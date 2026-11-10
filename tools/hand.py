"""Your hand: how you draw, measured from the movement in your drawings.

Usage:
    python tools/hand.py path/to/drawing.json.gz
    python tools/hand.py path/to/folder              # every drawing in it, together
    python tools/hand.py path/to/folder -o hand.html

Writes an HTML report (default: hand.html next to the input) and prints the key
numbers. Movement statistics use the device samples as recorded (`raw`), only
finished pen lines, and leave out lines tagged as fill (scrubbing would distort
speed and pressure). The pictures of each drawing show everything that is on the page.

Nothing here proves anything about a hand; these are descriptions to look at,
and they get more reliable with every drawing added.
"""
from __future__ import annotations
import argparse, html, math, random, sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from load import load_drawing  # noqa: E402

# mark sizes by path length (mm); what each probably is, in a dense ink drawing
CLASSES = [
    ("Dots", 0.0, 0.3, "under 0.3 mm: stipple, touches"),
    ("Ticks", 0.3, 1.5, "0.3 to 1.5 mm: fringe hairs, short hatching"),
    ("Short lines", 1.5, 6.0, "1.5 to 6 mm: hatching, small contours"),
    ("Long lines", 6.0, math.inf, "over 6 mm: contours, construction"),
]
FILL = len(CLASSES)          # timeline category for lines tagged as fill
CUT_NAME = "white"           # what marks in the paper's colour are called (set per report)
WHITE = FILL + 1             # timeline category for white marks (eraser strokes: drawing in white, not corrections)
SPEED_WINDOW_MS = 10         # speed is measured over at least this much time (dense pens jitter)
BREAK_MS = 60_000            # pauses longer than this are breaks, not rhythm
esc = html.escape


@dataclass
class Line:
    d: int                    # drawing index
    i: int
    t0: float                 # epoch ms
    t1: float                 # pen up
    n: int                    # samples while touching
    length: float             # mm along the path
    chord: float              # mm start to end
    angle: float              # degrees, start to end, screen coordinates (0 right, 90 down)
    peak: float               # mm/s
    mean_speed: float
    pressure: float           # median while touching
    width: float
    brush: str
    device: str
    kinds: list
    fill: bool
    altitude: float           # degrees from the page, median (nan if not reported)
    tilt: float               # degrees from vertical, approx., median
    profile: np.ndarray | None = None   # pressure over the line's time, 50 points
    pause: float | None = None          # ms since the previous line ended
    travel: float | None = None         # mm from the previous line's end to this start
    cls: int = 0
    white: bool = False       # an eraser stroke: a white mark cut into the ink

    @property
    def dur(self): return self.t1 - self.t0


@dataclass
class Sheet:
    """One drawing: what is needed for its pictures and timeline."""
    id: str
    title: str
    box: tuple                # x0, y0, w, h in mm
    paths: list               # (order, width_mm, "M..." path data) for every visible pen line
    timeline: list            # (t0, category) for every pen line, in time order
    undo: int = 0
    white: int = 0
    tone: str = "white"       # paper colour; "black" is a negative drawing
    cancelled: int = 0
    span_min: float = 0.0
    pen_min: float = 0.0
    devices: set = field(default_factory=set)


def cls_of(length):
    for k, (_, lo, hi, _) in enumerate(CLASSES):
        if lo <= length < hi:
            return k
    return len(CLASSES) - 1


def path_data(seg, step=0.1):
    """Polyline in mm, thinned to points at least `step` apart (the shape stays within `step`)."""
    pts = [seg[0]]
    for p in seg[1:-1]:
        if math.hypot(p[0] - pts[-1][0], p[1] - pts[-1][1]) >= step:
            pts.append(p)
    if len(seg) > 1:
        pts.append(seg[-1])
    if len(pts) == 1:
        return f"M{pts[0][0]:.2f} {pts[0][1]:.2f}h0"
    return "M" + " ".join(f"{x:.2f} {y:.2f}" for x, y in pts)


