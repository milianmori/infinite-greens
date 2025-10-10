// SpatialNode: wraps the spatial-processor worklet, 7 PannerNodes, and routing
// Expects existing context and ResonatorNode from main app

export class SpatialNode {
  static async create(context, resonatorNode, destination) {
    try {
      await context.audioWorklet.addModule('spatial-processor.js');
    } catch (_) {}
    return new SpatialNode(context, resonatorNode, destination);
  }

  constructor(context, resonatorNode, destination) {
    this.context = context;
    this.resNode = resonatorNode;
    this.destination = destination; // typically masterOut

    this.enabled = false;
    this.bypass = false;

    this.params = {
      refDistance: 1,
      rolloffFactor: 1,
      maxDistance: 10,
      coneInner: 360,
      coneOuter: 360,
      coneOuterGain: 0
    };

    // Default sources state
    this.sources = new Array(7).fill(null).map((_, i) => ({
      x: (i - 3) * 0.5,
      y: 0,
      z: -2 - 0.2 * i,
      gain: (i === 5 || i === 6) ? 0.3 : 1,
      solo: false
    }));

    // Listener pose used for distance-based reverb send (updated by UI)
    this.listener = { x: -5.22, y: -0.81, z: -7.69 };

    // Reverb parameters
    this.reverbParams = {
      wet: 0.05,
      decayTime: 1.5, // seconds
      gainDb: 0,      // make-up gain on wet bus (0..+12dB)
      hfDampHz: 6000
    };

    // Reverb exclusion per source (true => exclude from reverb send)
    this.reverbExclude = new Array(7).fill(false);

    // Per-source reverb scaling (multiplier on computed send amount)
    this.reverbScale = new Array(7).fill(1);

    this._buildGraph();
  }

  _buildGraph() {
    const ctx = this.context;
    // Worklet: 2 inputs (input 0: 5-ch rain stems, input 1: noise stereo), 1 output with 7 channels
    this.worklet = new AudioWorkletNode(ctx, 'spatial-processor', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [7],
      channelCount: 5,                 // allow up to 5 channels per input
      channelCountMode: 'clamped-max', // use connection's channel count up to 5
      channelInterpretation: 'speakers'
    });
    this.worklet.port.onmessage = (e) => {
      const data = e.data || {};
      if (data.type === 'meters' && this._meterSink) {
        try { this._meterSink(data.rms); } catch (_) {}
      }
    };

    // Channel split to 7 mono feeds
    this.splitter = ctx.createChannelSplitter(7);
    this.worklet.connect(this.splitter);

    // Per-source gain then panner, then a spatial master to destination
    this.spatialMaster = ctx.createGain();
    this.spatialMaster.gain.value = 1;
    this.spatialMaster.connect(this.destination);

    // Reverb bus (wet) after spatialized stereo mix per-source
    this._initReverbBus();

    // Per-source gain then panner
    this.sourceGains = new Array(7);
    this.panners = new Array(7);
    this.reverbSends = new Array(7);
    for (let i = 0; i < 7; i += 1) {
      const g = ctx.createGain();
      g.gain.value = this.sources[i].gain;
      this.sourceGains[i] = g;

      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = this.params.refDistance;
      p.rolloffFactor = this.params.rolloffFactor;
      p.maxDistance = this.params.maxDistance;
      p.coneInnerAngle = this.params.coneInner;
      p.coneOuterAngle = this.params.coneOuter;
      p.coneOuterGain = this.params.coneOuterGain;
      p.positionX.value = this.sources[i].x;
      p.positionY.value = this.sources[i].y;
      p.positionZ.value = this.sources[i].z;
      this.panners[i] = p;

      this.splitter.connect(g, i);
      g.connect(p);
      p.connect(this.spatialMaster);

      // Per-source reverb send (post-panner to preserve spatial cues)
      const send = ctx.createGain();
      send.gain.value = 0; // computed from distance
      this.reverbSends[i] = send;
      p.connect(send);
      send.connect(this._reverb.pre);
    }

    // Keep reference to original direct routes to allow bypass
    this._directNoiseToDest = null;
    this._directRainToDest = null;

    // Attach meters callback holder
    this._meterSink = null;

    // Default: enabled graph but not yet wired inputs
    this.enabled = true;

