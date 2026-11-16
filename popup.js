// popup.js
'use strict';

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  apiKey: '',
  engine: 'live',
  asrUrl: 'http://127.0.0.1:8791',
  asrLang: 'en',
  asrModel: '',
  textModel: 'gemini-2.5-flash-lite',
  model: 'gemini-3.5-live-translate-preview',
  targetLanguage: '繁體中文（台灣）',
  targetLangCode: 'zh-Hant',
  speechLanguageCode: '',
  mode: 'dub',
  voice: 'Kore',
  originalVolume: 0.25,
  outputVolume: 1,
  duckLevel: 0.12,
  autoPause: true,
  pauseAfterSec: 45,
  resumeSec: 10,
  vad: 'client',
  vadSensitivity: 5,
  showSource: true,
  subtitleSize: 26,
  showSeg: true,
};

// 舊版預設模型（native-audio 對話模型）拿來做翻譯效果很差，載入時自動升級一次
const LEGACY_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';

// 模型下拉選單的內建清單；按 ↻ 查到的可用模型會合併進來並記住
const MODEL_PRESETS = [
  'gemini-3.5-live-translate-preview',
  'gemini-3.8-live',
  'gemini-3.8-live-extended-thinking',
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-3.5-transcribe-live',
];

// 本機 Whisper 模式拿來翻譯的文字模型（generateContent）
const TEXT_PRESETS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-flash-latest',
];

// 「翻譯成」→ BCP-47，讓即時翻譯模型不用使用者手動填代碼
const LANG_CODES = {
  '繁體中文（台灣）': 'zh-Hant',
  '繁體中文': 'zh-Hant',
  '简体中文': 'zh-Hans',
  '中文（简体）': 'zh-Hans',
  日本語: 'ja',
  한국어: 'ko',
  Español: 'es',
  Français: 'fr',
  Deutsch: 'de',
  Italiano: 'it',
  'Português': 'pt-BR',
  Русский: 'ru',
  العربية: 'ar',
  हिन्दी: 'hi',
  ภาษาไทย: 'th',
  'Tiếng Việt': 'vi',
  'Bahasa Indonesia': 'id',
  English: 'en',
};

const isTranslateModel = (name) => /live-translate|translate-live/i.test(String(name || ''));

// 2026 年起 Live API 的模型全部只支援 AUDIO 輸出（文字要靠 outputAudioTranscription），
// 所以「僅字幕」不會比較快：模型照樣即時生成語音，只是我們不播放。
const isAudioOnlyLive = (name) =>
  /live|native-audio|transcribe/i.test(String(name || ''));

const LABELS = {
  idle: '未啟動',
  starting: '啟動中',
  connecting: '連線中',
  connected: '翻譯中',
  reconnecting: '重連中',
  error: '錯誤',
};

let config = { ...DEFAULTS };
let saveTimer = null;

/* ------------------------------------------------------------------ */
/* 讀寫設定                                                            */
/* ------------------------------------------------------------------ */

