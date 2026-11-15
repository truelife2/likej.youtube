@echo off
setlocal
set "HERE=%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\YTLT ASR.lnk"

echo Creating startup shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%');" ^
  "$s.TargetPath='wscript.exe';" ^
  "$s.Arguments='\"%HERE%start-hidden.vbs\"';" ^
  "$s.WorkingDirectory='%HERE%';" ^
  "$s.WindowStyle=7;" ^
  "$s.Description='YTLT local Whisper ASR server';" ^
  "$s.Save()"

if errorlevel 1 (
  echo [FAILED] Could not create the shortcut.
  pause
  exit /b 1
)

echo [OK] Installed: %LNK%
echo Starting it now (no console window)...

start "" wscript.exe "%HERE%start-hidden.vbs"

echo.
echo The ASR server will now start automatically at every logon.
echo Check it with:  curl http://127.0.0.1:8791/health
echo.
pause
