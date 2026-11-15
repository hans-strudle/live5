// The bell button: turn phone notifications ("Sam just went live") on or off for this device.
// Uses Web Push through the service worker (/sw.js). On iPhone/iPad, Apple only allows web
// notifications for sites added to the Home Screen, so in a Safari tab the button explains that.
import { getUser, authHeaders } from '/me.js';
import { toast } from '/share.js';
import { icon } from '/icons.js';

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS reports as Mac
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(b64u) {
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function render(btn, on) {
  btn.replaceChildren(icon(on ? 'bell' : 'bellOff', 20));
  btn.classList.toggle('on', on);
  const label = on ? 'Live alerts are on. Tap to turn them off.' : 'Get an alert when someone goes live';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

async function saveSubscription(sub) {
  const user = getUser();
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: user ? authHeaders(user) : { 'content-type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  });
}

function explainHomeScreen() {
  const d = document.createElement('dialog');
  d.className = 'welcome';
  d.innerHTML = `
    <h2>Live alerts on iPhone</h2>
    <p class="welcome-lead">iPhones only allow alerts from sites on the Home Screen.</p>
    <ol>
      <li>Tap Share in Safari’s toolbar.</li>
      <li>Choose Add to Home Screen.</li>
      <li>Open live5 from there and tap the bell again.</li>
    </ol>
    <button class="btn" type="button">OK</button>`;
  const close = () => { if (d.open) d.close(); d.remove(); };
  d.querySelector('button').onclick = close;
  d.addEventListener('cancel', close);
  document.body.append(d);
  d.showModal();
}

export async function setupBell(btn) {
  if (!pushSupported) {
    if (isIOS && !standalone) { // iPhone Safari tab: show how to enable it
      btn.hidden = false;
      render(btn, false);
      btn.onclick = explainHomeScreen;
    }
    return;
  }
  let reg;
  try { reg = await navigator.serviceWorker.register('/sw.js'); } catch { return; }
  btn.hidden = false;
  let sub = await reg.pushManager.getSubscription();
  render(btn, !!sub && Notification.permission === 'granted');
  if (sub && Notification.permission === 'granted') saveSubscription(sub).catch(() => {}); // keep the server's copy current

  btn.onclick = async () => {
    btn.disabled = true;
    try {
      sub = await reg.pushManager.getSubscription();
      if (sub && Notification.permission === 'granted') {
        await fetch('/api/push/unsubscribe', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe();
        render(btn, false);
        toast('Live alerts off');
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast(permission === 'denied' ? 'Notifications are blocked in your browser settings' : 'Live alerts are still off');
        return;
      }
      const { publicKey } = await (await fetch('/api/push/key')).json();
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      await saveSubscription(sub);
      render(btn, true);
      toast('Live alerts on');
    } catch {
      toast('Couldn’t turn on live alerts');
    } finally {
      btn.disabled = false;
    }
  };
}
