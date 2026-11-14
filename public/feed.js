// live5 feed: a full-screen vertical timeline of broadcasts, one per screen.
// The card in view plays; its neighbours load ahead of time; far-away cards release their video.
// Used by the home page (everyone) and profile pages (one user).

import { openComments } from '/comments.js';
import { shareStream, shareIcon } from '/share.js';

const MS = window.ManagedMediaSource || window.MediaSource;
const PAGE = 8;
let soundOn = false;
const allVideos = new Set();

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const seconds = (ms) => `${Math.max(1, Math.round(ms / 1000))}s`;

// A Media Source type string this browser accepts for the recorder's format, if any.
function mseType(type) {
  if (!MS || !type) return null;
  const base = type.split(';')[0].trim();
  const guesses = [type, ...(base === 'video/mp4'
    ? ['video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/mp4; codecs="avc1.4D401F, mp4a.40.2"', 'video/mp4; codecs="avc1.42E01E"']
    : ['video/webm; codecs="vp8, opus"', 'video/webm; codecs="vp9, opus"', 'video/webm; codecs="vp8"'])];
  return guesses.find((t) => { try { return MS.isTypeSupported(t); } catch { return false; } }) || null;
}

function setSound(on) {
  soundOn = on;
  for (const v of allVideos) v.muted = !on;
  document.querySelectorAll('.sound').forEach((b) => {
    b.textContent = on ? '🔊' : '🔇';
    b.setAttribute('aria-label', on ? 'Mute' : 'Unmute');
  });
}

