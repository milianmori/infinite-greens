// Spatial binaural mixer using shared AudioContext and 5 HRTF PannerNodes

const NUM_SOURCES = 5;

function getMixerApi() {
  try {
    if (window.opener && window.opener._mixerApi) return window.opener._mixerApi;
  } catch (_) {}
  try {
    if (window._mixerApi) return window._mixerApi;
  } catch (_) {}
  return null;
}

function dbToGain(db) {
  return Math.pow(10, (db || 0) / 20);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Simple vector helpers
function vec3(x=0,y=0,z=0){ return {x,y,z}; }
function length(v){ return Math.hypot(v.x, v.y, v.z); }
function sub(a,b){ return vec3(a.x-b.x, a.y-b.y, a.z-b.z); }
function add(a,b){ return vec3(a.x+b.x, a.y+b.y, a.z+b.z); }
function scale(v,s){ return vec3(v.x*s, v.y*s, v.z*s); }
function lerp(a,b,t){ return vec3(a.x + (b.x-a.x)*t, a.y + (b.y-a.y)*t, a.z + (b.z-a.z)*t); }

// Scene state
const state = {
  attached: false,
  bypass: false,
  ctx: null,
  masterBus: null,
  splitter: null,
  drySum: null,
  dryOut: null,
  wetSum: null,
  wetLPF: null,
  wetGain: null,
  outSum: null,
  convolver: null,
  erTaps: [],
  sources: [], // { inL, inR, inSum, userGain, panner, pos }
  listener: { pos: vec3(0,0,0) },
  camera: { yaw: 0.6, pitch: -0.15, zoom: 1, panX: 0, panY: 0 },
  automation: {
    enabled: false,
    speed: 1.0,
    approachDist: 0.5,
    pauseTime: 0.5,
    jitter: 0.05,
    phase: 'seek', // 'seek' | 'pause'
    targetIndex: 0,
    lastSwitchTime: 0
  }
};

function ensureContext() {
  const api = getMixerApi();
  if (!api) throw new Error('Main window not available. Start audio on index.html first.');
  const ctx = api.getContext();
  const masterBus = api.getMasterBus();
  if (!ctx || !masterBus) throw new Error('AudioContext or master bus not available.');
  state.ctx = ctx;
  state.masterBus = masterBus;
}

function createIR(seconds, sampleRate) {
  const len = Math.max(1, Math.floor((seconds || 2.5) * (sampleRate || 44100)));
  const buf = state.ctx.createBuffer(2, len, state.ctx.sampleRate);
  for (let c = 0; c < 2; c += 1) {
    const ch = buf.getChannelData(c);
    let amp = 1.0;
    for (let i = 0; i < len; i += 1) {
      // Pink-ish noise tail with exponential decay
      const t = i / len;
      const decay = Math.pow(1 - t, 2.0);
      amp *= 0.9995; // slight additional drop
      const n = ((Math.random() * 2 - 1) + (Math.random() * 2 - 1) * 0.5);
      ch[i] = n * decay * amp * 0.5;
    }
  }
  return buf;
}

function buildGraph() {
  ensureContext();
  const ctx = state.ctx;

  // Disconnect direct route to speakers
  try { state.masterBus.disconnect(); } catch (_) {}

  // Split master stereo into L/R
  const splitter = ctx.createChannelSplitter(2);
  state.masterBus.connect(splitter);
  state.splitter = splitter;

  // Sums
  const drySum = ctx.createGain(); drySum.gain.value = 1;
  const dryOut = ctx.createGain(); dryOut.gain.value = 1; // post-dry user mix
  const wetSum = ctx.createGain(); wetSum.gain.value = 1;
  const wetLPF = ctx.createBiquadFilter(); wetLPF.type = 'lowpass'; wetLPF.frequency.value = 16000;
  const wetGain = ctx.createGain(); wetGain.gain.value = 0.0; // mix + distance drives this
  const outSum = ctx.createGain(); outSum.gain.value = 1;
  state.drySum = drySum; state.dryOut = dryOut; state.wetSum = wetSum; state.wetLPF = wetLPF; state.wetGain = wetGain; state.outSum = outSum;

  // Build 5 sources: mono-sum L+R -> userGain -> HRTF panner -> drySum
  const sources = [];
  for (let i = 0; i < NUM_SOURCES; i += 1) {
    const inL = ctx.createGain(); inL.gain.value = 0.5; // half for L
    const inR = ctx.createGain(); inR.gain.value = 0.5; // half for R
    const inSum = ctx.createGain(); inSum.channelCount = 1; inSum.channelCountMode = 'explicit'; inSum.gain.value = 1;
    splitter.connect(inL, 0);
    splitter.connect(inR, 1);
    inL.connect(inSum);
    inR.connect(inSum);
    const userGain = ctx.createGain(); userGain.gain.value = 1 / NUM_SOURCES; // even distribution by default
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.positionX.value = 0; p.positionY.value = 0; p.positionZ.value = -1;
    p.orientationX.value = 0; p.orientationY.value = 0; p.orientationZ.value = -1;
    inSum.connect(userGain);
    userGain.connect(p);
    p.connect(drySum);
    sources.push({ inL, inR, inSum, userGain, baseGain: userGain.gain.value, solo: false, panner: p, pos: vec3(0,0,-1) });
  }
  state.sources = sources;

  // Early reflections network (parallel short delays)
  const erOut = ctx.createGain(); erOut.gain.value = 1;
  const erTimes = [0.007, 0.013, 0.021, 0.034];
  const erGains = [0.5, 0.35, 0.25, 0.18];
  const erTaps = [];
  for (let i = 0; i < erTimes.length; i += 1) {
    const tapGain = ctx.createGain(); tapGain.gain.value = erGains[i];
    const del = ctx.createDelay(0.1); del.delayTime.value = erTimes[i];
    drySum.connect(del);
    del.connect(tapGain);
    tapGain.connect(erOut);
    erTaps.push({ del, tapGain });
  }
  state.erTaps = erTaps;

  // Convolver tail
  const convolver = ctx.createConvolver();
  convolver.normalize = true;
  convolver.buffer = createIR(2.5, ctx.sampleRate);
  state.convolver = convolver;
  drySum.connect(convolver);

  // Wet chain: (ER + Tail) -> wetLPF -> wetGain -> outSum
  erOut.connect(wetSum);
  convolver.connect(wetSum);
  wetSum.connect(wetLPF);
  wetLPF.connect(wetGain);
  wetGain.connect(outSum);

  // Dry chain: drySum -> dryOut -> outSum
  drySum.connect(dryOut);
  dryOut.connect(outSum);

  // Output to speakers
  outSum.connect(ctx.destination);

  // Initialize listener orientation
  try {
    const L = ctx.listener;
    L.forwardX.value = 0; L.forwardY.value = 0; L.forwardZ.value = -1;
    L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    L.positionX.value = 0; L.positionY.value = 0; L.positionZ.value = 0;
  } catch (_) {}
}

function updateSoloGains() {
  if (!state.ctx) return;
  const anySolo = state.sources.some(s => s.solo);
  const at = state.ctx.currentTime;
  state.sources.forEach(s => {
    const target = anySolo ? (s.solo ? s.baseGain : 0) : s.baseGain;
    s.userGain.gain.setTargetAtTime(target, at, 0.02);
  });
}

function attachSpatial() {
  if (state.attached) return;
  buildGraph();
  state.attached = true;
  state.bypass = false;
  updateAllFromUI();
}

function setBypass(on) {
  if (!state.ctx || !state.masterBus) return;
  state.bypass = !!on;
  const ctx = state.ctx;
  // Disconnect all outputs first
  try { if (state.outSum) state.outSum.disconnect(); } catch (_) {}
  try { state.masterBus.disconnect(); } catch (_) {}
  if (state.bypass) {
    // Direct route: master -> destination
    state.masterBus.connect(ctx.destination);
  } else {
    // Reattach spatial graph, building if needed
    if (!state.attached) buildGraph();
    if (state.outSum) state.outSum.connect(ctx.destination);
  }
}

// UI wiring
function getEl(id){ return document.getElementById(id); }

function buildSourceControls() {
  const root = getEl('sources');
  root.innerHTML = '';
  state.sources.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    const h = document.createElement('h4'); h.textContent = 'Source ' + (i+1); h.style.margin = '0 0 8px'; card.appendChild(h);
    const mk = (label, id, min, max, step, val) => {
      const row = document.createElement('div'); row.className = 'row';
      const lab = document.createElement('label'); lab.textContent = label; row.appendChild(lab);
      const rng = document.createElement('input'); rng.type = 'range'; rng.min = String(min); rng.max = String(max); rng.step = String(step); rng.value = String(val);
      rng.id = id;
      row.appendChild(rng);
      return { row, rng };
    };
    const gain = mk('Gain', `g${i}`, 0, 2, 0.01, s.baseGain != null ? s.baseGain : s.userGain.gain.value);
    const x = mk('X', `x${i}`, -5, 5, 0.01, s.pos.x);
    const y = mk('Y', `y${i}`, -5, 5, 0.01, s.pos.y);
    const z = mk('Z', `z${i}`, -2, 2, 0.01, s.pos.z);
    card.appendChild(gain.row); card.appendChild(x.row); card.appendChild(y.row); card.appendChild(z.row);
    // Solo toggle
    const soloRow = document.createElement('div'); soloRow.className = 'row';
    const soloLab = document.createElement('label'); soloLab.textContent = 'Solo'; soloRow.appendChild(soloLab);
    const soloCb = document.createElement('input'); soloCb.type = 'checkbox'; soloCb.checked = !!s.solo; soloRow.appendChild(soloCb);
    card.appendChild(soloRow);

    gain.rng.addEventListener('input', () => { s.baseGain = parseFloat(gain.rng.value); updateSoloGains(); });
    x.rng.addEventListener('input', () => { s.pos.x = parseFloat(x.rng.value); s.panner.positionX.setTargetAtTime(s.pos.x, state.ctx.currentTime, 0.02); });
    y.rng.addEventListener('input', () => { s.pos.y = parseFloat(y.rng.value); s.panner.positionY.setTargetAtTime(s.pos.y, state.ctx.currentTime, 0.02); });
    z.rng.addEventListener('input', () => { s.pos.z = parseFloat(z.rng.value); s.panner.positionZ.setTargetAtTime(s.pos.z, state.ctx.currentTime, 0.02); });
    soloCb.addEventListener('change', () => { s.solo = !!soloCb.checked; updateSoloGains(); });
    root.appendChild(card);
  });
  // Ensure current solo state is enforced
  updateSoloGains();
}

