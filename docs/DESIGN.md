# 設計與內部運作

這份文件給「想知道它怎麼跑、為什麼這樣寫」的人。只想安裝和使用，看 [`README.md`](../README.md) 就好。

---

## 整體架構

```
YouTube 分頁音訊
      │  chrome.tabCapture.getMediaStreamId()   ← 使用者點圖示後由 service worker 取得
      ▼
offscreen document（MV3 不會回收的隱藏頁）
      ├─ AudioContext ─► GainNode(dry)  ─► 喇叭        （原音；配音時壓低）
      │              └─► GainNode(dub)  ─► 喇叭        （譯音）
      └─ AudioWorklet：混單聲道 → 低通 → 16kHz/16-bit PCM（每 100ms 一塊）
                      ▼
      兩條管線之一
      ┌───────────────────────────────┬───────────────────────────────┐
      │ Gemini 即時翻譯                │ 本機 Whisper + Gemini 文字      │
      │ SpeechSegmenter（可選）        │ SpeechSegmenter（必用）         │
      │ → WebSocket 串流音訊            │ → POST /asr（本機）→ 英文句     │
      │ → 24kHz 語音 + 逐字稿           │ → Gemini generateContent → 中文 │
      └───────────────────────────────┴───────────────────────────────┘
                      ▼
      service worker ─► content script ─► Shadow DOM 字幕框
```

擷取與播放都靠同一個 `AudioContext`，所以不需要另外處理時鐘同步。

---

## 音訊管線細節

### 降採樣（`audio-worklet.js`）

Live API 只吃 16 kHz、16-bit、單聲道 PCM。Worklet 在音訊執行緒裡：

1. 多聲道混成單聲道
2. 一階低通（cutoff = min(7000, targetRate × 0.45)）避免降採樣別名
3. 線性插值降到 16 kHz
4. 累積 1600 個樣本（100 ms）才 `postMessage`，並轉移 buffer 所有權

> 早期版本降採樣迴圈的條件寫成 `readPos + 1 < len`，等於每個 block 多產生一個樣本，造成 0.83% 的速度漂移（12 分鐘多送 6 秒音訊）。已改為 `readPos + ratio < len`。

### 切句（`vad.js` 的 `SpeechSegmenter`）

純邏輯、無 DOM 依賴，所以可以離線測試。

| 參數 | 值 | 意義 |
| --- | --- | --- |
| `frameMs` | 100 | 一塊 = 100 ms |
| `preRollChunks` | 5 | 句首多留 0.5 秒，避免第一個字被切掉 |
| `startFrames` | 2 | 連續 2 塊超過門檻才算開口 |
| `endFrames` | 8 | 停頓 0.8 秒才斷句 |
| `maxUtteranceMs` | 12000 | 沒有停頓的旁白每 12 秒強制切一句 |

門檻：`min(0.02, max(0.006, noise × 1.6)) / sensitivity`，噪音底只在靜音時緩慢更新，避免背景音樂把門檻拉高導致永遠不觸發。

**重要行為**：`push()` 是「逐塊」回傳音訊的。`start` 那次回 preroll，中間每次只回當前那塊，`end` 那次只回最後一塊。所以任何需要「整句」的用途（例如本機 Whisper）都必須自己累積，不能只拿 `end` 的 `chunks`。

### 短句接續（本機模式）

碎片化的句子會讓 Whisper 只能猜出幾個字，所以：

- 不足 `MIN_UTT_SEC = 1.8` 秒的片段先押著（`tailChunks`）
- 下一段在 `TAIL_WAIT_MS = 1400` 毫秒內開口 → 接在同一個句子前面一起送
- 沒接上 → 逾時自己送出（`flushTail()`）

**不丟音訊**，只是最多延遲 1.4 秒。

### 譯音播放（`playPcm` → `queuePcm` → `flushPcm`）

`live-translate` 的輸出音訊是幾十毫秒一塊串流回來的。逐塊建立 `AudioBufferSourceNode` 會在每個接縫出現瑕疵，聽起來就是「幾個字、停一下」。

