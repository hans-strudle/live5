import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { createApp, cleanName, cleanComment, jpegSize } from '../server.mjs';
import { encryptPayload, cleanSubscription } from '../push.mjs';
import { defragmentMp4, isFragmentedMp4 } from '../mp4.mjs';
import { parseChallenges, loadChallenges, zonedTime } from '../challenges.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------- helpers ----------
// Every test gets its own server and a throwaway data folder (never the real data/).
async function start(t, opts = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(path.join(tmpdir(), 'live5-test-'));
  const app = createApp({ idleSeconds: 30, ...opts, dataDir });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const close = async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await new Promise((r) => setTimeout(r, 50)); // let background writes finish
    rmSync(dataDir, { recursive: true, force: true });
  };
  t.after(close); // always shut down, even when an assertion fails
  return { ...app, base, dataDir, close };
}

const post = (base, p, body, headers = {}) => fetch(base + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const auth = (u) => ({ 'x-user-id': u.id, 'x-user-secret': u.secret });

async function newUser(base, name = 'Sam') {
  const r = await post(base, '/api/users', { name });
  assert.equal(r.status, 201);
  return r.json();
}
async function goLive(base, u, type = 'video/webm', extra = {}) {
  const r = await post(base, '/api/streams', { type, ...extra }, auth(u));
  return { status: r.status, body: await r.json() };
}
const chunk = (base, s, seq, data, token = s.token) =>
  fetch(`${base}/api/streams/${s.id}/chunks?seq=${seq}`, { method: 'POST', headers: { 'x-broadcast-token': token }, body: data });
const end = (base, s) => fetch(`${base}/api/streams/${s.id}/end`, { method: 'POST', headers: { 'x-broadcast-token': s.token } });
const getJson = async (base, p) => (await fetch(base + p)).json();

// ---------- names and text ----------
test('names and comments are cleaned of control and invisible characters', () => {
  assert.equal(cleanName('Sam\u0000‮\n\tLee'), 'Sam Lee');
  assert.equal(cleanName('👩‍💻 Dev'), '👩‍💻 Dev', 'keeps emoji joined');
  assert.equal(cleanName('x'.repeat(30)), 'x'.repeat(30));
  assert.equal(cleanName('x'.repeat(31)), '');
  assert.equal(cleanName(42), '');
  assert.equal(cleanComment('hi\n\nthere'), 'hi there');
  assert.equal(cleanComment('x'.repeat(201)), '');
});

// ---------- users ----------
test('a user gets a private key once; profiles never show it; renaming keeps the id', async (t) => {
  const app = await start(t);
  const u = await newUser(app.base, '  Ana   María ');
  assert.equal(u.name, 'Ana María');
  assert.ok(u.secret);
  const profile = await getJson(app.base, `/api/users/${u.id}`);
  assert.equal(profile.secret, undefined);
  assert.equal(profile.secretHash, undefined);
  assert.equal((await fetch(`${app.base}/api/users/me`)).status, 401);
  assert.equal((await fetch(`${app.base}/api/users/me`, { headers: { ...auth(u), 'x-user-secret': 'wrong' } })).status, 401);
  const r = await fetch(`${app.base}/api/users/me`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...auth(u) }, body: JSON.stringify({ name: 'Ana' }) });
  const me = await r.json();
  assert.equal(me.id, u.id);
  assert.equal(me.name, 'Ana');
  assert.equal((await post(app.base, '/api/users', { name: '   ' })).status, 400);
});

// ---------- going live ----------
test('going live needs a user and a video type; one live at a time; live comes first in the feed', async (t) => {
  const app = await start(t);
  const u = await newUser(app.base);
  assert.equal((await post(app.base, '/api/streams', { type: 'video/webm' })).status, 401);
  assert.equal((await goLive(app.base, u, 'image/png')).status, 400);
  const { status, body: s } = await goLive(app.base, u);
  assert.equal(status, 201);
  assert.equal(s.status, 'live');
  assert.equal(s.name, 'Sam');
  assert.equal((await goLive(app.base, u)).status, 409, 'already live');
  const feed = await getJson(app.base, '/api/streams');
  assert.equal(feed.items[0].id, s.id);
  assert.equal(feed.items[0].token, undefined, 'the broadcast token never leaks');
});