function updateGlobalsFromUI() {
  const vals = {
    refDistance: parseFloat(getEl('refDistance').value),
    rolloffFactor: parseFloat(getEl('rolloffFactor').value),
    maxDistance: parseFloat(getEl('maxDistance').value),
    coneInner: parseFloat(getEl('coneInner').value),
    coneOuter: parseFloat(getEl('coneOuter').value),
    coneOuterGain: parseFloat(getEl('coneOuterGain').value),
    reverbMix: parseFloat(getEl('reverbMix').value) / 100,
    reverbGainDb: parseFloat(getEl('reverbGain').value),
    reverbSize: parseFloat(getEl('reverbSize').value),
    hfDamp: parseFloat(getEl('hfDamp').value)
  };
  (['refDistanceVal','rolloffVal','maxDistanceVal','coneInVal','coneOutVal','coneGainVal','revMixVal','revGainVal','revSizeVal','hfDampVal']).forEach(id => {
    const map = {
      refDistanceVal: vals.refDistance,
      rolloffVal: vals.rolloffFactor,
      maxDistanceVal: vals.maxDistance,
      coneInVal: vals.coneInner,
      coneOutVal: vals.coneOuter,
      coneGainVal: vals.coneOuterGain,
      revMixVal: Math.round(vals.reverbMix * 100),
      revGainVal: vals.reverbGainDb,
      revSizeVal: vals.reverbSize,
      hfDampVal: vals.hfDamp
    };
    const el = getEl(id); if (el) el.textContent = String(map[id]);
  });
  // Apply to nodes
  state.sources.forEach(s => {
    const p = s.panner;
    p.refDistance = vals.refDistance;
    p.rolloffFactor = vals.rolloffFactor;
    p.maxDistance = vals.maxDistance;
    p.coneInnerAngle = vals.coneInner;
    p.coneOuterAngle = vals.coneOuter;
    p.coneOuterGain = vals.coneOuterGain;
  });
  // Wet controls
  state.wetLPF.frequency.setTargetAtTime(vals.hfDamp, state.ctx.currentTime, 0.05);
  // Convolver size update (regenerate IR if significant change)
  if (state.convolver && Math.abs((state.convolver.buffer?.length || 0) / state.ctx.sampleRate - vals.reverbSize) > 0.05) {
    state.convolver.buffer = createIR(vals.reverbSize, state.ctx.sampleRate);
  }
  // Store UI values for later dynamic wet calc
  state.__ui = vals;
}

