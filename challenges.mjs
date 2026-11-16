// Challenges: a prompt that is open for a set window (e.g. Friday 5pm to Sunday night). Each
// person gets one extra take per challenge. The list is a hand-edited JSON file:
//
//   { "timezone": "America/Los_Angeles",
//     "challenges": [ { "id": "2026-11-20", "starts": "2026-11-20 17:00", "ends": "2026-11-22 23:59",
//                       "title": "The Tour", "prompt": "Show us where you are right now." } ] }
//
// Times are wall-clock times in the file's time zone. Any window works; there is no weekend
// logic here. Windows may not overlap, so at most one challenge is open at a time.
import { readFileSync } from 'node:fs';

export const MAX_CHALLENGE_TITLE = 40;
export const MAX_CHALLENGE_PROMPT = 140;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/i;
const WALL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;

// How far the zone's clock is ahead of UTC at a given moment, in ms (negative west of UTC).
function zoneOffset(timeZone, at) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(at));
  const n = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(at / 1000) * 1000;
}

// "2026-11-20 17:00" in a time zone -> the moment (ms since 1970). Daylight saving is handled by
// asking for the zone's offset at that moment (twice, as the first guess may be on the other side
// of a clock change).
export function zonedTime(text, timeZone) {
  const m = WALL.exec(String(text ?? '').trim());
  if (!m) throw new Error(`"${text}" is not a time like "2026-11-20 17:00"`);
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(wall); // Date.UTC rolls bad values over (month 13, Feb 30, hour 24), so compare
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
    || back.getUTCHours() !== h || back.getUTCMinutes() !== mi) throw new Error(`"${text}" is not a real date and time`);
  const first = wall - zoneOffset(timeZone, wall);
  return wall - zoneOffset(timeZone, first);
}

const oneLine = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

// The file's contents -> [{ id, title, prompt, startsAt, endsAt }], oldest first. Throws with a
// message naming the entry when something is wrong.
export function parseChallenges(doc) {
  const timeZone = doc?.timezone || 'America/Los_Angeles';
  try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch { throw new Error(`unknown time zone "${timeZone}"`); }
  if (!Array.isArray(doc?.challenges)) throw new Error('expected a "challenges" list');
  const seen = new Set();
  const list = doc.challenges.map((c, i) => {
    const where = `challenge ${i + 1}${c?.id ? ` (${c.id})` : ''}`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`${where}: expected { id, starts, ends, title, prompt }`);
    const id = String(c.id ?? '');
    if (!ID.test(id) || id === 'current') throw new Error(`${where}: id must be letters, digits and dashes (and not "current")`);
    if (seen.has(id)) throw new Error(`${where}: id is used twice`);
    seen.add(id);
    const title = oneLine(c.title), prompt = oneLine(c.prompt);
    if (!title || [...title].length > MAX_CHALLENGE_TITLE) throw new Error(`${where}: title must be 1-${MAX_CHALLENGE_TITLE} characters`);
    if (!prompt || [...prompt].length > MAX_CHALLENGE_PROMPT) throw new Error(`${where}: prompt must be 1-${MAX_CHALLENGE_PROMPT} characters`);
    let startsAt, endsAt;
    try { startsAt = zonedTime(c.starts, timeZone); endsAt = zonedTime(c.ends, timeZone); }
    catch (e) { throw new Error(`${where}: ${e.message}`); }
    if (endsAt <= startsAt) throw new Error(`${where}: ends before it starts`);
    return { id, title, prompt, startsAt, endsAt };
  }).sort((a, b) => a.startsAt - b.startsAt);
  for (let i = 1; i < list.length; i++) {
    if (list[i].startsAt < list[i - 1].endsAt) throw new Error(`challenges ${list[i - 1].id} and ${list[i].id} overlap`);
  }
  return list;
}

// Read the file. A missing file means no challenges; a broken one is reported and also means no
// challenges (the app then simply works without them) rather than stopping the server.
export function loadChallenges(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  try { return parseChallenges(JSON.parse(text)); }
  catch (e) { console.error(`${file}: ${e.message}. Running without challenges.`); return []; }
}

// Open right now (start included, end excluded), and the next one to open.
export const currentChallenge = (list, now = Date.now()) => list.find((c) => c.startsAt <= now && now < c.endsAt) ?? null;
export const nextChallenge = (list, now = Date.now()) => list.find((c) => c.startsAt > now) ?? null;