def analyse(files):
    lines, sheets, rates = [], [], defaultdict(list)
    for di, f in enumerate(files):
        d = load_drawing(f)
        F = d.fields
        cP, cTx, cTy, cAl = (F.index(n) if n in F else None for n in ("pressure", "tiltX", "tiltY", "altitude"))
        dev_of = {s["id"]: (s.get("device") or {}).get("name", "?") for s in d.meta.get("sessions", [])}
        kinds_of = (lambda st: d.kinds(st) or (["Figure"] if st.figure is not None else [])) if d.parts else \
            (lambda st: ["Figure"] if st.figure is not None else [])
        order = sorted([s for s in d.strokes if len(s.raw)], key=lambda s: s.t0)
        paper = d.meta.get("paper") or {}
        sh = Sheet(d.id, d.meta.get("title") or "", (0, 0, paper.get("w_mm", 210), paper.get("h_mm", 297)), [], [])
        sh.undo = sum(e.get("type") == "undo" for e in d.events)
        sh.tone = d.tone
        prev = None
        for st in order:
            raw = st.raw if st.cancelled else st.raw[:-1]   # last row is the pen-up event
            end = st.t0 + float(st.raw[-1, 0])
            white = st.tool == "eraser" or (st.ink or "black") == sh.tone   # cut back into the drawing: eraser, or ink the colour of the paper
            sh.cancelled += st.cancelled
            if not st.undone and not st.cancelled and len(raw):
                dev = dev_of.get(st.session, "?")
                sh.devices.add(dev)
                xy, t = raw[:, 1:3], raw[:, 0]
                steps = np.hypot(*np.diff(xy, axis=0).T) if len(raw) > 1 else np.zeros(0)
                cum = np.concatenate([[0], np.cumsum(steps)])
                length = float(cum[-1])
                dur = float(t[-1] - t[0]) if len(t) > 1 else 0.0
                if len(t) > 1:
                    dt = np.diff(t)
                    rates[dev].extend(dt[dt > 0].tolist())
                    j = np.searchsorted(t, t + SPEED_WINDOW_MS)
                    ok = j < len(t)
                    peak = float(np.max((cum[j[ok]] - cum[ok]) / (t[j[ok]] - t[ok]) * 1000)) if ok.any() else \
                        (length / dur * 1000 if dur > 0 else 0.0)
                else:
                    peak = 0.0
                p = raw[:, cP] if cP is not None else np.full(len(raw), np.nan)
                prof = None
                if len(raw) >= 8 and dur > 0:
                    prof = np.interp(np.linspace(0, 1, 50), (t - t[0]) / dur, np.nan_to_num(p))
                tilt = float(np.nanmedian(np.hypot(raw[:, cTx], raw[:, cTy]))) if cTx is not None else math.nan
                alt = raw[:, cAl] if cAl is not None else np.array([np.nan])
                alt = float(np.degrees(np.nanmedian(alt))) if np.isfinite(alt).any() else math.nan
                dx, dy = xy[-1] - xy[0]
                ln = Line(di, st.i, st.t0, end, len(raw), length, float(math.hypot(dx, dy)),
                          float(math.degrees(math.atan2(dy, dx)) % 360), peak,
                          length / dur * 1000 if dur > 0 else 0.0, float(np.nanmedian(p)) if np.isfinite(p).any() else math.nan,
                          st.width_mm, st.brush, dev, [] if white else kinds_of(st), "fill" in (st.tags or []) and not white, alt, tilt, prof)
                ln.cls, ln.white = cls_of(length), white
                sh.white += white
                if prev is not None:
                    ln.pause = st.t0 - prev[0]
                    ln.travel = float(math.hypot(*(xy[0] - prev[1])))
                lines.append(ln)
                sh.timeline.append((st.t0, WHITE if white else FILL if ln.fill else ln.cls, end))
                sh.pen_min += (end - st.t0) / 60000   # pen down to pen up
            if len(raw):
                prev = (end, raw[-1, 1:3])
        # pictures: the drawn (smoothed) path as it ended up on the page, erased parts removed
        vis = [s for s in order if s.tool != "eraser" and not s.undone and not s.cancelled]   # white pen lines included, painted white
        rank = {s.i: k for k, s in enumerate(vis)}
        x0 = y0 = math.inf; x1 = y1 = -math.inf
        for s in vis:
            for seg in s.visible_segments():
                if not len(seg):
                    continue
                seg = seg[:, 1:3]
                sh.paths.append((rank[s.i] / max(1, len(vis)), s.width_mm, path_data(seg.tolist()), (s.ink or "black") == sh.tone))
                x0 = min(x0, seg[:, 0].min()); x1 = max(x1, seg[:, 0].max())
                y0 = min(y0, seg[:, 1].min()); y1 = max(y1, seg[:, 1].max())
        if x0 < math.inf:   # cropped to the drawing, with a little paper around it
            m = max(3.0, 0.04 * max(x1 - x0, y1 - y0))
            sh.box = (x0 - m, y0 - m, x1 - x0 + 2 * m, y1 - y0 + 2 * m)
        if sh.timeline:
            sh.span_min = (sh.timeline[-1][2] - sh.timeline[0][0]) / 60000
        sheets.append(sh)
    return lines, sheets, rates


# ---------------------------------------------------------------- numbers

def med(a):
    a = [x for x in a if x is not None and np.isfinite(x)]
    return float(np.median(a)) if a else math.nan


def g(x, unit="", nd=3):
    if x is None or not np.isfinite(x):
        return "–"
    s = f"{x:.{nd}g}" if abs(x) < 10 ** nd else f"{x:,.0f}"
    if "e" in s:
        s = f"{x:,.0f}"
    return f"{s} {unit}".strip()


def pct(n, of):
    return f"{100 * n / of:.0f}%" if of else "–"


# ---------------------------------------------------------------- charts (inline SVG)

def ticks_log(lo, hi):
    out = []
    for e in range(math.floor(math.log10(lo)), math.ceil(math.log10(hi)) + 1):
        for m in (1, 3):
            v = m * 10 ** e
            if lo <= v <= hi:
                out.append(v)
    return out


def ticks_lin(lo, hi, n=5):
    span = hi - lo
    step = 10 ** math.floor(math.log10(span / n)) if span > 0 else 1
    for m in (1, 2, 5, 10):
        if span / (step * m) <= n:
            step *= m
            break
    v = math.ceil(lo / step) * step
    out = []
    while v <= hi + 1e-9:
        out.append(round(v, 10))
        v += step
    return out


def tick_label(v):
    return f"{v:g}" if v < 1000 else f"{v / 1000:g}k"


def hist(values, lo, hi, *, bins=36, log=False, unit="", caption="", what="lines", median=True):
    v = np.asarray([x for x in values if x is not None and np.isfinite(x)], float)
    if log:
        v = v[v > 0]
    if not len(v):
        return ""
    tr = np.log10 if log else (lambda x: x)
    inv = (lambda x: 10 ** x) if log else (lambda x: x)
    a, b = float(tr(lo)), float(tr(hi))
    c = np.clip(tr(v), a, b - (b - a) * 1e-9)
    counts, edges = np.histogram(c, bins=bins, range=(a, b))
    W, H, T, B = 420, 120, 14, 20
    bw = W / bins
    top = counts.max() or 1
    X = lambda val: (float(tr(val)) - a) / (b - a) * W
    out = [f'<line class="base" x1="0" y1="{T + H + .5}" x2="{W}" y2="{T + H + .5}"/>']
    for k, cnt in enumerate(counts):
        lo_k, hi_k = inv(edges[k]), inv(edges[k + 1])
        h = cnt / top * H
        if cnt:
            out.append(f'<rect class="bar" x="{k * bw + 1:.1f}" y="{T + H - h:.1f}" width="{max(bw - 2, 1):.1f}" height="{h:.1f}" rx="1.5"/>')
        more = " and above" if k == bins - 1 and v.max() >= hi else (" and below" if k == 0 and v.min() <= lo else "")
        tip = f"{g(lo_k)}–{g(hi_k)} {unit}{more}: {cnt:,} {what} ({pct(cnt, len(v))})"
        out.append(f'<rect class="hit" x="{k * bw:.1f}" y="{T}" width="{bw:.1f}" height="{H}" data-tip="{esc(tip)}"/>')
    for tv in (ticks_log(lo, hi) if log else ticks_lin(lo, hi)):
        x = X(tv)
        anchor = "start" if x < 8 else "end" if x > W - 8 else "middle"
        out.append(f'<line class="tick" x1="{x:.1f}" y1="{T + H}" x2="{x:.1f}" y2="{T + H + 4}"/>'
                   f'<text x="{x:.1f}" y="{T + H + 16}" text-anchor="{anchor}">{tick_label(tv)}</text>')
    if median:
        m = float(np.median(v))
        x = min(max(X(min(max(m, lo), hi)), 0), W)
        out.append(f'<line class="med" x1="{x:.1f}" y1="{T - 2}" x2="{x:.1f}" y2="{T + H}"/>'
                   f'<text class="medl" x="{x + (4 if x < W * .7 else -4):.1f}" y="{T + 8}" text-anchor="{"start" if x < W * .7 else "end"}">median {g(m, unit)}</text>')
    return figure(caption, f'<svg viewBox="0 0 {W} {T + H + B}" role="img" aria-label="{esc(caption)}">{"".join(out)}</svg>')


