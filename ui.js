import { ResonatorNode } from './resonator-node.js';

let context = null;
let node = null;

const MAX = 40;

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
  freq.min = '25';
  freq.max = '8000';
  freq.step = '1';
  freq.value = '440';
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
  amp.value = '0.02';
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
      freq: parseFloat(freq.value),
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
    row.querySelector('input[data-role="freq"]').value = String(freq);
    row.querySelector('input[data-role="decay"]').value = String(decay);
    row.querySelector('input[data-role="amp"]').value = String(amp);
    row.querySelector('input[data-role="pan"]').value = String(pan);
  }
  if (node) node.setAllBranches(branches);
}

function resetDefaults() {
  const n = parseInt(document.getElementById('nbranches').value, 10) || 16;
  randomize(n);
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
  const sliders = ['noiseLevel', 'rmix', 'dryWet', 'nbranches', 'freqScale', 'octaves', 'exciterCutoff', 'exciterHP', 'burstRate', 'burstDurMs', 'impulseGain', 'freqCenter', 'decayScale'];
  // Add exciterBandQ if present in the DOM
  if (document.getElementById('exciterBandQ')) sliders.push('exciterBandQ');
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
  modeSel.addEventListener('change', () => {
    if (!node) return;
    node.exciterMode.setValueAtTime(parseInt(modeSel.value, 10), context.currentTime);
  });

  const mon = document.getElementById('monitorExciter');
  mon.addEventListener('change', () => {
    if (!node) return;
    node.monitorExciter.setValueAtTime(mon.checked ? 1 : 0, context.currentTime);
  });

  // Quantize checkbox (k-rate boolean)
  const q = document.getElementById('quantize');
  q.addEventListener('change', () => {
    if (!node) return;
    node.quantize.setValueAtTime(q.checked ? 1 : 0, context.currentTime);
  });

  // Initialize defaults
  const n = parseInt(document.getElementById('nbranches').value, 10) || 16;
  node.nbranches.setValueAtTime(n, context.currentTime);
  setBranchesVisible(n);
  resetDefaults();
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
  document.getElementById('rmix').value = '0.5';
  document.getElementById('dryWet').value = '1';
  document.getElementById('nbranches').value = '16';
  document.getElementById('freqScale').value = '1';
  document.getElementById('octaves').value = '0';
  document.getElementById('exciterCutoff').value = '4000';
  document.getElementById('exciterHP').value = '50';
  const burstEl = document.getElementById('exciterBurst');
  if (burstEl) burstEl.checked = false;
  document.getElementById('burstRate').value = '4';
  document.getElementById('burstDurMs').value = '12';
  document.getElementById('exciterMode').value = '0';
  document.getElementById('impulseGain').value = '0.3';
  document.getElementById('monitorExciter').checked = false;
  document.getElementById('freqCenter').value = '0';
  document.getElementById('decayScale').value = '1';
  const qEl = document.getElementById('exciterBandQ');
  if (qEl) qEl.value = '25';
  document.getElementById('quantize').checked = false;
  updateValueLabels();

  if (node && context) {
    const t = context.currentTime;
    node.noiseLevel.setValueAtTime(0.1, t);
    node.rmix.setValueAtTime(0.5, t);
    node.dryWet.setValueAtTime(1, t);
    node.nbranches.setValueAtTime(16, t);
    node.freqScale.setValueAtTime(1, t);
    node.octaves.setValueAtTime(0, t);
    node.exciterCutoff.setValueAtTime(4000, t);
    node.exciterHP.setValueAtTime(50, t);
    if (node.exciterBurst) node.exciterBurst.setValueAtTime(0, t);
    node.burstRate.setValueAtTime(4, t);
    node.burstDurMs.setValueAtTime(12, t);
    node.exciterMode.setValueAtTime(0, t);
    node.impulseGain.setValueAtTime(0.3, t);
    node.monitorExciter.setValueAtTime(0, t);
    node.freqCenter.setValueAtTime(0, t);
    node.decayScale.setValueAtTime(1, t);
    node.quantize.setValueAtTime(0, t);
    setBranchesVisible(16);
  }
  resetDefaults();
});

updateValueLabels();


