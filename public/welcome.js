// First-visit popup explaining live5. Shown once per device, on whichever page is opened first.
(() => {
  const KEY = 'live5:welcomed';
  try { if (localStorage.getItem(KEY)) return; } catch { /* storage blocked: show it anyway */ }

  const dialog = document.createElement('dialog');
  dialog.className = 'welcome';
  dialog.setAttribute('aria-labelledby', 'welcome-title');
  dialog.innerHTML = `
    <h2 id="welcome-title">live<span>5</span></h2>
    <p class="welcome-lead">Hit <strong>Go live</strong> and you're on air instantly.</p>
    <ul>
      <li><strong><span data-seconds>30</span> seconds</strong> per live, then it ends.</li>
      <li><strong>No previews, no edits, no uploads.</strong> Whatever you say goes out to the world.</li>
      <li><strong><span data-per-day>5</span> lives a day.</strong></li>
    </ul>
    <button class="btn" type="button" autofocus>Got it</button>`;

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
    if (c.maxSeconds) dialog.querySelector('[data-seconds]').textContent = c.maxSeconds;
    if (c.maxPerDay) dialog.querySelector('[data-per-day]').textContent = c.maxPerDay;
  }).catch(() => {});
})();
