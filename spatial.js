const MAX_BRANCHES = 32; // browser channel layout limit for AudioWorkletNode output bus
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
    this.branch = []; // { pan:AudioParam?, panner:PannerNode, gain:GainNode, pos:{x,y,z} }
    this.stageState = { dragging: -1 };
    this.listener = { x:0, y:0, z:0, yawDeg:0 };
    this.rand = cryptoRand;
    this.stereoSum = null;
    this.revConvolver = null;
    this.revWet = null;
    this.revDry = null;
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

    // Reverb bus: dry + wet mix into master
    this.revDry = this.ctx.createGain(); this.revDry.gain.value = 1;
    this.revWet = this.ctx.createGain(); this.revWet.gain.value = 0.2;
    this.revConvolver = this.ctx.createConvolver();
    this.revConvolver.normalize = true;
    // Procedurally build a basic IR so there's sound without loading files
    this.revConvolver.buffer = buildSimpleIR(this.ctx, 2.3);

    this.stereoSum = this.ctx.createGain();
    this.stereoSum.channelCount = 2;
    this.stereoSum.gain.value = 1;
    // Split stereo sum to dry path and wet path
    this.stereoSum.connect(this.revDry);
    this.stereoSum.connect(this.revConvolver);
    this.revConvolver.connect(this.revWet);
    // Mix to master
    this.revDry.connect(this.master);
    this.revWet.connect(this.master);

    // Build per-branch panners
    this.n = Math.min(this.node.parameters.get('nbranches').value | 0, maxCh);
    this.branch = [];
    this.rowsRoot.innerHTML = '';
    for (let i = 0; i < this.n; i += 1) {
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
      splitter.connect(p, i);
      p.connect(g);
      g.connect(this.stereoSum);
      // Default position
      p.positionX.value = 0; p.positionY.value = 0; p.positionZ.value = 0;
      // UI row
      const row = createBranchRow(i);
      this.rowsRoot.appendChild(row);
      const gainEl = row.querySelector('[data-role="gain"]');
      const xEl = row.querySelector('[data-role="x"]');
      const yEl = row.querySelector('[data-role="y"]');
      const zEl = row.querySelector('[data-role="z"]');
      const apply = () => {
        const pos = enforceMinDist({ x: parseFloat(xEl.value), y: parseFloat(yEl.value), z: parseFloat(zEl.value) }, this.listener);
        smoothParam(p.positionX, this.ctx, clamp(pos.x, BOUNDS.xMin, BOUNDS.xMax));
        smoothParam(p.positionY, this.ctx, clamp(pos.y, BOUNDS.yMin, BOUNDS.yMax));
        smoothParam(p.positionZ, this.ctx, clamp(pos.z, BOUNDS.zMin, BOUNDS.zMax));
        smoothParam(g.gain, this.ctx, Math.max(0, Math.min(1, parseFloat(gainEl.value))));
        this.drawStage();
      };
      [gainEl, xEl, yEl, zEl].forEach(el => el.addEventListener('input', apply));
      this.branch.push({ panner: p, gain: g, pos: { x:0, y:0, z:0 } });
    }

    // Mute the original stereo from main so we only hear spatial sum
    this.api.muteMainStereo(true);
    this.setupStage();
    this.wireRoomControls();
    this.wireBypassAndReverb();
    this.drawStage();
  }

  detach() {
    try { this.api && this.api.muteMainStereo(false); } catch(_) {}
  }

  randomizeAll() {
    const seed = document.getElementById('seedInput')?.value || '';
    this.rand = makeRand(seed || undefined);
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

    const updateListener = () => {
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
      this.drawStage();
    };

    bind('lx', (v) => { this.listener.x = clamp(v, BOUNDS.xMin, BOUNDS.xMax); updateListener(); });
    bind('ly', (v) => { this.listener.y = clamp(v, BOUNDS.yMin, BOUNDS.yMax); updateListener(); });
    bind('lz', (v) => { this.listener.z = clamp(v, BOUNDS.zMin, BOUNDS.zMax); updateListener(); });
    bind('yaw', (v) => { this.listener.yawDeg = v; updateListener(); });

    const bindP = (id, fn) => {
      const el = document.getElementById(id);
      if (!el) return;
      const handler = () => {
        const v = parseFloat(el.value);
        for (const b of this.branch) fn(b.panner, v);
      };
      el.addEventListener('input', handler);
      handler();
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

  wireBypassAndReverb() {
    // Bypass HRTF: toggle panningModel between HRTF and equalpower
    const bypassH = document.getElementById('bypassHRTF');
    if (bypassH) {
      const apply = () => {
        const equal = !!bypassH.checked;
        for (const b of this.branch) {
          b.panner.panningModel = equal ? 'equalpower' : 'HRTF';
        }
      };
      bypassH.addEventListener('change', apply);
      apply();
    }

    // Reverb wet and bypass
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

    const bypassR = document.getElementById('bypassReverb');
    if (bypassR) {
      const apply = () => {
        const by = !!bypassR.checked;
        if (this.revWet) this.revWet.gain.setTargetAtTime(by ? 0 : Math.max(0, Math.min(1, parseFloat(document.getElementById('reverbWet').value || '0.2'))), this.ctx.currentTime, 0.02);
      };
      bypassR.addEventListener('change', apply);
      apply();
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
      this.stageState.dragging = pick(x, y);
      e.preventDefault();
    };
    const onMove = (e) => {
      if (this.stageState.dragging < 0) return;
      const rect = c.getBoundingClientRect();
      const sx = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
      const sy = (e.clientY - rect.top) * (window.devicePixelRatio || 1);
      const w = toWorld(sx, sy);
      const idx = this.stageState.dragging;
      const row = this.rowsRoot.children[idx];
      row.querySelector('[data-role="x"]').value = String(clamp(w.x, BOUNDS.xMin, BOUNDS.xMax).toFixed(2));
      row.querySelector('[data-role="y"]').value = String(clamp(w.y, BOUNDS.yMin, BOUNDS.yMax).toFixed(2));
      row.querySelector('[data-role="x"]').dispatchEvent(new Event('input', { bubbles:true }));
    };
    const onUp = () => { this.stageState.dragging = -1; };
    c.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    this.toScreen = toScreen;
  }

  drawStage() {
    const c = this.stage; if (!c) return; const ctx = c.getContext('2d');
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    ctx.resetTransform();
    ctx.scale(1, 1);
    ctx.clearRect(0, 0, c.width, c.height);
    // grid
    ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 1;
    for (let i = -5; i <= 5; i += 1) {
      const p1 = this.toScreen(i, -5), p2 = this.toScreen(i, 5);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      const q1 = this.toScreen(-5, i), q2 = this.toScreen(5, i);
      ctx.beginPath(); ctx.moveTo(q1.x, q1.y); ctx.lineTo(q2.x, q2.y); ctx.stroke();
    }
    // listener
    const L = this.toScreen(this.listener.x, this.listener.y);
    ctx.fillStyle = '#22d3ee'; ctx.beginPath(); ctx.arc(L.x, L.y, 6, 0, Math.PI*2); ctx.fill();
    // orientation
    const yaw = this.listener.yawDeg * Math.PI / 180;
    const fx = Math.cos(yaw), fy = Math.sin(yaw);
    ctx.strokeStyle = '#22d3ee'; ctx.beginPath(); ctx.moveTo(L.x, L.y); ctx.lineTo(L.x + fx*20, L.y - fy*20); ctx.stroke();
    // branches
    for (let i = 0; i < this.branch.length; i += 1) {
      const p = this.branch[i].panner;
      const s = this.toScreen(p.positionX.value, p.positionY.value);
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


