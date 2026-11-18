# 設計與內部運作

給想知道「它怎麼跑、為什麼這樣寫」的人。安裝與使用看 [`README.md`](../README.md)。

## 整體架構

```
YouTube 分頁音訊
      │  chrome.tabCapture.getMediaStreamId()   ← 使用者點圖示後由 service worker 取得
      ▼
offscreen document
      ├─ AudioContext ─► GainNode(dry) ─► 喇叭   （原音；配音時壓低）
      │              └─► GainNode(dub) ─► 喇叭   （譯音）
      └─ AudioWorklet：混單聲道 → 低通 → 16kHz/16-bit PCM（每 100ms 一塊）
                      ▼
      兩條管線之一
      ┌──────────────────────────┬─────────────────────────────┐
      │ Gemini 即時翻譯           │ 本機 Whisper + Gemini 文字    │
      │ SpeechSegmenter（可選）    │ SpeechSegmenter（必用）       │
      │ → WebSocket 串流音訊       │ → POST /asr → 英文句          │
      │ → 24kHz 語音 + 逐字稿      │ → generateContent → 中文      │
      └──────────────────────────┴─────────────────────────────┘
                      ▼
      service worker ─► content script ─► Shadow DOM 字幕框
```

擷取與播放共用同一個 `AudioContext`，不需要另外處理時鐘同步。

## 音訊管線

### 降採樣（`audio-worklet.js`）

Live API 只吃 16 kHz、16-bit、單聲道 PCM。Worklet 在音訊執行緒做：混單聲道 → 一階低通（`min(7000, rate×0.45)`）→ 線性插值降採樣 → 累積 1600 樣本（100 ms）才 `postMessage` 並轉移 buffer。

### 切句（`vad.js` 的 `SpeechSegmenter`）

純邏輯、無 DOM 依賴，可離線測試。

| 參數 | 值 | 意義 |
| --- | --- | --- |
| `frameMs` | 100 | 一塊 = 100 ms |
| `preRollChunks` | 5 | 句首多留 0.5 秒，避免第一個字被切掉 |
| `startFrames` | 2 | 連續 2 塊超過門檻才算開口 |
| `endFrames` | 8 | 停頓 0.8 秒才斷句 |
| `maxUtteranceMs` | 12000 | 沒有停頓時每 12 秒強制切一句 |

門檻 `min(0.02, max(0.006, noise×1.6)) / sensitivity`；噪音底只在靜音時緩慢更新，避免背景音樂把門檻拉高。

**`push()` 是逐塊回傳音訊的**：`start` 回 preroll、中間回當前那塊、`end` 只回最後一塊。任何需要「整句」的用途都要自己累積。

### 短句接續（本機模式）

不足 `MIN_UTT_SEC = 1.8` 秒的片段先押著；下一段在 `TAIL_WAIT_MS = 1400` ms 內開口就併在同一句，逾時自己送出。不丟音訊，只是最多延遲 1.4 秒。

## 譯音播放

模型的譯音是幾十毫秒一塊串流回來的。逐塊建立 `AudioBufferSourceNode` 會在每個接縫留下瑕疵（聽起來「幾個字、停一下」），所以改成**以句子為單位併段播出**。

| 常數 | 值 | 作用 |
| --- | --- | --- |
| `PCM_LEAD` / `PCM_RELEAD` | 0.6 / 0.12 s | 真正空檔後重新開播的緩衝（第一次用大的） |
| `TRIM_HEAD` / `TRIM_TAIL` | 0.06 / 0.1 s | 每段頭尾只留這麼多靜音 |
| `PCM_MAX` | 20 s | 等不到換色的保底上限 |
| `FLIP_IDLE` / `FLIP_MAX_WAIT` | 250 / 1500 ms | 字幕換色後，譯音靜止這麼久（或最多再等這麼久）就整塊播 |
| `FLUSH_MAX_WAIT` | 4000 ms | 句尾標點後一直等不到換色時，最多再等這麼久 |
| `IDLE_FLUSH` / `OPEN_IDLE` | 6000 / 20000 ms | 沒有標點時，逐字稿已收尾／未收尾的等待上限 |
| `ENUF_RATIO` / `HOLD_MAX` | 0.75 / 800 ms | 音訊夠不夠的判定比例／最多多等多久 |

判斷順序：

