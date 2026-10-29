param(
    [switch]$CheckOnly,
    [switch]$SkipStop,
    [string]$Src = '',
    [string]$Dst = '',
    [string]$DshExe = '',
    [string]$DshProcessName = '',
    [string]$LogFile = '',
    [int]$Port = 0
)

# 把 dsh-mneme 的本地推理运行时从系统盘迁到大容量盘（目录 junction），然后重启 DeepSeek Harness。
#
# 为什么要「重启」而不是就地搬：onnxruntime.dll / sharp 的 .node 被宿主进程 mmap 常驻，
# Windows 内核拒绝删除已映射的 DLL —— 提权也没用，必须先让宿主退出。
#
# 为什么不能用「先关掉 DSH 再手动跑」：脚本一旦挂在 DSH 的进程树下面，
# DSH 一退出它自己也死了。所以入口必须是 wscript（见 relaunch-dsh.vbs），
# 再经 WMI Win32_Process.Create 把父进程换成 WmiPrvSE，彻底脱离。
#
# 任何一步失败都会回滚到迁移前布局，保证 DSH 一定能起来、插件一定能用。
#
# 必须自己提供的参数（也可以用同名环境变量给默认值）：
#   -Dst            迁移目标目录，例如 D:\dsh\mneme\runtime
#                   环境变量：DSH_MNEME_TARGET
#   -Src            源目录，默认 $env:DSH_HOME\mneme\runtime（DSH_HOME 默认 %USERPROFILE%\.dsh）
#   -DshExe         DSH 可执行文件，默认 %LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe
#                   环境变量：DSH_EXE
#   -DshProcessName DSH 的进程名（不带 .exe），默认 'DeepSeek Harness'
#   -LogFile        日志路径，默认 %PC_TUNE_DIR%\migrate-relaunch.log
#   -Port           可选，仅作为「启动成功」的辅助信息；不要拿它当判据，端口每次启动都会变

$ErrorActionPreference = 'Continue'

# ---------------- 参数解析 ----------------
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$TuneDir = if ($env:PC_TUNE_DIR) { $env:PC_TUNE_DIR } else { Join-Path $env:LOCALAPPDATA 'dsh-tune' }

if (-not $Src) { $Src = Join-Path $DshHome 'mneme\runtime' }
if (-not $Dst) { $Dst = $env:DSH_MNEME_TARGET }
if (-not $DshExe) {
    if ($env:DSH_EXE) { $DshExe = $env:DSH_EXE }
    else { $DshExe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe' }
}
if (-not $DshProcessName) { $DshProcessName = 'DeepSeek Harness' }
if (-not $LogFile) { $LogFile = Join-Path $TuneDir 'migrate-relaunch.log' }

# 探针脚本：同仓库 memory-ops 目录下的 ASCII 探针
$ProbeScript = if ($env:MNEME_PROBE) { $env:MNEME_PROBE } else {
    Join-Path (Split-Path $PSScriptRoot -Parent) 'memory-ops\mneme-prodpath-check.mjs'
}

if (-not (Test-Path $TuneDir)) { New-Item -ItemType Directory -Path $TuneDir -Force | Out-Null }

function L([string]$m) {
    $line = '[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] ' + $m
    try { Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8 } catch { }
    Write-Host $line
}

if (-not $Dst) {
    L '缺少迁移目标目录。请传 -Dst 或设置环境变量 DSH_MNEME_TARGET，例如 D:\dsh\mneme\runtime'
    exit 2
}

function Get-PathStat([string]$p) {
    if (-not (Test-Path $p)) { return $null }
    $f = Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum
    return [pscustomobject]@{ Files = [int]$f.Count; Bytes = [long]$f.Sum }
}

function Format-Stat($s) {
    if ($null -eq $s) { return '不存在' }
    return ("{0} 文件 / {1} MB" -f $s.Files, [math]::Round($s.Bytes / 1MB, 1))
}

function Get-DshProcs {
    return @(Get-Process -Name $DshProcessName -ErrorAction SilentlyContinue)
}

function Test-Port([int]$p) {
    if ($p -le 0) { return $false }
    $c = $null
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(1500)) { return $false }
        $c.EndConnect($iar)
        return $true
    } catch { return $false } finally { if ($c) { $c.Close() } }
}