現在改成「以句子為單位併段」：一句的譯音到齊後，把緩衝中的音訊合成一個 `AudioBuffer` 一起播出。判斷「一句到齊」有三個觸發點：

| 常數 | 值 | 作用 |
| --- | --- | --- |
| `PCM_LEAD` | 0.6 s | 只有在真正空檔（排程落後）時才補的開播緩衝，吸收網路抖動 |
| `PCM_MAX` | 8.0 s | 等不到句尾的保底上限（正常句子遠短於此，等同不切句） |
| `FLUSH_DEBOUNCE` | 400 ms | 看到句尾標點後再等這麼久，讓句尾（含數字）的音訊塊到齊 |
| 音訊閒置 | 800 ms | 沒有新音塊進來超過這個時間、且緩衝有內容 → 這句講完了，播出 |

句子邊界優先從 `outputTranscription` 的句尾標點判斷（`markSentenceEnd()`），逐字稿來不及標點時靠「音訊閒置 800ms」補上——這也是數字、專有名詞後面模型會停頓的情況。**播放中不再因為「快斷炊」提前切句**，那是「唸幾個字就停」的主因。

即使湊成一句，聽起來仍會斷，還有兩個來源，都已處理：

1. **每個節點各自重取樣**：模型的譯音是 24 kHz，播放裝置通常是 48 kHz。若直接把 24 kHz 的 `AudioBuffer` 交給 `BufferSource`，每個節點都會各自重取樣，接縫處留下極短空隙。現在 `flushPcm()` 先用 `resampleTo()` 線性內插成 `ctx.sampleRate` 再建 buffer，`BufferSource` 完全不做重取樣，句內就是樣本連續。
2. **模型在字與字之間留空白**（數字、專有名詞最明顯）：`smoothGaps()` 掃描 10 ms 一格的能量，把句中的長空白壓短（0.18 s → 0.05 s），句首句尾與短空白不動；被壓掉的量超過 40% 就放棄、整段照原樣播，避免吃字。


排程游標（`playCursor`）只在「有空隙」時前移，**絕不往回跳**——往回跳會讓新音塊插進已排定的隊列，聽起來就是多個聲音同時說話。

代價是譯音比字幕晚約 0.35 秒。

### 原音壓低（ducking）

- `dryGain` = 原音基準（`originalVolume`）
- `dubGain` = 譯音音量（`outputVolume`，0–150%）
- 譯音開始播放時，`dryGain` 乘上 `duckFactor`（預設 0.12，可選 1 / 0.5 / 0.25 / 0.12 / 0.05）
- 所有譯音音塊播完才恢復

音量調整走 `GAIN` 訊息，用 `setTargetAtTime` 平滑過渡，播放中即時生效。

---

## 連線與容錯

### 連線前的音訊佇列

WebSocket 還沒 `setupComplete` 之前收到的音訊原本直接丟掉，開頭幾秒就沒字幕。現在進 `live.pending`（上限 `PENDING_MAX = 120` 塊 = 12 秒），連線就緒後一次補送。

### 自動降級

不同模型支援的設定欄位不同（`realtimeInputConfig`、`speechConfig`、逐字稿）。初始化被拒時會依序拿掉這些欄位重試（`liteLevel` 0→3）。

### 模式解析（`resolveMode`）

| 情況 | 模式 | 行為 |
| --- | --- | --- |
| 輸出＝配音 | `dub` | 要 AUDIO、播放譯音 |
| 輸出＝僅字幕，模型支援 TEXT | `text` | 要 TEXT |
| 輸出＝僅字幕，模型只支援 AUDIO（native-audio、live-translate） | `silent` | 要 AUDIO 但不播放，只取逐字稿 |

2026 年起 Live API 沒有支援 TEXT 輸出的模型，所以 `silent` 是常態。

### goAway 與重連

伺服器送 `goAway` 時先把 `live.ready = false`，之後的音訊進佇列，重連完成再一次補送，中間不會留下聽不見的空白段。重連採指數退避（上限約 30 秒），連續失敗 4 次停止。

### 配額（429）處理

本機模式的文字翻譯：