1. `secs >= PCM_MAX`，或句尾已標記且等滿 `FLUSH_MAX_WAIT`（一直等不到下一次換色），或逐字稿靜止超過上限 → **一定播**。
2. 字幕換色（`flipAt`：上一句已收尾、下一段譯文才到）且譯音靜止 `FLIP_IDLE` → 先把「前一整塊」播完；音訊還零碎滴進來時最多再等 `FLIP_MAX_WAIT`。

**配音的單位是「色塊」而不是「句子」**：色塊結束（字幕換色）才是播出點，所以畫面上的號碼＝真的聽到的音訊片段。換色後先用「每個字平均音長」（`sPerChar`，每次播出後 EMA 更新）確認音訊夠整塊，不足 `ENUF_RATIO` 就再等，**最多 `HOLD_MAX`**。

換色點由 `handleServerPayload` 判定：`sentBoundary`（上一段逐字稿以句尾標點收尾，或有 `turn` 事件）為真時，下一段非空譯文到達的瞬間就是換色點，記進 `flipAt`。字幕端（`content.js`）用同一條規則換色，所以文字與配音對得起來。

播出前會：`trimSilence()` 剪頭尾靜音 → `smoothGaps()` 把句中長空白（0.15 s 以上）壓成 0.06 s（被壓超過 90% 就放棄，避免吃字）→ `resampleTo()` 內插到 `ctx.sampleRate`。自己重取樣是為了讓 `BufferSource` 不再各自重取樣，句內才樣本連續。

`playCursor` 只在有空隙時前移，**絕不往回跳**（往回跳會讓新音塊插進已排定的隊列，變成多個聲音同時說話）。診斷用的片段號在字幕框產生：**一個色塊（＝一次配音）一個號碼**，標在色塊結尾、也就是字幕換色的那一刻——號碼出現的同時，那一段配音正好開始播；停止再開始才從 `(1)` 重新數。片段號只是診斷標記，**不計入** `trimOutput`／`rollOutput` 的字數，所以不會讓字幕提早消失；字幕保留約 5–6 行真正的文字。**不做音塊編號、段號、tooltip、播放亮燈或停頓標記。**

## 原音壓低（ducking）

- `dryGain` = `originalVolume`，`dubGain` = `outputVolume`（0–150%）
- 譯音播放時 `dryGain` 乘 `duckFactor`（`duckLevel`，預設 0.12；1 = 不壓低）
- 所有譯音播完才恢復；`GAIN` 訊息用 `setTargetAtTime` 平滑調整，播放中即時生效

## 連線與容錯

- **連線前佇列**：`setupComplete` 前的音訊進 `live.pending`（上限 12 秒），連線就緒後補送。
- **自動降級**：初始化被拒時依序拿掉 `realtimeInputConfig`、`speechConfig`、逐字稿欄位重試（`liteLevel` 0→3）。
- **模式解析**：`dub`（要 AUDIO 並播放）、`text`（要 TEXT）、`silent`（要 AUDIO 不播放，只取逐字稿）。2026 年起 Live API 沒有 TEXT 輸出模型，`silent` 是常態。
- **goAway**：先 `ready = false`（音訊進佇列）再重連，指數退避上限約 30 秒，連續失敗 4 次停止。
- **429**：重試 0.8 → 2 → 4 秒，仍失敗暫停 60 秒並把句子放回佇列（上限 90 句）。

## 字幕顯示

Shadow DOM 建立字幕框，YouTube 樣式不會互相影響。

- `pushText()` 只累積字串，DOM 由 `scheduleRender()` 併到 `requestAnimationFrame`，一畫格最多一次。
- 譯文只累積不覆蓋；超過約 120 字沿句子邊界捲掉最舊的。
- 句子用白／淺藍雙色輪替；有 `turn` 事件的模型每回合換色，連續串流模型用句尾標點判斷。換色同時也是配音的播出點（色塊＝音訊片段）。
- 診斷列每 2 秒更新：`延遲` / `待譯` / `落後` / `峰值` / `送稿`。

## 本機 Whisper 服務

`local-asr/asr-server.py`：標準庫 `http.server` + `transformers` pipeline，沒有額外依賴。

| 端點 | 用途 |
| --- | --- |
| `GET /health` | 狀態、模型名稱、device、模型資料夾、`tts`／`translate` 後端狀態 |
| `GET /models` | 列出模型資料夾內可用模型 |
| `POST /model` | 熱切換模型（清 GPU 快取後重新載入） |
| `POST /asr` | 16 kHz s16le PCM → `{text, ms}` |
| `POST /translate` | `{text, lang, src}` → `{text, ms, backend}` |
| `POST /tts` | `{text, lang, voice}` → `{rate, pcm}`（base64 16-bit 單聲道） |
| `POST /shutdown` | 關閉服務 |