def figure(caption, body, note=""):
    return (f'<figure><figcaption>{caption}</figcaption>{body}'
            f'{f"<p class=note>{note}</p>" if note else ""}</figure>')


def scatter_speed(lines):
    pts = [(l.length, l.peak) for l in lines if l.length > 0.02 and l.peak > 0.05]
    if len(pts) < 10:
        return "", None
    L = np.array([p[0] for p in pts]); V = np.array([p[1] for p in pts])
    xlo, xhi = 0.02, max(30.0, float(np.percentile(L, 99.8)) * 1.2)
    ylo, yhi = 0.5, max(50.0, float(np.percentile(V, 99.8)) * 1.2)
    W, H, Lm, B, T = 420, 250, 34, 22, 8
    X = lambda v: Lm + (math.log10(min(max(v, xlo), xhi)) - math.log10(xlo)) / (math.log10(xhi) - math.log10(xlo)) * (W - Lm)
    Y = lambda v: T + H - (math.log10(min(max(v, ylo), yhi)) - math.log10(ylo)) / (math.log10(yhi) - math.log10(ylo)) * H
    out = []
    for tv in ticks_log(ylo, yhi):
        out.append(f'<line class="grid" x1="{Lm}" y1="{Y(tv):.1f}" x2="{W}" y2="{Y(tv):.1f}"/>'
                   f'<text x="{Lm - 5}" y="{Y(tv) + 4:.1f}" text-anchor="end">{tick_label(tv)}</text>')
    for tv in ticks_log(xlo, xhi):
        out.append(f'<text x="{X(tv):.1f}" y="{T + H + 16}" text-anchor="middle">{tick_label(tv)}</text>')
    for k, (name, lo, _, _) in enumerate(CLASSES[1:], 1):
        x = X(lo)
        out.append(f'<line class="bound" x1="{x:.1f}" y1="{T}" x2="{x:.1f}" y2="{T + H}"/>')
    for k, (name, lo, hi, _) in enumerate(CLASSES):
        xa, xb = X(max(lo, xlo)), X(min(hi, xhi))
        out.append(f'<text class="cl" x="{(xa + xb) / 2:.1f}" y="{T + 10}" text-anchor="middle">{esc(name)}</text>')
    rnd = random.Random(1)
    sel = list(range(len(pts)))
    if len(sel) > 6000:
        sel = rnd.sample(sel, 6000)
    out.append('<g class="dots">' + "".join(f'<circle cx="{X(L[k]):.1f}" cy="{Y(V[k]):.1f}" r="1.6"/>' for k in sel) + "</g>")
    m = (L > 0.3) & (V > 0.5)
    fit = None
    if m.sum() > 20:
        b, a = np.polyfit(np.log10(L[m]), np.log10(V[m]), 1)
        fit = (10 ** a, b)
        xs = [0.3, xhi]
        out.append(f'<line class="fit" x1="{X(xs[0]):.1f}" y1="{Y(10 ** a * xs[0] ** b):.1f}" x2="{X(xs[1]):.1f}" y2="{Y(10 ** a * xs[1] ** b):.1f}" '
                   f'data-tip="{esc(f"Fitted on lines over 0.3 mm: peak speed ≈ {10 ** a:.3g} × length^{b:.2f}")}"/>')
    out.append(f'<line class="base" x1="{Lm}" y1="{T + H + .5}" x2="{W}" y2="{T + H + .5}"/>')
    cap = "Peak speed against length, one dot per line (both scales logarithmic: mm and mm/s)"
    svg = f'<svg viewBox="0 0 {W} {T + H + B}" role="img" aria-label="{esc(cap)}">{"".join(out)}</svg>'
    note = (f"The dashed line: peak speed ≈ {fit[0]:.3g} × length<sup>{fit[1]:.2f}</sup> (lines over 0.3 mm). "
            "An exponent below 1 means longer lines are faster, but not in proportion: they take longer too.") if fit else ""
    return figure(cap, svg, note), fit


def profiles(lines):
    groups = []
    for k, (name, *_rest) in enumerate(CLASSES):
        ps = [l.profile for l in lines if l.cls == k and l.profile is not None]
        if len(ps) >= 15:
            groups.append((k, name, np.median(np.array(ps), axis=0), len(ps)))
    if not groups:
        return ""
    W, H, Lm, B, T, R = 420, 170, 30, 22, 10, 86
    top = max(0.2, max(float(gp[2].max()) for gp in groups) * 1.1)
    X = lambda u: Lm + u * (W - Lm - R)
    Y = lambda p: T + H - p / top * H
    out = []
    for tv in ticks_lin(0, top, 4):
        out.append(f'<line class="grid" x1="{Lm}" y1="{Y(tv):.1f}" x2="{W - R}" y2="{Y(tv):.1f}"/>'
                   f'<text x="{Lm - 5}" y="{Y(tv) + 4:.1f}" text-anchor="end">{tv:g}</text>')
    for u, lab in ((0, "pen down"), (0.5, "middle"), (1, "pen up")):
        out.append(f'<text x="{X(u):.1f}" y="{T + H + 16}" text-anchor="{"start" if u == 0 else "end" if u == 1 else "middle"}">{lab}</text>')
    ends = []
    for k, name, prof, n in groups:
        d = " ".join(f"{X(j / 49):.1f},{Y(p):.1f}" for j, p in enumerate(prof))
        out.append(f'<polyline class="ser s{k + 1}" points="{d}"/>')
        out.append(f'<polyline class="hitl" points="{d}" data-tip="{esc(f"{name}: median pressure over the line, {n:,} lines; peak {prof.max():.2f}")}"/>')
        ends.append([Y(prof[42]), name, k, Y(prof[42])])
    ends.sort()
    for j in range(1, len(ends)):                       # keep labels apart
        ends[j][0] = max(ends[j][0], ends[j - 1][0] + 13)
    shift = max(0.0, ends[-1][0] - (T + H - 4)) if ends else 0
    for e in ends:
        e[0] -= shift
    for y, name, k, y0 in ends:
        out.append(f'<line class="lead s{k + 1}" x1="{X(42 / 49) + 3:.1f}" y1="{y0:.1f}" x2="{X(1) + 8:.1f}" y2="{y:.1f}"/>'
                   f'<text class="lbl" x="{X(1) + 11:.1f}" y="{y + 4:.1f}">{esc(name)}</text>')
    out.append(f'<line class="base" x1="{Lm}" y1="{T + H + .5}" x2="{W - R}" y2="{T + H + .5}"/>')
    legend = '<div class="legend">' + "".join(f'<span><i class="sw s{k + 1}"></i>{esc(n)}</span>' for k, n, *_ in groups) + "</div>"
    cap = "Pressure through a line, from pen down to pen up (median of each kind of mark)"
    return figure(cap, legend + f'<svg viewBox="0 0 {W} {T + H + B}" role="img" aria-label="{esc(cap)}">{"".join(out)}</svg>')


