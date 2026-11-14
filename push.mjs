// Web Push with no dependencies: VAPID signing (RFC 8292) and message encryption (RFC 8291,
// aes128gcm), using only node:crypto and fetch. Works with the push services behind Chrome/Android
// (FCM), Firefox (Mozilla), Safari/iOS (Apple) and Edge (Windows).
import {
  createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

// The server's VAPID key pair, created once and kept in data/ (never committed).
export function loadVapid(file) {
  let jwk = null;
  if (existsSync(file)) { try { jwk = JSON.parse(readFileSync(file, 'utf8')); } catch {} }
  if (!jwk || !jwk.d) {
    jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
    writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 });
  }
  return {
    privateKey: createPrivateKey({ key: jwk, format: 'jwk' }),
    // what browsers need as applicationServerKey: the uncompressed public point
    publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])),
  };
}

// Only real browser push services: the server POSTs to these URLs, so anything else is refused.
const PUSH_HOSTS = ['.googleapis.com', '.push.apple.com', '.mozilla.com', '.mozaws.net', '.notify.windows.com'];
export function isPushEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((h) => u.hostname.endsWith(h));
  } catch { return false; }
}

// A browser subscription as sent by PushSubscription.toJSON(), checked and trimmed.
export function cleanSubscription(raw) {
  const endpoint = raw?.endpoint, p256dh = raw?.keys?.p256dh, auth = raw?.keys?.auth;
  if (typeof endpoint !== 'string' || endpoint.length > 1024 || !isPushEndpoint(endpoint)) return null;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  const key = fromB64u(p256dh), secret = fromB64u(auth);
  if (key.length !== 65 || key[0] !== 4 || secret.length !== 16) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function vapidJwt(endpoint, vapid, subject) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  }));
  const data = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(data), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64u(signature)}`;
}

// RFC 8291: encrypt the payload for one subscription (single record, aes128gcm).
export function encryptPayload(payload, p256dh, auth) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys(); // 65-byte uncompressed point
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), // 0x02: last record
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16); // record size
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, record]);
}

// Send one notification. Returns the push service's HTTP status (201 = accepted; 404/410 = the
// subscription is gone and should be forgotten), or 0 on a network error.
export async function sendPush(subscription, data, vapid, subject, ttlSeconds = 120) {
  const body = encryptPayload(JSON.stringify(data), subscription.keys.p256dh, subscription.keys.auth);
  try {
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        'content-type': 'application/octet-stream',
        'content-encoding': 'aes128gcm',
        ttl: String(ttlSeconds),
        urgency: 'high',
        authorization: `vapid t=${vapidJwt(subscription.endpoint, vapid, subject)}, k=${vapid.publicKey}`,
      },
      body,
    });
    return res.status;
  } catch {
    return 0;
  }
}
