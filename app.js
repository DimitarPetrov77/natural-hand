/* Natural Hand — capture app
 * Records every pen sample (position, time, pressure, tilt, hover) as raw data,
 * renders it as a technical pen, stores locally in IndexedDB and syncs to Google Drive.
 *
 * Coordinates: paper millimetres, origin top-left of the sheet.
 * Screen mapping (CSS px): screen = R(rot) * (doc * ppmm * zoom) + (tx, ty)
 */
'use strict';
(() => {

const APP_VERSION = '0.7.1';
const FORMAT = 'natural-hand/1';
const SAMPLE_FIELDS = ['dt_ms','x_mm','y_mm','pressure','tiltX','tiltY','twist','altitude','azimuth','tangential','width_px','height_px','buttons'];
const PAPERS = { A5: [148, 210], A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], Square: [300, 300] };
const ENDLESS_PAD = 150, ENDLESS_MARGIN = 25; // mm of room added around ink on endless pages
const NIBS = [0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2.0];
const BRUSHES = {
  technical: { label: 'Technical', width: () => 1 },
  ink:       { label: 'Ink pen',   width: (p) => 0.5 + 0.8 * p },
  brush:     { label: 'Brush pen', width: (p) => 0.08 + 2.2 * Math.pow(p, 1.3) },
};
const SMOOTH_MAX_TAU = 150;    // ms of smoothing lag at level 100
const tauFor = (level) => rnd(SMOOTH_MAX_TAU * Math.pow(clamp(level || 0, 0, 100) / 100, 1.5), 2);
const MAX_BITMAP = 4096;       // paper bitmap edge, px (mobile canvas limit safe)
const PALM_MS = 800;           // ignore finger touches this long after pen activity
const HOVER_LIMIT = 30000;     // max hover samples kept between two strokes
const DEFAULT_PPMM = 96 / 25.4; // CSS nominal; calibration replaces it

const $ = (s) => document.querySelector(s);
const rnd = (v, d) => { const m = 10 ** d; return Math.round(v * m) / m; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/* Time. Pen events carry precise timestamps from the browser's monotonic clock, but on
 * phones that clock stops while the device sleeps (screen locked). clockDrift adds back
 * the time the clock missed, so stroke start times stay true wall-clock times and pauses
 * across a locked screen have their real length. It is only updated between strokes. */
let clockDrift = 0;
function syncClock() {
  const d = Date.now() - (performance.timeOrigin + performance.now());
  if (Math.abs(d - clockDrift) > 5) clockDrift = d;
}
const absTime = (e) => performance.timeOrigin + e.timeStamp + clockDrift;
const absNow = () => performance.timeOrigin + performance.now() + clockDrift;
const uid = () => Math.random().toString(36).slice(2, 8);
const pad2 = (n) => String(n).padStart(2, '0');

/* ---------------------------------------------------------------- storage */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('natural-hand', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('drawings', { keyPath: 'id' });
        d.createObjectStore('strokes', { keyPath: ['drawing', 'i'] });
        d.createObjectStore('events', { autoIncrement: true }).createIndex('drawing', 'drawing');
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  write(store, fn) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(store, 'readwrite');
      fn(tx);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('Storage write aborted'));
    });
  },
  read(store, fn) {
    return new Promise((res, rej) => {
      const r = fn(this.db.transaction(store).objectStore(store));
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  put(store, v) { return this.write(store, (tx) => tx.objectStore(store).put(v)); },
  add(store, v) { return this.write(store, (tx) => tx.objectStore(store).add(v)); },
  get(store, k) { return this.read(store, (s) => s.get(k)); },
  all(store) { return this.read(store, (s) => s.getAll()); },
  // In batches: each batch is decoded on its own, so the page keeps breathing. The batch
  // size follows how long the last one took, since lines vary from 2 to thousands of samples.
  async strokes(id, onBatch) {
    const out = [];
    let n = 100;
    for (;;) {
      const lo = out.length ? out[out.length - 1].i : 0, t = performance.now();
      const part = await this.read('strokes', (s) => s.getAll(IDBKeyRange.bound([id, lo], [id, Infinity], out.length > 0), n));
      const dt = performance.now() - t;
      for (const st of part) out.push(st);
      if (onBatch) await onBatch(part, out.length);
      if (part.length < n) return out;
      n = clamp(Math.round(n * 25 / Math.max(dt, 1)), Math.max(20, n >> 2), Math.min(n * 2, 1000)); // aim for about 25 ms a batch
    }
  },
  events(id) { return this.read('events', (s) => s.index('drawing').getAll(id)); },
  replaceDrawing(meta, strokes, events) {
    const id = meta.id;
    return this.write(['drawings', 'strokes', 'events'], (tx) => {
      tx.objectStore('drawings').put(meta);
      const ss = tx.objectStore('strokes');
      ss.delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
      // still one transaction (all or nothing), but each put copies its stroke on this thread,
      // so they go in slices: the next slice starts when the last put of this one is done
      let i = 0;
      const next = () => {
        const end = performance.now() + 12;
        let last = null;
        while (i < strokes.length && performance.now() < end) last = ss.put(strokes[i++]);
        if (i < strokes.length) last.onsuccess = next;
      };
      next();
      const es = tx.objectStore('events');
      es.index('drawing').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
        const c = e.target.result;
        if (c) { es.delete(c.primaryKey); c.continue(); }
        else for (const ev of events) es.add(ev);
      };
    });
  },
  deleteDrawing(id) {
    return this.write(['drawings', 'strokes', 'events'], (tx) => {
      tx.objectStore('drawings').delete(id);
      tx.objectStore('strokes').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
      const idx = tx.objectStore('events').index('drawing');
      idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
        const c = e.target.result;
        if (c) { tx.objectStore('events').delete(c.primaryKey); c.continue(); }
      };
    });
  },
};

function loadDevice() { try { return JSON.parse(localStorage.getItem('nh-device')); } catch { return null; } }
function saveDevice(d) { localStorage.setItem('nh-device', JSON.stringify(d)); }

/* ------------------------------------------------------------------ state */
const S = {
  device: null,
  ppmm: DEFAULT_PPMM,
  meta: null,          // current drawing metadata
  strokes: [],         // current drawing strokes (index = stroke.i)
  paper: null,         // {c, x, K} bitmap of the sheet
  endless: false,
  view: { s: 1, r: 0, tx: 0, ty: 0 },
  tool: 'pen',
  width: 0.3,
  eraseMode: 'stroke',     // 'stroke' deletes whole lines, 'cut' cuts through them
  brush: 'technical',
  smoothing: 0,
  partStack: [],       // ids of the parts open while drawing, outermost first
  kind: localStorage.getItem('nh-kind') || 'Figure', // kind the part button starts
  fill: false,
  active: null,        // {st, id}
  loading: false,      // a drawing is being opened: no drawing input until it is ready
  hover: [],
  hoverDropped: 0,
  redo: [],
  sessionId: null,
  sessionLogged: false,
  lastPen: -1e9,
  touchNav: localStorage.getItem('nh-touch') !== '0',
  penButtonFigure: localStorage.getItem('nh-penbtn') !== '0',
  prompt: null,
  diag: localStorage.getItem('nh-diag') === '1',
};

/* ------------------------------------------------------------ view canvas */
const view = $('#view');
const vctx = view.getContext('2d', { alpha: false });
let dpr = 1, cw = 0, ch = 0, surround = '#575651';

function readSurround() { surround = getComputedStyle(document.documentElement).getPropertyValue('--surround').trim() || surround; }
function resize() {
  dpr = window.devicePixelRatio || 1;
  cw = window.innerWidth; ch = window.innerHeight;
  view.width = Math.round(cw * dpr); view.height = Math.round(ch * dpr);
  view.style.width = cw + 'px'; view.style.height = ch + 'px';
  requestRender();
}

let renderQueued = false;
function requestRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(render); } }
function render() {
  renderQueued = false;
  updateZoomChip();
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  if (S.paper && !Replay.on && sharpKey === viewKey()) { vctx.drawImage(sharp, 0, 0); return; }
  vctx.fillStyle = S.paper && S.endless ? '#ffffff' : surround;
  vctx.fillRect(0, 0, view.width, view.height);
  if (!S.paper) return;
  const v = S.view, k = S.ppmm * v.s, pp = Replay.on ? Replay.paper : S.paper, b = pp.b;
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vctx.translate(v.tx, v.ty);
  vctx.rotate(v.r);
  vctx.scale(k, k);
  vctx.imageSmoothingEnabled = true;
  vctx.imageSmoothingQuality = 'high';
  vctx.drawImage(pp.c, b.x0, b.y0, b.w, b.h);
  if (Replay.on) { Replay.drawCursor(vctx, k); return; }
  scheduleSharp();
}

/* Sharp layer: when the view stops moving, strokes in view are redrawn from their
 * vector samples at full screen resolution, so ink stays crisp at any zoom.
 * While panning or zooming, the cached page bitmap is shown instead. */
const sharp = document.createElement('canvas');
const sctx = sharp.getContext('2d', { alpha: false });
let sharpKey = null, sharpTimer = 0;
const BB = new WeakMap();
function viewKey() { const v = S.view; return `${v.s}|${v.r}|${v.tx}|${v.ty}|${view.width}|${view.height}|${S.ppmm}|${surround}`; }
function invalidateSharp() { sharpKey = null; }
function scheduleSharp() { clearTimeout(sharpTimer); sharpTimer = setTimeout(renderSharp, 120); }
function applyView(ctx) {
  const v = S.view, k = S.ppmm * v.s;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(v.tx, v.ty); ctx.rotate(v.r); ctx.scale(k, k);
}
function bboxOf(st) {
  const n = st.samples.length;
  let b = BB.get(st);
  if (b && b.n === n) return b;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of st.samples) { if (r[1] < x0) x0 = r[1]; if (r[1] > x1) x1 = r[1]; if (r[2] < y0) y0 = r[2]; if (r[2] > y1) y1 = r[2]; }
  const h = st.width_mm / 2;
  b = { x0: x0 - h, y0: y0 - h, x1: x1 + h, y1: y1 + h, n };
  BB.set(st, b);
  return b;
}
function visibleDocRect() {
  const c = [screenToDoc(0, 0), screenToDoc(cw, 0), screenToDoc(0, ch), screenToDoc(cw, ch)];
  return { x0: Math.min(...c.map((p) => p[0])), x1: Math.max(...c.map((p) => p[0])), y0: Math.min(...c.map((p) => p[1])), y1: Math.max(...c.map((p) => p[1])) };
}
function clipPaper(ctx) { if (S.endless) return; const b = S.paper.b; ctx.beginPath(); ctx.rect(b.x0, b.y0, b.w, b.h); ctx.clip(); }
// true when the screen shows more pixels per mm than the page bitmap holds (zoomed in):
// only then are strokes redrawn from vectors; otherwise the bitmap is already sharp enough
function vectorView() { return S.ppmm * S.view.s * dpr > S.paper.K * 1.05; }
function renderSharp() {
  if (!S.paper || Replay.on) return;
  if (gesture || mousePan) { scheduleSharp(); return; }
  if (sharp.width !== view.width || sharp.height !== view.height) { sharp.width = view.width; sharp.height = view.height; }
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.fillStyle = S.endless ? '#ffffff' : surround;
  sctx.fillRect(0, 0, sharp.width, sharp.height);
  applyView(sctx);
  const pb = S.paper.b;
  if (!vectorView()) {
    sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(S.paper.c, pb.x0, pb.y0, pb.w, pb.h);
    sharpKey = viewKey();
    requestRender();
    return;
  }
  sctx.fillStyle = '#ffffff';
  if (!S.endless) sctx.fillRect(pb.x0, pb.y0, pb.w, pb.h);
  sctx.save(); clipPaper(sctx);
  const r = visibleDocRect();
  for (const st of S.strokes) {
    if (!visibleInk(st)) continue;
    const b = bboxOf(st);
    if (b.x1 < r.x0 || b.x0 > r.x1 || b.y1 < r.y0 || b.y0 > r.y1) continue;
    drawStroke(sctx, st);
  }
  sctx.restore();
  sharpKey = viewKey();
  requestRender();
}
// draw new ink into the page bitmap and, if it is current, the sharp layer
function inkLive(st, from = 0) {
  drawStroke(S.paper.x, st, from);
  if (sharpKey === viewKey()) {
    applyView(sctx); sctx.save(); clipPaper(sctx);
    drawStroke(sctx, st, from);
    sctx.restore();
  }
}

function screenToDoc(sx, sy, v = S.view) {
  const k = S.ppmm * v.s, c = Math.cos(v.r), s = Math.sin(v.r);
  const X = sx - v.tx, Y = sy - v.ty;
  return [(c * X + s * Y) / k, (-s * X + c * Y) / k];
}
function setViewAround(D, sx, sy, s, r) {
  const k = S.ppmm * s, c = Math.cos(r), sn = Math.sin(r);
  const X = D[0] * k, Y = D[1] * k;
  S.view = { s, r, tx: sx - (c * X - sn * Y), ty: sy - (sn * X + c * Y) };
}
function snapRot(r) {
  r = Math.atan2(Math.sin(r), Math.cos(r));
  const q = Math.round(r / (Math.PI / 2)) * (Math.PI / 2);
  return Math.abs(r - q) < (3 * Math.PI / 180) ? q : r;
}
function fit() {
  if (!S.meta) return;
  const b = S.endless ? (contentBox(S.strokes, 15) || { x0: -100, y0: -140, w: 200, h: 280 }) : S.paper.b, pad = 24;
  const rr = $('#rail').getBoundingClientRect();
  let L = 0, B = 0;
  if (rr.height > rr.width) L = rr.right; else B = ch - rr.top;
  const aw = cw - L - pad * 2, ah = ch - B - pad * 2 - 30;
  const s = clamp(Math.min(aw / (b.w * S.ppmm), ah / (b.h * S.ppmm)), 0.02, 4);
  const k = S.ppmm * s;
  S.view = { s, r: 0, tx: L + pad + (aw - b.w * k) / 2 - b.x0 * k, ty: pad + 30 + (ah - b.h * k) / 2 - b.y0 * k };
  persistViewSoon();
  requestRender();
}

/* ------------------------------------------------------------ paper ink */
function makePaper(b) {
  const K = Math.min(MAX_BITMAP / b.w, MAX_BITMAP / b.h, 16);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(b.w * K)); c.height = Math.max(1, Math.round(b.h * K));
  return { c, x: c.getContext('2d'), K, b };
}
function contentBox(strokes, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const st of strokes) {
    if (st.undone_at || st.tool === 'eraser' || !st.samples.length) continue;
    const b = bboxOf(st);
    if (b.x0 < x0) x0 = b.x0; if (b.y0 < y0) y0 = b.y0; if (b.x1 > x1) x1 = b.x1; if (b.y1 > y1) y1 = b.y1;
  }
  if (x0 === Infinity) return null;
  return { x0: x0 - pad, y0: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}
// endless pages: grow the page (in 50 mm steps) when ink comes near its edge
function growTo(b, c) {
  if (c.x0 >= b.x0 + ENDLESS_MARGIN && c.y0 >= b.y0 + ENDLESS_MARGIN && c.x0 + c.w <= b.x0 + b.w - ENDLESS_MARGIN && c.y0 + c.h <= b.y0 + b.h - ENDLESS_MARGIN) return b;
  const snap = (v, f) => f(v / 50) * 50;
  const x0 = snap(Math.min(b.x0, c.x0 - ENDLESS_PAD), Math.floor), y0 = snap(Math.min(b.y0, c.y0 - ENDLESS_PAD), Math.floor);
  const x1 = snap(Math.max(b.x0 + b.w, c.x0 + c.w + ENDLESS_PAD), Math.ceil), y1 = snap(Math.max(b.y0 + b.h, c.y0 + c.h + ENDLESS_PAD), Math.ceil);
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}
function boundsOfMeta(meta, strokes) {
  const p = meta.paper;
  if (!p.endless) return { x0: 0, y0: 0, w: p.w_mm, h: p.h_mm };
  const b = { x0: p.x0 ?? -200, y0: p.y0 ?? -200, w: p.w_mm || 400, h: p.h_mm || 400 };
  const c = contentBox(strokes);
  return c ? growTo(b, c) : b;
}
function maybeExtend() {
  if (!S.endless) return;
  const c = contentBox(S.strokes);
  if (!c) return;
  const nb = growTo(S.paper.b, c);
  if (nb === S.paper.b) return;
  S.paper = makePaper(nb);
  Object.assign(S.meta.paper, { x0: nb.x0, y0: nb.y0, w_mm: nb.w, h_mm: nb.h });
  repaint();
}
// a whole-line eraser shows a light trail while you drag; a cutting eraser paints white
const eraseModeOf = (st) => st.erase_mode || 'cut';
function inkOf(st) { return st.tool !== 'eraser' ? '#000000' : eraseModeOf(st) === 'stroke' ? '#a4dded' : '#ffffff'; }
/* Smoothing: `raw` keeps exactly what the device reported; `samples` is the smoothed
 * path that is drawn and analysed. Positions pass through a time-based exponential
 * filter (time constant smoothing_tau_ms), so a level feels the same on every device.
 * The pen-up sample lands on the real end point. */
function smoothStep(sm, r, tau) {
  if (!sm.started || tau <= 0) { sm.ex = r[1]; sm.ey = r[2]; sm.started = true; }
  else { const a = 1 - Math.exp(-Math.max(0, r[0] - sm.t) / tau); sm.ex += (r[1] - sm.ex) * a; sm.ey += (r[2] - sm.ey) * a; }
  sm.t = r[0];
  const out = r.slice(); out[1] = rnd(sm.ex, 4); out[2] = rnd(sm.ey, 4);
  return out;
}
function smoothRows(raw, tau, complete) {
  const sm = {}, out = raw.map((r) => smoothStep(sm, r, tau));
  if (complete && out.length) { const l = raw[raw.length - 1]; out[out.length - 1] = l.slice(); }
  return out;
}
// strokes from older versions: v0.3 stored raw positions with display-only smoothing
function normalizeStroke(st) {
  if (st.smoothing_tau_ms > 0 && !st.raw) { st.raw = st.samples; st.samples = smoothRows(st.raw, st.smoothing_tau_ms, !st.cancelled); }
  if (!st.brush) st.brush = 'technical';
  return st;
}

