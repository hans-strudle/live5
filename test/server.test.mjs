import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, cleanName } from '../server.mjs';

async function start(opts) {
  const app = createApp(opts);
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  return { ...app, base, close: () => new Promise((r) => { app.server.closeAllConnections(); app.server.close(r); }) };
}

const create = (base, body) => fetch(`${base}/api/streams`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const goLive = (base, name = 'Sam') => create(base, { name, type: 'video/webm' }).then((r) => r.json());
const chunk = (base, s, seq, body, token = s.token) =>
  fetch(`${base}/api/streams/${s.id}/chunks?seq=${seq}`, { method: 'POST', headers: { 'x-broadcast-token': token }, body });

test('going live is immediate and listed as live', async () => {
  const app = await start();
  const s = await goLive(app.base);
  assert.equal(s.status, 'live');
  const list = await (await fetch(`${app.base}/api/streams`)).json();
  assert.equal(list[0].id, s.id);
  assert.equal(list[0].token, undefined, 'token never leaks in listings');
  await app.close();
});

test('default cap is 30 seconds per stream', async () => {
  delete process.env.LIVE5_MAX_SECONDS;
  const app = await start();
  const s = await goLive(app.base);
  assert.equal(s.maxSeconds, 30);
  await app.close();
});

test('going live requires a name, which every viewer sees', async () => {
  const app = await start();
  assert.equal((await create(app.base, { type: 'video/webm' })).status, 400);
  assert.equal((await create(app.base, { name: '   ', type: 'video/webm' })).status, 400);
  assert.equal((await create(app.base, { name: 'x'.repeat(31), type: 'video/webm' })).status, 400);
  assert.equal((await fetch(`${app.base}/api/streams`, { method: 'POST', body: 'not json' })).status, 400);

  const s = await goLive(app.base, '  Ana   María ');
  assert.equal(s.name, 'Ana María');
  const list = await (await fetch(`${app.base}/api/streams`)).json();
  assert.equal(list[0].name, 'Ana María');
  const info = await (await fetch(`${app.base}/api/streams/${s.id}`)).json();
  assert.equal(info.name, 'Ana María');
  await app.close();
});

test('names are cleaned of control and invisible characters', () => {
  assert.equal(cleanName('Sam\u0000‮\n\tLee'), 'Sam Lee');
  assert.equal(cleanName('👩‍💻 Dev'), '👩‍💻 Dev', 'keeps emoji joined');
  assert.equal(cleanName('x'.repeat(30)), 'x'.repeat(30));
  assert.equal(cleanName('x'.repeat(31)), '');
  assert.equal(cleanName(42), '');
});

test('rejects non-video types', async () => {
  const app = await start();
  const r = await create(app.base, { name: 'Sam', type: 'image/png' });
  assert.equal(r.status, 400);
  await app.close();
});

test('chunks need the token, must be in order, and stop after end', async () => {
  const app = await start();
  const s = await goLive(app.base);
  assert.equal((await chunk(app.base, s, 0, 'a', 'wrong-token-wrong-token-wrong-to')).status, 403);
  assert.equal((await chunk(app.base, s, 1, 'a')).status, 409, 'cannot skip ahead');
  assert.equal((await chunk(app.base, s, 0, 'a')).status, 200);
  assert.equal((await chunk(app.base, s, 0, 'x')).status, 409, 'cannot replace an existing chunk');
  assert.equal((await chunk(app.base, s, 1, 'b')).status, 200);
  await fetch(`${app.base}/api/streams/${s.id}/end`, { method: 'POST', headers: { 'x-broadcast-token': s.token } });
  assert.equal((await chunk(app.base, s, 2, 'c')).status, 409, 'nothing can be added after the end');
  const video = await (await fetch(`${app.base}/api/streams/${s.id}/video`)).text();
  assert.equal(video, 'ab');
  await app.close();
});

test('viewers get the backlog and then live chunks until the end', async () => {
  const app = await start();
  const s = await goLive(app.base);
  await chunk(app.base, s, 0, 'a');
  const res = await fetch(`${app.base}/api/streams/${s.id}/video`);
  const body = res.text();
  await chunk(app.base, s, 1, 'b');
  await fetch(`${app.base}/api/streams/${s.id}/end`, { method: 'POST', headers: { 'x-broadcast-token': s.token } });
  assert.equal(await body, 'ab');
  await app.close();
});

test('ended broadcasts serve byte ranges (needed by Safari)', async () => {
  const app = await start();
  const s = await goLive(app.base);
  await chunk(app.base, s, 0, 'hello');
  await chunk(app.base, s, 1, 'world');
  await fetch(`${app.base}/api/streams/${s.id}/end`, { method: 'POST', headers: { 'x-broadcast-token': s.token } });
  const url = `${app.base}/api/streams/${s.id}/video`;

  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-length'), '10');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(await full.text(), 'helloworld');

  const probe = await fetch(url, { headers: { range: 'bytes=0-1' } });
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get('content-range'), 'bytes 0-1/10');
  assert.equal(await probe.text(), 'he');

  const tail = await fetch(url, { headers: { range: 'bytes=5-' } });
  assert.equal(await tail.text(), 'world');
  const suffix = await fetch(url, { headers: { range: 'bytes=-3' } });
  assert.equal(await suffix.text(), 'rld');
  assert.equal((await fetch(url, { headers: { range: 'bytes=50-' } })).status, 416);
  await app.close();
});

test('accepts recorder types with codecs and reports the type to viewers', async () => {
  const app = await start();
  const type = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
  const r = await create(app.base, { name: 'Sam', type });
  assert.equal(r.status, 201);
  const s = await r.json();
  const info = await (await fetch(`${app.base}/api/streams/${s.id}`)).json();
  assert.equal(info.type, type);
  await app.close();
});

test('serves HTTPS when given a certificate', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'live5-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  } catch { t.skip('openssl not available'); return; }
  const https = await import('node:https');
  const app = createApp({ tls: { key: readFileSync(path.join(dir, 'k.pem')), cert: readFileSync(path.join(dir, 'c.pem')) } });
  await new Promise((r) => app.server.listen(0, r));
  const port = app.server.address().port;
  const body = await new Promise((resolve, reject) => {
    https.get({ host: 'localhost', port, path: '/api/streams', rejectUnauthorized: false }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
  assert.equal(body, '[]');
  await new Promise((r) => { app.server.closeAllConnections(); app.server.close(r); });
});

test('server enforces the time limit', async () => {
  const app = await start({ maxSeconds: 0.2 });
  const s = await goLive(app.base);
  await new Promise((r) => setTimeout(r, 300));
  const info = await (await fetch(`${app.base}/api/streams/${s.id}`)).json();
  assert.equal(info.status, 'ended');
  assert.equal(info.endReason, 'time-limit');
  assert.equal((await chunk(app.base, s, 0, 'a')).status, 409);
  await app.close();
});

test('server enforces the size limit', async () => {
  const app = await start({ maxBytes: 4 });
  const s = await goLive(app.base);
  assert.equal((await chunk(app.base, s, 0, 'abc')).status, 200);
  assert.equal((await chunk(app.base, s, 1, 'de')).status, 409);
  const info = await (await fetch(`${app.base}/api/streams/${s.id}`)).json();
  assert.equal(info.endReason, 'size-limit');
  await app.close();
});
