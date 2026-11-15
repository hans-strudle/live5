// live5 feed: a full-screen vertical timeline of broadcasts, one per screen.
// The card in view plays; its neighbours load ahead of time; far-away cards release their video.
// Used by the home page (everyone) and profile pages (one user).

import { openComments } from '/comments.js';
import { shareStream, shareIcon } from '/share.js';
import { getUser, viewerId } from '/me.js';
import { icon } from '/icons.js';

const MS = window.ManagedMediaSource || window.MediaSource;
const PAGE = 8;
const POLL_MS = 5000; // how often to look for new lives and viewer counts
const allVideos = new Set();

// ---------- sound ----------
// Sound is on unless the viewer turned it off (remembered). Browsers refuse to play sound
// before the person has tapped or clicked on the page; when that happens the video plays muted,
// a "Tap for sound" hint shows, and the next tap anywhere turns the sound on.
const SOUND_KEY = 'live5:sound';
let soundOn = (() => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } })();
let soundBlocked = false; // the browser refused sound; waiting for a tap
let currentVideo = null; // the video on screen
let tapJustUnmuted = false; // the current tap was used to turn sound on (don't also pause etc.)
let soundHint = null;

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

function updateSoundUi() {
  const audible = soundOn && !soundBlocked;
  document.querySelectorAll('.sound').forEach((b) => {
    b.replaceChildren(icon(audible ? 'sound' : 'muted'));
    b.setAttribute('aria-label', audible ? 'Mute' : 'Unmute');
  });
  if (!soundHint && soundOn && soundBlocked) {
    soundHint = el('div', 'sound-hint', 'Tap for sound');
    soundHint.setAttribute('aria-hidden', 'true');
    document.body.append(soundHint);
  }
  if (soundHint) soundHint.hidden = !(soundOn && soundBlocked);
}

// ---------- likes ----------
// Private: a filled heart for the viewer, a quiet record on the server, no counts shown anywhere.
// What this device liked is remembered locally so hearts stay filled.
const LIKED_KEY = 'live5:liked';
const liked = new Set((() => { try { return JSON.parse(localStorage.getItem(LIKED_KEY) || '[]'); } catch { return []; } })());
function setLiked(streamId, on) {
  if (on) liked.add(streamId); else liked.delete(streamId);
  try { localStorage.setItem(LIKED_KEY, JSON.stringify([...liked].slice(-2000))); } catch {}
  const viewer = viewerId();
  if (viewer) {
    fetch(`/api/streams/${streamId}/like`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ viewer, liked: on }),
    }).catch(() => {});
  }
}
const heartIcon = () => icon('heart');

function setSound(on) {
  soundOn = on;
  soundBlocked = false;
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch {}
  for (const v of allVideos) v.muted = !on;
  updateSoundUi();
}

// Play with sound if allowed; if the browser refuses, play muted and wait for a tap.
function playWithSound(v) {
  v.muted = !soundOn || soundBlocked;
  return v.play().then(() => {
    if (soundOn && !v.muted && soundBlocked) { soundBlocked = false; updateSoundUi(); }
  }).catch(() => {
    if (v.muted) return; // failed for some other reason than sound
    soundBlocked = true;
    v.muted = true;
    updateSoundUi();
    v.play().catch(() => {});
  });
}

// The first tap/click/key anywhere lets the browser play sound: use it to unmute the video on
// screen. Runs before the tapped element's own handler (capture), which then ignores this tap.
function unlockSound() {
  if (!soundOn || !soundBlocked || !currentVideo) return;
  soundBlocked = false;
  currentVideo.muted = false;
  currentVideo.play().catch(() => {});
  updateSoundUi();
  tapJustUnmuted = true;
  setTimeout(() => { tapJustUnmuted = false; }, 0);
}
document.addEventListener('click', unlockSound, true);
document.addEventListener('keydown', unlockSound, true);

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

