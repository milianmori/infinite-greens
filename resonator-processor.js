/*
  ResonatorProcessor
  - Up to 40 branches, each a resonator fed by continuous white noise
  - Two resonator types: 2-pole real and complex 1-pole, crossfaded by rmix
  - Outputs:
    0: Noise-excited wet stereo sum (L,R)
    1: Rain-excited wet stereo sum (L,R)
    2: Rain stems 5-channel mono buses (0..4)
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

function quantize12TET(freqHz) {
  if (freqHz <= 0) return 0;
  const n = Math.round(69 + 12 * Math.log2(freqHz / 440));
  return 440 * Math.pow(2, (n - 69) / 12);
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
        name: 'noiseType', // 0=white,1=pink,2=brown,3=blue
        defaultValue: 0,
        minValue: 0,
        maxValue: 3,
        automationRate: 'k-rate'
      },
      {
        name: 'lfoEnabled', // 0/1 toggle
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      },
      {
        name: 'lfoRate', // Hz
        defaultValue: 2,
        minValue: 0.1,
        maxValue: 20,
        automationRate: 'k-rate'
      },
      {
        name: 'lfoDepth', // 0..1 depth (amplitude scalar from 1-depth..1)
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      },
      {
        name: 'lfoWave', // 0=sine,1=triangle,2=square,3=sample&hold
        defaultValue: 0,
        minValue: 0,
        maxValue: 3,
        automationRate: 'k-rate'
      },
      {
        name: 'rmix',
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: 'a-rate'
      },
      // Removed dryWet: output is always wet-only
      {
        name: 'quantize',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      },
      {
        name: 'exciterCutoff',
        defaultValue: 4000,
        minValue: 20,
        maxValue: 20000,
        automationRate: 'k-rate'
      },
      {
        name: 'exciterHP',
        defaultValue: 50,
        minValue: 10,
        maxValue: 2000,
        automationRate: 'k-rate'
      },
      {
        name: 'groupEnabled', // 0/1: if enabled, split branches into two groups
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      },
      {
        name: 'groupSplit', // integer count of branches in group 1
        defaultValue: 0,
        minValue: 0,
        maxValue: MAX_BRANCHES,
        automationRate: 'k-rate'
      },
      // Raindrop exciter parameters
      {
        name: 'rainEnabled',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      },
      {
        name: 'rainGain',
        defaultValue: 0.3,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      },
      {
        name: 'rainRate', // triggers per second per limb
        defaultValue: 6,
        minValue: 0.1,
        maxValue: 40,
        automationRate: 'k-rate'
      },
      {
        name: 'rainDurMs', // envelope decay of a drop
        defaultValue: 8,
        minValue: 1,
        maxValue: 200,
        automationRate: 'k-rate'
      },
      {
        name: 'rainSpread', // 0..1 controls branch selection spread
        defaultValue: 0.4,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      },
      {
        name: 'rainCenter', // 0..1 center across branch indices
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      },
      {
        name: 'rainLimbs',
        defaultValue: 5,
        minValue: 1,
        maxValue: 10,
        automationRate: 'k-rate'
      },
      {
        name: 'monitorExciter',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      },
      {
        name: 'freqScale',
        defaultValue: 1,
        minValue: 0.25,
        maxValue: 4,
        automationRate: 'k-rate'
      },
      {
        name: 'octaves',
        defaultValue: 0,
        minValue: -4,
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
      ,
      {
        name: 'exciterBandQNoise',
        defaultValue: 25,
        minValue: 0.5,
        maxValue: 80,
        automationRate: 'k-rate'
      },
      {
        name: 'exciterBandQRain',
        defaultValue: 25,
        minValue: 0.5,
        maxValue: 80,
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

    // Per-branch bandpass filter coefficients per exciter path
    this.bpN_b0 = new Float32Array(MAX_BRANCHES);
    this.bpN_b1 = new Float32Array(MAX_BRANCHES);
    this.bpN_b2 = new Float32Array(MAX_BRANCHES);
    this.bpN_a1 = new Float32Array(MAX_BRANCHES);
    this.bpN_a2 = new Float32Array(MAX_BRANCHES);
    this.bpR_b0 = new Float32Array(MAX_BRANCHES);
    this.bpR_b1 = new Float32Array(MAX_BRANCHES);
    this.bpR_b2 = new Float32Array(MAX_BRANCHES);
    this.bpR_a1 = new Float32Array(MAX_BRANCHES);
    this.bpR_a2 = new Float32Array(MAX_BRANCHES);
    // Separate state delay lines per exciter path (Noise vs Rain)
    this.bpN_x1 = new Float32Array(MAX_BRANCHES);
    this.bpN_x2 = new Float32Array(MAX_BRANCHES);
    this.bpN_y1 = new Float32Array(MAX_BRANCHES);
    this.bpN_y2 = new Float32Array(MAX_BRANCHES);
    this.bpR_x1 = new Float32Array(MAX_BRANCHES);
    this.bpR_x2 = new Float32Array(MAX_BRANCHES);
    this.bpR_y1 = new Float32Array(MAX_BRANCHES);
    this.bpR_y2 = new Float32Array(MAX_BRANCHES);

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

    // 2-pole (biquad) low-pass for exciter shaping (shared for all branches)
    this.ex_b0 = 1; this.ex_b1 = 0; this.ex_b2 = 0;
    this.ex_a1 = 0; this.ex_a2 = 0;
    this.ex_x1 = 0; this.ex_x2 = 0; this.ex_y1 = 0; this.ex_y2 = 0;

    // 1st-order high-pass for exciter (pre-LP) to remove lows
    this.hpf_x1 = 0; this.hpf_y1 = 0;
    this.hpf_a = 0; // alpha computed per block

    // Raindrop state
    this.rainEnv = new Float32Array(MAX_BRANCHES); // per-branch short env
    this.MAX_LIMBS = 16;
    // Per-limb next trigger in samples (sample & hold style inter-arrival)
    this.rainNextSamples = new Int32Array(this.MAX_LIMBS);
    // Seed next trigger intervals with an exponential draw using a nominal rate
    for (let li = 0; li < this.MAX_LIMBS; li += 1) {
      this.rainNextSamples[li] = 1; // initialize to trigger soon; will be resampled on first process block
    }

    // LFO and noise shaping state
    this.lfoPhase = 0;
    this.lfoSH = 0; // sample & hold value
    this.prevWhite = 0; // for blue/violet style diff
    this.brown = 0; // integrator state for brown noise
    this.pk_b0 = 0; // Paul Kellet pink noise filter states
    this.pk_b1 = 0;
    this.pk_b2 = 0;

    // Per-exciter-path resonator states (Noise path)
    this.twoN_y1 = new Float32Array(MAX_BRANCHES);
    this.twoN_y2 = new Float32Array(MAX_BRANCHES);
    this.cN_ry1 = new Float32Array(MAX_BRANCHES);
    this.cN_iy1 = new Float32Array(MAX_BRANCHES);
    // Per-exciter-path resonator states (Rain path)
    this.twoR_y1 = new Float32Array(MAX_BRANCHES);
    this.twoR_y2 = new Float32Array(MAX_BRANCHES);
    this.cR_ry1 = new Float32Array(MAX_BRANCHES);
    this.cR_iy1 = new Float32Array(MAX_BRANCHES);

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
      // Initialize bandpass at default center with default Q per path
      this.recomputeBandpassCoefficientsNoise(i, 440, 25);
      this.recomputeBandpassCoefficientsRain(i, 440, 25);
      // Initialize per-path states to zero
      this.twoN_y1[i] = 0; this.twoN_y2[i] = 0; this.cN_ry1[i] = 0; this.cN_iy1[i] = 0;
      this.twoR_y1[i] = 0; this.twoR_y2[i] = 0; this.cR_ry1[i] = 0; this.cR_iy1[i] = 0;
      this.bpN_x1[i] = 0; this.bpN_x2[i] = 0; this.bpN_y1[i] = 0; this.bpN_y2[i] = 0;
      this.bpR_x1[i] = 0; this.bpR_x2[i] = 0; this.bpR_y1[i] = 0; this.bpR_y2[i] = 0;
    }

    // Lightweight PRNG state (xorshift32). Seeded deterministically.
    // Using a fixed non-zero seed avoids per-sample Math.random() cost.
    this.rngState = (0x9E3779B9 ^ (sr | 0)) >>> 0;

    // Cache previous band Q per path to force recompute on change
    this.prevBandQNoise = 25;
    this.prevBandQRain = 25;

    // Current scale state
    this.scaleConfig = { name: 'off', root: 'A' };
    this.scalePitchClasses = null; // array of allowed semitone classes [0..11]

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
      } else if (data.type === 'setScale') {
        const name = (data.name || 'off');
        const root = (data.root || 'A');
        this.scaleConfig = { name, root };
        this.scalePitchClasses = this.computePitchClasses(name, root);
      }
    };
  }

  // --- Fast PRNG helpers (xorshift32) ---
  nextRand() {
    // Returns float in [0,1)
    let x = this.rngState | 0;
    x ^= (x << 13);
    x ^= (x >>> 17);
    x ^= (x << 5);
    this.rngState = x >>> 0;
    return (this.rngState) * 2.3283064365386963e-10; // 1/2^32
  }

  nextSigned() {
    // Returns float in [-1, 1]
    return this.nextRand() * 2 - 1;
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

  recomputeBandpassCoefficientsNoise(index, centerHz, bandQ) {
    const sr = sampleRate;
    const w0 = 2 * Math.PI * Math.max(1, Math.min(sr * 0.45, centerHz)) / sr;
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const Q = Math.max(0.5, bandQ);
    const alpha = sinw0 / (2 * Q);
    // RBJ bandpass (constant skirt gain, peak gain = Q)
    let b0 = Q * alpha;
    let b1 = 0;
    let b2 = -Q * alpha;
    let a0 = 1 + alpha;
    let a1 = -2 * cosw0;
    let a2 = 1 - alpha;
    this.bpN_b0[index] = b0 / a0;
    this.bpN_b1[index] = b1 / a0;
    this.bpN_b2[index] = b2 / a0;
    this.bpN_a1[index] = a1 / a0;
    this.bpN_a2[index] = a2 / a0;
  }

  recomputeBandpassCoefficientsRain(index, centerHz, bandQ) {
    const sr = sampleRate;
    const w0 = 2 * Math.PI * Math.max(1, Math.min(sr * 0.45, centerHz)) / sr;
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const Q = Math.max(0.5, bandQ);
    const alpha = sinw0 / (2 * Q);
    // RBJ bandpass (constant skirt gain, peak gain = Q)
    let b0 = Q * alpha;
    let b1 = 0;
    let b2 = -Q * alpha;
    let a0 = 1 + alpha;
    let a1 = -2 * cosw0;
    let a2 = 1 - alpha;
    this.bpR_b0[index] = b0 / a0;
    this.bpR_b1[index] = b1 / a0;
    this.bpR_b2[index] = b2 / a0;
    this.bpR_a1[index] = a1 / a0;
    this.bpR_a2[index] = a2 / a0;
  }

  process(inputs, outputs, parameters) {
    const out0 = outputs[0];
    const out0L = out0 && out0[0];
    const out0R = out0 && out0[1];
    const out1 = outputs[1];
    const out1L = out1 && out1[0];
    const out1R = out1 && out1[1];
    // Spatialization removed: no third output bus

    const frames = out0L.length;

    const pBranches = parameters.nbranches;
    const pNoise = parameters.noiseLevel;
    const pMix = parameters.rmix;
    // dry/wet removed: always wet
    const pQuantize = parameters.quantize;
    const pFreqScale = parameters.freqScale;
    const pOctaves = parameters.octaves;
    const pFreqCenter = parameters.freqCenter;
    const pDecayScale = parameters.decayScale;
    const pExciterCut = parameters.exciterCutoff;
    const pExciterHP = parameters.exciterHP;
    const pGroupEnabled = parameters.groupEnabled;
    const pGroupSplit = parameters.groupSplit;
    const pNoiseType = parameters.noiseType;
    const pLfoEnabled = parameters.lfoEnabled;
    const pLfoRate = parameters.lfoRate;
    const pLfoDepth = parameters.lfoDepth;
    const pLfoWave = parameters.lfoWave;
    const pRainEnabled = parameters.rainEnabled;
    const pRainGain = parameters.rainGain;
    const pRainRate = parameters.rainRate;
    const pRainDurMs = parameters.rainDurMs;
    const pRainSpread = parameters.rainSpread;
    const pRainCenter = parameters.rainCenter;
    const pRainLimbs = parameters.rainLimbs;
    const pMonitorExciter = parameters.monitorExciter;
    const pExciterBandQNoise = parameters.exciterBandQNoise;
    const pExciterBandQRain = parameters.exciterBandQRain;

    const freqScale = pFreqScale.length === 1 ? pFreqScale[0] : pFreqScale[0];
    const freqCenter = pFreqCenter.length === 1 ? pFreqCenter[0] : pFreqCenter[0];
    const decayScale = pDecayScale.length === 1 ? pDecayScale[0] : pDecayScale[0];

    const nBranches = clamp(pBranches[0] | 0, 0, MAX_BRANCHES);

    // Bandpass Q per exciter path for per-branch exciter filters
    const bandQNoise = pExciterBandQNoise && (pExciterBandQNoise.length === 1 ? pExciterBandQNoise[0] : pExciterBandQNoise[0]) || 25;
    const bandQRain = pExciterBandQRain && (pExciterBandQRain.length === 1 ? pExciterBandQRain[0] : pExciterBandQRain[0]) || 25;
    const bandQNoiseClamped = Math.max(0.5, Math.min(80, bandQNoise));
    const bandQRainClamped = Math.max(0.5, Math.min(80, bandQRain));
    const bandQNoiseChanged = Math.abs(bandQNoiseClamped - this.prevBandQNoise) > 1e-6;
    const bandQRainChanged = Math.abs(bandQRainClamped - this.prevBandQRain) > 1e-6;

    // Compute exciter biquad LPF coefficients once per block (Butterworth, Q≈0.7071)
    const cut = pExciterCut && (pExciterCut.length === 1 ? pExciterCut[0] : pExciterCut[0]);
    const fc = Math.max(20, Math.min(20000, cut || 4000));
    const w0 = 2 * Math.PI * fc / sampleRate;
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const Q = 0.70710678;
    const alpha = sinw0 / (2 * Q);
    let b0 = (1 - cosw0) / 2;
    let b1 = 1 - cosw0;
    let b2 = (1 - cosw0) / 2;
    let a0 = 1 + alpha;
    let a1 = -2 * cosw0;
    let a2 = 1 - alpha;
    // normalize
    this.ex_b0 = b0 / a0;
    this.ex_b1 = b1 / a0;
    this.ex_b2 = b2 / a0;
    this.ex_a1 = a1 / a0;
    this.ex_a2 = a2 / a0;

    // Compute first-order HPF coefficient alpha from cutoff
    const hpc = pExciterHP && (pExciterHP.length === 1 ? pExciterHP[0] : pExciterHP[0]);
    const fhp = Math.max(10, Math.min(2000, hpc || 50));
    const RC = 1 / (2 * Math.PI * fhp);
    const dt = 1 / sampleRate;
    this.hpf_a = RC / (RC + dt);

    // Read k-rate parameters once per block
    const lfoEnabledBlock = pLfoEnabled && (pLfoEnabled.length === 1 ? pLfoEnabled[0] : pLfoEnabled[0]) >= 0.5;
    const lfoRateBlock = Math.max(0.1, pLfoRate && (pLfoRate.length === 1 ? pLfoRate[0] : pLfoRate[0]) || 2);
    const lfoDepthBlock = Math.max(0, Math.min(1, pLfoDepth && (pLfoDepth.length === 1 ? pLfoDepth[0] : pLfoDepth[0]) || 0.5));
    const lfoWaveBlock = pLfoWave && (pLfoWave.length === 1 ? pLfoWave[0] : pLfoWave[0]) | 0;

    const rainEnabledBlock = pRainEnabled && (pRainEnabled.length === 1 ? pRainEnabled[0] : pRainEnabled[0]) >= 0.5;
    const groupEnabledBlock = pGroupEnabled && (pGroupEnabled.length === 1 ? pGroupEnabled[0] : pGroupEnabled[0]) >= 0.5;
    const rawSplit = (pGroupSplit && (pGroupSplit.length === 1 ? pGroupSplit[0] : pGroupSplit[0]));
    const groupSplitCount = Math.max(0, Math.min(MAX_BRANCHES, Math.round(rawSplit === undefined ? 0 : rawSplit))) | 0;
    const monitorExciterBlock = pMonitorExciter && (pMonitorExciter.length === 1 ? pMonitorExciter[0] : pMonitorExciter[0]) >= 0.5;

    for (let i = 0; i < frames; i += 1) {
      const noiseLevel = pNoise.length > 1 ? pNoise[i] : pNoise[0];

      // LFO amplitude modulation for exciter input level (compute only if enabled)
      let lfoAmp = 1;
      if (lfoEnabledBlock) {
        this.lfoPhase += lfoRateBlock / sampleRate;
        if (this.lfoPhase >= 1) {
          this.lfoPhase -= 1;
          if (lfoWaveBlock === 3) {
            // sample & hold: new random value on each cycle
            this.lfoSH = this.nextSigned();
          }
        }
        let lfoVal;
        switch (lfoWaveBlock) {
          default: // sine
            lfoVal = Math.sin(this.lfoPhase * 2 * Math.PI);
            break;
          case 1: { // triangle in [-1,1]
            const p = this.lfoPhase;
            lfoVal = 4 * Math.abs(p - Math.round(p)) - 1; // saw-tri trick
            break;
          }
          case 2: // square
            lfoVal = (this.lfoPhase < 0.5) ? 1 : -1;
            break;
          case 3: // sample & hold
            lfoVal = this.lfoSH;
            break;
        }
        lfoAmp = ((1 - lfoDepthBlock) + lfoDepthBlock * ((lfoVal + 1) * 0.5));
      }

      // Base white noise sample scaled by effective amplitude
      const baseWhite = (this.nextSigned()) * (noiseLevel * lfoAmp);

      // Color the noise according to noiseType
      const nType = pNoiseType && (pNoiseType.length === 1 ? pNoiseType[0] : pNoiseType[0]) | 0;
      let colored;
      if (nType === 0) {
        // Reduce white noise level so it isn't louder than other colors
        colored = baseWhite * 0.2;
      } else if (nType === 1) {
        // Pink noise via Paul Kellet approximation
        this.pk_b0 = 0.99765 * this.pk_b0 + 0.0990460 * baseWhite;
        this.pk_b1 = 0.96300 * this.pk_b1 + 0.2965164 * baseWhite;
        this.pk_b2 = 0.57000 * this.pk_b2 + 1.0526913 * baseWhite;
        colored = this.pk_b0 + this.pk_b1 + this.pk_b2 + 0.1848 * baseWhite;
        colored *= 0.05; // roughly normalize
      } else if (nType === 2) {
        // Brown (integrated) noise with slight damping
        this.brown = (this.brown + baseWhite * 0.02) * 0.998;
        // clamp to avoid runaway
        if (this.brown > 1) this.brown = 1;
        else if (this.brown < -1) this.brown = -1;
        colored = this.brown;
      } else if (nType === 3) {
        // Blue-ish noise via simple differentiator
        const diff = baseWhite - this.prevWhite;
        this.prevWhite = baseWhite;
        colored = diff * 0.5;
      } else {
        // Fallback to reduced white level
        colored = baseWhite * 0.2;
      }

      // First, high-pass to remove lows
      const hp = this.hpf_a * (this.hpf_y1 + colored - this.hpf_x1);
      this.hpf_x1 = colored; this.hpf_y1 = hp;
      // Then biquad LP filter the exciter noise (mono)
      let exciterNoise = this.ex_b0 * hp + this.ex_b1 * this.ex_x1 + this.ex_b2 * this.ex_x2 - this.ex_a1 * this.ex_y1 - this.ex_a2 * this.ex_y2;
      this.ex_x2 = this.ex_x1; this.ex_x1 = hp;
      this.ex_y2 = this.ex_y1; this.ex_y1 = exciterNoise;

      // Raindrop updates (per sample)
      // Read current rainRate once per sample (k-rate param so typically constant across block)
      const rainRate = Math.max(0.1, pRainRate && (pRainRate.length === 1 ? pRainRate[0] : pRainRate[0]) || 6);
      const rainDurMs = Math.max(1, pRainDurMs && (pRainDurMs.length === 1 ? pRainDurMs[0] : pRainDurMs[0]) || 8);
      const rainGain = Math.max(0, pRainGain && (pRainGain.length === 1 ? pRainGain[0] : pRainGain[0]) || 0.3);
      const rainSpread = Math.max(0, Math.min(1, pRainSpread && (pRainSpread.length === 1 ? pRainSpread[0] : pRainSpread[0]) || 0.4));
      const rainCenter = Math.max(0, Math.min(1, pRainCenter && (pRainCenter.length === 1 ? pRainCenter[0] : pRainCenter[0]) || 0.5));
      const limbs = Math.max(1, Math.min(10, pRainLimbs && (pRainLimbs.length === 1 ? pRainLimbs[0] : pRainLimbs[0]) || 5)) | 0;

      // per-sample decay coefficient for rain envelopes
      const rainDecay = Math.exp(-1 / Math.max(1, (rainDurMs * 0.001) * sampleRate));
      // trigger per active limb using Poisson process (sample & hold inter-arrival)
      if (rainEnabledBlock && limbs > 0 && nBranches > 0) {
        for (let li = 0; li < limbs; li += 1) {
          // Count down to next trigger in samples
          let next = this.rainNextSamples[li] | 0;
          if (next <= 0) {
            // choose branch by gaussian around center
            const centerIdx = Math.round(rainCenter * (nBranches - 1));
            const sigma = Math.max(0.5, rainSpread * (nBranches - 1) * 0.5);
            const u1 = this.nextRand() || 1e-10; // Box-Muller
            const u2 = this.nextRand();
            const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); // N(0,1)
            let idx = Math.round(centerIdx + sigma * z);
            if (idx < 0) idx = 0; else if (idx >= nBranches) idx = nBranches - 1;
            // If grouping is enabled, only apply raindrops to group 2 branches
            if (groupEnabledBlock) {
              const splitIdx = Math.max(0, Math.min(nBranches, groupSplitCount));
              if (idx < splitIdx) {
                // redirect to nearest group 2 index
                idx = splitIdx + ((idx % Math.max(1, nBranches - splitIdx)));
                if (idx >= nBranches) idx = nBranches - 1;
              }
            }
            // add a small amplitude impulse to envelope
            const amp = 1;
            this.rainEnv[idx] += amp;
            // Resample next inter-arrival from exponential distribution with mean 1/rainRate
            const u = this.nextRand() || 1e-12;
            const intervalSec = -Math.log(u) / rainRate;
            const samples = Math.max(1, Math.round(intervalSec * sampleRate));
            this.rainNextSamples[li] = samples;
          } else {
            this.rainNextSamples[li] = next - 1;
          }
        }
      }
      // decay all envelopes slightly (cheap: subset per sample)
      for (let di = 0; di < nBranches; di += 1) {
        this.rainEnv[di] *= rainDecay;
      }
      const rmixTarget = pMix.length > 1 ? pMix[i] : pMix[0];
      // smooth global rmix
      this.smoothMix = smoothToward(this.smoothMix, rmixTarget, this.alphaMix);

      // Accumulators per output bus
      let l0 = 0; // Noise-excited stereo bus L
      let r0 = 0; // Noise-excited stereo bus R
      let l1 = 0; // Rain-excited stereo bus L
      let r1 = 0; // Rain-excited stereo bus R
      // Five rain mono stems (pre-pan, even branch distribution)
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
      let monSum0 = 0;
      let monSum1 = 0;

      const splitIdxBlock = groupEnabledBlock ? Math.max(0, Math.min(nBranches, groupSplitCount)) : 0;
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

        // Update pan gains only when smoothed pan meaningfully changes (checked sparsely)
        if ((i & 7) === 0) {
          if (!this._prevPanForGains) this._prevPanForGains = new Float32Array(MAX_BRANCHES);
          const prev = this._prevPanForGains[b];
          if (Math.abs(panNow - prev) > 1e-3) {
            this._prevPanForGains[b] = panNow;
            this.updatePanGains(b);
          }
        }

        // Effective global-scaling adjusted params
        // Octave transpose factor 2^oct
        const oct = pOctaves && (pOctaves.length === 1 ? pOctaves[0] : pOctaves[0]);
        const octMul = Math.pow(2, oct || 0);
        let effFreq = clamp(freqHz * freqScale * octMul + freqCenter, 25, sampleRate * 0.45);
        const doQuant = pQuantize && (pQuantize.length === 1 ? pQuantize[0] : pQuantize[0]);
        if (doQuant >= 0.5) {
          const pcs = this.scalePitchClasses;
          if (!pcs || pcs.length === 0) {
            effFreq = quantize12TET(effFreq);
          } else {
            effFreq = this.quantizeToScale(effFreq, pcs);
          }
        }
        const effDecay = Math.max(1, this.branchDecayMs[b] * decayScale);

        // Update coefficients if effective params changed notably
        const freqChanged = Math.abs(effFreq - this.cachedEffFreq[b]) > 0.1;
        const decayChanged = Math.abs(effDecay - this.cachedEffDecay[b]) > 0.1;
        if (freqChanged || decayChanged) {
          this.cachedEffFreq[b] = effFreq;
          this.cachedEffDecay[b] = effDecay;
          this.recomputeCoefficients(b, effFreq, effDecay);
        }

        // Recompute bandpass per path if needed (on freq or path-specific Q change)
        if (freqChanged || bandQNoiseChanged) {
          this.recomputeBandpassCoefficientsNoise(b, effFreq, bandQNoiseClamped);
        }
        if (freqChanged || bandQRainChanged) {
          this.recomputeBandpassCoefficientsRain(b, effFreq, bandQRainClamped);
        }

        // Exciter -> filtered noise
        // Per-branch bandpass around the branch frequency
        const rainInput = rainGain * this.rainEnv[b];
        let noiseIn = exciterNoise;
        let rainIn = rainInput;
        if (groupEnabledBlock) {
          const inGroup1 = (b < splitIdxBlock);
          noiseIn = inGroup1 ? exciterNoise : 0;
          rainIn = inGroup1 ? 0 : rainInput;
        }

        // Bandpass each path separately (shared coefficients, separate delay lines)
        const xbpN = this.bpN_b0[b] * noiseIn + this.bpN_b1[b] * this.bpN_x1[b] + this.bpN_b2[b] * this.bpN_x2[b]
          - this.bpN_a1[b] * this.bpN_y1[b] - this.bpN_a2[b] * this.bpN_y2[b];
        this.bpN_x2[b] = this.bpN_x1[b];
        this.bpN_x1[b] = noiseIn;
        this.bpN_y2[b] = this.bpN_y1[b];
        this.bpN_y1[b] = xbpN;

        const xbpR = this.bpR_b0[b] * rainIn + this.bpR_b1[b] * this.bpR_x1[b] + this.bpR_b2[b] * this.bpR_x2[b]
          - this.bpR_a1[b] * this.bpR_y1[b] - this.bpR_a2[b] * this.bpR_y2[b];
        this.bpR_x2[b] = this.bpR_x1[b];
        this.bpR_x1[b] = rainIn;
        this.bpR_y2[b] = this.bpR_y1[b];
        this.bpR_y1[b] = xbpR;

        // 2-pole real resonator (noise path)
        const yN = this.two_a[b] * xbpN + this.two_b[b] * this.twoN_y1[b] + this.two_c[b] * this.twoN_y2[b];
        this.twoN_y2[b] = this.twoN_y1[b];
        this.twoN_y1[b] = clamp(yN, -1, 1);
        // Complex 1-pole (noise path)
        const rN = xbpN * 0.02 + this.c_rcos[b] * this.cN_ry1[b] - this.c_rsin[b] * this.cN_iy1[b];
        const iN = this.c_rsin[b] * this.cN_ry1[b] + this.c_rcos[b] * this.cN_iy1[b];
        this.cN_ry1[b] = clamp(rN, -1, 1);
        this.cN_iy1[b] = clamp(iN, -1, 1);
        const sumN = (1 - this.smoothMix) * this.twoN_y1[b] + this.smoothMix * this.cN_ry1[b];

        // 2-pole real resonator (rain path)
        const yR = this.two_a[b] * xbpR + this.two_b[b] * this.twoR_y1[b] + this.two_c[b] * this.twoR_y2[b];
        this.twoR_y2[b] = this.twoR_y1[b];
        this.twoR_y1[b] = clamp(yR, -1, 1);
        // Complex 1-pole (rain path)
        const rR = xbpR * 0.02 + this.c_rcos[b] * this.cR_ry1[b] - this.c_rsin[b] * this.cR_iy1[b];
        const iR = this.c_rsin[b] * this.cR_ry1[b] + this.c_rcos[b] * this.cR_iy1[b];
        this.cR_ry1[b] = clamp(rR, -1, 1);
        this.cR_iy1[b] = clamp(iR, -1, 1);
        const sumR = (1 - this.smoothMix) * this.twoR_y1[b] + this.smoothMix * this.cR_ry1[b];

        // Gain and pan per path (stereo sums)
        const vN = sumN * amp;
        l0 += vN * this.leftPanGain[b];
        r0 += vN * this.rightPanGain[b];
        const vR = sumR * amp;
        l1 += vR * this.leftPanGain[b];
        r1 += vR * this.rightPanGain[b];

        // Also accumulate mono rain stems: assign branch evenly to 5 buses
        // Use branch index modulo 5 for distribution, sum pre-pan for mono buses
        const stemVal = sumR * amp;
        switch (b % 5) {
          case 0: s0 += stemVal; break;
          case 1: s1 += stemVal; break;
          case 2: s2 += stemVal; break;
          case 3: s3 += stemVal; break;
          case 4: s4 += stemVal; break;
        }

        // Spatialization removed: no per-branch taps

        // For monitoring: sum the per-branch bandpassed exciter per path
        monSum0 += xbpN;
        monSum1 += xbpR;
      }

      // Monitor exciter only (post filter/gate), else wet-only resonator sum
      if (monitorExciterBlock) {
        const denom = nBranches > 0 ? nBranches : 1;
        const m0 = monSum0 / denom;
        const m1 = monSum1 / denom;
        if (out0L) { out0L[i] = m0; out0R[i] = m0; }
        if (out1L) { out1L[i] = m1; out1R[i] = m1; }
      } else {
        // Wet level per path
        if (out0L) { out0L[i] = l0; out0R[i] = r0; }
        if (out1L) { out1L[i] = l1; out1R[i] = r1; }
        // Write rain stems to output 2 channels 0..4 if present
        const out2 = outputs[2];
        if (out2 && out2.length >= 5) {
          out2[0][i] = s0;
          out2[1][i] = s1;
          out2[2][i] = s2;
          out2[3][i] = s3;
          out2[4][i] = s4;
        }
      }
    }

    // Update cached band Qs after processing block
    if (bandQNoiseChanged) this.prevBandQNoise = bandQNoiseClamped;
    if (bandQRainChanged) this.prevBandQRain = bandQRainClamped;

    return true;
  }

  // ---- Scale helpers ----
  noteNameToClass(name) {
    // Map C..B with sharps only
    const map = {
      'C': 0, 'C#': 1, 'Db': 1,
      'D': 2, 'D#': 3, 'Eb': 3,
      'E': 4, 'Fb': 4, 'E#': 5, // tolerate enharmonics
      'F': 5, 'F#': 6, 'Gb': 6,
      'G': 7, 'G#': 8, 'Ab': 8,
      'A': 9, 'A#': 10, 'Bb': 10,
      'B': 11, 'Cb': 11, 'B#': 0
    };
    return map[name] != null ? map[name] : 9; // default A
  }

  computePitchClasses(scaleName, rootName) {
    if (!scaleName || scaleName === 'off') return null;
    const root = this.noteNameToClass(rootName || 'A');
    // Define scale intervals in semitones from root
    const scales = {
      chromatic: [0,1,2,3,4,5,6,7,8,9,10,11],
      major: [0,2,4,5,7,9,11],
      minor: [0,2,3,5,7,8,10], // natural minor
      harmonicMinor: [0,2,3,5,7,8,11],
      melodicMinor: [0,2,3,5,7,9,11], // ascending
      dorian: [0,2,3,5,7,9,10],
      phrygian: [0,1,3,5,7,8,10],
      lydian: [0,2,4,6,7,9,11],
      mixolydian: [0,2,4,5,7,9,10],
      locrian: [0,1,3,5,6,8,10],
      pentatonicMajor: [0,2,4,7,9],
      pentatonicMinor: [0,3,5,7,10],
      blues: [0,3,5,6,7,10],
      wholeTone: [0,2,4,6,8,10],
      octatonic12: [0,1,3,4,6,7,9,10], // H-W
      octatonic21: [0,2,3,5,6,8,9,11]  // W-H
    };
    const base = scales[scaleName] || null;
    if (!base) return null;
    const pcs = base.map(iv => (root + iv) % 12);
    // ensure uniqueness and sorted
    const uniq = Array.from(new Set(pcs)).sort((a,b) => a - b);
    return uniq;
  }

  quantizeToScale(freqHz, pitchClasses) {
    if (!(freqHz > 0)) return 0;
    // Convert to MIDI, then to nearest pitch class over all octaves
    const midi = 69 + 12 * Math.log2(freqHz / 440);
    const roundMidi = Math.round(midi);
    const pc = ((roundMidi % 12) + 12) % 12;
    // If already on allowed pc, return 12-TET rounded
    if (pitchClasses.indexOf(pc) !== -1) {
      return 440 * Math.pow(2, (roundMidi - 69) / 12);
    }
    // Search nearest allowed pitch in semitone distance
    let bestMidi = roundMidi;
    let bestDist = Infinity;
    for (let d = 0; d <= 12; d += 1) {
      const up = roundMidi + d;
      const down = roundMidi - d;
      const upPc = ((up % 12) + 12) % 12;
      const downPc = ((down % 12) + 12) % 12;
      if (pitchClasses.indexOf(upPc) !== -1) {
        bestMidi = up; bestDist = d; break;
      }
      if (pitchClasses.indexOf(downPc) !== -1) {
        bestMidi = down; bestDist = d; break;
      }
    }
    return 440 * Math.pow(2, (bestMidi - 69) / 12);
  }
}

registerProcessor('resonator-processor', ResonatorProcessor);


