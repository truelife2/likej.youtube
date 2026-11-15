@echo off
setlocal
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\YTLT ASR.lnk"

if exist "%LNK%" (
  del /q "%LNK%"
  echo [OK] Removed startup shortcut.
) else (
  echo [INFO] No startup shortcut found.
)

echo.
echo Note: a running server is left alone. Stop it with Task Manager
echo (look for python.exe) or just log off / reboot.
echo.
pause
