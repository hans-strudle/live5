// This device's live5 user (no login): { id, name, secret } kept in localStorage.
// The same record the Go live page creates; pages that need to act as the user import this.
const KEY = 'live5:user';

export function getUser() {
  try {
    const u = JSON.parse(localStorage.getItem(KEY) || 'null');
    return u && u.id && u.secret ? u : null;
  } catch { return null; }
}

export function saveUser(u) {
  try { localStorage.setItem(KEY, JSON.stringify({ id: u.id, name: u.name, secret: u.secret })); } catch {}
}

export function clearUser() {
  try { localStorage.removeItem(KEY); } catch {}
}

export const authHeaders = (u) => ({ 'content-type': 'application/json', 'x-user-id': u.id, 'x-user-secret': u.secret });

// First time on this device: the server creates the user and returns its private key once.
export async function createUser(name) {
  const r = await fetch('/api/users', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'Could not save your name.');
  const u = { id: body.id, name: body.name, secret: body.secret };
  saveUser(u);
  return u;
}