function updateAllFromUI() {
  buildSourceControls();
  updateGlobalsFromUI();
}

function nearestSourceDistance() {
  let minD = Infinity;
  for (const s of state.sources) {
    const d = length(sub(s.pos, state.listener.pos));
    if (d < minD) minD = d;
  }
  if (!isFinite(minD)) minD = 1;
  return minD;
}

function updateDynamicWet() {
  if (!state.wetGain || !state.dryOut) return; // graph not attached yet
  const d = nearestSourceDistance();
  const mix = (state.__ui?.reverbMix != null) ? state.__ui.reverbMix : 0.3;
  // Map distance to [0,1] roughly over 0.2..10 meters
  const norm = clamp((d - 0.2) / (10 - 0.2), 0, 1);
  const inv = 1 - norm; // closer -> more wet per requirement
  const wetLevel = mix * inv;
  const wetDb = (state.__ui?.reverbGainDb || 0);
  state.wetGain.gain.setTargetAtTime(dbToGain(wetDb) * wetLevel, state.ctx.currentTime, 0.05);
  // Dry scaled complementarily
  if (state.dryOut) state.dryOut.gain.setTargetAtTime(1 - mix * 0.6, state.ctx.currentTime, 0.05);
}

// Automation: move listener center -> nearest -> next -> loop
function stepAutomation(dt) {
  if (!state.automation.enabled) return;
  const now = state.ctx.currentTime;
  const a = state.automation;
  // Ensure target index exists
  if (a.targetIndex == null || a.targetIndex < 0 || a.targetIndex >= state.sources.length) {
    a.targetIndex = 0;
  }
  const target = state.sources[a.targetIndex]?.pos || vec3(0,0,0);
  const toT = sub(target, state.listener.pos);
  const dist = length(toT);
  if (a.phase === 'pause') {
    if (now - a.lastSwitchTime >= a.pauseTime) {
      a.phase = 'seek';
      a.lastSwitchTime = now;
      a.targetIndex = (a.targetIndex + 1) % state.sources.length;
    }
    return;
  }
  // Seek
  const step = Math.max(0.0001, a.speed) * dt;
  const dir = (dist > 0.0001) ? scale(toT, 1 / dist) : vec3(0,0,0);
  // jitter
  const jit = scale(vec3((Math.random()*2-1), (Math.random()*2-1), (Math.random()*2-1)), a.jitter);
  const move = add(scale(dir, step), jit);
  state.listener.pos = add(state.listener.pos, move);
  // Arrived?
  if (dist <= a.approachDist) {
    a.phase = 'pause';
    a.lastSwitchTime = now;
  }
}