// first: a broadcast id to show before everything else (a shared link), then the feed as usual.
export function createFeed(root, { user = null, first = null, emptyTitle = 'Nothing here yet', emptyText = '' } = {}) {
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
    video.muted = !soundOn || soundBlocked;
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

    const audible = soundOn && !soundBlocked;
    const sound = el('button', 'sound');
    sound.append(icon(audible ? 'sound' : 'muted'));
    sound.type = 'button';
    sound.setAttribute('aria-label', audible ? 'Mute' : 'Unmute');
    sound.onclick = (e) => {
      e.stopPropagation();
      if (tapJustUnmuted) return; // this tap already turned the sound on
      setSound(!soundOn);
      card.video.play().catch(() => {});
    };

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
    const talkIcon = el('span', 'talk-icon');
    talkIcon.append(icon('comment'));
    talk.append(talkIcon, talkCount);
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

    // Like: a heart that fills in. Private — no counts anywhere.
    const like = el('button', 'like-btn');
    like.type = 'button';
    like.append(heartIcon());
    const showLiked = (on) => {
      like.classList.toggle('on', on);
      like.setAttribute('aria-pressed', String(on));
      like.setAttribute('aria-label', on ? 'Unlike' : 'Like');
    };
    showLiked(liked.has(s.id));
    const doLike = (on) => {
      if (on !== liked.has(s.id)) setLiked(s.id, on);
      showLiked(on);
      if (on) { like.classList.remove('pop'); void like.offsetWidth; like.classList.add('pop'); }
    };
    like.onclick = (e) => { e.stopPropagation(); doLike(!liked.has(s.id)); };

    // Double-tap the video to like (never un-likes), with a big heart where the finger was.
    function burst(x, y) {
      const r = node.getBoundingClientRect();
      const b = el('div', 'like-burst');
      b.append(heartIcon());
      b.style.left = `${x - r.left}px`;
      b.style.top = `${y - r.top}px`;
      node.append(b);
      setTimeout(() => b.remove(), 800);
    }

    node.append(video, top, info, like, share, talk, sound, progress, note);

    // Tap the video: if sound is off, turn it on; otherwise pause/resume. Double-tap: like.
    // A single tap waits a moment so a second tap can make it a double-tap instead.
    const DOUBLE_TAP_MS = 300;
    let lastTap = 0, tapTimer = null;
    video.onclick = (e) => {
      const now = Date.now();
      if (now - lastTap < DOUBLE_TAP_MS) {
        clearTimeout(tapTimer);
        tapTimer = null;
        lastTap = 0;
        doLike(true);
        burst(e.clientX, e.clientY);
        return;
      }
      lastTap = now;
      if (tapJustUnmuted) return; // this tap already turned the sound on (a second tap can still like)
      tapTimer = setTimeout(() => {
        tapTimer = null;
        if (!soundOn) { setSound(true); video.play().catch(() => {}); return; }
        if (video.paused) video.play().catch(() => {}); else video.pause();
      }, DOUBLE_TAP_MS);
    };
    video.onended = () => onEnded(card);
    video.ontimeupdate = () => {
      if (card.stream.status !== 'live' && video.duration && Number.isFinite(video.duration)) {
        bar.style.width = `${(video.currentTime / video.duration) * 100}%`;
      }
    };
    // A removed source (detach) isn't a failure; anything else is. A broken live is tried again
    // by the regular check further down: as a live while it lasts, as a replay once it's over.
    video.onerror = () => {
      if (!card.attached) return;
      card.broken = true;
      showNote(card.stream.status === 'live' ? 'Can’t play this live here. The replay will follow.' : 'This video can’t play in this browser.');
    };
    video.onplaying = () => { note.hidden = true; };

    // mode: how the video is being played ('mse' = streamed into Media Source, 'file' = a plain
    // video URL). broken: playback failed.
    const card = {
      stream: s, node, video, badge, meta, note, progress,
      attached: false, abort: null, objectUrl: null, mode: null, broken: false,
    };
    node.card = card;

    function showNote(text) { note.textContent = text; note.hidden = false; }
    card.showNote = showNote;
    render(card);
    return card;
  }

  function render(card) {
    const s = card.stream;
    const live = s.status === 'live';
    card.badge.textContent = 'LIVE';
    card.badge.classList.toggle('on', live);
    card.badge.hidden = !live; // a replay needs no label
    card.meta.textContent = live
      ? `${s.viewers} watching`
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
    card.mode = type ? 'mse' : 'file';
    card.broken = false;
    if (type) playLive(card, type, url);
    else playReplay(card, url);
  }

  // A finished broadcast: a normal video file (the server supports seeking and caching).
  function playReplay(card, url) {
    card.video.loop = false; // onEnded decides: next broadcast, or play this one again
    card.video.preload = 'auto';
    card.video.src = url;
  }

  // The live on this card has ended (seen by the 5-second check, or by the server answering with
  // the finished replay): from now on play it as a replay.
  function markEnded(card) {
    if (card.stream.status !== 'live') return;
    card.stream = { ...card.stream, status: 'ended', endedAt: card.stream.endedAt ?? Date.now() };
    render(card);
  }

  // Start a card's video over, e.g. after losing a live or when it has become a replay.
  function reload(card) {
    detach(card);
    card.note.hidden = true;
    const i = cards.indexOf(card);
    if (Math.abs(i - active) > 1) return; // far away: it loads when scrolled to
    attach(card);
    if (i === active) playWithSound(card.video);
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
      try { sb = ms.addSourceBuffer(type); } catch {
        card.broken = true;
        card.showNote('Can’t play this live here. The replay will follow.');
        return;
      }
      const append = (buf) => new Promise((resolve, reject) => {
        const done = () => { sb.removeEventListener('updateend', ok); sb.removeEventListener('error', bad); };
        const ok = () => { done(); resolve(); };
        const bad = () => { done(); reject(new Error('append failed')); };
        sb.addEventListener('updateend', ok);
        sb.addEventListener('error', bad);
        try { sb.appendBuffer(buf); } catch (e) { done(); reject(e); }
      });
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error('not available');
        // The live ended before we got here: the server sent the finished replay, which Media
        // Source can't take. Play it as an ordinary video instead.
        if (res.headers.get('accept-ranges') === 'bytes') {
          ctrl.abort();
          card.abort = null;
          if (card.objectUrl) URL.revokeObjectURL(card.objectUrl);
          card.objectUrl = null;
          markEnded(card);
          playReplay(card, url);
          if (cards[active] === card) playWithSound(v);
          return;
        }
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done || ctrl.signal.aborted) break;
          if (value && value.length) await append(value);
          jumpToEdge(card);
          if (cards[active] === card && v.paused) playWithSound(v);
        }
        if (ctrl.signal.aborted) return;
        if (ms.readyState === 'open') ms.endOfStream();
        markEnded(card);
      } catch {
        if (ctrl.signal.aborted) return;
        card.broken = true;
        card.showNote('Lost the connection. Trying again…');
      }
    }, { once: true });
  }

  function jumpToEdge(card) {
    const v = card.video;
    if (card.stream.status !== 'live' || !v.buffered.length) return;
    const edge = v.buffered.end(v.buffered.length - 1);
    if (edge - v.currentTime > 3) v.currentTime = Math.max(0, edge - 1); // stay ~1s behind live
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
        currentVideo = card.video;
        playWithSound(card.video);
      } else if (card.attached) {
        card.video.pause();
      }
    });
    if (i >= cards.length - 3) loadMore();
  }

  // ---------- data ----------
  function addCard(s) {
    if (known.has(s.id)) return; // e.g. the shared broadcast turning up again in the feed
    known.add(s.id);
    const card = makeCard(s);
    cards.push(card);
    root.append(card.node);
    io.observe(card.node);
  }

  async function loadMore() {
    if (loading || next == null) return;
    loading = true;
    try {
      const r = await fetch(query({ offset: next, limit: PAGE }));
      const page = await r.json();
      next = page.next;
      for (const s of page.items) addCard(s);
      if (!cards.length) showEmpty();
    } catch {
      if (!cards.length) showEmpty('Couldn’t load the feed. Reload to try again.');
    } finally {
      loading = false;
    }
  }

  function showEmpty(text) {
    if (root.querySelector('.card-empty')) return;
    const box = el('section', 'card card-empty');
    box.append(el('h2', null, emptyTitle), el('p', 'muted', text || emptyText));
    const go = el('a', 'btn live', 'Go live');
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

  // ---------- someone just went live ----------
  // A banner over the feed: "Sam just went live · Watch". Watch puts that live right after the
  // broadcast on screen and scrolls to it. Hides itself after a while, or when the live ends.
  const me = getUser();
  const announced = new Set();
  let bannerLives = [], bannerTimer = null;
  const banner = el('div', 'live-banner');
  banner.hidden = true;
  banner.setAttribute('role', 'status');
  let bannerPic = el('span'); // replaced by the person's picture on each show
  const bannerText = el('div', 'live-banner-text');
  const bannerWatch = el('button', 'btn', 'Watch');
  bannerWatch.type = 'button';
  const bannerClose = el('button', 'live-banner-close');
  bannerClose.append(icon('close', 18));
  bannerClose.type = 'button';
  bannerClose.setAttribute('aria-label', 'Dismiss');
  banner.append(bannerPic, bannerText, bannerWatch, bannerClose);
  document.body.append(banner);

  function showBanner(list) {
    bannerLives = list;
    const s = list[0];
    const pic = avatarNode(s.avatar, s.name, 'avatar xs');
    bannerPic.replaceWith(pic);
    bannerPic = pic;
    bannerText.replaceChildren();
    const name = el('strong', null, s.name);
    const others = list.length - 1;
    bannerText.append(name, others ? ` and ${others} ${others === 1 ? 'other' : 'others'} are live` : ' is live');
    banner.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, 12000);
  }
  function hideBanner() {
    banner.hidden = true;
    bannerLives = [];
    clearTimeout(bannerTimer);
  }
  bannerClose.onclick = (e) => { e.stopPropagation(); hideBanner(); };
  bannerWatch.onclick = (e) => {
    e.stopPropagation();
    const list = bannerLives;
    hideBanner();
    insertNext(list);
  };
  // Put broadcasts right after the one on screen (or at the top) and scroll to the first of them.
  function insertNext(list) {
    root.querySelector('.card-empty')?.remove();
    let at = active + 1, firstCard = null;
    for (const s of list) {
      if (known.has(s.id)) {
        firstCard ??= cards.find((c) => c.stream.id === s.id) ?? null;
        continue;
      }
      known.add(s.id);
      const card = makeCard(s);
      const before = cards[at]?.node ?? null;
      if (before) before.before(card.node); else root.append(card.node);
      cards.splice(at, 0, card);
      io.observe(card.node);
      at++;
      firstCard ??= card;
    }
    firstCard?.node.scrollIntoView({ behavior: 'smooth' });
  }

  // ---------- keeping it fresh ----------
  // Every few seconds: update live viewer counts, and announce lives that started since.
  async function poll() {
    try {
      const r = await fetch(query({ status: 'live', limit: 50 }));
      const { items } = await r.json();
      const liveNow = new Map(items.map((s) => [s.id, s]));
      for (const card of cards) {
        const fresh = liveNow.get(card.stream.id);
        if (card.stream.status !== 'live') continue;
        if (fresh) {
          card.stream.viewers = fresh.viewers;
          render(card);
          if (card.broken && card.attached) reload(card); // lost it mid-live: connect again
        } else if (!card.attached) {
          markEnded(card); // ended since the feed loaded; it will play as a replay
        } else if (card.broken || card.mode === 'file') {
          // Ended, and this card wasn't streaming it properly: show the replay instead.
          markEnded(card);
          if (card.broken) reload(card);
        } // otherwise the card is streaming it and finishes on its own
      }
      const fresh = items.filter((s) => !known.has(s.id) && !announced.has(s.id) && !(me && s.userId === me.id));
      fresh.forEach((s) => announced.add(s.id));
      if (fresh.length) showBanner(fresh);
      else if (bannerLives.length && !bannerLives.some((s) => liveNow.has(s.id))) hideBanner(); // they ended
    } catch {}
  }
  setInterval(poll, POLL_MS);
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

  // A shared link: that broadcast plays first, then the feed continues (auto-advancing) from the top.
  (async () => {
    if (first) {
      try {
        const r = await fetch(`/api/streams/${encodeURIComponent(first)}`);
        if (r.ok) {
          const s = await r.json();
          if (!user || s.userId === user) addCard(s);
        }
      } catch {}
    }
    loadMore();
  })();
  return { reset };
}