test('one live every 12 hours by default: locked until 12 hours after going live', async (t) => {
  const app = await start(t);
  const u = await newUser(app.base);
  const { body: s } = await goLive(app.base, u);
  await chunk(app.base, s, 0, 'x');
  await end(app.base, s);
  const { status, body } = await goLive(app.base, u);
  assert.equal(status, 429);
  assert.equal(body.dailyLimit, 1);
  assert.ok(Math.abs(body.nextAt - (s.startedAt + 12 * 3600 * 1000)) < 1000, 'unlocks 12h after that live started');
  assert.equal(body.limitHours, 12);
  const me = await (await fetch(`${app.base}/api/users/me`, { headers: auth(u) })).json();
  assert.equal(me.leftToday, 0);
  assert.equal((await getJson(app.base, '/api/config')).maxPerDay, 1);
});

test('daily limit: refused after the limit, with when the next live frees up', async (t) => {
  const app = await start(t, { maxPerDay: 2 });
  const u = await newUser(app.base);
  for (let i = 0; i < 2; i++) {
    const { body: s } = await goLive(app.base, u);
    await chunk(app.base, s, 0, 'x');
    await end(app.base, s);
  }
  const { status, body } = await goLive(app.base, u);
  assert.equal(status, 429);
  assert.equal(body.leftToday, 0);
  assert.ok(body.nextAt > Date.now());
});

test('a live that recorded nothing is dropped and does not use up the limit', async (t) => {
  const app = await start(t);
  const u = await newUser(app.base);
  const { body: s } = await goLive(app.base, u);
  await end(app.base, s);
  await app.streams.get(s.id).finalizing;
  assert.equal((await fetch(`${app.base}/api/streams/${s.id}`)).status, 404);
  assert.equal((await getJson(app.base, `/api/users/${u.id}`)).broadcasts.length, 0);
  assert.equal((await goLive(app.base, u)).status, 201, 'can go live again straight away');
});

test('a live cut short by a server crash comes back as a replay after restart', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'live5-test-'));
  mkdirSync(path.join(dataDir, 'streams'));
  // what is on disk mid-broadcast: details saved at the start (0 bytes), and the recording so far
  const meta = { id: 'crashed', userId: 'u1', type: 'video/webm', ext: 'webm', status: 'live', startedAt: Date.now() - 5000, bytes: 0 };
  writeFileSync(path.join(dataDir, 'streams', 'crashed.json'), JSON.stringify(meta));
  writeFileSync(path.join(dataDir, 'streams', 'crashed.webm'), 'recorded');
  const app = await start(t, { dataDir });
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const s = app.streams.get('crashed');
  assert.equal(s.status, 'ended');
  assert.equal(s.bytes, 8);
  assert.ok(!s.empty);
  assert.deepEqual((await getJson(app.base, '/api/streams')).items.map((x) => x.id), ['crashed']);
  assert.equal(await (await fetch(`${app.base}/api/streams/crashed/video`)).text(), 'recorded');
});

// ---------- video ----------
test('pieces need the token, must be in order, and stop after the end', async (t) => {
  const app = await start(t);
  const u = await newUser(app.base);
  const { body: s } = await goLive(app.base, u);
  assert.equal((await chunk(app.base, s, 0, 'a', 'x'.repeat(32))).status, 403);
  assert.equal((await chunk(app.base, s, 1, 'a')).status, 409, 'cannot skip ahead');
  assert.equal((await chunk(app.base, s, 0, 'a')).status, 200);
  const again = await chunk(app.base, s, 0, 'x');
  assert.equal(again.status, 409, 'cannot replace a piece');
  assert.equal((await again.json()).expected, 1, 'says which piece is next, so a resend after a lost answer can tell it arrived');
  assert.equal((await chunk(app.base, s, 1, 'b')).status, 200);
  await end(app.base, s);
  assert.ok([403, 409].includes((await chunk(app.base, s, 2, 'c')).status), 'nothing can be added after the end');
});

