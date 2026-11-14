// Comment sheet: slides up over the video, lists a broadcast's comments (oldest first, like a
// chat) and lets anyone add one. While open it checks for new comments every few seconds.
import { avatarNode } from '/feed.js';
import { clearUser, authHeaders, ensureUser } from '/me.js';

// Asked after pressing Send, only by someone without a profile on this device yet.
const NAME_PROMPT = { title: 'Your name', note: 'Shown with your comment. No account needed.', action: 'Post comment' };

const POLL_MS = 4000;
let current = null; // the open sheet, if any

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// stream: { id, name } from the API. onCount(n) is told the comment count when it changes.
export function openComments(stream, { onCount } = {}) {
  if (current) current.close();

  const dialog = el('dialog', 'sheet');
  dialog.setAttribute('aria-label', 'Comments');
  const head = el('header', 'sheet-head');
  const title = el('h2', null, 'Comments');
  const closeBtn = el('button', 'sheet-close', '✕');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close comments');
  head.append(title, closeBtn);

  const list = el('ol', 'comments');
  const empty = el('p', 'comments-empty', 'No comments yet. Say something.');
  empty.hidden = true;

  const form = el('form', 'comment-form');
  const row = el('div', 'comment-row');
  const textInput = el('input', 'comment-text');
  Object.assign(textInput, { name: 'text', maxLength: 200, placeholder: 'Add a comment…', autocomplete: 'off', required: true });
  textInput.setAttribute('enterkeyhint', 'send');
  const send = el('button', 'btn', 'Send');
  send.type = 'submit';
  row.append(textInput, send);
  const note = el('p', 'comment-note');
  form.append(row, note);

  dialog.append(head, list, empty, form);
  document.body.append(dialog);

  let next = 0, count = 0, timer = null, closed = false;

  function setCount(n) {
    count = n;
    title.textContent = n ? `Comments · ${n}` : 'Comments';
    empty.hidden = n > 0;
    if (onCount) onCount(n);
  }

  function render(c) {
    const li = el('li', 'comment');
    const who = el('a', 'comment-avatar');
    who.href = `/u/${c.userId}`;
    who.append(avatarNode(c.avatar, c.name, 'avatar xs'));
    const body = el('div', 'comment-body');
    const line = el('div', 'comment-line');
    const name = el('a', 'comment-author', c.name);
    name.href = `/u/${c.userId}`;
    line.append(name, el('span', 'comment-time', ago(c.createdAt)));
    body.append(line, el('p', 'comment-text-body', c.text));
    li.append(who, body);
    return li;
  }

  async function load() {
    try {
      const r = await fetch(`/api/streams/${stream.id}/comments?from=${next}`);
      if (!r.ok) return;
      const { items, next: n } = await r.json();
      if (closed) return;
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      for (const c of items) list.append(render(c));
      next = n;
      setCount(n);
      if (items.length && (atBottom || list.childElementCount === items.length)) list.scrollTop = list.scrollHeight;
    } catch {}
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = textInput.value.replace(/\s+/g, ' ').trim();
    if (!text) return;
    note.textContent = '';
    send.disabled = true;
    try {
      // No profile on this device yet: ask for a name in a popup, then post.
      let user = await ensureUser(NAME_PROMPT);
      if (!user) return; // cancelled; the comment stays in the box
      const post = (u) => fetch(`/api/streams/${stream.id}/comments`, {
        method: 'POST', headers: authHeaders(u), body: JSON.stringify({ text }),
      });
      let r = await post(user);
      if (r.status === 401) { // this server doesn't know this device's user any more: ask again
        clearUser();
        user = await ensureUser(NAME_PROMPT);
        if (!user) return;
        r = await post(user);
      }
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { note.textContent = body.error ? `${body.error[0].toUpperCase()}${body.error.slice(1)}.` : 'Could not send. Try again.'; return; }
      textInput.value = '';
      await load(); // picks up this comment (and any others) in order
      list.scrollTop = list.scrollHeight;
    } catch (err) {
      note.textContent = err.message || 'Could not send. Try again.';
    } finally {
      send.disabled = false;
    }
  };

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    if (dialog.open) dialog.close();
    dialog.remove();
    if (current === api) current = null;
  }
  closeBtn.onclick = close;
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); }); // tap above the sheet

  const api = { close };
  current = api;
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  load();
  timer = setInterval(load, POLL_MS);
  return api;
}
