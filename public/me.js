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

// A small popup asking for a name, shown over whatever is on screen (the camera, the comment
// sheet...). onSubmit(name) does the work; if it throws, its message is shown and the popup stays
// open. Resolves with onSubmit's result, or null if the person cancels.
export function askName({ title = 'What’s your name?', note = 'No account needed.', initial = '', action = 'Continue', onSubmit } = {}) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'name-dialog';
    d.innerHTML = `
      <form>
        <h2></h2>
        <input name="name" maxlength="30" autocomplete="nickname" autocapitalize="words" enterkeyhint="go"
               placeholder="Your name" required>
        <p class="name-note"></p>
        <div class="name-actions">
          <button class="btn ghost" type="button" data-cancel>Cancel</button>
          <button class="btn" type="submit"></button>
        </div>
      </form>`;
    const form = d.querySelector('form');
    const input = d.querySelector('input');
    const noteEl = d.querySelector('.name-note');
    const submit = d.querySelector('[type=submit]');
    d.querySelector('h2').textContent = title;
    noteEl.textContent = note;
    submit.textContent = action;
    input.value = initial;

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (d.open) d.close();
      d.remove();
      resolve(value);
    };
    d.querySelector('[data-cancel]').onclick = () => finish(null);
    d.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); }); // Esc
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = input.value.replace(/\s+/g, ' ').trim();
      if (!name) { input.focus(); return; }
      submit.disabled = true;
      try {
        finish(onSubmit ? await onSubmit(name) : name);
      } catch (err) {
        noteEl.textContent = err.message || 'Something went wrong. Try again.';
        noteEl.classList.add('error');
        input.focus();
      } finally {
        submit.disabled = false;
      }
    };

    document.body.append(d);
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    input.focus();
  });
}

// This device's user, asking for a name (and creating the user) first if there isn't one yet.
// Resolves with the user, or null if the person cancels.
export function ensureUser(options = {}) {
  return getUser() ?? askName({ ...options, onSubmit: createUser });
}

// First time on this device: the server creates the user and returns its private key once.
export async function createUser(name) {
  const r = await fetch('/api/users', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ? `${body.error[0].toUpperCase()}${body.error.slice(1)}.` : 'Could not save your name.');
  const u = { id: body.id, name: body.name, secret: body.secret };
  saveUser(u);
  return u;
}

// Change this device's user's name. If the server no longer knows the user (e.g. its data was
// reset), a new user is created with that name instead.
export async function renameUser(user, name) {
  const r = await fetch('/api/users/me', { method: 'PATCH', headers: authHeaders(user), body: JSON.stringify({ name }) });
  if (r.status === 401) { clearUser(); return createUser(name); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ? `${body.error[0].toUpperCase()}${body.error.slice(1)}.` : 'Could not save your name.');
  const u = { ...user, name: body.name };
  saveUser(u);
  return u;
}