async function loadConfig() {
  const res = await chrome.storage.local
    .get(['config', 'modelChoices', 'textModelChoices'])
    .catch(() => ({}));
  config = { ...DEFAULTS, ...((res && res.config) || {}) };

  let migrated = false;
  if (config.model === LEGACY_MODEL) {
    config.model = DEFAULTS.model;
    migrated = true;
  }
  // 舊設定若把「轉錄／即時語音」模型存成翻譯用文字模型，直接換成一般文字模型
  if (/transcribe|native-audio|-live|live-/i.test(String(config.textModel || ''))) {
    config.textModel = DEFAULTS.textModel;
    migrated = true;
  }

  $('apiKey').value = config.apiKey || '';
  $('engine').value = config.engine === 'local' ? 'local' : 'live';
  $('asrUrl').value = config.asrUrl || DEFAULTS.asrUrl;
  $('asrLang').value = config.asrLang || DEFAULTS.asrLang;
  config.asrModel = config.asrModel || '';
  fillModelOptions((res && res.modelChoices) || []);
  fillTextModels((res && res.textModelChoices) || []);
  $('model').value = config.model || '';
  $('textModel').value = config.textModel || DEFAULTS.textModel;
  syncTextModelHint();
  $('targetLanguage').value = config.targetLanguage || '繁體中文（台灣）';
  $('speechLanguageCode').value = config.speechLanguageCode || '';
  $('mode').value = config.mode === 'text' ? 'text' : 'dub';
  $('voice').value = config.voice || 'Kore';
  $('originalVolume').value = String(Math.round((config.originalVolume ?? 0.25) * 100));
  $('outputVolume').value = String(Math.round((config.outputVolume ?? 1) * 100));
  $('duckLevel').value = String(config.duckLevel ?? 0.12);
  $('autoPause').checked = config.autoPause !== false;
  $('showSeg').checked = config.showSeg !== false;
  $('pauseAfterSec').value = String(config.pauseAfterSec ?? 45);
  $('resumeSec').value = String(config.resumeSec ?? 10);
  $('vad').value = config.vad === 'auto' ? 'auto' : 'client';
  $('vadSensitivity').value = String(config.vadSensitivity ?? 5);
  syncVolumeLabel();
  syncDubVolLabel();
  syncSensLabel();
  syncLangCode();
  syncModelUi();
  syncEngineUi();
  syncDuckHint();
  syncPauseHint();
  if (config.engine === 'local') fetchAsrModels(false);

  if (migrated) {
    persist();
    setStatus(
      '已把不相容的模型設定換成建議值（即時翻譯 gemini-3.5-live-translate-preview、文字 gemini-2.5-flash-lite）。要改回可在對應欄位重選。'
    );
  }
  return { migrated };
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ config }).catch(() => {});
  }, 250);
}

function bindField(id, key, transform) {
  const el = $(id);
  const handler = () => {
    const raw = el.type === 'range' ? Number(el.value) : el.value;
    config[key] = transform ? transform(raw) : raw;
    persist();
  };
  el.addEventListener('input', handler);
  el.addEventListener('change', handler);
}

// 用 <select> 而不是 datalist：datalist 會依輸入框內容過濾，填好模型名稱後只看得到那一項
function fillModelOptions(extra) {
  const seen = new Set();
  const list = [];
  const push = (v) => {
    const name = String(v || '')
      .trim()
      .replace(/^models\//, '');
    if (!name || seen.has(name)) return;
    seen.add(name);
    list.push(name);
  };
  push(config.model); // 目前設定值一定要在選單裡，否則會被清掉
  (extra || []).forEach(push);
  MODEL_PRESETS.forEach(push);
  list.sort((a, b) => (isTranslateModel(a) ? 0 : 1) - (isTranslateModel(b) ? 0 : 1));

  const sel = $('model');
  sel.innerHTML = '';
  for (const name of list) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  if (config.model) sel.value = config.model;
  return list;
}

// 本機模式用的文字模型下拉（純 generateContent 模型）
function fillTextModels(extra) {
  const seen = new Set();
  const list = [];
  const push = (v) => {
    const name = String(v || '')
      .trim()
      .replace(/^models\//, '');
    if (!name || seen.has(name)) return;
    seen.add(name);
    list.push(name);
  };
  push(config.textModel);
  (extra || []).forEach(push);
  TEXT_PRESETS.forEach(push);

  const sel = $('textModel');
  if (!sel) return list;
  sel.innerHTML = '';
  for (const name of list) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  if (config.textModel) sel.value = config.textModel;
  return list;
}

// 切換引擎：本機模式隱藏 Live 模型欄，並說明差異
function syncEngineUi() {
  const local = $('engine').value === 'local';
  const lb = $('liveBox');
  const nb = $('localBox');
  if (lb) lb.style.display = local ? 'none' : '';
  if (nb) nb.style.display = local ? '' : 'none';
  const hint = $('engineHint');
  if (hint) {
    hint.textContent = local
      ? '音訊送到你電腦上的 Whisper 辨識（16 倍即時），再請 Gemini 純文字模型翻譯。只有字幕、沒有配音，延遲固定約 2 秒。'
      : 'Gemini 直接聽音訊、邊翻邊產生中文語音（可配音）。快語速時輸出會越積越多，這是模型本身的限制。';
  }
  if (local) checkAsr();
}

function asrBase() {
  return String(($('asrUrl') && $('asrUrl').value) || DEFAULTS.asrUrl).replace(/\/+$/, '');
}

let asrChecking = 0;

// 開 popup 就自動檢查本機服務在不在，不用自己開視窗猜
async function checkAsr() {
  const dot = $('asrDot');
  const txt = $('asrStatus');
  if (!dot || !txt) return;
  const id = ++asrChecking;
  const base = String(($('asrUrl') && $('asrUrl').value) || DEFAULTS.asrUrl).replace(/\/+$/, '');
  dot.className = 'asrdot wait';
  txt.textContent = '檢查中…';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  try {
    const res = await fetch(base + '/health', { signal: ctl.signal, cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || !data || !data.ok) throw new Error('bad');
    if (id !== asrChecking) return;
    const dev = data.device === 'cuda' ? 'GPU' : String(data.device || 'CPU');
    dot.className = 'asrdot ok';
    txt.textContent = '服務正常（' + dev + (data.loading ? '，模型載入中' : '') + '）';
  } catch (_) {
    if (id !== asrChecking) return;
    dot.className = 'asrdot bad';
    txt.textContent = '服務沒跑。按 ▶ 啟動（需先執行過 native-host\\install.cmd）';
  } finally {
    clearTimeout(timer);
  }
}

// 用原生主機一鍵啟動本機辨識服務，不必開任何 cmd 視窗
async function startAsr() {
  const dot = $('asrDot');
  const txt = $('asrStatus');
  if (dot) dot.className = 'asrdot wait';
  if (txt) txt.textContent = '啟動中…（首次載入模型約 2–10 秒）';
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'HOST',
      cmd: 'start',
      payload: {},
      timeout: 60000,
    });
  } catch (err) {
    res = { ok: false, error: (err && err.message) || String(err) };
  }
  if (!res || !res.ok) {
    if (dot) dot.className = 'asrdot bad';
    const msg = (res && res.error) || '';
    if (txt) {
      txt.textContent = /connectNative|nativeMessaging|not a function/i.test(msg)
        ? '擴充功能還是舊版（原生主機權限未生效）。請按右上角 ⚙ 開設定頁，按「重新載入擴充功能」。'
        : '啟動失敗：' + (msg || '請先執行 native-host\\install.cmd（只需一次）');
    }
    return;
  }
  await new Promise((r) => setTimeout(r, 1500));
  checkAsr();
}

