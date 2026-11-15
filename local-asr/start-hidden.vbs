' Start the local Whisper ASR server with no console window.
' Used by install-autostart.cmd; safe to run from a shortcut too.
Option Explicit

Dim fso, sh, here, py, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
py = "C:\ai\ComfyUI_windows_portable\python_embeded\python.exe"
If Not fso.FileExists(py) Then py = "python.exe"

sh.CurrentDirectory = here
cmd = """" & py & """ """ & here & "\asr-server.py"" --preload"
sh.Run cmd, 0, False
