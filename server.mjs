import http from 'node:http';
import https from 'node:https';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, appendFile, rename, stat } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { isFragmentedMp4, defragmentMp4 } from './mp4.mjs';
import { loadVapid, cleanSubscription, sendPush } from './push.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const EXT = { 'video/webm': 'webm', 'video/mp4': 'mp4' };
const STATIC = {
  '/': ['index.html', 'text/html'],
  '/go': ['go.html', 'text/html'],
};
// Scripts and styles: any top-level public/<name>.js or .css, looked up when requested, so a new
// file works without restarting the server. The pattern allows no slashes or extra dots, so
// nothing outside public/ can be reached.
const ASSET = /^\/([a-z0-9][a-z0-9-]*)\.(js|css|svg|webmanifest)$/i;
const ASSET_TYPES = {
  js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', webmanifest: 'application/manifest+json',
};
const MAX_PUSH_SUBSCRIPTIONS = 20000;
const MAX_POSTER_BYTES = 300 * 1024;
const FINAL_PIECE_GRACE = 3; // seconds
const clampInt = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
// /watch/:streamId (a shared link: the main feed, starting with that broadcast) and /u/:userId
// (a profile) are pages that load their data from the API.
const PAGES = { watch: 'index.html', u: 'profile.html' };

// No logins. Each device gets a user: a public UUID (used in profile links and to tie
// broadcasts to the person) plus a private key the device keeps to act as that user.
// Display names are free text, not unique, and can be changed; the UUID never changes.
export const MAX_NAME = 30;
export const MAX_COMMENT = 200;
// One line of plain text: whitespace collapsed, control and invisible characters removed.
// Empty string if missing or longer than max characters.
function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  const text = raw.normalize('NFC')
    .replace(/\s+/g, ' ') // tabs, newlines and runs of spaces become one space
    // then drop other control and invisible-format characters (keeping the emoji joiner)
    .replace(/\p{Cc}|(?!‍)\p{Cf}/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  return [...text].length > max ? '' : text;
}
export const cleanName = (raw) => cleanText(raw, MAX_NAME);
export const cleanComment = (raw) => cleanText(raw, MAX_COMMENT);
const COMMENT_GAP_MS = 3000; // one comment every 3 seconds per user
const VIEWER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // anonymous per-device id (likes)

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Width and height of a JPEG, read from its frame header (SOF marker). null if not found.
export function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function createApp({
  maxSeconds = Number(process.env.LIVE5_MAX_SECONDS) || 30,
  maxBytes = 10 * 1024 * 1024,
  maxChunkBytes = 4 * 1024 * 1024,
  idleSeconds = 10,
  maxPerDay = Number(process.env.LIVE5_MAX_PER_DAY) || 1, // lives allowed per window (below)
  limitHours = Number(process.env.LIVE5_LIMIT_HOURS) || 12, // the rolling window: one live every 12 hours
  finalPieceGrace = FINAL_PIECE_GRACE,
  dataDir = process.env.LIVE5_DATA_DIR || path.join(ROOT, 'data'),
  tls = null,
} = {}) {
  // ---- storage: data/users.json, data/streams/<id>.json (details) + <id>.<ext> (video) ----
  const streamDir = path.join(dataDir, 'streams');
  mkdirSync(streamDir, { recursive: true });
  const usersFile = path.join(dataDir, 'users.json');

  const users = new Map(); // id -> { id, name, secretHash, createdAt }
  for (const u of readJson(usersFile, [])) users.set(u.id, u);

  const streams = new Map();
  for (const f of readdirSync(streamDir)) {
    if (!f.endsWith('.json')) continue;
    const meta = readJson(path.join(streamDir, f), null);
    if (!meta || !meta.id) continue;
    if (meta.status === 'live') {
      // The server stopped mid-broadcast. The saved details are from when it started, so take
      // the size and end time from the recording itself.
      let bytes = 0, endedAt = meta.startedAt;
      try {
        const st = statSync(path.join(streamDir, `${meta.id}.${meta.ext}`));
        bytes = st.size;
        endedAt = Math.max(meta.startedAt, Math.round(st.mtimeMs));
      } catch {}
      Object.assign(meta, { status: 'ended', endedAt, endReason: 'server-restart', bytes });
      writeFileSync(path.join(streamDir, f), JSON.stringify(meta, null, 2));
    }
    if (meta.status === 'ended' && !meta.bytes) meta.empty = true; // nothing was recorded
    streams.set(meta.id, { ...meta, viewers: new Set() });
  }

  // ---- Web Push: who wants a phone notification when someone goes live ----
  // data/vapid.json is the server's push key pair; data/push.json the subscriptions
  // ({ endpoint, keys, userId? }). A subscription tied to a user isn't told about their own lives.
  const vapid = loadVapid(path.join(dataDir, 'vapid.json'));
  const pushFile = path.join(dataDir, 'push.json');
  const pushSubs = new Map(); // endpoint -> subscription
  for (const sub of readJson(pushFile, [])) if (sub?.endpoint) pushSubs.set(sub.endpoint, sub);
  // Push services want a contact for the sender: set LIVE5_VAPID_SUBJECT (mailto: or https: URL).
  const vapidSubject = process.env.LIVE5_VAPID_SUBJECT || process.env.LIVE5_PUBLIC_URL || 'mailto:live5@example.com';
  let pushWrite = Promise.resolve();
  function savePushSubs() {
    const snapshot = JSON.stringify([...pushSubs.values()], null, 2);
    pushWrite = pushWrite.then(async () => {
      await writeFile(`${pushFile}.tmp`, snapshot);
      await rename(`${pushFile}.tmp`, pushFile);
    }).catch((e) => console.error('saving push subscriptions failed', e));
    return pushWrite;
  }

  // "Sam just went live": to every subscribed device except the broadcaster's own, a few at a
  // time. Subscriptions the push service says are gone (404/410) are forgotten.
  async function notifyLive(s) {
    const u = users.get(s.userId);
    const data = {
      title: `${u?.name ?? 'Someone'} just went live`,
      body: `Live for the next ${maxSeconds} seconds.`,
      url: `/watch/${s.id}`,
      icon: avatarOf(s.userId),
      tag: `live-${s.id}`,
    };
    const targets = [...pushSubs.values()].filter((sub) => sub.userId !== s.userId);
    let removed = false;
    for (let i = 0; i < targets.length; i += 10) {
      await Promise.all(targets.slice(i, i + 10).map(async (sub) => {
        const status = await sendPush(sub, data, vapid, vapidSubject, maxSeconds + 30);
        if (status === 404 || status === 410) { pushSubs.delete(sub.endpoint); removed = true; }
        else if (status >= 400) console.error(`push to ${new URL(sub.endpoint).host} failed: ${status}`);
      }));
    }
    if (removed) savePushSubs();
  }

  let usersWrite = Promise.resolve();
  function saveUsers() {
    const snapshot = JSON.stringify([...users.values()], null, 2);
    usersWrite = usersWrite.then(async () => {
      await writeFile(`${usersFile}.tmp`, snapshot);
      await rename(`${usersFile}.tmp`, usersFile);
    }).catch((e) => console.error('saving users failed', e));
    return usersWrite;
  }

  const videoFile = (s) => path.join(streamDir, `${s.id}.${s.ext}`);
  const posterFile = (s) => path.join(streamDir, `${s.id}.jpg`);
  // What replays serve: the converted plain MP4 when there is one, else the recording itself.
  const replayFile = (s) => (s.replay ? path.join(streamDir, s.replay) : videoFile(s));
  function saveStream(s) {
    const meta = {
      id: s.id, userId: s.userId, type: s.type, ext: s.ext, status: s.status,
      startedAt: s.startedAt, endedAt: s.endedAt ?? null, endReason: s.endReason ?? null, bytes: s.bytes,
      hasPoster: !!s.hasPoster, replay: s.replay ?? null, empty: !!s.empty, commentCount: s.commentCount ?? 0,
      likeCount: s.likeCount ?? 0, // kept for later; never sent to viewers or the broadcaster
    };
    s.saving = (s.saving ?? Promise.resolve())
      .then(() => writeFile(path.join(streamDir, `${s.id}.json`), JSON.stringify(meta, null, 2)))
      .catch((e) => console.error('saving stream failed', e));
    return s.saving;
  }

  // ---- live state ----
  function endStream(s, reason) {
    if (s.status !== 'live') return;
    s.status = 'ended';
    s.endedAt = Date.now();
    s.endReason = reason;
    clearTimeout(s.capTimer);
    clearTimeout(s.idleTimer);
    for (const res of s.viewers) res.end();
    s.viewers.clear();
    s.chunks = null; // the video is on disk; replays read it from there
    s.token = null;
    saveStream(s);
    s.finalizing = finalize(s);
  }

  // After a broadcast ends: MediaRecorder writes fragmented MP4, which some browsers won't play
  // from a URL. Write a plain MP4 copy for replays (the recording itself is left untouched).
  // A recording with no playable samples is marked empty and left out of the feed.
  async function finalize(s) {
    try {
      await s.lastAppend?.catch(() => {});
      // Nothing arrived at all (any format): not a live worth showing or counting.
      if (!s.bytes && !s.empty) { s.empty = true; avatars.delete(s.userId); await saveStream(s); return; }
      if (s.ext !== 'mp4' || s.replay || s.empty) return;
      let buf;
      try { buf = await readFile(videoFile(s)); } catch { buf = Buffer.alloc(0); }
      if (!isFragmentedMp4(buf)) {
        if (!buf.length || !boxesHaveMedia(buf)) { s.empty = true; avatars.delete(s.userId); await saveStream(s); }
        return;
      }
      const plain = defragmentMp4(buf);
      if (!plain) { s.empty = true; avatars.delete(s.userId); await saveStream(s); return; }
      const name = `${s.id}.replay.mp4`;
      await writeFile(path.join(streamDir, `${name}.tmp`), plain);
      await rename(path.join(streamDir, `${name}.tmp`), path.join(streamDir, name));
      s.replay = name;
      await saveStream(s);
    } catch (e) {
      console.error(`preparing replay for ${s.id} failed`, e);
    }
  }
  // A non-fragmented file needs at least one media box to be worth showing.
  const boxesHaveMedia = (buf) => buf.includes(Buffer.from('mdat')) || buf.includes(Buffer.from('moof'));

  // Recordings from before replays were converted (or interrupted by a restart): convert now,
  // one at a time, in the background.
  queueMicrotask(async () => {
    for (const s of streams.values()) {
      if (s.status === 'ended' && s.ext === 'mp4' && !s.replay && !s.empty) {
        s.finalizing = finalize(s);
        await s.finalizing;
      }
    }
  });

  function touch(s) {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => endStream(s, 'idle'), idleSeconds * 1000);
  }

  function publicStream(s) {
    return {
      id: s.id,
      userId: s.userId,
      name: users.get(s.userId)?.name ?? 'Someone',
      status: s.status,
      type: s.type,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      endReason: s.endReason ?? null,
      durationMs: s.endedAt ? s.endedAt - s.startedAt : null,
      poster: s.hasPoster ? `/api/streams/${s.id}/poster` : null,
      avatar: avatarOf(s.userId),
      commentCount: s.commentCount ?? 0,
      maxSeconds,
      viewers: s.viewers.size,
    };
  }

  // Profile picture: the preview frame of the person's latest live that has one (skipping
  // recordings with no video). Cached per user; forgotten whenever a new frame arrives or a
  // recording turns out empty.
  const avatars = new Map(); // userId -> poster URL or null
  function avatarOf(userId) {
    if (!avatars.has(userId)) {
      let latest = null;
      for (const s of streams.values()) {
        if (s.userId === userId && s.hasPoster && !s.empty && (!latest || s.startedAt > latest.startedAt)) latest = s;
      }
      avatars.set(userId, latest ? `/api/streams/${latest.id}/poster` : null);
    }
    return avatars.get(userId);
  }

  // ---- comments: data/streams/<id>.comments.jsonl, one JSON object per line, loaded on first use ----
  // ---- likes: data/streams/<id>.likes.jsonl, one {viewer, liked, at} line per change ----
  // Private: likes aren't shown to anyone. One like per device (anonymous viewer id), toggleable.
  const likesFile = (s) => path.join(streamDir, `${s.id}.likes.jsonl`);
  function loadLikes(s) {
    s.likes ??= readFile(likesFile(s), 'utf8')
      .then((text) => {
        const set = new Set();
        for (const line of text.split('\n')) {
          try { const e = JSON.parse(line); if (e.liked) set.add(e.viewer); else set.delete(e.viewer); } catch {}
        }
        return set;
      })
      .catch(() => new Set());
    return s.likes;
  }

  const commentsFile = (s) => path.join(streamDir, `${s.id}.comments.jsonl`);
  const lastCommentAt = new Map(); // userId -> time of their last comment (in memory)
  function loadComments(s) {
    s.comments ??= readFile(commentsFile(s), 'utf8')
      .then((text) => text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean))
      .catch(() => []);
    return s.comments;
  }
  const publicComment = (c) => ({
    id: c.id, userId: c.userId, name: users.get(c.userId)?.name ?? 'Someone', avatar: avatarOf(c.userId),
    text: c.text, createdAt: c.createdAt,
  });

  const publicUser = (u) => ({ id: u.id, name: u.name, createdAt: u.createdAt, avatar: avatarOf(u.id) });

  // Live limit: at most maxPerDay lives started in any rolling window of limitHours (default:
  // one live every 12 hours). Lives that recorded no video don't count. nextAt is when the oldest
  // counted live drops out of the window. (Field names say "day"/"today" for history.)
  const WINDOW_MS = limitHours * 60 * 60 * 1000;
  function dailyUsage(u, now = Date.now()) {
    const recent = [...streams.values()]
      .filter((s) => s.userId === u.id && !s.empty && s.startedAt > now - WINDOW_MS)
      .map((s) => s.startedAt)
      .sort((a, b) => a - b);
    const leftToday = Math.max(0, maxPerDay - recent.length);
    return {
      dailyLimit: maxPerDay,
      limitHours,
      usedToday: recent.length,
      leftToday,
      nextAt: leftToday ? null : recent[recent.length - maxPerDay] + WINDOW_MS,
    };
  }
  // What a user sees about themselves (never shown on public profiles).
  const selfView = (u) => ({ ...publicUser(u), ...dailyUsage(u) });

  // ---- http helpers ----
  function json(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function tokenOk(s, req) {
    if (!s.token) return false;
    const given = Buffer.from(String(req.headers['x-broadcast-token'] ?? ''));
    const want = Buffer.from(s.token);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  // The device proves it is a user with x-user-id + x-user-secret. Only a hash is stored.
  function currentUser(req) {
    const u = users.get(String(req.headers['x-user-id'] ?? ''));
    const secret = String(req.headers['x-user-secret'] ?? '');
    if (!u || !secret) return null;
    return timingSafeEqual(Buffer.from(sha256(secret)), Buffer.from(u.secretHash)) ? u : null;
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const parts = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
        parts.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(parts)));
      // e.g. the sender went away mid-request
      req.on('error', () => reject(Object.assign(new Error('request was cut off'), { status: 400 })));
    });
  }

  async function readJsonBody(req, limit = 1024) {
    try { return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}') ?? {}; }
    catch { return null; }
  }

  // ---- routes ----
  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return json(res, 400, { error: 'bad request' }); }
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && Object.hasOwn(STATIC, url.pathname)) {
      return sendPage(req, res, STATIC[url.pathname][0], { kind: 'home' });
    }
    const asset = req.method === 'GET' && ASSET.exec(url.pathname);
    if (asset) {
      let body;
      try { body = await readFile(path.join(PUBLIC_DIR, `${asset[1]}.${asset[2]}`)); }
      catch { return json(res, 404, { error: 'not found' }); }
      res.writeHead(200, { 'content-type': `${ASSET_TYPES[asset[2].toLowerCase()]}; charset=utf-8`, 'cache-control': 'no-cache' });
      return res.end(body);
    }
    if (req.method === 'GET' && parts.length === 2 && Object.hasOwn(PAGES, parts[0])) {
      return sendPage(req, res, PAGES[parts[0]], { kind: parts[0], id: parts[1] });
    }
    // GET /oembed?url=<page url> — oEmbed for apps that look for it (title, author, thumbnail).
    if (req.method === 'GET' && url.pathname === '/oembed') return sendOembed(req, res, url);

    // GET /api/config — the rules pages explain to people (e.g. the welcome popup).
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return json(res, 200, { maxSeconds, maxPerDay, limitHours });
    }
    // Web Push: GET /api/push/key (the server's public key for subscribing),
    // POST /api/push/subscribe { endpoint, keys } (user headers optional), POST /api/push/unsubscribe { endpoint }.
    if (url.pathname === '/api/push/key' && req.method === 'GET') return json(res, 200, { publicKey: vapid.publicKey });
    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
      const sub = cleanSubscription(await readJsonBody(req, 4096));
      if (!sub) return json(res, 400, { error: 'not a valid push subscription' });
      if (!pushSubs.has(sub.endpoint) && pushSubs.size >= MAX_PUSH_SUBSCRIPTIONS) return json(res, 503, { error: 'too many subscriptions' });
      const u = currentUser(req);
      pushSubs.set(sub.endpoint, { ...sub, userId: u?.id ?? null, createdAt: pushSubs.get(sub.endpoint)?.createdAt ?? Date.now() });
      await savePushSubs();
      return json(res, 201, { ok: true });
    }
    if (url.pathname === '/api/push/unsubscribe' && req.method === 'POST') {
      const body = await readJsonBody(req, 4096);
      if (body && pushSubs.delete(String(body.endpoint ?? ''))) await savePushSubs();
      return json(res, 200, { ok: true });
    }
    if (parts[0] === 'api' && parts[1] === 'users') return handleUsers(req, res, parts);
    if (parts[0] === 'api' && parts[1] === 'streams') return handleStreams(req, res, url, parts);
    return json(res, 404, { error: 'not found' });
  }

  // ---- link previews ----
  // Chat apps and social sites don't run JavaScript, so each page is sent with its preview
  // tags (Open Graph, Twitter card, oEmbed link) already filled in: who, what, and an image.
  // Pages mark the spot with <!--META--> in their <head>.
  function publicOrigin(req) {
    if (process.env.LIVE5_PUBLIC_URL) return process.env.LIVE5_PUBLIC_URL.replace(/\/+$/, '');
    const first = (v) => String(v ?? '').split(',')[0].trim();
    let proto = first(req.headers['x-forwarded-proto']) || (tls ? 'https' : 'http');
    if (proto !== 'https' && proto !== 'http') proto = 'https';
    let host = first(req.headers['x-forwarded-host']) || first(req.headers.host);
    if (!/^[a-z0-9.\-:[\]]{1,255}$/i.test(host)) host = 'localhost';
    return `${proto}://${host}`;
  }

  const SITE_DESCRIPTION = `Live video, ${maxSeconds} seconds at a time. No uploads, no editing.`;

  async function posterSize(s) {
    if (!s.hasPoster) return null;
    if (s.posterSize === undefined) {
      s.posterSize = null;
      try { s.posterSize = jpegSize(await readFile(posterFile(s))); } catch {}
    }
    return s.posterSize;
  }
  const latestWithPoster = (filter) => [...streams.values()]
    .filter((s) => s.hasPoster && !s.empty && filter(s))
    .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;

  // Everything a preview needs, for the home page, a broadcast or a profile.
  async function preview(kind, id) {
    let info = { title: 'live5', description: SITE_DESCRIPTION, path: '/', image: null, type: 'website' };
    if (kind === 'watch') {
      const s = streams.get(id);
      const u = s && users.get(s.userId);
      if (s && !s.empty) {
        const name = u?.name ?? 'Someone';
        const secs = s.endedAt ? Math.max(1, Math.round((s.endedAt - s.startedAt) / 1000)) : null;
        const day = new Date(s.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
        info = {
          title: s.status === 'live' ? `${name} is live on live5` : `${name} on live5`,
          description: s.status === 'live' ? 'Live right now. Catch it before it ends.' : `A ${secs ? `${secs}-second ` : ''}live from ${day}.`,
          path: `/watch/${s.id}`, image: s.hasPoster ? s : null, type: 'video.other',
          author: u && { name, path: `/u/${u.id}` },
        };
      }
    } else if (kind === 'u') {
      const u = users.get(id);
      if (u) {
        const count = [...streams.values()].filter((s) => s.userId === u.id && !s.empty).length;
        info = {
          title: `${u.name} on live5`,
          description: `${count} ${count === 1 ? 'live' : 'lives'} on live5. ${SITE_DESCRIPTION}`,
          path: `/u/${u.id}`, image: latestWithPoster((s) => s.userId === u.id), type: 'profile',
          author: { name: u.name, path: `/u/${u.id}` },
        };
      }
    } else {
      info.image = latestWithPoster(() => true); // the newest live's frame for the home page
    }
    return info;
  }

  async function sendPage(req, res, file, { kind, id }) {
    let html = (await readFile(path.join(PUBLIC_DIR, file))).toString('utf8');
    const base = publicOrigin(req);
    const p = await preview(kind, id);
    const pageUrl = base + p.path;
    const size = p.image ? await posterSize(p.image) : null;
    const tags = [
      ['property', 'og:site_name', 'live5'],
      ['property', 'og:type', p.type],
      ['property', 'og:title', p.title],
      ['property', 'og:description', p.description],
      ['property', 'og:url', pageUrl],
      ['name', 'description', p.description],
      ['name', 'twitter:card', p.image ? 'summary_large_image' : 'summary'],
      ['name', 'twitter:title', p.title],
      ['name', 'twitter:description', p.description],
      ['name', 'theme-color', '#0b0b0a'],
    ];
    if (p.image) {
      const img = `${base}/api/streams/${p.image.id}/poster`;
      tags.push(['property', 'og:image', img], ['property', 'og:image:type', 'image/jpeg'],
        ['property', 'og:image:alt', p.title], ['name', 'twitter:image', img]);
      if (size) tags.push(['property', 'og:image:width', String(size.width)], ['property', 'og:image:height', String(size.height)]);
    }
    const meta = tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeHtml(value)}">`);
    meta.push(`<link rel="canonical" href="${escapeHtml(pageUrl)}">`);
    if (kind === 'watch' || kind === 'u') {
      meta.push(`<link rel="alternate" type="application/json+oembed" href="${escapeHtml(`${base}/oembed?format=json&url=${encodeURIComponent(pageUrl)}`)}" title="${escapeHtml(p.title)}">`);
    }
    html = html.replace('<!--META-->', meta.join('\n  '));
    if (kind === 'watch' || kind === 'u') html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(p.title)}</title>`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  async function sendOembed(req, res, url) {
    const format = url.searchParams.get('format') || 'json';
    if (format !== 'json') return json(res, 501, { error: 'only json is supported' });
    let target;
    try { target = new URL(url.searchParams.get('url') || ''); } catch { return json(res, 404, { error: 'unknown url' }); }
    const [kind, id, extra] = target.pathname.split('/').filter(Boolean);
    if (!['watch', 'u'].includes(kind) || !id || extra) return json(res, 404, { error: 'unknown url' });
    const p = await preview(kind, id);
    if (p.path === '/') return json(res, 404, { error: 'unknown url' });
    const base = publicOrigin(req);
    const body = { version: '1.0', type: 'link', title: p.title, provider_name: 'live5', provider_url: `${base}/` };
    if (p.author) Object.assign(body, { author_name: p.author.name, author_url: base + p.author.path });
    const size = p.image ? await posterSize(p.image) : null;
    if (p.image && size) {
      Object.assign(body, {
        thumbnail_url: `${base}/api/streams/${p.image.id}/poster`, thumbnail_width: size.width, thumbnail_height: size.height,
      });
    }
    return json(res, 200, body);
  }

  async function handleUsers(req, res, parts) {
    // POST /api/users {name} — first visit on a device. Returns the private key once.
    if (parts.length === 2 && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body) return json(res, 400, { error: 'expected a JSON body' });
      const name = cleanName(body.name);
      if (!name) return json(res, 400, { error: `enter a name (1–${MAX_NAME} characters)` });
      const secret = randomBytes(32).toString('base64url');
      const u = { id: randomUUID(), name, secretHash: sha256(secret), createdAt: Date.now() };
      users.set(u.id, u);
      await saveUsers();
      return json(res, 201, { ...selfView(u), secret });
    }

    // GET /api/users/me — check this device's identity is still known.
    // PATCH /api/users/me {name} — change display name; the UUID stays the same.
    if (parts[2] === 'me' && parts.length === 3) {
      const u = currentUser(req);
      if (!u) return json(res, 401, { error: 'unknown user' });
      if (req.method === 'GET') return json(res, 200, selfView(u));
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const name = cleanName(body?.name);
        if (!name) return json(res, 400, { error: `enter a name (1–${MAX_NAME} characters)` });
        u.name = name;
        await saveUsers();
        return json(res, 200, selfView(u));
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    // GET /api/users/:id — public profile with every broadcast, newest first.
    if (parts.length === 3 && req.method === 'GET') {
      const u = users.get(parts[2]);
      if (!u) return json(res, 404, { error: 'no such user' });
      const broadcasts = [...streams.values()]
        .filter((s) => s.userId === u.id && !s.empty)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(publicStream);
      return json(res, 200, { ...publicUser(u), broadcasts });
    }

    return json(res, 404, { error: 'not found' });
  }

  async function handleStreams(req, res, url, parts) {
    // POST /api/streams {type} — go live now as the calling user. No video in the body.
    if (parts.length === 2 && req.method === 'POST') {
      const u = currentUser(req);
      if (!u) return json(res, 401, { error: 'unknown user' });
      const body = await readJsonBody(req);
      if (!body) return json(res, 400, { error: 'expected a JSON body' });
      // The recorder's format, e.g. video/mp4;codecs=avc1.42E01E,mp4a.40.2. It is sent back as a
      // content-type header, so only plain printable characters are kept.
      const type = String(body.type ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 200);
      const base = type.split(';')[0].trim().toLowerCase();
      if (!Object.hasOwn(EXT, base)) return json(res, 400, { error: 'unsupported type' });
      for (const other of streams.values()) {
        if (other.userId === u.id && other.status === 'live') return json(res, 409, { error: 'you are already live' });
      }
      const usage = dailyUsage(u);
      if (!usage.leftToday) {
        const lives = maxPerDay === 1 ? 'your live' : `all ${maxPerDay} lives`;
        return json(res, 429, { error: `you've had ${lives} for the last ${limitHours} hours`, ...usage });
      }
      const s = {
        id: randomBytes(6).toString('base64url'), userId: u.id, type, ext: EXT[base],
        status: 'live', startedAt: Date.now(), bytes: 0,
        token: randomBytes(24).toString('base64url'), chunks: [], nextSeq: 0, busy: false, viewers: new Set(),
      };
      // The page stops recording at maxSeconds; the extra moment lets its final piece (which some
      // recorders only hand over when stopped) arrive before the hard cap closes the broadcast.
      s.capTimer = setTimeout(() => endStream(s, 'time-limit'), (maxSeconds + finalPieceGrace) * 1000);
      touch(s);
      streams.set(s.id, s);
      await saveStream(s);
      notifyLive(s).catch((e) => console.error('sending live notifications failed', e)); // in the background
      return json(res, 201, { ...publicStream(s), token: s.token, ...dailyUsage(u) });
    }

    // GET /api/streams?user=<uuid>&status=live&offset=0&limit=10 — the feed: live first, then
    // past broadcasts newest first. Ended broadcasts with no recorded video are left out.
    if (parts.length === 2 && req.method === 'GET') {
      const user = url.searchParams.get('user');
      const status = url.searchParams.get('status');
      const offset = clampInt(url.searchParams.get('offset'), 0, 1e6, 0);
      const limit = clampInt(url.searchParams.get('limit'), 1, 50, 10);
      const all = [...streams.values()]
        .filter((s) => (!user || s.userId === user) && (!status || s.status === status))
        .filter((s) => s.status === 'live' || (s.bytes > 0 && !s.empty))
        .sort((a, b) => {
          const al = a.status === 'live', bl = b.status === 'live';
          return al !== bl ? (al ? -1 : 1) : b.startedAt - a.startedAt;
        });
      const items = all.slice(offset, offset + limit).map(publicStream);
      return json(res, 200, { items, next: offset + limit < all.length ? offset + limit : null });
    }

    const s = streams.get(parts[2]);
    if (!s) return json(res, 404, { error: 'no such stream' });

    if (parts.length === 3 && req.method === 'GET') {
      if (s.empty) return json(res, 404, { error: 'no such stream' }); // recorded nothing to show
      return json(res, 200, publicStream(s));
    }

    // POST /api/streams/:id/chunks?seq=n — append-only, in order, one at a time, while live.
    if (parts[3] === 'chunks' && req.method === 'POST') {
      if (!tokenOk(s, req)) return json(res, 403, { error: 'bad token' });
      if (s.status !== 'live') return json(res, 409, { error: 'stream has ended' });
      const seq = Number(url.searchParams.get('seq'));
      if (seq !== s.nextSeq || s.busy) return json(res, 409, { error: 'out of order', expected: s.nextSeq });
      s.busy = true;
      try {
        let body;
        try { body = await readBody(req, maxChunkBytes); } catch (e) { return json(res, e.status ?? 400, { error: e.message }); }
        if (s.status !== 'live') return json(res, 409, { error: 'stream has ended' });
        if (s.bytes + body.length > maxBytes) { endStream(s, 'size-limit'); return json(res, 409, { error: 'size limit' }); }
        s.chunks.push(body);
        s.bytes += body.length;
        s.nextSeq++;
        for (const v of s.viewers) v.write(body);
        touch(s);
        s.lastAppend = appendFile(videoFile(s), body);
        try { await s.lastAppend; } catch (e) {
          // The recording can't be written (disk full?). A replay with a hole in it won't play,
          // so stop here rather than carry on.
          console.error(`writing ${s.id} failed`, e);
          endStream(s, 'storage-error');
          return json(res, 500, { error: 'could not save the broadcast' });
        }
        return json(res, 200, { ok: true, seq });
      } finally {
        s.busy = false;
      }
    }

    // Preview image: one JPEG frame grabbed from the live camera by the broadcaster's page.
    // Only with the broadcast token, only while live, only once, JPEG only, small.
    if (parts[3] === 'poster' && req.method === 'POST') {
      if (!tokenOk(s, req)) return json(res, 403, { error: 'bad token' });
      if (s.status !== 'live') return json(res, 409, { error: 'stream has ended' });
      if (s.hasPoster || s.posterBusy) return json(res, 409, { error: 'preview already set' });
      s.posterBusy = true;
      try {
        let body;
        try { body = await readBody(req, MAX_POSTER_BYTES); } catch (e) { return json(res, e.status ?? 400, { error: e.message }); }
        if (s.status !== 'live') return json(res, 409, { error: 'stream has ended' });
        if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) {
          return json(res, 400, { error: 'expected a JPEG' });
        }
        await writeFile(posterFile(s), body);
        s.hasPoster = true;
        avatars.delete(s.userId);
        await saveStream(s);
        return json(res, 200, { ok: true });
      } finally {
        s.posterBusy = false;
      }
    }
    if (parts[3] === 'poster' && req.method === 'GET') {
      if (!s.hasPoster) return json(res, 404, { error: 'no preview' });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' });
      createReadStream(posterFile(s)).on('error', () => res.destroy()).pipe(res);
      return;
    }

    // POST /api/streams/:id/like { viewer, liked } — like (or un-like) from this device. Nothing
    // about likes is ever returned to anyone.
    if (parts[3] === 'like' && parts.length === 4 && req.method === 'POST') {
      if (s.empty) return json(res, 404, { error: 'no such stream' });
      const body = await readJsonBody(req);
      const viewer = String(body?.viewer ?? '').toLowerCase();
      if (!VIEWER_ID.test(viewer)) return json(res, 400, { error: 'bad viewer id' });
      const liked = body.liked !== false;
      const set = await loadLikes(s);
      if (liked !== set.has(viewer)) {
        if (liked) set.add(viewer); else set.delete(viewer);
        s.likeCount = set.size;
        s.likeWrite = (s.likeWrite ?? Promise.resolve())
          .then(() => appendFile(likesFile(s), `${JSON.stringify({ viewer, liked, at: Date.now() })}\n`))
          .catch((e) => console.error(`saving like on ${s.id} failed`, e));
        saveStream(s);
      }
      return json(res, 200, { ok: true, liked });
    }

    // Comments: GET /api/streams/:id/comments?from=n (n = how many the caller already has),
    // POST /api/streams/:id/comments {text} as a user. Text only, append-only.
    if (parts[3] === 'comments' && parts.length === 4) {
      if (s.empty) return json(res, 404, { error: 'no such stream' });
      if (req.method === 'GET') {
        const list = await loadComments(s);
        const from = clampInt(url.searchParams.get('from'), 0, list.length, 0);
        const items = list.slice(Math.max(from, list.length - 500)).map(publicComment);
        return json(res, 200, { items, next: list.length });
      }
      if (req.method === 'POST') {
        const u = currentUser(req);
        if (!u) return json(res, 401, { error: 'unknown user' });
        const body = await readJsonBody(req, 4096);
        const text = cleanComment(body?.text);
        if (!text) return json(res, 400, { error: `write 1–${MAX_COMMENT} characters` });
        const now = Date.now();
        if (now - (lastCommentAt.get(u.id) ?? 0) < COMMENT_GAP_MS) return json(res, 429, { error: 'slow down a little' });
        lastCommentAt.set(u.id, now);
        const c = { id: randomBytes(6).toString('base64url'), userId: u.id, text, createdAt: now };
        const list = await loadComments(s);
        list.push(c);
        s.commentCount = list.length;
        s.commentWrite = (s.commentWrite ?? Promise.resolve())
          .then(() => appendFile(commentsFile(s), `${JSON.stringify(c)}\n`))
          .catch((e) => console.error(`saving comment on ${s.id} failed`, e));
        await s.commentWrite;
        saveStream(s);
        return json(res, 201, { ...publicComment(c), count: list.length });
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    // POST /api/streams/:id/end
    if (parts[3] === 'end' && req.method === 'POST') {
      if (!tokenOk(s, req)) return json(res, 403, { error: 'bad token' });
      endStream(s, 'stopped');
      return json(res, 200, publicStream(s));
    }

    // GET /api/streams/:id/video — live: everything so far, then new chunks until the end.
    if (parts[3] === 'video' && req.method === 'GET') {
      if (s.status !== 'live') return sendReplay(s, req, res);
      res.writeHead(200, { 'content-type': s.type, 'cache-control': 'no-store' });
      for (const c of s.chunks) res.write(c);
      s.viewers.add(res);
      req.on('close', () => s.viewers.delete(res));
      return;
    }

    return json(res, 405, { error: 'method not allowed' });
  }

  // Finished broadcasts are a file on disk: answer with a length and honour Range
  // requests (Safari's <video> refuses media that does not support them).
  async function sendReplay(s, req, res) {
    await s.saving;
    await s.finalizing;
    if (s.empty) return json(res, 404, { error: 'no video was recorded' });
    const file = replayFile(s);
    let total;
    try { total = (await stat(file)).size; } catch { total = 0; }
    if (!total) return json(res, 404, { error: 'no video was recorded' });
    // A finished replay never changes, so browsers may keep it: scrolling back, looping or
    // preloading doesn't download it again. (Only once it's final: an MP4 still waiting for its
    // replay copy isn't cached.)
    const final = s.ext !== 'mp4' || !!s.replay;
    const headers = {
      'content-type': s.type, 'accept-ranges': 'bytes',
      'cache-control': final ? 'public, max-age=31536000, immutable' : 'no-store',
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0, end = total - 1, code = 200;
    if (m && !(m[1] === '' && m[2] === '')) {
      if (m[1] === '') { start = Math.max(0, total - Number(m[2])); }
      else { start = Number(m[1]); end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1); }
      if (start >= total || start > end) {
        res.writeHead(416, { ...headers, 'content-range': `bytes */${total}` });
        return res.end();
      }
      code = 206;
      headers['content-range'] = `bytes ${start}-${end}/${total}`;
    }
    res.writeHead(code, { ...headers, 'content-length': end - start + 1 });
    // If the file can't be read mid-way (e.g. deleted while someone watches), just drop this
    // response; an unhandled stream error would take the whole server down.
    createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  }

  const handler = (req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: 'server error' });
      else res.end();
    });
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.on('close', () => { for (const s of streams.values()) endStream(s, 'shutdown'); });

  // Stopping cleanly: end whatever is live, then wait until every recording, replay copy and
  // list has been written.
  async function shutdown() {
    for (const s of streams.values()) endStream(s, 'shutdown');
    const all = [...streams.values()];
    await Promise.all(all.map((s) => s.finalizing));
    await Promise.all(all.flatMap((s) => [s.saving, s.commentWrite, s.likeWrite]));
    await Promise.all([usersWrite, pushWrite]);
  }
  return { server, streams, users, shutdown };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 5555;
  const certDir = path.join(ROOT, 'certs');
  const keyFile = process.env.LIVE5_TLS_KEY ?? path.join(certDir, 'key.pem');
  const certFile = process.env.LIVE5_TLS_CERT ?? path.join(certDir, 'cert.pem');
  const tls = existsSync(keyFile) && existsSync(certFile)
    ? { key: readFileSync(keyFile), cert: readFileSync(certFile) } : null;
  const scheme = tls ? 'https' : 'http';
  // LIVE5_HOST=127.0.0.1 when a reverse proxy (e.g. Caddy on a server) is the only way in.
  const host = process.env.LIVE5_HOST || undefined;
  const app = createApp({ tls });
  // Ctrl+C or a service restart: finish writing before exiting, so a live in progress keeps
  // its replay. A second signal exits straight away.
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (stopping) process.exit(1);
      stopping = true;
      app.server.close();
      app.shutdown().catch((e) => console.error('shutting down failed', e)).finally(() => process.exit(0));
    });
  }
  app.server.listen(port, host, () => {
    console.log(`live5 on ${scheme}://localhost:${port}`);
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  on your network: ${scheme}://${a.address}:${port}`);
      }
    }
    if (!tls) console.log('\nPhones need HTTPS for the camera. Run `npm run cert` once, then `npm start` again.');
  });
}
