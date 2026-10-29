# 把正在被进程 mmap 的大目录搬到另一个盘（并重启宿主）

## 场景

DSH 的本地推理运行时（`~/.dsh/mneme/runtime`，614 MB / 4596 文件）待在系统盘上，而那块盘正在坏。要搬到 D 盘。

按理说 `move` 一下完事。实际有三个约束把它变成一个「必须重启宿主 + 必须能回滚」的工程问题：

1. **DLL 被 mmap 常驻**：`onnxruntime.dll`、`onnxruntime_binding.node`、`sharp-win32-x64.node`、`libvips-cpp.dll` 正被宿主进程加载。Windows 内核拒绝删除已映射的文件——`Access denied`，**提权成管理员也没用**。
2. **迁移脚本不能活在宿主进程树里**：宿主一退出，它的所有子进程一起死。脚本恰好死在「删完源目录、还没建 junction」那一瞬间，目录就没了。
3. **宿主必须被重新拉起来**，而且用户不能感知到「AI 挂了」。

## 三个约束对应的三个设计

### 1. 先确认是谁在锁，再决定杀谁

```powershell
$target = 'C:\Users\<you>\.dsh\mneme\runtime'
Get-Process | ForEach-Object {
  $p = $_
  try {
    $p.Modules | Where-Object { $_.FileName -and $_.FileName.StartsWith($target, 'OrdinalIgnoreCase') } |
      ForEach-Object { "PID=$($p.Id) $($p.ProcessName) <- $($_.FileName)" }
  } catch { }   # 无权读别的进程模块列表很正常
}
```

`Get-Process -Name` 找不到线索，因为「加载了这个 DLL 的进程」和「名字里有 dsh 的进程」不是一回事。必须扫 `Modules`。

**一个反直觉的坑**：junction 建成之后，进程模块里记录的路径是**目标盘的真实路径**，不再是那条链接路径。所以比对时要把源路径**和**目标路径都放进前缀列表，否则会得到「无锁持有者」的假结论，然后删目录时才发现删不掉。这个坑只有建成 junction 之后才会暴露，第一版脚本就栽在这里。

### 2. 让脚本脱离宿主进程树

用 WMI 创建进程，父进程会变成 `WmiPrvSE.exe`：

```powershell
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = 'wscript.exe //nologo "C:\path\to\relaunch-dsh.vbs"'
}
```

`relaunch-dsh.vbs` 再以 `sh.Run cmd, 0, False` 起 `pwsh -WindowStyle Hidden`（见 [`../silent-autostart/`](../silent-autostart/) 为什么必须经过 wscript）。

验证父进程：

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId=$pid" | Select-Object ParentProcessId
```

### 3. 优雅关闭 + 可证伪的验收 + 无条件回滚

**优雅关闭比强杀快得多**：实测 `CloseMainWindow` 后 24-26 秒退出；强杀之后冷启动要 79.5 秒。所以顺序是「请求关窗 → 等 25s → `Stop-Process`（不带 Force）→ 等 12s → `-Force`」。

**验收判据必须是纯 ASCII 且真的加载模型**：

```powershell
# 1) 文件级真读一个字节——Test-Path 不足以证明 junction 通透
$fs = [System.IO.File]::OpenRead($onnxDll); $null = $fs.ReadByte(); $fs.Close()

# 2) 跑一次真实推理，只认 ASCII 标记
$o = & node $probeScript 2>&1 | Out-String
if ($o -notmatch 'PROBE_OK dim=512') { 失败 }
```

**不要**解析 CLI 的中文状态输出（不同代码页必乱码），**也不要**看它的「功能」字段——那份输出恒为 `unknown`，因为 `status` 子命令根本不加载模型。这两条都真踩过，代价是「迁移明明成功却自动回滚」。

**回滚不依赖前面的成功**：`Invoke-Rollback` 自己判断当前是什么形态（junction 就 `rmdir`、普通目录就删）再从目标盘 robocopy 回来。

## 流程

```
触发（WMI → wscript → pwsh，脱离宿主进程树）
  ↓ 睡 40 秒（让触发方把最后一段话说完）
  ↓ 优雅关闭宿主（25s + 12s + Force）
  ↓ 确认无人持锁（再查一次 Modules）
  ↓ robocopy 源 → 目标，比对文件数
  ↓ 文件数达标才删源目录        ← 保命判据
  ↓ mklink /J 源 目标            ← junction 不需要管理员
  ↓ 文件级真读 + 跑一次推理
  ↓ 失败 → 回滚 → 再验一次
  ↓ 无论如何：把宿主拉起来
  ↓ 轮询「出现主窗口的进程」判就绪
```

## 用法

```powershell
# 先看状态，什么都不改
./migrate-and-relaunch.ps1 -CheckOnly -Dst 'D:\dsh\mneme\runtime'

# 真跑（注意：会关掉 DSH）
./migrate-and-relaunch.ps1 -Dst 'D:\dsh\mneme\runtime'

# 已经手动关掉 DSH 了，跳过停止步骤
./migrate-and-relaunch.ps1 -Dst 'D:\dsh\mneme\runtime' -SkipStop

# 从 DSH 内部触发（不阻塞会话）
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = 'wscript.exe //nologo "' + (Resolve-Path ./relaunch-dsh.vbs) + '"'
}
```

参数（也认环境变量）：

| 参数 | 环境变量 | 说明 |
|---|---|---|
| `-Src` | `DSH_HOME` | 源目录，默认 `<DSH_HOME>\mneme\runtime` |
| `-Dst` | `DSH_MNEME_TARGET` | **必须给**。没给直接 exit 2，不会瞎猜往哪搬 |
| `-DshExe` | `DSH_EXE` | 宿主可执行文件 |
| `-DshProcessName` | — | 进程名（不带 `.exe`），默认 `DeepSeek Harness` |
| `-LogFile` | `PC_TUNE_DIR` | 日志，默认 `%PC_TUNE_DIR%\migrate-relaunch.log` |
| `-Port` | — | 可选，**只作辅助信息**，不要当判据 |

## 关于端口

宿主的 GUI 端口每次启动都变（实测 5166 → 9264 → 9605）。第一版脚本把就绪判定写成「连上 5166」，结果迁移完成后空转 150 秒，被外部当成卡死杀掉。

正确判据是「进程出现且 `MainWindowHandle -ne 0`」。端口最多用来在日志里补一句参考信息。

## 需要管理员吗

不需要。`mklink /J`（目录 junction）是普通用户权限，与 `mklink /D`（符号链接，需要 Developer Mode 或管理员）不同。这也是这类迁移选 junction 而不是 symlink 的原因之一。

## 一个不一定需要的优化

如果只是想省系统盘空间、不介意每次启动慢一点，也可以不迁移——但是 `onnxruntime.dll` 的加载发生在每次 DSH 启动时，从慢盘冷读的代价会一直存在。迁移+junction 之后路径不变，加载速度取决于目标盘，对上层完全透明。

## 边界

- 只处理**目录**迁移。单文件被 mmap 的情况（比如某个 `.pyd`）同理，但驱动/内核态持有的文件不适用。
- 回滚需要目标盘的副本完整。如果目标盘已经写入一半就被断电，下次启动会检测到 junction 不存在且源目录不完整 → 走回滚路径。
- 这套流程不保护「宿主启动失败」之外的问题：宿主起来了但插件报错，属于另一层（见 [`../../09-self-plugins/`](../../09-self-plugins/) 的 `dsh-v4-source-guard`）。
