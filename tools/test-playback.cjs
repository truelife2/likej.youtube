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
  advance(300); // 超過句尾後的等待上限（1200ms）
  ok(scheduled.length === before2 + 1, '音訊持續滴流時，句尾標點仍會在等待上限後播一次');
  const d2 = scheduled[before2] ? scheduled[before2].dur : 0;
  ok(d2 > 0.9 && d2 < 1.1, '第二段長度 ≈ 1.0 秒（實際 ' + d2.toFixed(3) + 's）');

  /* 情境三：完全沒有標點 → 音訊靜止 3 秒才播，且不切成兩段 */
  const before3 = scheduled.length;
  for (let i = 0; i < 15; i++) {
    feedAudio();
    advance(100);
  }
  advance(2000);
  ok(scheduled.length === before3, '沒有標點時，靜止未滿 3 秒不播（不切句）');
  advance(1500);
  ok(scheduled.length === before3 + 1, '沒有標點時，靜止滿 3 秒播一次');
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
  const before5 = scheduled.length;
  advance(3200);
  ok(scheduled.length === before5 + 1, '保底之後的尾段仍會播出（音訊不丟）');
  const tail = scheduled[before5] ? scheduled[before5].dur : 0;
  ok(tail > 0.9 && tail < 1.1, '尾段長度 ≈ 剩下的 1.0 秒（實際 ' + tail.toFixed(3) + 's）');

  /* 全域檢查 */
  ok(!overlaps(), '排程沒有重疊（不會兩段聲音同時唸）');
  const fed = 0.8 + 1.0 + 1.5 + 9.0;
  ok(
    Math.abs(totalDur() - fed) < fed * 0.05,
    '播放總長與送進來的音訊相符（' + totalDur().toFixed(2) + 's / ' + fed.toFixed(2) + 's）'
  );

  console.log(fail ? '\n有 ' + fail + ' 項失敗' : '\n播放排程檢查全部通過');
  process.exit(fail ? 1 : 0);
})();
