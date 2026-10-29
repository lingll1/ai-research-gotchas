' guard-hidden.vbs -- silent launcher for any scheduled .ps1 (originally
' dsh-desktop-plugin-guard.ps1).
'
' Root cause this fixes: the task action pointed straight at powershell.exe.
' Task Scheduler had StartWhenAvailable=True, so a run missed during sleep would
' be caught up right after wake -- cold-starting powershell.exe, which allocates
' a console, which flashes a black window on screen. Seen exactly once per wake
' and impossible to reproduce on demand.
'
' wscript.exe is a GUI-subsystem host: it never allocates a console itself, and
' window style 0 tells it to start the child fully hidden.
'
' Register as:  wscript.exe //nologo "guard-hidden.vbs" "C:\path\your.ps1"
' and set the task's Settings.Hidden = $true.
'
' ASCII only: this file must stay readable under any code page.
Option Explicit
Dim sh, env, base, target, cmd

If WScript.Arguments.Count > 0 Then
  target = WScript.Arguments(0)
Else
  Set env = CreateObject("WScript.Shell").Environment("PROCESS")
  base = env("PC_TUNE_DIR")
  If Len(base) = 0 Then base = env("LOCALAPPDATA") & "\dsh-tune"
  target = base & "\dsh-desktop-plugin-guard.ps1"
End If

Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & target & """"
sh.Run cmd, 0, False