test('viewers get the backlog, then live pieces until the end; live is never cached', async (t) => {
  const app = await start(t);
  const u = await newUser(app.base);
  const { body: s } = await goLive(app.base, u);
  await chunk(app.base, s, 0, 'a');
  const res = await fetch(`${app.base}/api/streams/${s.id}/video`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('accept-ranges'), null, 'a live response has no ranges (the feed relies on this)');
  const body = res.text();
  await chunk(app.base, s, 1, 'b');
  await end(app.base, s);
  assert.equal(await body, 'ab');
});

test('finished replays: full file, byte ranges (for Safari), and cacheable', async (t) => {
  const app = await start(t);
  const u = await newUser(app.base);
  const { body: s } = await goLive(app.base, u);
  await chunk(app.base, s, 0, 'hello');
  await chunk(app.base, s, 1, 'world');
  await end(app.base, s);
  const url = `${app.base}/api/streams/${s.id}/video`;
  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-length'), '10');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.match(full.headers.get('cache-control'), /immutable/);
  assert.equal(await full.text(), 'helloworld');
  const probe = await fetch(url, { headers: { range: 'bytes=0-1' } });
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get('content-range'), 'bytes 0-1/10');
  assert.equal(await probe.text(), 'he');
  assert.equal(await (await fetch(url, { headers: { range: 'bytes=5-' } })).text(), 'world');
  assert.equal(await (await fetch(url, { headers: { range: 'bytes=-3' } })).text(), 'rld');
  assert.equal((await fetch(url, { headers: { range: 'bytes=50-' } })).status, 416);
});

test('the server enforces the time limit and the size limit', async (t) => {
  const app = await start(t, { maxSeconds: 0.2, finalPieceGrace: 0, maxBytes: 4, maxPerDay: 5 });
  const u = await newUser(app.base);
  const { body: s1 } = await goLive(app.base, u);
  assert.equal((await chunk(app.base, s1, 0, 'a')).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  const info = await getJson(app.base, `/api/streams/${s1.id}`);
  assert.equal(info.status, 'ended');
  assert.equal(info.endReason, 'time-limit');
  assert.ok([403, 409].includes((await chunk(app.base, s1, 1, 'b')).status), 'nothing after the time limit');

  const { body: s2 } = await goLive(app.base, u);
  assert.equal((await chunk(app.base, s2, 0, 'abc')).status, 200);
  assert.equal((await chunk(app.base, s2, 1, 'de')).status, 409);
  assert.equal((await getJson(app.base, `/api/streams/${s2.id}`)).endReason, 'size-limit');
});

test('the preview image: JPEG only, once, with the token, while live', async (t) => {
  const app = await start(t);
  const u = await newUser(app.base);
  const { body: s } = await goLive(app.base, u);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const send = (body, token = s.token) => fetch(`${app.base}/api/streams/${s.id}/poster`, { method: 'POST', headers: { 'x-broadcast-token': token }, body });
  assert.equal((await send('not a jpeg')).status, 400);
  assert.equal((await send(jpeg, 'x'.repeat(32))).status, 403);
  assert.equal((await send(jpeg)).status, 200);
  assert.equal((await send(jpeg)).status, 409, 'only once');
  const profile = await getJson(app.base, `/api/users/${u.id}`);
  assert.equal(profile.avatar, `/api/streams/${s.id}/poster`, 'profile picture is the latest frame');
});

// ---------- comments and likes ----------
test('comments: need a user, short text only, rate limited, read from a position', async (t) => {
  const app = await start(t);
  const u = await newUser(app.base);
  const { body: s } = await goLive(app.base, u);
  const url = `/api/streams/${s.id}/comments`;
  assert.equal((await post(app.base, url, { text: 'hi' })).status, 401);
  assert.equal((await post(app.base, url, { text: 'x'.repeat(201) }, auth(u))).status, 400);
  assert.equal((await post(app.base, url, { text: 'first' }, auth(u))).status, 201);
  assert.equal((await post(app.base, url, { text: 'too soon' }, auth(u))).status, 429);
  const all = await getJson(app.base, `${url}?from=0`);
  assert.deepEqual(all.items.map((c) => c.text), ['first']);
  assert.equal(all.items[0].name, 'Sam');
  assert.equal(all.next, 1);
  assert.deepEqual((await getJson(app.base, `${url}?from=1`)).items, []);
  assert.equal((await getJson(app.base, `/api/streams/${s.id}`)).commentCount, 1);
});

test('likes: one per device, toggleable, and the count is never revealed', async (t) => {
  const app = await start(t);
  const u = await newUser(app.base);
  const { body: s } = await goLive(app.base, u);
  const viewer = '3f1c2a9e-1b7d-4c55-9a0e-2f6b8d4c1e77';
  const like = (liked, v = viewer) => post(app.base, `/api/streams/${s.id}/like`, { viewer: v, liked });
  assert.equal((await like(true, 'not-a-uuid')).status, 400);
  const r = await like(true);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(await r.json()).sort(), ['liked', 'ok']);
  await like(true); // same device again: still one like
  assert.equal(app.streams.get(s.id).likeCount, 1);
  await like(false);
  assert.equal(app.streams.get(s.id).likeCount, 0);
  const everything = JSON.stringify([
    await getJson(app.base, `/api/streams/${s.id}`),
    await getJson(app.base, '/api/streams'),
    await getJson(app.base, `/api/users/${u.id}`),
  ]);
  assert.ok(!/like/i.test(everything), 'no like data in any public response');
});

