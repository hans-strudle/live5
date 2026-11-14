// Share a broadcast: the phone's share sheet where there is one, otherwise copy the link.
// The link opens /watch/<id>, which carries a link preview (title, frame) for chat apps.

export const streamUrl = (stream) => `${location.origin}/watch/${stream.id}`;

export async function shareStream(stream) {
  const url = streamUrl(stream);
  const who = stream.name || 'Someone';
  const title = stream.status === 'live' ? `${who} is live on live5` : `${who} on live5`;
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

// The share icon (an arrow out of a box), as an element.
export function shareIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path d="M12 3v12M7 8l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
  return svg;
}
