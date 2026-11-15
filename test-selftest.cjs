// 自我檢查：驗證 AudioWorklet 的降採樣、offscreen 的 base64 與 setup 訊息結構。
// 用法：node test-selftest.cjs
const fs = require('fs');
const vm = require('vm');

/* ---------------- 1. audio-worklet ---------------- */
let Registered = null;
const collected = [];

const workletSandbox = {
  sampleRate: 48000,
  AudioWorkletProcessor: class {
    constructor() {
      this.port = { postMessage: (buf) => collected.push(Buffer.from(buf)) };
    }
  },
  registerProcessor(name, Ctor) {
    Registered = { name, Ctor };
  },
  Float32Array,
  Int16Array,
  Math,
};

vm.createContext(workletSandbox);
vm.runInContext(fs.readFileSync('audio-worklet.js', 'utf8'), workletSandbox);

if (!Registered || Registered.name !== 'pcm-capture') throw new Error('processor not registered');
const processor = new Registered.Ctor({ processorOptions: { targetRate: 16000, chunkSamples: 1600 } });

const SR = 48000;
const N = SR; // 1 second
const input = new Float32Array(N);
for (let i = 0; i < N; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);

const BLOCK = 128;
for (let off = 0; off < N; off += BLOCK) {
  processor.process([[input.subarray(off, Math.min(off + BLOCK, N))]]);
}

const samples = [];
for (const c of collected) {
  const i16 = new Int16Array(c.buffer, c.byteOffset, c.byteLength / 2);
  for (let i = 0; i < i16.length; i++) samples.push(i16[i] / 32768);
}

console.log('worklet: chunks =', collected.length, ' samples =', samples.length, '(expect ~16000，尾端不足一塊會留在緩衝)');

let crossings = 0;
for (let i = 1; i < samples.length; i++) {
  if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) crossings++;
}
const hz = crossings / 2 / (samples.length / 16000);
console.log('worklet: estimated frequency =', hz.toFixed(1), 'Hz (expect ~440)');

if (Math.abs(samples.length - 16000) > 2000) throw new Error('wrong sample count');
if (Math.abs(hz - 440) > 25) throw new Error('wrong frequency - resampling broken');
const peak = Math.max(...samples.map(Math.abs));
if (peak < 0.3) throw new Error('amplitude too low');
console.log('worklet: peak =', peak.toFixed(3));

/* ---------------- 2. offscreen base64 + setup ---------------- */
const { SpeechSegmenter } = require('./vad.js');
const offSandbox = {
  console,
  Math,
  Date,
  TextDecoder,
  SpeechSegmenter,
  WebSocket: class {
    constructor() {
      this.readyState = 0;
    }
  },
  AudioContext: class {},
  navigator: { mediaDevices: {} },
  atob,
  btoa,
  Uint8Array,
  Int16Array,
  Float32Array,
  ArrayBuffer,
  setTimeout,
  clearTimeout,
  encodeURIComponent,
  chrome: {
    runtime: {
      getURL: (p) => 'chrome-extension://x/' + p,
      sendMessage: async () => ({}),
      onMessage: { addListener: () => {} },
    },
  },
};
vm.createContext(offSandbox);
vm.runInContext(fs.readFileSync('offscreen.js', 'utf8'), offSandbox);

const enc = offSandbox.base64FromArrayBuffer;
const dec = offSandbox.base64ToBytes;
if (typeof enc !== 'function') throw new Error('base64FromArrayBuffer not global');

let worst = 0;
for (const len of [0, 1, 2, 3, 5, 1024, 3200, 24577]) {
  const buf = new Uint8Array(len);
  for (let i = 0; i < len; i++) buf[i] = (i * 37 + 11) % 256;
  const mine = enc(buf.buffer);
  const ref = Buffer.from(buf).toString('base64');
  if (mine !== ref) throw new Error('base64 mismatch len=' + len);
  const back = dec(mine);
  for (let i = 0; i < len; i++) if (back[i] !== buf[i]) throw new Error('base64 round-trip failed len=' + len);
  worst = Math.max(worst, len);
}
console.log('offscreen: base64 matches Node Buffer exactly (max length tested', worst + ')');

