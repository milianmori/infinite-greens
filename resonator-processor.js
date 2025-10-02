/*
  ResonatorProcessor
  - Up to 40 branches, each a resonator fed by continuous white noise
  - Two resonator types: 2-pole real and complex 1-pole, crossfaded by rmix
  - Stereo output with per-branch equal-power panning
  - Global AudioParams: nbranches, noiseLevel, rmix, freqScale, freqCenter, decayScale
  - Per-branch params set via messages: setBranchParams(index, { freq, decay, amp, pan })
*/

const MAX_BRANCHES = 40;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Simple per-sample smoothing: current += (target - current) * alpha
function smoothToward(current, target, alpha) {
  if (current === target) return current;
  return current + (target - current) * alpha;
}

class ResonatorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'nbranches',
        defaultValue: 16,
        minValue: 1,
        maxValue: MAX_BRANCHES,
        automationRate: 'k-rate'
      },
      {
        name: 'noiseLevel',
        defaultValue: 0.1,
        minValue: 0,
        maxValue: 0.5,
        automationRate: 'a-rate'
      },
      {
        name: 'rmix',
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: 'a-rate'
      },
      {
        name: 'freqScale',
        defaultValue: 1,
        minValue: 0.25,
        maxValue: 4,
        automationRate: 'k-rate'
      },
      {
        name: 'freqCenter',
        defaultValue: 0,
        minValue: -2000,
        maxValue: 2000,
        automationRate: 'k-rate'
      },
      {
        name: 'decayScale',
        defaultValue: 1,
        minValue: 0.25,
        maxValue: 4,
        automationRate: 'k-rate'
      }
    ];
  }

  constructor() {
    super();

    const sr = sampleRate;

    // Per-branch state arrays
    this.branchFreqHz = new Float32Array(MAX_BRANCHES); // target freq in Hz
    this.branchDecayMs = new Float32Array(MAX_BRANCHES); // target decay in ms
    this.branchAmp = new Float32Array(MAX_BRANCHES); // target linear gain
    this.branchPan = new Float32Array(MAX_BRANCHES); // target pan in [-1, 1]

    // Smoothed params
    this.smoothFreqHz = new Float32Array(MAX_BRANCHES);
    this.smoothAmp = new Float32Array(MAX_BRANCHES);
    this.smoothPan = new Float32Array(MAX_BRANCHES); // still in [-1, 1]
    this.smoothMix = 0.5; // rmix smoothing

    // Precomputed per-branch pan gains (equal-power)
    this.leftPanGain = new Float32Array(MAX_BRANCHES);
    this.rightPanGain = new Float32Array(MAX_BRANCHES);

    // 2-pole resonator state per branch
    this.two_a = new Float32Array(MAX_BRANCHES);
    this.two_b = new Float32Array(MAX_BRANCHES);
    this.two_c = new Float32Array(MAX_BRANCHES);
    this.two_y1 = new Float32Array(MAX_BRANCHES);
    this.two_y2 = new Float32Array(MAX_BRANCHES);

    // Complex 1-pole resonator state per branch
    this.c_r = new Float32Array(MAX_BRANCHES); // pole radius
    this.c_rcos = new Float32Array(MAX_BRANCHES);
    this.c_rsin = new Float32Array(MAX_BRANCHES);
    this.c_ry1 = new Float32Array(MAX_BRANCHES);
    this.c_iy1 = new Float32Array(MAX_BRANCHES);

    // Cached effective params for re-coefficient checks
    this.cachedEffFreq = new Float32Array(MAX_BRANCHES);
    this.cachedEffDecay = new Float32Array(MAX_BRANCHES);

    // Smoothing coefficients (empirical, similar to provided idea)
    this.alphaFreq = 0.0005;
    this.alphaAmp = 0.0007;
    this.alphaMix = 0.0007;

    // Constants for coefficient calculations
    this.twopi = Math.PI * 2;
    this.twopiOverSR = this.twopi / sr;
    this.mssr = -1000 / sr; // used for complex pole decay mapping from ms

    // Defaults for safety
    for (let i = 0; i < MAX_BRANCHES; i += 1) {
      this.branchFreqHz[i] = 440;
      this.branchDecayMs[i] = 400;
      this.branchAmp[i] = 0.02;
      this.branchPan[i] = 0;
      this.smoothFreqHz[i] = this.branchFreqHz[i];
      this.smoothAmp[i] = this.branchAmp[i];
      this.smoothPan[i] = this.branchPan[i];
      this.updatePanGains(i);
      this.cachedEffFreq[i] = 0;
      this.cachedEffDecay[i] = 0;
      this.recomputeCoefficients(i, 440, 400); // initialize
    }

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'setBranchParams') {
        const { index, params } = data;
        if (index >= 0 && index < MAX_BRANCHES && params) {
          if (typeof params.freq === 'number') this.branchFreqHz[index] = params.freq;
          if (typeof params.decay === 'number') this.branchDecayMs[index] = Math.max(1, params.decay);
          if (typeof params.amp === 'number') this.branchAmp[index] = Math.max(0, params.amp);
          if (typeof params.pan === 'number') {
            this.branchPan[index] = clamp(params.pan, -1, 1);
            this.smoothPan[index] = this.branchPan[index];
            this.updatePanGains(index);
          }
        }
      } else if (data.type === 'setAllBranches') {
        const arr = data.branches || [];
        const count = Math.min(arr.length, MAX_BRANCHES);
        for (let i = 0; i < count; i += 1) {
          const p = arr[i] || {};
          this.branchFreqHz[i] = typeof p.freq === 'number' ? p.freq : 440;
          this.branchDecayMs[i] = typeof p.decay === 'number' ? Math.max(1, p.decay) : 400;
          this.branchAmp[i] = typeof p.amp === 'number' ? Math.max(0, p.amp) : 0.02;
          this.branchPan[i] = typeof p.pan === 'number' ? clamp(p.pan, -1, 1) : 0;
          this.smoothFreqHz[i] = this.branchFreqHz[i];
          this.smoothAmp[i] = this.branchAmp[i];
          this.smoothPan[i] = this.branchPan[i];
          this.updatePanGains(i);
          // force coeff recompute next block
          this.cachedEffFreq[i] = 0;
          this.cachedEffDecay[i] = 0;
        }
      }
    };
  }

  updatePanGains(index) {
    // Equal-power panning from pan [-1,1]
    const pan = clamp(this.smoothPan[index], -1, 1);
    const t = (pan + 1) * 0.5; // 0..1
    const left = Math.cos(t * Math.PI * 0.5);
    const right = Math.sin(t * Math.PI * 0.5);
    this.leftPanGain[index] = left;
    this.rightPanGain[index] = right;
  }

  recomputeCoefficients(index, effFreqHz, effDecayMs) {
    const sr = sampleRate;
    const omega = this.twopi * effFreqHz / sr; // rad/sample
    const bw = Math.E / Math.max(1e-3, effDecayMs * 0.001); // ~ 1/time constant (Hz-ish)
    const bwrps = bw * this.twopiOverSR; // bandwidth in rad/sample

    // 2-pole real resonator coefficients
    const eNegHalfBW = Math.exp(-0.5 * bwrps);
    const cosW = Math.cos(omega);
    const b = 2 * cosW * eNegHalfBW;
    const c = -Math.exp(-bwrps);
    const a = 1 - (c + b);
    this.two_a[index] = a;
    this.two_b[index] = b;
    this.two_c[index] = c;

    // Complex 1-pole
    const radius = Math.exp(this.mssr / (Math.max(1, effDecayMs) * 0.08));
    this.c_r[index] = radius;
    this.c_rcos[index] = radius * Math.cos(omega);
    this.c_rsin[index] = radius * Math.sin(omega);
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const outL = output[0];
    const outR = output[1];

    const frames = outL.length;

    const pBranches = parameters.nbranches;
    const pNoise = parameters.noiseLevel;
    const pMix = parameters.rmix;
    const pFreqScale = parameters.freqScale;
    const pFreqCenter = parameters.freqCenter;
    const pDecayScale = parameters.decayScale;

    const freqScale = pFreqScale.length === 1 ? pFreqScale[0] : pFreqScale[0];
    const freqCenter = pFreqCenter.length === 1 ? pFreqCenter[0] : pFreqCenter[0];
    const decayScale = pDecayScale.length === 1 ? pDecayScale[0] : pDecayScale[0];

    const nBranches = clamp(pBranches[0] | 0, 0, MAX_BRANCHES);

    for (let i = 0; i < frames; i += 1) {
      const noiseLevel = pNoise.length > 1 ? pNoise[i] : pNoise[0];
      const noise = (Math.random() * 2 - 1) * noiseLevel;
      const rmixTarget = pMix.length > 1 ? pMix[i] : pMix[0];
      // smooth global rmix
      this.smoothMix = smoothToward(this.smoothMix, rmixTarget, this.alphaMix);

      let l = 0;
      let r = 0;

      for (let b = 0; b < nBranches; b += 1) {
        // smooth per-branch params
        const freqTarget = this.branchFreqHz[b];
        const ampTarget = this.branchAmp[b];
        const panTarget = this.branchPan[b];

        const freqHz = (this.smoothFreqHz[b] = smoothToward(
          this.smoothFreqHz[b],
          freqTarget,
          this.alphaFreq
        ));
        const amp = (this.smoothAmp[b] = smoothToward(
          this.smoothAmp[b],
          ampTarget,
          this.alphaAmp
        ));
        const panNow = (this.smoothPan[b] = smoothToward(
          this.smoothPan[b],
          panTarget,
          this.alphaAmp
        ));

        // update pan gains if pan smoothed changed significantly
        // lightweight check
        if ((i & 7) === 0) {
          this.updatePanGains(b);
        }

        // Effective global-scaling adjusted params
        const effFreq = clamp(freqHz * freqScale + freqCenter, 25, sampleRate * 0.45);
        const effDecay = Math.max(1, this.branchDecayMs[b] * decayScale);

        // Update coefficients if effective params changed notably
        if (
          Math.abs(effFreq - this.cachedEffFreq[b]) > 0.1 ||
          Math.abs(effDecay - this.cachedEffDecay[b]) > 0.1
        ) {
          this.cachedEffFreq[b] = effFreq;
          this.cachedEffDecay[b] = effDecay;
          this.recomputeCoefficients(b, effFreq, effDecay);
        }

        // Exciter -> noise
        const x = noise;

        // 2-pole real resonator
        const y = this.two_a[b] * x + this.two_b[b] * this.two_y1[b] + this.two_c[b] * this.two_y2[b];
        this.two_y2[b] = this.two_y1[b];
        this.two_y1[b] = clamp(y, -1, 1);

        // Complex 1-pole resonator
        const ry = x * 0.1 + this.c_rcos[b] * this.c_ry1[b] - this.c_rsin[b] * this.c_iy1[b];
        const iy = this.c_rsin[b] * this.c_ry1[b] + this.c_rcos[b] * this.c_iy1[b];
        this.c_ry1[b] = clamp(ry, -1, 1);
        this.c_iy1[b] = clamp(iy, -1, 1);

        // Crossfade by rmix (smoothed)
        const sum = (1 - this.smoothMix) * this.two_y1[b] + this.smoothMix * this.c_ry1[b];

        // Gain and pan (equal-power)
        const v = sum * amp;
        l += v * this.leftPanGain[b];
        r += v * this.rightPanGain[b];
      }

      outL[i] = l;
      outR[i] = r;
    }

    return true;
  }
}

registerProcessor('resonator-processor', ResonatorProcessor);


