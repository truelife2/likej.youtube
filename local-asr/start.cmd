@echo off
setlocal
rem 本機 Whisper 辨識服務：用 ComfyUI 內建的 Python（已含 torch + transformers）
set PY=C:\ai\ComfyUI_windows_portable\python_embeded\python.exe
if not exist "%PY%" (
  echo 找不到 %PY%
  echo 請修改這支檔案裡的 PY 路徑。
  pause
  exit /b 1
)
"%PY%" "%~dp0asr-server.py" %*
pause
