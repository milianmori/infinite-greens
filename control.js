// Cross-tab controller for exciter parameters

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

let bc = null;
let isApplyingRemote = false;

function getEl(id) { return document.getElementById(id); }

function updateValueLabels() {
  const get = (id) => document.getElementById(id);
  if (get('exciterCutoff')) get('exciterCutoffVal').textContent = get('exciterCutoff').value;
  if (get('exciterHP')) get('exciterHPVal').textContent = get('exciterHP').value;
  if (get('exciterBandQ')) get('exciterBandQVal').textContent = get('exciterBandQ').value;
  if (get('burstRate')) get('burstRateVal').textContent = Number(get('burstRate').value).toFixed(2);
  if (get('burstDurMs')) get('burstDurMsVal').textContent = get('burstDurMs').value;
  if (get('impulseGain')) get('impulseGainVal').textContent = Number(get('impulseGain').value).toFixed(2);
}

function sendSet(id, value) {
  if (!bc) return;
  bc.postMessage({ type: 'set', id, value, source: 'control' });
}

function sendSetMultiple(values) {
  if (!bc) return;
  bc.postMessage({ type: 'setMultiple', values, source: 'control' });
}

function applyFromMain(values) {
  isApplyingRemote = true;
  try {
    for (const [id, value] of Object.entries(values)) {
      const el = getEl(id);
      if (!el) continue;
      if (el.type === 'checkbox') {
        el.checked = !!value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.value = String(value);
        const evtType = (el.tagName === 'SELECT') ? 'change' : 'input';
        el.dispatchEvent(new Event(evtType, { bubbles: true }));
      }
    }
  } finally {
    isApplyingRemote = false;
  }
  updateValueLabels();
}

function setup() {
  if (typeof BroadcastChannel === 'undefined') {
    alert('BroadcastChannel is not supported in this browser.');
    return;
  }
  bc = new BroadcastChannel('exciter-controls');
  bc.onmessage = (event) => {
    const data = event.data || {};
    if (data.source === 'control') return; // ignore self
    if (data.type === 'state' && data.state) {
      applyFromMain(data.state);
    }
  };

  // Wire local controls to broadcast changes
  for (const id of EXCITER_IDS) {
    const el = getEl(id);
    if (!el) continue;
    const handler = () => {
      if (isApplyingRemote) return;
      const value = (el.type === 'checkbox') ? !!el.checked : el.value;
      sendSet(id, value);
      updateValueLabels();
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  }

  // Request initial state from main tab
  bc.postMessage({ type: 'requestState', source: 'control' });

  // Manual sync button
  const syncBtn = document.getElementById('requestSyncBtn');
  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      bc.postMessage({ type: 'requestState', source: 'control' });
    });
  }

  updateValueLabels();
}

document.addEventListener('DOMContentLoaded', setup);


