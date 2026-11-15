// First-visit popup explaining live5. Shown once per device, on whichever page is opened first.
(() => {
  const KEY = 'live5:welcomed';
  try { if (localStorage.getItem(KEY)) return; } catch { /* storage blocked: show it anyway */ }

  const dialog = document.createElement('dialog');
  dialog.className = 'welcome';
  dialog.setAttribute('aria-labelledby', 'welcome-title');
  dialog.innerHTML = `
    <h2 id="welcome-title" class="logo">live5</h2>
    <p class="welcome-lead">Live video, <span data-seconds>30</span> seconds at a time.</p>
    <ol>
      <li>Press Go live and you’re on air. There’s no preview first.</li>
      <li>After <span data-seconds>30</span> seconds it cuts off.</li>
      <li>Nothing can be uploaded, edited or deleted afterwards.</li>
      <li data-per-day>You get one live every 12 hours.</li>
    </ol>
    <button class="btn" type="button" autofocus>OK</button>`;

  function close() {
    try { localStorage.setItem(KEY, '1'); } catch {}
    if (dialog.open) dialog.close();
    dialog.remove();
  }
  dialog.querySelector('button').onclick = close;
  dialog.addEventListener('cancel', close); // Esc key
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); }); // tap outside

  function open() {
    document.body.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', ''); // very old browsers: still visible, just not modal
  }
  if (document.body) open(); else document.addEventListener('DOMContentLoaded', open);

  // Fill in the server's actual limits (the defaults above are shown until then).
  fetch('/api/config').then((r) => r.json()).then((c) => {
    if (c.maxSeconds) dialog.querySelectorAll('[data-seconds]').forEach((n) => { n.textContent = c.maxSeconds; });
    const hours = c.limitHours || 12;
    dialog.querySelector('[data-per-day]').textContent = c.maxPerDay > 1
      ? `You get ${c.maxPerDay} lives every ${hours} hours.` : `You get one live every ${hours} hours.`;
  }).catch(() => {});
})();