    // Hook inputs from ResonatorNode outputs
    // output 2 (index 2): 5-ch rain stems -> input 0 (expects 5 channels)
    // output 0 (index 0): noise stereo -> input 1 (expects 2 channels)
    try {
      this.resNode.connect(this.worklet, 2, 0);
    } catch (_) {}
    try {
      this.resNode.connect(this.worklet, 0, 1);
    } catch (_) {}
    // Initialize sends based on current listener and sources
    try { this._updateReverbSends(); } catch (_) {}
  }

  _initReverbBus() {
    const ctx = this.context;
    const rv = {};
    // Pre-sum for all sends
    rv.pre = ctx.createGain();
    rv.pre.gain.value = 1;

    // Early reflections: a few short taps with mild LPF
    rv.erSum = ctx.createGain();
    rv.erSum.gain.value = 1;
    rv.erLPF = ctx.createBiquadFilter();
    rv.erLPF.type = 'lowpass';
    rv.erLPF.frequency.value = 8000;

    const tapTimes = [0.012, 0.021, 0.034];
    const tapGains = [0.5, 0.35, 0.25];
    rv.taps = tapTimes.map((t, idx) => {
      const d = ctx.createDelay(0.1);
      d.delayTime.value = t;
      const g = ctx.createGain();
      g.gain.value = tapGains[idx];
      // Route: pre -> LPF -> delay -> gain -> erSum
      rv.erLPF.connect(d);
      d.connect(g);
      g.connect(rv.erSum);
      return { d, g };
    });
    // Direct early energy path
    rv.erLPF.connect(rv.erSum);

    // Convolver with stereo IR
    rv.convolver = ctx.createConvolver();
    rv.convolver.normalize = false;

    // Post-tail HF damping
    rv.postLPF = ctx.createBiquadFilter();
    rv.postLPF.type = 'lowpass';
    rv.postLPF.frequency.value = this.reverbParams.hfDampHz;

    // Wet mix and output gain
    rv.wetGain = ctx.createGain();
    rv.wetGain.gain.value = this.reverbParams.wet;
    rv.outGain = ctx.createGain();
    rv.outGain.gain.value = this._dbToGain(this.reverbParams.gainDb);

    // Wiring
    // All sends go to pre -> erLPF; erSum feeds convolver
    rv.pre.connect(rv.erLPF);
    rv.erSum.connect(rv.convolver);
    rv.convolver.connect(rv.postLPF);
    rv.postLPF.connect(rv.wetGain);
    rv.wetGain.connect(rv.outGain);
    rv.outGain.connect(this.destination);

    // Generate initial IR
    rv.convolver.buffer = this._generateStereoIR(this.reverbParams.decayTime, this.reverbParams.hfDampHz);

    this._reverb = rv;
  }

  _dbToGain(db) {
    return Math.pow(10, (db || 0) / 20);
  }

  _generateStereoIR(decayTimeSec, hfDampHz) {
    const ctx = this.context;
    const sr = ctx.sampleRate || 44100;
    const length = Math.max(1, Math.floor(sr * Math.max(0.1, Math.min(10, decayTimeSec))))
    const buf = ctx.createBuffer(2, length, sr);
    const tau = Math.max(0.001, decayTimeSec) / 3; // decay constant for exp falloff
    const a = Math.exp(-1 / (sr * tau));
    // One-pole LP during IR synthesis for slight HF tilt
    const hf = Math.max(200, Math.min(20000, hfDampHz || 6000));
    const rc = 1 / (2 * Math.PI * hf);
    const alpha = 1 / (1 + sr * rc);
    for (let ch = 0; ch < 2; ch += 1) {
      const out = buf.getChannelData(ch);
      let y = 0;
      let env = 1;
      for (let i = 0; i < length; i += 1) {
        // White noise with small inter-channel decorrelation
        const n = (Math.random() * 2 - 1) * (ch === 0 ? 1 : 0.97);
        // HF damping
        y += alpha * (n - y);
        // Exponential decay envelope
        env *= a;
        out[i] = y * env;
      }
    }
    return buf;
  }

  _updateReverbSends() {
    const L = this.listener;
    const minD = Math.max(0.001, this.params.refDistance);
    const maxD = Math.max(minD + 0.001, this.params.maxDistance);
    const t = this.context.currentTime;
    for (let i = 0; i < 7; i += 1) {
      const s = this.sources[i];
      const dx = (s.x - L.x);
      const dy = (s.y - L.y);
      const dz = (s.z - L.z);
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let norm = (d - minD) / (maxD - minD);
      if (norm < 0) norm = 0; else if (norm > 1) norm = 1;
      // Slight emphasis on far distances, preserve source gain
      let sendAmt = Math.pow(norm, 0.7) * Math.max(0, s.gain);
      if (this.reverbExclude[i]) sendAmt = 0; else sendAmt *= Math.max(0, (this.reverbScale && this.reverbScale[i] != null) ? this.reverbScale[i] : 1);
      try { this.reverbSends[i].gain.setTargetAtTime(sendAmt, t, 0.05); } catch (_) { this.reverbSends[i].gain.value = sendAmt; }
    }
  }

  setReverbExclude(index, excluded) {
    const i = index | 0;
    if (i < 0 || i >= 7) return;
    this.reverbExclude[i] = !!excluded;
    this._updateReverbSends();
  }

  setReverbScale(index, scale) {
    const i = index | 0;
    if (i < 0 || i >= 7) return;
    const v = Number(scale);
    // clamp to [0, 2] for safety
    this.reverbScale[i] = (isFinite(v) ? Math.max(0, Math.min(2, v)) : 1);
    this._updateReverbSends();
  }

  setReverbParams(partial) {
    this.reverbParams = { ...this.reverbParams, ...(partial || {}) };
    const p = this.reverbParams;
    const t = this.context.currentTime;
    try { this._reverb.wetGain.gain.setTargetAtTime(Math.max(0, Math.min(1, p.wet)), t, 0.02); } catch (_) { this._reverb.wetGain.gain.value = Math.max(0, Math.min(1, p.wet)); }
    try { this._reverb.postLPF.frequency.setTargetAtTime(Math.max(200, Math.min(20000, p.hfDampHz)), t, 0.02); } catch (_) { this._reverb.postLPF.frequency.value = Math.max(200, Math.min(20000, p.hfDampHz)); }
    try { this._reverb.outGain.gain.setTargetAtTime(this._dbToGain(Math.max(0, Math.min(12, p.gainDb))), t, 0.02); } catch (_) { this._reverb.outGain.gain.value = this._dbToGain(Math.max(0, Math.min(12, p.gainDb))); }
    // Rebuild IR if decay time changed notably
    try {
      this._reverb.convolver.buffer = this._generateStereoIR(p.decayTime, p.hfDampHz);
    } catch (_) {}
  }

  setListenerPose(pose) {
    if (!pose || !pose.position) return;
    this.listener.x = Number(pose.position.x) || 0;
    this.listener.y = Number(pose.position.y) || 0;
    this.listener.z = Number(pose.position.z) || 0;
    this._updateReverbSends();
  }

  setBypass(enabled) {
    this.bypass = !!enabled;
    // Lower/raise spatial master; external UI handles main stereo mute
    const target = this.bypass ? 0 : 1;
    try { this.spatialMaster.gain.setTargetAtTime(target, this.context.currentTime, 0.02); } catch (_) { this.spatialMaster.gain.value = target; }
    try { this._reverb.outGain.gain.setTargetAtTime(target * this._dbToGain(this.reverbParams.gainDb), this.context.currentTime, 0.02); } catch (_) {}
  }

  setMeterSink(cb) { this._meterSink = cb; }

  setSource(index, { x, y, z, gain, solo }) {
    const i = index | 0;
    if (i < 0 || i >= 7) return;
    const s = this.sources[i];
    if (typeof x === 'number') { s.x = x; this.panners[i].positionX.value = x; }
    if (typeof y === 'number') { s.y = y; this.panners[i].positionY.value = y; }
    if (typeof z === 'number') { s.z = z; this.panners[i].positionZ.value = z; }
    if (typeof gain === 'number') { s.gain = gain; this.sourceGains[i].gain.value = gain; }
    if (typeof solo === 'boolean') { s.solo = solo; this._applySolo(); }
    // Update reverb send after any pose or gain change
    this._updateReverbSends();
  }

  _applySolo() {
    const anySolo = this.sources.some(s => s.solo);
    for (let i = 0; i < 7; i += 1) {
      this.sourceGains[i].gain.value = (anySolo ? (this.sources[i].solo ? this.sources[i].gain : 0) : this.sources[i].gain);
    }
  }

  setGlobal(params) {
    Object.assign(this.params, params || {});
    for (let i = 0; i < 7; i += 1) {
      const p = this.panners[i];
      p.refDistance = this.params.refDistance;
      p.rolloffFactor = this.params.rolloffFactor;
      p.maxDistance = this.params.maxDistance;
      p.coneInnerAngle = this.params.coneInner;
      p.coneOuterAngle = this.params.coneOuter;
      p.coneOuterGain = this.params.coneOuterGain;
    }
    this._updateReverbSends();
  }

  randomizePositions(opts) {
    const radius = (opts && typeof opts.radius === 'number') ? Math.max(0.01, opts.radius) : 3;
    // Sample positions within a front-facing hemisphere of given radius, biased forward (negative z)
    for (let i = 0; i < 7; i += 1) {
      // Uniform on sphere using Marsaglia method, then scale by random radius in [0, R]
      let x, y, z;
      while (true) {
        const u = Math.random() * 2 - 1;
        const v = Math.random() * 2 - 1;
        const s = u * u + v * v;
        if (s >= 1 || s === 0) continue;
        const mul = Math.sqrt(1 - s);
        x = 2 * u * mul;
        y = 2 * v * mul;
        z = 1 - 2 * s;
        if (z <= 0) break; // front hemisphere (negative z in our coord system), we flip below
      }
      // Flip to front (negative z) if needed
      z = -Math.abs(z);
      // Random radius with slight outward bias (sqrt for uniform disk -> cone volume)
      const r = radius * Math.sqrt(Math.random());
      this.setSource(i, { x: x * r, y: y * r * 0.5, z: z * r - 0.5 });
    }
  }

  destroy() {
    try { this.worklet.disconnect(); } catch (_) {}
    try { this.splitter.disconnect(); } catch (_) {}
    for (let i = 0; i < 7; i += 1) {
      try { this.sourceGains[i].disconnect(); } catch (_) {}
      try { this.panners[i].disconnect(); } catch (_) {}
      try { this.reverbSends[i].disconnect(); } catch (_) {}
    }
    try { this._reverb.outGain.disconnect(); } catch (_) {}
    try { this._reverb.postLPF.disconnect(); } catch (_) {}
    try { this._reverb.convolver.disconnect(); } catch (_) {}
    try { this._reverb.erSum.disconnect(); } catch (_) {}
    try { this._reverb.pre.disconnect(); } catch (_) {}
    this.enabled = false;
  }
}