// ---------- push ----------
test('push subscriptions: only real push services, with well-formed keys', async (t) => {
  const app = await start(t);
  const key = createECDH('prime256v1');
  key.generateKeys();
  const good = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: key.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') } };
  assert.ok(cleanSubscription(good));
  assert.equal(cleanSubscription({ ...good, endpoint: 'https://evil.example.com/x' }), null);
  assert.equal(cleanSubscription({ ...good, endpoint: 'http://fcm.googleapis.com/x' }), null);
  assert.equal(cleanSubscription({ ...good, endpoint: 'https://fcm.googleapis.com:8443/x' }), null);
  assert.equal(cleanSubscription({ ...good, keys: { ...good.keys, auth: 'short' } }), null);
  assert.equal((await post(app.base, '/api/push/subscribe', { ...good, endpoint: 'https://127.0.0.1/x' })).status, 400);
  assert.equal((await post(app.base, '/api/push/subscribe', good)).status, 201);
  const { publicKey } = await getJson(app.base, '/api/push/key');
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
});

test('push encryption (RFC 8291) decrypts with the subscriber keys', () => {
  // The subscriber side (normally the browser).
  const ua = createECDH('prime256v1');
  const uaPublic = ua.generateKeys();
  const authSecret = randomBytes(16);
  const body = encryptPayload('{"title":"Sam is recording right now"}', uaPublic.toString('base64url'), authSecret.toString('base64url'));
  const salt = body.subarray(0, 16);
  assert.equal(body.readUInt32BE(16), 4096);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen);
  const shared = ua.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([d.update(ciphertext.subarray(0, -16)), d.final()]);
  assert.equal(plain.at(-1), 2, 'last-record delimiter');
  assert.equal(plain.subarray(0, -1).toString(), '{"title":"Sam is recording right now"}');
});

