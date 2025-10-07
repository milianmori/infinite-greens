/*
  spatial-processor
  - Inputs:
    0: Rain stems (5-channel mono from resonator)
    1: Noise path (stereo)
  - Output: 7 mono channels
    ch0..ch4: pass-through of rain stems 0..4
    ch5..ch6: decorrelated stems derived from noise stereo
  - Posts simple RMS meters per channel each render quantum
*/

class SpatialProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Simple delay-line decorrelators for noise channels only
    this.noiseDelays = [101, 127];
    const mkBuf = (len) => ({ buf: new Float32Array(len), idx: 0, len });
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
      // For rain stems: pass-through 5 mono inputs to 5 outputs
      const r0 = (inRain[0] || new Float32Array(N))[i] || 0;
      const r1 = (inRain[1] || new Float32Array(N))[i] || 0;
      const r2 = (inRain[2] || new Float32Array(N))[i] || 0;
      const r3 = (inRain[3] || new Float32Array(N))[i] || 0;
      const r4 = (inRain[4] || new Float32Array(N))[i] || 0;

      // Mid/side-like bases for noise
      const nMid = (noiseL[i] + noiseR[i]) * 0.5;
      const nSide = (noiseL[i] - noiseR[i]) * 0.5;

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


