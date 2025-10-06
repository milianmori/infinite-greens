const MAX_BRANCHES = 32; // browser channel layout limit for AudioWorkletNode output bus
const GROUP_TAPS = 5; // max mono taps used for spatial panning (configurable)
const BOUNDS = { xMin: -5, xMax: 5, yMin: -5, yMax: 5, zMin: -2, zMax: 2 };
const MIN_DIST = 0.5;
const SMOOTH_MS = 0.35; // 350 ms default

function getMainApi() {
  try {
    if (window.opener && window.opener._mixerApi) return window.opener._mixerApi;
  } catch(_) {}
  try { if (window._mixerApi) return window._mixerApi; } catch(_) {}
  return null;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function seededPRNG(seed) {
  // xorshift32 seeded from string
  let h = 2166136261 >>> 0;
  const s = String(seed || '').trim();
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let x = (h || 0x9E3779B9) >>> 0;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return (x) * 2.3283064365386963e-10; // [0,1)
  };
}

function cryptoRand() {
  const u = new Uint32Array(1);
  crypto.getRandomValues(u);
  return (u[0] >>> 0) * 2.3283064365386963e-10;
}

function makeRand(seed) { return seed ? seededPRNG(seed) : cryptoRand; }

function smoothParam(param, ctx, target, timeMs) {
  const now = ctx.currentTime;
  const t = Math.max(0.001, (timeMs != null ? timeMs : SMOOTH_MS) / 1000);
  if (!param) return;
  try { param.cancelScheduledValues(now); } catch(_) {}
  try { param.setValueAtTime(param.value, now); } catch(_) {}
  try { param.linearRampToValueAtTime(target, now + t); } catch(_) {}
}

// Build a simple exponential-decay noise impulse response
function buildSimpleIR(ctx, timeSec) {
  const sr = ctx.sampleRate || 44100;
  const len = Math.max(1, Math.floor(sr * Math.max(0.1, Math.min(6, timeSec || 2.3))));
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch += 1) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i += 1) {
      const t = i / len;
      const decay = Math.exp(-3 * t); // fairly quick decay
      d[i] = (Math.random() * 2 - 1) * decay * 0.5;
    }
  }
  return buf;
}

function createBranchRow(i) {
  const row = document.createElement('div');
  row.className = 'row';
  const idx = document.createElement('span'); idx.textContent = String(i + 1); row.appendChild(idx);
  const g = document.createElement('input'); g.type = 'range'; g.min = '0'; g.max = '1'; g.step = '0.001'; g.value = '1'; g.dataset.role = 'gain'; row.appendChild(g);
  const xs = document.createElement('input'); xs.type = 'range'; xs.min = String(BOUNDS.xMin); xs.max = String(BOUNDS.xMax); xs.step = '0.01'; xs.value = '0'; xs.dataset.role = 'x'; row.appendChild(xs);
  const ys = document.createElement('input'); ys.type = 'range'; ys.min = String(BOUNDS.yMin); ys.max = String(BOUNDS.yMax); ys.step = '0.01'; ys.value = '0'; ys.dataset.role = 'y'; row.appendChild(ys);
  const zs = document.createElement('input'); zs.type = 'range'; zs.min = String(BOUNDS.zMin); zs.max = String(BOUNDS.zMax); zs.step = '0.01'; zs.value = '0'; zs.dataset.role = 'z'; row.appendChild(zs);
  return row;
}

function distance3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.hypot(dx, dy, dz);
}

function enforceMinDist(p, listener) {
  const d = distance3(p, listener);
  if (d >= MIN_DIST) return p;
  const dx = p.x - listener.x; const dy = p.y - listener.y; const dz = p.z - listener.z;
  let nx = dx, ny = dy, nz = dz;
  const mag = Math.hypot(nx, ny, nz) || 1;
  nx /= mag; ny /= mag; nz /= mag;
  return { x: listener.x + nx * MIN_DIST, y: listener.y + ny * MIN_DIST, z: listener.z + nz * MIN_DIST };
}

class SpatialMixer {
  constructor() {
    this.api = null;
    this.ctx = null;
    this.node = null;
    this.master = null;
    this.stage = document.getElementById('stage');
    this.rowsRoot = document.getElementById('branchRows');
    this.n = 0;
    this.branch = []; // groups: { panner:PannerNode, gain:GainNode }
    this.stageState = { dragging: -1, orbiting: false, lastX: 0, lastY: 0 };
    this.listener = { x:0, y:0, z:0, yawDeg:0 };
    this.rand = cryptoRand;
    this.splitter = null;
    this.groupInputs = [];
    this.groupCount = 0;
    this.revConvolver = null;
    this.revWet = null;
    this.revBoost = null;
    this.revDry = null;
    this.directBypass = false;
    this.masterOffset = { x:0, y:0, z:0 };
    this.sendWet = [];
    this.revNear = 0.7; // distance at which reverb starts increasing
    this.revFar = 12;   // distance at which reverb is maxed
    this.revCurve = 1.2; // curve exponent for wetness progression
    // 3D view state (orbit camera)
    this.view3D = {
      enabled: true,
      yawDeg: -35,    // horizontal orbit angle
      pitchDeg: 20,   // vertical orbit angle
      distance: 12,   // camera distance from center
      center: { x: 0, y: 0, z: 0 }
    };
    // Auto navigation state
    this.auto = {
      enabled: false,
      speed: 1,            // units per second
      approach: 0.5,       // arrival radius
      dwellSec: 0.3,       // pause at target
      yaw: true,           // auto face direction
      yawRateDeg: 120,     // deg per second
      targetIndex: -1,
      visited: new Set(),
      dwellUntil: 0,
      rafId: 0,
      lastTsMs: 0
    };
  }