### 本機翻譯（通用 `/translate` 介面）

`POST /translate` 依 `YTLT_TRANSLATE_BACKEND` 分派：

- `http`：POST OpenAI 相容的 `/v1/chat/completions`（llama.cpp、Ollama、LM Studio、vLLM），系統提示詞要求只輸出譯文；回應解析 `choices[0].message.content` 或 `text`／`translation`。目標語言經 `TR_LANG_NAME` 轉成提示詞看得懂的名字（`zh-Hant` → 繁體中文（台灣））。
- `command`：原文走 stdin，譯文從 stdout 讀回（`{lang}` `{src}` 替代字）。
- `none`（預設）：回 501 與設定說明。

`translate_text()` 以 `TR_LOCK`（RLock，序列化推論）序列化，避免搶 GPU。擴充功能端 `translateOne()`：`config.localTranslate` 為真時打 `/translate`；遇到 501／404／500／連不上且還有 Gemini 金鑰就自動退回 `translateGemini()`，只提醒一次（`live.mtWarned`）。`translateWithRetry()` 只對 429／5xx 重試，維持原本配額暫停邏輯。

實務上建議 `http` 接 llama.cpp 的 Qwen3-4B-Instruct（Q4_K_M，約 2.4 GB）：一句 95–330ms、譯文接近 Gemini。`native-host/host.py` 會順便管理它——`start_server()` 先呼叫 `start_llm()`，用 `llmExe`／`llmModel`／`llmPort`（+ `llmArgs`）啟動 `llama-server.exe -m <gguf> -ngl 99 -c 4096 --host 127.0.0.1 --port N -a <translateModel>`，`cwd` 設在執行檔目錄、PATH 前插執行檔目錄與 `python_embeded\Lib\site-packages\torch\lib`（借 torch 的 `cudart64_13.dll`，不必另裝 CUDA runtime），log 寫 `.logs/llm.log`；`stop_server()` 用 netstat 找 port 的 PID 再 taskkill。舊行程不會自動套用新設定，改完要「停止服務 → 啟動服務」。

### 本機配音（通用 TTS 介面）

`asr-server.py` 只定義介面，不含語音模型。`POST /tts` 依 `YTLT_TTS_BACKEND` 分派：

- `edge`：內建，跑同資料夾的 `tts-edge.py`（Edge TTS，需連網；2–3 秒）。
- `sapi`：內建，跑同資料夾的 `tts-sapi.ps1`（Windows SAPI，完全離線；約 0.5 秒）。
- `command`：把文字寫成 `in.txt`，執行 `YTLT_TTS_CMD`（可含 `{textfile}` `{out}` `{lang}` `{voice}` `{text}`），讀回 `{out}` 的 WAV。
- `http`：把 `{text,lang,voice}` POST 到 `YTLT_TTS_URL`，回應收 WAV 或 JSON（`pcm`／`audio`）。
- `none`（預設）：回 501 與設定說明。

`edge`／`sapi` 若拿到不屬於自己的音色（例如 edge 收到 `Microsoft Hanhan Desktop`）會自動改用該引擎的預設音色，避免整句合成失敗；`/health` 的 `tts.voice` 回報的是實際會用的音色。

WAV 解析自己寫（`wav_to_pcm16`）：支援 PCM 8/16/24/32-bit 與 float32/64、單/雙聲道，統一轉 16-bit 單聲道；取樣率照原檔回報。多數語音模型不能同時推論，`synthesize()` 用 `TTS_LOCK` 排隊。

repo 內附兩支現成指令稿：`local-asr/tts-sapi.ps1`（Windows SAPI，`Microsoft Hanhan Desktop` 台灣女聲，離線約 0.4–0.5 秒、22.05 kHz）與 `local-asr/tts-edge.py`（edge-tts 神經語音，需網路，2–3 秒、24 kHz；`python -m edge_tts` 只吐 mp3，這支用 ffmpeg 轉 WAV）。

擴充功能端：`engine === 'local'` 且 `config.localTts` 時，`pumpLocal()` 每句譯文用 `live.ttsChain` 串接 `speakLocal()`（不阻塞下一句辨識，順序由 `playCursor` 保證）；`speakLocal()` 直接 `queuePcm()` + `flushPcm()`，跳過 `playPcm()` 的 `resolvedMode === 'silent'` 檢查（那個檢查只為 Gemini 模式的純字幕情境）。失敗只提示一次，不影響字幕。