# 谁把 runtime 目录下的文件映射进自己地址空间了？这些进程不退出就删不掉目录。
#
# 注意：同时要比对 $Dst。junction 建成之后，进程模块里记录的路径是**目标盘真实路径**，
# 不再是 C 盘那条链接路径；只比 $Src 会得到「无锁持有者」的假结论，
# 然后删目录时才发现删不掉。这个坑是建成 junction 之后才暴露的。
function Get-RuntimeLockers {
    $prefs = @($Src.TrimEnd('\'), $Dst.TrimEnd('\')) | Where-Object { $_ }
    $ids = New-Object System.Collections.Generic.List[int]
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
        if ($p.Id -eq $PID) { continue }
        try {
            $hit = $false
            foreach ($m in $p.Modules) {
                if (-not $m.FileName) { continue }
                foreach ($pref in $prefs) {
                    if ($m.FileName.StartsWith($pref, 'OrdinalIgnoreCase')) { $hit = $true; break }
                }
                if ($hit) { break }
            }
            if ($hit) { $ids.Add($p.Id) }
        } catch { }   # 无权读别的进程模块列表很正常，跳过即可
    }
    return @($ids | Sort-Object -Unique)
}

# 优雅退出远比强杀快：实测优雅 24-26s，强杀后冷启动要 79.5s。
function Stop-DshGracefully {
    $procs = Get-DshProcs
    if ($procs.Count -eq 0) { L 'DSH 未运行，跳过停止'; return $true }
    L ('DSH 进程: ' + ($procs.Id -join ',') + ' —— 发送窗口关闭请求')
    foreach ($p in $procs) {
        try { if ($p.MainWindowHandle -ne 0) { $null = $p.CloseMainWindow() } } catch { }
    }
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Seconds 1
        if ((Get-DshProcs).Count -eq 0) { L ('DSH 已优雅退出（' + ($i + 1) + 's）'); return $true }
    }
    L '优雅关闭超时 → Stop-Process（不带 Force）'
    foreach ($p in Get-DshProcs) { Stop-Process -Id $p.Id -ErrorAction SilentlyContinue }
    for ($i = 0; $i -lt 12; $i++) {
        Start-Sleep -Seconds 1
        if ((Get-DshProcs).Count -eq 0) { L 'DSH 已退出'; return $true }
    }
    L '进程仍存活 → Stop-Process -Force'
    foreach ($p in Get-DshProcs) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 4
    $left = (Get-DshProcs).Count
    if ($left -eq 0) { L 'DSH 已退出（强制）'; return $true }
    L ("仍有 $left 个 DSH 进程存活，为避免损坏 runtime 放弃迁移")
    return $false
}

function Clear-RuntimeLockers {
    $lockers = Get-RuntimeLockers
    if ($lockers.Count -eq 0) { L '无进程持有 runtime 文件'; return $true }
    L ('仍有进程持有 runtime 文件: ' + ($lockers -join ','))
    foreach ($id in $lockers) {
        try { Stop-Process -Id $id -Force -ErrorAction Stop; L ("已终止 PID=$id") }
        catch { L ("终止失败 PID=$id : " + $_.Exception.Message) }
    }
    Start-Sleep -Seconds 3
    $again = Get-RuntimeLockers
    if ($again.Count -eq 0) { L '锁定已解除'; return $true }
    L ('锁定未解除: ' + ($again -join ','))
    return $false
}

