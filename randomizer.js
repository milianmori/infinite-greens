import './ui.js';

// Bridge buttons to main window functions via BroadcastChannel and DOM hooks
const applyBtn = document.getElementById('applyBtn');
const closeBtn = document.getElementById('closeBtn');

applyBtn.addEventListener('click', () => {
  // Trigger the same applyRandomizer flow by dispatching a CustomEvent the ui.js listens to
  if (window.opener && !window.opener.closed) {
    try {
      window.opener.document.getElementById('randomizeBtn')?.click();
    } catch (_) {}
  }
});

closeBtn.addEventListener('click', () => window.close());


