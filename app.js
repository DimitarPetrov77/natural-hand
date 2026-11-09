/* Natural Hand — capture app
 * Records every pen sample (position, time, pressure, tilt, hover) as raw data,
 * renders it as a technical pen, stores locally in IndexedDB and syncs to Google Drive.
 *
 * Coordinates: paper millimetres, origin top-left of the sheet.
 * Screen mapping (CSS px): screen = R(rot) * (doc * ppmm * zoom) + (tx, ty)
 */
'use strict';
(() => {

const APP_VERSION = '0.1.1';
const FORMAT = 'natural-hand/1';
const SAMPLE_FIELDS = ['dt_ms','x_mm','y_mm','pressure','tiltX','tiltY','twist','altitude','azimuth','tangential','width_px','height_px','buttons'];
const PAPERS = { A5:[148,210], A4:[210,297], A3:[297,420] };
const NIBS = [0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2.0];
const MAX_BITMAP = 4096;       // paper bitmap edge, px (mobile canvas limit safe)
const PALM_MS = 800;           // ignore finger touches this long after pen activity
const HOVER_LIMIT = 30000;     // max hover samples kept between two strokes
const DEFAULT_PPMM = 96 / 25.4; // CSS nominal; calibration replaces it

const $ = (s) => document.querySelector(s);
const rnd = (v, d) => { const m = 10 ** d; return Math.round(v * m) / m; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const absTime = (e) => performance.timeOrigin + e.timeStamp;
const absNow = () => performance.timeOrigin + performance.now();
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
  strokes(id) { return this.read('strokes', (s) => s.getAll(IDBKeyRange.bound([id, 0], [id, Infinity]))); },
  events(id) { return this.read('events', (s) => s.index('drawing').getAll(id)); },
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
  paperSize: [210, 297],
  view: { s: 1, r: 0, tx: 0, ty: 0 },
  tool: 'pen',
  width: 0.3,
  figure: null,
  fill: false,
  active: null,        // {st, id}
  hover: [],
  hoverDropped: 0,
  redo: [],
  sessionId: null,
  sessionLogged: false,
  lastPen: -1e9,
  touchNav: localStorage.getItem('nh-touch') !== '0',
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
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  if (S.paper && sharpKey === viewKey()) { vctx.drawImage(sharp, 0, 0); return; }
  vctx.fillStyle = surround;
  vctx.fillRect(0, 0, view.width, view.height);
  if (!S.paper) return;
  const v = S.view, k = S.ppmm * v.s, [W, H] = S.paperSize;
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vctx.translate(v.tx, v.ty);
  vctx.rotate(v.r);
  vctx.scale(k, k);
  vctx.imageSmoothingEnabled = true;
  vctx.imageSmoothingQuality = 'high';
  vctx.drawImage(S.paper.c, 0, 0, W, H);
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
function clipPaper(ctx) { const [W, H] = S.paperSize; ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip(); }
function renderSharp() {
  if (!S.paper) return;
  if (gesture || mousePan) { scheduleSharp(); return; }
  if (sharp.width !== view.width || sharp.height !== view.height) { sharp.width = view.width; sharp.height = view.height; }
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.fillStyle = surround;
  sctx.fillRect(0, 0, sharp.width, sharp.height);
  applyView(sctx);
  const [W, H] = S.paperSize;
  sctx.fillStyle = '#ffffff';
  sctx.fillRect(0, 0, W, H);
  sctx.save(); clipPaper(sctx);
  const r = visibleDocRect();
  for (const st of S.strokes) {
    if (st.undone_at) continue;
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
  const [W, H] = S.paperSize, pad = 24;
  const rr = $('#rail').getBoundingClientRect();
  let L = 0, B = 0;
  if (rr.height > rr.width) L = rr.right; else B = ch - rr.top;
  const aw = cw - L - pad * 2, ah = ch - B - pad * 2 - 30;
  const s = Math.max(0.02, Math.min(aw / (W * S.ppmm), ah / (H * S.ppmm)));
  const k = S.ppmm * s;
  S.view = { s, r: 0, tx: L + pad + (aw - W * k) / 2, ty: pad + 30 + (ah - H * k) / 2 };
  persistViewSoon();
  requestRender();
}

/* ------------------------------------------------------------ paper ink */
function makePaper(W, H) {
  const K = Math.min(MAX_BITMAP / W, MAX_BITMAP / H, 16);
  const c = document.createElement('canvas');
  c.width = Math.round(W * K); c.height = Math.round(H * K);
  const x = c.getContext('2d');
  return { c, x, K };
}
function inkOf(st) { return st.tool === 'eraser' ? '#ffffff' : '#000000'; }
function drawStroke(ctx, st, from = 0) {
  const s = st.samples, n = s.length;
  if (!n) return;
  ctx.strokeStyle = ctx.fillStyle = inkOf(st);
  ctx.lineWidth = st.width_mm;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (from === 0) {
    ctx.beginPath(); ctx.arc(s[0][1], s[0][2], st.width_mm / 2, 0, Math.PI * 2); ctx.fill();
    if (n === 1) return;
  }
  const a = Math.max(1, from);
  if (a >= n) return;
  ctx.beginPath();
  ctx.moveTo(s[a - 1][1], s[a - 1][2]);
  for (let i = a; i < n; i++) ctx.lineTo(s[i][1], s[i][2]);
  ctx.stroke();
}
function paintAll(ctx, strokes, W, H, K) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(K, 0, 0, K, 0, 0);
  for (const st of strokes) if (!st.undone_at) drawStroke(ctx, st);
}
function repaint() {
  const { x, K } = S.paper;
  paintAll(x, S.strokes, S.paperSize[0], S.paperSize[1], K);
  invalidateSharp();
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
  if (!S.meta || document.querySelector('dialog[open]')) return;
  hideNibs();
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
    figure: S.figure,
    tags: S.fill ? ['fill'] : [],
    pointer_type: e.pointerType,
    view: [rnd(S.view.s, 6), rnd(S.view.r, 6), rnd(S.view.tx, 2), rnd(S.view.ty, 2)],
    ppmm: rnd(S.ppmm, 5),
    hover: h,
    hover_dropped: dropped,
    samples: [sampleOf(e, t0)],
    undone_at: null,
    cancelled: false,
  };
  S.active = { st, id: e.pointerId };
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
  if (mousePan) {
    S.view.tx = mousePan.v.tx + e.clientX - mousePan.x;
    S.view.ty = mousePan.v.ty + e.clientY - mousePan.y;
    requestRender();
    return;
  }
  const list = coalesced(e);
  if (S.active && e.pointerId === S.active.id) {
    const st = S.active.st, from = st.samples.length;
    for (const ce of list) st.samples.push(sampleOf(ce, st.t0));
    inkLive(st, from);
    requestRender();
    S.lastPen = performance.now();
    Diag.move(e, list.length);
    return;
  }
  if (e.pointerType === 'pen' && e.buttons === 0 && S.meta) {
    for (const ce of list) S.hover.push(sampleOf(ce, 0));
    trimHover();
    S.lastPen = performance.now();
    Diag.hover(e, list.length);
  }
}

function onUp(e) {
  if (e.pointerType === 'touch') { endTouch(e); return; }
  if (mousePan) { mousePan = null; persistViewSoon(); return; }
  if (S.active && e.pointerId === S.active.id) finish(e, false);
}
function onCancel(e) {
  if (e.pointerType === 'touch') { endTouch(e); return; }
  if (mousePan) { mousePan = null; return; }
  if (S.active && e.pointerId === S.active.id) finish(e, true);
}
function finish(e, cancelled) {
  const st = S.active.st;
  if (cancelled) st.cancelled = true;
  else {
    const from = st.samples.length;
    st.samples.push(sampleOf(e, st.t0)); // pen-up event (pressure 0)
    inkLive(st, from);
  }
  S.active = null;
  S.lastPen = performance.now();
  saveStroke(st);
  markChanged();
  Diag.end(st);
  requestRender();
}
function saveStroke(st) {
  DB.put('strokes', st).catch((err) => { toast('Could not save a stroke: ' + err.message); setSaveState('Save failed', true); });
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
  if (S.active) return;
  for (let i = S.strokes.length - 1; i >= 0; i--) {
    const st = S.strokes[i];
    if (!st.undone_at) {
      st.undone_at = rnd(absNow(), 3);
      S.redo.push(i);
      saveStroke(st); logEvent('undo', { stroke: i });
      repaint(); markChanged(); updateTools();
      return;
    }
  }
}
function redo() {
  if (S.active || !S.redo.length) return;
  const i = S.redo.pop(), st = S.strokes[i];
  st.undone_at = null;
  saveStroke(st); logEvent('redo', { stroke: i });
  repaint(); markChanged(); updateTools();
}
function setNib(w) { S.width = w; localStorage.setItem('nh-nib', String(w)); updateTools(); }
function toggleEraser() { S.tool = S.tool === 'eraser' ? 'pen' : 'eraser'; updateTools(); }
function toggleFigure() {
  if (!S.meta) return;
  if (S.figure == null) {
    S.meta.figure_count = (S.meta.figure_count || 0) + 1;
    S.figure = S.meta.figure_count;
    logEvent('figure_start', { figure: S.figure });
    toast(`Figure ${S.figure}: strokes are being marked`);
  } else {
    logEvent('figure_end', { figure: S.figure });
    S.figure = null;
  }
  markChanged(); updateTools();
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
  const [W, H] = S.paperSize, k = 120 / Math.max(W, H);
  const c = document.createElement('canvas'); c.width = Math.round(W * k); c.height = Math.round(H * k);
  c.getContext('2d').drawImage(S.paper.c, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}
async function flushMeta() {
  clearTimeout(metaTimer);
  if (!S.meta) return;
  S.meta.updated = new Date().toISOString();
  try { S.meta.thumb = makeThumb(); } catch {}
  try { await DB.put('drawings', S.meta); setSaveState('Saved'); }
  catch (err) { setSaveState('Save failed', true); toast('Could not save drawing: ' + err.message); }
  updateDriveChip();
}
function newId() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}_${uid().slice(0, 4)}`;
}
async function newDrawing(paperName, landscape, title) {
  const [a, b] = PAPERS[paperName] || PAPERS.A4;
  const [W, H] = landscape ? [b, a] : [a, b];
  const now = new Date().toISOString();
  const meta = {
    id: newId(), format: FORMAT, title: title || '', created: now, updated: now,
    paper: { name: paperName, w_mm: W, h_mm: H },
    tags: [], notes: '', sessions: [], figure_count: 0, stroke_count: 0,
    rev: 0, synced_rev: 0, drive: {}, view: null,
  };
  await DB.put('drawings', meta);
  await openDrawing(meta.id);
}
async function openDrawing(id) {
  if (S.meta) await flushMeta();
  const meta = await DB.get('drawings', id);
  if (!meta) { toast('That drawing is no longer on this device.'); return; }
  const strokes = (await DB.strokes(id)).sort((a, b) => a.i - b.i);
  Object.assign(S, {
    meta, strokes, redo: [], figure: null, fill: false, hover: [], hoverDropped: 0, active: null,
    paperSize: [meta.paper.w_mm, meta.paper.h_mm], sessionId: `${Date.now().toString(36)}-${uid()}`, sessionLogged: false,
  });
  S.paper = makePaper(meta.paper.w_mm, meta.paper.h_mm);
  repaint();
  localStorage.setItem('nh-last', id);
  if (meta.view) S.view = { ...meta.view }; else fit();
  updateTools(); setSaveState('Saved'); updateDriveChip();
  requestRender();
}
function defaultPaper() { return Math.min(screen.width, screen.height) < 600 ? 'A5' : 'A4'; }

async function buildExport(id) {
  const cur = S.meta && S.meta.id === id;
  const meta = cur ? S.meta : await DB.get('drawings', id);
  let strokes = cur ? S.strokes.filter((s) => !S.active || s !== S.active.st) : (await DB.strokes(id)).sort((a, b) => a.i - b.i);
  const events = await DB.events(id);
  const { thumb, drive, rev, synced_rev, synced_at, view: _v, ...m } = meta;
  return {
    ...m,
    format: FORMAT,
    exported: new Date().toISOString(),
    exported_by: `natural-hand ${APP_VERSION}`,
    sample_fields: SAMPLE_FIELDS,
    units: {
      coordinates: 'x_mm, y_mm in paper millimetres, origin at top-left of the sheet',
      t0: 'stroke start, epoch milliseconds (high resolution)',
      dt_ms: 'milliseconds since the stroke t0; negative in hover (pen in the air before the stroke)',
      last_sample: 'the final sample of a stroke is the pen-up event (pressure 0) unless the stroke was cancelled',
      angles: 'tiltX, tiltY, twist in degrees; altitude, azimuth in radians; null when the browser does not report them',
      view: '[zoom, rotation_rad, tx_px, ty_px]; screen_css_px = R(rotation) * (doc_mm * ppmm * zoom) + (tx, ty)',
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
async function exportJson(id) {
  const data = await buildExport(id);
  download(`${id}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
}
async function previewPng(id) {
  const cur = S.meta && S.meta.id === id;
  const meta = cur ? S.meta : await DB.get('drawings', id);
  const strokes = cur ? S.strokes : (await DB.strokes(id)).sort((a, b) => a.i - b.i);
  const W = meta.paper.w_mm, H = meta.paper.h_mm, K = Math.min(6, 2400 / Math.max(W, H));
  const c = document.createElement('canvas'); c.width = Math.round(W * K); c.height = Math.round(H * K);
  paintAll(c.getContext('2d'), strokes, W, H, K);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}
async function gzip(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Blob([buf], { type: 'application/gzip' });
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
  async put(name, blob, fileId, folder) {
    const send = (fid) => {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(fid ? { name } : { name, parents: [folder] })], { type: 'application/json' }));
      form.append('file', blob);
      const url = fid
        ? `https://www.googleapis.com/upload/drive/v3/files/${fid}?uploadType=multipart&fields=id`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
      return this.api(url, { method: fid ? 'PATCH' : 'POST', body: form });
    };
    if (fileId) {
      try { return (await send(fileId)).id; }
      catch (e) { if (e.status !== 404) throw e; }
    }
    return (await send(null)).id;
  },
};

