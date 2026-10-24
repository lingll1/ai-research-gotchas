# 长跑命令：超时、后台与管道阻塞

> `Start-Process -RedirectStandardOutput` 看起来是最"正规"的写法，却会让子进程**永久卡死**在一个 4KB 的管道里。

## 现象

要用脚本跑一个长时间的命令（构建、转换、下载、模型推理），希望：

- 能看输出
- 不阻塞当前脚本
- 不要弹个黑窗口

三种典型翻车：

**翻车一：超时把结果一起吞了**

跑一个耗时 3 分钟的命令，工具设了 60 秒超时 → 到点被 kill → **前面 60 秒的输出也没了**。

**翻车二：重定向让子进程卡死**

```powershell
Start-Process -FilePath 'longjob.exe' -RedirectStandardOutput 'out.log' -RedirectStandardError 'err.log'
```

子进程跑到某个点就**再也不动了**。看 `out.log`，停在某个字节数不动。CPU 占用为 0。

**翻车三：窗口一闪而过 / 弹黑窗**

开机自启动脚本，用 `powershell.exe -WindowStyle Hidden` 包一层 → 还是闪一下黑窗。

## 根因

### 翻车一：超时 ≠ 失败

`timeout` 的语义是"**最长等待时间**"，不是"预计耗时"。到点后很多执行环境会**杀掉进程**，连带丢掉 stdout 缓冲。

正确的语义应该是"到点转后台，继续读输出"。

### 翻车二：`Start-Process -Redirect*` 是管道，有缓冲区

`-RedirectStandardOutput` 的实现是：创建匿名管道 → 子进程写管道 → **父进程读管道写文件**。

管道有约 **4KB** 的缓冲区。当子进程写满缓冲区、而父进程不再读（比如父进程在等子进程结束）→ 子进程阻塞在 `write()` → **死锁**。

`Start-Process` 在多进程/服务场景下尤其容易触发，因为父进程的生命周期管理不明确。

### 翻车三：`-WindowStyle Hidden` 不可靠

`powershell.exe -WindowStyle Hidden` 在控制台程序上有已知的闪烁问题 —— 窗口先创建再隐藏。

## 做法

### 一、长跑命令交给"后台任务"，不要靠调大超时

好的执行器会把超时处理成"转后台"而不是"杀掉"：

```
前台执行 → 到超时点 → 自动转后台 job → 用 job_output 继续读 → job_kill 停止
```

如果你的环境支持这种语义，**长命令一律用后台运行**，别把 timeout 调到 10 分钟硬等。

### 二、重定向交给 shell，不要交给 `Start-Process`

```powershell
# 坏：父进程抽水，可能死锁
Start-Process -FilePath 'longjob.exe' -RedirectStandardOutput 'out.log'

# 好：交给 cmd，直接用文件句柄，没有中间管道
cmd /c "longjob.exe > out.log 2>&1 < NUL"
```

`cmd` 的 `>` 是**打开文件句柄**给子进程直接写，没有父进程中转，所以不存在"父进程不读就卡住"。

Linux/macOS 同理：`sh -c 'longjob > out.log 2>&1 < /dev/null'`。

**注意 `< NUL` / `< /dev/null`**：重定向 stdin，防止子进程试图读 stdin 而挂起。

### 三、确实要脱离父进程用 `Start-Process`，但别用 `-Redirect*`

```powershell
Start-Process -FilePath 'longjob.exe' `
              -WorkingDirectory 'D:\work' `
              -WindowStyle Hidden `
              -PassThru | Select-Object -ExpandProperty Id
```

输出让它自己写到文件（在程序内部写日志），或在 cmd 里包一层重定向：

```powershell
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c longjob.exe > out.log 2>&1 < NUL' -WindowStyle Hidden
```

### 四、开机自启动要真静默：用 VBS 包装

```vbs
' launcher.vbs —— 双击或放启动项，完全不出现窗口
Set sh = CreateObject("WScript.Shell")
sh.Run "pwsh -NoProfile -WindowStyle Hidden -File ""D:\path\start.ps1""", 0, False
```

`sh.Run(..., 0, ...)` 的 `0` 是窗口样式 = 隐藏。`wscript.exe` 本身属于 GUI 子系统，**不创建控制台**，所以没有闪烁。

任务本体再加 `-WindowStyle Hidden` 是双保险。

### 五、超时值的另一种用法：熔断而非放弃

```python
# 概念示例：把超时当熔断，而不是放弃
deadline = time.time() + 600
while time.time() < deadline:
    if job_done():
        break
    time.sleep(2)
else:
    print("超时终止，但已保存的中间结果仍在 ./out/")
    raise SystemExit(2)
```

**关键**：让子任务**持续落盘**。这样超时后最多丢最后一点进度，而不是全部。

## 边界

- 不同的执行器（shell 工具、CI runner、systemd）超时语义不同。**先确认它是"杀掉"还是"转后台"**，再决定怎么用。
- `cmd /c` 的重定向方案要求目标是 Windows 上能通过 cmd 跑的程序。对需要特定环境的程序（conda env、SDK 设置），用包装脚本。
- 缓冲导致的"看起来卡住"还有一种情况：**程序自己输出缓冲**（Python 的 stdout 在管道下默认块缓冲）。加 `-u` / `PYTHONUNBUFFERED=1` / `flush=True`。
- 4KB 缓冲是常见值，不是标准。管道缓冲区大小**依平台而异**，但"写满就阻塞"是普遍规律。

## 一句话记法

> **超时是熔断不是放弃，重定向交给 shell 不交给父进程。要静默就用 VBS 包一层。**