def rose(lines, caption):
    a = np.array([l.angle for l in lines])
    if len(a) < 20:
        return ""
    nb = 24
    counts = np.bincount((a // (360 / nb)).astype(int) % nb, minlength=nb)
    top = counts.max() or 1
    S, c, R = 240, 120, 96
    names = ["right", "down-right", "down", "down-left", "left", "up-left", "up", "up-right"]
    out = [f'<circle class="ring" cx="{c}" cy="{c}" r="{R * f}"/>' for f in (1 / 3, 2 / 3, 1)]
    for k, cnt in enumerate(counts):
        a0, a1 = math.radians(k * 360 / nb + 1), math.radians((k + 1) * 360 / nb - 1)
        r = R * math.sqrt(cnt / top)   # area true to the count
        if cnt:
            out.append(f'<path class="bar" d="M{c} {c}L{c + r * math.cos(a0):.1f} {c + r * math.sin(a0):.1f}A{r:.1f} {r:.1f} 0 0 1 {c + r * math.cos(a1):.1f} {c + r * math.sin(a1):.1f}Z"/>')
        mid = (k + .5) * 360 / nb
        tip = f"Toward {k * 15}–{(k + 1) * 15}° ({names[int(((mid + 22.5) % 360) // 45)]}): {cnt:,} lines ({pct(cnt, len(a))})"
        out.append(f'<path class="hit" d="M{c} {c}L{c + R * math.cos(a0):.1f} {c + R * math.sin(a0):.1f}A{R} {R} 0 0 1 {c + R * math.cos(a1):.1f} {c + R * math.sin(a1):.1f}Z" data-tip="{esc(tip)}"/>')
    for lab, x, y, an in (("right", c + R + 6, c + 4, "start"), ("left", c - R - 6, c + 4, "end"), ("down", c, c + R + 15, "middle"), ("up", c, c - R - 6, "middle")):
        out.append(f'<text x="{x}" y="{y}" text-anchor="{an}">{lab}</text>')
    return figure(caption, f'<svg class="rose" viewBox="-30 -14 {S + 60} {S + 28}" role="img" aria-label="{esc(caption)}">{"".join(out)}</svg>')


def timeline(sh, n_win=40):
    tl = sh.timeline
    if len(tl) < 40:
        return ""
    n_win = min(n_win, len(tl) // 15)
    cuts = np.linspace(0, len(tl), n_win + 1).astype(int)
    t_start = tl[0][0]
    names = [c[0] for c in CLASSES] + ["Fill (tagged)", CUT_NAME.capitalize() + " marks"]
    W, H, T, B = 640, 150, 6, 20
    bw = W / n_win
    out = []
    for w in range(n_win):
        chunk = tl[cuts[w]:cuts[w + 1]]
        cnt = Counter(c for _, c, _ in chunk)
        y = T + H
        m0, m1 = (chunk[0][0] - t_start) / 60000, (chunk[-1][2] - t_start) / 60000
        for k in range(len(names)):
            if not cnt[k]:
                continue
            h = cnt[k] / len(chunk) * H
            out.append(f'<rect class="s{k + 1}" x="{w * bw + 1:.1f}" y="{y - h + 1:.1f}" width="{bw - 2:.1f}" height="{max(h - 2, .5):.1f}" rx="1"'
                       f' data-tip="{esc(f"Minutes {m0:.0f}–{m1:.0f}: {names[k].lower()} {pct(cnt[k], len(chunk))} ({cnt[k]} of {len(chunk)} lines)")}"/>')
            y -= h
    for w in range(0, n_win + 1, max(1, n_win // 5)):
        k = min(cuts[w], len(tl) - 1)
        x = min(w * bw, W)
        out.append(f'<text x="{x:.1f}" y="{T + H + 15}" text-anchor="{"start" if w == 0 else "end" if w == n_win else "middle"}">{(tl[k][0] - t_start) / 60000:.0f} min</text>')
    present = sorted({c for _, c, _ in tl})
    legend = '<div class="legend">' + "".join(f'<span><i class="sw s{k + 1}"></i>{esc(names[k])}</span>' for k in present) + "</div>"
    cap = f"What you drew, in order: each bar is 1/{n_win} of the lines, split by kind of mark"
    return figure(cap, legend + f'<svg viewBox="0 0 {W} {T + H + B}" role="img" aria-label="{esc(cap)}">{"".join(out)}</svg>',
                  "Time under each bar is when that stretch started, counted from the first line.")


def sheet_pictures(sh, idx):
    if not sh.paths:
        return ""
    x0, y0, w, h = sh.box
    nb = 8
    groups = [[] for _ in range(nb)]
    for order, wd, d, wh in sh.paths:
        st_ = ' style="stroke:var(--wm)"' if wh else ""
        groups[min(nb - 1, int(order * nb))].append(f'<path d="{d}" stroke-width="{max(wd, 0.12):.2f}"{st_}/>')
    defs = "".join(f'<g id="d{idx}b{k}">{"".join(gp)}</g>' for k, gp in enumerate(groups))
    vb = f'{x0:.1f} {y0:.1f} {w:.1f} {h:.1f}'
    frames = []
    for q, upto in ((25, 2), (50, 4), (75, 6), (100, 8)):
        old = "".join(f'<use href="#d{idx}b{k}"/>' for k in range(upto - 2))
        new = "".join(f'<use href="#d{idx}b{k}"/>' for k in range(upto - 2, upto))
        neg = ' style="--paper:#000000;--pen:#f4f2ec;--old:#5f5c56"' if sh.tone == "black" else ""
        frames.append(f'<figure class="frame"><svg{neg} viewBox="{vb}" role="img" aria-label="The drawing after {q}% of its lines; the last quarter in black">'
                      f'<rect class="paper" x="{x0}" y="{y0}" width="{w}" height="{h}"/><g class="ink old">{old}</g><g class="ink">{new}</g></svg>'
                      f'<figcaption>Lines {q - 25}–{q}%</figcaption></figure>')
    tmap = "".join(f'<use href="#d{idx}b{k}" class="t{k}"/>' for k in range(nb))
    ramp = '<div class="ramp"><span>first lines</span>' + "".join(f'<i class="t{k}"></i>' for k in range(nb)) + '<span>last lines</span></div>'
    return (f'<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>{defs}</defs></svg>'
            f'<h3>How it grew</h3><div class="frames">{"".join(frames)}</div>'
            f'<p class="note">Each frame adds a quarter of the lines, in {"white" if sh.tone == "black" else "black"}; earlier lines are grey. Lines are shown as they ended up, with the {CUT_NAME} marks already cut in.</p>'
            f'<h3>When each part was drawn</h3><div class="tmap"><svg viewBox="{vb}" role="img" aria-label="The drawing coloured by when each line was drawn">'
            f'<rect class="paper2" x="{x0}" y="{y0}" width="{w}" height="{h}"/><g class="tink">{tmap}</g></svg>{ramp}</div>')


def gallery(lines, k, n=24, seed=3):
    pool = [l for l in lines if l.cls == k]
    if not pool:
        return ""
    rnd = random.Random(seed + k)
    pick = rnd.sample(pool, min(n, len(pool)))
    return pick


# ---------------------------------------------------------------- report

def table(head, rows, cls=""):
    th = "".join(f"<th>{h}</th>" for h in head)
    trs = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<div class="tw"><table class="{cls}"><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table></div>'


def report(files, lines, sheets, rates, galleries, white_gallery):
    global CUT_NAME
    tones = {s.tone for s in sheets}
    CUT_NAME = "white" if tones == {"white"} else "black" if tones == {"black"} else "cut-in"
    INK = "white" if tones == {"black"} else "ink"
    motor = [l for l in lines if not l.fill and not l.white]
    whites = [l for l in lines if l.white]
    n_fill = sum(l.fill for l in lines)
    N = len(motor)
    pauses = [l.pause for l in motor if l.pause is not None and l.pause < BREAK_MS]
    breaks = sum(1 for l in motor if l.pause is not None and l.pause >= BREAK_MS)
    body = []
    pen_min = sum(s.pen_min for s in sheets)
    span_min = sum(s.span_min for s in sheets)
    devs = sorted({l.device for l in lines})
    # key numbers
    cards = [
        (f"{INK.capitalize()} lines measured", f"{N:,}", ", ".join(x for x in (f"{n_fill:,} fill lines left out" if n_fill else "", f"{len(whites):,} {CUT_NAME} marks on their own" if whites else "") if x) or "all pen lines"),
        ("Typical line", g(med([l.length for l in motor]), "mm"), f"{g(med([l.dur for l in motor]), 'ms')} with the pen down"),
        ("Typical pause", g(med(pauses), "ms"), "between one line and the next"),
        ("Typical peak speed", g(med([l.peak for l in motor]), "mm/s"), f"fastest 1%: over {g(float(np.percentile([l.peak for l in motor], 99)) if motor else math.nan, 'mm/s')}"),
        ("Typical pressure", g(med([l.pressure for l in motor]), "", 2), "0 to 1, as the pen reports it"),
        ("Pen on paper", f"{pen_min:.0f} min", f"of {span_min:.0f} min from first to last line"),
    ]
    body.append('<div class="cards">' + "".join(f'<div class="card"><div class="k">{esc(a)}</div><div class="v">{esc(b)}</div><div class="s">{esc(c)}</div></div>' for a, b, c in cards) + "</div>")

    # marks
    rows, desc = [], []
    for k, (name, lo, hi, what) in enumerate(CLASSES):
        ls = [l for l in motor if l.cls == k]
        rows.append([f'<i class="sw s{k + 1}"></i> {esc(name)}', esc(what), f"{len(ls):,}", pct(len(ls), N),
                     g(med([l.dur for l in ls]), "ms"), g(med([l.peak for l in ls]), "mm/s"), g(med([l.pressure for l in ls]), "", 2),
                     pct(sum(l.chord >= 0.8 * l.length for l in ls if l.length > 0), len([l for l in ls if l.length > 0]))])
    small = sum(1 for l in motor if l.cls <= 1)
    body.append(f'<section><h2>Your marks</h2><p class="lead">{pct(small, N)} of your lines are under 1.5 mm long. '
                f'Sorting by length is only a first cut; grouping by the whole movement comes later.</p>')
    body.append(table(["Mark", "Length", "Lines", "Share", "Pen down", "Peak speed", "Pressure", "Nearly straight"], rows, "num"))
    body.append('<p class="note">Medians. Nearly straight: the distance from start to end is at least 80% of the path.</p>')
    for k, (name, lo, hi, what) in enumerate(CLASSES):
        pick = galleries[k]
        if not pick:
            continue
        box = {0: 0.6, 1: 2.0, 2: 7.0}.get(k)
        cells = []
        for l, seg in pick:
            if seg is None or not len(seg):
                continue
            cx, cy = (seg[:, 0].min() + seg[:, 0].max()) / 2, (seg[:, 1].min() + seg[:, 1].max()) / 2
            size = box or max(np.ptp(seg[:, 0]), np.ptp(seg[:, 1]), 1) * 1.15
            tip = f"{name[:-1] if name.endswith('s') else name}: {g(l.length, 'mm')}, {g(l.dur, 'ms')}, peak {g(l.peak, 'mm/s')}, pressure {g(l.pressure, '', 2)}"
            cells.append(f'<svg class="cell" viewBox="{cx - size / 2:.3f} {cy - size / 2:.3f} {size:.3f} {size:.3f}" data-tip="{esc(tip)}" role="img" aria-label="{esc(tip)}">'
                         f'<path d="{path_data(seg.tolist(), step=size / 200)}"/></svg>')
        scale = f"each box is {box:g} mm wide" if box else "each scaled to fit its box"
        body.append(f'<h3>{esc(name)} <span class="sub">{len(cells)} at random, {scale}</span></h3><div class="gal">{"".join(cells)}</div>')
    body.append('<div class="figs">' + hist([l.length for l in motor], 0.01, 100, log=True, unit="mm", caption="Line length (logarithmic scale)") +
                hist([l.dur for l in motor], 1, 5000, log=True, unit="ms", caption="Time with the pen down per line (logarithmic scale)") + "</div></section>")

    # white marks
    if whites:
        rows = []
        for k, (name, lo, hi, what) in enumerate(CLASSES):
            ls = [l for l in whites if l.cls == k]
            if ls:
                rows.append([esc(name), f"{len(ls):,}", pct(len(ls), len(whites)), g(med([l.dur for l in ls]), "ms"),
                             g(med([l.peak for l in ls]), "mm/s"), g(med([l.pressure for l in ls]), "", 2),
                             esc(", ".join(f"{w:g}" for w in sorted({l.width for l in ls}))) + " mm"])
        rows.append([f"<b>All {CUT_NAME} marks</b>", f"<b>{len(whites):,}</b>", "", g(med([l.dur for l in whites]), "ms"),
                     g(med([l.peak for l in whites]), "mm/s"), g(med([l.pressure for l in whites]), "", 2), ""])
        rows.append([f"All {INK} lines", f"{N:,}", "", g(med([l.dur for l in motor]), "ms"), g(med([l.peak for l in motor]), "mm/s"),
                     g(med([l.pressure for l in motor]), "", 2), ""])
        ts = sorted((l.d, l.t0) for l in whites)
        spans, start = [], ts[0]
        for a_, b_ in zip(ts, ts[1:] + [None]):
            if b_ is None or b_[0] != a_[0] or b_[1] - a_[1] > 5 * 60000:
                t_first = min(t for t, _, _ in sheets[start[0]].timeline)
                m0, m1 = round((start[1] - t_first) / 60000), round((a_[1] - t_first) / 60000)
                spans.append(f"{m0}–{m1} min" if m1 > m0 else f"{m0} min")
                start = b_
        cells = []
        for l, seg in white_gallery:
            if seg is None or not len(seg):
                continue
            box = {0: 0.6, 1: 2.0, 2: 7.0}.get(l.cls)
            cx, cy = (seg[:, 0].min() + seg[:, 0].max()) / 2, (seg[:, 1].min() + seg[:, 1].max()) / 2
            size = max(box or max(np.ptp(seg[:, 0]), np.ptp(seg[:, 1]), 1) * 1.15, max(np.ptp(seg[:, 0]), np.ptp(seg[:, 1])) + l.width * 1.6)
            tip = f"{CUT_NAME.capitalize()} {CLASSES[l.cls][0].lower().rstrip('s')}: {g(l.length, 'mm')}, {l.width:g} mm wide, {g(l.dur, 'ms')}, pressure {g(l.pressure, '', 2)}"
            cells.append(f'<svg class="cell neg" viewBox="{cx - size / 2:.3f} {cy - size / 2:.3f} {size:.3f} {size:.3f}" data-tip="{esc(tip)}" role="img" aria-label="{esc(tip)}">'
                         f'<path d="{path_data(seg.tolist(), step=size / 200)}" style="stroke-width:{max(l.width, size / 60):.3f}"/></svg>')
        body.append(f'<section><h2>{CUT_NAME.capitalize()} marks</h2><p class="lead">{len(whites):,} {CUT_NAME} marks, made with ink the colour of the paper or by cutting through with the eraser: '
                    f'drawing back into the drawing, not corrections. Made in {len(spans)} stretch{"es" * (len(spans) != 1)}: {esc(", ".join(spans))}.</p>'
                    + table(["Mark", "Marks", "Share", "Pen down", "Peak speed", "Pressure", "Widths"], rows, "num")
                    + '<p class="note">Medians. Sizes are sorted by the same lengths as ink lines.</p>'
                    + f'<h3>Examples <span class="sub">{len(cells)} at random, at their real width; boxes as for ink lines, or larger to fit a wide mark</span></h3>'
                    + f'<div class="gal">{"".join(cells)}</div></section>')

    # speed
    sc, fit = scatter_speed(motor)
    body.append('<section><h2>Speed</h2><p class="lead">Speed is measured over at least 10 ms, so the jitter of a fast pen does not count as movement.</p>'
                f'<div class="figs">{sc}{hist([l.peak for l in motor], 0.5, 500, log=True, unit="mm/s", caption="Peak speed per line (logarithmic scale)")}</div></section>')

    # pressure and pen angle
    alts = [l.altitude for l in motor if np.isfinite(l.altitude)]
    figs = profiles(motor) + hist([l.pressure for l in motor], 0, 1, unit="", caption="Median pressure per line")
    if alts:
        figs += hist(alts, 20, 90, unit="°", caption="How upright you hold the pen (angle from the page, 90° = straight up)")
    body.append(f'<section><h2>Pressure and pen angle</h2><div class="figs">{figs}</div></section>')

    # direction
    ticks = [l for l in motor if l.cls == 1]
    longer = [l for l in motor if l.cls >= 2]
    body.append('<section><h2>Direction</h2><p class="lead">Which way each line travels from where the pen lands to where it lifts, as seen on the page. '
                'Wedge area is true to the number of lines.</p>'
                f'<div class="figs roses">{rose(ticks, f"Ticks ({len(ticks):,})")}{rose(longer, f"Short and long lines ({len(longer):,})")}</div></section>')

    # rhythm
    travel = [l.travel for l in motor if l.travel is not None and l.pause is not None and l.pause < BREAK_MS]
    quick = sum(1 for p in pauses if p < 200)
    body.append(f'<section><h2>Rhythm</h2><p class="lead">{pct(quick, len(pauses))} of pauses between lines are under 200 ms. '
                f'{breaks} break{"s" * (breaks != 1)} of over a minute {"are" if breaks != 1 else "is"} left out of these charts.</p><div class="figs">'
                + hist(pauses, 10, BREAK_MS, log=True, unit="ms", caption="Pause before each line (logarithmic scale)")
                + hist(travel, 0.01, 200, log=True, unit="mm", caption="How far the pen moves in the air between lines (logarithmic scale)")
                + "</div></section>")

    # parts
    groups = defaultdict(list)
    for l in motor:
        if l.kinds:
            for kd in set(l.kinds):
                groups[kd].append(l)
        else:
            groups[None].append(l)
    rows = []
    for kd, ls in sorted(groups.items(), key=lambda kv: (kv[0] is None, kv[0] or "")):
        if len(ls) < 20:
            continue
        ps = [l.pause for l in ls if l.pause is not None and l.pause < BREAK_MS]
        rows.append([esc(kd or "Not in a part"), f"{len(ls):,}", g(med([l.length for l in ls]), "mm"), g(med([l.dur for l in ls]), "ms"),
                     g(med([l.peak for l in ls]), "mm/s"), g(med([l.pressure for l in ls]), "", 2), g(med(ps), "ms"),
                     pct(sum(l.cls == 0 for l in ls), len(ls)), pct(sum(l.cls == 1 for l in ls), len(ls))])
    if len(rows) > 1:
        body.append('<section><h2>Parts</h2><p class="lead">Lines inside each kind of part you marked, next to everything else. Medians.</p>'
                    + table(["Kind", "Lines", "Length", "Pen down", "Peak speed", "Pressure", "Pause before", "Dots", "Ticks"], rows, "num") + "</section>")

    # devices
    drows = []
    for dv in devs:
        ls = [l for l in motor if l.device == dv]
        iv = med(rates[dv])
        drows.append([esc(dv), f"{len(ls):,}", f"{1000 / iv:.0f} Hz" if np.isfinite(iv) and iv > 0 else "–",
                      g(med([l.length for l in ls]), "mm"), g(med([l.peak for l in ls]), "mm/s"), g(med([l.pressure for l in ls]), "", 2),
                      g(med([l.tilt for l in ls]), "°")])
    body.append('<section><h2>Devices</h2><p class="lead">Pressure and tilt are reported differently by each pen, so compare them within a device.</p>'
                + table(["Device", "Lines", "Sample rate", "Length", "Peak speed", "Pressure", "Tilt from vertical"], drows, "num") + "</section>")

    # drawings
    for idx, sh in enumerate(sheets):
        nm = esc(sh.title or sh.id)
        facts = (f"{'Negative drawing (black paper). ' if sh.tone == 'black' else ''}{len(sh.timeline) - sh.white:,} {'white' if sh.tone == 'black' else 'ink'} lines and {sh.white:,} {'black' if sh.tone == 'black' else 'white'} marks, {sh.pen_min:.0f} min with the pen down over {sh.span_min:.0f} min; "
                 f"{sh.undo} undo{'s' * (sh.undo != 1)}{f', {sh.cancelled} cancelled' if sh.cancelled else ''}. {esc(', '.join(sorted(sh.devices)))}.")
        body.append(f'<section><h2>{nm}</h2><p class="lead">{facts}</p>{timeline(sh)}{sheet_pictures(sh, idx)}</section>')

    src = ", ".join(esc(Path(p).name) for p in files[:6]) + (f" and {len(files) - 6} more" if len(files) > 6 else "")
    head = (f'<h1>Your hand</h1><p class="sub">{len(files)} drawing{"s" * (len(files) != 1)}: {src}. '
            f'Movement from the pen as recorded. Statistics are for lines that contrast with the paper; fill lines are left out, and marks in the paper\'s colour (cut back in) have their own section. Hover or tap a chart for numbers.</p>')
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>Your hand</title><style>{CSS}</style></head><body><main>{head}{"".join(body)}</main>'
            f'<div id="tip" role="tooltip" hidden></div><script>{JS}</script></body></html>')


CSS = """
:root{color-scheme:light;--bg:#fbfaf7;--ink:#1d1c1a;--muted:#5f5c56;--line:#e3e0d8;--grid:#eceae4;--card:#f3f1ec;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#8f8b84;--paper:#ffffff;--pen:#141414;
--t0:#86b6ef;--t1:#6da7ec;--t2:#5598e7;--t3:#3987e5;--t4:#2a78d6;--t5:#256abf;--t6:#1c5cab;--t7:#104281;--tpaper:#ffffff}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#171715;--ink:#ecebe6;--muted:#aaa69e;--line:#33312d;--grid:#262522;--card:#201f1d;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#e4e1da;--paper:#f4f2ec;--pen:#141414;
--t0:#184f95;--t1:#1c5cab;--t2:#256abf;--t3:#2a78d6;--t4:#3987e5;--t5:#6da7ec;--t6:#9ec5f4;--t7:#cde2fb;--tpaper:#1a1a19}}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;padding:24px 16px 64px}
main{max-width:920px;margin:0 auto}
h1{font-size:1.6rem;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:1.2rem;margin:0 0 4px}
h3{font-size:.98rem;margin:20px 0 8px;font-weight:600}
h3 .sub{font-weight:400;font-size:.85rem}
.sub,.note{color:var(--muted)} .sub{margin:2px 0 12px}
.note{font-size:.85rem;margin:6px 0 0}
.lead{margin:2px 0 14px;max-width:62ch}
section{border-top:1px solid var(--line);padding-top:22px;margin-top:28px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:10px;margin:18px 0 6px}
.card{background:var(--card);border-radius:10px;padding:12px 14px}
.card .k{font-size:.8rem;color:var(--muted)} .card .v{font-size:1.5rem;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.card .s{font-size:.8rem;color:var(--muted)}
.tw{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.9rem}
td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-weight:600;color:var(--muted);font-size:.8rem}
table.num td:nth-child(n+3),table.num th:nth-child(n+3){text-align:right;font-variant-numeric:tabular-nums}
.figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr));gap:18px 28px;margin-top:14px}
.roses{grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))} .roses svg{max-width:300px}
figure{margin:0} figcaption{font-size:.85rem;color:var(--muted);margin-bottom:6px}
svg{width:100%;height:auto;display:block;overflow:visible}
svg text{fill:var(--muted);font-size:11px}
.base{stroke:var(--line)} .tick{stroke:var(--line)} .grid{stroke:var(--grid)} .ring{fill:none;stroke:var(--grid)}
.bar{fill:var(--s1)} .hit{fill:transparent} .hit:hover{fill:var(--ink);fill-opacity:.07}
.med{stroke:var(--ink);stroke-width:1;stroke-dasharray:3 3} svg text.medl{fill:var(--ink)}
.bound{stroke:var(--line);stroke-dasharray:2 3} svg text.cl{fill:var(--muted);font-size:10px}
.dots circle{fill:var(--s1);fill-opacity:.28}
.fit{stroke:var(--ink);stroke-width:2;stroke-dasharray:6 4}
.ser{fill:none;stroke-width:2;stroke-linejoin:round} .hitl{fill:none;stroke:transparent;stroke-width:12}
.ser.s1,.lead.s1{stroke:var(--s1)} .ser.s2,.lead.s2{stroke:var(--s2)} .ser.s3,.lead.s3{stroke:var(--s3)} .ser.s4,.lead.s4{stroke:var(--s4)}
.lead{stroke-width:1} svg text.lbl{fill:var(--ink)}
rect.s1,.sw.s1{fill:var(--s1);background:var(--s1)} rect.s2,.sw.s2{fill:var(--s2);background:var(--s2)} rect.s3,.sw.s3{fill:var(--s3);background:var(--s3)}
rect.s4,.sw.s4{fill:var(--s4);background:var(--s4)} rect.s5,.sw.s5{fill:var(--s5);background:var(--s5)} rect.s6,.sw.s6{fill:var(--s6);background:var(--s6)}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:.82rem;margin-bottom:6px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{display:inline-block;width:10px;height:10px;border-radius:3px;vertical-align:-1px}
.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:6px}
.cell{overflow:hidden;aspect-ratio:1;background:var(--paper);border-radius:6px}
.cell.neg{background:#141414} .cell.neg path{stroke:#ffffff;vector-effect:none}
.cell path{fill:none;stroke:var(--pen);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.frames{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(46%,200px),1fr));gap:12px}
.frame figcaption{margin:4px 0 0}
.paper{fill:var(--paper)} .paper2{fill:var(--tpaper)} .frame svg{--wm:var(--paper)} .tmap svg{--wm:var(--tpaper)} .ink.old{stroke:var(--old,#b9b6ae)}
.ink,.tink{fill:none;stroke-linecap:round;stroke-linejoin:round} .ink{stroke:var(--pen)}
.frame svg,.tmap svg{border-radius:4px;box-shadow:0 0 0 1px var(--line)}
.tmap{max-width:520px}
.tink .t0{stroke:var(--t0)} .tink .t1{stroke:var(--t1)} .tink .t2{stroke:var(--t2)} .tink .t3{stroke:var(--t3)}
.tink .t4{stroke:var(--t4)} .tink .t5{stroke:var(--t5)} .tink .t6{stroke:var(--t6)} .tink .t7{stroke:var(--t7)}
.ramp{display:flex;align-items:center;gap:2px;font-size:.8rem;color:var(--muted);margin-top:6px}
.ramp span{margin:0 6px} .ramp i{flex:1;height:8px;max-width:36px;border-radius:2px}
.ramp .t0{background:var(--t0)} .ramp .t1{background:var(--t1)} .ramp .t2{background:var(--t2)} .ramp .t3{background:var(--t3)}
.ramp .t4{background:var(--t4)} .ramp .t5{background:var(--t5)} .ramp .t6{background:var(--t6)} .ramp .t7{background:var(--t7)}
#tip{position:fixed;z-index:9;pointer-events:none;background:var(--ink);color:var(--bg);font-size:.8rem;padding:5px 8px;border-radius:6px;max-width:260px}
"""
JS = """
const tip=document.getElementById('tip');
function show(e){const t=e.target.closest&&e.target.closest('[data-tip]');if(!t){tip.hidden=true;return;}
tip.textContent=t.getAttribute('data-tip');tip.hidden=false;
const x=Math.min(e.clientX+12,innerWidth-tip.offsetWidth-8),below=e.clientY+16+tip.offsetHeight<innerHeight;
tip.style.left=Math.max(8,x)+'px';tip.style.top=(below?e.clientY+16:e.clientY-tip.offsetHeight-10)+'px';}
addEventListener('pointermove',show);addEventListener('pointerdown',show);addEventListener('scroll',()=>{tip.hidden=true},{passive:true});
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="a drawing (.json / .json.gz) or a folder of them")
    ap.add_argument("-o", "--out", help="HTML report path (default: hand.html next to the input)")
    a = ap.parse_args()
    p = Path(a.path)
    files = sorted(p.glob("*.json*")) if p.is_dir() else [p]
    if not files:
        sys.exit(f"No drawings found in {p}")
    lines, sheets, rates = analyse(files)
    motor = [l for l in lines if not l.fill and not l.white]
    whites = [l for l in lines if l.white]
    if not motor:
        sys.exit("No finished pen lines to measure.")
    # example marks for the galleries: the drawn path of a few lines of each kind
    galleries = []
    by_d = {}
    for k in range(len(CLASSES)):
        pick = gallery(motor, k, n=24 if k < 3 else 12)
        out = []
        for l in pick or []:
            if l.d not in by_d:
                by_d[l.d] = {s.i: s for s in load_drawing(files[l.d]).strokes}
            st = by_d[l.d][l.i]
            seg = st.drawn[:, 1:3]
            out.append((l, seg))
        galleries.append(out)
    white_gallery = []
    for l in random.Random(9).sample(whites, min(24, len(whites))):
        if l.d not in by_d:
            by_d[l.d] = {s.i: s for s in load_drawing(files[l.d]).strokes}
        white_gallery.append((l, by_d[l.d][l.i].drawn[:, 1:3]))
    html_out = report([str(f) for f in files], lines, sheets, rates, galleries, white_gallery)
    out = Path(a.out) if a.out else (p if p.is_dir() else p.parent) / "hand.html"
    out.write_text(html_out, encoding="utf-8")
    N = len(motor)
    pauses = [l.pause for l in motor if l.pause is not None and l.pause < BREAK_MS]
    print(f"{len(files)} drawing(s), {N} lines measured ({sum(l.fill for l in lines)} fill lines left out), {len(whites)} marks cut back in (paper-colour ink or eraser)")
    for k, (name, *_r) in enumerate(CLASSES):
        ls = [l for l in motor if l.cls == k]
        print(f"  {name:12} {len(ls):6}  {100 * len(ls) / N:4.0f}%   median {med([l.dur for l in ls]):6.0f} ms, peak {med([l.peak for l in ls]):6.1f} mm/s")
    print(f"  median pause {med(pauses):.0f} ms; {100 * sum(p < 200 for p in pauses) / max(1, len(pauses)):.0f}% of pauses under 200 ms")
    print(f"Report: {out}")


if __name__ == "__main__":
    main()