// per-sample widths (mm) from pressure, lightly smoothed so the line does not wobble
const WD = new WeakMap();
function widthsOf(st) {
  const n = st.samples.length, fn = (BRUSHES[st.brush] || BRUSHES.technical).width;
  let c = WD.get(st);
  if (!c || c.n > n) { c = { n: 0, w: [], p: null, t: 0 }; WD.set(st, c); }
  for (let i = c.n; i < n; i++) {
    const r = st.samples[i];
    let p = r[3];
    if (st.pointer_type === 'mouse' && p > 0) p = 0.5;
    if (c.p == null) c.p = p;
    else { const a = 1 - Math.exp(-Math.max(0, r[0] - c.t) / 12); c.p += (p - c.p) * a; }
    c.t = r[0];
    c.w.push(Math.max(0.02, st.width_mm * fn(Math.pow(clamp(c.p, 0, 1), st.pressure_gamma || 1))));
  }
  c.n = n;
  return c.w;
}
// erased sample ranges -> mask
const EM = new WeakMap();
function erasedMask(st) {
  if (!st.erased || !st.erased.length) return null;
  let m = EM.get(st);
  if (m && m.src === st.erased && m.n === st.samples.length) return m.mask;
  const mask = new Uint8Array(st.samples.length);
  for (const [a, b] of st.erased) for (let i = a; i <= b && i < mask.length; i++) mask[i] = 1;
  EM.set(st, { src: st.erased, n: st.samples.length, mask });
  return mask;
}
// the drawable pieces of a stroke: a start dot and runs of points sharing one width
let minLineMm = 0; // raised only while rendering video, so hairlines stay visible
function strokeRuns(st, from = 0, to = st.samples.length, useMask = true) {
  const P = st.samples, n = Math.min(to, P.length), runs = [];
  let dot = null;
  if (!n) return { dot, runs };
  const eraser = st.tool === 'eraser';
  const W = eraser || st.brush === 'technical' ? null : widthsOf(st);
  const M = eraser || !useMask ? null : erasedMask(st);
  if (from === 0 && !(M && M[0])) dot = [P[0][1], P[0][2], Math.max(minLineMm, W ? W[0] : st.width_mm) / 2];
  const q = st.width_mm * 0.04;
  let run = null;
  for (let i = Math.max(1, from); i < n; i++) {
    if (M && (M[i] || M[i - 1])) { run = null; continue; }
    const w = Math.max(minLineMm, W ? Math.max(0.02, Math.round(((W[i - 1] + W[i]) / 2) / q) * q) : st.width_mm);
    if (!run || run.w !== w) { run = { w, pts: [[P[i - 1][1], P[i - 1][2]]] }; runs.push(run); }
    run.pts.push([P[i][1], P[i][2]]);
  }
  return { dot, runs };
}
function drawStroke(ctx, st, from = 0, to = undefined, useMask = true, color = null) {
  const { dot, runs } = strokeRuns(st, from, to ?? st.samples.length, useMask);
  ctx.strokeStyle = ctx.fillStyle = color || inkOf(st);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (dot) { ctx.beginPath(); ctx.arc(dot[0], dot[1], dot[2], 0, Math.PI * 2); ctx.fill(); }
  for (const r of runs) {
    ctx.beginPath(); ctx.lineWidth = r.w;
    ctx.moveTo(r.pts[0][0], r.pts[0][1]);
    for (let k = 1; k < r.pts.length; k++) ctx.lineTo(r.pts[k][0], r.pts[k][1]);
    ctx.stroke();
  }
}
const visibleInk = (st) => !st.undone_at && (st.tool !== 'eraser' || (S.active && S.active.st === st));

/* Vector eraser: an eraser stroke marks the samples of earlier strokes that it passes
 * over (st.erased = [[from, to, eraser_i], ...]). The ink data stays, marked as erased,
 * so undoing the eraser brings it back and the history of corrections is kept. */
function ptSeg(px, py, A, B) {
  const dx = B[1] - A[1], dy = B[2] - A[2], L = dx * dx + dy * dy;
  const t = L ? clamp(((px - A[1]) * dx + (py - A[2]) * dy) / L, 0, 1) : 0;
  return Math.hypot(px - (A[1] + t * dx), py - (A[2] + t * dy));
}
function segSeg(p, q, A, B) {
  const o = (a, b, c) => Math.sign((b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]));
  if (o(p, q, A) * o(p, q, B) < 0 && o(A, B, p) * o(A, B, q) < 0) return 0;
  return Math.min(ptSeg(p[1], p[2], A, B), ptSeg(q[1], q[2], A, B), ptSeg(A[1], A[2], [0, p[1], p[2]], [0, q[1], q[2]]), ptSeg(B[1], B[2], [0, p[1], p[2]], [0, q[1], q[2]]));
}
// the parts of earlier, visible strokes that one eraser stroke removes: Map(stroke -> ranges)
// Fast pens report a sample every ~0.02 mm, so this is built for dense data: eraser segments go
// into a fine grid (each cell lists every segment within reach of it), so a sample far from the
// eraser costs one lookup, and a whole-line eraser stops at a line's first touched sample.
function eraserHits(E, strokes, result = new Map()) {
  if (E.tool !== 'eraser' || E.undone_at || !E.samples.length) return result;
  const whole = eraseModeOf(E) === 'stroke';
  // reach: the eraser's half width plus the touched line's half width;
  // whole-line erasing gets at least 0.75 mm so thin lines are easy to hit
  const r0 = E.width_mm / 2, eb0 = bboxOf(E), eb = { x0: eb0.x0 - 2, y0: eb0.y0 - 2, x1: eb0.x1 + 2, y1: eb0.y1 + 2 };
  const cands = [];
  let maxW = 0;
  for (const T of strokes) {
    if (T.tool === 'eraser' || T.undone_at || T.t0 >= E.t0 || !T.samples.length) continue;
    const tb = bboxOf(T);
    if (tb.x1 < eb.x0 || tb.x0 > eb.x1 || tb.y1 < eb.y0 || tb.y0 > eb.y1) continue;
    cands.push(T); if (T.width_mm > maxW) maxW = T.width_mm;
  }
  if (!cands.length) return result;
  const R = Math.max(whole ? 0.75 : 0, r0 + maxW / 2) + 1e-6, cell = Math.max(0.25, R / 2);
  const oldCell = Math.max((r0 + 2) * 2, 0.5), maxCells = 400 * (oldCell / cell) ** 2; // same cut-off for very long jumps as before
  const grid = new Map(), key = (cx, cy) => cx * 1000003 + cy;
  const ES = E.samples, segs = ES.length === 1 ? [[ES[0], ES[0]]] : [];
  for (let i = 1; i < ES.length; i++) segs.push([ES[i - 1], ES[i]]);
  for (const sg of segs) {
    const [A, B] = sg;
    const x0 = Math.floor((Math.min(A[1], B[1]) - R) / cell), x1 = Math.floor((Math.max(A[1], B[1]) + R) / cell);
    const y0 = Math.floor((Math.min(A[2], B[2]) - R) / cell), y1 = Math.floor((Math.max(A[2], B[2]) + R) / cell);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const k = key(cx, cy), l = grid.get(k);
      if (!l) grid.set(k, [sg]); else if (l[l.length - 1] !== sg) l.push(sg);
    }
  }
  const near = (px, py, rr) => {
    const l = grid.get(key(Math.floor(px / cell), Math.floor(py / cell)));
    if (l) for (let j = 0; j < l.length; j++) if (ptSeg(px, py, l[j][0], l[j][1]) <= rr) return true;
    return false;
  };
  const seen = new Set();
  // the eraser segment nearest-crossing a line segment p-q within rr, if any (fast, sparse strokes)
  const crosses = (p, q, rr) => {
    const x0 = Math.floor(Math.min(p[1], q[1]) / cell), x1 = Math.floor(Math.max(p[1], q[1]) / cell);
    const y0 = Math.floor(Math.min(p[2], q[2]) / cell), y1 = Math.floor(Math.max(p[2], q[2]) / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > maxCells) return null;
    if (x0 === x1 && y0 === y1) {
      const l = grid.get(key(x0, y0));
      if (l) for (const sg of l) if (segSeg(p, q, sg[0], sg[1]) <= rr) return sg;
      return null;
    }
    seen.clear();
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const l = grid.get(key(cx, cy));
      if (l) for (const sg of l) {
        if (seen.has(sg)) continue;
        seen.add(sg);
        if (segSeg(p, q, sg[0], sg[1]) <= rr) return sg;
      }
    }
    return null;
  };
  for (const T of cands) {
    // a sample is erased if it lies under the eraser; a segment the eraser crosses
    // between two samples loses its endpoint nearest the eraser
    const TS = T.samples, rr = whole ? Math.max(0.75, r0 + T.width_mm / 2) : r0 + T.width_mm / 2;
    const hit = new Uint8Array(TS.length);
    let any = false;
    for (let idx = 0; idx < TS.length; idx++) {
      if (near(TS[idx][1], TS[idx][2], rr)) { hit[idx] = 1; any = true; if (whole) break; }
    }
    if (!(whole && any)) {
      for (let idx = 1; idx < TS.length; idx++) {
        if (hit[idx] || hit[idx - 1]) continue;
        const p = TS[idx - 1], q = TS[idx], sg = crosses(p, q, rr);
        if (!sg) continue;
        hit[ptSeg(p[1], p[2], sg[0], sg[1]) <= ptSeg(q[1], q[2], sg[0], sg[1]) ? idx - 1 : idx] = 1;
        any = true;
        if (whole) break;
      }
    }
    if (!any) continue;
    if (!result.has(T)) result.set(T, []);
    const ranges = result.get(T);
    if (whole) { ranges.push([0, TS.length - 1, E.i]); continue; }
    for (let k = 0; k < TS.length; k++) {
      if (!hit[k]) continue;
      let e = k; while (e + 1 < TS.length && hit[e + 1]) e++;
      ranges.push([k, e, E.i]); k = e;
    }
  }
  return result;
}
// full recomputation from every eraser (opening old drawings, merging another device's copy);
// strokes that are undone keep their ranges, so a redo shows them as they were
function computeErasure(strokes) {
  const result = new Map();
  for (const E of strokes) eraserHits(E, strokes, result);
  return applyErasure(strokes, result);
}
// the same, a few erasers at a time so the page stays responsive
async function computeErasureAsync(strokes, onProgress) {
  const result = new Map(), erasers = strokes.filter((E) => E.tool === 'eraser');
  let end = performance.now() + 12;
  for (let k = 0; k < erasers.length; k++) {
    eraserHits(erasers[k], strokes, result);
    if (performance.now() > end) { if (onProgress) onProgress(k / erasers.length); await yieldNow(); end = performance.now() + 12; }
  }
  return applyErasure(strokes, result);
}
function applyErasure(strokes, result) {
  const changed = [];
  for (const T of strokes) {
    if (T.tool === 'eraser' || T.undone_at) continue;
    const nr = result.get(T) || null;
    const was = T.erased && T.erased.length ? JSON.stringify(T.erased) : null;
    const now = nr ? JSON.stringify(nr) : null;
    if (was !== now) { T.erased = nr; changed.push(T); }
  }
  return changed;
}
// incremental erasing: only the eraser that just finished, was undone or redone is evaluated
function addErasure(E) {
  const changed = [];
  for (const [T, ranges] of eraserHits(E, S.strokes)) {
    T.erased = (T.erased || []).filter((g) => g[2] !== E.i).concat(ranges);
    changed.push(T);
  }
  return changed;
}
function removeErasure(E) {
  const changed = [];
  for (const T of S.strokes) {
    if (!T.erased || !T.erased.some((g) => g[2] === E.i)) continue;
    const keep = T.erased.filter((g) => g[2] !== E.i);
    T.erased = keep.length ? keep : null;
    changed.push(T);
  }
  return changed;
}
// after an eraser change: save the touched strokes and redraw only where they are
function eraserChanged(E, changed) {
  for (const st of changed) saveStroke(st);
  repaintRegion([E, ...changed].map(bboxOf).reduce(unionBox));
}
function paintAll(ctx, strokes, b, K, bg = '#ffffff') {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); }
  else ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(K, 0, 0, K, -b.x0 * K, -b.y0 * K);
  for (const st of strokes) if (visibleInk(st)) drawStroke(ctx, st);
}
/* Full repaint of the page bitmap. Big drawings take a while, so it runs in slices
 * of about 12 ms and the app stays responsive (the drawing appears in order). Live
 * ink and region repaints during a slow repaint are fine: finished ink is all black. */
let paintGen = 0, painting = false;
const yieldNow = () => new Promise((r) => setTimeout(r, 0));
// resolves when the page is fully painted (or a newer repaint took over)
function repaint(onProgress) {
  const gen = ++paintGen, p = S.paper, { x, K, b } = p, list = S.strokes.slice();
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, x.canvas.width, x.canvas.height);
  x.setTransform(K, 0, 0, K, -b.x0 * K, -b.y0 * K);
  painting = true;
  let i = 0;
  return new Promise((done) => {
    const slice = () => {
      if (gen !== paintGen || S.paper !== p) { done(false); return; }
      const end = performance.now() + (S.loading ? 30 : 12); // nothing to respond to behind the loading screen
      x.setTransform(K, 0, 0, K, -b.x0 * K, -b.y0 * K);
      while (i < list.length && performance.now() < end) { const st = list[i++]; if (visibleInk(st)) drawStroke(x, st); }
      if (onProgress) onProgress(list.length ? i / list.length : 1);
      if (i < list.length) setTimeout(slice, 0); else { painting = false; done(true); }
      invalidateSharp();
      if (!S.loading) requestRender(); // behind the loading screen the view is shown once, at the end
    };
    slice();
  });
}
const unionBox = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const boxesMeet = (a, b) => !(a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1);
function strokesIn(r) { return S.strokes.filter((st) => st.samples.length && visibleInk(st) && boxesMeet(bboxOf(st), r)); }
// redraw one area (doc mm box) of the page bitmap and the sharp layer, e.g. after undo or erasing
function repaintRegion(r) {
  const { x, K, b, c } = S.paper;
  const X0 = clamp(Math.floor((r.x0 - b.x0) * K) - 1, 0, c.width), X1 = clamp(Math.ceil((r.x1 - b.x0) * K) + 1, 0, c.width);
  const Y0 = clamp(Math.floor((r.y0 - b.y0) * K) - 1, 0, c.height), Y1 = clamp(Math.ceil((r.y1 - b.y0) * K) + 1, 0, c.height);
  if (X1 > X0 && Y1 > Y0) {
    x.save();
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.beginPath(); x.rect(X0, Y0, X1 - X0, Y1 - Y0); x.clip();
    x.fillStyle = '#ffffff'; x.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
    x.setTransform(K, 0, 0, K, -b.x0 * K, -b.y0 * K);
    for (const st of strokesIn({ x0: b.x0 + X0 / K, y0: b.y0 + Y0 / K, x1: b.x0 + X1 / K, y1: b.y0 + Y1 / K })) drawStroke(x, st);
    x.restore();
  }
  if (sharpKey === viewKey()) {
    if (!vectorView()) renderSharp();
    else {
      const v = S.view, k = S.ppmm * v.s, co = Math.cos(v.r), si = Math.sin(v.r);
      const pts = [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]].map(([X, Y]) => [(co * X * k - si * Y * k + v.tx) * dpr, (si * X * k + co * Y * k + v.ty) * dpr]);
      const SX0 = clamp(Math.floor(Math.min(...pts.map((q) => q[0]))) - 1, 0, sharp.width), SX1 = clamp(Math.ceil(Math.max(...pts.map((q) => q[0]))) + 1, 0, sharp.width);
      const SY0 = clamp(Math.floor(Math.min(...pts.map((q) => q[1]))) - 1, 0, sharp.height), SY1 = clamp(Math.ceil(Math.max(...pts.map((q) => q[1]))) + 1, 0, sharp.height);
      if (SX1 > SX0 && SY1 > SY0) {
        const dc = [[SX0, SY0], [SX1, SY0], [SX0, SY1], [SX1, SY1]].map(([a, bb]) => screenToDoc(a / dpr, bb / dpr));
        const rr = { x0: Math.min(...dc.map((q) => q[0])), x1: Math.max(...dc.map((q) => q[0])), y0: Math.min(...dc.map((q) => q[1])), y1: Math.max(...dc.map((q) => q[1])) };
        sctx.save();
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.beginPath(); sctx.rect(SX0, SY0, SX1 - SX0, SY1 - SY0); sctx.clip();
        sctx.fillStyle = S.endless ? '#ffffff' : surround; sctx.fillRect(SX0, SY0, SX1 - SX0, SY1 - SY0);
        applyView(sctx);
        if (!S.endless) { const pb = S.paper.b; sctx.fillStyle = '#ffffff'; sctx.fillRect(pb.x0, pb.y0, pb.w, pb.h); }
        clipPaper(sctx);
        for (const st of strokesIn(rr)) drawStroke(sctx, st);
        sctx.restore();
      }
    }
  }
  requestRender();
}

/* ---------------------------------------------------------------- capture */
function sampleOf(e, t0) {
  const [x, y] = screenToDoc(e.clientX, e.clientY);
  return [
    rnd(absTime(e) - t0, 3), rnd(x, 4), rnd(y, 4),
    rnd(e.pressure, 4), rnd(e.tiltX || 0, 2), rnd(e.tiltY || 0, 2), rnd(e.twist || 0, 2),
    e.altitudeAngle != null ? rnd(e.altitudeAngle, 4) : null,
    e.azimuthAngle != null ? rnd(e.azimuthAngle, 4) : null,
    rnd(e.tangentialPressure || 0, 4), rnd(e.width || 0, 2), rnd(e.height || 0, 2), e.buttons,
  ];
}
function coalesced(e) {
  const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
  return list && list.length ? list : [e];
}
function trimHover() {
  if (S.hover.length > HOVER_LIMIT * 1.1) {
    const drop = S.hover.length - HOVER_LIMIT;
    S.hover.splice(0, drop);
    S.hoverDropped += drop;
  }
}
function takeHover(t0) {
  const h = S.hover.map((r) => { const c = r.slice(); c[0] = rnd(r[0] - t0, 3); return c; });
  const dropped = S.hoverDropped;
  S.hover = []; S.hoverDropped = 0;
  return { h, dropped };
}
function ensureSession() {
  if (S.sessionLogged) return;
  S.sessionLogged = true;
  S.meta.sessions.push({
    id: S.sessionId,
    started: new Date().toISOString(),
    app_version: APP_VERSION,
    device: { id: S.device.id, name: S.device.name, ppmm: S.device.ppmm, calibrated: !!S.device.calibrated, pressure_setting: S.device.pressure_setting || '' },
    screen: { width: screen.width, height: screen.height, dpr: window.devicePixelRatio || 1 },
    user_agent: navigator.userAgent,
  });
}

const touches = new Map();
let gesture = null, mousePan = null, spaceDown = false;