function updateListenerNode() {
  const L = state.ctx.listener;
  const p = state.listener.pos;
  L.positionX.setTargetAtTime(p.x, state.ctx.currentTime, 0.03);
  L.positionY.setTargetAtTime(p.y, state.ctx.currentTime, 0.03);
  L.positionZ.setTargetAtTime(p.z, state.ctx.currentTime, 0.03);
}

// 3D canvas
const scene = {
  el: null,
  dragging: false,
  lastX: 0,
  lastY: 0,
  cmdDrag: false
};

function toScreen(v) {
  const { yaw, pitch, zoom, panX, panY } = state.camera;
  // Rotate around Y (yaw), then X (pitch)
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cx = Math.cos(pitch), sx = Math.sin(pitch);
  // Yaw
  let x = v.x * cy - v.z * sy;
  let z = v.x * sy + v.z * cy;
  let y = v.y;
  // Pitch
  let y2 = y * cx - z * sx;
  let z2 = y * sx + z * cx;
  // Simple perspective
  const d = 6 / (z2 + 10);
  return { x: (x * d * 60 * zoom) + panX, y: (y2 * d * 60 * zoom) + panY };
}

function drawScene() {
  const cvs = scene.el; if (!cvs) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cvs.clientWidth, h = cvs.clientHeight;
  if (cvs.width !== Math.floor(w*dpr) || cvs.height !== Math.floor(h*dpr)) {
    cvs.width = Math.floor(w*dpr); cvs.height = Math.floor(h*dpr);
  }
  const ctx2d = cvs.getContext('2d');
  ctx2d.setTransform(dpr,0,0,dpr,0,0);
  ctx2d.clearRect(0,0,w,h);
  // Grid
  ctx2d.strokeStyle = '#1f2633'; ctx2d.lineWidth = 1;
  for (let gx=-5; gx<=5; gx+=1) {
    const a = toScreen(vec3(gx,0,-5)); const b = toScreen(vec3(gx,0,5));
    ctx2d.beginPath(); ctx2d.moveTo(w/2+a.x, h/2+a.y); ctx2d.lineTo(w/2+b.x, h/2+b.y); ctx2d.stroke();
  }
  for (let gz=-5; gz<=5; gz+=1) {
    const a = toScreen(vec3(-5,0,gz)); const b = toScreen(vec3(5,0,gz));
    ctx2d.beginPath(); ctx2d.moveTo(w/2+a.x, h/2+a.y); ctx2d.lineTo(w/2+b.x, h/2+b.y); ctx2d.stroke();
  }
  // Listener
  const lp = toScreen(state.listener.pos);
  ctx2d.fillStyle = '#22c55e';
  ctx2d.beginPath(); ctx2d.arc(w/2+lp.x, h/2+lp.y, 6, 0, Math.PI*2); ctx2d.fill();
  // Sources
  ctx2d.fillStyle = '#9ca3af';
  state.sources.forEach((s,i) => {
    const sp = toScreen(s.pos);
    ctx2d.beginPath(); ctx2d.arc(w/2+sp.x, h/2+sp.y, 5, 0, Math.PI*2); ctx2d.fill();
    ctx2d.fillStyle = '#cbd5e1'; ctx2d.font = '12px system-ui'; ctx2d.fillText(String(i+1), w/2+sp.x+6, h/2+sp.y-6);
    ctx2d.fillStyle = '#9ca3af';
  });
}

