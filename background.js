// background.js — MV3 service worker
// 職責：取得分頁音訊 stream id、管理 offscreen document、把字幕事件轉發給 content script。

'use strict';

const OFFSCREEN_URL = 'offscreen.html';

let state = {
  running: false,
  tabId: null,
  status: 'idle', // idle | starting | connecting | connected | reconnecting | error
  detail: '',
  ts: 0,
};

let stateLoaded = null;

async function loadState() {
  try {
    const res = await chrome.storage.session.get('bgState');
    if (res && res.bgState) state = { ...state, ...res.bgState };
  } catch (_) {
    /* storage.session 在某些情況下不可用時忽略 */
  }
  return state;
}

function getState() {
  if (!stateLoaded) stateLoaded = loadState();
  return stateLoaded.then(() => state);
}

function setState(patch) {
  state = { ...state, ...patch, ts: Date.now() };
  chrome.storage.session.set({ bgState: state }).catch(() => {});
  chrome.runtime.sendMessage({ target: 'popup', type: 'STATE', state }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* offscreen document                                                  */
/* ------------------------------------------------------------------ */

let creatingOffscreen = null;

async function hasOffscreen() {
  try {
    if (!chrome.runtime.getContexts) return false;
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return contexts.length > 0;
  } catch (_) {
    return false;
  }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        // 只用 USER_MEDIA。不能加 AUDIO_PLAYBACK：那個 reason 會讓 Chrome 在
        // 「連續 30 秒沒有播放音訊」時自動關掉整份 offscreen 文件，
        // 使用者只要把 YouTube 暫停超過 30 秒，擷取、WebSocket、process 全部消失，
        // 恢復播放也救不回來。播放音訊本身不需要這個 reason。
        reasons: ['USER_MEDIA'],
        justification: '擷取分頁音訊送到 Gemini Live，並播放翻譯後的語音。',
      })
      .catch((err) => {
        if (!/single offscreen/i.test(String(err))) throw err;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function closeOffscreen() {
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  } catch (_) {
    /* 已經關閉 */
  }
}

function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

/* ------------------------------------------------------------------ */
/* content script                                                      */
/* ------------------------------------------------------------------ */

async function ensureContent(tabId) {
  // 版本握手：擴充功能重新載入後，舊頁面的 content script 可能還「活著」
  // 但訊息管道已失效（畫面留著字幕框卻永遠沒有新字幕）。
  // 只要回報的版本對不上，就重新注入一份（content.js 會先清掉舊字幕框）。
  let needInject = false;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'YTLT_PING' });
    const want = chrome.runtime.getManifest().version;
    needInject = !res || !res.ok || res.v !== want;
  } catch (_) {
    needInject = true;
  }
  if (needInject) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }
}

async function relayToContent(event) {
  const s = await getState();
  if (!s.tabId) return;
  await chrome.tabs
    .sendMessage(s.tabId, { type: 'YTLT', event })
    .catch(() => {
      /* 分頁已關或已離開 */
    });
}

/* ------------------------------------------------------------------ */
/* start / stop                                                        */
/* ------------------------------------------------------------------ */

async function handleStart(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('找不到目前分頁');
  if (!/^https:\/\/(www\.)?youtube\.com\//.test(tab.url || '')) {
    throw new Error('請先切換到 YouTube 頁面再按開始');
  }

  const { config } = await chrome.storage.local.get('config');
  const cfg = config || {};
  if (!cfg.apiKey) throw new Error('請先填入 Gemini API Key');
  if (cfg.engine !== 'local' && !cfg.model) throw new Error('請先選擇模型');

  // 本機模式：服務沒開就透過原生主機自動啟動，使用者不必再去點 .cmd
  if (cfg.engine === 'local') {
    const st = await hostCall('status', {}, 6000);
    if (!st || !st.running) {
      setState({ status: 'starting', detail: '正在啟動本機辨識服務…' });
      const started = await hostCall('start', {}, 60000);
      if (!started || !started.ok) {
        setState({ status: 'error', detail: '本機辨識服務沒有啟動' });
        throw new Error(
          '本機辨識服務沒有啟動。請執行一次 native-host\\install.cmd（安裝原生主機，之後就會自動啟動），' +
            '或先手動執行 local-asr\\start.cmd。' +
            (started && started.error ? '（' + started.error + '）' : '')
        );
      }
    }
  }

  // 已經在別的分頁（或同分頁）跑的話先收掉，否則會有兩條擷取管線 → 音訊變兩倍速
  const prev = await getState();
  if (prev.running || (prev.status && prev.status !== 'idle')) await handleStop('切換分頁');

  setState({ running: false, tabId, status: 'starting', detail: '正在取得分頁音訊…' });

  await ensureOffscreen();

  // 必須在使用者手勢（點擴充功能圖示）之後呼叫，否則 Chrome 會拒絕。
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    setState({ status: 'error', detail: '無法擷取分頁音訊：' + err.message });
    await closeOffscreen();
    throw new Error('無法擷取分頁音訊。請關閉這個視窗，直接點工具列上的擴充功能圖示再按「開始」。');
  }

  setState({ running: true, status: 'connecting', detail: '正在連線 Gemini Live…' });

  const res = await sendToOffscreen({ type: 'START', streamId, config: cfg });
  if (res && res.error) {
    setState({ status: 'error', detail: res.error });
    throw new Error(res.error);
  }

  await ensureContent(tabId);
  await chrome.tabs
    .sendMessage(tabId, { type: 'YTLT', event: { kind: 'config', config: cfg } })
    .catch(() => {});

  return { ok: true };
}