function onDown(e) {
  if (!S.meta || S.loading || document.querySelector('dialog[open]')) return;
  hideNibs();
  if (e.pointerType === 'pen' && e.button === 2) { e.preventDefault(); penButton(); return; }
  if (Replay.on && e.pointerType !== 'touch') {
    if (Replay.lab && e.button === 0 && !spaceDown) { Replay.loopStart(e); view.setPointerCapture(e.pointerId); return; }
    mousePan = { x: e.clientX, y: e.clientY, v: { ...S.view } };
    view.setPointerCapture(e.pointerId);
    return;
  }
  if (e.pointerType === 'touch') {
    if (!S.touchNav || S.active || performance.now() - S.lastPen < PALM_MS) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { view.setPointerCapture(e.pointerId); } catch {}
    startGesture();
    return;
  }
  if (e.pointerType === 'mouse' && (e.button === 1 || spaceDown)) {
    mousePan = { x: e.clientX, y: e.clientY, v: { ...S.view } };
    view.setPointerCapture(e.pointerId);
    return;
  }
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (S.active) return;
  touches.clear(); gesture = null;
  ensureSession();
  const eraserEnd = (e.buttons & 32) !== 0 || e.button === 5;
  syncClock();
  if (awayAt != null) awayEnd();
  const t0 = rnd(absTime(e), 3);
  const { h, dropped } = takeHover(t0);
  const st = {
    drawing: S.meta.id,
    i: S.strokes.length,
    session: S.sessionId,
    t0,
    tool: eraserEnd ? 'eraser' : S.tool,
    eraser_end: eraserEnd,
    width_mm: S.width,
    brush: eraserEnd || S.tool === 'eraser' ? null : S.brush,
    erase_mode: eraserEnd || S.tool === 'eraser' ? S.eraseMode : undefined,
    smoothing: eraserEnd || S.tool === 'eraser' ? 0 : S.smoothing,
    smoothing_tau_ms: eraserEnd || S.tool === 'eraser' ? 0 : tauFor(S.smoothing),
    pressure_gamma: rnd(S.device.pressure_gamma || 1, 4),
    prompt: S.prompt ? S.prompt.id : null,
    parts: S.partStack.slice(),
    tags: S.fill ? ['fill'] : [],
    pointer_type: e.pointerType,
    view: [rnd(S.view.s, 6), rnd(S.view.r, 6), rnd(S.view.tx, 2), rnd(S.view.ty, 2)],
    ppmm: rnd(S.ppmm, 5),
    hover: h,
    hover_dropped: dropped,
    samples: [],
    undone_at: null,
    cancelled: false,
  };
  const r0 = sampleOf(e, t0), sm = {};
  if (st.smoothing_tau_ms > 0) st.raw = [r0];
  st.samples.push(smoothStep(sm, r0, st.smoothing_tau_ms));
  S.active = { st, id: e.pointerId, sm };
  S.strokes.push(st);
  S.redo.length = 0;
  view.setPointerCapture(e.pointerId);
  inkLive(st);
  requestRender();
  S.lastPen = performance.now();
  Diag.down(e);
  updateTools();
}

function onMove(e) {
  if (e.pointerType === 'touch') {
    if (touches.has(e.pointerId)) { touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); moveGesture(); }
    return;
  }
  if (Replay.drawingLoop && e.pointerId === Replay.loopId) { Replay.loopMove(e); return; }
  if (mousePan) {
    S.view.tx = mousePan.v.tx + e.clientX - mousePan.x;
    S.view.ty = mousePan.v.ty + e.clientY - mousePan.y;
    requestRender();
    return;
  }
  const list = coalesced(e);
  if (S.active && e.pointerId === S.active.id) {
    const st = S.active.st, from = st.samples.length, tau = st.smoothing_tau_ms;
    for (const ce of list) {
      const r = sampleOf(ce, st.t0);
      if (st.raw) st.raw.push(r);
      st.samples.push(smoothStep(S.active.sm, r, tau));
    }
    inkLive(st, from);
    requestRender();
    S.lastPen = performance.now();
    Diag.move(e, list.length);
    return;
  }
  if (e.pointerType === 'pen' && !(e.buttons & 1) && S.meta && !Replay.on) {
    const side = (e.buttons & 2) !== 0;
    if (side && !S.sideDown) penButton();
    S.sideDown = side;
    for (const ce of list) S.hover.push(sampleOf(ce, 0));
    trimHover();
    S.lastPen = performance.now();
    Diag.hover(e, list.length);
  }
}

function onUp(e) {
  if (e.pointerType === 'touch') { endTouch(e); return; }
  if (Replay.drawingLoop && e.pointerId === Replay.loopId) { Replay.loopEnd(); return; }
  if (mousePan) { mousePan = null; persistViewSoon(); return; }
  if (S.active && e.pointerId === S.active.id) finish(e, false);
}
function onCancel(e) {
  if (e.pointerType === 'touch') { endTouch(e); return; }
  if (Replay.drawingLoop && e.pointerId === Replay.loopId) { Replay.drawingLoop = null; requestRender(); return; }
  if (mousePan) { mousePan = null; return; }
  if (S.active && e.pointerId === S.active.id) finish(e, true);
}
function finish(e, cancelled) {
  const st = S.active.st;
  const from = st.samples.length;
  if (cancelled) st.cancelled = true;
  else {
    const r = sampleOf(e, st.t0); // pen-up event (pressure 0), drawn at the pen's real end point
    if (st.raw) st.raw.push(r);
    st.samples.push(r.slice());
  }
  S.active = null;
  if (st.tool === 'eraser') eraserChanged(st, addErasure(st));
  else { inkLive(st, from); maybeExtend(); }
  S.lastPen = performance.now();
  saveStroke(st);
  markChanged();
  Diag.end(st);
  requestRender();
}
function saveStroke(st) {
  DB.put('strokes', st).catch((err) => { toast('Could not save a stroke: ' + err.message); setSaveState('Save failed', true); });
}
// many strokes at once (opening older drawings): a few at a time, since each one is copied on this thread
async function saveStrokes(list) {
  for (let i = 0; i < list.length;) {
    const end = performance.now() + 12, from = i;
    await DB.write('strokes', (tx) => { const os = tx.objectStore('strokes'); while (i < list.length && (i === from || performance.now() < end)) os.put(list[i++]); })
      .catch((err) => { toast('Could not save a stroke: ' + err.message); setSaveState('Save failed', true); });
  }
}
function logEvent(type, extra = {}) {
  if (!S.meta) return;
  DB.add('events', { drawing: S.meta.id, t: rnd(absNow(), 3), session: S.sessionId, type, ...extra }).catch(() => {});
}

/* --------------------------------------------------------- touch gestures */
function startGesture() {
  const pts = [...touches.values()];
  const v = { ...S.view };
  if (pts.length === 1) gesture = { n: 1, p0: pts[0], v };
  else if (pts.length >= 2) {
    const [a, b] = pts, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    gesture = { n: 2, v, d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, a0: Math.atan2(b.y - a.y, b.x - a.x), D: screenToDoc(mx, my, v) };
  }
}
function moveGesture() {
  if (!gesture) return;
  const pts = [...touches.values()];
  if (gesture.n === 1 && pts.length >= 1) {
    S.view.tx = gesture.v.tx + pts[0].x - gesture.p0.x;
    S.view.ty = gesture.v.ty + pts[0].y - gesture.p0.y;
  } else if (gesture.n === 2 && pts.length >= 2) {
    const [a, b] = pts, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const d = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
    const s = clamp(gesture.v.s * d / gesture.d0, 0.03, 60);
    setViewAround(gesture.D, mx, my, s, snapRot(gesture.v.r + ang - gesture.a0));
  }
  requestRender();
}
function endTouch(e) {
  touches.delete(e.pointerId);
  if (touches.size) startGesture(); else { gesture = null; persistViewSoon(); }
}

/* ------------------------------------------------------------ actions */
function undo() {
  if (S.active || Replay.on) return;
  for (let i = S.strokes.length - 1; i >= 0; i--) {
    const st = S.strokes[i];
    if (!st.undone_at) {
      st.undone_at = rnd(absNow(), 3);
      S.redo.push(i);
      saveStroke(st); logEvent('undo', { stroke: i });
      if (st.tool === 'eraser') eraserChanged(st, removeErasure(st));
      else repaintRegion(bboxOf(st));
      markChanged(); updateTools();
      return;
    }
  }
}
function redo() {
  if (S.active || Replay.on || !S.redo.length) return;
  const i = S.redo.pop(), st = S.strokes[i];
  st.undone_at = null;
  saveStroke(st); logEvent('redo', { stroke: i });
  if (st.tool === 'eraser') eraserChanged(st, addErasure(st));
  else repaintRegion(bboxOf(st));
  markChanged(); updateTools();
}
function setNib(w) { S.width = w; localStorage.setItem('nh-nib', String(w)); updateTools(); }
function setEraseMode(m) { S.eraseMode = m === 'cut' ? 'cut' : 'stroke'; localStorage.setItem('nh-erase-mode', S.eraseMode); updateTools(); }
function setBrush(b) { if (BRUSHES[b]) { S.brush = b; localStorage.setItem('nh-brush', b); if (S.tool === 'eraser') { S.tool = 'pen'; buildNibs(); } updateTools(); } }
function setSmoothing(v) { S.smoothing = clamp(Math.round(v), 0, 100); localStorage.setItem('nh-smooth', String(S.smoothing)); updateTools(); }
function toggleEraser() { S.tool = S.tool === 'eraser' ? 'pen' : 'eraser'; buildNibs(); updateTools(); }
/* ------------------------------------------------------------ parts
 * A part is a group of strokes that make one thing: a figure, a head, a structure, a shell.
 * Its kind is a word from your own list, and parts can sit inside parts. Each stroke lists
 * the ids of every part it belongs to (st.parts); meta.parts holds each part's kind, parent
 * and origin. Parts are started and ended while drawing, or labelled afterwards in replay.
 * Nothing is deleted: a removed part is marked with removed_at. */
