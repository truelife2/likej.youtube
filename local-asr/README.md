# 本機 Whisper 辨識服務

給「本機 Whisper」模式用：做語音 → 文字。翻譯預設由擴充功能呼叫 Gemini 文字模型，也可以在 popup 勾「翻譯也走本機」，改由這支服務的 `/translate` 翻（接本機 LLM；完全不消耗 Gemini 額度）。

Chrome 擴充功能不能載入模型，所以模型跑在這支小服務裡，用的是 ComfyUI 內建的 Python（已含 PyTorch + transformers），不需要安裝任何東西。

服務本身也提供**通用的 TTS（文字 → 語音）介面**：內建 `edge`（Edge TTS）與 `sapi`（Windows 內建）兩種引擎，也可以接任何能輸出 WAV 的外部模型（BreezyVoice、CosyVoice2、Kokoro、Piper…），擴充功能只認 `/tts` 這一種介面。

## 使用

1. 執行一次 `native-host\install.cmd`（讓擴充功能能自己叫起服務）。
2. 之後在 popup 選「本機 Whisper」按開始即可，服務會自動啟動，不需要開黑窗、不需要下指令。

所有設定（Python 路徑、模型資料夾、要用哪個模型、連接埠、開機自動啟動）都在 popup 右上 **⚙** 的設定頁，不需要改檔案或加參數。

## API

| 端點 | 說明 |
| --- | --- |
| `GET /health` | 服務狀態、目前模型、裝置，以及 `tts.backend` / `tts.ready`。 |
| `GET /models`、`POST /model` | 掃描模型資料夾、熱切換 Whisper 模型。 |
| `POST /asr` | body 放 16 kHz / 16-bit / 單聲道 PCM，回 `{ok,text,ms}`。可用 header `X-Lang: en` 指定語言。 |
| `POST /translate` | body `{"text":"…","lang":"zh-Hant","src":"en"}`，回 `{ok,text,ms,backend}`。後端沒接上時回 501。 |
| `GET /translate_info` | 翻譯後端、模型、裝置。 |
| `POST /tts` | body `{"text":"…","lang":"zh-Hant","voice":""}`，回 `{ok,rate,pcm,ms}`；`pcm` 是 base64 的 16-bit 單聲道 PCM。 |
| `POST /shutdown` | 關閉服務（設定頁／原生主機用）。 |

## 翻譯介面（本機翻譯）

popup 勾「本機模式翻譯也走本機」後，每句原文會送到 `POST /translate`，拿回譯文就當字幕（有勾配音的話再送 `/tts`）。整條流程都不碰 Gemini，額度不會被吃掉。**建議用 `http` 接本機 LLM（Qwen3-4B，一句約 0.3 秒）**；沒有 GPU 或想更省資源時可用 `command` 包裝任何 CLI 翻譯工具。

這些設定也可以在擴充功能的 **⚙ 設定頁 →「本機翻譯與配音（可選）」** 直接填（存進 `local-asr\config.json`，服務重啟後生效），下面的環境變數／參數寫法適合手動啟動或除錯。

| 設定 | 值 |
| --- | --- |
| `YTLT_TRANSLATE_BACKEND` / `--translate-backend` | `none`（預設）、`http`、`command` |
| `YTLT_TRANSLATE_MODEL` / `--translate-model` | `http` 後端送出的 model 名稱（llama.cpp 的 `-a`） |
| `YTLT_TRANSLATE_URL` / `--translate-url` | `http` 後端的網址（OpenAI 相容 `/v1/chat/completions`） |
| `YTLT_TRANSLATE_KEY` | `http` 後端的 Bearer token（本機服務通常不用） |
| `YTLT_TRANSLATE_CMD` / `--translate-cmd` | `command` 後端指令：原文從 stdin 進、譯文從 stdout 出 |
| `YTLT_TRANSLATE_SRC` / `--translate-src` | 來源語言標籤（只給 `command` 的 `{src}` 用），預設 `en` |
| `YTLT_TRANSLATE_TIMEOUT` | 等翻譯的秒數，預設 30 |

### 方式一：`http`（接本機 LLM，建議）

任何 OpenAI 相容的伺服器都行：llama.cpp 的 `llama-server`、Ollama（`/v1`）、LM Studio、vLLM…。服務會用「即時字幕翻譯器」的系統提示詞，要求只輸出繁體中文譯文。

現成組合（RTX 3060 實測一句 95–330ms、譯文接近 Gemini）：

