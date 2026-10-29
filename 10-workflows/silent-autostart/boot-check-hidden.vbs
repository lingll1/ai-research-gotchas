' Silent launcher for boot-check.ps1 -- guarantees no console window ever appears.
'
' Why this exists:
'   Task Scheduler running `powershell.exe -WindowStyle Hidden` directly still
'   flashes a black window. The flag is applied AFTER the console is allocated,
'   so you see the allocation. wscript.exe, by contrast, is a GUI-subsystem host:
'   it never allocates a console at all, and window style 0 hides the child.
'
' Usage:
'   wscript.exe //nologo boot-check-hidden.vbs                (uses default target)
'   wscript.exe //nologo boot-check-hidden.vbs "C:\x\a.ps1"   (explicit target)
'
' Default target directory comes from PC_TUNE_DIR, falling back to
' %LOCALAPPDATA%\dsh-tune. Set PC_TUNE_DIR if your scripts live elsewhere.
Option Explicit
Dim env, sh, base, target, cmd

Set env = CreateObject("WScript.Shell").Environment("PROCESS")

If WScript.Arguments.Count > 0 Then
  target = WScript.Arguments(0)
Else
  base = env("PC_TUNE_DIR")
  If Len(base) = 0 Then base = env("LOCALAPPDATA") & "\dsh-tune"
  target = base & "\boot-check.ps1"
End If

Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & target & """"
sh.Run cmd, 0, False