const setup = offSandbox.buildSetup(
  {
    model: 'models/foo',
    mode: 'dub',
    voice: 'Kore',
    targetLanguage: 'ja',
    speechLanguageCode: 'ja-JP',
  },
  0,
  'dub'
);
console.log('setup (dub):', JSON.stringify(setup.generationConfig), '| model =', setup.model);
if (setup.model !== 'models/foo') throw new Error('model name normalisation broken');
if (setup.generationConfig.responseModalities[0] !== 'AUDIO') throw new Error('bad modality');
if (!setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName) throw new Error('missing voice');
if (!setup.inputAudioTranscription || !setup.outputAudioTranscription) throw new Error('transcription not enabled');
if (!setup.realtimeInputConfig || setup.realtimeInputConfig.automaticActivityDetection.disabled !== true)
  throw new Error('manual VAD not requested');
if (setup.realtimeInputConfig.activityHandling !== 'NO_INTERRUPTION')
  throw new Error('NO_INTERRUPTION missing - model will get cut off');

const lite1 = offSandbox.buildSetup({ model: 'foo', mode: 'dub', targetLanguage: 'ja' }, 1, 'dub');
if (lite1.realtimeInputConfig) throw new Error('lite level 1 must drop realtimeInputConfig');
if (!lite1.generationConfig.speechConfig) throw new Error('lite level 1 must keep speechConfig');

const lite3 = offSandbox.buildSetup({ model: 'foo', mode: 'dub', targetLanguage: 'ja' }, 3, 'dub');
if (lite3.inputAudioTranscription || lite3.outputAudioTranscription)
  throw new Error('lite level 3 must drop transcriptions');

const textSetup = offSandbox.buildSetup({ model: 'foo', mode: 'text', targetLanguage: 'English' }, 0, 'text');
if (textSetup.model !== 'models/foo') throw new Error('text mode model prefix broken');
if (textSetup.generationConfig.responseModalities[0] !== 'TEXT') throw new Error('bad text modality');
if (textSetup.generationConfig.speechConfig) throw new Error('text mode must not send speechConfig');
console.log('setup (text):', JSON.stringify(textSetup.generationConfig));

// native-audio 模型：TEXT 會被拒 → 必須自動改成 AUDIO + 逐字稿、不播放
const silent = offSandbox.buildSetup({ model: 'foo', mode: 'text', targetLanguage: 'English' }, 0, 'silent');
if (silent.generationConfig.responseModalities[0] !== 'AUDIO') throw new Error('silent mode must request AUDIO');
if (!silent.generationConfig.speechConfig) throw new Error('silent mode needs speechConfig');
if (!silent.outputAudioTranscription) throw new Error('silent mode needs output transcription');
if (!silent.inputAudioTranscription) throw new Error('silent mode needs input transcription');
console.log('setup (silent):', JSON.stringify(silent.generationConfig));

const rNative = offSandbox.resolveMode({ mode: 'text', model: 'gemini-2.5-flash-native-audio' });
const rLive = offSandbox.resolveMode({ mode: 'text', model: 'gemini-live-2.5-flash-preview' });
const rDub = offSandbox.resolveMode({ mode: 'dub', model: 'gemini-2.5-flash-native-audio' });
if (rNative !== 'silent') throw new Error('native-audio + text mode must resolve to silent, got ' + rNative);
if (rLive !== 'text') throw new Error('live preview + text mode must resolve to text, got ' + rLive);
if (rDub !== 'dub') throw new Error('dub mode must resolve to dub, got ' + rDub);
console.log('resolveMode: native-audio→silent, live-preview→text, dub→dub');

