//
// capture-worklet.js — マイク入力を 1024 サンプル単位で main thread へ送る。
// (AudioWorklet の量子は 128 サンプルなので貯めてから送る)
//
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.fill = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const n = Math.min(ch.length - i, 1024 - this.fill);
        this.buf.set(ch.subarray(i, i + n), this.fill);
        this.fill += n;
        i += n;
        if (this.fill === 1024) {
          this.port.postMessage(this.buf.slice());
          this.fill = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);