async function handleStop(detail) {
  const s = await getState();
  if (s.tabId) {
    await chrome.tabs.sendMessage(s.tabId, { type: 'YTLT', event: { kind: 'stopped' } }).catch(() => {});
  }
  await sendToOffscreen({ type: 'STOP' }).catch(() => {});
  await closeOffscreen();
  setState({ running: false, status: 'idle', detail: detail || '' });
  return { ok: true };
}

async function currentStatus() {
  const s = await getState();
  const alive = await hasOffscreen();
  if (!alive) {
    const wasActive = s.status && s.status !== 'idle' && s.status !== 'error';
    if (wasActive) {
      return {
        ...s,
        running: false,
        status: 'error',
        detail: '背景程序被瀏覽器關閉（通常是分頁長時間暫停或切到背景），請重新按開始。',
      };
    }
    return { ...s, running: false, status: s.status === 'error' ? 'error' : 'idle' };
  }
  const live = await sendToOffscreen({ type: 'STATUS_REQ' }).catch(() => null);
  if (!live) return { ...s, running: false, status: 'idle' };
  const active = live.status !== 'idle' && live.status !== 'error';
  return { ...s, running: active, status: live.status, detail: live.detail || s.detail };
}

/* ------------------------------------------------------------------ */
/* message router                                                      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 原生主機（com.ytlt.asr）：啟動/停止本機 Whisper 服務                  */
/* ------------------------------------------------------------------ */

let hostPort = null;
const hostWaiting = new Map();
let hostSeq = 0;

function ensureHost() {
  if (hostPort) return hostPort;
  if (typeof chrome.runtime.connectNative !== 'function') {
    // 只有「擴充功能重新載入後」權限才會生效；舊的 service worker 會停在沒有
    // nativeMessaging 的版本，訊息就很像 API 不見了。
    throw new Error('擴充功能還是舊版（原生主機權限未生效）。請到 chrome://extensions 按「重新載入」再試。');
  }
  hostPort = chrome.runtime.connectNative('com.ytlt.asr');
  hostPort.onMessage.addListener((res) => {
    const id = res && res.id;
    const w = hostWaiting.get(id);
    if (!w) return;
    hostWaiting.delete(id);
    clearTimeout(w.timer);
    w.resolve(res);
  });
  hostPort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    const reason = (err && err.message) || '原生主機已結束';
    for (const [, w] of hostWaiting) {
      clearTimeout(w.timer);
      w.resolve({ ok: false, error: reason, disconnect: true });
    }
    hostWaiting.clear();
    hostPort = null;
  });
  return hostPort;
}

function hostCall(cmd, payload, timeoutMs) {
  return new Promise((resolve) => {
    let port;
    try {
      port = ensureHost();
    } catch (err) {
      resolve({ ok: false, error: (err && err.message) || '無法連上原生主機' });
      return;
    }
    const id = ++hostSeq;
    const timer = setTimeout(() => {
      hostWaiting.delete(id);
      resolve({ ok: false, error: '原生主機逾時（' + cmd + '）' });
    }, timeoutMs || 20000);
    hostWaiting.set(id, { resolve, timer });
    try {
      port.postMessage(Object.assign({ cmd, id }, payload || {}));
    } catch (err) {
      clearTimeout(timer);
      hostWaiting.delete(id);
      resolve({ ok: false, error: (err && err.message) || '原生主機傳送失敗' });
    }
  });
}

async function route(msg) {
  switch (msg.type) {
    case 'START':
      return handleStart(msg.tabId);
    case 'HOST':
      return hostCall(msg.cmd, msg.payload, msg.timeout);
    case 'STOP':
      return handleStop(msg.detail);
    case 'GET_STATE':
      return currentStatus();
    case 'WAKE':
      // popup 的點擊可以讓被自動播放策略暫停的 AudioContext 恢復。
      return sendToOffscreen({ type: 'WAKE' }).catch(() => ({}));
    case 'GAIN':
      // 滑桿即時生效：不用停止再開始
      return sendToOffscreen({ type: 'GAIN', config: msg.config || {} }).catch(() => ({}));
    case 'CONFIG': {
      // 播放中改設定（例如暫停秒數）也要馬上看得到效果
      const st = await getState();
      if (st.tabId && (st.running || st.status !== 'idle')) {
        chrome.tabs
          .sendMessage(st.tabId, { type: 'YTLT', event: { kind: 'config', config: msg.config || {} } })
          .catch(() => {});
      }
      return { ok: true };
    }
    case 'EVENT':
      await relayToContent(msg.event);
      return { ok: true };
    case 'STATUS':
      setState({ status: msg.status, detail: msg.detail || '' });
      return { ok: true };
    default:
      return { ok: false, error: 'unknown message: ' + msg.type };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.target && msg.target !== 'background')) return false;
  if (msg.type === 'YT_GONE') {
    // 只有被擷取的那個分頁才有權停止；避免別的 YouTube 分頁誤觸
    getState()
      .then((s) => {
        const tabId = sender && sender.tab ? sender.tab.id : null;
        if (s.tabId && tabId === s.tabId && (s.running || s.status !== 'idle')) {
          handleStop('分頁已離開影片頁').catch(() => {});
        }
      })
      .catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  (async () => {
    try {
      sendResponse(await route(msg));
    } catch (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  })();
  return true;
});

/* 分頁關掉就一起收工 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getState();
  if (s.tabId === tabId && (s.running || s.status !== 'idle')) {
    handleStop('分頁已關閉').catch(() => {});
  }
});