const DEFAULT_KINDS = ['Figure', 'Head', 'Crowd', 'Mass', 'Shell', 'Ribbed form'];
const escHtml = (t) => String(t).replace(/[<&>"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' }[c]));
function loadKinds() {
  try { const k = JSON.parse(localStorage.getItem('nh-kinds')); if (Array.isArray(k) && k.length) return k; } catch {}
  return DEFAULT_KINDS.slice();
}
function saveKinds(k) { localStorage.setItem('nh-kinds', JSON.stringify(k)); }
// your list on this device, plus kinds already used in this drawing
function kindsList() {
  const out = loadKinds();
  for (const p of Object.values((S.meta && S.meta.parts) || {})) if (!p.removed_at && !out.includes(p.kind)) out.push(p.kind);
  return out;
}
const newPartId = () => 'p' + Date.now().toString(36).slice(-5) + uid();
function livePart(id) { const p = S.meta && S.meta.parts && S.meta.parts[id]; return p && !p.removed_at ? p : null; }
function partsOf(st) { return (st.parts || []).filter((id) => livePart(id)); }
function partMembers() {
  const m = new Map();
  for (const st of S.strokes) for (const id of partsOf(st)) { if (!m.has(id)) m.set(id, new Set()); m.get(id).add(st); }
  return m;
}
function openPart() { return S.partStack.length ? S.meta.parts[S.partStack[S.partStack.length - 1]] : null; }
function startPart(kind, source = 'button') {
  if (!S.meta || !kind) return;
  S.meta.parts = S.meta.parts || {};
  const parent = S.partStack.length ? S.partStack[S.partStack.length - 1] : null;
  const id = newPartId();
  S.meta.parts[id] = { kind, parent, source: 'live', session: S.sessionId, created: rnd(absNow(), 3) };
  S.partStack.push(id);
  S.kind = kind; localStorage.setItem('nh-kind', kind);
  logEvent('part_start', { part: id, kind, parent, source });
  toast(parent ? `${kind} started, inside ${S.meta.parts[parent].kind}` : `${kind} started`);
  markChanged(); updateTools();
}
function endPart(source = 'button') {
  const id = S.partStack.pop();
  if (!id) return;
  const p = S.meta.parts[id];
  logEvent('part_end', { part: id, kind: p.kind, source });
  // a part ended without any strokes in it is dropped (its start and end stay in the event log)
  const empty = !S.strokes.some((st) => (st.parts || []).includes(id));
  if (empty) delete S.meta.parts[id];
  toast(empty ? `${p.kind} ended with nothing drawn, so it was not kept` : `${p.kind} done`);
  markChanged(); updateTools();
}
function togglePart(source = 'button') { if (!S.meta) return; if (S.partStack.length) endPart(source); else startPart(S.kind, source); }
// figures from before parts existed (st.figure = number) become parts 'fig-N' of kind Figure; safe to run again
function migrateFigures(meta, strokes) {
  const changed = [];
  meta.parts = meta.parts || {};
  for (const st of strokes) {
    if (typeof st.figure !== 'number') continue;
    const id = `fig-${st.figure}`;
    if (!meta.parts[id]) meta.parts[id] = { kind: 'Figure', parent: null, source: 'figure', session: st.session, created: st.t0 };
    if (!(st.parts || []).includes(id)) { st.parts = [...(st.parts || []), id]; changed.push(st); }
  }
  return changed;
}
// the pen's side button (S Pen) or lower barrel button (Wacom) starts and ends a part
let lastPenButton = 0;
function penButton() {
  if (!S.penButtonFigure || Replay.on) return;
  const t = performance.now();
  if (t - lastPenButton < 400) return;
  lastPenButton = t;
  togglePart('pen_button');
  if (navigator.vibrate) navigator.vibrate(S.partStack.length ? 25 : [15, 60, 15]);
}
function toggleFill() {
  S.fill = !S.fill;
  logEvent(S.fill ? 'fill_start' : 'fill_end');
  updateTools();
}

/* ------------------------------------------------------------ drawings */
let metaTimer = null;
function markChanged() {
  if (!S.meta) return;
  S.meta.rev = (S.meta.rev || 0) + 1;
  S.meta.stroke_count = S.strokes.length;
  setSaveState('Saving…');
  scheduleMetaSave();
}
function persistViewSoon() { if (S.meta) { S.meta.view = { ...S.view }; scheduleMetaSave(); } }
function scheduleMetaSave() { clearTimeout(metaTimer); metaTimer = setTimeout(flushMeta, 900); }
function makeThumb() {
  const pc = S.paper.c, k = 120 / Math.max(pc.width, pc.height);
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(pc.width * k)); c.height = Math.max(1, Math.round(pc.height * k));
  c.getContext('2d').drawImage(pc, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}
async function flushMeta() {
  clearTimeout(metaTimer);
  if (!S.meta) return;
  S.meta.updated = new Date().toISOString();
  if (!painting && !S.loading) try { S.meta.thumb = makeThumb(); } catch {}
  try { await DB.put('drawings', S.meta); setSaveState('Saved'); }
  catch (err) { setSaveState('Save failed', true); toast('Could not save drawing: ' + err.message); }
  updateDriveChip();
}
function newId() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}_${uid().slice(0, 4)}`;
}
async function newDrawing(paperName, landscape, title) {
  let paper;
  if (paperName === 'Endless') paper = { name: 'Endless', endless: true, x0: -200, y0: -200, w_mm: 400, h_mm: 400 };
  else {
    const [a, b] = PAPERS[paperName] || PAPERS.A4;
    const [W, H] = landscape ? [b, a] : [a, b];
    paper = { name: paperName, w_mm: W, h_mm: H };
  }
  const now = new Date().toISOString();
  const meta = {
    id: newId(), format: FORMAT, title: title || '', created: now, updated: now,
    paper,
    tags: [], notes: '', sessions: [], figure_count: 0, stroke_count: 0,
    rev: 0, synced_rev: 0, drive: {}, view: null, erasure: 1, parts: {},
  };
  await DB.put('drawings', meta);
  await openDrawing(meta.id);
}
/* Loading screen. It is in the page from the first paint, so it shows while the app starts;
 * when switching drawings it appears only if opening takes more than a moment. */
const Loader = {
  timer: 0,
  show(title, thumb, quick) {
    const el = $('#loader');
    clearTimeout(this.timer);
    if (el.hidden) { el.hidden = false; el.classList.add('wait'); }
    if (quick || !el.classList.contains('wait')) el.classList.remove('wait');
    else this.timer = setTimeout(() => el.classList.remove('wait'), 150);
    $('#ld-title').textContent = title || 'Opening your drawing';
    const im = $('#ld-thumb');
    if (thumb) { im.src = thumb; im.hidden = false; } else { im.hidden = true; im.removeAttribute('src'); }
    $('#ld-acts').hidden = true; $('#ld-bar').hidden = false;
    this.set(0, 'Starting');
  },
  set(f, text) {
    const pc = Math.round(clamp(f, 0, 1) * 100);
    $('#ld-fill').style.width = pc + '%';
    $('#ld-bar').setAttribute('aria-valuenow', String(pc));
    if (text != null) $('#ld-step').textContent = text;
  },
  fail(msg) {
    clearTimeout(this.timer);
    const el = $('#loader');
    el.hidden = false; el.classList.remove('wait');
    $('#ld-bar').hidden = true; $('#ld-step').textContent = msg; $('#ld-acts').hidden = false;
  },
  hide() { clearTimeout(this.timer); $('#loader').hidden = true; },
};
const count = (n) => n.toLocaleString('en');
let loadGen = 0;
async function openDrawing(id) {
  const gen = ++loadGen;
  if (Replay.on) Replay.close();
  if (S.prompt && (!S.meta || S.meta.id !== id)) endPrompt(false);
  S.loading = true;
  Loader.show('Opening your drawing', null, !S.meta);
  let ok = false;
  try {
    if (S.meta) await flushMeta();
    const meta = await DB.get('drawings', id);
    if (!meta) { toast('That drawing is no longer on this device.'); ok = !!S.meta; return; }
    if (gen !== loadGen) return;
    const total = meta.stroke_count || 0;
    Loader.show(meta.title || 'Opening your drawing', meta.thumb, !S.meta);
    // 1. read the lines from storage (about half of the time on big drawings)
    const strokes = await DB.strokes(id, (part, n) => {
      for (const st of part) { normalizeStroke(st); bboxOf(st); }
      Loader.set(0.5 * (total ? Math.min(1, n / total) : 1), `Reading lines: ${count(n)} of ${count(Math.max(n, total))}`);
    });
    if (gen !== loadGen) return;
    strokes.sort((a, b) => a.i - b.i);
    Object.assign(S, {
      meta, strokes, redo: [], partStack: [], fill: false, hover: [], hoverDropped: 0, active: null,
      endless: !!meta.paper.endless, sessionId: `${Date.now().toString(36)}-${uid()}`, sessionLogged: false,
    });
    const migrated = migrateFigures(meta, strokes);
    if (migrated.length) { Loader.set(0.5, 'Converting figures to parts (first time only)'); await saveStrokes(migrated); scheduleMetaSave(); }
    if (gen !== loadGen) return;
    S.paper = makePaper(boundsOfMeta(meta, strokes));
    // 2. erased parts are stored with each stroke; drawings from before the vector eraser get them computed once
    let p0 = 0.5;
    if (meta.erasure !== 1) {
      Loader.set(0.5, 'Working out erased lines (first time only)');
      const changed = await computeErasureAsync(strokes, (f) => Loader.set(0.5 + 0.15 * f));
      if (gen !== loadGen) return;
      await saveStrokes(changed);
      meta.erasure = 1; scheduleMetaSave(); p0 = 0.65;
    }
    localStorage.setItem('nh-last', id);
    if (meta.view) S.view = { ...meta.view }; else fit();
    updateTools(); setSaveState('Saved'); updateDriveChip();
    // 3. paint the page
    Loader.set(p0, 'Drawing the page');
    await repaint((f) => Loader.set(p0 + (1 - p0) * f, `Drawing the page: ${Math.round(f * 100)}%`));
    ok = true;
  } catch (err) {
    if (gen === loadGen) {
      S.loading = false;
      Loader.fail(`Could not open this drawing: ${err && err.message || err}. Nothing was deleted.`);
    }
    return;
  } finally {
    if (gen === loadGen && ok) { S.loading = false; Loader.hide(); invalidateSharp(); requestRender(); }
  }
  // check Drive for changes from other devices once the drawing is on screen
  if (gen === loadGen && Drive.ready() && navigator.onLine) pullCurrent();
}
async function pullCurrent() {
  if (syncing || !S.meta || S.loading) return;
  syncing = true; updateDriveChip();
  try { await syncOne(S.meta.id); lastSync = new Date(); syncError = null; }
  catch (err) { syncError = err.message; }
  finally { syncing = false; updateDriveChip(); }
}
function defaultPaper() { return Math.min(screen.width, screen.height) < 600 ? 'A5' : 'A4'; }

async function buildExport(id) {
  const cur = S.meta && S.meta.id === id;
  const meta = cur ? S.meta : await DB.get('drawings', id);
  let strokes = cur ? S.strokes.filter((s) => !S.active || s !== S.active.st) : (await DB.strokes(id)).sort((a, b) => a.i - b.i);
  const events = await DB.events(id);
  const { thumb, drive, rev, synced_rev, synced_at, view: _v, erasure: _e, ...m } = meta;
  return {
    ...m,
    format: FORMAT,
    exported: new Date().toISOString(),
    exported_by: `natural-hand ${APP_VERSION}`,
    sample_fields: SAMPLE_FIELDS,
    units: {
      coordinates: 'x_mm, y_mm in paper millimetres, origin at top-left of the sheet (on endless pages coordinates can be negative)',
      pressure_gamma: 'pressure feel of the device when drawn: width uses pressure ** pressure_gamma; recorded pressure is unchanged',
      prompt: 'id of the session prompt the stroke was drawn under (see prompts), or null',
      time: 't0 and event times are wall-clock epoch ms, corrected for time the device slept; away_start / away_end events mark when the app was hidden (away_ms = length)',
      t0: 'stroke start, epoch milliseconds (high resolution)',
      dt_ms: 'milliseconds since the stroke t0; negative in hover (pen in the air before the stroke)',
      last_sample: 'the final sample of a stroke is the pen-up event (pressure 0) unless the stroke was cancelled',
      angles: 'tiltX, tiltY, twist in degrees; altitude, azimuth in radians; null when the browser does not report them',
      view: '[zoom, rotation_rad, tx_px, ty_px]; screen_css_px = R(rotation) * (doc_mm * ppmm * zoom) + (tx, ty)',
      samples: 'the drawn path: positions smoothed with an exponential filter (time constant smoothing_tau_ms); all other columns as reported by the device',
      raw: 'present when smoothing_tau_ms > 0: the unsmoothed device samples, same columns; absent means samples are raw',
      brush: 'technical (constant width), ink (width from pressure, mild), brush (width from pressure, strong); width_mm is the nominal width',
      parts: 'on strokes: ids of every part (figure, head, structure...) the stroke belongs to. In the drawing, parts = {id: {kind, parent, source, session, created, removed_at?}}: kind is the artist\'s word for the thing, parent the part it sits inside, source "live" (marked while drawing), "replay" (labelled afterwards) or "figure" (a figure from before parts existed). Parts with removed_at were taken back and should be ignored',
      figure: 'older strokes only: the figure number from before parts existed; the same strokes are in part "fig-N"',
      erased: '[[first_sample, last_sample, eraser_stroke_i], ...] parts of this stroke removed by later eraser strokes; the final drawing omits them',
      erase_mode: 'on eraser strokes: "stroke" deletes every line it touches (the whole range is marked), "cut" removes only the parts it passes over; the eraser is as wide as the pen',
      ppmm: 'CSS pixels per physical millimetre on this device at zoom 1 (from calibration)',
    },
    strokes: strokes.map(({ drawing, ...s }) => s),
    events: events.map(({ drawing, ...e }) => e),
  };
}
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
// the export as JSON text pieces, built a few strokes at a time so big drawings do not freeze the app
async function exportParts(id) {
  const { strokes, events, ...head } = await buildExport(id);
  const parts = [JSON.stringify(head).slice(0, -1), ',"strokes":['];
  let end = performance.now() + 10;
  for (let i = 0; i < strokes.length; i++) {
    parts.push((i ? ',' : '') + JSON.stringify(strokes[i]));
    if (performance.now() > end) { await yieldNow(); end = performance.now() + 10; }
  }
  parts.push('],"events":', JSON.stringify(events), '}');
  return parts;
}
async function exportJson(id) {
  download(`${id}.json`, new Blob(await exportParts(id), { type: 'application/json' }));
}
async function previewPng(id) {
  const cur = S.meta && S.meta.id === id;
  if (cur && !painting) { // the page bitmap already holds the drawing: scale it instead of redrawing every stroke
    const p = S.paper, b = imageBounds(S.meta, S.strokes), K = Math.min(6, 2400 / Math.max(b.w, b.h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(b.w * K)); c.height = Math.max(1, Math.round(b.h * K));
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(p.c, (b.x0 - p.b.x0) * p.K, (b.y0 - p.b.y0) * p.K, b.w * p.K, b.h * p.K, 0, 0, c.width, c.height);
    return canvasBlob(c, 'image/png');
  }
  const meta = cur ? S.meta : await DB.get('drawings', id);
  const strokes = cur ? S.strokes : (await DB.strokes(id)).sort((a, b) => a.i - b.i).map(normalizeStroke);
  const b = imageBounds(meta, strokes), K = Math.min(6, 2400 / Math.max(b.w, b.h));
  return canvasBlob(renderImage(strokes, b, K, '#ffffff'), 'image/png');
}
/* Compression and parsing of whole drawings run in a small background worker: in Chrome
 * CompressionStream works on the calling thread, and big drawings would freeze the page.
 * If a worker cannot start, the same work runs here instead. */
const WORKER_SRC = `onmessage = async (e) => {
  const { id, op, data } = e.data;
  try {
    if (op === 'gzip') {
      const buf = await new Response(data.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
      postMessage({ id, result: buf }, [buf]);
    } else {
      const b = new Uint8Array(data), gz = b[0] === 0x1f && b[1] === 0x8b;
      const text = gz ? await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).text() : new TextDecoder().decode(data);
      const obj = JSON.parse(text), list = obj && Array.isArray(obj.strokes) ? obj.strokes : null;
      if (list) {
        obj.strokes = []; // keeps its place among the keys; filled in from the pieces
        for (let i = 0; i < list.length;) {
          let j = i, n = 0;
          while (j < list.length && n < 20000) { const s = list[j++] || {}; n += 1 + (s.samples ? s.samples.length : 0) + (s.raw ? s.raw.length : 0) + (s.hover ? s.hover.length : 0); }
          postMessage({ id, chunk: list.slice(i, j) });
          i = j;
        }
      }
      postMessage({ id, result: obj, chunked: !!list });
    }
  } catch (err) { postMessage({ id, error: String(err && err.message || err) }); }
};`;
let bgWorker, bgSeq = 0;
function inWorker(op, data) {
  if (bgWorker === undefined) {
    try { bgWorker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }))); }
    catch { bgWorker = null; }
  }
  if (!bgWorker) return Promise.reject(new Error('no worker'));
  return new Promise((res, rej) => {
    const id = ++bgSeq, w = bgWorker, chunks = [];
    const done = () => { w.removeEventListener('message', on); w.removeEventListener('error', bad); };
    const on = (e) => {
      if (e.data.id !== id) return;
      if (e.data.chunk) { for (const s of e.data.chunk) chunks.push(s); return; } // each piece arrives as its own task
      done();
      if (e.data.error) { const er = new Error(e.data.error); er.bad = true; rej(er); return; }
      if (e.data.chunked) e.data.result.strokes = chunks;
      res(e.data.result);
    };
    const bad = (e) => { done(); bgWorker = null; rej(new Error(e.message || 'worker failed')); };
    w.addEventListener('message', on); w.addEventListener('error', bad);
    w.postMessage({ id, op, data });
  });
}
async function gzip(parts) {
  const list = Array.isArray(parts) ? parts : [parts], blobs = [];
  let end = performance.now() + 10;
  for (let i = 0; i < list.length; i += 200) { // text to bytes, a few hundred strokes at a time
    blobs.push(new Blob(list.slice(i, i + 200)));
    if (performance.now() > end) { await yieldNow(); end = performance.now() + 10; }
  }
  const blob = new Blob(blobs);
  let buf;
  try { buf = await inWorker('gzip', blob); }
  catch { buf = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(); }
  return new Blob([buf], { type: 'application/gzip' });
}
async function parseDrawingFile(buf) {
  try { return await inWorker('parse', buf); } // copied, not handed over, so the fallback below still has it
  catch (err) { if (err.bad) throw err; } // the file itself could not be read; otherwise the worker is unavailable
  const b = new Uint8Array(buf), isGz = b[0] === 0x1f && b[1] === 0x8b;
  const text = isGz ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text() : new TextDecoder().decode(buf);
  return JSON.parse(text);
}

/* ------------------------------------------------------------ Google Drive */
const Drive = {
  token: null, exp: 0, gis: null,
  restore() {
    try {
      const t = JSON.parse(localStorage.getItem('nh-drive-token'));
      if (t && t.exp > Date.now()) { this.token = t.token; this.exp = t.exp; }
    } catch {}
  },
  ready() { return !!this.token && Date.now() < this.exp; },
  wasConnected() { return localStorage.getItem('nh-drive') === '1'; },
  loadGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (this.gis) return this.gis;
    this.gis = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => res();
      s.onerror = () => { this.gis = null; rej(new Error('Could not load Google sign-in. Check the connection and try again.')); };
      document.head.appendChild(s);
    });
    return this.gis;
  },
  async connect() {
    const cid = (window.NH_CONFIG || {}).googleClientId;
    if (!cid) throw new Error('No Google client ID yet. Add it to config.js (see README).');
    await this.loadGis();
    await new Promise((res, rej) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: cid,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: (r) => {
          if (r.error) return rej(new Error('Google sign-in failed: ' + r.error));
          this.token = r.access_token;
          this.exp = Date.now() + (Number(r.expires_in || 3600) - 120) * 1000;
          localStorage.setItem('nh-drive', '1');
          localStorage.setItem('nh-drive-token', JSON.stringify({ token: this.token, exp: this.exp }));
          res();
        },
        error_callback: (err) => rej(new Error('Google sign-in closed: ' + (err.message || err.type))),
      });
      client.requestAccessToken({ prompt: this.wasConnected() ? '' : 'consent' });
    });
  },
  async api(url, opts = {}) {
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + this.token } });
    if (r.status === 401) { this.token = null; localStorage.removeItem('nh-drive-token'); const e = new Error('Drive sign-in expired. Tap the Drive button to reconnect.'); e.status = 401; throw e; }
    if (!r.ok) { const e = new Error(`Drive error ${r.status}: ${(await r.text()).slice(0, 160)}`); e.status = r.status; throw e; }
    return r.json();
  },
  async folder() {
    let id = localStorage.getItem('nh-drive-folder');
    if (id) {
      try { const f = await this.api(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,trashed`); if (!f.trashed) return id; }
      catch (e) { if (e.status === 401) throw e; }
    }
    const q = encodeURIComponent("name='Natural Hand' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    const l = await this.api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`);
    if (l.files && l.files.length) id = l.files[0].id;
    else id = (await this.api('https://www.googleapis.com/drive/v3/files', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Natural Hand', mimeType: 'application/vnd.google-apps.folder' }),
    })).id;
    localStorage.setItem('nh-drive-folder', id);
    return id;
  },
  // upload (create or overwrite); returns {id, md5Checksum}
  async put(name, blob, fileId, folder, props) {
    const send = (fid) => {
      const form = new FormData();
      const meta = fid ? { name } : { name, parents: [folder] };
      if (props) meta.appProperties = props;
      form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
      form.append('file', blob);
      const url = fid
        ? `https://www.googleapis.com/upload/drive/v3/files/${fid}?uploadType=multipart&fields=id,md5Checksum`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,md5Checksum';
      return this.api(url, { method: fid ? 'PATCH' : 'POST', body: form });
    };
    if (!fileId) fileId = await this.findByName(name, folder);
    if (fileId) {
      try { return await send(fileId); }
      catch (e) { if (e.status !== 404) throw e; }
    }
    return send(null);
  },
  async findByName(name, folder) {
    const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and '${folder}' in parents and trashed=false`);
    const l = await this.api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`);
    return l.files && l.files.length ? l.files[0].id : null;
  },
  async stat(fileId) {
    try { return await this.api(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,md5Checksum,modifiedTime,trashed`); }
    catch (e) { if (e.status === 404) return null; throw e; }
  },
  async list(folder) {
    const q = encodeURIComponent(`'${folder}' in parents and trashed=false and name contains '.json.gz'`);
    const l = await this.api(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=1000&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,md5Checksum,size,appProperties)&spaces=drive`);
    return l.files || [];
  },
  async download(fileId) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: 'Bearer ' + this.token } });
    if (r.status === 401) { this.token = null; localStorage.removeItem('nh-drive-token'); const e = new Error('Drive sign-in expired. Tap the Drive button to reconnect.'); e.status = 401; throw e; }
    if (!r.ok) { const e = new Error(`Drive download failed (${r.status})`); e.status = r.status; throw e; }
    return parseDrawingFile(await r.arrayBuffer());
  },
};

/* ------------------------------------------------------------ cross-device merge
 * Each stroke is identified by (session, t0), which is unique across devices.
 * Merging takes the union of both copies, orders strokes by time and renumbers them.
 * For a stroke present in both, the copy from the more recently updated side wins
 * (that is where an undo or redo would have happened). */
const strokeKey = (s) => `${s.session}|${s.t0}`;
const eventKey = (e) => `${e.session}|${e.t}|${e.type}|${e.stroke ?? ''}|${e.figure ?? ''}|${e.part ?? ''}`;
const unionIds = (a, b) => { const out = [...(a || [])]; for (const x of b || []) if (!out.includes(x)) out.push(x); return out; };
function mergeData(lm, ls, le, remote) {
  const id = lm.id;
  const remoteNewer = (remote.updated || '') > (lm.updated || '');
  const map = new Map();
  for (const st of ls) map.set(strokeKey(st), st);
  for (const st of remote.strokes || []) {
    const k = strokeKey(st), mine = map.get(k);
    // part labels from both sides are kept (one device may have labelled strokes in replay)
    if (!mine || remoteNewer) map.set(k, mine ? { ...st, parts: unionIds(mine.parts, st.parts) } : { ...st });
    else if (st.parts && st.parts.length) mine.parts = unionIds(mine.parts, st.parts);
  }
  const strokes = [...map.values()].sort((a, b) => a.t0 - b.t0);
  const emap = new Map();
  for (const e of le) emap.set(eventKey(e), e);
  for (const e of remote.events || []) if (!emap.has(eventKey(e))) emap.set(eventKey(e), { ...e });
  const events = [...emap.values()].sort((a, b) => a.t - b.t);
  // undo/redo events point at stroke numbers; translate them to stroke identities first
  const oldIndex = (src) => new Map(src.map((st) => [st.i, strokeKey(st)]));
  const localIdx = oldIndex(ls), remoteIdx = oldIndex(remote.strokes || []);
  const localEv = new Set(le.map(eventKey));
  for (const e of events) {
    if (e.stroke == null) continue;
    e._sk = (localEv.has(eventKey(e)) ? localIdx : remoteIdx).get(e.stroke);
  }
  strokes.forEach((st, i) => { st.i = i; st.drawing = id; });
  const newIndex = new Map(strokes.map((st) => [strokeKey(st), st.i]));
  for (const e of events) { if (e._sk) { e.stroke = newIndex.get(e._sk) ?? e.stroke; delete e._sk; } e.drawing = id; }
  // figure numbers started independently on two devices can collide: renumber the later one
  const starts = new Map();
  for (const e of events) if (e.type === 'figure_start') {
    if (!starts.has(e.figure)) starts.set(e.figure, []);
    starts.get(e.figure).push(e.session);
  }
  let maxFig = 0;
  for (const st of strokes) if (typeof st.figure === 'number') maxFig = Math.max(maxFig, st.figure);
  for (const e of events) if (typeof e.figure === 'number') maxFig = Math.max(maxFig, e.figure);
  const renames = new Map();
  for (const [fig, sessions] of starts) for (const sess of [...new Set(sessions)].slice(1)) renames.set(`${sess}|${fig}`, ++maxFig);
  for (const st of strokes) {
    const r = renames.get(`${st.session}|${st.figure}`);
    if (r) { if (st.parts) st.parts = st.parts.map((id) => (id === `fig-${st.figure}` ? `fig-${r}` : id)); st.figure = r; }
  }
  for (const e of events) { const r = renames.get(`${e.session}|${e.figure}`); if (r) e.figure = r; }
  const sessions = [...(lm.sessions || [])];
  for (const ss of remote.sessions || []) if (!sessions.some((x) => x.id === ss.id)) sessions.push(ss);
  sessions.sort((a, b) => (a.started || '').localeCompare(b.started || ''));
  const newer = remoteNewer ? remote : lm;
  // parts: union; the newer side wins for a part both know, and a removal on either side stays
  const lp = lm.parts || {}, rp = remote.parts || {};
  const parts = remoteNewer ? { ...lp, ...rp } : { ...rp, ...lp };
  for (const id of Object.keys(parts)) {
    const rm = [lp[id] && lp[id].removed_at, rp[id] && rp[id].removed_at].filter(Boolean);
    if (rm.length) parts[id] = { ...parts[id], removed_at: Math.min(...rm) };
  }
  const meta = {
    ...lm,
    title: newer.title || '', tags: newer.tags || [], notes: newer.notes || '',
    updated: remoteNewer ? remote.updated : lm.updated,
    sessions, parts, figure_count: Math.max(maxFig, lm.figure_count || 0, remote.figure_count || 0),
    stroke_count: strokes.length,
  };
  return { meta, strokes, events, renames };
}
async function waitIdle() { while (S.active) await new Promise((r) => setTimeout(r, 200)); }
/* The merge works on copies and takes its time (the page stays responsive); you can keep
 * drawing meanwhile. It is applied only if the drawing did not change while it ran;
 * otherwise it starts again from the new state (and after a few tries waits for the next sync). */
