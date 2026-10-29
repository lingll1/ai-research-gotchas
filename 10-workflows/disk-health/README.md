# 磁盘健康巡检：盯趋势，不是盯绝对值

## 为什么不用现成工具

CrystalDiskInfo 之类的工具会告诉你「健康状态：良好」，而一块正在坏的 SSD 完全可以「良好」着每天丢数据。你要的是三个具体信号的变化：

1. **待映射扇区数（SMART 197）** 从 0 涨到 8、涨到 16——这是坏道在扩散。
2. **24 小时内 IO 重试事件数** 从每天 3 次涨到 1038 次——这是读写已经开始反复失败，只是重试成功了。
3. **存储端口重置（事件 129）/ 非正常关机（事件 41）** 出现——这是链路层或电源层出问题。

单独看任何一个数字都没意义。**看它和上一次比有没有变坏**，这才是能行动的信号。

## 用法

```powershell
# 默认：目标盘按 FriendlyName 匹配 'ZSPEED'，日志写到 %LOCALAPPDATA%\dsh-tune
./disk-health-check.ps1

# 指定
./disk-health-check.ps1 -WorkDir 'D:\ops' -DiskMatch 'Samsung' -Ev153Threshold 100
```

配成计划任务每 4-6 小时跑一次，**必须经过 wscript 包装**，否则每次跑都闪黑窗——见 [`../silent-autostart/`](../silent-autostart/)。

先确认你的盘叫什么：

```powershell
Get-PhysicalDisk | Select-Object DeviceId, FriendlyName, MediaType, HealthStatus, Size
```

## 三个信号怎么读

### SMART 197 待映射扇区

WMI 只给 `MSStorageDriver_ATAPISmartData.VendorSpecific` 一堆原始字节，没有解析好的字段。布局是固定的：从 offset 2 开始，每 12 字节一个属性，`offset 0 = 属性 ID`，`offset 5..10 = 6 字节小端 raw 值`。

```powershell
for ($i = 2; $i + 12 -le $v.Length; $i += 12) {
  $id = $v[$i]
  $raw = 0
  for ($k = 5; $k -lt 11; $k++) { $raw = $raw + ([int64]$v[$i+$k] -shl (8*($k-5))) }
  if ($id -eq 197) { $pending = $raw }
  if ($id -eq 5)   { $realloc = $raw }
  if ($id -eq 168) { $phy     = $raw }
}
```

判据：

| 值 | 含义 |
|---|---|
| 0 | 正常 |
| 1-15 | 有坏道，已被备用区接管，继续观察 |
| **≥ 16** | 备用区快用完了，**准备换盘** |
| 上升中（不管数值） | 最危险的信号——它在扩散 |

### 事件 153：IO 重试

`storahci` 的「已对目标设备重试 IO 操作」。这个事件意味着**一次读写失败过、然后重试成功了**。上层应用完全无感，只是变慢。

```powershell
@(Get-WinEvent -FilterHashtable @{LogName='System'; Id=153; StartTime=(Get-Date).AddDays(-1)}).Count
```

实测的一台机器：一块 ZSPEED 512GB SSD，近 30 天 1038 次。对应体感是「系统随机卡一下」。这个数字超过每天 200 就该当故障处理，不是「略慢」。

### 事件 129 / 41

- **129** 存储端口重置：链路层复位，通常指 SATA 线/接口/电源问题，也可能是盘要挂。
- **41** 非正常关机：这是**结果**不是原因，但和上面两个一起出现，说明系统在被拖垮。

## 告警设计：只对「变坏了」告警

脚本把每次的结果写两份：

- `disk-health-history.log`：一行一条，追加
- `disk-health-state.json`：只留最近一次的数值，用于比对

告警条件全部是**相对上一次**或**绝对阈值**，不是「数值非零就告警」：

```powershell
if ($pending -gt $prev.pending) { "PENDING SECTORS ROSE $($prev.pending) -> $pending" }
if ($realloc -gt $prev.realloc) { "REALLOCATED SECTORS ROSE $($prev.realloc) -> $realloc" }
if ($ev153 -gt 200)             { "IO RETRY STORM ($ev153 in 24h)" }
if ($pending -ge 16)            { "PENDING SECTORS >= 16 : DISK FAILING" }
```

否则一块盘从出厂就有 1 个重映射扇区，你会收到一辈子的告警然后学会无视它们。

日志行格式（够 grep、够画图）：

```
[2026-10-29 18:00] pending=0 realloc=0 sataPHY=0 readErrUncorr=0 readLatMax=25ms ev153_24h=1038 ev129_24h=0 ev41_24h=1 C_free=53.5GB alert=IO RETRY STORM (1038 in 24h)
```

## 边界

- **读不出就是 `$null`，不要当 0**。`Get-StorageReliabilityCounter` 对某些 USB 桥接盘、RAID 卡后面的盘直接返回空。把「读不到」显示成 `0` 会让你以为盘是健康的。
- `$null -ne $x` 的判断不能省。PowerShell 里 `$null -gt 0` 是 `$false`，但 `$null -lt 0` 也是 `$false`——两种比较都静默为假，代码看起来在跑，其实一次都没告警。
- 事件 153 的量级和磁盘队列深度、工作负载强相关。同一台机器白天写日志和夜里闲着的基准不一样，阈值要按自己的常态调。
- 这个脚本只观测。它能提前几周告诉你「该换盘了」，但不能阻止坏道扩散。
