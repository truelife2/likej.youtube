@echo off
setlocal
for %%K in (
  "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ytlt.asr"
  "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.ytlt.asr"
) do (
  reg delete %%K /f >nul 2>&1
  echo Removed %%K
)
echo.
echo The launcher.exe and manifest files were left in place (harmless).
echo Delete the native-host folder if you want them gone too.
pause
