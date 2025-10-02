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
  get('freqCenterVal').textContent = get('freqCenter').value;
  get('decayScaleVal').textContent = Number(get('decayScale').value).toFixed(2);
}

async function startAudio() {
  if (context) return;
  context = new (window.AudioContext || window.webkitAudioContext)();
  node = await ResonatorNode.create(context);
  node.connect(context.destination);

  // Wire global sliders
  const $ = (id) => document.getElementById(id);
  const sliders = ['noiseLevel', 'rmix', 'dryWet', 'nbranches', 'freqScale', 'freqCenter', 'decayScale'];
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
        case 'freqCenter': node.freqCenter.setValueAtTime(parseFloat(el.value), t); break;
        case 'decayScale': node.decayScale.setValueAtTime(parseFloat(el.value), t); break;
      }
    });
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
  document.getElementById('freqCenter').value = '0';
  document.getElementById('decayScale').value = '1';
  updateValueLabels();

  if (node && context) {
    const t = context.currentTime;
    node.noiseLevel.setValueAtTime(0.1, t);
    node.rmix.setValueAtTime(0.5, t);
    node.dryWet.setValueAtTime(1, t);
    node.nbranches.setValueAtTime(16, t);
    node.freqScale.setValueAtTime(1, t);
    node.freqCenter.setValueAtTime(0, t);
    node.decayScale.setValueAtTime(1, t);
    setBranchesVisible(16);
  }
  resetDefaults();
});

updateValueLabels();