### 原生主機（`native-host/`）

Chrome 在 Windows 只接受 `.exe` 作為原生主機，所以 `launcher.cs` 編譯成 `launcher.exe`，再啟動 `python host.py` 轉送 stdin/stdout。

`host.py` 命令：`ping`、`status`、`start`、`stop`、`get-config`、`set-config`、`list-models`、`detect-python`、`autostart`。

`install.ps1`：解析擴充功能 ID（抓不到就用編碼 × 斜線的 4 種寫法算候選，全放進 `allowed_origins`）→ 編譯 launcher → 寫 manifest → 註冊 Chrome 與 Edge。**必須存成 UTF-8 with BOM**，否則 PowerShell 5.1 讀中文字串會壞。

## 關鍵設計取捨

1. **一次只允許一條擷取管線**：重複按開始會變兩倍速，模型永遠追不上，從外面看不出原因（`live.starting` 互斥 + `handleStart` 先停舊的）。
2. **不限速、不丟音訊**：來不及就靠自動暫停影片追上。唯一例外是連線前的 12 秒佇列。
3. **字幕用 rAF 合併重繪**：模型每秒吐十多個片段，直接寫 DOM 會反覆重排。
4. **`落後` 不是網路問題**：它是相對值，體感延遲看 `延遲`。
5. **offscreen 只申請 `USER_MEDIA`**：`AUDIO_PLAYBACK` 有「30 秒沒播音就關閉」規則，字幕模式會整條被回收。
6. **content script 版本握手**：PING 取得版本，不符就重新注入；舊實例用 `window.__ytltDestroy` 退場。
7. **過濾對話模型的思考旁白**：`native-audio` / `3.8-live` 會把推理寫進逐字稿，用 system prompt 禁止 + `stripMeta()`（只套用在非 translate 模型）。

## 模型備註（2026-11）

- Live API 模型全部只輸出 AUDIO，要文字只能靠 `outputAudioTranscription`。
- `gemini-3.5-live-translate-preview`：連續串流口譯，`generationConfig.translationConfig.targetLanguageCode`（BCP-47）；不支援 `speechConfig`／tools／文字輸入，音色會複製講者。
- `gemini-3.5-transcribe-live`：只轉文字不翻譯。
- `gemini-3.8-live`、`3.8-live-extended-thinking`、`3.1-flash-live-preview`：對話模型，等整句講完才回。
- 舊的 `gemini-live-2.5-flash-preview`、`gemini-2.0-flash-live-001` 已下線。

## 檔案結構

```
manifest.json        MV3 設定：權限、offscreen、content script、options 頁
background.js        service worker：stream id、offscreen 生命週期、訊息路由、原生主機橋接
offscreen.html/js    音訊擷取 + 播放 + Live WebSocket + 本機模式 + 重連/降級
vad.js               SpeechSegmenter（純邏輯，可單獨測試）
audio-worklet.js     48 kHz → 16 kHz PCM（音訊執行緒）
content.js           字幕框（Shadow DOM、雙色、拖曳、診斷列）
popup.html/css/js    主設定介面
options.html/css/js  本機服務設定頁
local-asr/           Whisper HTTP 服務
native-host/         原生主機（host.py、launcher.cs、install.ps1）
tools/               test-playback / check-ids / make-icons
test-*.cjs           離線測試
testmedia/           測試素材（可刪）
```

## 測試

```bash
node test-selftest.cjs        # worklet、base64、setup 結構、duckFactor/dubLevel、語言代碼
node test-flow.cjs            # 假 WebSocket 走完整流程（含 translate、補送佇列、本機配音 /tts、本機翻譯 /translate）
node test-segment.cjs         # 真實音訊的切句品質
node tools/test-playback.cjs  # 配音排程：不切句、不重疊、不丟音
node tools/check-ids.cjs      # popup.js 的 id 是否都存在
python -m py_compile local-asr/asr-server.py native-host/host.py
```

實測基準（`testmedia/audio48.pcm`，762 秒英文講道）：切出約 150 句、句長中位數約 4.1 秒、送出約 79% 音訊。Whisper `large-v3-turbo` 在 RTX 3060 上 RTF 約 0.06–0.09（11–16 倍即時）。