1. 429 / 5xx → 自動重試 0.8 → 2 → 4 秒
2. 仍失敗 → 暫停 60 秒（`quotaUntil`），把句子 `unshift` 回佇列，恢復後照原順序翻
3. 佇列上限 90 句，真的滿了才捨棄並提示

---

## 字幕顯示

`content.js` 用 Shadow DOM 建立字幕框，所以 YouTube 的樣式不會影響它，也不會污染頁面。

- `pushText()` 只累積字串，實際 DOM 寫入由 `scheduleRender()` 排到 `requestAnimationFrame`，一畫格最多一次，內容沒變不碰 DOM
- 譯文**只累積不覆蓋**；超過約 120 字沿句子邊界（`\n` `。` `！` `？` `；` `. `）捲掉最舊的
- 不同句子用**白／淺藍雙色輪替**。有 `turn` 事件的模型每回合換色；連續串流模型（live-translate）改用「累積文字已以句尾標點結尾」判斷換色
- 診斷列每 2 秒更新：`延遲` / `待譯` / `落後` / `峰值` / `送稿`

---

## 本機 Whisper 服務

`local-asr/asr-server.py`：純標準庫 `http.server` + `transformers` pipeline，沒有額外依賴。

| 端點 | 用途 |
| --- | --- |
| `GET /health` | 狀態、模型名稱、device、模型資料夾 |
| `GET /models` | 掃描模型資料夾列出可用模型 |
| `POST /model` | 熱切換模型（清 GPU 快取後重新載入） |
| `POST /asr` | 16 kHz s16le PCM → `{text, ms}` |
| `POST /shutdown` | 關閉服務 |

細節（參數、語言代碼、實測 RTF）見 [`local-asr/README.md`](../local-asr/README.md)。

### 原生主機（`native-host/`）

Chrome 在 Windows 只接受 `.exe` 作為原生主機，所以 `launcher.cs` 編譯成 `launcher.exe`，它再啟動 `python host.py` 並雙向轉送 stdin/stdout。

`host.py` 提供命令：`ping`、`status`、`start`、`stop`、`get-config`、`set-config`、`list-models`、`detect-python`、`autostart`。

`install.ps1` 會：解析擴充功能 ID（抓不到就用 UTF-16LE/UTF-8 × 斜線/反斜線算出 4 個候選，全部放進 `allowed_origins`）→ 編譯 launcher → 寫 manifest → 註冊 Chrome 與 Edge 的登錄機碼。

> 注意：`install.ps1` 必須存成 **UTF-8 with BOM**。PowerShell 5.1 讀無 BOM 的 UTF-8 中文會變亂碼，甚至讓字串提早結束、腳本半途失效。

---

## 關鍵設計取捨

**1. 一次只允許一條擷取管線**
`background.handleStart()` 會先停掉上一個工作階段，`offscreen.start()` 另有 `live.starting` 互斥鎖。重複按開始會建出第二條擷取管線，音訊變兩倍速，模型永遠追不上，從外面完全看不出原因。

**2. 完全不做限速、不丟音訊**
早期版本會把送稿速率鎖在 1x、塞車就丟 —— 結果是整段空白，而且被丟掉的救不回來。現在原則是音訊不丟，來不及就靠「待譯」暫停影片。唯一的例外是連線前的 12 秒暫存佇列。

**3. 字幕用 rAF 合併重繪**
模型每秒吐十多個文字片段，直接寫 DOM 會反覆重排、掉畫格。

**4. 落後 ≠ 網路問題**
`落後` 是「送出音訊秒數 − 收到譯音秒數」，`待譯` 是「送進去但還沒翻出來」。兩個都是相對值；體感延遲要看 `延遲`。

**5. offscreen 只申請 `USER_MEDIA`**
`AUDIO_PLAYBACK` 的 offscreen 文件有「連續 30 秒沒播放音訊就自動關閉」的規則。字幕模式從不播聲音，申請了就會在 30 秒後被回收，整條管線消失。

**6. content script 版本握手**
擴充功能重新載入後，舊分頁的 content script 訊息管道已死。`background.ensureContent()` 用 PING 取得版本，不符就重新注入；舊實例透過 `window.__ytltDestroy` 退場。