let syncing = false, lastSync = null, syncError = null;
async function syncOne(id) {
  const cur = S.meta && S.meta.id === id;
  const meta = cur ? S.meta : await DB.get('drawings', id);
  const rev = meta.rev || 0;
  const json = JSON.stringify(await buildExport(id));
  const gz = await gzip(json);
  const folder = await Drive.folder();
  meta.drive = meta.drive || {};
  meta.drive.json = await Drive.put(`${id}.json.gz`, gz, meta.drive.json, folder);
  meta.drive.png = await Drive.put(`${id}.png`, await previewPng(id), meta.drive.png, folder);
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
    for (const m of metas) if ((m.rev || 0) > (m.synced_rev || 0)) await syncOne(m.id);
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
  if (Drive.ready() && navigator.onLine && !S.active && performance.now() - S.lastPen > 15000) syncAll(false);
  else updateDriveChip();
}

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
    const s = st.samples.filter((r, i) => i < st.samples.length - 1 || st.cancelled);
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
  figure: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="6" r="3.2"/><circle cx="10.8" cy="5.8" r=".6" fill="currentColor"/><circle cx="13.2" cy="5.8" r=".6" fill="currentColor"/><path d="M12 9.5v7M8 12.5l4-1.5 4 1.5M12 16.5l-3 5M12 16.5l3 5"/></svg>',
  fill: '<svg viewBox="0 0 24 24"><path d="M5 7c3-3 9-4 13-1 3 3 1 8-2 10-4 3-10 3-12-1-1.5-3-1-6 1-8z" fill="currentColor"/></svg>',
  fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="8" y="8" width="8" height="8" rx="1"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
};
const nibThick = (w) => Math.max(1, Math.round(Math.sqrt(w) * 7));