1. 下載 llama.cpp 的 Windows CUDA 版（例如 `llama-b12499-bin-win-cuda-13.5-x64.zip`），解壓到 `C:\ai\llama.cpp\b12499`。
2. 下載 `Qwen3-4B-Instruct-2507-Q4_K_M.gguf`（約 2.4 GB，HuggingFace `unsloth/Qwen3-4B-Instruct-2507-GGUF`）放到 `C:\ai\models\llm\`。
3. ⚙ 設定頁 →「本機翻譯與配音」：後端選 `http`、網址填 `http://127.0.0.1:8080/v1/chat/completions`、模型名稱填 `qwen3-4b`，再把「本機 LLM 執行檔」（`llama-server.exe`）與「本機 LLM 模型檔」（`.gguf`）填好。之後 popup 一鍵啟動／開機啟動都會順便拉起 llama-server，不用另開視窗。
4. 不用另裝 CUDA runtime：`native-host` 啟動時會把 `python_embeded\Lib\site-packages\torch\lib` 加進 PATH，借用 torch 內附的 `cudart64_13.dll`。

手動啟動長這樣（`-ngl 99` 把模型全放 GPU）：

```
llama-server.exe -m "C:\ai\models\llm\Qwen3-4B-Instruct-2507-Q4_K_M.gguf" -ngl 99 -c 4096 --host 127.0.0.1 --port 8080 -a qwen3-4b
```

```
start.cmd --translate-backend http --translate-url "http://127.0.0.1:8080/v1/chat/completions" --translate-model qwen3-4b
```

Ollama 的例子（model 名稱填你有抓的模型）：

```
start.cmd --translate-backend http --translate-url "http://127.0.0.1:11434/v1/chat/completions" --translate-model qwen3:4b
```

### 方式二：`command`

模型只有 CLI 時用。原文從 **stdin** 進去、譯文從 **stdout** 出來（stdout 只能有譯文）；可用 `{lang}`、`{src}` 替代字。

```
start.cmd --translate-backend command --translate-cmd "python mt.py --to {lang}"
```

### 沒有接上會怎樣

`/translate` 回 `501` 與說明文字。擴充功能若還有 Gemini 金鑰，會**自動退回 Gemini 文字翻譯**並只提醒一次，字幕不中斷；沒有金鑰就顯示錯誤訊息。popup 的服務狀態會顯示「翻譯已接上／未接上」。

## TTS 介面（本機配音）

擴充功能 popup 的「本機模式也配音」打勾後，每句譯文會送到 `POST /tts`，拿回 PCM 就直接排進跟 Gemini 模式同一條播放佇列（原音一樣會壓低）。

後端有五種，用環境變數或命令列參數設定（兩者等效）。**最常用的是內建的 `edge` 與 `sapi`**，不必填任何指令：⚙ 設定頁的「配音引擎」選好就會用同資料夾的指令稿。

> 在設定頁改了**音色**，存檔後下一句就生效；改了**引擎／指令／網址**則要「停止服務」再「啟動服務」（這些是啟動時讀的）。

| 後端 | 說明 |
| --- | --- |
| `edge`（建議） | 內建 `tts-edge.py`（Edge TTS 神經語音），需連網、2–3 秒、較自然 |
| `sapi` | 內建 `tts-sapi.ps1`（Windows 內建語音），完全離線、約 0.5 秒、較機械 |
| `command` | 自己包一支「讀文字、寫出 WAV」的指令 |
| `http` | 外部 TTS 服務 |

> Edge TTS 偶爾會對「某些句子 + 某個音色」回空音訊（實測台灣男聲 `zh-TW-YunJheNeural` 對「我們正在回家」會失敗）。`tts-edge.py` 遇到這種情況會自動改用 `zh-CN-YunxiNeural`（男聲）或 `zh-TW-HsiaoChenNeural`（女聲）重試，並在 stderr 記一行「實際使用音色」，不會整句沒聲音。
| `none` | 不配音（預設） |

| 設定 | 值 |
| --- | --- |
| `YTLT_TTS_BACKEND` / `--tts-backend` | `none`（預設）、`edge`、`sapi`、`command`、`http` |
| `YTLT_TTS_CMD` / `--tts-cmd` | `command` 後端要執行的指令 |
| `YTLT_TTS_URL` / `--tts-url` | `http` 後端的網址 |
| `YTLT_TTS_VOICE` / `--tts-voice` | 預設音色（popup 留空時使用）；edge 預設 `zh-TW-HsiaoChenNeural`、sapi 預設 `Microsoft Hanhan Desktop` |
| `YTLT_TTS_TIMEOUT` | 等語音模型的秒數，預設 30 |

### 方式一：`command`（自訂指令）

把語音模型包成一支「讀文字、寫出 WAV」的指令。可用替代字：