async function applyRemote(id, remote, md5, fileId) {
  for (let attempt = 0; ; attempt++) {
    if (S.meta && S.meta.id === id) await waitIdle();
    const cur = !!(S.meta && S.meta.id === id);
    const lm = cur ? S.meta : await DB.get('drawings', id);
    const rev0 = lm.rev || 0, n0 = cur ? S.strokes.length : 0;
    const ls = (cur ? S.strokes : (await DB.strokes(id)).sort((a, b) => a.i - b.i)).map((st) => ({ ...st }));
    const le = await DB.events(id);
    await yieldNow();
    const { meta, strokes, events } = mergeData({ ...lm }, ls, le, remote);
    await yieldNow();
    strokes.forEach(normalizeStroke);
    migrateFigures(meta, strokes);
    await computeErasureAsync(strokes);
    meta.erasure = 1;
    meta.drive = { ...(lm.drive || {}), json: fileId, md5 };
    const still = cur ? S.meta === lm && (S.meta.rev || 0) === rev0 && S.strokes.length === n0 && !S.active && !S.loading
      : !(S.meta && S.meta.id === id) && ((await DB.get('drawings', id)) || {}).rev === lm.rev;
    if (!still) {
      if (attempt < 2) continue;
      throw new Error('The drawing changed while syncing. It will sync again shortly.');
    }
    // swap first (same task as the check), then write: anything drawn from now on is saved after this write
    if (cur) {
      const added = strokes.length - S.strokes.length;
      S.meta = meta; S.strokes = strokes; S.redo = [];
      const write = DB.replaceDrawing(meta, strokes, events);
      repaint(); updateTools();
      if (added > 0) toast(`Pulled ${added} stroke${added === 1 ? '' : 's'} from your other device.`);
      await write;
    } else await DB.replaceDrawing(meta, strokes, events);
    return;
  }
}
async function importRemote(file) {
  const remote = await Drive.download(file.id);
  const { strokes = [], events = [], sample_fields, units, exported, exported_by, ...m } = remote;
  if (!m.id || !m.paper) throw new Error('That file is not a Natural Hand drawing.');
  const meta = { ...m, format: FORMAT, rev: 0, synced_rev: 0, synced_at: file.modifiedTime, drive: { json: file.id, md5: file.md5Checksum }, view: null, stroke_count: strokes.length, erasure: 1 };
  strokes.sort((a, b) => a.i - b.i).forEach((st) => { st.drawing = meta.id; normalizeStroke(st); });
  migrateFigures(meta, strokes);
  await computeErasureAsync(strokes);
  events.forEach((e) => { e.drawing = meta.id; });
  await DB.replaceDrawing(meta, strokes, events);
  return meta.id;
}

let syncing = false, lastSync = null, syncError = null;
async function syncOne(id) {
  const getMeta = async () => (S.meta && S.meta.id === id ? S.meta : DB.get('drawings', id));
  let meta = await getMeta();
  if (!meta) return;
  const folder = await Drive.folder();
  // 1. pull: if the Drive copy changed since this device last saw it, merge it in
  const fileId = (meta.drive && meta.drive.json) || await Drive.findByName(`${id}.json.gz`, folder);
  if (fileId) {
    const st = await Drive.stat(fileId);
    if (st && !st.trashed && st.md5Checksum !== (meta.drive && meta.drive.md5)) {
      await applyRemote(id, await Drive.download(fileId), st.md5Checksum, fileId);
      meta = await getMeta();
    }
  }
  // 2. push: upload if this device has changes Drive does not
  if ((meta.rev || 0) <= (meta.synced_rev || 0) && meta.drive && meta.drive.json) return;
  if (S.meta && S.meta.id === id) await waitIdle();
  const rev = meta.rev || 0;
  const gz = await gzip(await exportParts(id));
  meta.drive = meta.drive || {};
  const props = { title: (meta.title || '').slice(0, 60), strokes: String(meta.stroke_count || 0), paper: meta.paper.name };
  const up = await Drive.put(`${id}.json.gz`, gz, meta.drive.json, folder, props);
  meta.drive.json = up.id; meta.drive.md5 = up.md5Checksum;
  meta.drive.png = (await Drive.put(`${id}.png`, await previewPng(id), meta.drive.png, folder)).id;
  meta.synced_rev = rev;
  meta.synced_at = new Date().toISOString();
  await DB.put('drawings', meta);
}
async function syncAll(manual) {
  if (syncing) return;
  if (!Drive.ready()) { if (manual) await connectDrive(); if (!Drive.ready()) return; }
  syncing = true; syncError = null; updateDriveChip();
  try {
    if (S.meta) await flushMeta();
    const metas = await DB.all('drawings');
    for (const m of metas) if ((S.meta && m.id === S.meta.id) || (m.rev || 0) > (m.synced_rev || 0)) await syncOne(m.id);
    lastSync = new Date();
    if (manual) toast('Everything is in Google Drive.');
  } catch (err) {
    syncError = err.message;
    if (manual) toast(err.message);
  } finally { syncing = false; updateDriveChip(); }
}
async function connectDrive() {
  try { await Drive.connect(); toast('Google Drive connected.'); updateDriveChip(); return true; }
  catch (err) { toast(err.message); updateDriveChip(); return false; }
}
function autoSync() {
  if (Drive.ready() && navigator.onLine && !S.active && !S.loading && performance.now() - S.lastPen > 15000) syncAll(false);
  else updateDriveChip();
}


/* ------------------------------------------------------------ images: PNG and SVG */
function imageBounds(meta, strokes) {
  const p = meta.paper;
  if (p.endless) return contentBox(strokes, 10) || { x0: 0, y0: 0, w: 100, h: 100 };
  return { x0: 0, y0: 0, w: p.w_mm, h: p.h_mm };
}
function renderImage(strokes, b, K, bg) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(b.w * K)); c.height = Math.max(1, Math.round(b.h * K));
  paintAll(c.getContext('2d'), strokes, b, K, bg);
  return c;
}
function canvasBlob(c, type) {
  return new Promise((res, rej) => c.toBlob((bl) => (bl ? res(bl) : rej(new Error('The image is too large for this device. Choose a lower resolution.'))), type));
}
const MAX_EXPORT_PX = 16e6;
function exportPlan(meta, strokes) {
  const b = imageBounds(meta, strokes);
  const dpi = Number($('#x-res').value);
  let K = dpi / 25.4, reduced = false;
  if (b.w * K * b.h * K > MAX_EXPORT_PX) { K = Math.sqrt(MAX_EXPORT_PX / (b.w * b.h)); reduced = true; }
  return { b, K, dpi: Math.floor(K * 25.4), reduced };
}
function svgOf(meta, strokes, transparent) {
  const b = imageBounds(meta, strokes), f = (v) => Math.round(v * 1000) / 1000;
  const esc = (t) => String(t).replace(/[<&>"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' }[c]));
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(b.w)}mm" height="${f(b.h)}mm" viewBox="${f(b.x0)} ${f(b.y0)} ${f(b.w)} ${f(b.h)}">`,
    `<title>${esc(meta.title || meta.id)}</title>`,
  ];
  if (!transparent) out.push(`<rect x="${f(b.x0)}" y="${f(b.y0)}" width="${f(b.w)}" height="${f(b.h)}" fill="#ffffff"/>`);
  out.push('<g fill="none" stroke="#000000" stroke-linecap="round" stroke-linejoin="round">');
  for (const st of strokes) {
    if (st.undone_at || st.tool === 'eraser') continue;
    const { dot, runs } = strokeRuns(st);
    if (dot) out.push(`<circle cx="${f(dot[0])}" cy="${f(dot[1])}" r="${f(dot[2])}" fill="#000000" stroke="none"/>`);
    for (const r of runs) out.push(`<path stroke-width="${f(r.w)}" d="M${r.pts.map((q) => `${f(q[0])} ${f(q[1])}`).join('L')}"/>`);
  }
  out.push('</g>', '</svg>');
  return out.join('\n');
}
function fileBase() { return (S.meta.title || S.meta.id).replace(/[^\p{L}\p{N}_\- ]+/gu, '').trim().replace(/\s+/g, '-') || S.meta.id; }
async function makeExportFile() {
  const fmt = $('#x-format').value, transparent = $('#x-transparent').checked;
  if (fmt === 'svg') {
    const text = svgOf(S.meta, S.strokes, transparent);
    return new File([text], `${fileBase()}.svg`, { type: 'image/svg+xml' });
  }
  const { b, K } = exportPlan(S.meta, S.strokes);
  const blob = await canvasBlob(renderImage(S.strokes, b, K, transparent ? null : '#ffffff'), 'image/png');
  return new File([blob], `${fileBase()}.png`, { type: 'image/png' });
}
function updateExportInfo() {
  const png = $('#x-format').value === 'png';
  $('#x-res-row').hidden = !png;
  if (!S.meta) return;
  const { b, K, dpi, reduced } = exportPlan(S.meta, S.strokes);
  $('#x-info').textContent = png
    ? `${Math.round(b.w * K)} × ${Math.round(b.h * K)} pixels, ${Math.round(b.w)} × ${Math.round(b.h)} mm${reduced ? `. Reduced to ${dpi} dpi, the most this device can make.` : '.'}`
    : `Vector lines in real millimetres, ${Math.round(b.w)} × ${Math.round(b.h)} mm. Opens in Illustrator, Inkscape and browsers.`;
  let canShare = false;
  try { canShare = !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.png', { type: 'image/png' })] })); } catch {}
  $('#x-share').hidden = !canShare;
}
function openExport() { $('#export-dlg').showModal(); updateExportInfo(); }
async function doExport(share) {
  const btn = share ? $('#x-share') : $('#x-save'), label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    const file = await makeExportFile();
    if (share) await navigator.share({ files: [file], title: S.meta.title || 'Drawing' });
    else download(file.name, file);
    $('#export-dlg').close();
  } catch (err) { if (err.name !== 'AbortError') toast(err.message); }
  finally { btn.disabled = false; btn.textContent = label; }
}

/* ------------------------------------------------------------ replay
 * Redraws the drawing in the order and at the speed it was made. Erased ink appears
 * and is then painted over when the eraser passes; undo and redo happen when they did.
 * "Skip pauses" shortens gaps longer than 1.5 s (thinking, breaks, other days). */
/* Labelling in replay: the strokes drawn between "From here" and the current moment are
 * selected (optionally only those inside a loop drawn on the page), shown in blue, and
 * can be labelled as a part of any kind. */
const HILITE = '#1b84b5';
function inPoly(x, y, P) {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
// a stroke is inside a loop when at least half of its samples are
function strokeInLoop(st, P) {
  const Q = st.samples, n = Q.length, step = Math.max(1, Math.floor(n / 40));
  let a = 0, b = 0;
  for (let i = 0; i < n; i += step) { b++; if (inPoly(Q[i][1], Q[i][2], P)) a++; }
  return a * 2 >= b;
}
const loopBox = (P) => ({ x0: Math.min(...P.map((q) => q[0])), x1: Math.max(...P.map((q) => q[0])), y0: Math.min(...P.map((q) => q[1])), y1: Math.max(...P.map((q) => q[1])) });

const Replay = {
  on: false, paper: null, items: [], toggles: [], events: [], strokes: [], total: 0, t: 0, playing: false, speed: 1, skip: true,
  k: 0, partial: 0, ti: 0, hidden: new Set(), lastFrame: 0, raf: 0, sessions: new Map(), byI: new Map(),
  lab: false, from: 0, loop: null, drawingLoop: null, loopId: null, sel: [], fixed: null, fixedId: null,
  async open() {
    if (!S.meta || S.active || this.on) return;
    const strokes = S.strokes.filter((st) => st.samples.length).slice().sort((a, b) => a.t0 - b.t0);
    if (!strokes.length) { toast('Nothing to replay yet.'); return; }
    hideNibs(); if ($('#menu').open) $('#menu').close();
    this.events = (await DB.events(S.meta.id)).filter((e) => e.type === 'undo' || e.type === 'redo').sort((a, b) => a.t - b.t);
    this.strokes = strokes;
    this.sessions = new Map((S.meta.sessions || []).map((ss) => [ss.id, ss]));
    this.skip = $('#rp-skip').checked; this.speed = Number($('#rp-speed').value);
    this.build();
    this.paper = makePaper(S.paper.b);
    this.on = true;
    document.body.classList.add('replaying');
    $('#replay-bar').hidden = false;
    this.seek(0);
    this.play();
  },
  build() {
    const MAXG = 1500, COMP = 400;
    this.items = []; let cursor = 0, prevEnd = null;
    const byI = new Map();
    for (const st of this.strokes) {
      const dur = Math.max(0, st.samples[st.samples.length - 1][0]);
      let gap = prevEnd == null ? 0 : Math.max(0, st.t0 - prevEnd);
      if (this.skip && gap > MAXG) gap = COMP;
      const it = { st, rs: cursor + gap, dur, real: st.t0 };
      cursor = it.rs + dur; prevEnd = st.t0 + dur;
      this.items.push(it); byI.set(st.i, it);
    }
    this.byI = byI;
    this.total = cursor;
    this.toggles = this.events.map((e) => ({ at: this.realToReplay(e.t), i: e.stroke, type: e.type })).filter((x) => byI.has(x.i));
    // when an eraser lifts, the page is redrawn with what it erased removed
    for (const it of this.items) if (it.st.tool === 'eraser') this.toggles.push({ at: it.rs + it.dur, i: it.st.i, type: 'erase' });
    this.toggles.sort((a, b) => a.at - b.at);
  },
  realToReplay(t) {
    const it = this.items; let lo = 0, hi = it.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (it[m].real <= t) { k = m; lo = m + 1; } else hi = m - 1; }
    if (k < 0) return 0;
    const a = it[k], off = t - a.real;
    if (off <= a.dur) return a.rs + off;
    const room = k + 1 < it.length ? it[k + 1].rs - (a.rs + a.dur) : 0;
    return a.rs + a.dur + Math.min(off - a.dur, room);
  },
  countUpTo(st, tt) {
    const P = st.samples; let lo = 0, hi = P.length - 1, k = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (P[m][0] <= tt) { k = m + 1; lo = m + 1; } else hi = m - 1; }
    return Math.max(1, k);
  },
  clear() { const { x, K, b } = this.paper; paintAll(x, [], b, K); },
  seek(tau) {
    this.t = clamp(tau, 0, this.total);
    this.clear(); this.k = 0; this.partial = 0; this.ti = 0; this.hidden = new Set();
    while (this.ti < this.toggles.length && this.toggles[this.ti].at <= this.t) this.applyToggle(this.toggles[this.ti++]);
    this.draw(this.t);
    if (this.lab) { this.select(); this.highlight(); }
    this.ui(); requestRender();
  },
  setLab(on) {
    if (on) this.pause();
    this.lab = on; this.loop = null; this.drawingLoop = null; this.fixed = null; this.fixedId = null; this.from = 0;
    $('#rp-lab').hidden = !on;
    $('#rp-label').setAttribute('aria-pressed', String(on));
    $('#rp-label').textContent = on ? 'Done labelling' : 'Label parts';
    if (on) this.fillKinds();
    this.seek(this.t);
  },
  fillKinds() {
    const cur = $('#lab-kind').value || S.kind;
    $('#lab-kind').innerHTML = kindsList().map((k) => `<option${k === cur ? ' selected' : ''}>${escHtml(k)}</option>`).join('');
  },
  select() {
    if (this.fixed) { this.sel = this.fixed; return; }
    const L = this.loop, lb = L && loopBox(L);
    this.sel = [];
    for (const it of this.items) {
      if (it.rs > this.t) break;
      const st = it.st;
      if (st.tool === 'eraser' || it.rs < this.from || this.hidden.has(st.i)) continue;
      if (L && !(boxesMeet(bboxOf(st), lb) && strokeInLoop(st, L))) continue;
      this.sel.push(st);
    }
  },
  // selected strokes in blue, as far as they are drawn at this moment
  highlight() {
    const ctx = this.paper.x, tau = this.t, done = new Set();
    for (const it of this.items) if (it.st.tool === 'eraser' && it.rs + it.dur <= tau && !this.hidden.has(it.st.i)) done.add(it.st.i);
    for (const st of this.sel) {
      const it = this.byI.get(st.i);
      if (!it || it.rs > tau) continue;
      const m = Math.min(st.samples.length, this.countUpTo(st, tau - it.rs));
      const cut = (st.erased || []).filter((r) => done.has(r[2]));
      drawStroke(ctx, cut.length ? Object.assign(Object.create(st), { erased: cut }) : st, 0, m, cut.length > 0, HILITE);
    }
  },
  labUi() {
    const n = this.sel.length, f = (ms) => this.fmt(ms);
    let msg;
    if (this.fixed) {
      const p = S.meta.parts[this.fixedId];
      msg = `Showing ${p ? p.kind : 'a part'}: ${n} stroke${n === 1 ? '' : 's'}. Draw a loop or press From here to select something new.`;
    } else if (this.t < this.from) msg = `The start point (${f(this.from)}) is after this moment. Move forward, or press From here.`;
    else msg = `${n} stroke${n === 1 ? '' : 's'} selected, drawn ${f(this.from)} to ${f(this.t)}${this.loop ? ' inside your loop' : ''}. `
      + (this.loop ? 'Tap the page to drop the loop.' : 'Draw a loop around the thing to leave the rest out.');
    $('#lab-help').textContent = msg;
    $('#lab-go').disabled = !n || !!this.fixed;
  },
  fromHere() { this.from = this.t; this.fixed = null; this.fixedId = null; this.seek(this.t); },
  loopStart(e) { this.drawingLoop = [screenToDoc(e.clientX, e.clientY)]; this.loopId = e.pointerId; requestRender(); },
  loopMove(e) { for (const ce of coalesced(e)) this.drawingLoop.push(screenToDoc(ce.clientX, ce.clientY)); requestRender(); },
  loopEnd() {
    const P = this.drawingLoop;
    this.drawingLoop = null;
    let len = 0;
    for (let i = 1; i < P.length; i++) len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    // a tap (or a tiny scribble) drops the loop
    this.loop = P.length >= 3 && len * S.ppmm * S.view.s > 30 ? P : null;
    this.fixed = null; this.fixedId = null;
    this.seek(this.t);
  },
  label() {
    const kind = $('#lab-kind').value, sel = this.sel;
    if (!sel.length || !kind || this.fixed) return;
    ensureSession();
    // nest it inside the smallest part that already holds all of these strokes
    let parent = null, best = Infinity;
    for (const [pid, ms] of partMembers()) if (ms.size < best && sel.every((st) => ms.has(st))) { parent = pid; best = ms.size; }
    const id = newPartId();
    S.meta.parts = S.meta.parts || {};
    S.meta.parts[id] = { kind, parent, source: 'replay', session: S.sessionId, created: rnd(absNow(), 3) };
    for (const st of sel) { st.parts = [...(st.parts || []), id]; saveStroke(st); }
    logEvent('part_label', { part: id, kind, parent, strokes: sel.length });
    markChanged();
    toast(`${sel.length} stroke${sel.length === 1 ? '' : 's'} labelled ${kind}${parent ? `, inside ${S.meta.parts[parent].kind}` : ''}.`);
    this.loop = null; this.from = this.t;
    this.seek(this.t);
  },
  show(id) {
    const ms = [...(partMembers().get(id) || [])].filter((st) => this.byI.has(st.i));
    if (!ms.length) { toast('This part has no strokes left.'); return; }
    if (!this.lab) this.setLab(true);
    this.fixed = ms; this.fixedId = id; this.loop = null;
    this.seek(Math.max(...ms.map((st) => { const it = this.byI.get(st.i); return it.rs + it.dur; })));
  },
  fmt(ms) { const t = Math.floor(ms / 1000); return t >= 3600 ? `${Math.floor(t / 3600)}:${pad2(Math.floor(t / 60) % 60)}:${pad2(t % 60)}` : `${Math.floor(t / 60)}:${pad2(t % 60)}`; },
  applyToggle(g) { if (g.type === 'undo') this.hidden.add(g.i); else if (g.type === 'redo') this.hidden.delete(g.i); },
  draw(tau) {
    const ctx = this.paper.x;
    const done = new Set();
    for (const it of this.items) if (it.st.tool === 'eraser' && it.rs + it.dur <= tau && !this.hidden.has(it.st.i)) done.add(it.st.i);
    while (this.k < this.items.length && this.items[this.k].rs <= tau) {
      const it = this.items[this.k], st = it.st, n = st.samples.length;
      const m = Math.min(n, this.countUpTo(st, tau - it.rs));
      if (!this.hidden.has(st.i) && m > this.partial) {
        if (st.tool === 'eraser') {
          // while erasing: a cutting eraser paints white, a whole-line eraser leaves no mark
          if (!done.has(st.i) && eraseModeOf(st) === 'cut') drawStroke(ctx, st, this.partial, m, false);
        } else {
          const cut = (st.erased || []).filter((r) => done.has(r[2]));
          if (cut.length) drawStroke(ctx, Object.assign(Object.create(st), { erased: cut }), this.partial, m, true);
          else drawStroke(ctx, st, this.partial, m, false);
        }
      }
      this.partial = m;
      if (m >= n) { this.k++; this.partial = 0; } else break;
    }
  },
  advance(tau) {
    if (this.ti < this.toggles.length && this.toggles[this.ti].at <= tau) { this.seek(tau); return; }
    this.draw(tau);
  },
  tick(now) {
    if (!this.playing) return;
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 0;
    this.lastFrame = now;
    this.t = Math.min(this.total, this.t + dt * this.speed);
    this.advance(this.t);
    this.ui(); requestRender();
    if (this.t >= this.total) { this.pause(); return; }
    this.raf = requestAnimationFrame((n) => this.tick(n));
  },
  play() {
    if (this.t >= this.total) this.seek(0);
    this.playing = true; this.lastFrame = 0; $('#rp-play').textContent = 'Pause';
    cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame((n) => this.tick(n));
  },
  pause() {
    const was = this.playing;
    this.playing = false; cancelAnimationFrame(this.raf); $('#rp-play').textContent = this.t >= this.total ? 'Play again' : 'Play';
    if (was && this.lab && this.on) this.seek(this.t); // refresh the selection where playback stopped
  },
  close() {
    this.lab = false; this.loop = null; this.drawingLoop = null; this.fixed = null; this.fixedId = null;
    $('#rp-lab').hidden = true; $('#rp-label').setAttribute('aria-pressed', 'false'); $('#rp-label').textContent = 'Label parts';
    this.pause(); this.on = false; this.paper = null;
    document.body.classList.remove('replaying');
    $('#replay-bar').hidden = true;
    invalidateSharp(); requestRender();
  },
  current() {
    const it = this.items[this.k];
    if (!it) return null;
    if (it.rs <= this.t) { const P = it.st.samples[Math.max(0, this.partial - 1)]; return { x: P[1], y: P[2], down: true, st: it.st }; }
    let best = null;
    for (const h of it.st.hover || []) { if (it.rs + h[0] <= this.t) best = h; else break; }
    if (best) return { x: best[1], y: best[2], down: false, st: it.st };
    return { st: it.st };
  },
  drawCursor(ctx, k) {
    const L = this.drawingLoop || this.loop;
    if (this.lab && L && L.length > 1) {
      ctx.save(); ctx.beginPath(); ctx.moveTo(L[0][0], L[0][1]);
      for (const q of L) ctx.lineTo(q[0], q[1]);
      if (!this.drawingLoop) ctx.closePath();
      ctx.setLineDash([5 / k, 4 / k]); ctx.lineWidth = 1.5 / k; ctx.strokeStyle = HILITE; ctx.stroke(); ctx.restore();
    }
    const c = this.current();
    if (!c || c.x == null) return;
    const r = 5 / k;
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.lineWidth = 1.5 / k; ctx.strokeStyle = '#3f8fa8';
    if (c.down) { ctx.fillStyle = 'rgba(164,221,237,0.55)'; ctx.fill(); }
    ctx.stroke();
  },
  ui() {
    const fmt = (ms) => this.fmt(ms);
    $('#rp-seek').value = this.total ? Math.round((this.t / this.total) * 1000) : 0;
    $('#rp-time').textContent = `${fmt(this.t)} / ${fmt(this.total)}`;
    const c = this.current(), ss = c && this.sessions.get(c.st.session);
    const info = [];
    if (ss) info.push(`${ss.device ? ss.device.name : ''}, ${new Date(ss.started).toLocaleDateString()}`);
    const kinds = c ? partsOf(c.st).map((id) => S.meta.parts[id].kind) : [];
    if (kinds.length) info.push(kinds.join(' › '));
    if (c && c.st.tool === 'eraser') info.push('erasing');
    $('#rp-info').textContent = info.join(', ');
    if (this.lab) this.labUi();
  },
};

