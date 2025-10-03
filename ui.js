import { ResonatorNode } from './resonator-node.js';

let context = null;
let node = null;

const MAX = 40;

// ----- Cross-tab exciter control (BroadcastChannel) -----
const EXCITER_IDS = [
  'noiseLevel',
  'noiseType',
  'lfoEnabled',
  'lfoRate',
  'lfoDepth',
  'lfoWave',
  'exciterCutoff',
  'exciterHP',
  'exciterBandQ',
  'monitorExciter',
  // Raindrop
  'rainEnabled',
  'rainGain',
  'rainRate',
  'rainDurMs',
  'rainSpread',
  'rainCenter',
  'rainLimbs'
];

let isApplyingRemote = false;
let bc = null;

function getEl(id) { return document.getElementById(id); }

function setParamById(id, value) {
  if (!node || !context) return;
  const t = context.currentTime;
  switch (id) {
    case 'noiseLevel': node.noiseLevel && node.noiseLevel.setValueAtTime(parseFloat(value), t); break;
    case 'noiseType': node.noiseType && node.noiseType.setValueAtTime(parseInt(value, 10), t); break;
    case 'lfoEnabled': node.lfoEnabled && node.lfoEnabled.setValueAtTime(value ? 1 : 0, t); break;
    case 'lfoRate': node.lfoRate && node.lfoRate.setValueAtTime(parseFloat(value), t); break;
    case 'lfoDepth': node.lfoDepth && node.lfoDepth.setValueAtTime(parseFloat(value), t); break;
    case 'lfoWave': node.lfoWave && node.lfoWave.setValueAtTime(parseInt(value, 10), t); break;
    case 'exciterCutoff': node.exciterCutoff && node.exciterCutoff.setValueAtTime(parseFloat(value), t); break;
    case 'exciterHP': node.exciterHP && node.exciterHP.setValueAtTime(parseFloat(value), t); break;
    case 'exciterBandQ': node.exciterBandQ && node.exciterBandQ.setValueAtTime(parseFloat(value), t); break;
    case 'monitorExciter': node.monitorExciter && node.monitorExciter.setValueAtTime(value ? 1 : 0, t); break;
    // Raindrop params
    case 'rainEnabled': node.rainEnabled && node.rainEnabled.setValueAtTime(value ? 1 : 0, t); break;
    case 'rainGain': node.rainGain && node.rainGain.setValueAtTime(parseFloat(value), t); break;
    case 'rainRate': node.rainRate && node.rainRate.setValueAtTime(parseFloat(value), t); break;
    case 'rainDurMs': node.rainDurMs && node.rainDurMs.setValueAtTime(parseFloat(value), t); break;
    case 'rainSpread': node.rainSpread && node.rainSpread.setValueAtTime(parseFloat(value), t); break;
    case 'rainCenter': node.rainCenter && node.rainCenter.setValueAtTime(parseFloat(value), t); break;
    case 'rainLimbs': node.rainLimbs && node.rainLimbs.setValueAtTime(parseInt(value, 10), t); break;
  }
}

function getExciterState() {
  const state = {};
  for (const id of EXCITER_IDS) {
    const el = getEl(id);
    if (!el) {
      // If control isn't present in this tab, include current node value for key params
      if (id === 'noiseLevel' && node && node.noiseLevel) state[id] = node.noiseLevel.value;
      continue;
    }
    if (el.type === 'checkbox') state[id] = !!el.checked;
    else state[id] = el.value;
  }
  return state;
}

function broadcastState(partial) {
  if (!bc) return;
  const state = partial || getExciterState();
  bc.postMessage({ type: 'state', source: 'main', state, partial: !!partial });
}

function applyControlFromRemote(id, value) {
  const el = getEl(id);
  if (!el) {
    // If control isn't present in this tab, apply directly to node
    setParamById(id, value);
    return;
  }
  isApplyingRemote = true;
  try {
    if (el.type === 'checkbox') {
      el.checked = !!value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.value = String(value);
      // range/select both fire 'input' or 'change'; prefer input for ranges
      const evtType = (el.tagName === 'SELECT') ? 'change' : 'input';
      el.dispatchEvent(new Event(evtType, { bubbles: true }));
    }
  } finally {
    isApplyingRemote = false;
  }
}

