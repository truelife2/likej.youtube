# Use Windows SAPI voices (e.g. "Microsoft Hanhan Desktop", zh-TW) to render a WAV.
# Backend for asr-server's TTS command mode: ~0.3 s latency, but older voice quality.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tts-sapi.ps1 -File in.txt -Out out.wav [-Voice "Microsoft Hanhan Desktop"]
param(
  [Parameter(Mandatory=$true)][string]$File,
  [Parameter(Mandatory=$true)][string]$Out,
  [string]$Voice = "Microsoft Hanhan Desktop"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$text = Get-Content -LiteralPath $File -Raw -Encoding UTF8
if (-not $text -or -not $text.Trim()) { throw "no text to synthesize" }

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
  if ($Voice -and ($voices -contains $Voice)) { $synth.SelectVoice($Voice) }
  $synth.SetOutputToWaveFile($Out)
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}
