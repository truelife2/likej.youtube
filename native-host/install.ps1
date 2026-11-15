# Registers the YTLT native messaging host so the extension can start / stop
# the local Whisper server from its settings page (no .cmd needed).
#
# Run:  native-host\install.cmd        (or right-click install.ps1 > Run with PowerShell)
# Undo: native-host\uninstall.cmd

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$hostName = 'com.ytlt.asr'

Write-Host ''
Write-Host 'YTLT native host installer'
Write-Host ('  extension folder: ' + $root)
Write-Host ''

# ---------------------------------------------------------------- 1. extension id
# Unpacked extensions get an id derived from their absolute path, but instead of
# guessing we read it from Chrome's Preferences (an entry whose path matches).
function Resolve-ExtensionId {
    $profiles = @(
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Default\Preferences'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Profile 1\Preferences')
    )
    foreach ($prefs in $profiles) {
        if (-not (Test-Path $prefs)) { continue }
        try {
            $json = Get-Content -Raw -Encoding UTF8 $prefs | ConvertFrom-Json
            $settings = $json.extensions.settings
            if (-not $settings) { continue }
            foreach ($p in $settings.PSObject.Properties) {
                $path = $p.Value.path
                if ($path -and ($path -ieq $root)) { return $p.Name }
            }
        } catch { }
    }
    return $null
}

# 未封裝擴充功能的 ID = sha256(路徑) 前 32 個 hex，0-f 對應 a-p。
# Windows 上可能是 UTF-16LE 或 UTF-8，兩種都算出來一起放進 allowed_origins，
# 這樣不論 Chrome 用哪一種，真正的 ID 一定在清單裡。
function Get-PathIds {
    $out = @()
    $variants = @($root, ($root -replace '\\', '/'))
    foreach ($v in $variants) {
        foreach ($enc in @([Text.Encoding]::Unicode, [Text.Encoding]::UTF8)) {
            $sha = [System.Security.Cryptography.SHA256]::Create()
            $bytes = $sha.ComputeHash($enc.GetBytes($v))
            $hex = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
            $map = 'abcdefghijklmnop'
            $id = ''
            foreach ($ch in $hex.Substring(0, 32).ToCharArray()) {
                $id += $map[[Convert]::ToInt32([string]$ch, 16)]
            }
            $out += $id
        }
    }
    return ($out | Select-Object -Unique)
}

$ids = @()
if ($args.Count -ge 1 -and $args[0]) {
    $ids += $args[0]
    Write-Host ('  extension id (given): ' + $args[0])
} else {
    $detected = Resolve-ExtensionId
    if ($detected) {
        $ids += $detected
        Write-Host ('  extension id: ' + $detected)
    } else {
        Write-Host '  extension id: 自動偵測不到，改用路徑推算（已把 4 種可能都放進白名單）'
    }
}
$ids += Get-PathIds
$ids = $ids | Select-Object -Unique
Write-Host ('  allowed origins: ' + ($ids -join ', '))

# ---------------------------------------------------------------- 2. compile launcher
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) {
    Write-Host '[FAILED] 找不到 csc.exe（.NET Framework 4），無法編譯 launcher。' -ForegroundColor Red
    exit 1
}

$exe = Join-Path $here 'launcher.exe'
Write-Host '  compiling launcher.exe ...'
& $csc /nologo /target:exe /out:"$exe" (Join-Path $here 'launcher.cs') | Out-Null
if (-not (Test-Path $exe)) {
    Write-Host '[FAILED] 編譯失敗。' -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- 3. python path
$cfgPath = Join-Path $root 'local-asr\config.json'
$py = 'C:\ai\ComfyUI_windows_portable\python_embeded\python.exe'
if (Test-Path $cfgPath) {
    try {
        $cfg = Get-Content -Raw -Encoding UTF8 $cfgPath | ConvertFrom-Json
        if ($cfg.python) { $py = $cfg.python }
    } catch { }
}
if (-not (Test-Path $py)) {
    $found = (Get-Command python.exe -ErrorAction SilentlyContinue)
    if ($found) { $py = $found.Source }
}
Write-Host ('  python: ' + $py)

$launcherJson = @{ python = $py } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $here 'launcher.json'), $launcherJson, (New-Object Text.UTF8Encoding $false))

# 如果 config.json 不存在就建立一個預設的
if (-not (Test-Path $cfgPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cfgPath) | Out-Null
    $defaults = @{
        python     = $py
        modelsRoot = 'C:\ai\ComfyUI_windows_portable\ComfyUI\models\audio_encoders'
        port       = 8791
        model      = ''
        autostart  = $false
    } | ConvertTo-Json
    [IO.File]::WriteAllText($cfgPath, $defaults, (New-Object Text.UTF8Encoding $false))
}

# ---------------------------------------------------------------- 4. host manifest
$manifestPath = Join-Path $here "$hostName.json"
$manifest = @{
    name            = $hostName
    description     = 'YTLT local Whisper ASR control'
    path            = $exe
    type            = 'stdio'
    allowed_origins = @($ids | ForEach-Object { "chrome-extension://$_/" })
} | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($manifestPath, $manifest, (New-Object Text.UTF8Encoding $false))

# ---------------------------------------------------------------- 5. registry
foreach ($base in @(
        "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
        "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName")) {
    New-Item -Path $base -Force | Out-Null
    Set-ItemProperty -Path $base -Name '(default)' -Value $manifestPath
}

Write-Host ''
Write-Host '[OK] 原生主機已註冊。' -ForegroundColor Green
Write-Host ('     manifest: ' + $manifestPath)
Write-Host ''
Write-Host '接下來：'
Write-Host '  1. chrome://extensions 重新載入擴充功能'
Write-Host '  2. 點擴充功能的齒輪圖示 → 本機辨識設定 → 按「啟動服務」'
Write-Host ''
