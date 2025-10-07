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
      maxDistance: 50,
      coneInner: 360,
      coneOuter: 360,
      coneOuterGain: 0
    };

    // Default sources state
    this.sources = new Array(7).fill(null).map((_, i) => ({
      x: (i - 3) * 0.5,
      y: 0,
      z: -2 - 0.2 * i,
      gain: 1,
      solo: false
    }));

    this._buildGraph();
  }

  _buildGraph() {
    const ctx = this.context;
    // Worklet: 2 inputs (stereo each), 1 output with 7 channels
    this.worklet = new AudioWorkletNode(ctx, 'spatial-processor', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [7],
      channelCountMode: 'explicit',
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

    // Per-source gain then panner
    this.sourceGains = new Array(7);
    this.panners = new Array(7);
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
    }

    // Keep reference to original direct routes to allow bypass
    this._directNoiseToDest = null;
    this._directRainToDest = null;

    // Attach meters callback holder
    this._meterSink = null;

    // Default: enabled graph but not yet wired inputs
    this.enabled = true;

    // Hook inputs from ResonatorNode outputs (1: rain -> input 0, 0: noise -> input 1)
    // Note: do not disturb existing noise/rain gain nodes; we connect directly from the source node outputs
    try {
      this.resNode.connect(this.worklet, 1, 0); // rain stereo -> input 0
    } catch (_) {}
    try {
      this.resNode.connect(this.worklet, 0, 1); // noise stereo -> input 1
    } catch (_) {}
  }

  setBypass(enabled) {
    this.bypass = !!enabled;
    // Lower/raise spatial master; external UI handles main stereo mute
    const target = this.bypass ? 0 : 1;
    try { this.spatialMaster.gain.setTargetAtTime(target, this.context.currentTime, 0.02); } catch (_) { this.spatialMaster.gain.value = target; }
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
    }
    this.enabled = false;
  }
}