# 验收判据必须是纯 ASCII 且真的加载了模型。
# 不能解析 CLI 的中文 status 输出（不同代码页必乱码），
# 也不能看它的「功能」字段（那份输出恒为 unknown，它根本不加载模型）。
function Test-RuntimeOk {
    $probe = Get-ChildItem -Path $Src -Recurse -Filter 'onnxruntime.dll' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $probe) { L '结构校验失败：找不到 onnxruntime.dll'; return $false }
    # 真实读一次：仅 Test-Path 不足以证明 junction 通透（目录可列但文件读不到的情况存在）
    try {
        $fs = [System.IO.File]::OpenRead($probe.FullName)
        $null = $fs.ReadByte()
        $fs.Close()
        L ('onnxruntime.dll 可读（文件级校验通过）: ' + $probe.FullName)
    } catch {
        L ('onnxruntime.dll 读取失败: ' + $_.Exception.Message)
        return $false
    }
    if (-not (Test-Path $ProbeScript)) { L ('缺少生产路径探针脚本: ' + $ProbeScript); return $false }
    $o2 = (& node $ProbeScript 2>&1 | Out-String)
    L ('生产路径自检: ' + ($o2 -replace "`r?`n", ' | '))
    if ($o2 -notmatch 'PROBE_OK dim=512') { L '探针未返回 PROBE_OK dim=512'; return $false }
    return $true
}

