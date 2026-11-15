// vad.js
// 純邏輯的能量式語音切句器（不含 DOM / chrome / WebSocket 依賴，方便測試）。
//
// 為什麼需要它：
//   把連續音訊直接丟給 Gemini Live，伺服器 VAD 會把每個停頓都當成一句結束，
//   產生大量很短的輪次，模型被反覆打斷 → 翻譯零散、多個聲音重疊。
//   由本地先切出完整的句子，再用 activityStart / activityEnd 框住，
//   模型每次拿到的就是一句完整的話。
//
// 用法：
//   const seg = new SpeechSegmenter();
//   const r = seg.push(int16ArrayBuffer);
//   if (r.start) { ...送出 activityStart... }
//   for (const c of r.chunks) sendAudio(c);
//   if (r.end) { ...送出 activityEnd... }

'use strict';

class SpeechSegmenter {
  constructor(options) {
    const o = options || {};
    this.frameMs = o.frameMs || 100;
    this.preRollChunks = o.preRollChunks != null ? o.preRollChunks : 3; // 300ms 前置緩衝
    this.startFrames = o.startFrames != null ? o.startFrames : 2; // 200ms 有聲才開句
    this.endFrames = o.endFrames != null ? o.endFrames : 6; // 600ms 靜音才收句
    this.maxUtteranceMs = o.maxUtteranceMs != null ? o.maxUtteranceMs : 12000;
    this.sensitivity = o.sensitivity || 1;
    this.reset();
  }

  reset() {
    this.speaking = false;
    this.noise = 0.004; // 噪音底噪估計 (RMS)
    this.above = 0;
    this.below = 0;
    this.sentMs = 0;
    this.preRoll = [];
  }

  setSensitivity(v) {
    const n = Number(v);
    this.sensitivity = isNaN(n) || n <= 0 ? 1 : n;
  }

  // 寧可多送一點也不要漏字：底噪的影響有上限，避免整段背景音樂把門檻拉到聽不到人聲
  static threshold(noise, sensitivity) {
    const base = Math.min(0.02, Math.max(0.006, noise * 1.6));
    const s = !sensitivity || isNaN(sensitivity) ? 1 : sensitivity;
    return base / s;
  }

  static rms(buf) {
    const i16 = new Int16Array(buf);
    if (!i16.length) return 0;
    let sum = 0;
    for (let i = 0; i < i16.length; i++) {
      const v = i16[i] / 32768;
      sum += v * v;
    }
    return Math.sqrt(sum / i16.length);
  }

  /**
   * @param {ArrayBuffer} buf 16kHz / 16-bit / 單聲道一小塊 PCM
   * @returns {{start:boolean, chunks:ArrayBuffer[], end:boolean, rms:number, speech:boolean}}
   */
  push(buf) {
    const out = { start: false, chunks: [], end: false, rms: 0, speech: false };
    if (!buf || !buf.byteLength) return out;

    const rms = SpeechSegmenter.rms(buf);
    out.rms = rms;

    const threshold = SpeechSegmenter.threshold(this.noise, this.sensitivity);
    const isSpeech = rms > threshold;
    out.speech = isSpeech;
    out.threshold = threshold;

    if (!this.speaking) {
      // 靜音時緩慢更新噪音底
      if (rms < 0.2) this.noise = Math.min(0.06, this.noise * 0.97 + rms * 0.03);

      this.preRoll.push(buf);
      while (this.preRoll.length > this.preRollChunks) this.preRoll.shift();

      if (isSpeech) {
        this.above += 1;
        if (this.above >= this.startFrames) {
          this.speaking = true;
          this.above = 0;
          this.below = 0;
          this.sentMs = 0;
          out.start = true;
          out.chunks = this.preRoll; // 補送字頭前的緩衝
          this.preRoll = [];
        }
      } else {
        this.above = 0;
      }
      return out;
    }

    // 說話中
    out.chunks.push(buf);
    this.sentMs += this.frameMs;
    this.below = isSpeech ? 0 : this.below + 1;

    if (this.below >= this.endFrames) {
      this.speaking = false;
      this.above = 0;
      this.below = 0;
      this.sentMs = 0;
      out.end = true;
      return out;
    }

    // 一句話拖太長（沒有停頓的旁白）就強制收句，避免翻譯延遲一直累積
    if (this.sentMs >= this.maxUtteranceMs) {
      this.speaking = false;
      this.below = 0;
      this.sentMs = 0;
      out.end = true;
      if (isSpeech) {
        // 立刻接續下一句，不要漏掉正在說的話
        this.speaking = true;
        out.start = true;
      }
    }

    return out;
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { SpeechSegmenter };
