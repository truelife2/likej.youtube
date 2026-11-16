// 驗證「配音整句播放」的排程邏輯（1.12.x）。
// 目的：確認一句話不會被切成好幾段唸出來（使用者回報「唸幾個字就停」的根因）。
// 用法：node tools/test-playback.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { SpeechSegmenter } = require('../vad.js');

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
  if (!cond) fail++;
};

const ROOT = path.join(__dirname, '..');

// 假時鐘：Date.now() 與 AudioContext.currentTime 都由 tick() 推進
const T0 = 1700000000000;
let fakeNow = T0;
const tick = (ms) => {
  fakeNow += ms;
};

const scheduled = []; // { start, dur }
const worklets = [];
let gainSeq = 0;

class FakeCtx {
  constructor() {
    this.state = 'running';
    this.sampleRate = 48000;
    this.destination = {};
    this.audioWorklet = { addModule: async () => {} };
    this._dry = { gain: { value: 0.25, setTargetAtTime() {} }, connect() {} };
    this._dub = { gain: { value: 1, setTargetAtTime() {} }, connect() {} };
  }
  get currentTime() {
    return (fakeNow - T0) / 1000;
  }
  createMediaStreamSource() {
    return { connect: () => ({ connect: () => ({}) }) };
  }
  createGain() {
    gainSeq += 1;
    return gainSeq === 1 ? this._dry : this._dub;
  }
  createBuffer(_ch, len, rate) {
    const ch = new Float32Array(len);
    return {
      duration: len / rate,
      length: len,
      sampleRate: rate,
      copyToChannel(src, _i, off) {
        ch.set(src, off || 0);
      },
    };
  }
  createBufferSource() {
    const node = {
      buffer: null,
      connect() {},
      stop() {},
      onended: null,
      start(at) {
        scheduled.push({ start: at, dur: this.buffer ? this.buffer.duration : 0 });
      },
    };
    return node;
  }
  async resume() {}
  async close() {}
}

class FakeWorkletNode {
  constructor() {
    this.port = { onmessage: null, postMessage() {} };
    worklets.push(this);
  }
  connect() {}
  disconnect() {}
}

class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWS.last = this;
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
  }
}
FakeWS.OPEN = 1;

const intervals = [];
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
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: (fn, ms) => {
    intervals.push({ fn, ms });
    return intervals.length;
  },
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
      sendMessage: async () => ({}),
      onMessage: { addListener: () => {} },
    },
  },
};
vm.createContext(sandbox);
const src = fs.readFileSync(path.join(ROOT, 'offscreen.js'), 'utf8');
// 把內部函式借出來，測試才能直接檢查緩衝狀態
vm.runInContext(
  src + '\n;globalThis.__t = { live, queuePcm, flushPcm, resetPlayback };',
  sandbox
);
const T = sandbox.__t;

// 每 120ms 的看門狗（決定「這句到齊了沒」的地方）
const watchdog = intervals.filter((i) => i.ms === 120).map((i) => i.fn)[0];

// 24kHz 的 0.1 秒正弦波（聽起來像人聲持續發聲，不會被 smoothGaps 當成停頓）
function chunkB64(n = 2400) {
  const i16 = new Int16Array(n);
  for (let i = 0; i < n; i++) i16[i] = Math.round(0.25 * 32767 * Math.sin((2 * Math.PI * 220 * i) / 24000));
  return Buffer.from(i16.buffer).toString('base64');
}
const MIME = 'audio/pcm;rate=24000';

function feedAudio() {
  FakeWS.last.onmessage({
    data: JSON.stringify({
      serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: MIME, data: chunkB64() } }] } },
    }),
  });
}

function feedText(text) {
  FakeWS.last.onmessage({
    data: JSON.stringify({ serverContent: { outputTranscription: { text } } }),
  });
}

// 模型回傳的句尾常夾一小段靜音
function feedSilentOut(n = 2400) {
  const b64 = Buffer.from(new Int16Array(n).buffer).toString('base64');
  FakeWS.last.onmessage({
    data: JSON.stringify({
      serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: MIME, data: b64 } }] } },
    }),
  });
}

// 分頁擷取到的輸入音（0 = 靜音）：用來模擬「講者停下來了」
function feedInput(amp, n = 1600) {
  const i16 = new Int16Array(n);
  for (let i = 0; i < n; i++) i16[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * 220 * i) / 16000));
  const node = worklets[0];
  if (node && node.port.onmessage) node.port.onmessage({ data: i16.buffer });
}

function advance(ms, step = 100) {
  let left = ms;
  while (left > 0) {
    const d = Math.min(step, left);
    tick(d);
    left -= d;
    if (watchdog) watchdog();
  }
}

const totalDur = () => scheduled.reduce((a, b) => a + b.dur, 0);
const overlaps = () =>
  scheduled.some((s, i) => i > 0 && s.start < scheduled[i - 1].start + scheduled[i - 1].dur - 0.02);

