' relaunch-dsh.vbs -- launch the migration script with no console window,
' and (critically) from OUTSIDE the DSH process tree.
'
' How it is meant to be invoked:
'   Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
'     CommandLine = 'wscript.exe //nologo "C:\path\to\relaunch-dsh.vbs"'
'   }
'
' Why WMI: the wscript process is then a child of WmiPrvSE, not of DSH. The
' migration script must outlive DSH -- if it were a normal child, closing DSH
' would kill the script halfway through, leaving the runtime dir deleted and no
' junction created. That is the one failure mode you cannot recover from without
' a manual copy.
'
' Usage:
'   wscript.exe //nologo relaunch-dsh.vbs                 (targets sibling .ps1)
'   wscript.exe //nologo relaunch-dsh.vbs "C:\x\scr.ps1" (explicit script)
'
' Requires PowerShell 7 (pwsh). Windows PowerShell 5.1 handles BOM-less UTF-8
' and unix-ish paths badly enough to be a real hazard here. Override the binary
' with PWSH_EXE if it is not in the default install location.
Option Explicit
Dim env, fso, sh, selfDir, target, pwsh, cmd

Set env = CreateObject("WScript.Shell").Environment("PROCESS")
Set fso = CreateObject("Scripting.FileSystemObject")

pwsh = env("PWSH_EXE")
If Len(pwsh) = 0 Then
  If fso.FileExists("C:\Program Files\PowerShell\7\pwsh.exe") Then
    pwsh = "C:\Program Files\PowerShell\7\pwsh.exe"
  Else
    pwsh = "pwsh.exe"
  End If
End If

If WScript.Arguments.Count > 0 Then
  target = WScript.Arguments(0)
Else
  selfDir = fso.GetParentFolderName(WScript.ScriptFullName)
  target = fso.BuildPath(selfDir, "migrate-and-relaunch.ps1")
End If

Set sh = CreateObject("WScript.Shell")
cmd = """" & pwsh & """ -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & target & """"
sh.Run cmd, 0, False