// ---------- pages and files ----------
test('link previews escape names; oEmbed describes broadcasts and profiles', async (t) => {
  const app = await start(t);
  const u = await newUser(app.base, '"><script>x</script>');
  const html = await (await fetch(`${app.base}/u/${u.id}`)).text();
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;x&lt;/script&gt; on 1take'));
  const { body: s } = await goLive(app.base, u);
  const page = `${app.base}/watch/${s.id}`;
  const watch = await (await fetch(page)).text();
  assert.match(watch, /is recording on 1take/);
  const o = await getJson(app.base, `/oembed?url=${encodeURIComponent(page)}`);
  assert.equal(o.type, 'link');
  assert.equal(o.author_url, `${app.base}/u/${u.id}`);
  assert.equal((await fetch(`${app.base}/oembed?url=${encodeURIComponent('https://x.test/nope')}`)).status, 404);
});

test('only files in public/ are served', async (t) => {
  const app = await start(t);
  assert.equal((await fetch(`${app.base}/feed.js`)).status, 200);
  assert.equal((await fetch(`${app.base}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${app.base}/..%2Fserver.mjs`)).status, 404);
  assert.equal((await fetch(`${app.base}/data/users.json`)).status, 404);
});

test('built-in object names are not mistaken for pages or video types', async (t) => {
  const app = await start(t);
  assert.equal((await fetch(`${app.base}/__proto__/x`)).status, 404);
  assert.equal((await fetch(`${app.base}/constructor/x`)).status, 404);
  const u = await newUser(app.base);
  assert.equal((await goLive(app.base, u, 'constructor')).status, 400);
  const odd = await goLive(app.base, u, 'video/webm;codecs=vp8\r\nx-evil: 1');
  assert.equal(odd.body.type, 'video/webm;codecs=vp8x-evil: 1', 'line breaks never reach the content-type header');
});

test('jpegSize reads the frame size', () => {
  const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x80, 0x01, 0x68, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(jpegSize(sof), { width: 360, height: 640 });
  assert.equal(jpegSize(Buffer.from('nope')), null);
});

// ---------- MP4 replay conversion ----------
// A tiny fragmented MP4 like MediaRecorder writes: one video track, two fragments of 2 samples.
function box(type, ...parts) {
  const payload = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}
const u32 = (...v) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4)); return b; };
function fragmentedMp4() {
  const mvhd = box('mvhd', u32(0, 0, 0, 1000, 0), Buffer.alloc(80));
  const tkhd = box('tkhd', u32(0, 0, 0, 1, 0, 0), Buffer.alloc(60));
  const mdhd = box('mdhd', u32(0, 0, 0, 30000, 0, 0));
  const hdlr = box('hdlr', u32(0, 0), Buffer.from('vide'), Buffer.alloc(13));
  const stsd = box('stsd', u32(0, 1), box('avc1', Buffer.alloc(8)));
  const empty = (t) => box(t, u32(0, 0));
  const stbl = box('stbl', stsd, empty('stts'), empty('stsc'), box('stsz', u32(0, 0, 0)), empty('stco'));
  const minf = box('minf', box('vmhd', u32(1, 0, 0)), stbl);
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
  const mvex = box('mvex', box('trex', u32(0, 1, 1, 0, 0, 0x10000)));
  const moov = box('moov', mvhd, trak, mvex);
  const fragment = (seq, base, samples) => {
    // tfhd: default-base-is-moof; trun: data offset + duration + size + first-sample-flags
    const trunBody = () => u32(0x305, samples.length, 0, 0, ...samples.flatMap((s) => [1000, s.length]));
    let traf = box('traf', box('tfhd', u32(0x20000, 1)), box('tfdt', u32(0, base)), box('trun', trunBody()));
    let moof = box('moof', box('mfhd', u32(0, seq)), traf);
    // patch the data offset: from the moof start to the first sample in the following mdat
    const trunAt = moof.indexOf(Buffer.from('trun'));
    moof.writeUInt32BE(moof.length + 8, trunAt + 4 + 8);
    return Buffer.concat([moof, box('mdat', ...samples)]);
  };
  const s = ['AAAA', 'BB', 'CCC', 'D'].map((x) => Buffer.from(x));
  return { file: Buffer.concat([box('ftyp', Buffer.from('isom'), u32(0)), moov, fragment(1, 0, [s[0], s[1]]), fragment(2, 2000, [s[2], s[3]])]), samples: s };
}