**7. 對話模型的思考旁白要過濾**
`native-audio` / `3.8-live` 會把推理寫進逐字稿：
`The user says "expertise"... I will translate... Traditional Chinese (Taiwan).專業知識`
處理方式：system prompt 明令禁止 + 前端 `stripMeta()`（9 條句首樣式）過濾。**只套用在非 translate 模型**，因為正常譯文也可能出現「使用者說…」這種句子。

---

## 模型備註（2026-11）

- Live API 模型全部只輸出 **AUDIO**；要文字只能靠 `outputAudioTranscription`
- `gemini-3.5-live-translate-preview`：continuous stream processing，用 `generationConfig.translationConfig.targetLanguageCode`（BCP-47）指定目標語言，**不支援 `speechConfig`／tools／文字輸入**，音色會複製講者
- `gemini-3.5-transcribe-live`：只轉文字，不翻譯
- `gemini-3.8-live` / `3.8-live-extended-thinking` / `3.1-flash-live-preview`：對話模型，要等句子講完才回，較慢
- `gemini-2.5-flash-native-audio-*`：舊世代，免費額度 RPD 很低
- 舊的 `gemini-live-2.5-flash-preview`、`gemini-2.0-flash-live-001` 已下線

---

## 離線驗證

```bash
node test-selftest.cjs    # 降採樣、base64、setup 結構、duckFactor/dubLevel、語言代碼
node test-flow.cjs        # 假 WebSocket / AudioContext 走完整流程（含翻譯模型與補送佇列）
node test-segment.cjs     # 真實影片音訊的切句品質
python -m py_compile local-asr/asr-server.py native-host/host.py
```

### 切句實測

素材：`testmedia/audio48.pcm`（762 秒英文講道，`yt-dlp` + `ffmpeg` 產生）

| 指標 | 數值 |
| --- | --- |
| 降採樣塊數 | 7622 塊 / 762.2 秒（零漂移） |
| 切出句數 | 153 句（接續後 147 句） |
| 句長中位數 | 4.1 秒（接續後 4.2 秒） |
| 過短句（< 1.5 秒） | 1 句 |
| 送出的音訊 | 約 79%（只送有人聲的片段） |

### Whisper 實測

RTX 3060 12 GB、`large-v3-turbo`、fp16：

| 音訊長度 | 推論時間 | RTF |
| --- | --- | --- |
| 10 秒 | 0.5–0.6 秒 | 0.06 |
| 3 秒 | 0.26–0.27 秒 | 0.09 |

也就是 11–16 倍即時，永遠不會累積。

---

## 檔案結構

```
manifest.json        MV3 設定：權限、offscreen、content script、options 頁
background.js        service worker：stream id、offscreen 生命週期、訊息路由、原生主機橋接
offscreen.html/js    音訊擷取 + 播放 + Gemini Live WebSocket + 本機模式 + 重連/降級
vad.js               SpeechSegmenter（純邏輯，可單獨測試）
audio-worklet.js     48 kHz → 16 kHz PCM（音訊執行緒）
content.js           字幕框（Shadow DOM、雙色、拖曳、診斷列）
popup.html/css/js    主設定介面
options.html/css/js  本機服務設定頁
local-asr/           Whisper HTTP 服務（asr-server.py、start.cmd、config.json）
native-host/         原生主機（host.py、launcher.cs、install.ps1、install.cmd）
tools/check-ids.cjs  靜態檢查：popup.js 用到的 id 是否都存在於 popup.html
tools/make-icons.cjs 產生 icons/icon{16,32,48,128}.png（紅底白十字，純 Node、零依賴）
icons/               擴充功能圖示（由 make-icons.cjs 產生，改色後重跑即可）
test-*.cjs           離線測試
testmedia/           yt-dlp / ffmpeg 產生的測試素材（可刪）
docs/DESIGN.md       本文件
```

---

## 可以再往上做什麼

- 在最低能量點切句（而不是固定 12 秒硬切），減少切在半個詞中間
- 專有名詞表（人名、產品名）注入 system instruction
- 字幕歷史 + 匯出 SRT
- 只在主持人講話時收音（人聲分離）
- 本機模式接 TTS（例如 Piper）補上配音
