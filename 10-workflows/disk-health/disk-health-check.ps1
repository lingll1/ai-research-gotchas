# 磁盘健康巡检（SMART + 系统事件）
#
# 每 N 小时跑一次，把关键指标追加到一行日志，并对「恶化」而不是「绝对值」告警。
# 设计前提：一块盘正在坏但还没死，你要的是「趋势」和「变化点」，不是一堆漂亮的数字。
#
# 参数（都有默认值，可用环境变量或显式传参覆盖）：
#   -WorkDir        日志与状态文件放在哪。默认 %LOCALAPPDATA%\dsh-tune
#                   可用环境变量 PC_TUNE_DIR 统一覆盖（本仓库所有工作流共用这一个变量）
#   -DiskMatch      目标盘用 FriendlyName / InstanceName 匹配哪个字符串（默认 'ZSPEED'）
#                   不知道叫什么就先跑：Get-PhysicalDisk | ft DeviceId,FriendlyName
#                   或直接按 DeviceId 改下面第 2 处查询
#   -Ev153Threshold 24h 内 IO 重试次数告警阈值（默认 200）

param(
  [string]$WorkDir = $(if ($env:PC_TUNE_DIR) { $env:PC_TUNE_DIR } else { Join-Path $env:LOCALAPPDATA 'dsh-tune' }),
  [string]$DiskMatch = 'ZSPEED',
  [int]$Ev153Threshold = 200
)

$ErrorActionPreference = 'SilentlyContinue'
if (-not (Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
$log = Join-Path $WorkDir 'disk-health-history.log'
$stateFile = Join-Path $WorkDir 'disk-health-state.json'

# --- 1) 可靠性计数器（读不出就是不支持，不要当 0）---
$d0 = Get-PhysicalDisk | Where-Object { $_.DeviceId -eq 0 } | Select-Object -First 1
if (-not $d0) { $d0 = Get-PhysicalDisk | Where-Object { $_.FriendlyName -match $DiskMatch } | Select-Object -First 1 }
$r = $d0 | Get-StorageReliabilityCounter

# --- 2) 裸 SMART：WMI 只给 VendorSpecific 字节，要自己按 12 字节一条解析 ---
# 布局：offset 0 = 属性 ID，offset 1 = 状态，offset 5..10 = 6 字节 little-endian raw
$smart = Get-CimInstance -Namespace root\wmi -ClassName MSStorageDriver_ATAPISmartData |
  Where-Object { $_.InstanceName -match $DiskMatch } | Select-Object -First 1
$pending = $null; $realloc = $null; $phy = $null
if ($smart) {
  $v = $smart.VendorSpecific
  for ($i = 2; $i + 12 -le $v.Length; $i += 12) {
    $id = $v[$i]
    $raw = 0
    for ($k = 5; $k -lt 11; $k++) { $raw = $raw + ([int64]$v[$i+$k] -shl (8*($k-5))) }
    if ($id -eq 197) { $pending = $raw }   # Current Pending Sector Count
    if ($id -eq 5)   { $realloc = $raw }   # Reallocated Sectors Count
    if ($id -eq 168) { $phy = $raw }       # SATA PHY error count
  }
}

# --- 3) 系统事件：153 IO 重试 / 129 端口重置 / 41 非正常关机 ---
$since = (Get-Date).AddDays(-1)
$ev153 = @(Get-WinEvent -FilterHashtable @{LogName='System'; Id=153; StartTime=$since} -ErrorAction SilentlyContinue).Count
$ev129 = @(Get-WinEvent -FilterHashtable @{LogName='System'; Id=129; StartTime=$since} -ErrorAction SilentlyContinue).Count
$ev41  = @(Get-WinEvent -FilterHashtable @{LogName='System'; Id=41;  StartTime=$since} -ErrorAction SilentlyContinue).Count
$freeC = [math]::Round((Get-Volume -DriveLetter C).SizeRemaining/1GB,1)

# --- 4) 和上一次比：只对「变坏了」告警 ---
$prev = $null
if (Test-Path $stateFile) { $prev = Get-Content $stateFile -Raw | ConvertFrom-Json }

$alert = @()
if ($prev) {
  if ($null -ne $pending -and $null -ne $prev.pending -and $pending -gt $prev.pending) { $alert += "PENDING SECTORS ROSE $($prev.pending) -> $pending" }
  if ($null -ne $realloc -and $null -ne $prev.realloc -and $realloc -gt $prev.realloc) { $alert += "REALLOCATED SECTORS ROSE $($prev.realloc) -> $realloc" }
}
if ($ev153 -gt $Ev153Threshold) { $alert += "IO RETRY STORM ($ev153 in 24h)" }
if ($ev129 -gt 0)   { $alert += "STORAGE PORT RESET x$ev129 in 24h" }
if ($ev41  -gt 0)   { $alert += "UNEXPECTED SHUTDOWN x$ev41 in 24h" }
if ($null -ne $pending -and $pending -ge 16) { $alert += "PENDING SECTORS >= 16 : DISK FAILING" }

$line = "[{0}] pending={1} realloc={2} sataPHY={3} readErrUncorr={4} readLatMax={5}ms ev153_24h={6} ev129_24h={7} ev41_24h={8} C_free={9}GB alert={10}" -f `
  (Get-Date -Format 'yyyy-MM-dd HH:mm'), $pending, $realloc, $phy, $r.ReadErrorsUncorrected, $r.ReadLatencyMax, $ev153, $ev129, $ev41, $freeC, $(if($alert.Count){$alert -join '; '}else{'none'})
Add-Content -Path $log -Value $line -Encoding utf8

[pscustomobject]@{ time=(Get-Date -Format 'yyyy-MM-dd HH:mm'); pending=$pending; realloc=$realloc; phy=$phy; ev153=$ev153; freeC=$freeC } |
  ConvertTo-Json | Out-File $stateFile -Encoding utf8