  // Update world bounds (symmetric around 0) and refresh UI/scene
  setWorldSize(xyHalf, zHalf) {
    const safeXY = Math.max(0.5, Math.min(50, xyHalf || 5));
    const safeZ = Math.max(0.1, Math.min(20, zHalf || 2));
    BOUNDS.xMin = -safeXY; BOUNDS.xMax = safeXY;
    BOUNDS.yMin = -safeXY; BOUNDS.yMax = safeXY;
    BOUNDS.zMin = -safeZ;  BOUNDS.zMax = safeZ;

    // Update label
    const bl = document.getElementById('boundsLabel');
    if (bl) bl.textContent = `Bounds x,y [${BOUNDS.xMin},${BOUNDS.xMax}] z [${BOUNDS.zMin},${BOUNDS.zMax}]`;

    // Sync world controls to clamped values
    const wxy = document.getElementById('worldXY');
    const wxyn = document.getElementById('worldXYn');
    const wz = document.getElementById('worldZ');
    const wzn = document.getElementById('worldZn');
    const sync = (from, to) => { try { to.value = from.value; } catch(_) {} };
    if (wxy) { wxy.value = String(safeXY); if (wxyn) sync(wxy, wxyn); }
    if (wz) { wz.value = String(safeZ); if (wzn) sync(wz, wzn); }

    // Update listener slider ranges and clamp values
    const setRange = (id, min, max) => {
      const el = document.getElementById(id);
      const nEl = document.getElementById(id + 'n');
      if (el) { el.min = String(min); el.max = String(max); el.value = String(clamp(parseFloat(el.value || '0'), min, max)); }
      if (nEl) { nEl.min = String(min); nEl.max = String(max); nEl.value = String(clamp(parseFloat(nEl.value || '0'), min, max)); }
    };
    setRange('lx', BOUNDS.xMin, BOUNDS.xMax);
    setRange('ly', BOUNDS.yMin, BOUNDS.yMax);
    setRange('lz', BOUNDS.zMin, BOUNDS.zMax);
    setRange('mx', BOUNDS.xMin, BOUNDS.xMax);
    setRange('my', BOUNDS.yMin, BOUNDS.yMax);
    setRange('mz', BOUNDS.zMin, BOUNDS.zMax);

    // Clamp current listener and master offset state and apply to audio
    this.listener.x = clamp(this.listener.x, BOUNDS.xMin, BOUNDS.xMax);
    this.listener.y = clamp(this.listener.y, BOUNDS.yMin, BOUNDS.yMax);
    this.listener.z = clamp(this.listener.z, BOUNDS.zMin, BOUNDS.zMax);
    this.masterOffset.x = clamp(this.masterOffset.x, BOUNDS.xMin, BOUNDS.xMax);
    this.masterOffset.y = clamp(this.masterOffset.y, BOUNDS.yMin, BOUNDS.yMax);
    this.masterOffset.z = clamp(this.masterOffset.z, BOUNDS.zMin, BOUNDS.zMax);

    // Update branch row slider ranges and re-apply positions
    for (let i = 0; i < this.rowsRoot.children.length; i += 1) {
      const row = this.rowsRoot.children[i];
      const xEl = row.querySelector('[data-role="x"]');
      const yEl = row.querySelector('[data-role="y"]');
      const zEl = row.querySelector('[data-role="z"]');
      if (xEl) { xEl.min = String(BOUNDS.xMin); xEl.max = String(BOUNDS.xMax); xEl.value = String(clamp(parseFloat(xEl.value || '0'), BOUNDS.xMin, BOUNDS.xMax)); }
      if (yEl) { yEl.min = String(BOUNDS.yMin); yEl.max = String(BOUNDS.yMax); yEl.value = String(clamp(parseFloat(yEl.value || '0'), BOUNDS.yMin, BOUNDS.yMax)); }
      if (zEl) { zEl.min = String(BOUNDS.zMin); zEl.max = String(BOUNDS.zMax); zEl.value = String(clamp(parseFloat(zEl.value || '0'), BOUNDS.zMin, BOUNDS.zMax)); }
      // Trigger re-apply with smoothing and redraw
      if (xEl) xEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Redraw grid and update listener
    this.updateAudioListener();
    this.drawStage();
  }

  updateAudioListener() {
    const o = this.listener;
    const f = (deg) => deg * Math.PI / 180;
    const yaw = f(o.yawDeg);
    const fx = Math.cos(yaw), fy = Math.sin(yaw);
    try {
      const lp = this.ctx.listener;
      lp.positionX.setTargetAtTime(o.x, this.ctx.currentTime, 0.02);
      lp.positionY.setTargetAtTime(o.y, this.ctx.currentTime, 0.02);
      lp.positionZ.setTargetAtTime(o.z, this.ctx.currentTime, 0.02);
      lp.forwardX.setTargetAtTime(fx, this.ctx.currentTime, 0.02);
      lp.forwardY.setTargetAtTime(0, this.ctx.currentTime, 0.02);
      lp.forwardZ.setTargetAtTime(-fy, this.ctx.currentTime, 0.02);
      lp.upX.setTargetAtTime(0, this.ctx.currentTime, 0.02);
      lp.upY.setTargetAtTime(1, this.ctx.currentTime, 0.02);
      lp.upZ.setTargetAtTime(0, this.ctx.currentTime, 0.02);
    } catch(_) {}
    this.updateReverbSends();
    this.drawStage();
  }

  assignGroups() {
    if (!this.splitter) return;
    // Disconnect previous wiring into group inputs
    try {
      for (let i = 0; i < MAX_BRANCHES; i += 1) {
        for (const gi of this.groupInputs) { try { this.splitter.disconnect(gi); } catch(_) {} }
      }
    } catch(_) {}

    // Build an even distribution across groupCount, randomized
    const n = this.n;
    const k = Math.max(1, Math.min(this.groupCount || 1, n));
    const indices = Array.from({ length: n }, (_, i) => i);
    // shuffle
    for (let i = indices.length - 1; i > 0; i -= 1) {
      const j = Math.floor((typeof this.rand === 'function' ? this.rand() : Math.random()) * (i + 1));
      const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
    }
    // even chunks
    const groups = Array.from({ length: k }, () => []);
    for (let i = 0; i < indices.length; i += 1) groups[i % k].push(indices[i]);

    // Wire splitter outputs into group sum gains
    for (let g = 0; g < k; g += 1) {
      const gi = this.groupInputs[g];
      const members = groups[g];
      for (const ch of members) {
        try { this.splitter.connect(gi, ch); } catch(_) {}
      }
    }
  }

  attach() {
    this.api = getMainApi();
    if (!this.api) throw new Error('Main window not found. Start audio on index.html then click Attach.');
    this.ctx = this.api.getContext();
    this.node = this.api.getNode();
    this.master = this.api.getMasterOut();
    if (!this.node || !this.master) throw new Error('Audio not started in main window.');

    // Create branch graph: node output[2] → channelSplitter → per-branch panner → branch gain → stereo merger → master
    const maxCh = Math.min(MAX_BRANCHES, 40);
    const splitter = this.ctx.createChannelSplitter(maxCh);
    // Connect processor 3rd output (index 2) into splitter
    this.node.connect(splitter, 2, 0);
    this.splitter = splitter;

    // Reverb bus: dry + wet mix into master
    this.revDry = this.ctx.createGain(); this.revDry.gain.value = 1;
    this.revWet = this.ctx.createGain(); this.revWet.gain.value = 0.2;
    this.revConvolver = this.ctx.createConvolver();
    this.revConvolver.normalize = true;
    // Procedurally build a basic IR so there's sound without loading files
    this.revConvolver.buffer = buildSimpleIR(this.ctx, 2.3);

    // Insert boost stage on wet path (only affects reverb signal)
    this.revBoost = this.ctx.createGain(); this.revBoost.gain.value = 1;
    this.revConvolver.connect(this.revBoost);
    this.revBoost.connect(this.revWet);
    // Mix to master (default: spatial active)
    this.revDry.connect(this.master);
    this.revWet.connect(this.master);

    // Build group panners (K taps or fewer if fewer branches)
    this.n = Math.min(this.node.parameters.get('nbranches').value | 0, maxCh);
    this.groupCount = Math.min(GROUP_TAPS, this.n);
    this.branch = [];
    this.groupInputs = [];
    this.sendWet = [];
    this.rowsRoot.innerHTML = '';
    for (let k = 0; k < this.groupCount; k += 1) {
      const sumIn = this.ctx.createGain(); sumIn.gain.value = 1; // sums branches assigned to this group
      const g = this.ctx.createGain(); g.gain.value = 1;
      const p = this.ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 1;
      p.rolloffFactor = 1;
      p.maxDistance = 25;
      p.coneInnerAngle = 60;
      p.coneOuterAngle = 90;
      p.coneOuterGain = 0.3;
      sumIn.connect(p);
      p.connect(g);
      // Per-group routing: direct to dry bus, distance-based send to wet bus
      try { g.connect(this.revDry); } catch(_) {}
      const wetSend = this.ctx.createGain();
      wetSend.gain.value = 0; // will be driven by distance
      try { g.connect(wetSend); } catch(_) {}
      try { wetSend.connect(this.revConvolver); } catch(_) {}
      this.sendWet.push(wetSend);
      p.positionX.value = 0; p.positionY.value = 0; p.positionZ.value = 0;
      const row = createBranchRow(k);
      this.rowsRoot.appendChild(row);
      const gainEl = row.querySelector('[data-role="gain"]');
      const xEl = row.querySelector('[data-role="x"]');
      const yEl = row.querySelector('[data-role="y"]');
      const zEl = row.querySelector('[data-role="z"]');
      const apply = () => {
        const base = { x: parseFloat(xEl.value), y: parseFloat(yEl.value), z: parseFloat(zEl.value) };
        const withMaster = { x: base.x + this.masterOffset.x, y: base.y + this.masterOffset.y, z: base.z + this.masterOffset.z };
        const pos = enforceMinDist(withMaster, this.listener);
        smoothParam(p.positionX, this.ctx, clamp(pos.x, BOUNDS.xMin, BOUNDS.xMax));
        smoothParam(p.positionY, this.ctx, clamp(pos.y, BOUNDS.yMin, BOUNDS.yMax));
        smoothParam(p.positionZ, this.ctx, clamp(pos.z, BOUNDS.zMin, BOUNDS.zMax));
        smoothParam(g.gain, this.ctx, Math.max(0, Math.min(1, parseFloat(gainEl.value))));
        this.updateReverbSends();
        this.drawStage();
      };
      [gainEl, xEl, yEl, zEl].forEach(el => el.addEventListener('input', apply));
      this.branch.push({ panner: p, gain: g });
      this.groupInputs.push(sumIn);
    }

    // Initial random-even assignment of branches to groups
    this.assignGroups();

    // Mute the original stereo from main so we only hear spatial sum
    this.api.muteMainStereo(true);
    this.setupStage();
    this.wireRoomControls();
    this.wireViewZoom();
    this.wireBypassAndReverb();
    this.wireAutoControls();
    this.drawStage();
  }

  detach() {
    try { this.api && this.api.muteMainStereo(false); } catch(_) {}
  }

  randomizeAll() {
    const seed = document.getElementById('seedInput')?.value || '';
    this.rand = makeRand(seed || undefined);
    // Re-seed grouping and rewire channels
    this.assignGroups();
    for (let i = 0; i < this.branch.length; i += 1) {
      const r = this.rand; const fr = typeof r === 'function' ? r : cryptoRand;
      const xr = BOUNDS.xMin + fr() * (BOUNDS.xMax - BOUNDS.xMin);
      const yr = BOUNDS.yMin + fr() * (BOUNDS.yMax - BOUNDS.yMin);
      const zr = BOUNDS.zMin + fr() * (BOUNDS.zMax - BOUNDS.zMin);
      const row = this.rowsRoot.children[i];
      row.querySelector('[data-role="x"]').value = String(xr.toFixed(2));
      row.querySelector('[data-role="y"]').value = String(yr.toFixed(2));
      row.querySelector('[data-role="z"]').value = String(zr.toFixed(2));
      row.querySelector('[data-role="gain"]').value = String(1);
      row.querySelector('[data-role="x"]').dispatchEvent(new Event('input', { bubbles:true }));
    }
    // Also randomize reverb settings
    try {
      const fr = typeof this.rand === 'function' ? this.rand : cryptoRand;
      const wet = (fr() * 0.7).toFixed(2); // 0..0.7
      const time = (0.3 + fr() * 3.5).toFixed(1); // 0.3..3.8s
      const wetEl = document.getElementById('reverbWet');
      const timeEl = document.getElementById('reverbTime');
      if (wetEl) { wetEl.value = wet; wetEl.dispatchEvent(new Event('input', { bubbles:true })); }
      if (timeEl) { timeEl.value = time; timeEl.dispatchEvent(new Event('input', { bubbles:true })); }
    } catch(_) {}
  }

  wireRoomControls() {
    const bind = (id, cb) => {
      const el = document.getElementById(id);
      const nEl = document.getElementById(id + 'n');
      if (!el) return;
      const sync = (from, to) => { try { to.value = from.value; } catch(_) {} };
      const handler = () => { sync(el, nEl); cb(parseFloat(el.value)); };
      el.addEventListener('input', handler);
      if (nEl) {
        nEl.addEventListener('input', () => { sync(nEl, el); cb(parseFloat(nEl.value)); });
      }
      handler();
    };

    const updateListener = () => this.updateAudioListener();

    // World size bindings
    bind('worldXY', (v) => { this.setWorldSize(v, (BOUNDS.zMax - BOUNDS.zMin) * 0.5); });
    bind('worldZ', (v) => { this.setWorldSize((BOUNDS.xMax - BOUNDS.xMin) * 0.5, v); });

    bind('lx', (v) => { this.listener.x = clamp(v, BOUNDS.xMin, BOUNDS.xMax); this.auto.enabled && this.stopAuto(); updateListener(); });
    bind('ly', (v) => { this.listener.y = clamp(v, BOUNDS.yMin, BOUNDS.yMax); this.auto.enabled && this.stopAuto(); updateListener(); });
    bind('lz', (v) => { this.listener.z = clamp(v, BOUNDS.zMin, BOUNDS.zMax); this.auto.enabled && this.stopAuto(); updateListener(); });
    bind('yaw', (v) => { this.listener.yawDeg = v; this.auto.yaw = false; updateListener(); });
    // Master position offsets applied additively to all branches
    const bindM = (id, axis) => {
      const el = document.getElementById(id);
      const nEl = document.getElementById(id + 'n');
      if (!el) return;
      const sync = (from, to) => { try { to.value = from.value; } catch(_) {} };
      const apply = () => {
        sync(el, nEl);
        // Clamp using current bounds at apply-time so world size changes are respected
        const boundsMin = axis === 'z' ? BOUNDS.zMin : (axis === 'x' ? BOUNDS.xMin : BOUNDS.yMin);
        const boundsMax = axis === 'z' ? BOUNDS.zMax : (axis === 'x' ? BOUNDS.xMax : BOUNDS.yMax);
        // Ensure inputs reflect current bounds
        el.min = String(boundsMin); el.max = String(boundsMax);
        if (nEl) { nEl.min = String(boundsMin); nEl.max = String(boundsMax); }
        const val = clamp(parseFloat(el.value), boundsMin, boundsMax);
        this.masterOffset[axis] = val;
        // re-apply each branch to take effect smoothly
        for (let i = 0; i < this.branch.length; i += 1) {
          const row = this.rowsRoot.children[i];
          row.querySelector('[data-role="x"]').dispatchEvent(new Event('input', { bubbles:true }));
        }
      };
      el.addEventListener('input', apply);
      if (nEl) nEl.addEventListener('input', () => { sync(nEl, el); apply(); });
      apply();
    };
    bindM('mx', 'x');
    bindM('my', 'y');
    bindM('mz', 'z');

    const bindP = (id, fn) => {
      const el = document.getElementById(id);
      if (!el) return;
      // Pair with the number input in the same row (IDs are not always `${id}n`)
      const nEl = el.parentElement ? el.parentElement.querySelector('input[type="number"]') : null;
      const sync = (from, to) => { try { to.value = from.value; } catch(_) {} };
      const applyVal = (v) => { for (const b of this.branch) fn(b.panner, v); };
      const onSlider = () => { if (nEl) sync(el, nEl); applyVal(parseFloat(el.value)); };
      el.addEventListener('input', onSlider);
      if (nEl) {
        nEl.addEventListener('input', () => { sync(nEl, el); applyVal(parseFloat(nEl.value)); });
      }
      onSlider();
    };
    bindP('refDistance', (p, v) => p.refDistance = Math.max(0.01, v));
    bindP('rolloffFactor', (p, v) => p.rolloffFactor = Math.max(0, v));
    bindP('maxDistance', (p, v) => p.maxDistance = Math.max(1, v));
    bindP('coneInner', (p, v) => p.coneInnerAngle = clamp(v, 0, 360));
    bindP('coneOuter', (p, v) => p.coneOuterAngle = clamp(v, 0, 360));
    bindP('coneOuterGain', (p, v) => p.coneOuterGain = clamp(v, 0, 1));

    document.getElementById('presetRoom').addEventListener('click', () => {
      ['refDistance','rolloffFactor','maxDistance','coneInner','coneOuter','coneOuterGain']
        .forEach((id, idx) => {
          const v = { refDistance:1, rolloffFactor:1.5, maxDistance:20, coneInner:60, coneOuter:90, coneOuterGain:0.3 }[id];
          const el = document.getElementById(id); el.value = String(v); el.dispatchEvent(new Event('input', { bubbles:true }));
        });
    });
    document.getElementById('presetHall').addEventListener('click', () => {
      const vals = { refDistance:1.5, rolloffFactor:0.9, maxDistance:40, coneInner:80, coneOuter:120, coneOuterGain:0.2 };
      for (const [k,v] of Object.entries(vals)) { const el = document.getElementById(k); el.value = String(v); el.dispatchEvent(new Event('input', { bubbles:true })); }
    });
    document.getElementById('presetOutside').addEventListener('click', () => {
      const vals = { refDistance:1, rolloffFactor:0.3, maxDistance:50, coneInner:180, coneOuter:220, coneOuterGain:0.9 };
      for (const [k,v] of Object.entries(vals)) { const el = document.getElementById(k); el.value = String(v); el.dispatchEvent(new Event('input', { bubbles:true })); }
    });
  }

  wireViewZoom() {
    const el = document.getElementById('viewZoom');
    const nEl = document.getElementById('viewZoomn');
    if (!el) return;
    const sync = (from, to) => { try { to.value = from.value; } catch(_) {} };
    const apply = (v) => {
      const val = Math.max(2, Math.min(100, isFinite(v) ? v : 12));
      this.view3D.distance = val;
      this.drawStage();
    };
    el.addEventListener('input', () => { if (nEl) sync(el, nEl); apply(parseFloat(el.value)); });
    if (nEl) nEl.addEventListener('input', () => { sync(nEl, el); apply(parseFloat(nEl.value)); });
    // initialize
    apply(parseFloat(el.value || '12'));
  }

  getBranchPositions() {
    const positions = [];
    for (let i = 0; i < this.branch.length; i += 1) {
      const p = this.branch[i].panner;
      positions.push({ x: p.positionX.value, y: p.positionY.value, z: p.positionZ.value, index: i });
    }
    return positions;
  }

  pickNearest(from, excludeSet) {
    const ps = this.getBranchPositions();
    let bestIdx = -1, bestD = Infinity;
    for (let i = 0; i < ps.length; i += 1) {
      if (excludeSet && excludeSet.has(ps[i].index)) continue;
      const d = distance3(from, ps[i]);
      if (d < bestD) { bestD = d; bestIdx = ps[i].index; }
    }
    return bestIdx;
  }

  wireAutoControls() {
    const sync = (from, to) => { try { to.value = from.value; } catch(_) {} };
    const bindToggle = (id, cb) => {
      const el = document.getElementById(id);
      if (!el) return;
      const handler = () => cb(!!el.checked);
      el.addEventListener('change', handler);
      handler();
    };
    const bindNum = (id, cb) => {
      const el = document.getElementById(id);
      const nEl = document.getElementById(id + 'n');
      if (!el) return;
      const handler = () => { sync(el, nEl); cb(parseFloat(el.value)); };
      el.addEventListener('input', handler);
      if (nEl) nEl.addEventListener('input', () => { sync(nEl, el); cb(parseFloat(nEl.value)); });
      handler();
    };

    bindToggle('autoEnable', (on) => {
      this.auto.enabled = on;
      if (on) {
        // Start from center as requested
        this.listener.x = 0; this.listener.y = 0; this.listener.z = 0;
        this.updateAudioListener();
        this.auto.visited = new Set();
        this.auto.targetIndex = -1;
        this.auto.dwellUntil = 0;
        this.startAuto();
      } else {
        this.stopAuto();
      }
    });
    bindNum('autoSpeed', (v) => { this.auto.speed = Math.max(0.01, v); });
    bindNum('autoApproach', (v) => { this.auto.approach = clamp(v, 0.01, 10); });
    bindNum('autoDwell', (v) => { this.auto.dwellSec = Math.max(0, v); });
    bindToggle('autoYaw', (on) => { this.auto.yaw = !!on; });
    bindNum('autoYawRate', (v) => { this.auto.yawRateDeg = Math.max(0, v); });
  }

  updateReverbSends() {
    if (!this.sendWet || !this.branch || !this.ctx) return;
    const near = Math.max(0, this.revNear);
    const far = Math.max(near + 0.001, this.revFar);
    for (let i = 0; i < this.branch.length; i += 1) {
      const p = this.branch[i].panner;
      const d = distance3({ x: p.positionX.value, y: p.positionY.value, z: p.positionZ.value }, this.listener);
      let t = (d - near) / (far - near);
      t = Math.max(0, Math.min(1, t));
      // Curve control (curve>1 keeps it more direct when close)
      const curve = this.revCurve || 1.2;
      const wetAmt = Math.pow(t, curve);
      const send = this.sendWet[i];
      if (send && send.gain) {
        smoothParam(send.gain, this.ctx, wetAmt, 120); // 120ms smoothing
      }
    }
  }

  startAuto() {
    if (this.auto.rafId) cancelAnimationFrame(this.auto.rafId);
    this.auto.lastTsMs = performance.now();
    const tick = (ts) => {
      const dt = Math.max(0, (ts - this.auto.lastTsMs) / 1000);
      this.auto.lastTsMs = ts;
      if (this.auto.enabled) this.stepAuto(dt, ts);
      this.auto.rafId = this.auto.enabled ? requestAnimationFrame(tick) : 0;
    };
    this.auto.rafId = requestAnimationFrame(tick);
  }

  stopAuto() {
    this.auto.enabled = false;
    if (this.auto.rafId) cancelAnimationFrame(this.auto.rafId);
    this.auto.rafId = 0;
  }

  stepAuto(dt, nowMs) {
    if (!this.branch || this.branch.length === 0) return;
    // Pick a target if none
    if (this.auto.targetIndex < 0 || this.auto.targetIndex >= this.branch.length) {
      const startPos = { x: this.listener.x, y: this.listener.y, z: this.listener.z };
      this.auto.targetIndex = this.pickNearest(startPos, this.auto.visited);
      this.auto.dwellUntil = 0;
    }
    const p = this.branch[this.auto.targetIndex]?.panner;
    if (!p) return;
    const target = { x: p.positionX.value, y: p.positionY.value, z: p.positionZ.value };
    const pos = { x: this.listener.x, y: this.listener.y, z: this.listener.z };
    const dx = target.x - pos.x, dy = target.y - pos.y, dz = target.z - pos.z;
    const dist = Math.hypot(dx, dy, dz);

    if (dist <= this.auto.approach) {
      if (!this.auto.dwellUntil) {
        this.auto.dwellUntil = nowMs + this.auto.dwellSec * 1000;
      }
      if (nowMs >= this.auto.dwellUntil) {
        this.auto.visited.add(this.auto.targetIndex);
        if (this.auto.visited.size >= this.branch.length) this.auto.visited.clear();
        // Next nearest from current position
        this.auto.targetIndex = this.pickNearest(pos, this.auto.visited);
        this.auto.dwellUntil = 0;
      }
      // no movement during dwell
      return;
    }

    // Move towards target at constant speed
    const speed = this.auto.speed;
    const nx = dx / (dist || 1), ny = dy / (dist || 1), nz = dz / (dist || 1);
    const step = speed * dt;
    const newPos = {
      x: clamp(pos.x + nx * step, BOUNDS.xMin, BOUNDS.xMax),
      y: clamp(pos.y + ny * step, BOUNDS.yMin, BOUNDS.yMax),
      z: clamp(pos.z + nz * step, BOUNDS.zMin, BOUNDS.zMax)
    };
    this.listener.x = newPos.x; this.listener.y = newPos.y; this.listener.z = newPos.z;

    // Auto yaw towards motion direction
    if (this.auto.yaw) {
      const desiredYawRad = Math.atan2(-nz, nx); // matches drawStage forward
      let desiredDeg = desiredYawRad * 180 / Math.PI;
      let cur = this.listener.yawDeg;
      // shortest angular difference
      let diff = ((desiredDeg - cur + 540) % 360) - 180;
      const maxStep = this.auto.yawRateDeg * dt;
      if (Math.abs(diff) <= maxStep) cur = desiredDeg; else cur += Math.sign(diff) * maxStep;
      // normalize
      cur = ((cur + 180) % 360) - 180;
      this.listener.yawDeg = cur;
    }

    this.updateAudioListener();
  }

  wireBypassAndReverb() {
    // Spatial bypass: disconnect spatial graph and unmute main stereo
    const bypassSpatial = document.getElementById('bypassSpatial');
    if (bypassSpatial) {
      const apply = () => {
        const by = !!bypassSpatial.checked;
        this.directBypass = by;
        if (by) {
          // Disconnect spatial mix from master and unmute original
          try { this.revDry.disconnect(); } catch(_) {}
          try { this.revWet.disconnect(); } catch(_) {}
          try { this.api.muteMainStereo(false); } catch(_) {}
        } else {
          // Reconnect spatial mix and mute original stereo
          try { this.revDry.connect(this.master); } catch(_) {}
          try { this.revWet.connect(this.master); } catch(_) {}
          try { this.api.muteMainStereo(true); } catch(_) {}
        }
      };
      bypassSpatial.addEventListener('change', apply);
      apply();
    }

    // Reverb wet
    const wet = document.getElementById('reverbWet');
    const wetn = document.getElementById('reverbWetn');
    const sync = (from, to) => { try { to.value = from.value; } catch(_) {} };
    const setWet = (val) => { if (this.revWet) this.revWet.gain.setTargetAtTime(Math.max(0, Math.min(1, val)), this.ctx.currentTime, 0.02); };
    if (wet) {
      wet.addEventListener('input', () => { sync(wet, wetn); setWet(parseFloat(wet.value)); });
      wet.dispatchEvent(new Event('input', { bubbles:true }));
    }
    if (wetn) {
      wetn.addEventListener('input', () => { sync(wetn, wet); setWet(parseFloat(wetn.value)); });
    }

    const rtime = document.getElementById('reverbTime');
    const rtimen = document.getElementById('reverbTimen');
    const setTime = (val) => {
      const t = Math.max(0.1, Math.min(6, val));
      if (this.revConvolver) {
        try { this.revConvolver.buffer = buildSimpleIR(this.ctx, t); } catch(_) {}
      }
    };
    if (rtime) {
      rtime.addEventListener('input', () => { sync(rtime, rtimen); setTime(parseFloat(rtime.value)); });
      rtime.dispatchEvent(new Event('input', { bubbles:true }));
    }
    if (rtimen) {
      rtimen.addEventListener('input', () => { sync(rtimen, rtime); setTime(parseFloat(rtimen.value)); });
    }

    // Reverb distance/curve parameters
    const bindParam = (id, cb) => {
      const el = document.getElementById(id);
      const nEl = document.getElementById(id + 'n');
      if (!el) return;
      const handler = () => { try { if (nEl) nEl.value = el.value; } catch(_){} cb(parseFloat(el.value)); };
      el.addEventListener('input', handler);
      if (nEl) nEl.addEventListener('input', () => { try { el.value = nEl.value; } catch(_) {} cb(parseFloat(nEl.value)); });
      handler();
    };
    bindParam('reverbNear', (v) => { this.revNear = Math.max(0, v); this.updateReverbSends(); });
    bindParam('reverbFar', (v) => { this.revFar = Math.max(0.01, v); this.updateReverbSends(); });
    bindParam('reverbCurve', (v) => { this.revCurve = Math.max(0.1, v); this.updateReverbSends(); });

    // Reverb gain (dB boost on wet only)
    const rg = document.getElementById('reverbGainDb');
    const rgn = document.getElementById('reverbGainDbn');
    const setBoost = (db) => {
      const clamped = Math.max(0, Math.min(12, isFinite(db) ? db : 0));
      const lin = Math.pow(10, clamped / 20); // 0..12 dB → 1..~3.98
      if (this.revBoost) this.revBoost.gain.setTargetAtTime(lin, this.ctx.currentTime, 0.02);
    };
    if (rg) {
      rg.addEventListener('input', () => { try { if (rgn) rgn.value = rg.value; } catch(_) {}; setBoost(parseFloat(rg.value)); });
      rg.dispatchEvent(new Event('input', { bubbles:true }));
    }
    if (rgn) {
      rgn.addEventListener('input', () => { try { if (rg) rg.value = rgn.value; } catch(_) {}; setBoost(parseFloat(rgn.value)); });
    }
  }

  setupStage() {
    const c = this.stage;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = c.getBoundingClientRect();
    c.width = Math.floor(rect.width * dpr);
    c.height = Math.floor(rect.height * dpr);
    const toWorld = (px, py) => {
      const w = c.width, h = c.height;
      const nx = (px / w) * 2 - 1; // -1..1
      const ny = (py / h) * 2 - 1;
      const x = (nx) * (BOUNDS.xMax - BOUNDS.xMin) * 0.5;
      const y = (-ny) * (BOUNDS.yMax - BOUNDS.yMin) * 0.5;
      return { x, y };
    };
    const toScreen = (x, y) => {
      const w = c.width, h = c.height;
      const nx = (x) / ((BOUNDS.xMax - BOUNDS.xMin) * 0.5);
      const ny = (y) / ((BOUNDS.yMax - BOUNDS.yMin) * 0.5);
      const px = (nx * 0.5 + 0.5) * w;
      const py = ((-ny) * 0.5 + 0.5) * h;
      return { x: px, y: py };
    };
    // 3D projection helper: world (x,y,z) -> screen {x,y,behind:boolean}
    this.project3D = (x, y, z) => {
      const v = this.view3D;
      // camera spherical to cartesian around center
      const yaw = v.yawDeg * Math.PI / 180;
      const pitch = v.pitchDeg * Math.PI / 180;
      const cosPitch = Math.cos(pitch);
      const sinPitch = Math.sin(pitch);
      const cosYaw = Math.cos(yaw);
      const sinYaw = Math.sin(yaw);
      const cx = v.center.x + v.distance * cosPitch * sinYaw;
      const cy = v.center.y + v.distance * sinPitch;
      const cz = v.center.z + v.distance * cosPitch * cosYaw;
      // camera basis
      const fx = v.center.x - cx;
      const fy = v.center.y - cy;
      const fz = v.center.z - cz;
      const fLen = Math.hypot(fx, fy, fz) || 1;
      const fX = fx / fLen, fY = fy / fLen, fZ = fz / fLen; // forward
      const upXw = 0, upYw = 1, upZw = 0;
      // right = normalize(cross(forward, upWorld))
      const rXn = fY * upZw - fZ * upYw;
      const rYn = fZ * upXw - fX * upZw;
      const rZn = fX * upYw - fY * upXw;
      const rLen = Math.hypot(rXn, rYn, rZn) || 1;
      const rX = rXn / rLen, rY = rYn / rLen, rZ = rZn / rLen; // right
      // up = cross(right, forward)
      const uX = rY * fZ - rZ * fY;
      const uY = rZ * fX - rX * fZ;
      const uZ = rX * fY - rY * fX;
      // point relative to camera
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const camX = dx * rX + dy * rY + dz * rZ;
      const camY = dx * uX + dy * uY + dz * uZ;
      const camZ = dx * fX + dy * fY + dz * fZ; // depth along forward
      const near = 0.1;
      const fov = 60 * Math.PI / 180; // 60 deg
      const scale = (0.5 * c.height) / Math.tan(fov / 2);
      const behind = camZ <= near;
      const px = c.width * 0.5 + (camX * scale) / Math.max(near, camZ);
      const py = c.height * 0.5 - (camY * scale) / Math.max(near, camZ);
      return { x: px, y: py, behind };
    };
    const pick = (px, py) => {
      const pt = toWorld(px, py);
      for (let i = 0; i < this.branch.length; i += 1) {
        const b = this.branch[i];
        const dx = pt.x - b.panner.positionX.value;
        const dy = pt.y - b.panner.positionY.value;
        if (Math.hypot(dx, dy) < 0.3) return i;
      }
      return -1;
    };
    const onDown = (e) => {
      const rect = c.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
      const y = (e.clientY - rect.top) * (window.devicePixelRatio || 1);
      if (e.metaKey) {
        this.stageState.orbiting = true;
        this.stageState.lastX = x;
        this.stageState.lastY = y;
      } else {
        this.stageState.dragging = pick(x, y);
      }
      e.preventDefault();
    };
    const onMove = (e) => {
      const rect = c.getBoundingClientRect();
      const sx = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
      const sy = (e.clientY - rect.top) * (window.devicePixelRatio || 1);
      if (this.stageState.orbiting) {
        const dx = sx - this.stageState.lastX;
        const dy = sy - this.stageState.lastY;
        this.stageState.lastX = sx;
        this.stageState.lastY = sy;
        const v = this.view3D;
        v.yawDeg += dx * 0.2;
        v.pitchDeg = Math.max(-80, Math.min(80, v.pitchDeg + dy * 0.2));
        this.drawStage();
        return;
      }
      if (this.stageState.dragging < 0) return;
      const w = toWorld(sx, sy);
      const idx = this.stageState.dragging;
      const row = this.rowsRoot.children[idx];
      row.querySelector('[data-role="x"]').value = String(clamp(w.x, BOUNDS.xMin, BOUNDS.xMax).toFixed(2));
      row.querySelector('[data-role="y"]').value = String(clamp(w.y, BOUNDS.yMin, BOUNDS.yMax).toFixed(2));
      row.querySelector('[data-role="x"]').dispatchEvent(new Event('input', { bubbles:true }));
    };
    const onUp = () => { this.stageState.dragging = -1; this.stageState.orbiting = false; };
    c.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    this.toScreen = toScreen;
  }

  drawStage() {
    const c = this.stage; if (!c) return; const ctx = c.getContext('2d');
    ctx.resetTransform();
    ctx.scale(1, 1);
    ctx.clearRect(0, 0, c.width, c.height);

    // draw 3D grid on XY and XZ planes within bounds
    const drawLine3 = (a, b, color) => {
      const pa = this.project3D(a.x, a.y, a.z);
      const pb = this.project3D(b.x, b.y, b.z);
      if (pa.behind && pb.behind) return;
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    };
    // grid lines based on dynamic bounds (10 divisions per axis)
    const xMin = BOUNDS.xMin, xMax = BOUNDS.xMax;
    const yMin = BOUNDS.yMin, yMax = BOUNDS.yMax;
    const zMin = BOUNDS.zMin, zMax = BOUNDS.zMax;
    const xStep = (xMax - xMin) / 10;
    const yStep = (yMax - yMin) / 10;
    const zStep = (zMax - zMin) / 10;
    for (let xi = 0; xi <= 10; xi += 1) {
      const x = xMin + xi * xStep;
      // XY plane (z=0)
      drawLine3({x, y:yMin, z:0}, {x, y:yMax, z:0}, '#1f2937');
      // XZ plane (y=0)
      drawLine3({x, y:0, z:zMin}, {x, y:0, z:zMax}, '#0b1220');
    }
    for (let yi = 0; yi <= 10; yi += 1) {
      const y = yMin + yi * yStep;
      // XY plane (z=0)
      drawLine3({x:xMin, y, z:0}, {x:xMax, y, z:0}, '#1f2937');
    }
    for (let zi = 0; zi <= 10; zi += 1) {
      const z = zMin + zi * zStep;
      // XZ plane (y=0)
      drawLine3({x:xMin, y:0, z}, {x:xMax, y:0, z}, '#0b1220');
    }
    // axes at origin
    drawLine3({x:xMin, y:0, z:0}, {x:xMax, y:0, z:0}, '#ef4444'); // X - red
    drawLine3({x:0, y:yMin, z:0}, {x:0, y:yMax, z:0}, '#22c55e'); // Y - green
    drawLine3({x:0, y:0, z:zMin}, {x:0, y:0, z:zMax}, '#3b82f6'); // Z - blue

    // listener
    const Lp = this.project3D(this.listener.x, this.listener.y, this.listener.z);
    ctx.fillStyle = '#22d3ee'; ctx.beginPath(); ctx.arc(Lp.x, Lp.y, 6, 0, Math.PI*2); ctx.fill();
    // orientation (yaw around Y)
    const yaw = this.listener.yawDeg * Math.PI / 180;
    const fx = Math.cos(yaw), fz = -Math.sin(yaw);
    const tip = this.project3D(this.listener.x + fx, this.listener.y, this.listener.z + fz);
    ctx.strokeStyle = '#22d3ee'; ctx.beginPath(); ctx.moveTo(Lp.x, Lp.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
    // branches
    for (let i = 0; i < this.branch.length; i += 1) {
      const p = this.branch[i].panner;
      const s = this.project3D(p.positionX.value, p.positionY.value, p.positionZ.value);
      ctx.fillStyle = '#a78bfa'; ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, Math.PI*2); ctx.fill();
    }
  }
}

const mixer = new SpatialMixer();

document.getElementById('attachBtn').addEventListener('click', () => {
  try { mixer.attach(); } catch(err) { alert(err.message || String(err)); }
});
document.getElementById('randomAllBtn').addEventListener('click', () => mixer.randomizeAll());

window.addEventListener('beforeunload', () => mixer.detach());

// Listen for randomize trigger from main window
try {
  if (typeof BroadcastChannel !== 'undefined') {
    const ch = new BroadcastChannel('spatial');
    ch.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'randomizeSpatial') {
        try { mixer.randomizeAll(); } catch(_) {}
      }
    };
  }
} catch(_) {}


// Floating Randomize triggers main page randomizer (if available)
(function(){
  const floater = document.getElementById('floatingRandomizeBtn');
  if (!floater) return;
  floater.addEventListener('click', () => {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.document.getElementById('randomizeBtn')?.click();
      } else {
        // As a fallback, trigger local spatial randomize
        mixer.randomizeAll();
      }
    } catch(_) { try { mixer.randomizeAll(); } catch(_) {} }
  });
})();


