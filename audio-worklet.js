// audio-worklet.js
// 把播放中的音訊 (通常是 48kHz 立體聲) 即時轉成 16kHz / 16-bit / 單聲道 PCM，
// 每 100ms 丟一塊給 offscreen 頁面送去 Gemini Live。
//
// 流程：混成單聲道 -> 一階低通(抗鋸齒) -> 線性插值降採樣 -> Int16 -> postMessage

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.chunkSamples = opts.chunkSamples || 1600; // 1600 @ 16kHz = 100ms

    // sampleRate 是 AudioWorkletGlobalScope 的全域變數
    this.ratio = sampleRate / this.targetRate;

    // 6dB/oct 的一階低通，用來減少降採樣造成的鋸齒。語音主要能量在 4kHz 以下，足夠了。
    const cutoff = Math.min(7000, this.targetRate * 0.45);
    this.lpAlpha = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
    this.lpState = 0;

    this.buf = new Float32Array(0);
    this.readPos = 0;

    this.out = new Float32Array(this.chunkSamples);
    this.outLen = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const n = input[0].length;

    // 1) 混成單聲道
    let mono;
    if (input.length === 1) {
      mono = input[0];
    } else {
      mono = new Float32Array(n);
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        for (let i = 0; i < n; i++) mono[i] += ch[i] / input.length;
      }
    }

    // 2) 低通
    const filtered = new Float32Array(n);
    let y = this.lpState;
    const a = this.lpAlpha;
    for (let i = 0; i < n; i++) {
      y += a * (mono[i] - y);
      filtered[i] = y;
    }
    this.lpState = y;

    // 3) 接到緩衝尾端
    const merged = new Float32Array(this.buf.length + n);
    merged.set(this.buf, 0);
    merged.set(filtered, this.buf.length);
    this.buf = merged;

    // 4) 線性插值降採樣 -> 累積到 chunk
    //    條件用 readPos + ratio，確保不會越過緩衝尾端而多產生一個樣本
    //    （用 readPos + 1 會每個 block 多產生一個樣本，累積成 0.8% 的速度漂移）
    while (this.readPos + this.ratio < this.buf.length) {
      const i0 = Math.floor(this.readPos);
      const f = this.readPos - i0;
      this.out[this.outLen++] = this.buf[i0] * (1 - f) + this.buf[i0 + 1] * f;
      this.readPos += this.ratio;
      if (this.outLen === this.chunkSamples) this.flushChunk();
    }

    // 5) 丟掉已消費的樣本
    const cut = Math.floor(this.readPos);
    if (cut > 0) {
      this.buf = this.buf.slice(cut);
      this.readPos -= cut;
    }

    return true;
  }

  flushChunk() {
    const pcm = new Int16Array(this.chunkSamples);
    for (let i = 0; i < this.chunkSamples; i++) {
      let v = this.out[i];
      if (v > 1) v = 1;
      else if (v < -1) v = -1;
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    this.outLen = 0;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