| 替代字 | 內容 |
| --- | --- |
| `{textfile}` | 這一整句文字的 UTF-8 檔（推薦，不怕引號與空白） |
| `{text}` | 文字本身（短句方便，長句可能被 shell 解讀） |
| `{out}` | 要寫出的 WAV 路徑（**必須**產生這個檔） |
| `{lang}` | 目標語言，例如 `zh-Hant` |
| `{voice}` | 音色名稱（popup 填的或 `--tts-voice`） |

WAV 可以是 8/16/24/32-bit 整數或 float32/64、單聲道或雙聲道，服務會自動轉成 16-bit 單聲道；取樣率不限（回傳時會一併告知）。

附了兩支可直接用的指令稿（都在這個資料夾）：

| 指令稿 | 聲音 | 延遲 | 需求 |
| --- | --- | --- | --- |
| `tts-sapi.ps1` | Windows 內建語音（`Microsoft Hanhan Desktop`，台灣女聲） | 約 0.5 秒 | 無（離線） |
| `tts-edge.py` | 微軟線上神經語音（`zh-TW-HsiaoChenNeural` 等） | 約 2–3 秒 | 連網、`pip install edge-tts`、`ffmpeg` 在 PATH |

```
start.cmd --tts-backend command --tts-cmd "powershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0tts-sapi.ps1\" -File \"{textfile}\" -Out \"{out}\" -Voice \"{voice}\"" --tts-voice "Microsoft Hanhan Desktop"

start.cmd --tts-backend command --tts-cmd "python \"%~dp0tts-edge.py\" --file \"{textfile}\" --out \"{out}\" --voice \"{voice}\"" --tts-voice "zh-TW-HsiaoChenNeural"
```

`%~dp0` 是 `start.cmd` 所在的資料夾，貼到「⚙ 設定頁 → 本機翻譯與配音」時要改成完整路徑（例如 `G:\impl\likej.youtube\local-asr\tts-sapi.ps1`）。

> `python -m edge_tts` 直接輸出的是 mp3，而這裡只收 WAV，所以要用 `tts-edge.py`（它會呼叫 ffmpeg 轉成 24 kHz 單聲道 WAV）。
> 要完全離線又想要好聽，就換成任何本機模型（BreezyVoice、CosyVoice2、Chatterbox…）的 CLI，只要它吃文字、吐 WAV 就能接。

### 方式二：`http`

另一個 TTS 服務已經有 HTTP 介面時用這個。服務會 `POST {"text","lang","voice"}` 到 `YTLT_TTS_URL`，回應可以是：

- `Content-Type: audio/wav` 的 WAV 檔；或
- JSON `{"pcm":"<base64 int16>","rate":24000}`；或
- JSON `{"audio":"<base64 WAV>"}`。

```
start.cmd --tts-backend http --tts-url "http://127.0.0.1:9880/tts"
```

### 沒有接上會怎樣

`/tts` 回 `501` 與說明文字，擴充功能只提示一次「本機配音沒有聲音」，**字幕完全照常**。popup 的服務狀態會顯示「配音未接上／已接上」。

## 出問題時

| 症狀 | 處理 |
| --- | --- |
| 連不上服務 | 設定頁看狀態，按 **▶ 啟動服務**。第一次要載入模型（2–10 秒）。 |
| 想手動啟動 | 執行 `local-asr\start.cmd`（除錯用）。 |
| 辨識回空字串 | 正常。太短（< 0.1 秒）或近乎無聲的片段會被擋掉，避免 Whisper 幻覺出「謝謝觀看」。 |
| `HTTP 404`／`429` | 這是文字模型的問題，不是服務壞了：404 換一般文字模型，429 是額度用完。 |
| 勾了配音沒聲音 | 看 popup 狀態是否「配音未接上」；`/tts` 回 501 就是後端沒設好，或服務是改設定前啟動的舊行程（停止再啟動）。 |
| `TTS 指令失敗` | 錯誤訊息會帶指令的 stderr 末段；先用同一條指令手動跑一次確認能產出 WAV。 |
| 勾了本機翻譯卻還是用掉額度 | 看 popup 狀態是否「翻譯未接上」；`/translate` 回 501 就是沒設定 `translateBackend`（設定頁 → 本機翻譯與配音）。 |
| 第一句翻譯卡很久 | llama.cpp 的模型載入要幾秒（4 GB 模型約 4 秒）；先手動跑一次 llama-server 確認可用。 |
| 本機 LLM 沒被自動拉起 | 翻譯後端必須是 `http`，且設定頁的「本機 LLM 執行檔／模型檔」都填了存在的路徑；log 在 `native-host\.logs\llm.log`。 |

端點與實作細節看 [`docs/DESIGN.md`](../docs/DESIGN.md#本機-whisper-服務)。