/* ------------------------------------------------------------ parts list */
const SOURCE_TEXT = { live: 'marked while drawing', replay: 'labelled in replay', figure: 'figure from an older version' };
function openPartsList() {
  if (!S.meta) return;
  const members = partMembers(), kinds = kindsList();
  const rows = Object.entries(S.meta.parts || {}).filter(([, p]) => !p.removed_at).map(([id, p]) => {
    const ms = [...(members.get(id) || [])];
    return { id, p, n: ms.length, first: ms.length ? Math.min(...ms.map((st) => st.t0)) : Infinity };
  }).sort((a, b) => a.first - b.first);
  $('#parts-empty').hidden = rows.length > 0;
  $('#parts-list').innerHTML = rows.map(({ id, p, n }) => {
    const par = p.parent && livePart(p.parent);
    const opts = (kinds.includes(p.kind) ? kinds : [p.kind, ...kinds]).map((k) => `<option${k === p.kind ? ' selected' : ''}>${escHtml(k)}</option>`).join('');
    return `<div class="item part"><div><select data-kind="${id}" aria-label="Kind">${opts}</select>`
      + `<div class="meta">${n} stroke${n === 1 ? '' : 's'}, ${SOURCE_TEXT[p.source] || escHtml(p.source)}${par ? `, inside ${escHtml(par.kind)}` : ''}</div></div>`
      + `<div class="acts">${Replay.on && n ? `<button class="btn" data-show="${id}">Show</button>` : ''}<button class="btn danger" data-rm="${id}">Remove</button></div></div>`;
  }).join('');
  if (!$('#parts-dlg').open) $('#parts-dlg').showModal();
}
function setPartKind(id, kind) {
  const p = S.meta.parts[id];
  if (!p || !kind || p.kind === kind) return;
  p.kind = kind;
  logEvent('part_kind', { part: id, kind });
  markChanged(); updateTools();
  if (Replay.lab) Replay.seek(Replay.t);
}
function removePart(id) {
  const p = S.meta.parts[id];
  if (!p || !confirm(`Remove this ${p.kind}? The strokes stay; only the label is taken back.`)) return;
  p.removed_at = rnd(absNow(), 3);
  logEvent('part_remove', { part: id, kind: p.kind });
  const i = S.partStack.indexOf(id);
  if (i >= 0) S.partStack.splice(i);
  markChanged(); updateTools();
  if (Replay.fixedId === id) { Replay.fixed = null; Replay.fixedId = null; }
  openPartsList();
  if (Replay.lab) Replay.seek(Replay.t);
}

/* ------------------------------------------------------------ life size */
function lifeSize() {
  if (!S.meta) return;
  if (Math.abs(S.view.s - 1) < 0.005) { fit(); return; }
  const D = screenToDoc(cw / 2, ch / 2);
  setViewAround(D, cw / 2, ch / 2, 1, S.view.r);
  persistViewSoon(); requestRender();
  if (!S.device.calibrated) toast('Calibrate this device in the menu so life size is exact.');
}
let zoomShown = null;
function updateZoomChip() {
  const life = Math.abs(S.view.s - 1) < 0.005;
  const t = !S.meta ? '' : life ? 'Life size' : `${Math.round(S.view.s * 100)}%`;
  if (t !== zoomShown) {
    zoomShown = t;
    const c = $('#zoom-chip');
    c.textContent = t; c.hidden = !t;
    c.title = life ? 'Fit the page (0)' : 'Show at life size (L)';
  }
}

/* ------------------------------------------------------------ session prompts */
let promptTimer = 0;
async function startPrompt() {
  const kind = $('#pr-kind').value;
  const text = kind === 'custom' ? ($('#pr-custom').value.trim() || 'Own prompt') : kind;
  const minutes = Number($('#pr-min').value);
  $('#prompt-dlg').close(); if ($('#menu').open) $('#menu').close();
  if (S.prompt) endPrompt(false);
  if ($('#pr-new').checked) {
    const p = S.meta ? S.meta.paper : null;
    await newDrawing(p ? (p.endless ? 'Endless' : p.name) : defaultPaper(), !!(p && !p.endless && p.w_mm > p.h_mm), text);
  }
  const now = Date.now();
  S.prompt = { id: `p-${now.toString(36)}`, text, minutes, started: now, ends: minutes ? now + minutes * 60000 : null };
  S.meta.prompts = S.meta.prompts || [];
  S.meta.prompts.push({ id: S.prompt.id, text, minutes, started: new Date(now).toISOString(), ended: null });
  logEvent('prompt_start', { prompt: S.prompt.id, text, minutes });
  markChanged();
  clearInterval(promptTimer); promptTimer = setInterval(promptTick, 1000);
  promptTick();
  toast(minutes ? `${text}, ${minutes} minutes. The timer is running.` : `${text}. Tap the timer to end the session.`);
}
function promptTick() {
  const p = S.prompt, c = $('#prompt-chip');
  if (!p) { c.hidden = true; return; }
  const now = Date.now();
  if (p.ends && now >= p.ends) { endPrompt(true); return; }
  if (p.paused) return;
  const ms = p.ends ? p.ends - now : now - p.started, t = Math.floor(ms / 1000);
  c.hidden = false;
  c.textContent = `${p.text}, ${Math.floor(t / 60)}:${pad2(t % 60)}${p.ends ? ' left' : ''}`;
}
function endPrompt(timeUp) {
  const p = S.prompt;
  if (!p) return;
  S.prompt = null; clearInterval(promptTimer); $('#prompt-chip').hidden = true;
  const rec = S.meta && (S.meta.prompts || []).find((x) => x.id === p.id);
  if (rec) { rec.ended = new Date().toISOString(); markChanged(); }
  logEvent('prompt_end', { prompt: p.id, reason: timeUp ? 'time' : 'ended' });
  if (timeUp) {
    toast(`Time is up for "${p.text}". Keep drawing if you like; new strokes are outside the session.`);
    if (navigator.vibrate) navigator.vibrate([40, 80, 40]);
  }
}

/* ------------------------------------------------------------ time away
 * When the app is hidden (screen locked, another app opened) the data records it, so a
 * pause for thought and leaving the drawing can be told apart. A session timer pauses too. */
let awayAt = null;
function awayStart() {
  if (awayAt != null || !S.meta) return;
  awayAt = absNow();
  logEvent('away_start');
  if (S.prompt && S.prompt.ends) { S.prompt.remaining = S.prompt.ends - Date.now(); S.prompt.ends = null; S.prompt.paused = true; }
}
function awayEnd() {
  syncClock();
  if (awayAt == null) return;
  const ms = Math.max(0, absNow() - awayAt);
  awayAt = null;
  logEvent('away_end', { away_ms: Math.round(ms) });
  if (S.prompt && S.prompt.paused) { S.prompt.ends = Date.now() + S.prompt.remaining; S.prompt.paused = false; promptTick(); }
}

/* ------------------------------------------------------------ pressure feel */
const gammaFromFeel = (v) => rnd(Math.pow(2, (1.5 * v) / 100), 4);
const feelFromGamma = (g) => Math.round((Math.log2(g || 1) / 1.5) * 100);
function drawFeelCurve() {
  const g = gammaFromFeel(Number($('#m-feel').value)), pts = [];
  for (let i = 0; i <= 24; i++) { const p = i / 24; pts.push(`${(p * 100).toFixed(1)},${(60 - Math.pow(p, g) * 60).toFixed(1)}`); }
  $('#feel-curve').setAttribute('points', pts.join(' '));
}


/* ------------------------------------------------------------ replay video (MP4)
 * Frames are drawn one by one from the stroke data at the chosen size (not screen-
 * recorded), encoded with the browser's video encoder (WebCodecs) and packed into
 * an MP4 by the bundled mp4-muxer library. Faster than real time on most devices. */
