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
| `PCM_MAX` | 14 s | 等不到句尾的保底上限 |
| `SPEAKER_QUIET` / `SPEAKER_IDLE` | 700 / 300 ms | 講者停這麼久、且音訊也靜這麼久 → 可以播 |
| `FLUSH_QUIET` | 700 ms | 句尾標點後，音訊靜止這麼久算到齊 |
| `FLUSH_MAX_WAIT` | 4000 ms | 句尾標點後最多再等這麼久 |
| `IDLE_FLUSH` / `OPEN_IDLE` | 6000 / 20000 ms | 沒有標點時，逐字稿已收尾／未收尾的等待上限 |
| `ENUF_RATIO` / `HOLD_MAX` | 0.75 / 800 ms | 音訊夠不夠的判定比例／最多多等多久 |

判斷順序：

1. `secs >= PCM_MAX`，或句尾已標記且等滿 `FLUSH_MAX_WAIT`，或逐字稿靜止超過上限 → **一定播**。
2. 講者真的停（`SPEAKER_QUIET`）或句尾標點 + 音訊靜止（`FLUSH_QUIET`）→ 先檢查音訊夠不夠：用「每個字平均音長」（`sPerChar`，每次播出後 EMA 更新）估這句需要多少秒，不足 `ENUF_RATIO` 就再等，**最多 `HOLD_MAX`**。

「講者停頓」直接看擷取波形，不等辨識或模型，所以沒有解析延遲。逐字稿未到句尾（停在逗號）時不因停頓切句。

播出前會：`trimSilence()` 剪頭尾靜音 → `smoothGaps()` 把句中長空白（0.15 s 以上）壓成 0.06 s（被壓超過 90% 就放棄，避免吃字）→ `resampleTo()` 內插到 `ctx.sampleRate`。自己重取樣是為了讓 `BufferSource` 不再各自重取樣，句內才樣本連續。

`playCursor` 只在有空隙時前移，**絕不往回跳**（往回跳會讓新音塊插進已排定的隊列，變成多個聲音同時說話）。每段播出後 emit `{kind:'seg', dur, gapMs, quietMs}` 給字幕框畫分段記號。

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
- 句子用白／淺藍雙色輪替；有 `turn` 事件的模型每回合換色，連續串流模型用句尾標點判斷。
- 診斷列每 2 秒更新：`延遲` / `待譯` / `落後` / `峰值` / `送稿`。

## 本機 Whisper 服務

`local-asr/asr-server.py`：標準庫 `http.server` + `transformers` pipeline，沒有額外依賴。

| 端點 | 用途 |
| --- | --- |
| `GET /health` | 狀態、模型名稱、device、模型資料夾 |
| `GET /models` | 列出模型資料夾內可用模型 |
| `POST /model` | 熱切換模型（清 GPU 快取後重新載入） |
| `POST /asr` | 16 kHz s16le PCM → `{text, ms}` |
| `POST /shutdown` | 關閉服務 |

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
node test-flow.cjs            # 假 WebSocket 走完整流程（含 translate、補送佇列）
node test-segment.cjs         # 真實音訊的切句品質
node tools/test-playback.cjs  # 配音排程：不切句、不重疊、不丟音
node tools/check-ids.cjs      # popup.js 的 id 是否都存在
python -m py_compile local-asr/asr-server.py native-host/host.py
```

實測基準（`testmedia/audio48.pcm`，762 秒英文講道）：切出約 150 句、句長中位數約 4.1 秒、送出約 79% 音訊。Whisper `large-v3-turbo` 在 RTX 3060 上 RTF 約 0.06–0.09（11–16 倍即時）。
