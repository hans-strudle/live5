// Share a broadcast: the phone's share sheet where there is one, otherwise copy the link.
// The link opens /watch/<id>, which carries a link preview (title, frame) for chat apps.

import { icon } from '/icons.js';

export const streamUrl = (stream) => `${location.origin}/watch/${stream.id}`;

export function shareStream(stream) {
  const who = stream.name || 'Someone';
  return shareLink(stream.status === 'live' ? `${who} is recording on 1take` : `${who} on 1take`, streamUrl(stream));
}

// Any page of the app (e.g. a challenge): share sheet, or copy the link.
export async function shareLink(title, url) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text: title, url });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // closed the share sheet
      // anything else: fall back to copying
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    window.prompt('Copy this link', url);
  }
}

let toastTimer = null;
export function toast(text) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    // inside an open modal (e.g. the comment sheet) the toast must be in that top layer to be seen
    (document.querySelector('dialog[open]') || document.body).append(t);
  }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 1800);
}

export const shareIcon = () => icon('share', 22);
