// Turn a fragmented MP4 (what MediaRecorder writes: ftyp, moov with mvex, then moof+mdat pairs)
// into a plain "fast start" MP4 (ftyp, moov with full sample tables, one mdat). Plain MP4 has a
// known duration and plays progressively in every browser; some browsers (notably Safari) are
// unreliable with Chrome's fragmented recordings played straight from a URL.
// The sample data is copied byte for byte; only the index is rebuilt. Zero dependencies.

function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); header = 16; }
    else if (size === 0) size = end - p;
    if (size < header || p + size > end) break; // truncated tail: ignore what's incomplete
    out.push({ type, start: p, end: p + size, body: p + header });
    p += size;
  }
  return out;
}
const child = (buf, box, type) => boxes(buf, box.body, box.end).find((b) => b.type === type);
const children = (buf, box) => boxes(buf, box.body, box.end);

function box(type, ...parts) {
  const payload = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}
function fullBox(type, version, flags, ...parts) {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
  return box(type, vf, ...parts);
}
const u32 = (values) => {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4));
  return b;
};

// Copy a header box (mvhd/tkhd/mdhd) with its duration field replaced.
function withDuration(buf, b, duration, offsets) {
  const copy = Buffer.from(buf.subarray(b.start, b.end));
  const version = copy[b.body - b.start];
  const at = (b.body - b.start) + offsets[version ? 1 : 0];
  if (version) copy.writeBigUInt64BE(BigInt(duration), at);
  else copy.writeUInt32BE(Math.min(duration, 0xffffffff), at);
  return copy;
}
// Duration offsets from the start of each box's body (after version/flags), for v0 and v1.
const MVHD = [4 + 4 + 4 + 4, 4 + 8 + 8 + 4];
const TKHD = [4 + 4 + 4 + 4 + 4, 4 + 8 + 8 + 4 + 4];
const MDHD = [4 + 4 + 4 + 4, 4 + 8 + 8 + 4];

const timescaleOf = (buf, b) => (buf[b.body] ? buf.readUInt32BE(b.body + 20) : buf.readUInt32BE(b.body + 12));

// Far more than a capped live can hold (30 fps video plus audio is under 100 samples a second).
const MAX_SAMPLES = 500_000;

export function isFragmentedMp4(buf) {
  const top = boxes(buf);
  const moov = top.find((b) => b.type === 'moov');
  return !!(moov && child(buf, moov, 'mvex') && top.some((b) => b.type === 'moof'));
}

