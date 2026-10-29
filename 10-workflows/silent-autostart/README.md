# 让开机 / 唤醒后的计划任务彻底不弹窗

## 症状

电脑从睡眠唤醒，或者刚登录进桌面，屏幕上闪过一个黑色命令行窗口，一两秒后消失。找不到来源——事件日志里没有任何「程序崩溃」，任务管理器也抓不到，因为它活得比打开任务管理器还短。

## 三个独立成因，缺一个都还会闪

### 1. `-WindowStyle Hidden` 并不能阻止窗口出现

这是最反直觉的一条。任务计划里写：

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\x\a.ps1"
```

看起来已经隐藏了。但 `-WindowStyle` 是**在进程启动之后**才应用的：`powershell.exe` 是控制台子系统程序，被创建时 Windows 先给它分配一个控制台，控制台窗口先画出来，然后才轮到 `Hidden` 把它藏起来。那一帧就是你能看见的黑框。

**解法**：加一层 `wscript.exe`。它是 GUI 子系统宿主，**从来不分配控制台**；它再用窗口样式 `0` 启动子进程。

```vbs
' guard-hidden.vbs
Option Explicit
Dim sh, cmd
Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & target & """"
sh.Run cmd, 0, False      ' 0 = hidden, False = don't wait
```

任务 Action 改成：

```
wscript.exe //nologo "C:\path\to\guard-hidden.vbs" "C:\path\to\your.ps1"
```

### 2. `StartWhenAvailable` 让「错过的时间」在唤醒时补跑

这条是「为什么偏偏在唤醒后闪」的答案。

任务计划默认 `StartWhenAvailable = False`：错过触发就算了。改成 `True` 之后，机器睡眠期间错过的所有触发，会在**唤醒后立刻补跑**。

于是现象变成：设了每天 12:00 / 20:00 两个触发，电脑 20:28 被唤醒，任务就在 20:28 左右跑起来——用户视角是「一唤醒就闪」，而不是「整点闪」，非常难对上号。

**怎么确认**：拿唤醒时间（`Kernel-Power` 事件，ID 131/107/42）去比对任务的 `LastRunTime`。两者差几十秒，就是它。

```powershell
Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; Id=131,107,42} -MaxEvents 20 |
  Select-Object TimeCreated, Id, @{n='Msg';e={$_.Message.Substring(0,[Math]::Min(80,$_.Message.Length))}}

Get-ScheduledTaskInfo -TaskName '你的任务名' | Select-Object LastRunTime, LastTaskResult, NextRunTime
```

顺便确认不是「唤醒定时器」在唤醒机器：

```powershell
powercfg /waketimers
```

空输出说明唤醒是人为的（键鼠/电源键），闪窗是「唤醒后补跑」，不是「任务把机器叫醒」。

### 3. 脚本内部又 `& powershell.exe` 起了子进程

外层藏好了，脚本自己再开一个就白干。典型写法：

```powershell
$out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper 2>&1
```

这个子进程没有任何隐藏标志，它自己分配控制台。

**解法**：用 `ProcessStartInfo`，关键是 `CreateNoWindow = $true`（这是**创建时不分配控制台**，与 `-WindowStyle` 的事后隐藏不同）：

```powershell
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName               = 'powershell.exe'
$psi.Arguments              = "-NoProfile -ExecutionPolicy Bypass -File `"$helper`""
$psi.UseShellExecute        = $false     # 必须 false，否则 CreateNoWindow 无效
$psi.CreateNoWindow         = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError  = $true

$p = [System.Diagnostics.Process]::Start($psi)
$stdout = $p.StandardOutput.ReadToEnd()
$stderr = $p.StandardError.ReadToEnd()
$p.WaitForExit()
$LASTEXITCODE = $p.ExitCode
```

`UseShellExecute = $false` 不能省：为 `$true` 时走 Shell 启动，`CreateNoWindow` 直接被忽略。

## 先把所有自启点列出来

不要猜，全列：

```powershell
# 1) 注册表 Run（HKCU + HKLM，32/64 位都要看）
foreach ($k in 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
               'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
               'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run') {
  if (Test-Path $k) {
    "--- $k ---"
    (Get-ItemProperty $k).PSObject.Properties |
      Where-Object { $_.Name -notmatch '^PS' } |
      ForEach-Object { "  $($_.Name) = $($_.Value)" }
  }
}

# 2) 启动文件夹
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup",
              "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Startup" -ErrorAction SilentlyContinue

# 3) 计划任务——重点看 Action 是不是控制台程序
Get-ScheduledTask | ForEach-Object {
  $t = $_
  foreach ($a in $t.Actions) {
    [pscustomobject]@{
      Task    = $t.TaskPath + $t.TaskName
      State   = $t.State
      Exec    = $a.Execute
      Args    = $a.Arguments
      Hidden  = $t.Settings.Hidden
      CatchUp = $t.Settings.StartWhenAvailable
    }
  }
} | Where-Object { $_.Exec -match 'powershell|cmd|pwsh|conhost|python|node' } | Format-List
```

`where` 那一行是关键：只有**控制台子系统程序**才会闪窗。GUI 程序（`nn.exe`、显卡面板、更新器）不产生控制台，列出来也不用管。

顺带一个坑：注册表 Run 里可能留着**文件已经不存在的残留项**（卸载没清干净）。判定前先 `Test-Path` 一下，别为一个不存在的 exe 折腾半天。

## 改完之后怎么验

改 Action 之后不要只看配置，要真跑一次：

```powershell
$before = (Get-ScheduledTaskInfo -TaskName '你的任务名').LastRunTime
Start-ScheduledTask -TaskName '你的任务名'
Start-Sleep -Seconds 20
Get-ScheduledTaskInfo -TaskName '你的任务名' | Select-Object LastRunTime, LastTaskResult, State

# 残留进程（正常应该只剩你自己的 shell）
Get-Process wscript, powershell, conhost -ErrorAction SilentlyContinue |
  Select-Object Id, ProcessName, StartTime
```

`LastTaskResult` 要 `0x0`。同时看任务自己写的日志有没有新行——`0x0` 只说明「启动成功」，不说明「干活成功」。

## 边界

- `wscript + style 0` 只保证**不分配控制台**。脚本如果自己创建 GUI 窗口、或者弹 MessageBox，照样能看见。要彻底静默，脚本内部也不能有交互输出。
- 别用 `-WindowStyle Hidden` 单独代替 wscript——它就是本文第 1 条的成因。
- 某些安全软件会拦 `wscript.exe` 执行 VBS（视为脚本宿主滥用）。被拦时任务会 `0x1` 失败，那种情况只能退回「让程序自己隐藏窗口」（即改造程序的入口）。
