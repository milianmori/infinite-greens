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
        name: 'rmix',
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: 'a-rate'
      },
      {
        name: 'dryWet',
        defaultValue: 1,
        minValue: 0,
        maxValue: 1,
        automationRate: 'a-rate'
      },
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
        name: 'exciterBurst',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      },
      {
        name: 'burstRate',
        defaultValue: 4,
        minValue: 0.1,
        maxValue: 40,
        automationRate: 'k-rate'
      },
      {
        name: 'burstDurMs',
        defaultValue: 12,
        minValue: 1,
        maxValue: 200,
        automationRate: 'k-rate'
      },
      {
        name: 'exciterMode', // 0=noise, 1=burst-noise, 2=impulse
        defaultValue: 0,
        minValue: 0,
        maxValue: 2,
        automationRate: 'k-rate'
      },
      {
        name: 'impulseGain',
        defaultValue: 0.3,
        minValue: 0,
        maxValue: 1,
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
        name: 'exciterBandQ',
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

    // Per-branch bandpass filter for exciter shaping around each mode
    this.bp_b0 = new Float32Array(MAX_BRANCHES);
    this.bp_b1 = new Float32Array(MAX_BRANCHES);
    this.bp_b2 = new Float32Array(MAX_BRANCHES);
    this.bp_a1 = new Float32Array(MAX_BRANCHES);
    this.bp_a2 = new Float32Array(MAX_BRANCHES);
    this.bp_x1 = new Float32Array(MAX_BRANCHES);
    this.bp_x2 = new Float32Array(MAX_BRANCHES);
    this.bp_y1 = new Float32Array(MAX_BRANCHES);
    this.bp_y2 = new Float32Array(MAX_BRANCHES);

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

    // Burst exciter state
    this.burstPhase = 0; // cycles 0..1 at burstRate
    this.burstOnSamples = 0; // current on-window remaining
    this.burstEnv = 0; // simple AR env for clicks

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
      // Initialize bandpass at default center with default Q
      this.recomputeBandpassCoefficients(i, 440, 25);
    }

    // Cache previous band Q to force recompute on change
    this.prevBandQ = 25;

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

  recomputeBandpassCoefficients(index, centerHz, bandQ) {
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
    this.bp_b0[index] = b0 / a0;
    this.bp_b1[index] = b1 / a0;
    this.bp_b2[index] = b2 / a0;
    this.bp_a1[index] = a1 / a0;
    this.bp_a2[index] = a2 / a0;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const outL = output[0];
    const outR = output[1];

    const frames = outL.length;

    const pBranches = parameters.nbranches;
    const pNoise = parameters.noiseLevel;
    const pMix = parameters.rmix;
    const pDryWet = parameters.dryWet;
    const pQuantize = parameters.quantize;
    const pFreqScale = parameters.freqScale;
    const pOctaves = parameters.octaves;
    const pFreqCenter = parameters.freqCenter;
    const pDecayScale = parameters.decayScale;
    const pExciterCut = parameters.exciterCutoff;
    const pExciterHP = parameters.exciterHP;
    const pExciterBurst = parameters.exciterBurst;
    const pBurstRate = parameters.burstRate;
    const pBurstDurMs = parameters.burstDurMs;
    const pExciterMode = parameters.exciterMode;
    const pImpulseGain = parameters.impulseGain;
    const pMonitorExciter = parameters.monitorExciter;
    const pExciterBandQ = parameters.exciterBandQ;

    const freqScale = pFreqScale.length === 1 ? pFreqScale[0] : pFreqScale[0];
    const freqCenter = pFreqCenter.length === 1 ? pFreqCenter[0] : pFreqCenter[0];
    const decayScale = pDecayScale.length === 1 ? pDecayScale[0] : pDecayScale[0];

    const nBranches = clamp(pBranches[0] | 0, 0, MAX_BRANCHES);

    // Bandpass Q for per-branch exciter filters
    const bandQ = pExciterBandQ && (pExciterBandQ.length === 1 ? pExciterBandQ[0] : pExciterBandQ[0]) || 25;
    const bandQClamped = Math.max(0.5, Math.min(80, bandQ));
    const bandQChanged = Math.abs(bandQClamped - this.prevBandQ) > 1e-6;

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

    for (let i = 0; i < frames; i += 1) {
      const noiseLevel = pNoise.length > 1 ? pNoise[i] : pNoise[0];
      const mode = pExciterMode && (pExciterMode.length === 1 ? pExciterMode[0] : pExciterMode[0]);
      const white = (Math.random() * 2 - 1) * noiseLevel;
      // First, high-pass to remove lows
      const hp = this.hpf_a * (this.hpf_y1 + white - this.hpf_x1);
      this.hpf_x1 = white; this.hpf_y1 = hp;
      // Then biquad LP filter the exciter noise (mono)
      let exciter = this.ex_b0 * hp + this.ex_b1 * this.ex_x1 + this.ex_b2 * this.ex_x2 - this.ex_a1 * this.ex_y1 - this.ex_a2 * this.ex_y2;
      this.ex_x2 = this.ex_x1; this.ex_x1 = hp;
      this.ex_y2 = this.ex_y1; this.ex_y1 = exciter;
      // Burst gating
      let gated = exciter;
      const doBurst = (mode >= 1) || (pExciterBurst && (pExciterBurst.length === 1 ? pExciterBurst[0] : pExciterBurst[0]) >= 0.5);
      if (doBurst && mode !== 2) {
        const rate = Math.max(0.1, pBurstRate && (pBurstRate.length === 1 ? pBurstRate[0] : pBurstRate[0]) || 4);
        const durMs = Math.max(1, pBurstDurMs && (pBurstDurMs.length === 1 ? pBurstDurMs[0] : pBurstDurMs[0]) || 12);
        const durSamples = (durMs * 0.001) * sampleRate;
        // advance phase
        this.burstPhase += rate / sampleRate;
        if (this.burstPhase >= 1) {
          this.burstPhase -= 1;
          this.burstOnSamples = durSamples;
        }
        // AR envelope for clicks
        const attack = 0.0005 * sampleRate; // 0.5ms
        const release = 0.002 * sampleRate; // 2ms
        if (this.burstOnSamples > 0) {
          this.burstEnv += (1 - this.burstEnv) * (1 / Math.max(1, attack));
          this.burstOnSamples -= 1;
        } else {
          this.burstEnv += (0 - this.burstEnv) * (1 / Math.max(1, release));
        }
        gated = exciter * this.burstEnv;
      } else if (mode === 2) {
        // Impulse excitation at burst rate
        const rate = Math.max(0.1, pBurstRate && (pBurstRate.length === 1 ? pBurstRate[0] : pBurstRate[0]) || 4);
        const impulseGain = pImpulseGain && (pImpulseGain.length === 1 ? pImpulseGain[0] : pImpulseGain[0]) || 0.3;
        this.burstPhase += rate / sampleRate;
        if (this.burstPhase >= 1) {
          this.burstPhase -= 1;
          gated = impulseGain; // single-sample impulse
        } else {
          gated = 0;
        }
      }
      const rmixTarget = pMix.length > 1 ? pMix[i] : pMix[0];
      const dryWet = pDryWet && pDryWet.length > 1 ? pDryWet[i] : (pDryWet ? pDryWet[0] : 1);
      // smooth global rmix
      this.smoothMix = smoothToward(this.smoothMix, rmixTarget, this.alphaMix);

      let l = 0;
      let r = 0;
      let monSum = 0;

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

        // Recompute bandpass if needed (on freq or Q change)
        if (freqChanged || bandQChanged) {
          this.recomputeBandpassCoefficients(b, effFreq, bandQClamped);
        }

        // Exciter -> filtered noise
        // Per-branch bandpass around the branch frequency
        const xbp = this.bp_b0[b] * gated + this.bp_b1[b] * this.bp_x1[b] + this.bp_b2[b] * this.bp_x2[b]
          - this.bp_a1[b] * this.bp_y1[b] - this.bp_a2[b] * this.bp_y2[b];
        this.bp_x2[b] = this.bp_x1[b];
        this.bp_x1[b] = gated;
        this.bp_y2[b] = this.bp_y1[b];
        this.bp_y1[b] = xbp;

        // 2-pole real resonator
        const y = this.two_a[b] * xbp + this.two_b[b] * this.two_y1[b] + this.two_c[b] * this.two_y2[b];
        this.two_y2[b] = this.two_y1[b];
        this.two_y1[b] = clamp(y, -1, 1);

        // Complex 1-pole resonator
        const ry = xbp * 0.02 + this.c_rcos[b] * this.c_ry1[b] - this.c_rsin[b] * this.c_iy1[b];
        const iy = this.c_rsin[b] * this.c_ry1[b] + this.c_rcos[b] * this.c_iy1[b];
        this.c_ry1[b] = clamp(ry, -1, 1);
        this.c_iy1[b] = clamp(iy, -1, 1);

        // Crossfade by rmix (smoothed)
        const sum = (1 - this.smoothMix) * this.two_y1[b] + this.smoothMix * this.c_ry1[b];

        // Gain and pan (equal-power)
        const v = sum * amp;
        l += v * this.leftPanGain[b];
        r += v * this.rightPanGain[b];

        // For monitoring: sum the per-branch bandpassed exciter
        monSum += xbp;
      }

      // Monitor exciter only (post filter/gate), else wet-only resonator sum
      const mon = pMonitorExciter && (pMonitorExciter.length === 1 ? pMonitorExciter[0] : pMonitorExciter[0]) >= 0.5;
      if (mon) {
        const denom = nBranches > 0 ? nBranches : 1;
        const m = monSum / denom;
        outL[i] = m;
        outR[i] = m;
      } else {
        // Wet level only (no dry noise in output). 0 = silent, 1 = full resonator
        outL[i] = dryWet * l;
        outR[i] = dryWet * r;
      }
    }

    // Update cached band Q after processing block
    if (bandQChanged) this.prevBandQ = bandQClamped;

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


