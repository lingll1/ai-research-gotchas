' Silent launcher for disk-health-check.ps1 -- no console window, ever.
'
' Register this as the Task Scheduler action, NOT powershell.exe:
'   wscript.exe //nologo "C:\path\to\disk-health-hidden.vbs"
' and set the task's Settings.Hidden = $true.
'
' Default target comes from PC_TUNE_DIR (fallback %LOCALAPPDATA%\dsh-tune);
' pass a path as the first argument to override.
Option Explicit
Dim env, sh, base, target, cmd

Set env = CreateObject("WScript.Shell").Environment("PROCESS")

If WScript.Arguments.Count > 0 Then
  target = WScript.Arguments(0)
Else
  base = env("PC_TUNE_DIR")
  If Len(base) = 0 Then base = env("LOCALAPPDATA") & "\dsh-tune"
  target = base & "\disk-health-check.ps1"
End If

Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & target & """"
sh.Run cmd, 0, False
