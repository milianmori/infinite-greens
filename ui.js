import { ResonatorNode } from './resonator-node.js';

let context = null;
let node = null;

const MAX = 40;
let currentBranchCount = 0;

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
  'exciterBandQNoise',
  'exciterBandQRain',
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

// ----- Persistence (localStorage) -----
const UI_STORAGE_KEY = 'uiStateV1';
const EXCITER_STORAGE_KEY = 'exciterStateV1';

function loadJson(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}
function saveJson(key, obj) {
  try { localStorage.setItem(key, JSON.stringify(obj || {})); } catch (_) {}
}

function readElValue(el, id) {
  if (!el) return undefined;
  if (el.type === 'checkbox') return !!el.checked;
  return (id === 'nbranches' || id === 'lfoWave' || id === 'noiseType' || id === 'rainLimbs' || id === 'groupSplit')
    ? parseInt(el.value, 10)
    : (id === 'scaleRoot' || id === 'scaleName') ? String(el.value) : parseFloat(el.value);
}

function writeElValue(el, id, value) {
  if (!el) return;
  if (el.type === 'checkbox') {
    el.checked = !!value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.value = String(value);
    const evtType = (el.tagName === 'SELECT') ? 'change' : 'input';
    el.dispatchEvent(new Event(evtType, { bubbles: true }));
  }
}

// Main UI ids to persist (present on index.html)
const MAIN_UI_IDS = [
  'rmix','nbranches','freqScale','freqCenter','decayScale',
  'groupEnabled','groupSplit','scaleRoot','scaleName'
];

function saveMainUIPartial(partial) {
  const cur = loadJson(UI_STORAGE_KEY) || {};
  const next = { ...cur, ...partial };
  saveJson(UI_STORAGE_KEY, next);
}

function applySavedMainUI() {
  const saved = loadJson(UI_STORAGE_KEY);
  if (!saved) return;
  for (const id of MAIN_UI_IDS) {
    if (!(id in saved)) continue;
    const el = getEl(id);
    if (!el) continue;
    writeElValue(el, id, saved[id]);
  }
}

function saveExciterPartial(partial) {
  const cur = loadJson(EXCITER_STORAGE_KEY) || {};
  const next = { ...cur, ...partial };
  saveJson(EXCITER_STORAGE_KEY, next);
}

function getSavedExciter() { return loadJson(EXCITER_STORAGE_KEY) || null; }

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
    case 'exciterBandQNoise': node.exciterBandQNoise && node.exciterBandQNoise.setValueAtTime(parseFloat(value), t); break;
    case 'exciterBandQRain': node.exciterBandQRain && node.exciterBandQRain.setValueAtTime(parseFloat(value), t); break;
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
  let state = partial || getExciterState();
  const saved = getSavedExciter();
  if (saved) state = { ...saved, ...state };
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
  // Persist applied value
  saveExciterPartial({ [id]: value });
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
      saveExciterPartial({ [id]: value });
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

// ----- Dependency helpers -----
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function normalizeLinear(value, min, max) {
  if (!(max > min)) return 0;
  return clamp01((value - min) / (max - min));
}
function denormalizeLinear(norm, min, max) {
  const n = clamp01(norm);
  return min + n * (max - min);
}
function applyCurve(norm, curve) {
  const n = clamp01(norm);
  switch (curve) {
    case 'smooth':
      return n * n * (3 - 2 * n); // smoothstep
    case 'strong':
      return n * n; // quadratic emphasis
    case 'linear':
    default:
      return n;
  }
}

// ---------------- Randomizer Panel ----------------
const RANDOMIZER_STORAGE_KEY = 'randomizerConfigV1';