function setupBroadcastChannel() {
  if (bc) return;
  if (typeof BroadcastChannel === 'undefined') return;
  bc = new BroadcastChannel('exciter-controls');
  bc.onmessage = (event) => {
    const data = event.data || {};
    if (data.source === 'main') return; // ignore self
    if (data.type === 'set' && data.id) {
      applyControlFromRemote(data.id, data.value);
    } else if (data.type === 'setMultiple' && data.values) {
      const entries = Object.entries(data.values);
      for (const [id, value] of entries) applyControlFromRemote(id, value);
    } else if (data.type === 'requestState') {
      broadcastState();
    }
  };

  // Broadcast local changes from exciter controls
  for (const id of EXCITER_IDS) {
    const el = getEl(id);
    if (!el) continue;
    const handler = () => {
      if (isApplyingRemote) return;
      const value = (el.type === 'checkbox') ? !!el.checked : el.value;
      broadcastState({ [id]: value });
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  }
}

// Frequency slider mapping (logarithmic)
const FREQ_MIN_HZ = 25;
const FREQ_MAX_HZ = 8000;

function hzToNorm(hz) {
  const min = FREQ_MIN_HZ;
  const max = FREQ_MAX_HZ;
  const safeHz = Math.min(Math.max(hz, min), max);
  return Math.log(safeHz / min) / Math.log(max / min);
}

function normToHz(norm) {
  const min = FREQ_MIN_HZ;
  const max = FREQ_MAX_HZ;
  const clamped = Math.min(Math.max(norm, 0), 1);
  return min * Math.pow(max / min, clamped);
}

function randRange(min, max) {
  return Math.random() * (max - min) + min;
}

function round2(x) { return Math.round(x * 100) / 100; }

function buildBranchRow(i) {
  const row = document.createElement('div');
  row.className = 'grid row';
  row.dataset.index = String(i);

  const idx = document.createElement('span');
  idx.textContent = String(i + 1);
  row.appendChild(idx);

  const freq = document.createElement('input');
  freq.type = 'range';
  freq.min = '0';
  freq.max = '1';
  freq.step = '0.001';
  freq.value = String(hzToNorm(440));
  freq.dataset.role = 'freq';
  row.appendChild(freq);

  const decay = document.createElement('input');
  decay.type = 'range';
  decay.min = '50';
  decay.max = '3000';
  decay.step = '1';
  decay.value = '400';
  decay.dataset.role = 'decay';
  row.appendChild(decay);

  const amp = document.createElement('input');
  amp.type = 'range';
  amp.min = '0';
  amp.max = '1';
  amp.step = '0.001';
  amp.value = '0.2';
  amp.dataset.role = 'amp';
  row.appendChild(amp);

  const pan = document.createElement('input');
  pan.type = 'range';
  pan.min = '-1';
  pan.max = '1';
  pan.step = '0.001';
  pan.value = '0';
  pan.dataset.role = 'pan';
  row.appendChild(pan);

  const onInput = () => {
    if (!node) return;
    const params = {
      freq: normToHz(parseFloat(freq.value)),
      decay: parseFloat(decay.value),
      amp: parseFloat(amp.value),
      pan: parseFloat(pan.value)
    };
    node.setBranchParams(i, params);
  };

  freq.addEventListener('input', onInput);
  decay.addEventListener('input', onInput);
  amp.addEventListener('input', onInput);
  pan.addEventListener('input', onInput);

  return row;
}

function setBranchesVisible(count) {
  const rows = document.querySelectorAll('#branches .row');
  rows.forEach((row, idx) => {
    row.style.display = idx < count ? 'grid' : 'none';
  });
}

function randomize(count) {
  const branches = [];
  const rows = document.querySelectorAll('#branches .row');
  for (let i = 0; i < count; i += 1) {
    const freq = Math.round(randRange(100, 2000));
    const decay = Math.round(randRange(100, 800));
    const amp = round2(randRange(0.005, 0.05));
    const pan = randRange(-1, 1);
    branches.push({ freq, decay, amp, pan });

    const row = rows[i];
    row.querySelector('input[data-role="freq"]').value = String(hzToNorm(freq));
    row.querySelector('input[data-role="decay"]').value = String(decay);
    row.querySelector('input[data-role="amp"]').value = String(amp);
    row.querySelector('input[data-role="pan"]').value = String(pan);
  }
  if (node) node.setAllBranches(branches);
}

function resetDefaults() {
  const n = parseInt(document.getElementById('nbranches').value, 10) || 4;
  const rows = document.querySelectorAll('#branches .row');
  const branches = [];
  for (let i = 0; i < n; i += 1) {
    const row = rows[i];
    const freqNorm = parseFloat(row.querySelector('input[data-role="freq"]').value);
    const decay = parseFloat(row.querySelector('input[data-role="decay"]').value);
    const pan = parseFloat(row.querySelector('input[data-role="pan"]').value);
    const ampEl = row.querySelector('input[data-role="amp"]');
    if (ampEl) ampEl.value = '0.2';
    branches.push({ freq: normToHz(freqNorm), decay, amp: 0.2, pan });
  }
  if (node) node.setAllBranches(branches);
  updateValueLabels();
}

function updateValueLabels() {
  const get = (id) => document.getElementById(id);
  if (get('noiseLevel')) get('noiseLevelVal').textContent = Number(get('noiseLevel').value).toFixed(2);
  get('rmixVal').textContent = Number(get('rmix').value).toFixed(2);
  get('nbranchesVal').textContent = get('nbranches').value;
  get('freqScaleVal').textContent = Number(get('freqScale').value).toFixed(2);
  if (get('octaves')) get('octavesVal').textContent = String(parseInt(get('octaves').value, 10));
  if (get('burstRate')) get('burstRateVal').textContent = Number(get('burstRate').value).toFixed(2);
  if (get('burstDurMs')) get('burstDurMsVal').textContent = get('burstDurMs').value;
  if (get('impulseGain')) get('impulseGainVal').textContent = Number(get('impulseGain').value).toFixed(2);
  if (get('exciterHP')) get('exciterHPVal').textContent = get('exciterHP').value;
  get('freqCenterVal').textContent = get('freqCenter').value;
  get('decayScaleVal').textContent = Number(get('decayScale').value).toFixed(2);
  if (get('groupSplit')) get('groupSplitVal').textContent = String(parseInt(get('groupSplit').value, 10));
  if (get('exciterBandQ')) get('exciterBandQVal').textContent = get('exciterBandQ').value;
  if (get('rainRate')) get('rainRateVal').textContent = Number(get('rainRate').value).toFixed(2);
  if (get('rainDurMs')) get('rainDurMsVal').textContent = get('rainDurMs').value;
  if (get('rainGain')) get('rainGainVal').textContent = Number(get('rainGain').value).toFixed(2);
  if (get('rainSpread')) get('rainSpreadVal').textContent = Number(get('rainSpread').value).toFixed(2);
  if (get('rainCenter')) get('rainCenterVal').textContent = Number(get('rainCenter').value).toFixed(2);
  if (get('rainLimbs')) get('rainLimbsVal').textContent = get('rainLimbs').value;
}

async function startAudio() {
  if (context) return;
  context = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: 44100,
    latencyHint: 'playback'
  });
  node = await ResonatorNode.create(context);
  node.connect(context.destination);
  console.info('AudioContext started', { sampleRate: context.sampleRate, baseLatency: context.baseLatency });

  // Wire global sliders
  const $ = (id) => document.getElementById(id);
  const sliders = ['rmix', 'nbranches', 'freqScale', 'octaves', 'freqCenter', 'decayScale', 'groupSplit'];
  // Exciter controls may live in a separate tab now; guard for missing elements
  const optional = ['noiseType', 'lfoRate', 'lfoDepth', 'exciterCutoff', 'exciterHP', 'exciterBandQ', 'rainRate', 'rainDurMs', 'rainGain', 'rainSpread', 'rainCenter', 'rainLimbs'];
  for (const id of optional) { if (document.getElementById(id)) sliders.push(id); }
  sliders.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      updateValueLabels();
      if (!node) return;
      const t = context.currentTime;
      switch (id) {
        case 'noiseLevel': node.noiseLevel.setValueAtTime(parseFloat(el.value), t); break;
        case 'noiseType': node.noiseType.setValueAtTime(parseInt(el.value, 10), t); break;
        case 'rmix': node.rmix.setValueAtTime(parseFloat(el.value), t); break;
        case 'nbranches': {
          const n = parseInt(el.value, 10);
          node.nbranches.setValueAtTime(n, t);
          setBranchesVisible(n);
          // Clamp groupSplit slider to n
          const gs = document.getElementById('groupSplit');
          if (gs) {
            gs.max = String(n);
            if (parseInt(gs.value, 10) > n) gs.value = String(n);
          }
          break;
        }
        case 'freqScale': node.freqScale.setValueAtTime(parseFloat(el.value), t); break;
        case 'octaves': node.octaves.setValueAtTime(parseInt(el.value, 10), t); break;
        case 'exciterCutoff': node.exciterCutoff.setValueAtTime(parseFloat(el.value), t); break;
        case 'exciterHP': node.exciterHP.setValueAtTime(parseFloat(el.value), t); break;
        case 'burstRate': node.burstRate.setValueAtTime(parseFloat(el.value), t); break;
        case 'burstDurMs': node.burstDurMs.setValueAtTime(parseFloat(el.value), t); break;
        case 'impulseGain': node.impulseGain.setValueAtTime(parseFloat(el.value), t); break;
        case 'freqCenter': node.freqCenter.setValueAtTime(parseFloat(el.value), t); break;
        case 'decayScale': node.decayScale.setValueAtTime(parseFloat(el.value), t); break;
        case 'exciterBandQ': node.exciterBandQ.setValueAtTime(parseFloat(el.value), t); break;
        case 'groupSplit': node.groupSplit.setValueAtTime(parseInt(el.value, 10), t); break;
      }
    });
  });
  const groupEnableEl = document.getElementById('groupEnabled');
  if (groupEnableEl) {
    groupEnableEl.addEventListener('change', () => {
      if (!node) return;
      node.groupEnabled.setValueAtTime(groupEnableEl.checked ? 1 : 0, context.currentTime);
    });
  }

  // Raindrop enable checkbox
  const rainEnableEl = document.getElementById('rainEnabled');
  if (rainEnableEl) {
    rainEnableEl.addEventListener('change', () => {
      if (!node) return;
      node.rainEnabled.setValueAtTime(rainEnableEl.checked ? 1 : 0, context.currentTime);
    });
  }

  // LFO enable and wave selects (change events)
  const lfoEnableEl = document.getElementById('lfoEnabled');
  if (lfoEnableEl) {
    lfoEnableEl.addEventListener('change', () => {
      if (!node) return;
      node.lfoEnabled.setValueAtTime(lfoEnableEl.checked ? 1 : 0, context.currentTime);
    });
  }
  const lfoWaveEl = document.getElementById('lfoWave');
  if (lfoWaveEl) {
    lfoWaveEl.addEventListener('change', () => {
      if (!node) return;
      node.lfoWave.setValueAtTime(parseInt(lfoWaveEl.value, 10), context.currentTime);
    });
  }

  const mon = document.getElementById('monitorExciter');
  if (mon) {
    mon.addEventListener('change', () => {
      if (!node) return;
      node.monitorExciter.setValueAtTime(mon.checked ? 1 : 0, context.currentTime);
    });
  }

  // Scale selectors -> send to processor and toggle quantize param
  const scaleRootSel = document.getElementById('scaleRoot');
  const scaleNameSel = document.getElementById('scaleName');
  const sendScale = () => {
    if (!node) return;
    const name = scaleNameSel.value;
    const root = scaleRootSel.value;
    node.setScale({ name, root });
    node.quantize.setValueAtTime(name === 'off' ? 0 : 1, context.currentTime);
  };
  scaleRootSel.addEventListener('change', sendScale);
  scaleNameSel.addEventListener('change', sendScale);

  // Initialize defaults
  const n = parseInt(document.getElementById('nbranches').value, 10) || 16;
  node.nbranches.setValueAtTime(n, context.currentTime);
  setBranchesVisible(n);
  // Initialize scale/quantize state from UI
  (function initScale() { if (scaleRootSel && scaleNameSel) sendScale(); })();
  resetDefaults();

  // After initializing defaults, share current exciter state with controller tabs
  broadcastState();
}