test('fragmented MP4 recordings become a plain MP4 with the same sample bytes', () => {
  const { file, samples } = fragmentedMp4();
  assert.ok(isFragmentedMp4(file));
  const plain = defragmentMp4(file);
  assert.ok(plain);
  assert.ok(!isFragmentedMp4(plain));
  const text = plain.toString('latin1');
  assert.ok(!text.includes('mvex') && !text.includes('moof'), 'no fragment boxes left');
  // the sample table points at each sample's bytes, in order
  const stsz = plain.indexOf(Buffer.from('stsz'));
  const count = plain.readUInt32BE(stsz + 12);
  assert.equal(count, 4);
  const stco = plain.indexOf(Buffer.from('stco'));
  for (let i = 0; i < count; i++) {
    const size = plain.readUInt32BE(stsz + 16 + i * 4);
    const offset = plain.readUInt32BE(stco + 12 + i * 4);
    assert.deepEqual(plain.subarray(offset, offset + size), samples[i]);
  }
  // total duration: 4 samples x 1000 at timescale 30000, in the movie timescale (1000)
  const mvhd = plain.indexOf(Buffer.from('mvhd'));
  assert.equal(plain.readUInt32BE(mvhd + 4 + 16), Math.round((4000 * 1000) / 30000));
  assert.equal(defragmentMp4(Buffer.from('nothing')), null);
});

test('a recording that claims billions of samples is refused, not processed', () => {
  const { file } = fragmentedMp4();
  // first trun: no per-sample fields (so nothing else stops the loop) and a count of 4 billion
  const trun = file.indexOf(Buffer.from('trun'));
  file.writeUInt32BE(0x001, trun + 4);
  file.writeUInt32BE(0xffffffff, trun + 8);
  const started = Date.now();
  assert.equal(defragmentMp4(file), null);
  assert.ok(Date.now() - started < 2000);
});

// ---------- challenges ----------
const HOUR = 3600 * 1000;
const challengeNow = (o = {}) => ({
  id: 'tour', title: 'The Tour', prompt: 'Show us where you are.', startsAt: Date.now() - HOUR, endsAt: Date.now() + HOUR, ...o,
});
async function record(base, u, extra) {
  const live = await goLive(base, u, 'video/webm', extra);
  if (live.status !== 201) return live;
  await chunk(base, live.body, 0, 'x');
  await end(base, live.body);
  return live;
}
const me = async (base, u) => (await fetch(`${base}/api/users/me`, { headers: auth(u) })).json();

test('a challenge take is extra: one per challenge, and it leaves the 12-hour limit alone', async (t) => {
  const app = await start(t, { challenges: [challengeNow()] });
  const u = await newUser(app.base);
  assert.deepEqual((await me(app.base, u)).openChallenge.done, false);

  const free = await record(app.base, u);
  assert.equal(free.status, 201);
  assert.equal(free.body.challenge, null);
  assert.equal((await goLive(app.base, u)).status, 429, 'the regular take is used up');

  const entry = await record(app.base, u, { challenge: 'tour' });
  assert.equal(entry.status, 201, 'the challenge take is still available');
  assert.deepEqual(entry.body.challenge, { id: 'tour', title: 'The Tour' });
  assert.equal(entry.body.openChallenge.done, true);

  const again = await goLive(app.base, u, 'video/webm', { challenge: 'tour' });
  assert.equal(again.status, 429, 'one take per challenge');
  assert.equal(again.body.openChallenge.done, true);

  const mine = await me(app.base, u);
  assert.equal(mine.usedToday, 1, 'the challenge take is not counted');
  assert.ok(Math.abs(mine.nextAt - (free.body.startedAt + 12 * HOUR)) < 1000, 'and does not push the unlock time back');

  // the other way round: a challenge take first leaves the regular take free
  const v = await newUser(app.base, 'Vic');
  assert.equal((await record(app.base, v, { challenge: 'tour' })).status, 201);
  assert.equal((await me(app.base, v)).leftToday, 1);
  assert.equal((await record(app.base, v)).status, 201);

  const gallery = await getJson(app.base, '/api/streams?challenge=tour');
  assert.equal(gallery.items.length, 2);
  assert.ok(gallery.items.every((s) => s.challenge.id === 'tour'));
  assert.equal((await getJson(app.base, '/api/streams')).items.length, 4);
  const { current, next } = await getJson(app.base, '/api/challenges/current');
  assert.equal(current.takes, 2);
  assert.equal(current.open, true);
  assert.equal(next, null);
});

