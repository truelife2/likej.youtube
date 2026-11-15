// 用假 WebSocket / 假 AudioContext 走一遍 offscreen 的完整流程，
// 驗證送給 Gemini 的訊息順序：setup → activityStart → audio… → activityEnd
// 用法：node test-flow.cjs
const fs = require('fs');
const vm = require('vm');
const { SpeechSegmenter } = require('./vad.js');

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) fail++;
};

const sockets = [];
const runtimeMessages = [];

class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
  }
}
FakeWS.OPEN = 1;

const nodes = [];

class FakeCtx {
  constructor() {
    this.state = 'running';
    this.sampleRate = 48000;
    this._t = 0;
    this.destination = { name: 'dest' };
    this.audioWorklet = { addModule: async () => {} };
    this.dry = { gain: { value: 0.25, setTargetAtTime() {} }, connect() { return this; } };
  }
  get currentTime() {
    return (this._t += 0.1);
  }
  createMediaStreamSource() {
    return { connect: () => ({ connect: () => ({}) }) };
  }
  createGain() {
    return this.dry;
  }
  createBuffer(_ch, len, rate) {
    return { duration: len / rate, copyToChannel() {} };
  }
  createBufferSource() {
    return { connect() {}, start() {}, stop() {}, onended: null };
  }
  async resume() {}
  async close() {}
}

class FakeWorkletNode {
  constructor() {
    this.port = { onmessage: null, postMessage() {} };
    nodes.push(this);
  }
  connect() {}
  disconnect() {}
}

// 假時鐘：送稿速率限制依 Date.now()，測試要能「每塊音訊前進 100ms」
let fakeNow = 1700000000000;
function tick(ms = 100) {
  fakeNow += ms;
}

const sandbox = {
  console,
  Math,
  Date: { now: () => fakeNow },
  JSON,
  TextDecoder,
  Int16Array,
  Float32Array,
  Uint8Array,
  ArrayBuffer,
  setTimeout,
  clearTimeout,
  encodeURIComponent,
  atob,
  btoa,
  SpeechSegmenter,
  WebSocket: FakeWS,
  AudioContext: FakeCtx,
  AudioWorkletNode: FakeWorkletNode,
  navigator: {
    mediaDevices: {
      getUserMedia: async () => ({
        getAudioTracks: () => [{ addEventListener() {}, stop() {} }],
        getTracks: () => [],
      }),
    },
  },
  chrome: {
    runtime: {
      getURL: (p) => 'chrome-extension://x/' + p,
      sendMessage: async (m) => {
        runtimeMessages.push(m);
        return {};
      },
      onMessage: { addListener: (fn) => (sandbox.__listener = fn) },
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('offscreen.js', 'utf8'), sandbox);

function pcmChunk(amplitude) {
  const i16 = new Int16Array(1600);
  for (let i = 0; i < i16.length; i++) {
    i16[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 300 * i) / 16000));
  }
  return i16.buffer;
}
const silenceChunk = () => new Int16Array(1600).buffer;