// 列出服務資料夾裡的 Whisper 模型；換模型不用重開服務（伺服器會自己重新載入）
async function fetchAsrModels(showStatus) {
  const sel = $('asrModel');
  if (!sel) return;
  const base = asrBase();
  try {
    const res = await fetch(base + '/models', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || !data || !data.ok) throw new Error('bad');
    const list = Array.isArray(data.models) ? data.models : [];
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = data.current
      ? '伺服器預設（' + String(data.current).split(/[\\/]/).pop() + '）'
      : '伺服器預設';
    sel.appendChild(auto);
    for (const m of list) {
      const o = document.createElement('option');
      o.value = m.path;
      o.textContent = m.name + (m.mb ? '（' + m.mb + ' MB）' : '');
      sel.appendChild(o);
    }
    const cur = config.asrModel || '';
    if (cur) {
      if (!list.some((m) => m.path === cur)) {
        const o = document.createElement('option');
        o.value = cur;
        o.textContent = String(cur).split(/[\\/]/).pop() + '（目前設定）';
        sel.appendChild(o);
      }
      sel.value = cur;
    }
    const hint = $('asrModelHint');
    if (hint) hint.textContent = '資料夾：' + data.root + '。換模型會立刻重新載入（約 2–6 秒）。';
    if (cur && data.current && data.current !== cur) applyAsrModel(cur, true);
  } catch (_) {
    if (showStatus) {
      const hint = $('asrModelHint');
      if (hint) hint.textContent = '先讓本機服務跑起來（或到設定頁按啟動）才列得出模型。';
    }
  }
}