// Returns a Buffer with the plain MP4, or null if the input has no usable samples.
export function defragmentMp4(buf) {
  const top = boxes(buf);
  const ftyp = top.find((b) => b.type === 'ftyp');
  const moov = top.find((b) => b.type === 'moov');
  if (!ftyp || !moov) return null;

  // Track info and fragment defaults.
  const tracks = new Map(); // track_ID -> { trak, samples: [] , defaults }
  for (const trak of children(buf, moov).filter((b) => b.type === 'trak')) {
    const tkhd = child(buf, trak, 'tkhd');
    const id = buf.readUInt32BE(tkhd.body + (buf[tkhd.body] ? 20 : 12));
    tracks.set(id, { id, trak, samples: [], defaults: { duration: 0, size: 0, flags: 0 } });
  }
  const mvex = child(buf, moov, 'mvex');
  for (const trex of mvex ? children(buf, mvex).filter((b) => b.type === 'trex') : []) {
    const t = tracks.get(buf.readUInt32BE(trex.body + 4));
    if (t) t.defaults = { duration: buf.readUInt32BE(trex.body + 12), size: buf.readUInt32BE(trex.body + 16), flags: buf.readUInt32BE(trex.body + 20) };
  }

  // Walk every fragment and collect each sample's size, timing, flags and file position.
  // The file comes from whoever was broadcasting, so the counts in it aren't trusted: a run
  // claiming billions of samples would otherwise keep the server busy until it ran out of memory.
  let budget = MAX_SAMPLES;
  for (const moof of top.filter((b) => b.type === 'moof')) {
    for (const traf of children(buf, moof).filter((b) => b.type === 'traf')) {
      const tfhd = child(buf, traf, 'tfhd');
      if (!tfhd) continue;
      const tfFlags = buf.readUInt32BE(tfhd.body) & 0xffffff;
      const t = tracks.get(buf.readUInt32BE(tfhd.body + 4));
      if (!t) continue;
      let q = tfhd.body + 8;
      let base = moof.start; // default-base-is-moof (and the usual choice when no base is given)
      if (tfFlags & 0x1) { base = Number(buf.readBigUInt64BE(q)); q += 8; }
      if (tfFlags & 0x2) q += 4; // sample description index
      let dDur = t.defaults.duration, dSize = t.defaults.size, dFlags = t.defaults.flags;
      if (tfFlags & 0x8) { dDur = buf.readUInt32BE(q); q += 4; }
      if (tfFlags & 0x10) { dSize = buf.readUInt32BE(q); q += 4; }
      if (tfFlags & 0x20) { dFlags = buf.readUInt32BE(q); q += 4; }

      let dataEnd = null; // runs without a data offset continue where the previous one ended
      for (const trun of children(buf, traf).filter((b) => b.type === 'trun')) {
        const version = buf[trun.body];
        const f = buf.readUInt32BE(trun.body) & 0xffffff;
        const count = buf.readUInt32BE(trun.body + 4);
        let r = trun.body + 8;
        let pos = dataEnd ?? base;
        if (f & 0x1) { pos = base + buf.readInt32BE(r); r += 4; }
        let firstFlags = null;
        if (f & 0x4) { firstFlags = buf.readUInt32BE(r); r += 4; }
        for (let i = 0; i < count; i++) {
          if (--budget < 0) return null;
          const duration = f & 0x100 ? buf.readUInt32BE((r += 4) - 4) : dDur;
          const size = f & 0x200 ? buf.readUInt32BE((r += 4) - 4) : dSize;
          let flags = f & 0x400 ? buf.readUInt32BE((r += 4) - 4) : dFlags;
          if (i === 0 && firstFlags != null) flags = firstFlags;
          const cto = f & 0x800 ? (version ? buf.readInt32BE((r += 4) - 4) : buf.readUInt32BE((r += 4) - 4)) : 0;
          if (pos >= 0 && pos + size <= buf.length) t.samples.push({ duration, size, flags, cto, pos });
          pos += size;
        }
        dataEnd = pos;
      }
    }
  }

  const used = [...tracks.values()].filter((t) => t.samples.length);
  if (!used.length) return null;

  // New mdat: all samples in their original order in the file (keeps audio/video interleaved).
  const order = used.flatMap((t) => t.samples.map((s) => ({ t, s }))).sort((a, b) => a.s.pos - b.s.pos);

  const mvhd = child(buf, moov, 'mvhd');
  const movieScale = timescaleOf(buf, mvhd);

  function buildMoov(offsets) {
    let movieDuration = 0;
    const traks = used.map((t) => {
      const mdia = child(buf, t.trak, 'mdia');
      const mdhd = child(buf, mdia, 'mdhd');
      const mediaScale = timescaleOf(buf, mdhd);
      const mediaDuration = t.samples.reduce((a, s) => a + s.duration, 0);
      const trackDuration = Math.round((mediaDuration * movieScale) / mediaScale);
      movieDuration = Math.max(movieDuration, trackDuration);

      const minf = child(buf, mdia, 'minf');
      const stbl = child(buf, minf, 'stbl');
      const stsd = child(buf, stbl, 'stsd');

      // stts: run-length durations
      const stts = [];
      for (const s of t.samples) {
        const last = stts[stts.length - 1];
        if (last && last[1] === s.duration) last[0]++; else stts.push([1, s.duration]);
      }
      const parts = [
        Buffer.from(buf.subarray(stsd.start, stsd.end)),
        fullBox('stts', 0, 0, u32([stts.length, ...stts.flat()])),
      ];
      // ctts: composition offsets (B-frames), only when present
      if (t.samples.some((s) => s.cto)) {
        const runs = [];
        for (const s of t.samples) {
          const last = runs[runs.length - 1];
          if (last && last[1] === s.cto) last[0]++; else runs.push([1, s.cto]);
        }
        const neg = runs.some((x) => x[1] < 0);
        const body = Buffer.alloc(4 + runs.length * 8);
        body.writeUInt32BE(runs.length, 0);
        runs.forEach(([n, o], i) => { body.writeUInt32BE(n, 4 + i * 8); if (neg) body.writeInt32BE(o, 8 + i * 8); else body.writeUInt32BE(o, 8 + i * 8); });
        parts.push(fullBox('ctts', neg ? 1 : 0, 0, body));
      }
      // stss: key frames (omitted when every sample is a sync sample, e.g. audio)
      const hdlr = child(buf, mdia, 'hdlr');
      const isVideo = hdlr && buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) === 'vide';
      const sync = [];
      t.samples.forEach((s, i) => { if (!(s.flags & 0x10000)) sync.push(i + 1); });
      if (isVideo && sync.length && sync.length !== t.samples.length) {
        parts.push(fullBox('stss', 0, 0, u32([sync.length, ...sync])));
      }
      // one sample per chunk; chunk offsets point into the new mdat
      parts.push(fullBox('stsc', 0, 0, u32([1, 1, 1, 1])));
      parts.push(fullBox('stsz', 0, 0, u32([0, t.samples.length, ...t.samples.map((s) => s.size)])));
      parts.push(fullBox('stco', 0, 0, u32([t.samples.length, ...t.samples.map((s) => offsets.get(s) ?? 0)])));
      const newStbl = box('stbl', ...parts);

      const newMinf = box('minf', ...children(buf, minf).map((c) =>
        c.type === 'stbl' ? newStbl : Buffer.from(buf.subarray(c.start, c.end))));
      const newMdia = box('mdia', ...children(buf, mdia).map((c) => {
        if (c.type === 'mdhd') return withDuration(buf, c, mediaDuration, MDHD);
        if (c.type === 'minf') return newMinf;
        return Buffer.from(buf.subarray(c.start, c.end));
      }));
      return box('trak', ...children(buf, t.trak).map((c) => {
        if (c.type === 'tkhd') return withDuration(buf, c, trackDuration, TKHD);
        if (c.type === 'mdia') return newMdia;
        return Buffer.from(buf.subarray(c.start, c.end));
      }));
    });
    const rest = children(buf, moov).filter((c) => !['mvhd', 'trak', 'mvex'].includes(c.type))
      .map((c) => Buffer.from(buf.subarray(c.start, c.end)));
    return box('moov', withDuration(buf, mvhd, movieDuration, MVHD), ...traks, ...rest);
  }

  const ftypBuf = Buffer.from(buf.subarray(ftyp.start, ftyp.end));
  const moovSize = buildMoov(new Map()).length; // offsets don't change the size
  const mdatSize = 8 + order.reduce((a, x) => a + x.s.size, 0);
  if (mdatSize > 0xffffffff) return null;
  const offsets = new Map();
  let at = ftypBuf.length + moovSize + 8;
  for (const { s } of order) { offsets.set(s, at); at += s.size; }

  const mdatHead = Buffer.alloc(8);
  mdatHead.writeUInt32BE(mdatSize, 0);
  mdatHead.write('mdat', 4, 'latin1');
  return Buffer.concat([ftypBuf, buildMoov(offsets), mdatHead, ...order.map(({ s }) => buf.subarray(s.pos, s.pos + s.size))]);
}