function buildRail() {
  $('#eraser-btn').innerHTML = ICONS.eraser;
  $('#undo-btn').innerHTML = ICONS.undo;
  $('#redo-btn').innerHTML = ICONS.redo;
  $('#figure-btn').innerHTML = ICONS.figure + '<span class="badge" id="fig-badge"></span>';
  $('#fill-btn').innerHTML = ICONS.fill;
  $('#fit-btn').innerHTML = ICONS.fit;
  $('#menu-btn').innerHTML = ICONS.menu;
  $('#nib-pop').innerHTML = NIBS.map((w, i) =>
    `<button role="menuitemradio" data-w="${w}" title="${w} mm (${i + 1})"><i class="stroke" style="height:${nibThick(w)}px"></i><small>${w}</small></button>`).join('');
}
function updateTools() {
  const nb = $('#nib-btn');
  nb.innerHTML = `<svg viewBox="0 0 24 24"><line x1="5" y1="10" x2="19" y2="10" stroke="currentColor" stroke-linecap="round" stroke-width="${Math.min(7, nibThick(S.width) / 1.6 + 0.6)}"/></svg><span>${S.width}</span>`;
  nb.setAttribute('aria-label', `Pen width ${S.width} mm`);
  for (const b of document.querySelectorAll('#nib-pop button')) b.setAttribute('aria-pressed', String(Number(b.dataset.w) === S.width));
  $('#eraser-btn').setAttribute('aria-pressed', String(S.tool === 'eraser'));
  $('#figure-btn').setAttribute('aria-pressed', String(S.figure != null));
  $('#fig-badge').textContent = S.figure != null ? S.figure : '';
  $('#fill-btn').setAttribute('aria-pressed', String(S.fill));
  $('#undo-btn').disabled = !S.strokes.some((s) => !s.undone_at);
  $('#redo-btn').disabled = !S.redo.length;
}
function showNibs() {
  const pop = $('#nib-pop'), r = $('#nib-btn').getBoundingClientRect();
  pop.hidden = false;
  const pr = pop.getBoundingClientRect();
  if (window.innerWidth > window.innerHeight) { pop.style.left = (r.right + 8) + 'px'; pop.style.top = Math.max(8, r.top) + 'px'; }
  else { pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 8)) + 'px'; pop.style.top = (r.top - pr.height - 8) + 'px'; }
}
function hideNibs() { $('#nib-pop').hidden = true; }

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
  $('#m-diag').checked = S.diag;
  $('#menu-title').textContent = m ? (m.title || m.id) : 'Drawing';
  $('#m-foot').textContent = `Natural Hand ${APP_VERSION}. ${m ? `${m.stroke_count || 0} strokes, ${m.figure_count || 0} figures in this drawing.` : ''}`;
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
      if (!confirm(`Delete "${m.title || m.id}" from this device? This cannot be undone here. A copy in Google Drive, if any, stays.`)) return;
      await DB.deleteDrawing(m.id);
      if (S.meta && S.meta.id === m.id) { S.meta = null; S.paper = null; S.strokes = []; localStorage.removeItem('nh-last'); requestRender(); }
      openList();
    };
    list.appendChild(el);
  }
  if (!$('#list-dlg').open) $('#list-dlg').showModal();
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
  $('#nib-pop').onclick = (e) => { const b = e.target.closest('button'); if (b) { setNib(Number(b.dataset.w)); hideNibs(); } };
  $('#eraser-btn').onclick = toggleEraser;
  $('#undo-btn').onclick = undo;
  $('#redo-btn').onclick = redo;
  $('#figure-btn').onclick = toggleFigure;
  $('#fill-btn').onclick = toggleFill;
  $('#fit-btn').onclick = fit;
  $('#menu-btn').onclick = openMenu;
  $('#drive-chip').onclick = () => syncAll(true);
  $('#save-chip').onclick = () => flushMeta();

  for (const id of ['#m-title', '#m-tags', '#m-notes']) $(id).addEventListener('change', metaEdit);
  for (const id of ['#m-dev-name', '#m-dev-pressure']) $(id).addEventListener('change', deviceEdit);
  $('#m-touch').onchange = (e) => { S.touchNav = e.target.checked; localStorage.setItem('nh-touch', S.touchNav ? '1' : '0'); };
  $('#m-diag').onchange = (e) => setDiag(e.target.checked);
  $('#m-close').onclick = () => $('#menu').close();
  $('#m-new').onclick = () => { $('#n-paper').value = defaultPaper(); $('#n-title').value = ''; $('#new-dlg').showModal(); };
  $('#m-list').onclick = openList;
  $('#m-export').onclick = () => S.meta && exportJson(S.meta.id);
  $('#m-drive-connect').onclick = async () => { if (await connectDrive()) syncAll(false); };
  $('#m-drive-sync').onclick = () => syncAll(true);
  $('#m-calib').onclick = () => openCalib();
  $('#list-close').onclick = () => $('#list-dlg').close();
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
    if (document.querySelector('dialog[open]') || (e.target.closest && e.target.closest('input,textarea,select'))) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod) return;
    else if (k === ' ') { spaceDown = true; view.style.cursor = 'grab'; e.preventDefault(); }
    else if (k >= '1' && k <= '7') setNib(NIBS[Number(k) - 1]);
    else if (k === 'e') toggleEraser();
    else if (k === 'f') toggleFigure();
    else if (k === 'g') toggleFill();
    else if (k === '0') fit();
    else if (k === 'd') setDiag(!S.diag);
  });
  addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; view.style.cursor = ''; } });
  addEventListener('resize', () => { resize(); hideNibs(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readSurround(); invalidateSharp(); requestRender(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushMeta(); });
  addEventListener('pagehide', () => flushMeta());
  addEventListener('online', () => autoSync());
}

async function startDrawing() {
  const last = localStorage.getItem('nh-last');
  if (last && await DB.get('drawings', last)) await openDrawing(last);
  else await newDrawing(defaultPaper(), false, '');
}

async function init() {
  readSurround();
  resize();
  buildRail();
  S.width = NIBS.includes(Number(localStorage.getItem('nh-nib'))) ? Number(localStorage.getItem('nh-nib')) : 0.3;
  bindUI();
  updateTools();
  setDiag(S.diag);
  try { await DB.open(); }
  catch (err) { toast('This browser blocked local storage, so drawings cannot be saved: ' + err.message); return; }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  Drive.restore();
  updateDriveChip();
  setInterval(autoSync, 20000);
  S.device = loadDevice();
  if (!S.device) { $('#setup-dlg').showModal(); return; }
  S.ppmm = S.device.ppmm;
  await startDrawing();
}

// test hook (used by automated checks; harmless in normal use)
window.__nh = { S, buildExport, undo, redo, toggleFigure, fit };

init();
})();