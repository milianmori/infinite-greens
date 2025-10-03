import { ResonatorNode } from './resonator-node.js';

let context = null;
let node = null;

const MAX = 40;

// ----- Cross-tab exciter control (BroadcastChannel) -----
const EXCITER_IDS = [
  'exciterCutoff',
  'exciterHP',
  'exciterBandQ',
  'exciterMode',
  'impulseGain',
  'monitorExciter',
  'exciterBurst',
  'burstRate',
  'burstDurMs'
];

let isApplyingRemote = false;
let bc = null;

function getEl(id) { return document.getElementById(id); }

function getExciterState() {
  const state = {};
  for (const id of EXCITER_IDS) {
    const el = getEl(id);
    if (!el) continue;
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
  if (!el) return;
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
  get('noiseLevelVal').textContent = Number(get('noiseLevel').value).toFixed(2);
  get('rmixVal').textContent = Number(get('rmix').value).toFixed(2);
  if (get('dryWet')) get('dryWetVal').textContent = Number(get('dryWet').value).toFixed(2);
  get('nbranchesVal').textContent = get('nbranches').value;
  get('freqScaleVal').textContent = Number(get('freqScale').value).toFixed(2);
  if (get('octaves')) get('octavesVal').textContent = String(parseInt(get('octaves').value, 10));
  if (get('burstRate')) get('burstRateVal').textContent = Number(get('burstRate').value).toFixed(2);
  if (get('burstDurMs')) get('burstDurMsVal').textContent = get('burstDurMs').value;
  if (get('impulseGain')) get('impulseGainVal').textContent = Number(get('impulseGain').value).toFixed(2);
  if (get('exciterHP')) get('exciterHPVal').textContent = get('exciterHP').value;
  get('freqCenterVal').textContent = get('freqCenter').value;
  get('decayScaleVal').textContent = Number(get('decayScale').value).toFixed(2);
  if (get('exciterBandQ')) get('exciterBandQVal').textContent = get('exciterBandQ').value;
}

async function startAudio() {
  if (context) return;
  context = new (window.AudioContext || window.webkitAudioContext)();
  node = await ResonatorNode.create(context);
  node.connect(context.destination);

  // Wire global sliders
  const $ = (id) => document.getElementById(id);
  const sliders = ['noiseLevel', 'rmix', 'dryWet', 'nbranches', 'freqScale', 'octaves', 'freqCenter', 'decayScale'];
  // Exciter controls may live in a separate tab now; guard for missing elements
  const optional = ['exciterCutoff', 'exciterHP', 'burstRate', 'burstDurMs', 'impulseGain', 'exciterBandQ'];
  for (const id of optional) { if (document.getElementById(id)) sliders.push(id); }
  sliders.forEach((id) => {
    const el = $(id);
    el.addEventListener('input', () => {
      updateValueLabels();
      if (!node) return;
      const t = context.currentTime;
      switch (id) {
        case 'noiseLevel': node.noiseLevel.setValueAtTime(parseFloat(el.value), t); break;
        case 'rmix': node.rmix.setValueAtTime(parseFloat(el.value), t); break;
        case 'dryWet': node.dryWet.setValueAtTime(parseFloat(el.value), t); break;
        case 'nbranches': {
          const n = parseInt(el.value, 10);
          node.nbranches.setValueAtTime(n, t);
          setBranchesVisible(n);
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
      }
    });
  });

  // Burst toggle (legacy) and mode select
  const burst = document.getElementById('exciterBurst');
  if (burst) {
    burst.addEventListener('change', () => {
      if (!node) return;
      node.exciterBurst.setValueAtTime(burst.checked ? 1 : 0, context.currentTime);
    });
  }
  const modeSel = document.getElementById('exciterMode');
  if (modeSel) {
    modeSel.addEventListener('change', () => {
      if (!node) return;
      node.exciterMode.setValueAtTime(parseInt(modeSel.value, 10), context.currentTime);
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
});
document.getElementById('resetBtn').addEventListener('click', () => {
  // Reset globals
  document.getElementById('noiseLevel').value = '0.1';
  document.getElementById('rmix').value = '1';
  document.getElementById('dryWet').value = '1';
  document.getElementById('nbranches').value = '4';
  document.getElementById('freqScale').value = '1';
  document.getElementById('octaves').value = '0';
  if (document.getElementById('exciterCutoff')) document.getElementById('exciterCutoff').value = '4000';
  if (document.getElementById('exciterHP')) document.getElementById('exciterHP').value = '50';
  const burstEl = document.getElementById('exciterBurst');
  if (burstEl) burstEl.checked = false;
  if (document.getElementById('burstRate')) document.getElementById('burstRate').value = '4';
  if (document.getElementById('burstDurMs')) document.getElementById('burstDurMs').value = '12';
  if (document.getElementById('exciterMode')) document.getElementById('exciterMode').value = '0';
  if (document.getElementById('impulseGain')) document.getElementById('impulseGain').value = '0.3';
  if (document.getElementById('monitorExciter')) document.getElementById('monitorExciter').checked = false;
  document.getElementById('freqCenter').value = '0';
  document.getElementById('decayScale').value = '1';
  const qEl = document.getElementById('exciterBandQ');
  if (qEl) qEl.value = '25';
  // Reset scale selectors
  if (document.getElementById('scaleRoot')) document.getElementById('scaleRoot').value = 'A';
  if (document.getElementById('scaleName')) document.getElementById('scaleName').value = 'off';
  updateValueLabels();

  if (node && context) {
    const t = context.currentTime;
    node.noiseLevel.setValueAtTime(0.1, t);
    node.rmix.setValueAtTime(1, t);
    node.dryWet.setValueAtTime(1, t);
    node.nbranches.setValueAtTime(4, t);
    node.freqScale.setValueAtTime(1, t);
    node.octaves.setValueAtTime(0, t);
    if (node.exciterCutoff) node.exciterCutoff.setValueAtTime(4000, t);
    if (node.exciterHP) node.exciterHP.setValueAtTime(50, t);
    if (node.exciterBurst) node.exciterBurst.setValueAtTime(0, t);
    if (node.burstRate) node.burstRate.setValueAtTime(4, t);
    if (node.burstDurMs) node.burstDurMs.setValueAtTime(12, t);
    if (node.exciterMode) node.exciterMode.setValueAtTime(0, t);
    if (node.impulseGain) node.impulseGain.setValueAtTime(0.3, t);
    if (node.monitorExciter) node.monitorExciter.setValueAtTime(0, t);
    node.freqCenter.setValueAtTime(0, t);
    node.decayScale.setValueAtTime(1, t);
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