function Invoke-Rollback {
    L '回滚：把目标盘副本恢复到源盘'
    $item = Get-Item $Src -Force -ErrorAction SilentlyContinue
    if ($item -and $item.LinkType -eq 'Junction') {
        cmd /c "rmdir `"$Src`"" | Out-Null
        L '已移除 junction'
    }
    if (Test-Path $Src) { Remove-Item -LiteralPath $Src -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force -Path (Split-Path $Src) | Out-Null
    robocopy $Dst $Src /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    $s = Get-PathStat $Src
    L ('回滚后源盘: ' + (Format-Stat $s))
}

function Invoke-Migrate {
    $item = Get-Item $Src -Force -ErrorAction SilentlyContinue
    if ($item -and $item.LinkType -eq 'Junction') {
        L ('已迁移（Junction → ' + ($item.Target -join ',') + '），跳过搬运')
        return $true
    }
    $s = Get-PathStat $Src
    $d = Get-PathStat $Dst
    L ('迁移前 —— 源盘: ' + (Format-Stat $s) + ' ；目标盘: ' + (Format-Stat $d))

    if ($null -eq $d) {
        if ($null -eq $s) { L '两边都不存在，无需迁移'; return $true }
        L '目标盘没有副本 → 先完整复制再校验'
        New-Item -ItemType Directory -Force -Path (Split-Path $Dst) | Out-Null
        robocopy $Src $Dst /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
        $d = Get-PathStat $Dst
    } elseif ($null -ne $s -and ($d.Files -lt $s.Files -or $d.Bytes -lt $s.Bytes)) {
        L '目标盘副本不完整 → 补齐'
        robocopy $Src $Dst /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
        $d = Get-PathStat $Dst
    }
    L ('准备就绪 —— 目标盘: ' + (Format-Stat $d))

    if ($null -ne $s) {
        # 只有目标盘文件数不少于源盘才敢删源目录，这条是保命判据
        if ($d.Files -lt $s.Files) { L '目标盘文件数少于源盘，拒绝删除源目录'; return $false }
        L '删除源目录（内容已在目标盘）'
        Remove-Item -LiteralPath $Src -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $Src) {
            $left = Get-PathStat $Src
            L ('源目录删除未完成，残留: ' + (Format-Stat $left))
            return $false
        }
    }

    L '建立 junction'
    $mk = cmd /c "mklink /J `"$Src`" `"$Dst`"" 2>&1 | Out-String
    L ('mklink: ' + $mk.Trim())
    $after = Get-Item $Src -Force -ErrorAction SilentlyContinue
    if (-not $after -or $after.LinkType -ne 'Junction') { L 'junction 未建立'; return $false }
    $via = Get-PathStat $Src
    L ('junction 建立成功，透过链接可见: ' + (Format-Stat $via))
    return $true
}

function Start-DshApp {
    if (-not (Test-Path $DshExe)) { L ('找不到 DSH 可执行文件: ' + $DshExe); return $false }
    L ('启动 DSH: ' + $DshExe)
    try {
        Start-Process -FilePath $DshExe -WorkingDirectory (Split-Path $DshExe) -ErrorAction Stop
    } catch {
        L ('启动失败: ' + $_.Exception.Message)
        return $false
    }
    # 端口号每次启动都会变（实测 5166 → 9264 → 9605），不能当判据。
    # 以「出现带主窗口的进程」为准，端口只在 -Port 给了值时作辅助信息。
    for ($i = 0; $i -lt 180; $i++) {
        Start-Sleep -Seconds 1
        $withWin = @(Get-DshProcs | Where-Object { $_.MainWindowHandle -ne 0 })
        if ($withWin.Count -gt 0) {
            $pnote = ''
            if (Test-Port $Port) { $pnote = "，端口 $Port 可连" }
            L ('DSH 主窗口已出现（' + ($i + 1) + 's）PID=' + ($withWin.Id -join ',') + $pnote)
            return $true
        }
        if ($i -gt 25 -and (Get-DshProcs).Count -eq 0) {
            L 'DSH 进程启动后消失，启动失败'
            return $false
        }
    }
    L '等待主窗口超时（进程仍在则可能只是慢启动）'
    return ((Get-DshProcs).Count -gt 0)
}

# ---------------- 主流程 ----------------
L '==================================================================='
$modeTag = ''
if ($CheckOnly) { $modeTag = ' [CheckOnly]' }
if ($SkipStop) { $modeTag = $modeTag + ' [SkipStop]' }
L ('脚本启动 PID=' + $PID + $modeTag)
L ('源: ' + $Src + '  →  目标: ' + $Dst)

if ($CheckOnly) {
    $s = Get-PathStat $Src
    $d = Get-PathStat $Dst
    $models = Join-Path (Split-Path $Src -Parent) 'models'
    $m = Get-Item $models -Force -ErrorAction SilentlyContinue
    L ('源盘 runtime: ' + (Format-Stat $s))
    L ('目标盘 runtime: ' + (Format-Stat $d))
    if ($s) { $it = Get-Item $Src -Force; L ('源 LinkType=' + $it.LinkType + ' Target=' + ($it.Target -join ',')) }
    if ($m) { L ('models LinkType=' + $m.LinkType + ' Target=' + ($m.Target -join ',')) }
    $lockers = Get-RuntimeLockers
    L ('文件锁持有者 PID: ' + (($lockers -join ',') -replace '^$', '无'))
    L ('DSH 进程: ' + ((Get-DshProcs).Id -join ','))
    L 'CheckOnly 结束，未做任何修改'
    exit 0
}

# 留出缓冲：让触发方（DSH 会话）把最后一段话说完再动手关窗口
Start-Sleep -Seconds 40

if (-not $SkipStop) {
    if (-not (Stop-DshGracefully)) { L '中止：DSH 无法停止'; exit 3 }
} else {
    L '按参数跳过停止 DSH'
}

if (-not (Clear-RuntimeLockers)) { L '中止：runtime 文件仍被占用，保持原状'; exit 4 }

$migrated = Invoke-Migrate
if ($migrated) {
    if (Test-RuntimeOk) { L '★ 迁移完成且运行时功能验证通过' }
    else {
        L '迁移后验证失败 → 回滚'
        Invoke-Rollback
        if (Test-RuntimeOk) { L '回滚成功，运行时可用（维持在源盘）' }
        else { L '回滚后仍不可用；DSH 启动时会自行降级为关键词检索，不会崩溃' }
    }
} else {
    L '迁移未完成 → 回滚到源盘布局'
    Invoke-Rollback
    if (Test-RuntimeOk) { L '回滚成功，运行时可用（维持在源盘）' }
}

Start-DshApp
L '=== 结束 ==='