test('a challenge take that recorded nothing can be tried again', async (t) => {
  const app = await start(t, { challenges: [challengeNow()] });
  const u = await newUser(app.base);
  const { body: s } = await goLive(app.base, u, 'video/webm', { challenge: 'tour' });
  await end(app.base, s);
  await app.streams.get(s.id).finalizing;
  assert.equal((await me(app.base, u)).openChallenge.done, false);
  assert.equal((await goLive(app.base, u, 'video/webm', { challenge: 'tour' })).status, 201);
});

test('only the open challenge can be entered, and one that has not started stays secret', async (t) => {
  const app = await start(t, { challenges: [
    challengeNow({ id: 'old', title: 'Old One', startsAt: Date.now() - 3 * HOUR, endsAt: Date.now() - 2 * HOUR }),
    challengeNow({ id: 'soon', title: 'Secret Title', prompt: 'Secret prompt', startsAt: Date.now() + HOUR, endsAt: Date.now() + 2 * HOUR }),
  ] });
  const u = await newUser(app.base);
  for (const id of ['old', 'soon', 'nope']) {
    assert.equal((await goLive(app.base, u, 'video/webm', { challenge: id })).status, 409, id);
  }
  assert.equal((await me(app.base, u)).openChallenge, null);
  assert.equal((await goLive(app.base, u)).status, 201, 'a regular take still works');

  const old = await getJson(app.base, '/api/challenges/old');
  assert.equal(old.title, 'Old One');
  assert.equal(old.open, false);
  assert.equal((await fetch(`${app.base}/api/challenges/soon`)).status, 404);
  assert.equal((await fetch(`${app.base}/oembed?url=${encodeURIComponent(`${app.base}/c/soon`)}`)).status, 404);
  const answers = await Promise.all(['/api/challenges/current', '/c/soon', '/api/streams', '/api/config', '/']
    .map(async (p) => (await fetch(app.base + p)).text()));
  assert.ok(answers.every((text) => !text.includes('Secret')), 'nothing gives away the title or prompt');
  const { current, next } = JSON.parse(answers[0]);
  assert.equal(current, null);
  assert.ok(next.startsAt > Date.now());
});

test('a challenge page has its own link preview, with the text escaped', async (t) => {
  const app = await start(t, { challenges: [challengeNow({ title: '<b>"Tour"</b>', prompt: 'Show <i>us</i>' })] });
  const page = `${app.base}/c/tour`;
  const html = await (await fetch(page)).text();
  assert.ok(html.includes('&lt;b&gt;&quot;Tour&quot;&lt;/b&gt; · 1take challenge'));
  assert.ok(html.includes('content="Show &lt;i&gt;us&lt;/i&gt;"'));
  assert.ok(!html.includes('<b>"Tour"</b>') && !html.includes('<i>us</i>'));
  const o = await getJson(app.base, `/oembed?url=${encodeURIComponent(page)}`);
  assert.equal(o.title, '<b>"Tour"</b> · 1take challenge');
  // a take recorded for it says so in its own preview
  const u = await newUser(app.base);
  const { body: s } = await record(app.base, u, { challenge: 'tour' });
  assert.match(await (await fetch(`${app.base}/watch/${s.id}`)).text(), /take for the challenge/);
});