// Profile picture: a frame from the person's latest live, or their initial when there's none yet.
export function avatarNode(url, name, cls = 'avatar') {
  const initial = () => {
    const d = el('span', cls, [...(name || '?')][0].toUpperCase());
    d.setAttribute('aria-hidden', 'true');
    return d;
  };
  if (!url) return initial();
  const img = el('img', cls);
  img.src = url;
  img.alt = '';
  img.decoding = 'async';
  img.onerror = () => img.replaceWith(initial());
  return img;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function createFeed(root, { user = null, emptyTitle = 'Nothing here yet', emptyText = '', newPill = null } = {}) {
  const cards = [];
  const known = new Set();
  let next = 0, loading = false, active = -1;
  // Auto-advance: when the broadcast on screen finishes, move on to the next one. If the viewer
  // got here by scrolling back up, they want to watch this one, so it loops instead.
  let advance = true;

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && e.intersectionRatio >= 0.6) setActive(cards.indexOf(e.target.card));
    }
  }, { root, threshold: [0.6] });

  const query = (extra) => {
    const p = new URLSearchParams(extra);
    if (user) p.set('user', user);
    return `/api/streams?${p}`;
  };

  // ---------- cards ----------
  function makeCard(s) {
    const node = el('article', 'card');
    const video = el('video');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.muted = !soundOn;
    video.preload = 'none';
    if (s.poster) video.poster = s.poster;
    allVideos.add(video);

    const top = el('div', 'card-top');
    const badge = el('span', 'badge');
    top.append(badge);

    const info = el('div', 'card-info');
    const who = el('a', 'card-who');
    who.href = `/u/${s.userId}`;
    who.append(avatarNode(s.avatar, s.name, 'avatar sm'), el('span', 'card-name', s.name));
    const meta = el('div', 'card-meta');
    info.append(who, meta);

    const sound = el('button', 'sound', soundOn ? '🔊' : '🔇');
    sound.type = 'button';
    sound.setAttribute('aria-label', soundOn ? 'Mute' : 'Unmute');
    sound.onclick = (e) => { e.stopPropagation(); setSound(!soundOn); card.video.play().catch(() => {}); };

    const progress = el('div', 'card-progress');
    const bar = el('i');
    progress.append(bar);

    const note = el('div', 'card-note');
    note.hidden = true;

    // Comments: opens the comment sheet over the video; the count updates as people comment.
    const talk = el('button', 'talk');
    talk.type = 'button';
    talk.setAttribute('aria-label', 'Comments');
    const talkCount = el('span', 'talk-count');
    talk.append(el('span', 'talk-icon', '💬'), talkCount);
    const showCount = (n) => { talkCount.textContent = n ? String(n) : ''; };
    showCount(s.commentCount);
    talk.onclick = (e) => {
      e.stopPropagation();
      openComments(card.stream, { onCount: (n) => { card.stream.commentCount = n; showCount(n); } });
    };

    // Share: the phone's share sheet, or copy the link.
    const share = el('button', 'share-btn');
    share.type = 'button';
    share.setAttribute('aria-label', 'Share');
    share.append(shareIcon());
    share.onclick = (e) => { e.stopPropagation(); shareStream(card.stream); };

    node.append(video, top, info, share, talk, sound, progress, note);

    // Tap the video: first tap turns sound on; after that it pauses/resumes.
    video.onclick = () => {
      if (!soundOn) { setSound(true); video.play().catch(() => {}); return; }
      if (video.paused) video.play().catch(() => {}); else video.pause();
    };
    video.onended = () => onEnded(card);
    video.ontimeupdate = () => {
      if (card.stream.status !== 'live' && video.duration && Number.isFinite(video.duration)) {
        bar.style.width = `${(video.currentTime / video.duration) * 100}%`;
      }
    };
    video.onerror = () => showNote('This video can’t play in this browser.');

    const card = { stream: s, node, video, badge, meta, note, progress, attached: false, abort: null, objectUrl: null };
    node.card = card;

    function showNote(text) { note.textContent = text; note.hidden = false; }
    card.showNote = showNote;
    render(card);
    return card;
  }

  function render(card) {
    const s = card.stream;
    const live = s.status === 'live';
    card.badge.textContent = live ? 'LIVE' : 'REPLAY';
    card.badge.classList.toggle('on', live);
    card.meta.textContent = live
      ? `Live now · ${s.viewers} watching`
      : `${ago(s.startedAt)}${s.durationMs ? ` · ${seconds(s.durationMs)}` : ''}`;
    card.progress.hidden = live;
  }

  // ---------- playback ----------
  function attach(card) {
    if (card.attached) return;
    card.attached = true;
    const s = card.stream;
    const url = `/api/streams/${s.id}/video`;
    const type = s.status === 'live' ? mseType(s.type) : null;
    if (type) {
      playLive(card, type, url);
    } else {
      card.video.loop = false; // onEnded decides: next broadcast, or play this one again
      card.video.preload = 'auto';
      card.video.src = url;
    }
  }

  function detach(card) {
    if (!card.attached) return;
    card.attached = false;
    if (card.abort) card.abort.abort();
    card.abort = null;
    card.video.pause();
    card.video.removeAttribute('src');
    card.video.load();
    if (card.objectUrl) URL.revokeObjectURL(card.objectUrl);
    card.objectUrl = null;
  }

  // Live: stream the open-ended response into Media Source (works on iOS and Android).
  function playLive(card, type, url) {
    const v = card.video;
    const ms = new MS();
    const ctrl = new AbortController();
    card.abort = ctrl;
    if (window.ManagedMediaSource && MS === window.ManagedMediaSource) v.disableRemotePlayback = true;
    card.objectUrl = URL.createObjectURL(ms);
    v.src = card.objectUrl;
    ms.addEventListener('sourceopen', async () => {
      let sb;
      try { sb = ms.addSourceBuffer(type); } catch { card.showNote('This live can’t play in this browser.'); return; }
      const append = (buf) => new Promise((resolve, reject) => {
        sb.addEventListener('updateend', resolve, { once: true });
        sb.addEventListener('error', reject, { once: true });
        sb.appendBuffer(buf);
      });
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done || ctrl.signal.aborted) break;
          if (value && value.length) await append(value);
          jumpToEdge(card);
          if (cards[active] === card) v.play().catch(() => v.muted || mutedFallback(v));
        }
        if (ctrl.signal.aborted) return;
        if (ms.readyState === 'open') ms.endOfStream();
        card.stream = { ...card.stream, status: 'ended', endedAt: Date.now() };
        render(card);
      } catch {
        if (!ctrl.signal.aborted) card.showNote('Lost the connection to this live.');
      }
    }, { once: true });
  }

  function jumpToEdge(card) {
    const v = card.video;
    if (card.stream.status !== 'live' || !v.buffered.length) return;
    const edge = v.buffered.end(v.buffered.length - 1);
    if (edge - v.currentTime > 3) v.currentTime = Math.max(0, edge - 1); // stay ~1s behind live
  }

  // Browsers may refuse to autoplay with sound; fall back to muted rather than not playing.
  function mutedFallback(v) {
    setSound(false);
    v.play().catch(() => {});
  }

  function onEnded(card) {
    if (cards[active] !== card) return;
    const following = cards[active + 1];
    if (advance && following) {
      following.node.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (advance && next != null) loadMore(); // more may be on the way; keep this one playing meanwhile
    card.video.currentTime = 0;
    card.video.play().catch(() => {});
  }

  function setActive(i) {
    if (i < 0 || i === active) return;
    if (active >= 0) advance = i > active; // scrolled back up → stay and loop; down (or auto) → keep advancing
    active = i;
    cards.forEach((card, j) => {
      const d = Math.abs(j - i);
      if (d <= 1) attach(card); else if (d > 2) detach(card);
      if (j === i) {
        card.video.muted = !soundOn;
        card.video.play().catch(() => mutedFallback(card.video));
      } else if (card.attached) {
        card.video.pause();
      }
    });
    if (i >= cards.length - 3) loadMore();
  }

  // ---------- data ----------
  async function loadMore() {
    if (loading || next == null) return;
    loading = true;
    try {
      const r = await fetch(query({ offset: next, limit: PAGE }));
      const page = await r.json();
      next = page.next;
      for (const s of page.items) {
        if (known.has(s.id)) continue;
        known.add(s.id);
        const card = makeCard(s);
        cards.push(card);
        root.append(card.node);
        io.observe(card.node);
      }
      if (!cards.length) showEmpty();
    } catch {
      if (!cards.length) showEmpty('Could not load the feed. Pull down or reload to try again.');
    } finally {
      loading = false;
    }
  }

  function showEmpty(text) {
    if (root.querySelector('.card-empty')) return;
    const box = el('section', 'card card-empty');
    box.append(el('h2', null, emptyTitle), el('p', 'muted', text || emptyText));
    const go = el('a', 'btn', 'Go live');
    go.href = '/go';
    box.append(go);
    root.append(box);
  }

  function reset() {
    cards.forEach(detach);
    cards.forEach((c) => { io.unobserve(c.node); c.node.remove(); allVideos.delete(c.video); });
    cards.length = 0;
    known.clear();
    root.querySelector('.card-empty')?.remove();
    next = 0;
    active = -1;
    root.scrollTo({ top: 0 });
    return loadMore();
  }

  // ---------- keeping it fresh ----------
  // Every 10s: update live viewer counts, and offer new lives that started since loading.
  async function poll() {
    try {
      const r = await fetch(query({ status: 'live', limit: 50 }));
      const { items } = await r.json();
      const liveNow = new Map(items.map((s) => [s.id, s]));
      for (const card of cards) {
        const fresh = liveNow.get(card.stream.id);
        if (fresh && card.stream.status === 'live') { card.stream.viewers = fresh.viewers; render(card); }
      }
      const unseen = items.filter((s) => !known.has(s.id)).length;
      if (newPill) {
        newPill.hidden = unseen === 0;
        newPill.textContent = `${unseen} new ${unseen === 1 ? 'live' : 'lives'} ↑`;
      }
    } catch {}
  }
  if (newPill) newPill.onclick = () => { newPill.hidden = true; reset(); };
  setInterval(poll, 10000);
  setInterval(() => cards.forEach(render), 30000); // "2m ago" etc.

  // Keyboard on desktop: arrows / j k move between broadcasts.
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[e.key];
    if (!step || !cards.length) return;
    e.preventDefault();
    const target = cards[Math.min(cards.length - 1, Math.max(0, active + step))];
    target.node.scrollIntoView({ behavior: 'smooth' });
  });

  loadMore();
  return { reset };
}