(async function main() {
  const res = await sandbox.start('stream-id', {
    apiKey: 'k',
    model: 'gemini-3.5-live-translate-preview',
    mode: 'dub',
    targetLanguage: '繁體中文（台灣）',
    originalVolume: 0.3,
    vad: 'auto',
  });
  ok(!res.error, 'start() 沒有回錯');

  const ws = FakeWS.last;
  ws.readyState = 1;
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
  ok(T.live.resolvedMode === 'dub', 'translate 模型 + 配音模式 → 會播放');

  /* 情境一：句中回傳很慢（每 0.1 秒音訊之間隔 400ms）→ 一句話不能被切開 */
  const before = scheduled.length;
  for (let i = 0; i < 8; i++) {
    feedAudio();
    advance(400);
  }
  ok(scheduled.length === before, '句中音訊有 400ms 空隙時，不會提前切句（送出 0 段）');

  feedText('第一句話講完了。');
  advance(400);
  ok(scheduled.length === before + 1, '句尾標點 + 音訊靜止 → 整句只播一段');
  const d1 = scheduled[before] ? scheduled[before].dur : 0;
  ok(d1 > 0.7 && d1 < 0.9, '第一段長度 ≈ 送進來的 0.8 秒（實際 ' + d1.toFixed(3) + 's）');

  /* 情境二：句尾標點先到、音訊之後才陸續滴進來（間隔 < 250ms，不會觸發靜止判斷） */
  const before2 = scheduled.length;
  feedText('第二句話。');
  for (let i = 0; i < 10; i++) {
    feedAudio();
    advance(100);
  }
  advance(300); // 音訊停下來超過 400ms 的靜止門檻
  ok(scheduled.length === before2 + 1, '音訊持續滴流時，句尾標點仍會在等待上限後播一次');
  const d2 = scheduled[before2] ? scheduled[before2].dur : 0;
  ok(d2 > 0.9 && d2 < 1.1, '第二段長度 ≈ 1.0 秒（實際 ' + d2.toFixed(3) + 's）');

  /* 情境三：完全沒有標點、也沒偵測到講者停頓 → 音訊靜止 6 秒才播 */
  const before3 = scheduled.length;
  for (let i = 0; i < 15; i++) {
    feedAudio();
    advance(100);
  }
  advance(5000);
  ok(scheduled.length === before3, '沒有標點時，靜止未滿 6 秒不播（不切句）');
  advance(1500);
  ok(scheduled.length === before3 + 1, '沒有標點時，靜止滿 6 秒播一次');
  const d3 = scheduled[before3] ? scheduled[before3].dur : 0;
  ok(d3 > 1.4 && d3 < 1.6, '第三段長度 ≈ 1.5 秒（實際 ' + d3.toFixed(3) + 's）');

  /* 情境四：一直講都不停、沒有標點 → 到 8 秒保底才播，避免延遲無限長大 */
  const before4 = scheduled.length;
  for (let i = 0; i < 90; i++) {
    feedAudio();
    advance(100);
  }
  ok(scheduled.length >= before4 + 1, '連續 9 秒沒有標點時，保底會播（不會永不出聲）');
  const first = scheduled[before4] ? scheduled[before4].dur : 0;
  ok(first > 7.5 && first <= 8.2, '保底切點 ≈ 8 秒（實際 ' + first.toFixed(3) + 's）');

  /* 保底播完後剩下的尾巴，靜止夠久仍會播出（不會被吞掉） */
  const beforeTail = scheduled.length;
  advance(6500); // 超過 IDLE_FLUSH（6 秒）
  ok(scheduled.length === beforeTail + 1, '保底之後的尾段仍會播出（音訊不丟）');
  const tail = scheduled[beforeTail] ? scheduled[beforeTail].dur : 0;
  ok(tail > 0.9 && tail < 1.1, '尾段長度 ≈ 剩下的 1.0 秒（實際 ' + tail.toFixed(3) + 's）');

  /* 情境五：模型在句尾夾了一段靜音 → 剪掉，否則接到下一句就變成空白 */
  const before5 = scheduled.length;
  for (let i = 0; i < 10; i++) {
    feedAudio();
    advance(100);
  }
  for (let i = 0; i < 5; i++) {
    feedSilentOut();
    advance(100);
  }
  feedText('開始關注天上的徵兆。');
  advance(500);
  ok(scheduled.length === before5 + 1, '含句尾靜音的句子仍然只播一段');
  const d5 = scheduled[before5] ? scheduled[before5].dur : 0;
  ok(d5 > 1.0 && d5 < 1.25, '句尾 0.5 秒靜音被剪掉（1.0s + 0.1s 尾音，實際 ' + d5.toFixed(3) + 's）');

  /* 情境六：講者停下來 → 不必等 6 秒或標點，譯音收尾就播 */
  const before6 = scheduled.length;
  for (let i = 0; i < 3; i++) {
    feedAudio();
    advance(100);
  }
  ok(scheduled.length === before6, '講者還在講時，音訊 300ms 的空檔不會被當成句尾');
  for (let i = 0; i < 10; i++) {
    feedInput(0);
    advance(100);
  }
  ok(scheduled.length === before6 + 1, '講者安靜 600ms 後就播（不用等 6 秒或標點）');
  const d6 = scheduled[before6] ? scheduled[before6].dur : 0;
  ok(d6 > 0.2 && d6 < 0.4, '第六段長度 ≈ 0.3 秒（實際 ' + d6.toFixed(3) + 's）');

  /* 全域檢查 */
  ok(!overlaps(), '排程沒有重疊（不會兩段聲音同時唸）');
  const expected = 0.8 + 1.0 + 1.5 + 9.0 + 1.1 + 0.3;
  ok(
    Math.abs(totalDur() - expected) < 0.2,
    '播放總長符合預期（剪掉的只有句尾靜音）：' + totalDur().toFixed(2) + 's / ' + expected.toFixed(2) + 's'
  );

  console.log(fail ? '\n有 ' + fail + ' 項失敗' : '\n播放排程檢查全部通過');
  process.exit(fail ? 1 : 0);
})();