// Describe randomizable parameters across Main, Exciter, and Mixer
// kind: 'float' | 'int' | 'bool' | 'select' | 'special'
// For 'select', provide options array
const RANDOM_PARAMS = [
  // Main panel
  { id: 'rmix', label: 'Mix (rmix)', kind: 'float', min: 0, max: 1, step: 0.001 },
  { id: 'nbranches', label: 'Branch count', kind: 'int', min: 1, max: MAX, step: 1 },
  { id: 'freqScale', label: 'Freq Scale', kind: 'float', min: 0.25, max: 4, step: 0.01 },
  { id: 'octaves', label: 'Octave Transpose', kind: 'int', min: -4, max: 2, step: 1 },
  { id: 'freqCenter', label: 'Freq Center (Hz)', kind: 'int', min: -2000, max: 2000, step: 1 },
  { id: 'decayScale', label: 'Decay Scale', kind: 'float', min: 0.25, max: 4, step: 0.01 },
  { id: 'groupEnabled', label: 'Group Mode', kind: 'bool' },
  { id: 'groupSplit', label: 'Group Split', kind: 'int', min: 0, max: MAX, step: 1 },
  // Scale selection
  { id: 'scaleRoot', label: 'Scale Root', kind: 'select', options: ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'] },
  { id: 'scaleName', label: 'Scale', kind: 'select', options: ['off','chromatic','major','minor','harmonicMinor','melodicMinor','dorian','phrygian','lydian','mixolydian','locrian','pentatonicMajor','pentatonicMinor','blues','wholeTone','octatonic12','octatonic21'] },
  // Exciter (may live in separate tab; will apply via setParamById if control not present)
  { id: 'noiseLevel', label: 'Noise Level', kind: 'float', min: 0, max: 0.5, step: 0.001 },
  { id: 'noiseType', label: 'Noise Type', kind: 'int', min: 0, max: 3, step: 1 },
  { id: 'lfoEnabled', label: 'LFO Enable', kind: 'bool' },
  { id: 'lfoRate', label: 'LFO Rate (Hz)', kind: 'float', min: 0.1, max: 20, step: 0.01 },
  { id: 'lfoDepth', label: 'LFO Depth', kind: 'float', min: 0, max: 1, step: 0.01 },
  { id: 'lfoWave', label: 'LFO Wave', kind: 'int', min: 0, max: 3, step: 1 },
  { id: 'exciterCutoff', label: 'Exciter LP (Hz)', kind: 'int', min: 50, max: 20000, step: 1 },
  { id: 'exciterHP', label: 'Exciter HP (Hz)', kind: 'int', min: 10, max: 2000, step: 1 },
  { id: 'exciterBandQNoise', label: 'Exciter Band Q (Noise)', kind: 'float', min: 0.5, max: 80, step: 0.5 },
  { id: 'exciterBandQRain', label: 'Exciter Band Q (Rain)', kind: 'float', min: 0.5, max: 80, step: 0.5 },
  { id: 'monitorExciter', label: 'Monitor Exciter Only', kind: 'bool' },
  // Raindrop
  { id: 'rainEnabled', label: 'Rain Enabled', kind: 'bool' },
  { id: 'rainGain', label: 'Rain Gain', kind: 'float', min: 0, max: 1, step: 0.01 },
  { id: 'rainRate', label: 'Rain Rate (Hz)', kind: 'float', min: 0.1, max: 40, step: 0.01 },
  { id: 'rainDurMs', label: 'Drop Duration (ms)', kind: 'int', min: 1, max: 200, step: 1 },
  { id: 'rainSpread', label: 'Spread', kind: 'float', min: 0, max: 1, step: 0.01 },
  { id: 'rainCenter', label: 'Center', kind: 'float', min: 0, max: 1, step: 0.01 },
  { id: 'rainLimbs', label: 'N Limbs', kind: 'int', min: 1, max: 10, step: 1 }
];

function loadRandomizerConfig() {
  try {
    const raw = localStorage.getItem(RANDOMIZER_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function saveRandomizerConfig(cfg) {
  try { localStorage.setItem(RANDOMIZER_STORAGE_KEY, JSON.stringify(cfg)); } catch (_) {}
}

function getDefaultRandomizerConfig() {
  const cfg = {};
  for (const p of RANDOM_PARAMS) {
    const base = { enabled: false, depEnabled: false, depTarget: '', depBias: 0 };
    if (p.kind === 'bool' || p.kind === 'select') {
      cfg[p.id] = { ...base };
    } else {
      cfg[p.id] = { ...base, min: p.min, max: p.max, step: p.step };
    }
  }
  // Startup defaults (per requested Randomizer settings)
  // Main
  cfg.rmix.enabled = true; cfg.rmix.min = 0.7; cfg.rmix.max = 1; cfg.rmix.step = 0.001;
  cfg.nbranches.enabled = true; cfg.nbranches.min = 5; cfg.nbranches.max = MAX; cfg.nbranches.step = 1;
  // Leave freqScale disabled; keep meta min/max
  cfg.octaves.enabled = true; cfg.octaves.min = -2; cfg.octaves.max = 2; cfg.octaves.step = 1;
  // Leave freqCenter disabled; keep meta min/max
  cfg.decayScale.enabled = true; cfg.decayScale.min = 0.3; cfg.decayScale.max = 4; cfg.decayScale.step = 0.01;
  // Group Mode and Group Split disabled by default
  cfg.groupEnabled.enabled = false;
  cfg.groupSplit.enabled = false; cfg.groupSplit.min = 0; cfg.groupSplit.max = MAX; cfg.groupSplit.step = 1;
  // Scale randomization disabled by default
  cfg.scaleRoot.enabled = false;
  cfg.scaleName.enabled = false;
  return cfg;
}

// Ensure any saved config stays within the current parameter metadata bounds
function normalizeRandomizerConfig(inputCfg) {
  const cfg = inputCfg ? JSON.parse(JSON.stringify(inputCfg)) : {};
  for (const meta of RANDOM_PARAMS) {
    const base = { enabled: false, depEnabled: false, depTarget: '', depBias: 0 };
    let c = cfg[meta.id];
    if (!c) {
      c = (meta.kind === 'bool' || meta.kind === 'select') ? { ...base } : { ...base, min: meta.min, max: meta.max, step: meta.step };
    }
    if (meta.kind !== 'bool' && meta.kind !== 'select') {
      let mn = parseFloat(c.min);
      let mx = parseFloat(c.max);
      if (isNaN(mn)) mn = meta.min;
      if (isNaN(mx)) mx = meta.max;
      // Clamp to metadata bounds
      mn = Math.max(meta.min, Math.min(meta.max, mn));
      mx = Math.max(meta.min, Math.min(meta.max, mx));
      // Ensure valid ordering
      if (!(mx > mn)) { mn = meta.min; mx = meta.max; }
      c.min = mn; c.max = mx; c.step = meta.step;
    }
    // Merge back with base to ensure dependency fields exist
    cfg[meta.id] = { ...base, ...c };
  }
  return cfg;
}

function buildRandomizerPanel() {
  const root = document.getElementById('randomizerPanel');
  if (!root) return;
  const existing = normalizeRandomizerConfig(loadRandomizerConfig() || getDefaultRandomizerConfig());

  const mkCard = (title) => {
    const card = document.createElement('div');
    card.className = 'rand-card';
    const h3 = document.createElement('h3');
    h3.textContent = title;
    card.appendChild(h3);
    return card;
  };

  const groups = [
    { title: 'Main', ids: ['rmix','nbranches','freqScale','octaves','freqCenter','decayScale','groupEnabled','groupSplit','scaleRoot','scaleName'] },
    { title: 'Exciter', ids: ['noiseLevel','noiseType','lfoEnabled','lfoRate','lfoDepth','lfoWave','exciterCutoff','exciterHP','exciterBandQNoise','exciterBandQRain','monitorExciter','rainEnabled','rainGain','rainRate','rainDurMs','rainSpread','rainCenter','rainLimbs'] }
  ];

  root.innerHTML = '';
  for (const g of groups) {
    const card = mkCard(g.title);
    for (const id of g.ids) {
      const meta = RANDOM_PARAMS.find(r => r.id === id);
      if (!meta) continue;
      const row = document.createElement('div');
      row.className = 'rand-row';
      const enable = document.createElement('input');
      enable.type = 'checkbox';
      enable.checked = !!(existing[id] && existing[id].enabled);
      enable.addEventListener('change', () => { existing[id] = existing[id] || {}; existing[id].enabled = !!enable.checked; saveRandomizerConfig(existing); });
      row.appendChild(enable);
      const body = document.createElement('div');
      if (meta.kind === 'bool' || meta.kind === 'select') {
        const label = document.createElement('label');
        label.textContent = meta.label + (meta.kind === 'select' ? ' (random pick)' : '');
        body.appendChild(label);
      } else {
        const label = document.createElement('label');
        label.textContent = meta.label;
        body.appendChild(label);
        const rangeWrap = document.createElement('div');
        rangeWrap.className = 'range';
        const minInput = document.createElement('input');
        minInput.type = 'number';
        minInput.step = String(meta.step || 1);
        minInput.value = String((existing[id] && existing[id].min) != null ? existing[id].min : meta.min);
        const maxInput = document.createElement('input');
        maxInput.type = 'number';
        maxInput.step = String(meta.step || 1);
        maxInput.value = String((existing[id] && existing[id].max) != null ? existing[id].max : meta.max);
        const onChange = () => {
          const vmin = parseFloat(minInput.value);
          const vmax = parseFloat(maxInput.value);
          if (!existing[id]) existing[id] = { enabled: false };
          existing[id].min = isNaN(vmin) ? meta.min : vmin;
          existing[id].max = isNaN(vmax) ? meta.max : vmax;
          existing[id].step = meta.step;
          saveRandomizerConfig(existing);
        };
        minInput.addEventListener('input', onChange);
        maxInput.addEventListener('input', onChange);
        rangeWrap.appendChild(minInput);
        rangeWrap.appendChild(maxInput);
        body.appendChild(rangeWrap);
      }
			// Dependency controls
      const dep = document.createElement('div');
			dep.className = 'dep';
			const depEnable = document.createElement('input');
			depEnable.type = 'checkbox';
			depEnable.checked = !!(existing[id] && existing[id].depEnabled);
			depEnable.title = 'Enable dependency';
      const depTitle = document.createElement('span');
      depTitle.textContent = 'Dependency';
			const targetSel = document.createElement('select');
			const blankOpt = document.createElement('option');
			blankOpt.value = '';
			blankOpt.textContent = '(choose target)';
			targetSel.appendChild(blankOpt);
			for (const rp of RANDOM_PARAMS) {
				if (rp.id === id) continue;
				const opt = document.createElement('option');
				opt.value = rp.id;
				opt.textContent = rp.label;
				targetSel.appendChild(opt);
			}
			targetSel.value = (existing[id] && existing[id].depTarget) || '';
      const biasWrap = document.createElement('div');
			biasWrap.className = 'bias';
			const biasLabel = document.createElement('span');
      biasLabel.textContent = 'Bias';
			const biasRange = document.createElement('input');
      biasRange.type = 'range';
      biasRange.min = '-1';
      biasRange.max = '1';
      biasRange.step = '0.01';
      biasRange.value = String((existing[id] && typeof existing[id].depBias === 'number') ? existing[id].depBias : 0);
			const biasVal = document.createElement('span');
      const updateBiasText = () => { biasVal.textContent = String(Math.round(parseFloat(biasRange.value) * 100)) + '%'; };
			updateBiasText();
      biasRange.addEventListener('input', () => { updateBiasText(); if (!existing[id]) existing[id] = { enabled: false }; existing[id].depBias = parseFloat(biasRange.value); saveRandomizerConfig(existing); });

			depEnable.addEventListener('change', () => { existing[id] = existing[id] || {}; existing[id].depEnabled = !!depEnable.checked; saveRandomizerConfig(existing); });
			targetSel.addEventListener('change', () => { existing[id] = existing[id] || {}; existing[id].depTarget = targetSel.value; saveRandomizerConfig(existing); });

			dep.appendChild(depEnable);
			dep.appendChild(depTitle);
			dep.appendChild(targetSel);
			biasWrap.appendChild(biasLabel);
			biasWrap.appendChild(biasRange);
			biasWrap.appendChild(biasVal);
			dep.appendChild(biasWrap);
			body.appendChild(dep);
      row.appendChild(body);
      card.appendChild(row);
    }
    root.appendChild(card);
  }
}

function randomValueFor(meta, cfg) {
  if (!cfg || !cfg.enabled) return null;
  if (meta.kind === 'bool') return Math.random() < 0.5;
  if (meta.kind === 'select') {
    const opts = meta.options || [];
    if (!opts.length) return null;
    return opts[Math.floor(Math.random() * opts.length)];
  }
  const min = parseFloat(cfg.min);
  const max = parseFloat(cfg.max);
  if (!(max > min)) return null;
  let val = randRange(min, max);
  if (meta.kind === 'int') val = Math.round(val);
  if (meta.step) {
    const s = meta.step;
    val = Math.round(val / s) * s;
  }
  return val;
}

function applyRandomizer() {
  const cfg = normalizeRandomizerConfig(loadRandomizerConfig() || getDefaultRandomizerConfig());
  // If nbranches is enabled, do it first so dependent ranges can clamp
  const order = [...RANDOM_PARAMS];
  order.sort((a, b) => (a.id === 'nbranches' ? -1 : b.id === 'nbranches' ? 1 : 0));
  const planned = {};
  for (const meta of order) {
    // Skip 'octaves' here; we use it to set per-branch slider bounds
    if (meta.id === 'octaves') continue;
    const val = randomValueFor(meta, cfg[meta.id]);
    if (val == null) continue;
    planned[meta.id] = val;
  }
  // Clamp groupSplit to nbranches if both present
  if (planned.groupSplit != null) {
    const nb = planned.nbranches != null ? planned.nbranches : (document.getElementById('nbranches') ? parseInt(document.getElementById('nbranches').value, 10) : null);
    if (nb != null) planned.groupSplit = Math.max(0, Math.min(nb, planned.groupSplit | 0));
  }
  // Dependency pass: depBias in [-1, 1] pulls toward low (negative) or high (positive) poles
  const metaById = Object.fromEntries(RANDOM_PARAMS.map(m => [m.id, m]));
  for (const sourceId of Object.keys(cfg)) {
    const sc = cfg[sourceId];
    if (!sc || !sc.depEnabled) continue;
    const targetId = sc.depTarget;
    if (!targetId || targetId === sourceId) continue;
    if (planned[sourceId] == null) continue;
    if (planned[targetId] == null) continue;
    const srcMeta = metaById[sourceId];
    const tgtMeta = metaById[targetId];
    if (!srcMeta || !tgtMeta) continue;
    const srcCfg = cfg[sourceId];
    const tgtCfg = cfg[targetId];
    const sMin = (srcMeta.kind === 'bool' || srcMeta.kind === 'select') ? 0 : (srcCfg && srcCfg.min != null ? srcCfg.min : srcMeta.min);
    const sMax = (srcMeta.kind === 'bool' || srcMeta.kind === 'select') ? 1 : (srcCfg && srcCfg.max != null ? srcCfg.max : srcMeta.max);
    const tMin = (tgtMeta.kind === 'bool' || tgtMeta.kind === 'select') ? 0 : (tgtCfg && tgtCfg.min != null ? tgtCfg.min : tgtMeta.min);
    const tMax = (tgtMeta.kind === 'bool' || tgtMeta.kind === 'select') ? 1 : (tgtCfg && tgtCfg.max != null ? tgtCfg.max : tgtMeta.max);
    const sNorm = normalizeLinear(planned[sourceId], sMin, sMax);
    // Strength comes from |depBias| in [0,1]; sign chooses pole
    const rawBias = typeof sc.depBias === 'number' ? Math.max(-1, Math.min(1, sc.depBias)) : 0;
    const strength = Math.abs(rawBias);
    const tNorm = normalizeLinear(planned[targetId], tMin, tMax);
    const pole = rawBias < 0 ? 0 : 1;
    // Modulate influence by source level (Linear)
    const influence = strength * sNorm;
    const tOut = tNorm + (pole - tNorm) * influence;
    planned[targetId] = (tgtMeta.kind === 'bool') ? (tOut >= 0.5) : (tgtMeta.kind === 'int' ? Math.round(denormalizeLinear(tOut, tMin, tMax)) : denormalizeLinear(tOut, tMin, tMax));
  }
  // Apply to DOM/audio for all
  const entries = Object.entries(planned);
  for (const [id, value] of entries) {
    applyControlFromRemote(id, value);
  }

  // Special handling: transpose octave now sets per-branch octave slider min/max
  try {
    if (cfg.octaves && cfg.octaves.enabled) {
      const rows = document.querySelectorAll('#branches .row');
      const mn = (typeof cfg.octaves.min === 'number') ? Math.round(cfg.octaves.min) : -4;
      const mx = (typeof cfg.octaves.max === 'number') ? Math.round(cfg.octaves.max) : 4;
      // Limit randomization to visible branches
      const nNow = parseInt(document.getElementById('nbranches')?.value || String(rows.length), 10) | 0;
      rows.forEach((row, idx) => {
        if (idx >= nNow) return;
        const octEl = row.querySelector('input[data-role="oct"]');
        if (!octEl) return;
        const newMin = String(Math.min(mx, Math.max(-12, mn)));
        const newMax = String(Math.max(mn, Math.min(12, mx)));
        octEl.min = newMin;
        octEl.max = newMax;
        // Randomize the octave value within the new bounds (inclusive)
        const minI = parseInt(newMin, 10) | 0;
        const maxI = parseInt(newMax, 10) | 0;
        const next = (minI <= maxI)
          ? (minI + Math.floor(Math.random() * (maxI - minI + 1)))
          : 0;
        octEl.value = String(next);
        // Trigger input so frequency updates if audio is running
        octEl.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
  } catch (_) {}
  // Broadcast new exciter control values to controller tabs so their UI updates
  try {
    if (bc) {
      const excVals = {};
      for (const id of EXCITER_IDS) {
        if (planned[id] != null) excVals[id] = planned[id];
      }
      if (Object.keys(excVals).length) bc.postMessage({ type: 'setMultiple', values: excVals, source: 'main' });
    }
  } catch (_) {}
  // Update labels locally if present
  if (document.getElementById('rmix')) updateValueLabels();
}

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

  // Per-branch octave transpose (integer)
  const oct = document.createElement('input');
  oct.type = 'number';
  oct.min = '-4';
  oct.max = '4';
  oct.step = '1';
  oct.value = '0';
  oct.dataset.role = 'oct';
  row.appendChild(oct);

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
      freq: normToHz(parseFloat(freq.value)) * Math.pow(2, parseInt(oct.value || '0', 10)),
      decay: parseFloat(decay.value),
      amp: parseFloat(amp.value),
      pan: parseFloat(pan.value)
    };
    node.setBranchParams(i, params);
  };

  freq.addEventListener('input', onInput);
  oct.addEventListener('input', onInput);
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
    // Respect per-branch octave when randomizing
    const octEl = rows[i] && rows[i].querySelector('input[data-role="oct"]');
    const oct = octEl ? parseInt(octEl.value || '0', 10) : 0;
    const decay = Math.round(randRange(100, 800));
    const amp = round2(randRange(0.005, 0.05));
    const pan = randRange(-1, 1);
    branches.push({ freq: freq * Math.pow(2, oct), decay, amp, pan });

    const row = rows[i];
    row.querySelector('input[data-role="freq"]').value = String(hzToNorm(freq));
    row.querySelector('input[data-role="decay"]').value = String(decay);
    row.querySelector('input[data-role="amp"]').value = String(amp);
    row.querySelector('input[data-role="pan"]').value = String(pan);
  }
  if (node) node.setAllBranches(branches);
}

function randomizeBranchRange(startIndex, endIndex) {
  const rows = document.querySelectorAll('#branches .row');
  const start = Math.max(0, startIndex | 0);
  const end = Math.min(MAX, endIndex | 0);
  for (let i = start; i < end; i += 1) {
    const freq = Math.round(randRange(100, 2000));
    const octEl = rows[i] && rows[i].querySelector('input[data-role="oct"]');
    const oct = octEl ? parseInt(octEl.value || '0', 10) : 0;
    const decay = Math.round(randRange(100, 800));
    const amp = round2(randRange(0.005, 0.05));
    const pan = randRange(-1, 1);
    const row = rows[i];
    if (!row) continue;
    const freqEl = row.querySelector('input[data-role="freq"]');
    const decayEl = row.querySelector('input[data-role="decay"]');
    const ampEl = row.querySelector('input[data-role="amp"]');
    const panEl = row.querySelector('input[data-role="pan"]');
    if (freqEl) freqEl.value = String(hzToNorm(freq));
    if (decayEl) decayEl.value = String(decay);
    if (ampEl) ampEl.value = String(amp);
    if (panEl) panEl.value = String(pan);
    if (node) node.setBranchParams(i, { freq: freq * Math.pow(2, oct), decay, amp, pan });
  }
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
  if (get('burstRate')) get('burstRateVal').textContent = Number(get('burstRate').value).toFixed(2);
  if (get('burstDurMs')) get('burstDurMsVal').textContent = get('burstDurMs').value;
  if (get('impulseGain')) get('impulseGainVal').textContent = Number(get('impulseGain').value).toFixed(2);
  if (get('exciterHP')) get('exciterHPVal').textContent = get('exciterHP').value;
  get('freqCenterVal').textContent = get('freqCenter').value;
  get('decayScaleVal').textContent = Number(get('decayScale').value).toFixed(2);
  if (get('groupSplit')) get('groupSplitVal').textContent = String(parseInt(get('groupSplit').value, 10));
  if (get('exciterBandQNoise')) get('exciterBandQNoiseVal').textContent = get('exciterBandQNoise').value;
  if (get('exciterBandQRain')) get('exciterBandQRainVal').textContent = get('exciterBandQRain').value;
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
  const masterOut = context.createGain();
  masterOut.gain.value = 1;
  // Master bus: glue compressor -> makeup gain -> destination
  const glueComp = context.createDynamicsCompressor();
  // Sensible defaults for a gentle "glue"
  glueComp.threshold.value = -30; // dB
  glueComp.knee.value = 12; // dB
  glueComp.ratio.value = 2; // :1
  glueComp.attack.value = 0.01; // s
  glueComp.release.value = 0.25; // s
  const masterMakeup = context.createGain();
  masterMakeup.gain.value = 1.51;
  let _compBypass = false;
  function reconnectMaster() {
    try { masterOut.disconnect(); } catch(_) {}
    try { glueComp.disconnect(); } catch(_) {}
    try { masterMakeup.disconnect(); } catch(_) {}
    if (_compBypass) {
      masterOut.connect(context.destination);
    } else {
      masterOut.connect(glueComp);
      glueComp.connect(masterMakeup);
      masterMakeup.connect(context.destination);
    }
  }
  reconnectMaster();
  // Route dual outputs through per-path processing (noise path includes optional LPF)
  const noiseGain = context.createGain();
  noiseGain.gain.value = 1;
  const rainGain = context.createGain();
  rainGain.gain.value = 1;
  // Connect output 0 (noise path) direct -> gain; output 1 (rain) direct -> gain
  node.connect(noiseGain, 0, 0);
  node.connect(rainGain, 1, 0);
  noiseGain.connect(masterOut);
  rainGain.connect(masterOut);

  // Simple output meters using AnalyserNodes (RMS approximation)
  const analyser0 = context.createAnalyser();
  analyser0.fftSize = 1024;
  const analyser1 = context.createAnalyser();
  analyser1.fftSize = 1024;
  noiseGain.connect(analyser0);
  rainGain.connect(analyser1);
  const data0 = new Float32Array(analyser0.fftSize);
  const data1 = new Float32Array(analyser1.fftSize);
  const updateMeters = () => {
    const el0 = document.getElementById('meter0Bar');
    const el1 = document.getElementById('meter1Bar');
    if (el0 && el1) {
      analyser0.getFloatTimeDomainData(data0);
      analyser1.getFloatTimeDomainData(data1);
      let sum0 = 0; for (let i = 0; i < data0.length; i += 1) sum0 += data0[i] * data0[i];
      let sum1 = 0; for (let i = 0; i < data1.length; i += 1) sum1 += data1[i] * data1[i];
      const rms0 = Math.sqrt(sum0 / data0.length);
      const rms1 = Math.sqrt(sum1 / data1.length);
      const db0 = 20 * Math.log10(Math.max(1e-6, rms0));
      const db1 = 20 * Math.log10(Math.max(1e-6, rms1));
      const pct0 = Math.max(0, Math.min(1, (db0 + 60) / 60));
      const pct1 = Math.max(0, Math.min(1, (db1 + 60) / 60));
      el0.style.height = String(Math.round(pct0 * 100)) + '%';
      el1.style.height = String(Math.round(pct1 * 100)) + '%';
    }
    requestAnimationFrame(updateMeters);
  };
  requestAnimationFrame(updateMeters);

  // Expose mixer control hook on window for mixer.html
  // Preserve original gains for mute/unmute toggling
  let _origNoiseGain = 1;
  let _origRainGain = 1;
  window._mixerApi = {
    // Compressor controls
    setCompressorParams(params) {
      const p = params || {};
      if (typeof p.thresholdDb === 'number') glueComp.threshold.setTargetAtTime(p.thresholdDb, context.currentTime, 0.01);
      if (typeof p.kneeDb === 'number') glueComp.knee.setTargetAtTime(Math.max(0, Math.min(40, p.kneeDb)), context.currentTime, 0.01);
      if (typeof p.ratio === 'number') glueComp.ratio.setTargetAtTime(Math.max(1, Math.min(20, p.ratio)), context.currentTime, 0.01);
      if (typeof p.attack === 'number') glueComp.attack.setTargetAtTime(Math.max(0.001, Math.min(1, p.attack)), context.currentTime, 0.01);
      if (typeof p.release === 'number') glueComp.release.setTargetAtTime(Math.max(0.01, Math.min(2, p.release)), context.currentTime, 0.01);
    },
    getCompressorParams() {
      return {
        thresholdDb: glueComp.threshold.value,
        kneeDb: glueComp.knee.value,
        ratio: glueComp.ratio.value,
        attack: glueComp.attack.value,
        release: glueComp.release.value
      };
    },
    setMakeupGain(g) {
      const v = (typeof g === 'number') ? Math.max(0, Math.min(4, g)) : 1;
      masterMakeup.gain.setTargetAtTime(v, context.currentTime, 0.01);
    },
    getMakeupGain() { return masterMakeup.gain.value; },
    setCompressorBypass(enabled) {
      _compBypass = !!enabled;
      reconnectMaster();
    },
    getCompressorBypass() { return _compBypass; },
    getContext: () => context,
    getNode: () => node,
    getMasterOut: () => masterOut,
    getNoiseGain: () => noiseGain,
    getRainGain: () => rainGain,
    muteMainStereo(enabled) {
      if (enabled) {
        _origNoiseGain = noiseGain.gain.value;
        _origRainGain = rainGain.gain.value;
        noiseGain.gain.setTargetAtTime(0, context.currentTime, 0.02);
        rainGain.gain.setTargetAtTime(0, context.currentTime, 0.02);
      } else {
        noiseGain.gain.setTargetAtTime(_origNoiseGain, context.currentTime, 0.02);
        rainGain.gain.setTargetAtTime(_origRainGain, context.currentTime, 0.02);
      }
    }
  };
  console.info('AudioContext started', { sampleRate: context.sampleRate, baseLatency: context.baseLatency });

  // Wire global sliders
  const $ = (id) => document.getElementById(id);
  const sliders = ['rmix', 'nbranches', 'freqScale', 'freqCenter', 'decayScale', 'groupSplit'];
  // Exciter controls may live in a separate tab now; guard for missing elements
  const optional = ['noiseType', 'lfoRate', 'lfoDepth', 'exciterCutoff', 'exciterHP', 'exciterBandQNoise', 'exciterBandQRain', 'rainRate', 'rainDurMs', 'rainGain', 'rainSpread', 'rainCenter', 'rainLimbs'];
  for (const id of optional) { if (document.getElementById(id)) sliders.push(id); }
  sliders.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      updateValueLabels();
      // persist main UI slider value
      saveMainUIPartial({ [id]: (el.type === 'checkbox') ? !!el.checked : (id === 'nbranches' || id === 'groupSplit') ? parseInt(el.value, 10) : parseFloat(el.value) });
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
          // If increasing branch count, randomize only the newly added branches
          if (n > currentBranchCount) {
            randomizeBranchRange(currentBranchCount, n);
          }
          currentBranchCount = n;
          break;
        }
        case 'freqScale': node.freqScale.setValueAtTime(parseFloat(el.value), t); break;
        case 'exciterCutoff': node.exciterCutoff.setValueAtTime(parseFloat(el.value), t); break;
        case 'exciterHP': node.exciterHP.setValueAtTime(parseFloat(el.value), t); break;
        case 'burstRate': node.burstRate.setValueAtTime(parseFloat(el.value), t); break;
        case 'burstDurMs': node.burstDurMs.setValueAtTime(parseFloat(el.value), t); break;
        case 'impulseGain': node.impulseGain.setValueAtTime(parseFloat(el.value), t); break;
        case 'freqCenter': node.freqCenter.setValueAtTime(parseFloat(el.value), t); break;
        case 'decayScale': node.decayScale.setValueAtTime(parseFloat(el.value), t); break;
        case 'exciterBandQNoise': node.exciterBandQNoise.setValueAtTime(parseFloat(el.value), t); break;
        case 'exciterBandQRain': node.exciterBandQRain.setValueAtTime(parseFloat(el.value), t); break;
        case 'groupSplit': node.groupSplit.setValueAtTime(parseInt(el.value, 10), t); break;
      }
    });
  });

  // Mixer cross-tab channel no longer adjusts LPF; reserved for future messages
  const groupEnableEl = document.getElementById('groupEnabled');
  if (groupEnableEl) {
    groupEnableEl.addEventListener('change', () => {
      if (!node) return;
      saveMainUIPartial({ groupEnabled: !!groupEnableEl.checked });
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
    // persist scale selections
    saveMainUIPartial({ scaleName: name, scaleRoot: root });
    node.setScale({ name, root });
    node.quantize.setValueAtTime(name === 'off' ? 0 : 1, context.currentTime);
  };
  scaleRootSel.addEventListener('change', sendScale);
  scaleNameSel.addEventListener('change', sendScale);

  // Initialize defaults
  const n = parseInt(document.getElementById('nbranches').value, 10) || 16;
  node.nbranches.setValueAtTime(n, context.currentTime);
  setBranchesVisible(n);
  currentBranchCount = n;
  // Initialize scale/quantize state from UI
  (function initScale() { if (scaleRootSel && scaleNameSel) sendScale(); })();
  resetDefaults();
  // Trigger Randomize automatically after starting audio so user doesn't need to click
  try {
    const randomizeBtn = document.getElementById('randomizeBtn');
    if (randomizeBtn) randomizeBtn.click();
  } catch (_) {}

  // After initializing defaults, share current exciter state with controller tabs
  broadcastState();
}

// Build initial UI rows (only on main page where branches exist)
const branchesRoot = document.getElementById('branches');
if (branchesRoot) {
  for (let i = 0; i < MAX; i += 1) {
    branchesRoot.appendChild(buildBranchRow(i));
  }
}

const startBtnEl = document.getElementById('startBtn');
if (startBtnEl) startBtnEl.addEventListener('click', startAudio);
const randomizeBtnEl = document.getElementById('randomizeBtn');
if (randomizeBtnEl) randomizeBtnEl.addEventListener('click', () => {
  const n = parseInt(document.getElementById('nbranches').value, 10) || 16;
  // First apply configured random ranges across Main/Exciter/Mixer
  applyRandomizer();
  // Then randomize branch parameters as before (respect current nbranches which may have changed)
  const nNow = parseInt(document.getElementById('nbranches').value, 10) || n;
  randomize(nNow);
  // Also randomize musical scale root and scale selection
  const rootEl = document.getElementById('scaleRoot');
  const scaleEl = document.getElementById('scaleName');
  // Avoid overriding if Randomizer has scale randomization enabled
  const cfg = normalizeRandomizerConfig(loadRandomizerConfig() || getDefaultRandomizerConfig());
  const scaleRandEnabled = (cfg.scaleRoot && cfg.scaleRoot.enabled) || (cfg.scaleName && cfg.scaleName.enabled);
  if (!scaleRandEnabled && rootEl && scaleEl) {
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
  // Spatialization removed: no cross-tab spatial randomization
  try {
    // Also notify spatial window to randomize positions with current radius if available
    if (typeof BroadcastChannel !== 'undefined') {
      const sp = new BroadcastChannel('spatial');
      let radius = null;
      try {
        const el = document.getElementById('randMaxDist');
        if (el) radius = parseFloat(el.value);
      } catch (_) {}
      sp.postMessage({ type: 'randomizePositions', radius });
    }
  } catch (_) {}
});
const resetBtnEl = document.getElementById('resetBtn');
if (resetBtnEl) resetBtnEl.addEventListener('click', () => {
  // Clear persisted state
  try { localStorage.removeItem(UI_STORAGE_KEY); localStorage.removeItem(EXCITER_STORAGE_KEY); } catch (_) {}
  // Reset globals
  if (document.getElementById('noiseLevel')) document.getElementById('noiseLevel').value = '0.03';
  document.getElementById('rmix').value = '1';
  document.getElementById('nbranches').value = '4';
  document.getElementById('freqScale').value = '1';
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
  const qNEl = document.getElementById('exciterBandQNoise');
  if (qNEl) qNEl.value = '30';
  const qREl = document.getElementById('exciterBandQRain');
  if (qREl) qREl.value = '30';
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
    currentBranchCount = 4;
  }
  resetDefaults();
  // Inform controller tabs after a full reset
  broadcastState();
});

if (document.getElementById('rmix')) updateValueLabels();

// Setup BroadcastChannel and open-controls / mixer buttons
setupBroadcastChannel();
const openBtn = document.getElementById('openControlsBtn');
if (openBtn) {
  openBtn.addEventListener('click', () => {
    window.open('control.html', 'Exciter Controls');
  });
}

const openMixerBtn = document.getElementById('openMixerBtn');
if (openMixerBtn) {
  openMixerBtn.addEventListener('click', () => {
    window.open('mixer.html', 'Mixer');
  });
}

const openRandomizerBtn = document.getElementById('openRandomizerBtn');
if (openRandomizerBtn) {
  openRandomizerBtn.addEventListener('click', () => {
    window.open('randomizer.html', 'Randomizer');
  });
}

const openSpatialBtn = document.getElementById('openSpatialBtn');
if (openSpatialBtn) {
  openSpatialBtn.addEventListener('click', () => {
    window.open('spatial.html', 'Spatializer');
  });
}

// Build Randomizer panel if present on this page
if (document.getElementById('randomizerPanel')) {
  buildRandomizerPanel();
}

// Apply saved UI/exciter state on load (before user starts audio)
(function applySavedStateEarly() {
  try { applySavedMainUI(); } catch (_) {}
  try {
    const savedExc = getSavedExciter();
    if (savedExc) {
      for (const [id, value] of Object.entries(savedExc)) applyControlFromRemote(id, value);
    }
  } catch (_) {}
})();