// 專用即時翻譯模型：連續串流 + translationConfig，不能帶 speechConfig / 切句設定
const tr = offSandbox.buildSetup(
  { model: 'gemini-3.5-live-translate-preview', mode: 'dub', targetLanguage: '繁體中文（台灣）', voice: 'Kore' },
  0,
  'dub'
);
console.log('setup (live-translate):', JSON.stringify(tr.generationConfig));
if (!tr.generationConfig.translationConfig) throw new Error('translationConfig missing');
if (tr.generationConfig.translationConfig.targetLanguageCode !== 'zh-Hant')
  throw new Error('bad targetLanguageCode: ' + tr.generationConfig.translationConfig.targetLanguageCode);
if (tr.generationConfig.translationConfig.echoTargetLanguage !== false)
  throw new Error('echoTargetLanguage must default to false');
if (tr.generationConfig.speechConfig) throw new Error('live-translate must not send speechConfig');
if (tr.realtimeInputConfig) throw new Error('live-translate must stream without realtimeInputConfig');
if (!tr.inputAudioTranscription || !tr.outputAudioTranscription)
  throw new Error('live-translate needs both transcriptions for subtitles');
if (/即時同步口譯引擎/.test(tr.systemInstruction.parts[0].text))
  throw new Error('live-translate needs the short translation prompt');

const tr2 = offSandbox.buildSetup(
  { model: 'gemini-3.5-live-translate-preview', mode: 'dub', targetLanguage: '任意字串', targetLangCode: 'pt-BR' },
  0,
  'dub'
);
if (tr2.generationConfig.translationConfig.targetLanguageCode !== 'pt-BR')
  throw new Error('explicit targetLangCode must win');

const rTr = offSandbox.resolveMode({ mode: 'text', model: 'gemini-3.5-live-translate-preview' });
if (rTr !== 'silent') throw new Error('live-translate + text mode must resolve to silent, got ' + rTr);
console.log('live-translate: translationConfig + continuous streaming OK');

/* ---------------- 3. 音量：duckFactor / dubLevel ---------------- */
const duck = offSandbox.duckFactor;
const dub = offSandbox.dubLevel;
if (typeof duck !== 'function' || typeof dub !== 'function') throw new Error('duckFactor/dubLevel not global');

const cases = [
  [{}, 0.12, '預設壓到 12%'],
  [{ duckLevel: 0.25 }, 0.25, '指定 25%'],
  [{ duckLevel: 0 }, 1, '0 代表完全不壓（乘 1）'],
  [{ duckLevel: 1 }, 1, '100%'],
  [{ duckLevel: 2 }, 1, '超過 1 要夾住'],
  [{ duckOriginal: false }, 1, '舊設定相容：不壓低'],
  [{ duckOriginal: true }, 0.12, '舊設定相容：壓低'],
];
for (const [cfg, want, label] of cases) {
  const got = duck(cfg);
  if (Math.abs(got - want) > 1e-9) throw new Error('duckFactor ' + label + ': got ' + got + ' want ' + want);
}
console.log('duckFactor: 7 種設定 OK（預設 0.12，0 = 不壓低）');

if (dub({}) !== 1) throw new Error('dubLevel default must be 1');
if (dub({ outputVolume: -1 }) !== 0) throw new Error('dubLevel must clamp low');
if (dub({ outputVolume: 2 }) !== 1.5) throw new Error('dubLevel must clamp high');
if (dub({ outputVolume: '0.8' }) !== 0.8) throw new Error('dubLevel must accept numeric strings');
console.log('dubLevel: 預設 1、上下限夾住 0–1.5 OK');

/* ---------------- 4. 語言代碼 fallback ---------------- */
if (offSandbox.targetLangCode({}) !== 'zh-Hant') throw new Error('targetLangCode default must be zh-Hant');
if (offSandbox.targetLangCode({ targetLangCode: 'ja' }) !== 'ja')
  throw new Error('explicit targetLangCode must win');
if (offSandbox.targetLangCode({ targetLanguage: '日本語' }) !== 'ja') throw new Error('name lookup broken');
if (offSandbox.targetLangCode({ targetLanguage: 'pt-BR' }) !== 'pt-BR')
  throw new Error('BCP-47 passthrough broken');
console.log('targetLangCode: 預設 zh-Hant、名稱對照、BCP-47 直通 OK');

console.log('\nALL CHECKS PASSED');