(async function main() {
  const res = await sandbox.start('stream-id', {
    apiKey: 'test-key',
    model: 'gemini-live-2.5-flash-preview',
    mode: 'dub',
    voice: 'Kore',
    targetLanguage: '繁體中文（台灣）',
    vad: 'client',
    vadSensitivity: 5,
    originalVolume: 0.25,
  });

  ok(!res.error, 'start() 沒有回錯');
  const ws = sockets[0];
  ok(!!ws, '建立了 WebSocket');
  ok(ws.url.startsWith('wss://generativelanguage.googleapis.com/ws/'), 'WebSocket 網址正確');
  ok(ws.url.includes('key=test-key'), 'API key 有帶上');

  // 模擬連線與 setup
  ws.readyState = 1;
  ws.onopen();
  const setupMsg = ws.sent[0];
  ok(!!setupMsg.setup, '第一個訊息是 setup');
  ok(
    setupMsg.setup.realtimeInputConfig.automaticActivityDetection.disabled === true,
    '要求手動 VAD'
  );
  ok(setupMsg.setup.realtimeInputConfig.activityHandling === 'NO_INTERRUPTION', 'NO_INTERRUPTION 已設定');

  ws.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
  ok(true, 'setupComplete 處理沒有丟錯');

  // 餵音訊：10 塊說話 → 8 塊靜音 → 6 塊說話
  const node = nodes[0];
  const feed = node.port.onmessage;
  for (let i = 0; i < 10; i++) {
    tick();
    feed({ data: pcmChunk(0.3) });
  }
  for (let i = 0; i < 8; i++) {
    tick();
    feed({ data: silenceChunk() });
  }
  for (let i = 0; i < 6; i++) {
    tick();
    feed({ data: pcmChunk(0.3) });
  }

  const kinds = ws.sent.map((m) =>
    m.setup ? 'setup' : m.realtimeInput ? Object.keys(m.realtimeInput)[0] : 'other'
  );

  ok(kinds[0] === 'setup', '順序：setup 在最前');
  ok(kinds[1] === 'activityStart', '偵測到說話後先送 activityStart');
  ok(!kinds.slice(2).includes('setup'), '沒有重送 setup');
  ok(kinds.filter((k) => k === 'audio').length >= 12, '送出足夠的音訊塊：' + kinds.filter((k) => k === 'audio').length);
  ok(kinds.includes('activityEnd'), '靜音足夠後送出 activityEnd');
  ok(kinds[kinds.length - 1] === 'activityStart' || kinds[kinds.length - 1] === 'audio', '第二句重新開始');

  const firstAudio = ws.sent.find((m) => m.realtimeInput && m.realtimeInput.audio);
  ok(firstAudio.realtimeInput.audio.mimeType === 'audio/pcm;rate=16000', '音訊格式為 16kHz PCM');

  // 模型回一件音訊 + 逐字稿
  ws.onmessage({
    data: JSON.stringify({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] },
        outputTranscription: { text: '你好' },
        inputTranscription: { text: 'hello' },
        turnComplete: true,
      },
    }),
  });

  const events = runtimeMessages.filter((m) => m.type === 'EVENT').map((m) => m.event.kind);
  ok(events.includes('output'), '有轉出 output 字幕事件');
  ok(events.includes('input'), '有轉出 input 字幕事件');
  ok(events.includes('turn'), '有轉出 turn 事件');
  ok(events.includes('speech'), '有轉出 speech（VAD）事件');

  await sandbox.stop(false);
  ok(sockets[0].readyState === 3, 'stop() 有關閉連線');

  /* ---------------- 情境二：專用即時翻譯模型 ---------------- */
  runtimeMessages.length = 0;
  const res2 = await sandbox.start('stream-id', {
    apiKey: 'test-key',
    model: 'gemini-3.5-live-translate-preview',
    mode: 'dub',
    targetLanguage: '繁體中文（台灣）',
    targetLangCode: 'zh-Hant',
    vad: 'client',
    vadSensitivity: 5,
    originalVolume: 0.25,
  });
  ok(!res2.error, 'translate: start() 沒有回錯');

  const ws2 = sockets[sockets.length - 1];
  ws2.readyState = 1;
  ws2.onopen();
  const s2 = ws2.sent[0].setup;
  ok(
    s2.generationConfig.translationConfig.targetLanguageCode === 'zh-Hant',
    'translate: translationConfig 指定 zh-Hant'
  );
  ok(!s2.realtimeInputConfig, 'translate: 沒有 realtimeInputConfig（連續串流）');

  ws2.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
  const node2 = nodes[nodes.length - 1];
  // 講話與靜音交錯：翻譯模型不做 VAD，全部都要送出去
  for (let i = 0; i < 12; i++) {
    tick();
    node2.port.onmessage({ data: i % 4 === 3 ? silenceChunk() : pcmChunk(0.3) });
  }
  const kinds2 = ws2.sent
    .slice(1)
    .map((m) => (m.realtimeInput ? Object.keys(m.realtimeInput)[0] : 'other'));
  ok(
    kinds2.length === 12 && kinds2.every((k) => k === 'audio'),
    'translate: 只送 audio（含靜音），不送 activityStart/End → ' + kinds2.length
  );

  await sandbox.stop(false);

  /* ---------------- 情境三：連線完成前的音訊要排隊補送 ---------------- */
  runtimeMessages.length = 0;
  const res3 = await sandbox.start('stream-id', {
    apiKey: 'test-key',
    model: 'gemini-3.5-live-translate-preview',
    mode: 'dub',
    targetLanguage: '繁體中文（台灣）',
    targetLangCode: 'zh-Hant',
    vad: 'client',
    vadSensitivity: 5,
    originalVolume: 0.25,
  });
  ok(!res3.error, 'queue: start() 沒有回錯');

  const ws3 = sockets[sockets.length - 1];
  ws3.readyState = 1;
  ws3.onopen();
  const node3 = nodes[nodes.length - 1];
  // 連線還沒完成就開始播放（真實情況：按下開始後前面幾秒）
  for (let i = 0; i < 5; i++) {
    tick();
    node3.port.onmessage({ data: pcmChunk(0.3) });
  }
  ok(ws3.sent.length === 1, 'queue: 連線完成前只送 setup，不送音訊');

  ws3.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
  tick();
  node3.port.onmessage({ data: pcmChunk(0.3) });
  const audio3 = ws3.sent.slice(1).filter((m) => m.realtimeInput);
  ok(audio3.length === 6, 'queue: 連線完成後補送前面 5 塊 + 新的 1 塊 → ' + audio3.length);

  await sandbox.stop(false);

  console.log(fail ? '\n' + fail + ' 項失敗' : '\n全部流程檢查通過');
  process.exit(fail ? 1 : 0);
})();
