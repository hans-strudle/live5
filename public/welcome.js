// The "how 1take works" popup. Shown by itself on a device's first visit (whichever page is
// opened first), and again whenever someone taps a help button (any element with data-help).
import { icon } from '/icons.js';

const KEY = 'live5:welcomed'; // storage keys keep the old product name so nothing is forgotten

const dialog = document.createElement('dialog');
dialog.className = 'welcome';
dialog.setAttribute('aria-labelledby', 'welcome-title');
dialog.innerHTML = `
  <button class="welcome-close" type="button" aria-label="Close"></button>
  <h2 id="welcome-title" class="logo">1take</h2>
  <p class="welcome-lead">One take. <span data-seconds>30</span> seconds. No do-overs.</p>
  <ol>
    <li><div><strong>Press Record and you’re rolling.</strong> There’s no preview and no second try.</div></li>
    <li><div><strong>People can watch as you record.</strong> Your take is public from the first second.</div></li>
    <li><div><strong>It stops at <span data-seconds>30</span> seconds.</strong> You can end it sooner.</div></li>
    <li><div><strong>What you record is what stays.</strong> Nothing can be uploaded, edited or deleted.</div></li>
    <li><div><strong data-per-day>One take every 12 hours.</strong> Make it count.</div></li>
  </ol>
  <button class="btn welcome-ok" type="button">Got it</button>`;
dialog.querySelector('.welcome-close').append(icon('close', 18));

function close() {
  try { localStorage.setItem(KEY, '1'); } catch {}
  if (dialog.open) dialog.close();
  dialog.remove();
}
dialog.querySelector('.welcome-close').onclick = close;
dialog.querySelector('.welcome-ok').onclick = close;
dialog.addEventListener('cancel', close); // Esc key
dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); }); // tap outside

function show() {
  if (dialog.isConnected) return;
  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', ''); // very old browsers: still visible, just not modal
  dialog.querySelector('.welcome-ok').focus();
}

// Fill in the server's actual limits (the defaults above are shown until then).
fetch('/api/config').then((r) => r.json()).then((c) => {
  if (c.maxSeconds) dialog.querySelectorAll('[data-seconds]').forEach((n) => { n.textContent = c.maxSeconds; });
  const hours = c.limitHours || 12;
  dialog.querySelector('[data-per-day]').textContent = c.maxPerDay > 1
    ? `${c.maxPerDay} takes every ${hours} hours.` : `One take every ${hours} hours.`;
}).catch(() => {});

// Help buttons: a "?" in each page's top bar that opens this popup at any time.
for (const btn of document.querySelectorAll('[data-help]')) {
  btn.append(icon('help', 20));
  btn.hidden = false;
  btn.onclick = show;
}

let seen = false;
try { seen = !!localStorage.getItem(KEY); } catch { /* storage blocked: show it anyway */ }
if (!seen) show();