const VIDEO_HOLD_START = 0.5, VIDEO_HOLD_END = 2.5; // seconds of still page before and after
const Video = {
  busy: false, cancel: false, file: null,
  shapeOf(rect) {
    const v = $('#v-shape').value;
    if (v === 'page') return rect.w / rect.h;
    const [a, b] = v.split(':').map(Number);
    return a / b;
  },
  // what the video frames show (doc mm), the white paper inside it, and the frame size
  plan() {
    const meta = S.meta, strokes = S.strokes;
    const endless = !!meta.paper.endless;
    const content = endless ? (contentBox(strokes, 8) || { x0: 0, y0: 0, w: 100, h: 100 }) : { x0: 0, y0: 0, w: meta.paper.w_mm, h: meta.paper.h_mm };
    const aspect = this.shapeOf(content);
    const short = Number($('#v-res').value);
    let W = aspect >= 1 ? short * aspect : short, H = aspect >= 1 ? short : short / aspect;
    const even = (v) => Math.max(2, Math.round(v / 2) * 2);
    W = even(W); H = even(H);
    const pad = $('#v-shape').value === 'page' ? 0 : 0.06;
    const K = Math.min((W * (1 - 2 * pad)) / content.w, (H * (1 - 2 * pad)) / content.h);
    const b = { x0: content.x0 + content.w / 2 - W / (2 * K), y0: content.y0 + content.h / 2 - H / (2 * K), w: W / K, h: H / K };
    const fps = Number($('#v-fps').value);
    const bitrate = Math.round(W * H * fps * Number($('#v-q').value));
    return { W, H, K, b, paperRect: content, fps, bitrate, short };
  },
  engine(plan, ctx) {
    const eng = Object.create(Replay);
    Object.assign(eng, {
      strokes: S.strokes.filter((st) => st.samples.length).slice().sort((a, c) => a.t0 - c.t0),
      events: this.events, sessions: new Map(), skip: $('#v-skip').checked,
      items: [], toggles: [], hidden: new Set(), k: 0, partial: 0, ti: 0, t: 0,
      paper: { x: ctx, K: plan.K, b: plan.b },
      ui() {},
      clear() {
        const { K, b } = plan, bg = $('#v-bg').value, pr = plan.paperRect;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = bg; ctx.fillRect(0, 0, plan.W, plan.H);
        ctx.setTransform(K, 0, 0, K, -b.x0 * K, -b.y0 * K);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(pr.x0, pr.y0, pr.w, pr.h);
      },
    });
    eng.build();
    return eng;
  },
  speedFor(total) {
    const v = $('#v-len').value;
    if (v.startsWith('x')) return Number(v.slice(1));
    const target = Number(v.slice(3)) - VIDEO_HOLD_START - VIDEO_HOLD_END;
    return Math.max(1, total / (Math.max(1, target) * 1000));
  },
  async info() {
    if (!S.meta) return;
    const p = this.plan();
    const eng = this.engine(p, document.createElement('canvas').getContext('2d'));
    const speed = this.speedFor(eng.total);
    const secs = eng.total / speed / 1000 + VIDEO_HOLD_START + VIDEO_HOLD_END;
    const mb = (p.bitrate * secs) / 8 / 1048576;
    const t = Math.round(secs);
    $('#v-info').textContent = `${p.W} × ${p.H}, ${Math.floor(t / 60)}:${pad2(t % 60)} long at ${speed < 10 ? speed.toFixed(1) : Math.round(speed)}× speed, at most about ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB.`;
  },
  async open() {
    if (!S.meta) return;
    if (!S.strokes.some((st) => st.samples.length)) { toast('Nothing to make a video of yet.'); return; }
    if (!('VideoEncoder' in window)) { toast('This browser cannot make videos. Use Chrome on Android or a desktop.'); return; }
    if (Replay.on) Replay.pause();
    if ($('#menu').open) $('#menu').close();
    this.events = (await DB.events(S.meta.id)).filter((e) => e.type === 'undo' || e.type === 'redo').sort((a, b) => a.t - b.t);
    this.file = null;
    $('#v-share').hidden = true; $('#v-save').hidden = true; $('#v-go').hidden = false;
    $('#v-prog').hidden = true; $('#v-status').textContent = '';
    for (const el of document.querySelectorAll('#video-dlg select, #video-dlg input')) el.disabled = false;
    $('#video-dlg').showModal();
    this.info();
  },
  async pickCodec(W, H, fps, bitrate) {
    const tries = [
      ['avc', 'avc1.640034'], ['avc', 'avc1.640033'], ['avc', 'avc1.640028'], ['avc', 'avc1.4d0033'], ['avc', 'avc1.42003e'],
      ['vp9', 'vp09.00.51.08'], ['vp9', 'vp09.00.41.08'], ['av1', 'av01.0.12M.08'],
    ];
    for (const [mux, codec] of tries) {
      const cfg = { codec, width: W, height: H, bitrate, framerate: fps, latencyMode: 'quality' };
      if (mux === 'avc') cfg.avc = { format: 'avc' };
      try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return { mux, cfg }; } catch {}
    }
    return null;
  },
  loadMuxer() {
    if (window.Mp4Muxer) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/mp4-muxer.js';
      s.onload = () => res(); s.onerror = () => rej(new Error('Could not load the video packer. Check the connection once, then it works offline.'));
      document.head.appendChild(s);
    });
  },
  async make() {
    if (this.busy) return;
    this.busy = true; this.cancel = false;
    const status = (t) => { $('#v-status').textContent = t; };
    const prog = $('#v-prog');
    for (const el of document.querySelectorAll('#video-dlg select, #video-dlg input')) el.disabled = true;
    $('#v-go').hidden = true; prog.hidden = false; prog.value = 0;
    let wake = null;
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch {}
    try {
      await this.loadMuxer();
      const p = this.plan();
      const codec = await this.pickCodec(p.W, p.H, p.fps, p.bitrate);
      if (!codec) throw new Error('This device cannot encode video at this size. Try a lower resolution.');
      const ink = document.createElement('canvas'); ink.width = p.W; ink.height = p.H;
      const ictx = ink.getContext('2d');
      const out = document.createElement('canvas'); out.width = p.W; out.height = p.H;
      const octx = out.getContext('2d', { alpha: false });
      const eng = this.engine(p, ictx);
      const speed = this.speedFor(eng.total);
      const drawFrames = Math.ceil((eng.total / speed / 1000) * p.fps);
      const holdA = Math.round(VIDEO_HOLD_START * p.fps), holdB = Math.round(VIDEO_HOLD_END * p.fps);
      const frames = holdA + drawFrames + 1 + holdB;
      const target = new Mp4Muxer.ArrayBufferTarget();
      const muxer = new Mp4Muxer.Muxer({ target, video: { codec: codec.mux, width: p.W, height: p.H, frameRate: p.fps }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
      let encErr = null;
      const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
      enc.configure(codec.cfg);
      const cursor = $('#v-cursor').checked, ks = (p.K * 720) / p.short;
      minLineMm = $('#v-thin').checked ? (1.4 * p.short) / 1080 / p.K : 0;
      eng.seek(0);
      for (let f = 0; f < frames; f++) {
        if (this.cancel) throw new Error('cancelled');
        if (encErr) throw encErr;
        const tau = f < holdA ? 0 : Math.min(eng.total, ((f - holdA) / p.fps) * 1000 * speed);
        eng.t = tau; eng.advance(tau); eng.t = tau;
        octx.setTransform(1, 0, 0, 1, 0, 0);
        octx.drawImage(ink, 0, 0);
        if (cursor && f >= holdA && tau < eng.total) {
          octx.setTransform(p.K, 0, 0, p.K, -p.b.x0 * p.K, -p.b.y0 * p.K);
          eng.drawCursor(octx, ks);
        }
        const frame = new VideoFrame(out, { timestamp: Math.round((f * 1e6) / p.fps), duration: Math.round(1e6 / p.fps) });
        enc.encode(frame, { keyFrame: f % (p.fps * 2) === 0 });
        frame.close();
        if (enc.encodeQueueSize > 6) await new Promise((r) => enc.addEventListener('dequeue', r, { once: true }));
        if (f % 15 === 0) {
          prog.value = f / frames;
          status(`Making the video, ${Math.round((f / frames) * 100)}%`);
          await new Promise((r) => setTimeout(r));
        }
      }
      status('Finishing…');
      await enc.flush();
      enc.close();
      muxer.finalize();
      prog.value = 1;
      const name = `${fileBase()}-replay.mp4`;
      this.file = new File([target.buffer], name, { type: 'video/mp4' });
      const mb = this.file.size / 1048576;
      status(`Ready: ${name}, ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB, ${codec.mux === 'avc' ? 'H.264' : codec.mux.toUpperCase()}.`);
      $('#v-save').hidden = false;
      let canShare = false;
      try { canShare = !!(navigator.canShare && navigator.canShare({ files: [this.file] })); } catch {}
      $('#v-share').hidden = !canShare;
      download(name, this.file);
    } catch (err) {
      status(err.message === 'cancelled' ? 'Stopped.' : `Could not make the video: ${err.message}`);
      $('#v-go').hidden = false;
      for (const el of document.querySelectorAll('#video-dlg select, #video-dlg input')) el.disabled = false;
    } finally {
      this.busy = false; minLineMm = 0;
      if (wake) wake.release().catch(() => {});
    }
  },
};

/* ------------------------------------------------------------ diagnostics */
const Diag = {
  el: $('#diag'), last: null, seen: {}, hoverN: 0, hoverT0: 0, hoverHz: 0, coal: [], stroke: null, timer: 0,
  reset() { this.seen = { pressureVaries: false, tilt: false, altaz: false, twist: false, tangential: false, hover: false, pen: false, mouse: false }; },
  down(e) { this.last = e; this.coal = []; this.note(e); this.show(); },
  move(e, n) { this.last = e; this.coal.push(n); this.note(e); this.show(); },
  hover(e, n) {
    this.seen.hover = true; this.last = e;
    const t = performance.now();
    if (t - this.hoverT0 > 1000) { this.hoverHz = this.hoverN / ((t - this.hoverT0) / 1000 || 1); this.hoverN = 0; this.hoverT0 = t; }
    this.hoverN += n; this.show();
  },
  note(e) {
    if (e.pointerType === 'pen') this.seen.pen = true;
    if (e.pointerType === 'mouse') this.seen.mouse = true;
    if (e.tiltX || e.tiltY) this.seen.tilt = true;
    if (e.altitudeAngle != null && Math.abs(e.altitudeAngle - Math.PI / 2) > 1e-3) this.seen.altaz = true;
    if (e.twist) this.seen.twist = true;
    if (e.tangentialPressure) this.seen.tangential = true;
  },
  end(st) {
    const src = st.raw || st.samples;
    const s = src.filter((r, i) => i < src.length - 1 || st.cancelled);
    let pmin = Infinity, pmax = -Infinity;
    for (const r of s) { if (r[3] < pmin) pmin = r[3]; if (r[3] > pmax) pmax = r[3]; }
    if (!s.length) { pmin = pmax = 0; }
    if (pmax - pmin > 0.02) this.seen.pressureVaries = true;
    const gaps = []; for (let i = 1; i < s.length; i++) gaps.push(s[i][0] - s[i - 1][0]);
    gaps.sort((a, b) => a - b);
    const med = gaps.length ? gaps[gaps.length >> 1] : 0;
    const dur = s.length > 1 ? s[s.length - 1][0] - s[0][0] : 0;
    this.stroke = { n: s.length, hz: dur > 0 ? (s.length - 1) / (dur / 1000) : 0, med, pmin, pmax, type: st.pointer_type,
      coal: this.coal.length ? this.coal.reduce((a, b) => a + b, 0) / this.coal.length : 1 };
    this.show(true);
  },
  show(force) {
    if (!S.diag) return;
    const t = performance.now();
    if (!force && t - this.timer < 100) return;
    this.timer = t;
    const e = this.last, y = (b) => (b ? '<b>yes</b>' : '<span class="no">not seen</span>'), f = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));
    let h = '';
    if (e) {
      h += `Pointer: <b>${e.pointerType}</b>, pressure ${f(e.pressure, 3)}<br>`;
      h += `Tilt X/Y: ${f(e.tiltX, 0)}° / ${f(e.tiltY, 0)}°, twist ${f(e.twist, 0)}°<br>`;
      h += `Altitude/azimuth: ${f(e.altitudeAngle)} / ${f(e.azimuthAngle)} rad<br>`;
    } else h += 'Touch the screen with the pen.<br>';
    h += `Pressure varies: ${y(this.seen.pressureVaries)}<br>Tilt: ${y(this.seen.tilt || this.seen.altaz)}<br>`;
    h += `Twist (Art Pen only): ${y(this.seen.twist)}<br>`;
    h += `Hover: ${y(this.seen.hover)}${this.seen.hover ? `, ~${Math.round(this.hoverHz)} Hz` : ''}<br>`;
    const k = this.stroke;
    if (k) h += `Last stroke: ${k.n} samples, ${Math.round(k.hz)} Hz (median gap ${k.med.toFixed(1)} ms), pressure ${k.pmin.toFixed(2)}–${k.pmax.toFixed(2)}, ${k.coal.toFixed(1)} samples per event`;
    if (this.seen.mouse && !this.seen.pen) h += '<div class="note">The pen arrives as a mouse, so there is no pressure or tilt. On Windows, turn on Windows Ink in Wacom Tablet Properties.</div>';
    this.el.innerHTML = h;
  },
};
Diag.reset();
function setDiag(on) { S.diag = on; localStorage.setItem('nh-diag', on ? '1' : '0'); Diag.el.hidden = !on; if (on) Diag.show(true); }

/* ------------------------------------------------------------ UI */
const ICONS = {
  eraser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 16.5 13.5 7l5 5L9 21.5H6L4 19.5z"/><path d="M9 11.5l5 5M10 21.5h10"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>',
  part: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 15v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 19H5.5A1.5 1.5 0 0 1 4 17.5V15"/><circle cx="12" cy="9.5" r="2.4"/><path d="M8.6 15.5c.7-1.8 1.9-2.7 3.4-2.7s2.7.9 3.4 2.7"/></svg>',
  fill: '<svg viewBox="0 0 24 24"><path d="M5 7c3-3 9-4 13-1 3 3 1 8-2 10-4 3-10 3-12-1-1.5-3-1-6 1-8z" fill="currentColor"/></svg>',
  fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="8" y="8" width="8" height="8" rx="1"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
};
const nibThick = (w) => Math.max(1, Math.round(Math.sqrt(w) * 7));

function buildRail() {
  $('#eraser-btn').innerHTML = ICONS.eraser;
  $('#undo-btn').innerHTML = ICONS.undo;
  $('#redo-btn').innerHTML = ICONS.redo;
  $('#part-btn').innerHTML = ICONS.part + '<span class="lbl" id="part-lbl"></span><span class="badge top" id="part-depth"></span>';
  $('#fill-btn').innerHTML = ICONS.fill;
  $('#fit-btn').innerHTML = ICONS.fit;
  $('#menu-btn').innerHTML = ICONS.menu;
  buildNibs();
}
function buildNibs() {
  const er = S.tool === 'eraser';
  $('#nib-list').innerHTML = NIBS.map((w, i) =>
    `<button role="menuitemradio" data-w="${w}" title="${w} mm (${i + 1})"><i class="stroke" style="height:${Math.min(16, nibThick(w))}px"></i><small>${w}</small></button>`).join('');
  $('#nib-title').textContent = 'Width, mm';
  for (const id of ['#brush-seg', '#nib-title', '#nib-list', '.pop .smooth']) $(id).hidden = er;
  $('#erase-box').hidden = !er;
}
const BRUSH_ICON = {
  technical: '<line x1="5" y1="10" x2="19" y2="10" stroke="currentColor" stroke-linecap="round" stroke-width="W"/>',
  ink: '<path d="M4 11 C8 9.6 14 9.2 20 10 C14 11 8 11.4 4 11Z" fill="currentColor" stroke="currentColor" stroke-width="W" stroke-linejoin="round"/>',
  brush: '<path d="M3 13 C7 6 13 6 21 9 C14 9.5 9 11 3 13Z" fill="currentColor"/>',
};
function updateTools() {
  const nb = $('#nib-btn'), er = S.tool === 'eraser', w = S.width;
  const sw = Math.min(7, nibThick(w) / 1.6 + 0.6);
  const glyph = er ? `<line x1="5" y1="10" x2="19" y2="10" stroke="currentColor" stroke-linecap="round" stroke-dasharray="2 3" stroke-width="${sw}"/>`
    : BRUSH_ICON[S.brush].replace('W', S.brush === 'technical' ? sw : Math.max(0.5, sw / 3));
  nb.innerHTML = `<svg viewBox="0 0 24 24">${glyph}</svg><span>${w}</span>`;
  for (const b of document.querySelectorAll('#brush-seg button')) b.setAttribute('aria-pressed', String(!er && b.dataset.b === S.brush));
  nb.setAttribute('aria-label', er ? `Eraser, ${S.eraseMode === 'cut' ? 'cuts through lines' : 'deletes whole lines'}` : `Pen width ${w} mm, smoothing ${S.smoothing}`);
  for (const b of document.querySelectorAll('#erase-seg button')) b.setAttribute('aria-pressed', String(b.dataset.m === S.eraseMode));
  $('#erase-note').textContent = S.eraseMode === 'cut'
    ? `Cuts through lines where it passes, as wide as the pen (${w} mm).`
    : 'Deletes every line it touches, as it was drawn.';
  for (const b of document.querySelectorAll('#nib-list button')) b.setAttribute('aria-pressed', String(Number(b.dataset.w) === w));
  $('#smooth-range').value = S.smoothing;
  $('#smooth-val').textContent = S.smoothing;
  $('#eraser-btn').setAttribute('aria-pressed', String(S.tool === 'eraser'));
  const op = S.meta ? openPart() : null;
  $('#part-btn').setAttribute('aria-pressed', String(!!op));
  $('#part-lbl').textContent = op ? op.kind : S.kind;
  $('#part-depth').textContent = S.partStack.length > 1 ? S.partStack.length : '';
  $('#part-btn').setAttribute('aria-label', op ? `End ${op.kind}. Hold to start a part inside it` : `Start a ${S.kind}. Hold to choose the kind`);
  $('#fill-btn').setAttribute('aria-pressed', String(S.fill));
  $('#undo-btn').disabled = !S.strokes.some((s) => !s.undone_at);
  $('#redo-btn').disabled = !S.redo.length;
}
function placePop(pop, btn) {
  const r = btn.getBoundingClientRect();
  pop.hidden = false;
  const pr = pop.getBoundingClientRect();
  if (window.innerWidth > window.innerHeight) { pop.style.left = (r.right + 8) + 'px'; pop.style.top = Math.max(8, Math.min(r.top, window.innerHeight - pr.height - 8)) + 'px'; }
  else { pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 8)) + 'px'; pop.style.top = (r.top - pr.height - 8) + 'px'; }
}
function showNibs() { $('#part-pop').hidden = true; placePop($('#nib-pop'), $('#nib-btn')); }
function hideNibs() { $('#nib-pop').hidden = true; $('#part-pop').hidden = true; }
// the part button's menu: choose a kind (starts a part, inside the open one if any)
function showParts() {
  if (!S.meta) return;
  hideNibs();
  const op = openPart();
  $('#part-title').textContent = op ? `Start a part inside ${op.kind}` : 'Start a part';
  $('#kind-list').innerHTML = kindsList().map((k) => `<button role="menuitem" data-k="${escHtml(k)}" aria-pressed="${k === S.kind}">${escHtml(k)}</button>`).join('');
  $('#part-end').hidden = !op;
  if (op) $('#part-end').textContent = `End ${op.kind}`;
  placePop($('#part-pop'), $('#part-btn'));
}
// tap and hold (or right-click) on one button
function bindHold(btn, onTap, onHold) {
  let timer = 0, held = false;
  btn.addEventListener('pointerdown', (e) => { held = false; clearTimeout(timer); if (e.button === 0) timer = setTimeout(() => { held = true; onHold(); }, 450); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, () => clearTimeout(timer));
  btn.addEventListener('contextmenu', (e) => { e.preventDefault(); clearTimeout(timer); if (!held) onHold(); });
  btn.addEventListener('click', () => { if (held) { held = false; return; } onTap(); });
}
function renderKinds() {
  $('#kinds-list').innerHTML = loadKinds().map((k) => `<div class="krow"><span>${escHtml(k)}</span><button class="btn" data-del="${escHtml(k)}">Remove</button></div>`).join('');
}
function openKinds() { hideNibs(); renderKinds(); $('#kind-new').value = ''; $('#kinds-dlg').showModal(); }
function addKind() {
  const v = $('#kind-new').value.trim().replace(/\s+/g, ' ').slice(0, 30);
  if (!v) return;
  const ks = loadKinds();
  if (!ks.some((k) => k.toLowerCase() === v.toLowerCase())) { ks.push(v); saveKinds(ks); }
  $('#kind-new').value = '';
  renderKinds();
}
function removeKind(name) {
  const ks = loadKinds().filter((k) => k !== name);
  if (!ks.length) { toast('Keep at least one kind.'); return; }
  saveKinds(ks);
  if (S.kind === name) { S.kind = ks[0]; localStorage.setItem('nh-kind', S.kind); updateTools(); }
  renderKinds();
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
}
function setSaveState(text, warn) { const c = $('#save-chip'); c.textContent = text; c.classList.toggle('warn', !!warn); }
function updateDriveChip() {
  const c = $('#drive-chip');
  let text, warn = false;
  if (syncing) text = 'Syncing…';
  else if (!Drive.ready()) { text = Drive.wasConnected() ? 'Reconnect Drive' : 'Drive off'; warn = Drive.wasConnected(); }
  else if (syncError) { text = 'Sync failed'; warn = true; }
  else if (S.meta && (S.meta.rev || 0) > (S.meta.synced_rev || 0)) text = 'Not synced yet';
  else text = lastSync ? `Synced ${pad2(lastSync.getHours())}:${pad2(lastSync.getMinutes())}` : 'Drive on';
  c.textContent = text; c.classList.toggle('warn', warn);
  const mt = $('#m-drive-text');
  if (mt) mt.textContent = !Drive.ready()
    ? (Drive.wasConnected() ? 'Sign-in expired. Reconnect to keep syncing.' : 'Not connected. Drawings stay on this device until you connect.')
    : (syncError ? `Last sync failed: ${syncError}` : 'Connected. Drawings sync to the folder Natural Hand while you pause.');
}

function openMenu() {
  hideNibs();
  const m = S.meta;
  $('#m-title').value = m ? m.title || '' : '';
  $('#m-tags').value = m ? (m.tags || []).join(', ') : '';
  $('#m-notes').value = m ? m.notes || '' : '';
  $('#m-dev-name').value = S.device.name;
  $('#m-dev-pressure').value = S.device.pressure_setting || '';
  $('#m-dev-scale').textContent = S.device.calibrated
    ? `Calibrated: ${S.device.ppmm.toFixed(3)} screen px per mm.`
    : 'Not calibrated yet. Stroke sizes in mm will be wrong until you calibrate.';
  $('#m-touch').checked = S.touchNav;
  $('#m-penbtn').checked = S.penButtonFigure;
  $('#m-feel').value = feelFromGamma(S.device.pressure_gamma || 1);
  drawFeelCurve();
  $('#m-diag').checked = S.diag;
  $('#menu-title').textContent = m ? (m.title || m.id) : 'Drawing';
  $('#m-foot').textContent = `Natural Hand ${APP_VERSION}. ${m ? `${m.stroke_count || 0} strokes, ${Object.values(m.parts || {}).filter((p) => !p.removed_at).length} parts in this drawing.` : ''}`;
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then((est) => {
    $('#m-foot').textContent += ` Using ${(est.usage / 1048576).toFixed(1)} MB on this device.`;
  });
  updateDriveChip();
  $('#menu').showModal();
}
function metaEdit() {
  if (!S.meta) return;
  S.meta.title = $('#m-title').value.trim();
  S.meta.tags = $('#m-tags').value.split(',').map((t) => t.trim()).filter(Boolean);
  S.meta.notes = $('#m-notes').value;
  markChanged();
}
function deviceEdit() {
  S.device.name = $('#m-dev-name').value.trim() || S.device.name;
  S.device.pressure_setting = $('#m-dev-pressure').value.trim();
  saveDevice(S.device);
}

async function openList() {
  if (S.meta) await flushMeta();
  const metas = (await DB.all('drawings')).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  const list = $('#list');
  list.innerHTML = '';
  if (!metas.length) list.innerHTML = '<p>No drawings yet. Start one with New drawing.</p>';
  for (const m of metas) {
    const el = document.createElement('div');
    el.className = 'item' + (S.meta && S.meta.id === m.id ? ' current' : '');
    const synced = (m.rev || 0) <= (m.synced_rev || 0) && m.synced_at ? 'in Drive' : 'not in Drive yet';
    el.innerHTML = `<img alt="" src="${m.thumb || ''}"><div><div class="name"></div><div class="meta">${m.paper.name}, ${m.stroke_count || 0} strokes, ${synced}</div></div>
      <div class="acts"><button class="btn" data-a="open">Open</button><button class="btn" data-a="json">JSON</button><button class="btn danger" data-a="del">Delete</button></div>`;
    el.querySelector('.name').textContent = m.title || m.id;
    el.querySelector('[data-a=open]').onclick = async () => { $('#list-dlg').close(); $('#menu').close(); await openDrawing(m.id); };
    el.querySelector('[data-a=json]').onclick = () => exportJson(m.id);
    el.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm(`Delete "${m.title || m.id}" from this device? A copy in Google Drive, if synced, stays and can be opened again.`)) return;
      await DB.deleteDrawing(m.id);
      if (S.meta && S.meta.id === m.id) { S.meta = null; S.paper = null; S.strokes = []; localStorage.removeItem('nh-last'); requestRender(); }
      openList();
    };
    list.appendChild(el);
  }
  if (!$('#list-dlg').open) $('#list-dlg').showModal();
  listRemote(new Set(metas.map((m) => m.id)));
}
async function listRemote(localIds) {
  const box = $('#remote-list'), txt = $('#remote-text');
  box.innerHTML = '';
  if (!Drive.ready()) {
    txt.textContent = 'Connect Google Drive to see drawings from your other devices.';
    $('#remote-connect').hidden = false;
    return;
  }
  $('#remote-connect').hidden = true;
  txt.textContent = 'Looking in Google Drive…';
  try {
    const files = (await Drive.list(await Drive.folder())).filter((f) => !localIds.has(f.name.replace(/\.json\.gz$/, '')));
    txt.textContent = files.length ? 'These are in Drive but not on this device yet.' : 'Every drawing in Drive is already on this device.';
    for (const f of files) {
      const id = f.name.replace(/\.json\.gz$/, ''), p = f.appProperties || {};
      const el = document.createElement('div');
      el.className = 'item';
      const when = new Date(f.modifiedTime);
      el.innerHTML = `<div class="ph"></div><div><div class="name"></div><div class="meta"></div></div><div class="acts"><button class="btn primary" data-a="get">Open</button></div>`;
      el.querySelector('.name').textContent = p.title || id;
      el.querySelector('.meta').textContent = `${p.paper ? p.paper + ', ' : ''}${p.strokes ? p.strokes + ' strokes, ' : ''}changed ${when.toLocaleDateString()} ${pad2(when.getHours())}:${pad2(when.getMinutes())}`;
      el.querySelector('[data-a=get]').onclick = async (ev) => {
        ev.target.disabled = true; ev.target.textContent = 'Getting…';
        try {
          const newId = await importRemote(f);
          $('#list-dlg').close(); $('#menu').close();
          await openDrawing(newId);
        } catch (err) { toast(err.message); ev.target.disabled = false; ev.target.textContent = 'Open'; }
      };
      box.appendChild(el);
    }
  } catch (err) { txt.textContent = err.message; }
}