async function applyAsrModel(path, quiet) {
  const hint = $('asrModelHint');
  if (!path) return;
  if (!quiet && hint) hint.textContent = '切換模型並載入中…';
  try {
    const res = await fetch(asrBase() + '/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
    if (hint) {
      hint.textContent =
        '已切換：' + String(data.model).split(/[\\/]/).pop() + '（' + data.ms + ' ms）';
    }
    checkAsr();
  } catch (err) {
    if (hint) hint.textContent = '切換失敗：' + (err && err.message ? err.message : err);
  }
}

// 「翻譯用文字模型」選錯（轉錄模型、即時語音模型）要當場提醒，不然只會看到一堆錯誤
function syncTextModelHint() {
  const el = $('textModelHint');
  if (!el) return;
  const m = String(($('textModel') && $('textModel').value) || '');
  const bad = /transcribe|native-audio|-live|live-/i.test(m) || /embedding|imagen|veo|tts/i.test(m);
  el.textContent = bad
    ? '⚠ ' + m + ' 不是一般文字模型（轉錄／即時語音模型不能拿來翻譯，會失敗或回空）。請改選 gemini-2.5-flash-lite 這類。'
    : '純文字翻譯，每句約 0.5–1.5 秒。字幕由 Whisper 的英文字幕翻過來，延遲固定、不會越積越多。';
  el.style.color = bad ? '#f5c542' : '';
}

function syncVolumeLabel() {
  const v = Number($('originalVolume').value);
  $('volText').textContent = v + '%';
}

function syncDubVolLabel() {
  const v = Number($('outputVolume').value);
  $('dubVolText').textContent = v + '%';
}

// 音量滑桿邊拖邊生效（background 轉給 offscreen 調 GainNode）
function pushGains() {
  chrome.runtime
    .sendMessage({
      target: 'background',
      type: 'GAIN',
      config: {
        originalVolume: config.originalVolume,
        outputVolume: config.outputVolume,
        duckLevel: config.duckLevel,
      },
    })
    .catch(() => {});
}

function syncDuckHint() {
  const lv = Number(config.duckLevel);
  const el = $('duckHint');
  if (!el) return;
  el.textContent =
    !lv || lv >= 1
      ? '不壓低：譯音和原音用各自的音量同時播放。'
      : '譯音說話時，原音會變成基準音量的 ' + Math.round(lv * 100) + '%。';
}

function syncPauseHint() {
  const el = $('pauseHint');
  if (!el) return;
  const a = Number($('pauseAfterSec').value);
  const b = Number($('resumeSec').value);
  el.textContent = autoPauseOff()
    ? '目前關閉自動暫停（上面的勾選項）。'
    : '待譯累積超過 ' + a + ' 秒就暫停影片，翻到剩 ' + b + ' 秒時自動恢復播放。';
}

function autoPauseOff() {
  const el = $('autoPause');
  return el ? !el.checked : false;
}

// 播放中改設定（暫停秒數等）→ 背景轉給 content script 立即套用
function pushConfig() {
  chrome.runtime
    .sendMessage({ target: 'background', type: 'CONFIG', config })
    .catch(() => {});
}

function syncSensLabel() {
  $('sensText').textContent = $('vadSensitivity').value;
}

function syncVoiceEnabled() {
  const text = $('mode').value === 'text';
  const translate = isTranslateModel($('model').value);
  const hint = $('voiceHint');
  if (!hint) return;
  hint.textContent = translate
    ? '這個模型不支援指定嗓音（用翻譯模型自己的聲音），這個選單不會影響結果。'
    : text
      ? '「僅字幕」不產生語音，嗓音不會用到。'
      : '';
}

// 即時翻譯模型不吃切句設定（它是連續串流），也不吃嗓音；選單不鎖住，只加說明
function syncModelUi() {
  const translate = isTranslateModel($('model').value);
  const hint = $('vadHint');
  if (hint) {
    hint.textContent = translate
      ? '即時翻譯模型是連續串流（邊講邊翻），不需要切句，這個設定會被忽略。'
      : '偵測到停頓約 0.6 秒才把這一句送給模型，模型拿到完整句子，譯文與配音才不會零散。';
  }
  const modeHint = $('modeHint');
  if (modeHint) {
    const textMode = $('mode').value === 'text';
    if (isAudioOnlyLive($('model').value)) {
      modeHint.textContent = textMode
        ? '這個模型只支援語音輸出，字幕是那段語音的逐字稿。選「僅字幕」只是不播放，速度跟配音完全一樣。'
        : '會產生中文配音；tabCapture 後原音會變無聲，程式已自動把原音接回去。';
    } else {
      modeHint.textContent = '「僅字幕」只要求文字輸出，最省 token。';
    }
  }
  syncVoiceEnabled();
}

// 「翻譯成」→ BCP-47 由下面的對照表自動帶出，UI 只顯示代碼供確認
function syncLangCode() {
  const lang = $('targetLanguage').value.trim();
  const code = LANG_CODES[lang] || (/^[a-z]{2}-[A-Za-z]{2,4}$/.test(lang) ? lang : 'zh-Hant');
  config.targetLanguage = lang;
  config.targetLangCode = code;
  const hint = $('langCodeHint');
  if (hint) hint.textContent = '語言代碼：' + code;
  persist();
}

/* ------------------------------------------------------------------ */
/* 狀態顯示                                                            */
/* ------------------------------------------------------------------ */

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function renderState(s) {
  if (!s) return;
  const status = s.status || 'idle';
  const badge = $('badge');
  badge.textContent = LABELS[status] || status;
  badge.className = 'badge ' + status;

  const running = !!s.running && status !== 'error' && status !== 'idle';
  $('start').hidden = running;
  $('stop').hidden = !running;
  $('start').disabled = false;

  if (status === 'error') {
    setStatus(s.detail || '發生錯誤', 'error');
  } else if (running) {
    setStatus(s.detail || '翻譯中：字幕會顯示在播放器上方，拖曳可移動位置。');
  } else if (s.detail) {
    setStatus(s.detail);
  }
}

async function refresh() {
  try {
    const s = await chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' });
    renderState(s);
  } catch (_) {
    /* service worker 正在喚醒，下一輪再試 */
  }
}

/* ------------------------------------------------------------------ */
/* 動作                                                                */
/* ------------------------------------------------------------------ */

async function onStart() {
  $('start').disabled = true;
  setStatus('正在啟動…');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (!tab || !tab.id) {
    setStatus('找不到目前分頁', 'error');
    $('start').disabled = false;
    return;
  }

  // 點擊本身是使用者手勢，順便讓可能被暫停的 AudioContext 恢復。
  chrome.runtime.sendMessage({ target: 'background', type: 'WAKE' }).catch(() => {});

  const res = await chrome.runtime
    .sendMessage({ target: 'background', type: 'START', tabId: tab.id })
    .catch((e) => ({ error: String(e && e.message ? e.message : e) }));

  if (res && res.error) {
    setStatus(res.error, 'error');
    $('start').disabled = false;
    return;
  }
  refresh();
}

async function onStop() {
  setStatus('正在停止…');
  await chrome.runtime.sendMessage({ target: 'background', type: 'STOP' }).catch(() => {});
  refresh();
}

async function fetchModels(btnId) {
  const key = (config.apiKey || '').trim();
  if (!key) {
    setStatus('請先填入 Gemini API Key', 'error');
    $('apiKey').focus();
    return;
  }

  const btn = $(btnId || 'fetchModels');
  btn.disabled = true;
  const textBtn = btnId === 'fetchTextModels' ? null : $('fetchTextModels');
  if (textBtn) textBtn.disabled = true;
  setStatus('查詢可用模型…');

  try {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=' +
      encodeURIComponent(key);
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data && data.error && data.error.message) || 'HTTP ' + r.status);

    const all = data.models || [];
    const live = all.filter((m) =>
      (m.supportedGenerationMethods || []).includes('bidiGenerateContent')
    );
    // 專用即時翻譯模型排最前面
    live.sort(
      (a, b) => (isTranslateModel(a.name) ? 0 : 1) - (isTranslateModel(b.name) ? 0 : 1)
    );
    // 文字模型：只要 generateContent，排除 live / 影像 / 嵌入之類
    const text = all.filter((m) => {
      const methods = m.supportedGenerationMethods || [];
      const name = String(m.name || '');
      return (
        methods.includes('generateContent') &&
        !methods.includes('bidiGenerateContent') &&
        !/embedding|imagen|veo|tts|audio|live/i.test(name)
      );
    });

    const liveNames = live.map((m) => String(m.name || '').replace(/^models\//, ''));
    const textNames = text.map((m) => String(m.name || '').replace(/^models\//, ''));

    if (liveNames.length) fillModelOptions(liveNames);
    if (textNames.length) fillTextModels(textNames);
    chrome.storage.local
      .set({ modelChoices: liveNames, textModelChoices: textNames })
      .catch(() => {});

    if (!liveNames.length && !textNames.length) {
      setStatus('這把金鑰沒有可用的模型', 'error');
      return;
    }

    setStatus(
      '找到 ' +
        liveNames.length +
        ' 個即時語音模型、' +
        textNames.length +
        ' 個文字模型，已更新下拉選單。'
    );
  } catch (err) {
    setStatus('查詢失敗：' + (err && err.message ? err.message : err), 'error');
  } finally {
    btn.disabled = false;
    if (textBtn) textBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

(async function init() {
  await loadConfig();

  bindField('apiKey', 'apiKey');
  bindField('engine', 'engine', (v) => {
    syncEngineUi();
    return v === 'local' ? 'local' : 'live';
  });
  bindField('asrUrl', 'asrUrl', (v) => String(v || '').trim() || DEFAULTS.asrUrl);
  bindField('asrLang', 'asrLang');
  bindField('textModel', 'textModel', (v) => {
    syncTextModelHint();
    return v;
  });
  bindField('model', 'model', (v) => {
    syncModelUi();
    return v;
  });
  bindField('targetLanguage', 'targetLanguage', (v) => {
    syncLangCode();
    return v;
  });
  bindField('speechLanguageCode', 'speechLanguageCode');
  bindField('mode', 'mode', () => {
    syncVoiceEnabled();
    syncModelUi();
    return $('mode').value;
  });
  bindField('voice', 'voice');
  bindField('originalVolume', 'originalVolume', (v) => {
    syncVolumeLabel();
    config.originalVolume = Number(v) / 100;
    pushGains();
    return config.originalVolume;
  });
  bindField('outputVolume', 'outputVolume', (v) => {
    syncDubVolLabel();
    config.outputVolume = Number(v) / 100;
    pushGains();
    return config.outputVolume;
  });
  bindField('autoPause', 'autoPause', () => {
    config.autoPause = $('autoPause').checked;
    syncPauseHint();
    pushConfig();
    return config.autoPause;
  });
  bindField('showSeg', 'showSeg', () => {
    config.showSeg = $('showSeg').checked;
    pushConfig();
    return config.showSeg;
  });
  bindField('pauseAfterSec', 'pauseAfterSec', (v) => {
    config.pauseAfterSec = Number(v);
    syncPauseHint();
    pushConfig();
    return config.pauseAfterSec;
  });
  bindField('resumeSec', 'resumeSec', (v) => {
    config.resumeSec = Number(v);
    syncPauseHint();
    pushConfig();
    return config.resumeSec;
  });
  bindField('duckLevel', 'duckLevel', (v) => {
    config.duckLevel = Number(v);
    pushGains();
    syncDuckHint();
    return config.duckLevel;
  });

  $('toggleKey').addEventListener('click', () => {
    const el = $('apiKey');
    el.type = el.type === 'password' ? 'text' : 'password';
  });

  $('fetchModels').addEventListener('click', () => fetchModels('fetchModels'));
  const ft = $('fetchTextModels');
  if (ft) ft.addEventListener('click', () => fetchModels('fetchTextModels'));

  const opt = $('openOptions');
  // 齒輪是 <a href="options.html">，不需要 JS；下面這段只在舊版按鈕還在時補救
  if (opt && opt.tagName === 'BUTTON') {
    opt.addEventListener('click', () => chrome.runtime.openOptionsPage());
  }

  const ac = $('asrCheck');
  if (ac) ac.addEventListener('click', checkAsr);
  const ast = $('asrStart');
  if (ast) ast.addEventListener('click', startAsr);

  const am = $('asrModel');
  if (am) {
    am.addEventListener('change', () => {
      config.asrModel = am.value || '';
      persist();
      if (config.asrModel) applyAsrModel(config.asrModel);
    });
  }
  const af = $('fetchAsrModels');
  if (af) af.addEventListener('click', () => fetchAsrModels(true));

  $('start').addEventListener('click', onStart);
  $('stop').addEventListener('click', onStop);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.target === 'popup' && msg.type === 'STATE') renderState(msg.state);
    return false;
  });

  await refresh();
  setInterval(refresh, 1200);
})();