// Build initial UI rows
const branchesRoot = document.getElementById('branches');
for (let i = 0; i < MAX; i += 1) {
  branchesRoot.appendChild(buildBranchRow(i));
}

document.getElementById('startBtn').addEventListener('click', startAudio);
document.getElementById('randomizeBtn').addEventListener('click', () => {
  const n = parseInt(document.getElementById('nbranches').value, 10) || 16;
  randomize(n);
  // Also randomize musical scale root and scale selection
  const rootEl = document.getElementById('scaleRoot');
  const scaleEl = document.getElementById('scaleName');
  if (rootEl && scaleEl) {
    const rootVals = Array.from(rootEl.options).map(o => o.value);
    // Prefer to avoid 'off' when randomizing scale so quantize is active
    const allScaleVals = Array.from(scaleEl.options).map(o => o.value);
    const scaleVals = allScaleVals.filter(v => v !== 'off');
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const newRoot = pick(rootVals);
    const newScale = pick(scaleVals.length ? scaleVals : allScaleVals);
    rootEl.value = newRoot;
    scaleEl.value = newScale;
    // Trigger change handlers to propagate to audio node if running
    rootEl.dispatchEvent(new Event('change', { bubbles: true }));
    scaleEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
});
document.getElementById('resetBtn').addEventListener('click', () => {
  // Reset globals
  if (document.getElementById('noiseLevel')) document.getElementById('noiseLevel').value = '0.03';
  document.getElementById('rmix').value = '1';
  document.getElementById('nbranches').value = '4';
  document.getElementById('freqScale').value = '1';
  document.getElementById('octaves').value = '0';
  if (document.getElementById('exciterCutoff')) document.getElementById('exciterCutoff').value = '4000';
  if (document.getElementById('exciterHP')) document.getElementById('exciterHP').value = '50';
  if (document.getElementById('noiseType')) document.getElementById('noiseType').value = '0';
  if (document.getElementById('lfoEnabled')) document.getElementById('lfoEnabled').checked = true;
  if (document.getElementById('lfoRate')) document.getElementById('lfoRate').value = '0.10';
  if (document.getElementById('lfoDepth')) document.getElementById('lfoDepth').value = '0.56';
  if (document.getElementById('lfoWave')) document.getElementById('lfoWave').value = '0';
  if (document.getElementById('rainEnabled')) document.getElementById('rainEnabled').checked = true;
  if (document.getElementById('rainRate')) document.getElementById('rainRate').value = '0.81';
  if (document.getElementById('rainDurMs')) document.getElementById('rainDurMs').value = '8';
  if (document.getElementById('rainGain')) document.getElementById('rainGain').value = '0.85';
  if (document.getElementById('rainSpread')) document.getElementById('rainSpread').value = '0.69';
  if (document.getElementById('rainCenter')) document.getElementById('rainCenter').value = '0.55';
  if (document.getElementById('rainLimbs')) document.getElementById('rainLimbs').value = '9';
  if (document.getElementById('monitorExciter')) document.getElementById('monitorExciter').checked = false;
  document.getElementById('freqCenter').value = '0';
  document.getElementById('decayScale').value = '1';
  if (document.getElementById('groupEnabled')) document.getElementById('groupEnabled').checked = false;
  if (document.getElementById('groupSplit')) document.getElementById('groupSplit').value = '0';
  const qEl = document.getElementById('exciterBandQ');
  if (qEl) qEl.value = '30';
  // Reset scale selectors
  if (document.getElementById('scaleRoot')) document.getElementById('scaleRoot').value = 'A';
  if (document.getElementById('scaleName')) document.getElementById('scaleName').value = 'off';
  updateValueLabels();

  if (node && context) {
    const t = context.currentTime;
    node.noiseLevel.setValueAtTime(0.03, t);
      if (node.noiseType) node.noiseType.setValueAtTime(1, t);
      if (node.lfoEnabled) node.lfoEnabled.setValueAtTime(1, t);
      if (node.lfoRate) node.lfoRate.setValueAtTime(0.1, t);
      if (node.lfoDepth) node.lfoDepth.setValueAtTime(0.56, t);
      if (node.lfoWave) node.lfoWave.setValueAtTime(0, t);
    node.rmix.setValueAtTime(1, t);
    node.nbranches.setValueAtTime(4, t);
    node.freqScale.setValueAtTime(1, t);
    node.octaves.setValueAtTime(0, t);
    if (node.exciterCutoff) node.exciterCutoff.setValueAtTime(4000, t);
    if (node.exciterHP) node.exciterHP.setValueAtTime(50, t);
    if (node.rainEnabled) node.rainEnabled.setValueAtTime(1, t);
    if (node.rainRate) node.rainRate.setValueAtTime(0.83, t);
    if (node.rainDurMs) node.rainDurMs.setValueAtTime(61, t);
    if (node.rainGain) node.rainGain.setValueAtTime(0.62, t);
    if (node.rainSpread) node.rainSpread.setValueAtTime(0.71, t);
    if (node.rainCenter) node.rainCenter.setValueAtTime(0.49, t);
    if (node.rainLimbs) node.rainLimbs.setValueAtTime(10, t);
    if (node.monitorExciter) node.monitorExciter.setValueAtTime(0, t);
    node.freqCenter.setValueAtTime(0, t);
    node.decayScale.setValueAtTime(1, t);
    if (node.groupEnabled) node.groupEnabled.setValueAtTime(0, t);
    if (node.groupSplit) node.groupSplit.setValueAtTime(0, t);
    node.quantize.setValueAtTime(0, t);
    if (node.setScale) node.setScale({ name: 'off', root: 'A' });
    setBranchesVisible(4);
  }
  resetDefaults();
  // Inform controller tabs after a full reset
  broadcastState();
});

updateValueLabels();

// Setup BroadcastChannel and open-controls button
setupBroadcastChannel();
const openBtn = document.getElementById('openControlsBtn');
if (openBtn) {
  openBtn.addEventListener('click', () => {
    window.open('control.html', 'Exciter Controls');
  });
}