test('a challenge is announced once when it opens, and that is remembered across restarts', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'live5-test-'));
  const challenges = [challengeNow({ startsAt: Date.now() + 150 })];
  const stateFile = path.join(dataDir, 'challenges-state.json');
  const first = await start(t, { dataDir, challenges });
  await new Promise((r) => setTimeout(r, 50));
  assert.throws(() => readFileSync(stateFile), 'nothing announced before it opens');
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).announced, ['tour']);
  await first.shutdown();

  // Restart while it's still open: it was already announced, so nothing is sent or rewritten
  // (a re-announcement would rewrite the file and drop the marker added here).
  writeFileSync(stateFile, JSON.stringify({ announced: ['tour'], marker: true }));
  const second = await start(t, { dataDir, challenges });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).marker, true, 'not announced again after a restart');
  await second.shutdown();

  // Without the record, a restart soon after it opened would announce it (and write the record).
  writeFileSync(stateFile, '{}');
  const third = await start(t, { dataDir, challenges });
  await third.shutdown();
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).announced, ['tour']);
});

test('challenge times are read in the list’s time zone; bad lists are refused', () => {
  const tz = 'America/Los_Angeles';
  assert.equal(zonedTime('2026-11-20 17:00', tz), Date.UTC(2026, 10, 21, 1, 0), 'winter: 8 hours behind UTC');
  assert.equal(zonedTime('2026-07-03 17:00', tz), Date.UTC(2026, 6, 4, 0, 0), 'summer: 7 hours behind UTC');
  assert.equal(zonedTime('2026-11-20 17:00', 'UTC'), Date.UTC(2026, 10, 20, 17, 0));
  for (const bad of ['2026-02-30 17:00', '2026-13-04 17:00', '2026-00-10 17:00', '2026-11-20 24:00', '2026-11-20 17:60', 'friday']) {
    assert.throws(() => zonedTime(bad, tz), undefined, bad);
  }

  const entry = (o = {}) => ({ id: 'a', starts: '2026-11-20 17:00', ends: '2026-11-22 23:59', title: 'T', prompt: 'P', ...o });
  const [c] = parseChallenges({ timezone: tz, challenges: [entry()] });
  assert.equal(c.startsAt, Date.UTC(2026, 10, 21, 1, 0));
  assert.equal(c.endsAt, Date.UTC(2026, 10, 23, 7, 59));
  const sorted = parseChallenges({ challenges: [entry({ id: 'b', starts: '2026-11-27 17:00', ends: '2026-11-29 23:59' }), entry()] });
  assert.deepEqual(sorted.map((x) => x.id), ['a', 'b'], 'oldest first');
  for (const bad of [
    [entry(), entry({ id: 'b', starts: '2026-11-21 10:00' })], // overlap
    [entry(), entry()], // same id twice
    [entry({ id: 'current' })], [entry({ id: 'a/b' })],
    [entry({ title: '' })], [entry({ prompt: 'x'.repeat(141) })],
    [entry({ ends: '2026-11-20 16:00' })],
  ]) assert.throws(() => parseChallenges({ challenges: bad }));
  assert.throws(() => parseChallenges({ challenges: [entry(), null] }), /challenge 2: expected/, 'a stray entry is named');
  assert.throws(() => parseChallenges({ timezone: 'Mars/Phobos', challenges: [] }));
  assert.throws(() => parseChallenges({}));
});

test('a missing or broken challenge file means no challenges; the real one is valid', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'live5-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(loadChallenges(path.join(dir, 'none.json')), []);
  writeFileSync(path.join(dir, 'bad.json'), '{ "challenges": [ { "id": "x" } ] }');
  const errors = t.mock.method(console, 'error', () => {});
  assert.deepEqual(loadChallenges(path.join(dir, 'bad.json')), []);
  assert.equal(errors.mock.callCount(), 1, 'and it says why');
  errors.mock.restore();
  const real = loadChallenges(fileURLToPath(new URL('../challenges.json', import.meta.url)));
  assert.ok(real.length > 0, 'challenges.json in the repo loads');
});
