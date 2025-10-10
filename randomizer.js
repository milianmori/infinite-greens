import './ui.js';

// Bridge buttons to main window functions via BroadcastChannel and DOM hooks
const applyBtn = document.getElementById('applyBtn');
const closeBtn = document.getElementById('closeBtn');
const floatingRandomizeBtn = document.getElementById('floatingRandomizeBtn');

applyBtn.addEventListener('click', () => {
  // Trigger the same applyRandomizer flow by dispatching a CustomEvent the ui.js listens to
  if (window.opener && !window.opener.closed) {
    try {
      window.opener.document.getElementById('randomizeBtn')?.click();
    } catch (_) {}
  }
});

closeBtn.addEventListener('click', () => window.close());

if (floatingRandomizeBtn) {
  floatingRandomizeBtn.addEventListener('click', () => {
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.document.getElementById('randomizeBtn')?.click();
      } catch (_) {}
    }
    // Also notify spatial window to randomize positions (use radius from main if present)
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        const sp = new BroadcastChannel('spatial');
        let radius = null;
        try {
          const el = window.opener && !window.opener.closed ? window.opener.document.getElementById('randMaxDist') : null;
          if (el) radius = parseFloat(el.value);
        } catch (_) {}
        sp.postMessage({ type: 'randomizePositions', radius });
      }
    } catch (_) {}
  });
}