function animate(ts) {
  if (!state.ctx) return;
  const now = state.ctx.currentTime;
  if (!animate.__last) animate.__last = now;
  const dt = Math.max(0, Math.min(0.1, now - animate.__last));
  animate.__last = now;
  stepAutomation(dt);
  updateListenerNode();
  if (state.attached) updateDynamicWet();
  drawScene();
  requestAnimationFrame(animate);
}

function randomizeScatter() {
  const targetPositions = [];
  for (let i = 0; i < state.sources.length; i += 1) {
    targetPositions.push(vec3(
      (Math.random()*10 - 5),
      (Math.random()*10 - 5),
      (Math.random()*4 - 2)
    ));
  }
  const start = performance.now();
  const D = 800; // ms
  const startPos = state.sources.map(s => ({...s.pos}));
  function step() {
    const t = clamp((performance.now() - start) / D, 0, 1);
    for (let i = 0; i < state.sources.length; i += 1) {
      const p = lerp(startPos[i], targetPositions[i], t);
      state.sources[i].pos = p;
      const panner = state.sources[i].panner;
      const at = state.ctx.currentTime;
      panner.positionX.setTargetAtTime(p.x, at, 0.02);
      panner.positionY.setTargetAtTime(p.y, at, 0.02);
      panner.positionZ.setTargetAtTime(p.z, at, 0.02);
    }
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function wireUI() {
  const attachBtn = getEl('attachBtn');
  const bypassBtn = getEl('bypassBtn');
  const zoom = getEl('zoom');
  const auto = getEl('autoMove');
  const speed = getEl('speed');
  const approach = getEl('approachDist');
  const pause = getEl('pauseTime');
  const jitter = getEl('jitter');
  const floater = getEl('floatingRandomizeBtn');

  if (attachBtn) attachBtn.addEventListener('click', attachSpatial);
  if (bypassBtn) bypassBtn.addEventListener('click', () => setBypass(true));

  if (zoom) zoom.addEventListener('input', () => { state.camera.zoom = parseFloat(zoom.value); getEl('zoomVal').textContent = zoom.value; });
  if (auto) auto.addEventListener('change', () => { state.automation.enabled = !!auto.checked; });
  if (speed) speed.addEventListener('input', () => { state.automation.speed = parseFloat(speed.value); getEl('speedVal').textContent = speed.value; });
  if (approach) approach.addEventListener('input', () => { state.automation.approachDist = parseFloat(approach.value); getEl('approachVal').textContent = approach.value; });
  if (pause) pause.addEventListener('input', () => { state.automation.pauseTime = parseFloat(pause.value); getEl('pauseVal').textContent = pause.value; });
  if (jitter) jitter.addEventListener('input', () => { state.automation.jitter = parseFloat(jitter.value); getEl('jitterVal').textContent = jitter.value; });

  // Globals
  ['refDistance','rolloffFactor','maxDistance','coneInner','coneOuter','coneOuterGain','reverbMix','reverbGain','reverbSize','hfDamp']
    .forEach(id => {
      const el = getEl(id);
      if (!el) return;
      el.addEventListener('input', updateGlobalsFromUI);
    });

  // Canvas interactions
  scene.el = getEl('scene');
  if (scene.el) {
    const el = scene.el;
    el.addEventListener('mousedown', (e) => {
      scene.dragging = true; scene.lastX = e.clientX; scene.lastY = e.clientY; scene.cmdDrag = !!e.metaKey;
    });
    window.addEventListener('mouseup', () => { scene.dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (!scene.dragging) return;
      const dx = e.clientX - scene.lastX; const dy = e.clientY - scene.lastY;
      scene.lastX = e.clientX; scene.lastY = e.clientY;
      if (scene.cmdDrag) {
        state.camera.panX += dx; state.camera.panY += dy;
      } else {
        state.camera.yaw += dx * 0.01; state.camera.pitch += dy * 0.01;
        state.camera.pitch = clamp(state.camera.pitch, -1.2, 1.2);
      }
    });
  }

  // Randomize button: scatter spatial sources and also trigger main Randomizer
  if (floater) floater.addEventListener('click', () => {
    randomizeScatter();
    try { if (window.opener && !window.opener.closed) window.opener.document.getElementById('randomizeBtn')?.click(); } catch (_) {}
  });
}

function init() {
  try {
    ensureContext();
  } catch (e) {
    console.warn(e.message);
    // keep UI usable, but attach will fail until main is started
  }
  // Build an initial graph only after attach to avoid hijacking audio without intent
  wireUI();
  requestAnimationFrame(animate);
}

// Kick off
init();


