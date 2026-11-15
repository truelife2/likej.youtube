// 用真實影片音訊驗證「降採樣 + 切句」這一段（不需要 API key）
// 用法：node test-segment.cjs [testmedia/audio48.pcm]
const fs = require('fs');
const vm = require('vm');
const { SpeechSegmenter } = require('./vad.js');

const PCM = process.argv[2] || 'testmedia/audio48.pcm';
if (!fs.existsSync(PCM)) {
  console.error('找不到', PCM, '——先用 yt-dlp + ffmpeg 產生 48kHz 單聲道 s16le');
  process.exit(1);
}

/* ---------- 1. 用真正的 audio-worklet 降採樣 ---------- */
const collected = [];
let Registered = null;
const wctx = {
  sampleRate: 48000,
  AudioWorkletProcessor: class {
    constructor() {
      this.port = { postMessage: (b) => collected.push(Buffer.from(b)) };
    }
  },
  registerProcessor: (_n, C) => {
    Registered = C;
  },
  Float32Array,
  Int16Array,
  Math,
};
vm.createContext(wctx);
vm.runInContext(fs.readFileSync('audio-worklet.js', 'utf8'), wctx);
const proc = new Registered({ processorOptions: { targetRate: 16000, chunkSamples: 1600 } });

const raw = fs.readFileSync(PCM);
const seconds = raw.length / 2 / 48000;
console.log('音訊長度：', seconds.toFixed(1), '秒 /', (raw.length / 1048576).toFixed(1), 'MB');

const BLOCK = 128;
const f32 = new Float32Array(BLOCK);
for (let off = 0; off + BLOCK * 2 <= raw.length; off += BLOCK * 2) {
  for (let i = 0; i < BLOCK; i++) f32[i] = raw.readInt16LE(off + i * 2) / 32768;
  proc.process([[f32]]);
}
console.log('降採樣輸出塊數：', collected.length, '(預期約', Math.round(seconds * 10), ')');

/* ---------- 2. 跑 VAD ---------- */
function run(sensitivity) {
  const seg = new SpeechSegmenter({ sensitivity });
  const utts = [];
  let cur = null;
  let speechFrames = 0;
  let idx = 0;

  for (const chunk of collected) {
    // vad.js 期待真正的 ArrayBuffer（瀏覽器環境），Node 的 Buffer 要轉一下
    const buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    const r = seg.push(buf);
    idx += 1;
    if (r.speech) speechFrames += 1;

    if (r.end && cur) {
      cur.dur = (idx - cur.startIdx) * 0.1;
      utts.push(cur);
      cur = null;
    }
    if (r.start) cur = { startIdx: idx, startSec: (idx - 1) * 0.1, peak: 0, preRoll: r.chunks.length };
    if (cur) {
      cur.peak = Math.max(cur.peak, r.rms);
      cur.dur = (idx - cur.startIdx + 1) * 0.1;
    }
  }
  if (cur) {
    cur.dur = (idx - cur.startIdx + 1) * 0.1;
    utts.push(cur);
  }

  const durs = utts.map((u) => u.dur);
  const sorted = [...durs].sort((a, b) => a - b);
  return {
    utts,
    durs,
    median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    short: durs.filter((d) => d < 0.8).length,
    forced: durs.filter((d) => d >= 11.9).length,
    speechRatio: speechFrames / idx,
    total: idx,
  };
}

function report(sens) {
  const r = run(sens);
  const cover = r.durs.reduce((a, b) => a + b, 0);
  console.log('\n=== 靈敏度 ' + sens + ' ===');
  console.log('語音格數比例：', (r.speechRatio * 100).toFixed(1) + '%');
  console.log('切出句數：', r.utts.length);
  console.log(
    '句長 中位數 / 最短 / 最長：',
    r.median.toFixed(2),
    '/',
    Math.min(...r.durs).toFixed(2),
    '/',
    Math.max(...r.durs).toFixed(2),
    '秒'
  );
  console.log('過短(<0.8s)：', r.short, '  被迫切斷(>=11.9s)：', r.forced);
  console.log('送出的語音總長：', cover.toFixed(1), '秒（', ((cover / seconds) * 100).toFixed(1), '% 的音訊）');
  console.log('前 12 句（起點 → 長度, 峰值 RMS, 前置緩衝塊數）：');
  for (const u of r.utts.slice(0, 12)) {
    console.log(
      '    ' + u.startSec.toFixed(1) + 's →',
      u.dur.toFixed(1) + 's',
      ' peak',
      u.peak.toFixed(4),
      ' pre',
      u.preRoll
    );
  }
  return r;
}

const rDefault = report(1.0);
report(1.6);
report(0.6);

/* ---------- 3. 對照字幕 ---------- */
const vttPath = 'testmedia/Jpn6wdPVRzQ.en.vtt';
if (fs.existsSync(vttPath)) {
  const vtt = fs.readFileSync(vttPath, 'utf8');
  const cues = [...vtt.matchAll(/(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})/g)];
  const toSec = (h, m, s, ms) => +h * 3600 + +m * 60 + +s + +ms / 1000;
  const spans = cues.map((m) => [toSec(m[1], m[2], m[3], m[4]), toSec(m[5], m[6], m[7], m[8])]);
  const merged = [];
  let lastEnd = null;
  let bigGaps = 0;
  for (const [s, e] of spans) {
    if (lastEnd != null && s - lastEnd >= 0.6) bigGaps += 1;
    lastEnd = Math.max(lastEnd == null ? e : lastEnd, e);
  }
  const subSpeech = spans.reduce((a, [s, e]) => a + (e - s), 0);
  console.log('\n=== 字幕對照 ===');
  console.log('字幕 cue 數：', spans.length, '（平均每句', (subSpeech / spans.length).toFixed(2), '秒）');
  console.log('字幕裡的停頓(>=0.6s)：', bigGaps, '處 → VAD 最多可以切出這麼多句');
  console.log('VAD 句數 / 停頓數 =', rDefault.utts.length, '/', bigGaps);
}
