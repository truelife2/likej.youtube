# 本機 Whisper 辨識服務

給擴充功能的「本機 Whisper + Gemini 文字」模式用。只做**語音 → 英文文字**，
翻譯由擴充功能呼叫 Gemini 純文字模型完成。

## 為什麼要跑這個

Chrome 擴充功能不能載入 AI 模型，所以模型必須跑在你電腦上的一個小服務裡。
這個服務用你 ComfyUI 內建的 Python（已含 PyTorch + transformers），不需要安裝任何東西。

## 啟動

**正常用法：不用手動啟動。** 跑一次

```bat
native-host\install.cmd
```

它會編譯一個小啟動器、註冊 Chrome／Edge 的原生主機，之後在擴充功能按「開始」時會自動把服務叫起來（已經在跑就直接沿用）。
popup 的齒輪（⚙）→「本機辨識設定」可以看狀態、啟動／停止、換模型、改 Python 與模型資料夾。

手動啟動（除錯用；參數或模型可以在這裡指定）：

```bat
local-asr\start.cmd
```

或直接：

```bat
"C:\ai\ComfyUI_windows_portable\python_embeded\python.exe" asr-server.py --preload
```

看到下面這行就代表好了：

```
[asr] 監聽 http://127.0.0.1:8791  （Ctrl+C 結束）
```

同一時間只會有一份在跑：連接埠已被佔用時，新啟動的會自己結束（避免兩份模型把 VRAM 吃爆）。

## 設定（`local-asr/config.json`）

由設定頁寫入，也可以自己改：

| 欄位 | 預設 | 說明 |
| --- | --- | --- |
| `python` | `C:\ai\ComfyUI_windows_portable\python_embeded\python.exe` | 執行服務的 Python（需要 torch + transformers） |
| `modelsRoot` | `...\ComfyUI\models\audio_encoders` | 模型根目錄，設定頁的模型下拉就是掃這裡 |
| `port` | `8791` | 監聽埠 |
| `model` | `""` | 指定模型（空＝預設 turbo；可填資料夾名或完整路徑） |
| `autostart` | `false` | 登入 Windows 時自動啟動服務 |

## 參數

| 參數 | 預設 | 說明 |
| --- | --- | --- |
| `--model` | `...\audio_encoders\openai_whisper-large-v3-turbo` | 模型資料夾（HF 格式，含 `model.safetensors`） |
| `--models-root` | `...\audio_encoders` | 掃描模型用的根目錄 |
| `--port` | `8791` | 監聽埠，改這裡也要改 popup／設定頁 |
| `--lang` | `en` | 預設語言；擴充功能送 `X-Lang` 時以 header 為準 |
| `--preload` | 關 | 啟動就載入模型並暖機（約 2–6 秒），否則第一次請求才載入 |

也可以換成較大的 `openai_whisper-large-v3`（2.9 GB），英文準確度略高、速度約慢 3 倍；
在設定頁的模型下拉切換即可，**不用重啟服務**（實測切換約 2–10 秒，會先釋放舊模型）。

## 實測（RTX 3060 12 GB、large-v3-turbo）

| 音訊長度 | 辨識時間 | RTF |
| --- | --- | --- |
| 3 秒 | 0.26 秒 | 0.09 |
| 10 秒 | 0.5–0.6 秒 | 0.06 |

即約 11–16 倍即時，所以永遠追得上，不會愈翻愈慢。

## API

```
GET  /health   → {"ok":true,"model":"...","modelName":"...","modelsRoot":"...","device":"cuda","loading":false}
GET  /models   → {"ok":true,"root":"...","current":"...","models":[{"name":"openai_whisper-large-v3-turbo","path":"...","mb":1542}]}
POST /model    → body: {"path":"openai_whisper-large-v3"}（資料夾名或完整路徑）
                 → {"ok":true,"model":"...","ms":9466,"device":"cuda"}
POST /asr      → body: 16 kHz / 16-bit / 單聲道 PCM
                 headers: X-Lang: en（可省略＝自動偵測）
                 → {"ok":true,"text":"...","ms":263}
POST /shutdown → {"ok":true}（服務自己關閉，設定頁的「停止服務」用它）
```

伺服器會自己擋掉兩種不該辨識的音訊：短於 0.1 秒的碎片，以及 RMS < 0.004 的近靜音
（Whisper 在靜音與音樂上會幻覺出 "Thank you."、"謝謝觀看" 之類的句子）。
所以回傳空字串是正常結果，不是錯誤。

## 原生主機（`native-host/`）

Chrome 擴充功能不能直接執行外部程式，所以透過原生訊息主機代勞：

| 檔案 | 作用 |
| --- | --- |
| `host.py` | 收 JSON 命令：`ping`、`status`、`start`、`stop`、`get-config`、`set-config`、`list-models`、`detect-python`、`autostart` |
| `launcher.cs` → `launcher.exe` | Chrome 在 Windows 只認 `.exe`，這個小啟動器負責叫起 `host.py` 並轉接 stdin/stdout |
| `install.ps1` / `install.cmd` | 編譯啟動器、寫 `com.ytlt.asr.json`、註冊到 HKCU（Chrome 與 Edge） |
| `uninstall.cmd` | 移除註冊 |

`install.ps1` 會自動從 Chrome 的 Preferences 找擴充功能 ID，找不到就用「路徑雜湊」推算四種可能，全部放進 `allowed_origins`，
所以通常是無聲無息就裝好了。萬一擴充功能還是說找不到主機，開設定頁複製「擴充功能 ID」，執行：

```bat
native-host\install.cmd <ID>
```