/* calibration */
let calibPx = 0, calibThen = null;
function calibUpdate() {
  const ref = Number($('#c-ref').value);
  $('#c-bar').style.width = calibPx + 'px';
  $('#c-range').value = calibPx;
  $('#c-val').textContent = `${(calibPx / ref).toFixed(3)} px per mm`;
}
function openCalib(then) {
  calibThen = then || null;
  const ref = Number($('#c-ref').value);
  $('#calib-dlg').showModal();
  const max = Math.max(200, $('.ruler').clientWidth - 2);
  $('#c-range').max = max; $('#c-range').min = 80;
  calibPx = clamp((S.device && S.device.calibrated ? S.device.ppmm : (Math.min(screen.width, screen.height) < 600 ? 5.8 : DEFAULT_PPMM)) * ref, 80, max);
  calibUpdate();
}
function saveCalib() {
  const ppmm = calibPx / Number($('#c-ref').value);
  S.device.ppmm = rnd(ppmm, 5); S.device.calibrated = true; S.device.calibrated_at = new Date().toISOString();
  saveDevice(S.device);
  S.ppmm = S.device.ppmm;
  $('#calib-dlg').close();
  if (S.meta) fit();
  toast('Calibration saved.');
  const t = calibThen; calibThen = null; if (t) t();
}

function bindUI() {
  view.addEventListener('pointerdown', onDown);
  view.addEventListener('pointermove', onMove);
  view.addEventListener('pointerup', onUp);
  view.addEventListener('pointercancel', onCancel);
  view.addEventListener('contextmenu', (e) => e.preventDefault());
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!S.meta) return;
    const D = screenToDoc(e.clientX, e.clientY);
    if (e.shiftKey) setViewAround(D, e.clientX, e.clientY, S.view.s, S.view.r + (e.deltaY || e.deltaX) * 0.003);
    else setViewAround(D, e.clientX, e.clientY, clamp(S.view.s * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), 0.03, 60), S.view.r);
    requestRender(); persistViewSoon();
  }, { passive: false });

  $('#nib-btn').onclick = () => ($('#nib-pop').hidden ? showNibs() : hideNibs());
  $('#nib-list').onclick = (e) => { const b = e.target.closest('button'); if (b) { setNib(Number(b.dataset.w)); hideNibs(); } };
  $('#smooth-range').oninput = (e) => setSmoothing(Number(e.target.value));
  $('#brush-seg').onclick = (e) => { const b = e.target.closest('button'); if (b) setBrush(b.dataset.b); };
  $('#erase-seg').onclick = (e) => { const b = e.target.closest('button'); if (b) { setEraseMode(b.dataset.m); hideNibs(); } };
  $('#eraser-btn').onclick = toggleEraser;
  $('#undo-btn').onclick = undo;
  $('#redo-btn').onclick = redo;
  bindHold($('#part-btn'), () => togglePart('button'), showParts);
  $('#kind-list').onclick = (e) => { const b = e.target.closest('button'); if (b) { hideNibs(); startPart(b.dataset.k, 'menu'); } };
  $('#part-end').onclick = () => { hideNibs(); endPart('menu'); };
  $('#kinds-edit').onclick = openKinds;
  $('#kind-add').onclick = addKind;
  $('#kind-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addKind(); } });
  $('#kinds-list').onclick = (e) => { const b = e.target.closest('[data-del]'); if (b) removeKind(b.dataset.del); };
  $('#kinds-close').onclick = () => { $('#kinds-dlg').close(); if (Replay.lab) Replay.fillKinds(); };
  $('#fill-btn').onclick = toggleFill;
  $('#fit-btn').onclick = fit;
  $('#menu-btn').onclick = openMenu;
  $('#drive-chip').onclick = () => syncAll(true);
  $('#save-chip').onclick = () => flushMeta();

  for (const id of ['#m-title', '#m-tags', '#m-notes']) $(id).addEventListener('change', metaEdit);
  for (const id of ['#m-dev-name', '#m-dev-pressure']) $(id).addEventListener('change', deviceEdit);
  $('#m-touch').onchange = (e) => { S.touchNav = e.target.checked; localStorage.setItem('nh-touch', S.touchNav ? '1' : '0'); };
  $('#m-diag').onchange = (e) => setDiag(e.target.checked);
  $('#m-penbtn').onchange = (e) => { S.penButtonFigure = e.target.checked; localStorage.setItem('nh-penbtn', S.penButtonFigure ? '1' : '0'); };
  $('#m-feel').oninput = () => drawFeelCurve();
  $('#m-feel').onchange = (e) => { S.device.pressure_gamma = gammaFromFeel(Number(e.target.value)); saveDevice(S.device); toast('Pressure feel saved for this device. It applies to new strokes.'); };
  $('#m-replay').onclick = () => Replay.open();
  $('#m-video').onclick = () => Video.open();
  $('#rp-video').onclick = () => Video.open();
  for (const id of ['#v-shape', '#v-res', '#v-len', '#v-fps', '#v-q', '#v-skip']) $(id).addEventListener('change', () => Video.info());
  $('#v-go').onclick = () => Video.make();
  $('#v-save').onclick = () => Video.file && download(Video.file.name, Video.file);
  $('#v-share').onclick = async () => { try { await navigator.share({ files: [Video.file], title: S.meta.title || 'Drawing' }); } catch (err) { if (err.name !== 'AbortError') toast(err.message); } };
  $('#v-cancel').onclick = () => { if (Video.busy) Video.cancel = true; else $('#video-dlg').close(); };
  $('#video-dlg').addEventListener('cancel', (e) => { if (Video.busy) { e.preventDefault(); Video.cancel = true; } });
  $('#m-image').onclick = () => { $('#menu').close(); openExport(); };
  $('#m-prompt').onclick = () => { $('#prompt-dlg').showModal(); };
  $('#x-format').onchange = updateExportInfo;
  $('#x-res').onchange = updateExportInfo;
  $('#x-save').onclick = () => doExport(false);
  $('#x-share').onclick = () => doExport(true);
  $('#x-cancel').onclick = () => $('#export-dlg').close();
  $('#pr-kind').onchange = (e) => { $('#pr-custom-row').hidden = e.target.value !== 'custom'; };
  $('#pr-start').onclick = () => startPrompt();
  $('#pr-cancel').onclick = () => $('#prompt-dlg').close();
  $('#prompt-chip').onclick = () => { if (S.prompt && confirm(`End the session "${S.prompt.text}" now?`)) endPrompt(false); };
  $('#zoom-chip').onclick = lifeSize;
  $('#rp-play').onclick = () => (Replay.playing ? Replay.pause() : Replay.play());
  $('#rp-close').onclick = () => Replay.close();
  $('#rp-label').onclick = () => Replay.setLab(!Replay.lab);
  $('#lab-from').onclick = () => Replay.fromHere();
  $('#lab-go').onclick = () => Replay.label();
  $('#lab-list').onclick = () => openPartsList();
  $('#m-parts').onclick = () => { $('#menu').close(); openPartsList(); };
  $('#parts-list').addEventListener('change', (e) => { const el = e.target.closest('[data-kind]'); if (el) setPartKind(el.dataset.kind, el.value); });
  $('#parts-list').onclick = (e) => {
    const sh = e.target.closest('[data-show]');
    if (sh) { $('#parts-dlg').close(); Replay.show(sh.dataset.show); return; }
    const rm = e.target.closest('[data-rm]');
    if (rm) removePart(rm.dataset.rm);
  };
  $('#parts-close').onclick = () => $('#parts-dlg').close();
  $('#parts-kinds').onclick = () => { $('#parts-dlg').close(); openKinds(); };
  $('#rp-seek').oninput = (e) => { Replay.pause(); Replay.seek((Number(e.target.value) / 1000) * Replay.total); };
  $('#rp-speed').onchange = (e) => { Replay.speed = Number(e.target.value); };
  $('#rp-skip').onchange = (e) => { const frac = Replay.total ? Replay.t / Replay.total : 0; Replay.skip = e.target.checked; Replay.build(); Replay.seek(frac * Replay.total); };
  $('#n-paper').onchange = (e) => { $('#n-orient-row').hidden = ['Endless', 'Square'].includes(e.target.value); };

  $('#m-close').onclick = () => $('#menu').close();
  $('#m-new').onclick = () => { $('#n-paper').value = defaultPaper(); $('#n-title').value = ''; $('#new-dlg').showModal(); };
  $('#m-list').onclick = openList;
  $('#m-export').onclick = () => S.meta && exportJson(S.meta.id);
  $('#m-drive-connect').onclick = async () => { if (await connectDrive()) syncAll(false); };
  $('#m-drive-sync').onclick = () => syncAll(true);
  $('#m-calib').onclick = () => openCalib();
  $('#list-close').onclick = () => $('#list-dlg').close();
  $('#remote-connect').onclick = async () => { if (await connectDrive()) openList(); };
  $('#n-cancel').onclick = () => $('#new-dlg').close();
  $('#n-create').onclick = async () => {
    $('#new-dlg').close(); $('#menu').close();
    await newDrawing($('#n-paper').value, $('#n-orient').value === 'l', $('#n-title').value.trim());
  };
  $('#c-range').oninput = (e) => { calibPx = Number(e.target.value); calibUpdate(); };
  $('#c-minus').onclick = () => { calibPx = Math.max(80, calibPx - 0.5); calibUpdate(); };
  $('#c-plus').onclick = () => { calibPx = Math.min(Number($('#c-range').max), calibPx + 0.5); calibUpdate(); };
  $('#c-ref').onchange = () => calibUpdate();
  $('#c-save').onclick = saveCalib;
  $('#c-cancel').onclick = () => { $('#calib-dlg').close(); const t = calibThen; calibThen = null; if (t) t(); };
  $('#s-next').onclick = () => {
    const name = $('#s-name').value.trim();
    if (!name) { $('#s-name').focus(); return; }
    S.device = { id: `${Date.now().toString(36)}-${uid()}`, name, ppmm: DEFAULT_PPMM, calibrated: false, pressure_setting: '' };
    saveDevice(S.device);
    $('#setup-dlg').close();
    openCalib(startDrawing);
  };
  $('#setup-dlg').addEventListener('cancel', (e) => e.preventDefault());

  addEventListener('keydown', (e) => {
    if (S.loading || document.querySelector('dialog[open]') || (e.target.closest && e.target.closest('input,textarea,select'))) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (Replay.on) {
      if (k === ' ') { e.preventDefault(); Replay.playing ? Replay.pause() : Replay.play(); }
      else if (k === 'escape') { if (Replay.lab) Replay.setLab(false); else Replay.close(); }
      else if (k === '0') fit();
      return;
    }
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod) return;
    else if (k === ' ') { spaceDown = true; view.style.cursor = 'grab'; e.preventDefault(); }
    else if (k >= '1' && k <= '7') setNib(NIBS[Number(k) - 1]);
    else if (k === 'b') { const ks = Object.keys(BRUSHES); setBrush(ks[(ks.indexOf(S.brush) + 1) % ks.length]); }
    else if (k === '[') setSmoothing(S.smoothing - 10);
    else if (k === ']') setSmoothing(S.smoothing + 10);
    else if (k === 'e') toggleEraser();
    else if (k === 'f') { if (e.shiftKey) showParts(); else togglePart('key'); }
    else if (k === 'g') toggleFill();
    else if (k === '0') fit();
    else if (k === 'l') lifeSize();
    else if (k === 'r') Replay.open();
    else if (k === 'd') setDiag(!S.diag);
  });
  addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; view.style.cursor = ''; } });
  addEventListener('resize', () => { resize(); hideNibs(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readSurround(); invalidateSharp(); requestRender(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { flushMeta(); awayStart(); }
    else awayEnd();
  });
  addEventListener('pagehide', () => flushMeta());
  addEventListener('online', () => autoSync());
}

async function startDrawing() {
  const last = localStorage.getItem('nh-last');
  Loader.set(0, 'Opening storage');
  if (last && await DB.get('drawings', last)) await openDrawing(last);
  else await newDrawing(defaultPaper(), false, '');
}

// ---------- app updates ----------
// The service worker installs a new version in the background and takes over this page.
// The page keeps running the old code until it reloads, so offer a reload (never forced mid-drawing).
function watchForUpdates() {
  if (!('serviceWorker' in navigator) || !(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
  const hadController = !!navigator.serviceWorker.controller; // false on the very first install: nothing old is running
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) $('#update-chip').hidden = false; });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const check = () => reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    setInterval(check, 30 * 60 * 1000);
  }).catch(() => {});
  $('#update-chip').onclick = async () => {
    const c = $('#update-chip'); c.disabled = true; c.textContent = 'Saving…';
    await waitIdle();
    while (performance.now() - S.lastPen < 800) await new Promise((r) => setTimeout(r, 200)); // let the last stroke reach storage
    await flushMeta();
    location.reload();
  };
}

async function init() {
  syncClock();
  readSurround();
  resize();
  buildRail();
  S.width = NIBS.includes(Number(localStorage.getItem('nh-nib'))) ? Number(localStorage.getItem('nh-nib')) : 0.3;
  S.eraseMode = localStorage.getItem('nh-erase-mode') === 'cut' ? 'cut' : 'stroke';
  S.smoothing = clamp(Number(localStorage.getItem('nh-smooth')) || 0, 0, 100);
  S.brush = BRUSHES[localStorage.getItem('nh-brush')] ? localStorage.getItem('nh-brush') : 'technical';
  bindUI();
  updateTools();
  setDiag(S.diag);
  $('#ld-retry').onclick = () => location.reload();
  $('#ld-new').onclick = () => { $('#ld-acts').hidden = true; newDrawing(defaultPaper(), false, ''); };
  try { await DB.open(); }
  catch (err) { Loader.fail('This browser blocked local storage, so drawings cannot be saved: ' + err.message); $('#ld-new').hidden = true; return; }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  watchForUpdates();
  Drive.restore();
  updateDriveChip();
  setInterval(autoSync, 20000);
  S.device = loadDevice();
  if (!S.device) { Loader.hide(); $('#setup-dlg').showModal(); return; }
  S.ppmm = S.device.ppmm;
  await startDrawing();
}

// test hook (used by automated checks; harmless in normal use)
window.__nh = { S, openDrawing, Loader, applyRemote, buildExport, undo, redo, togglePart, startPart, endPart, migrateFigures, partMembers, fit, Drive, syncAll, mergeData, Replay, Video };

init();
})();
