// Challenges on the pages: what's open now, how long is left, and the strip on the home feed.
// The server decides everything (see challenges.mjs); a challenge that hasn't started is never sent.

// How long until something: "1d 4h", "13h 22m", "4m 05s", "12s". Used for the Record button's
// lock countdown (ticks every second) and, without seconds, for a challenge's time left.
export function untilText(ms, { seconds = true } = {}) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (!seconds) return s > 60 ? `${Math.ceil(s / 60)}m` : 'a minute';
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}
// A challenge's time left, for texts that update every 30 seconds: "1d 4h", "5h 12m", "12m".
export const timeLeft = (ms) => untilText(ms, { seconds: false });

// When the next one opens, in the viewer's own time: "Friday 5:00 PM", or with the date if it's over a week away.
export function dropTime(t) {
  const far = t - Date.now() > 6 * 24 * 3600 * 1000;
  return new Date(t).toLocaleString([], far
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { weekday: 'long', hour: 'numeric', minute: '2-digit' });
}

// { current: { id, title, prompt, startsAt, endsAt, open, takes } | null, next: { startsAt } | null }
export async function loadChallenges() {
  try {
    const r = await fetch('/api/challenges/current');
    if (r.ok) return await r.json();
  } catch {}
  return { current: null, next: null };
}

// The strip under the home page's header: the open challenge with the time left (a link to its
// page), or when the next one opens. Hidden when there is neither.
export async function setupStrip(box) {
  let data = await loadChallenges();
  const span = (cls, text) => { const n = document.createElement('span'); n.className = cls; n.textContent = text; return n; };
  function render() {
    const now = Date.now();
    const { current, next } = data;
    box.replaceChildren();
    if (current && now < current.endsAt) {
      const a = document.createElement('a');
      a.className = 'challenge-strip';
      a.href = `/c/${encodeURIComponent(current.id)}`;
      a.append(span('strip-label', 'Challenge'), span('strip-title', current.title), span('strip-time', `${timeLeft(current.endsAt - now)} left`));
      box.append(a);
    } else if (next && now < next.startsAt) {
      const d = document.createElement('div');
      d.className = 'challenge-strip';
      d.append(span('strip-label', 'Next challenge'), span('strip-time', dropTime(next.startsAt)));
      box.append(d);
    }
    box.hidden = !box.firstChild;
    document.body.classList.toggle('has-strip', !box.hidden);
  }
  render();
  // Keep the time left current, and ask again when one closes or the next one opens.
  setInterval(async () => {
    const now = Date.now();
    const { current, next } = data;
    if ((current && now >= current.endsAt) || (next && now >= next.startsAt)) data = await loadChallenges();
    render();
  }, 30000);
}
