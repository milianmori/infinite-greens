/*
  spatial-processor
  - Inputs:
    0: Rain path (stereo)
    1: Noise path (stereo)
  - Output: 7 mono channels
    ch0..ch4: decorrelated stems derived from rain stereo
    ch5..ch6: decorrelated stems derived from noise stereo
  - Posts simple RMS meters per channel each render quantum
*/

class SpatialProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Simple delay-line decorrelators per output channel
    // Use prime-ish lengths to avoid obvious combing; lengths in samples at 44.1k
    this.rainDelays = [23, 37, 53, 71, 89];
    this.noiseDelays = [101, 127];

    const mkBuf = (len) => ({ buf: new Float32Array(len), idx: 0, len });
    this.rainBufs = this.rainDelays.map((d) => mkBuf(d));
    this.noiseBufs = this.noiseDelays.map((d) => mkBuf(d));

    this.meterAccum = new Float64Array(7);
    this.meterCount = 0;

    this.port.onmessage = (e) => {
      const data = e.data || {};
      if (data && data.resetMeters) {
        this.meterAccum.fill(0);
        this.meterCount = 0;
      }
    };
  }

  static get parameterDescriptors() {
    return [];
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length < 7) return true;

    const inRain = inputs[0] || [];
    const inNoise = inputs[1] || [];
    const rainL = inRain[0] || new Float32Array(128);
    const rainR = inRain[1] || new Float32Array(128);
    const noiseL = inNoise[0] || new Float32Array(128);
    const noiseR = inNoise[1] || new Float32Array(128);

    const ch0 = out[0];
    const ch1 = out[1];
    const ch2 = out[2];
    const ch3 = out[3];
    const ch4 = out[4];
    const ch5 = out[5];
    const ch6 = out[6];

    const N = ch0.length;

    for (let i = 0; i < N; i += 1) {
      // Mid/side-like bases for rain and noise
      const rMid = (rainL[i] + rainR[i]) * 0.5;
      const rSide = (rainL[i] - rainR[i]) * 0.5;
      const nMid = (noiseL[i] + noiseR[i]) * 0.5;
      const nSide = (noiseL[i] - noiseR[i]) * 0.5;

      // Push into delay buffers and read taps
      // Rain stems (5)
      let r0 = 0, r1 = 0, r2 = 0, r3 = 0, r4 = 0;
      for (let s = 0; s < 5; s += 1) {
        const b = this.rainBufs[s];
        // Mix mid/side differently per stem
        const wMid = 0.6 + 0.08 * s; // 0.6..0.92
        const wSide = 1 - wMid;      // 0.4..0.08
        const v = wMid * rMid + wSide * rSide;
        b.buf[b.idx] = v;
        const readIdx = (b.idx + 1) % b.len;
        const outV = b.buf[readIdx];
        b.idx = readIdx;
        switch (s) {
          case 0: r0 = outV; break;
          case 1: r1 = outV; break;
          case 2: r2 = outV; break;
          case 3: r3 = outV; break;
          case 4: r4 = outV; break;
        }
      }

      // Noise stems (2)
      let n0 = 0, n1 = 0;
      for (let s = 0; s < 2; s += 1) {
        const b = this.noiseBufs[s];
        const wMid = 0.7 + 0.2 * s; // 0.7, 0.9
        const wSide = 1 - wMid;     // 0.3, 0.1
        const v = wMid * nMid + wSide * nSide;
        b.buf[b.idx] = v;
        const readIdx = (b.idx + 1) % b.len;
        const outV = b.buf[readIdx];
        b.idx = readIdx;
        if (s === 0) n0 = outV; else n1 = outV;
      }

      ch0[i] = r0;
      ch1[i] = r1;
      ch2[i] = r2;
      ch3[i] = r3;
      ch4[i] = r4;
      ch5[i] = n0;
      ch6[i] = n1;

      // meters: accumulate square
      this.meterAccum[0] += r0 * r0;
      this.meterAccum[1] += r1 * r1;
      this.meterAccum[2] += r2 * r2;
      this.meterAccum[3] += r3 * r3;
      this.meterAccum[4] += r4 * r4;
      this.meterAccum[5] += n0 * n0;
      this.meterAccum[6] += n1 * n1;
    }

    this.meterCount += N;
    // Post meters once per render quantum
    if (this.meterCount > 0) {
      const rms = new Float32Array(7);
      for (let c = 0; c < 7; c += 1) {
        const v = Math.sqrt(this.meterAccum[c] / this.meterCount) || 0;
        rms[c] = v;
        this.meterAccum[c] = 0;
      }
      this.meterCount = 0;
      this.port.postMessage({ type: 'meters', rms });
    }

    return true;
  }
}

registerProcessor('spatial-processor', SpatialProcessor);


