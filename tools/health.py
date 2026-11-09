"""Data health report: is each device recording what we think it records?

Run it on the first drawings from every device before collecting a lot more,
so problems (low sample rate, dropped samples, pressure that tops out, no tilt,
no hover, uncalibrated millimetres) show up early.

Usage:
    python tools/health.py path/to/drawing.json.gz
    python tools/health.py path/to/folder            # every drawing in it
    python tools/health.py path/to/folder -o report.html

Prints a summary per device and writes an HTML report (default: health.html
next to the input) with the checks and histograms.
"""
from __future__ import annotations
import argparse, html, sys
from collections import Counter, defaultdict
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from load import load_drawing  # noqa: E402

OK, CHECK, INFO = "ok", "check", "info"


class Device:
    def __init__(self, name):
        self.name = name
        self.drawings = set()
        self.sessions = {}
        self.strokes = 0
        self.undone = self.erasers = self.cancelled = self.figure = self.fill = self.smoothed = 0
        self.with_hover = 0
        self.hover_dropped = 0
        self.pointer = Counter()
        self.intervals = []      # ms between consecutive device samples while touching
        self.hover_intervals = []
        self.pressure = []
        self.tilt_x = []
        self.tilt_y = []
        self.altitude_present = 0
        self.twist_nonzero = 0
        self.samples = 0
        self.speed = []          # mm/s between consecutive samples
        self.step = []           # mm between consecutive samples
        self.draw_ms = 0.0

    def add(self, st):
        self.strokes += 1
        self.pointer[st.pointer_type or "?"] += 1
        self.undone += st.undone
        self.erasers += st.tool == "eraser"
        self.cancelled += st.cancelled
        self.figure += st.figure is not None
        self.fill += "fill" in (st.tags or [])
        self.smoothed += st.smoothing_tau_ms > 0
        self.hover_dropped += st.hover_dropped
        f = st.fields
        raw = st.raw if st.cancelled else st.raw[:-1]   # last row is the pen-up event
        if len(raw) == 0:
            return
        t = raw[:, f.index("dt_ms")]
        self.samples += len(raw)
        self.draw_ms += float(t[-1] - t[0])
        if len(raw) > 1:
            dt = np.diff(t)
            self.intervals.extend(dt.tolist())
            d = np.hypot(np.diff(raw[:, f.index("x_mm")]), np.diff(raw[:, f.index("y_mm")]))
            self.step.extend(d.tolist())
            ok = dt > 0
            self.speed.extend((d[ok] / dt[ok] * 1000).tolist())
        self.pressure.extend(raw[:, f.index("pressure")].tolist())
        self.tilt_x.extend(raw[:, f.index("tiltX")].tolist())
        self.tilt_y.extend(raw[:, f.index("tiltY")].tolist())
        self.altitude_present += int(np.sum(~np.isnan(raw[:, f.index("altitude")])))
        self.twist_nonzero += int(np.sum(np.nan_to_num(raw[:, f.index("twist")]) != 0))
        if len(st.hover) > 1:
            self.with_hover += 1
            self.hover_intervals.extend(np.diff(st.hover[:, f.index("dt_ms")]).tolist())
        elif len(st.hover) == 1:
            self.with_hover += 1


def collect(paths):
    devices = {}
    for p in paths:
        d = load_drawing(p)
        by_session = {s["id"]: s for s in d.meta.get("sessions", [])}
        for st in d.strokes:
            sess = by_session.get(st.session, {})
            name = (sess.get("device") or {}).get("name") or "Unknown device"
            dev = devices.setdefault(name, Device(name))
            dev.drawings.add(d.id)
            if st.session and st.session in by_session:
                dev.sessions[st.session] = sess
            dev.add(st)
    return devices


def pct(a, q):
    return float(np.percentile(a, q)) if len(a) else float("nan")


def checks(dev):
    """[(verdict, topic, finding, what to do)]"""
    out = []
    iv = np.array([x for x in dev.intervals if x >= 0])
    p = np.array(dev.pressure)
    tx, ty = np.array(dev.tilt_x), np.array(dev.tilt_y)

    if len(iv) == 0:
        return [(CHECK, "Samples", "No strokes with more than one sample.", "Draw a few longer lines on this device.")]

    med = float(np.median(iv[iv > 0])) if np.any(iv > 0) else float("nan")
    rate = 1000 / med if med > 0 else float("nan")
    jitter = f"middle 80% of intervals {pct(iv, 10):.1f}–{pct(iv, 90):.1f} ms"
    if rate >= 100:
        out.append((OK, "Sample rate", f"{rate:.0f} Hz ({med:.1f} ms between samples; {jitter}).", ""))
    elif rate >= 60:
        out.append((CHECK, "Sample rate", f"{rate:.0f} Hz ({med:.1f} ms; {jitter}).",
                    "Fine for contours, thin for fast fringe and stipple. Check Chrome reports coalesced events on this device."))
    else:
        out.append((CHECK, "Sample rate", f"Only {rate:.0f} Hz ({med:.1f} ms; {jitter}).",
                    "Too low for fast strokes. Check the browser and pen driver settings."))

    gaps = iv > 2.5 * med
    share = gaps.mean() * 100
    out.append((OK if share < 1 else CHECK, "Gaps",
                f"{share:.2f}% of intervals are over 2.5× the usual one; longest {iv.max():.0f} ms.",
                "" if share < 1 else "Likely dropped samples (busy device, battery saver, or the app was rendering)."))

    dup = float((iv == 0).mean() * 100)
    if dup >= 1:
        out.append((CHECK, "Repeated times", f"{dup:.1f}% of samples share a timestamp with the previous one.",
                    "The device batches samples; treat speed per sample with care."))

    if len(p):
        flat = float(np.mean(np.isclose(p, 0.5)) * 100)
        top = float(np.mean(p >= 0.995) * 100)
        levels = len(np.unique(np.round(p, 4)))
        desc = f"median {np.median(p):.2f}, 1–99% range {pct(p, 1):.2f}–{pct(p, 99):.2f}, {levels} distinct values."
        if flat > 90:
            out.append((CHECK, "Pressure", f"Almost always 0.5 ({flat:.0f}%). This is what browsers report without pressure.",
                        "The pen is not being read as a pen. Check Windows Ink / pointer type."))
        elif top > 5:
            out.append((CHECK, "Pressure", f"Tops out: {top:.1f}% of samples at full pressure. {desc}",
                        "Hard presses all look the same in the data. Soften the pen driver's pressure curve (the app's pressure feel only changes widths, not recorded values)."))
        elif levels < 64:
            out.append((CHECK, "Pressure", f"Coarse: {desc}", "Pressure is quantised; fine shading may not be captured."))
        else:
            out.append((OK, "Pressure", desc, ""))

    moving = float(np.mean((tx != 0) | (ty != 0)) * 100) if len(tx) else 0
    if moving < 1:
        out.append((CHECK, "Tilt", "No tilt reported (tiltX and tiltY are always 0).",
                    "This device or browser does not pass tilt through. Models can still train without it, but this device's data will lack it."))
    else:
        out.append((OK, "Tilt", f"Reported on {moving:.0f}% of samples; tiltX {pct(tx, 1):.0f}…{pct(tx, 99):.0f}°, tiltY {pct(ty, 1):.0f}…{pct(ty, 99):.0f}°.", ""))
    if dev.samples:
        alt = dev.altitude_present / dev.samples * 100
        out.append((INFO, "Altitude / twist", f"Altitude angle on {alt:.0f}% of samples; twist non-zero on {dev.twist_nonzero / dev.samples * 100:.0f}%.", ""))

    pen = dev.strokes - dev.erasers
    hov = dev.with_hover / dev.strokes * 100 if dev.strokes else 0
    if hov >= 50:
        hr = ""
        hi = np.array([x for x in dev.hover_intervals if x > 0])
        if len(hi):
            hr = f" Hover rate about {1000 / np.median(hi):.0f} Hz."
        out.append((OK, "Hover", f"{hov:.0f}% of strokes have pen-in-the-air samples before them.{hr}", ""))
    else:
        out.append((CHECK, "Hover", f"Only {hov:.0f}% of strokes have hover samples.",
                    "The approach to each stroke is missing. On Wacom check Windows Ink is on; some screens only report hover very close to the glass."))
    if dev.hover_dropped:
        out.append((INFO, "Hover limit", f"{dev.hover_dropped} hover samples were dropped during very long pauses (only the last 30,000 are kept).", ""))

    cal = [bool((s.get("device") or {}).get("calibrated")) for s in dev.sessions.values()]
    if cal and not all(cal):
        out.append((CHECK, "Calibration", f"{cal.count(False)} of {len(cal)} sessions were drawn before calibrating.",
                    "Millimetres there are estimates. Calibrate in the menu (Life size)."))
    elif cal:
        out.append((OK, "Calibration", "All sessions calibrated, so millimetres are real.", ""))

    if len(dev.step):
        s = np.array(dev.step)
        out.append((INFO, "Movement", f"median step {np.median(s):.2f} mm between samples; "
                    f"median speed {np.median(dev.speed):.0f} mm/s, fast strokes up to {pct(dev.speed, 99):.0f} mm/s.", ""))
    out.append((INFO, "Content", f"{pen} pen strokes, {dev.erasers} eraser strokes, {dev.undone} undone, {dev.cancelled} cancelled; "
                f"{dev.figure} in figures, {dev.fill} tagged fill, {dev.smoothed} smoothed. "
                f"{dev.draw_ms / 60000:.1f} min with the pen down. Pointer types: "
                + ", ".join(f"{k} {v}" for k, v in dev.pointer.most_common()) + ".", ""))
    versions = sorted({s.get("app_version", "?") for s in dev.sessions.values()})
    if versions:
        out.append((INFO, "App versions", ", ".join(versions), ""))
    return out


# ---------------------------------------------------------------- HTML

def histogram(values, lo, hi, title, unit, bins=40):
    v = np.asarray([x for x in values if np.isfinite(x)])
    if len(v) == 0:
        return ""
    clipped = np.clip(v, lo, hi)
    counts, edges = np.histogram(clipped, bins=bins, range=(lo, hi))
    W, H, pad = 520, 120, 22
    bw = W / bins
    top = counts.max() or 1
    bars = []
    for i, c in enumerate(counts):
        h = c / top * (H - 4)
        if c == 0:
            continue
        a, b = edges[i], edges[i + 1]
        last = " (and above)" if i == bins - 1 and v.max() > hi else ""
        bars.append(f'<rect x="{i * bw + 1:.1f}" y="{H - h:.1f}" width="{max(bw - 2, 1):.1f}" height="{h:.1f}" rx="1.5">'
                    f'<title>{a:.3g}–{b:.3g} {unit}{last}: {c} samples</title></rect>')
    return (f'<figure><figcaption>{html.escape(title)}</figcaption>'
            f'<svg viewBox="0 0 {W} {H + pad}" role="img" aria-label="{html.escape(title)}">'
            f'<g class="bars">{"".join(bars)}</g>'
            f'<line x1="0" y1="{H + .5}" x2="{W}" y2="{H + .5}" class="axis"/>'
            f'<text x="0" y="{H + 16}">{lo:g} {unit}</text>'
            f'<text x="{W / 2}" y="{H + 16}" text-anchor="middle">{(lo + hi) / 2:g}</text>'
            f'<text x="{W}" y="{H + 16}" text-anchor="end">{hi:g}{"+" if v.max() > hi else ""}</text>'
            f'</svg></figure>')


ICON = {OK: ("✓", "OK"), CHECK: ("!", "Check"), INFO: ("·", "Info")}


def device_html(dev, rows):
    trs = "".join(
        f'<tr class="{v}"><td class="v"><span class="mark">{ICON[v][0]}</span> {ICON[v][1]}</td><th>{html.escape(t)}</th>'
        f'<td>{html.escape(f)}{"<div class=todo>" + html.escape(todo) + "</div>" if todo else ""}</td></tr>'
        for v, t, f, todo in rows)
    iv = np.array([x for x in dev.intervals if x > 0])
    med = float(np.median(iv)) if len(iv) else 10
    figs = [
        histogram(dev.intervals, 0, round(med * 4, 1), "Time between samples (pen down)", "ms"),
        histogram(dev.pressure, 0, 1, "Pressure (pen down)", ""),
        histogram(dev.speed, 0, max(50, round(pct(dev.speed, 99) * 1.2, -1)), "Pen speed", "mm/s"),
    ]
    if np.any(np.array(dev.tilt_x) != 0) or np.any(np.array(dev.tilt_y) != 0):
        figs.append(histogram(np.hypot(dev.tilt_x, dev.tilt_y), 0, 90, "Tilt from vertical (approx.)", "°"))
    n_check = sum(r[0] == CHECK for r in rows)
    head = f"{len(dev.drawings)} drawing{'s' * (len(dev.drawings) != 1)}, {dev.strokes} strokes, {dev.samples:,} samples"
    status = f'<span class="badge {CHECK if n_check else OK}">{n_check} to check</span>' if n_check else f'<span class="badge {OK}">All checks OK</span>'
    return (f'<section><h2>{html.escape(dev.name)} {status}</h2><p class="sub">{head}</p>'
            f'<table>{trs}</table><div class="figs">{"".join(figs)}</div></section>')


CSS = """
:root{--bg:#fbfaf7;--ink:#1d1c1a;--muted:#6b6862;--line:#e3e0d8;--ok:#2f7d4f;--check:#b4561c;--bar:#2b2a27}
@media (prefers-color-scheme:dark){:root{--bg:#171715;--ink:#ecebe6;--muted:#a19d95;--line:#33312d;--ok:#6cc08b;--check:#f0a066;--bar:#d9d6cf}}
body{background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px 64px}
main{max-width:860px;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:1.15rem;margin:0;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.sub{color:var(--muted);margin:2px 0 12px}
section{border-top:1px solid var(--line);padding-top:20px;margin-top:24px}
table{border-collapse:collapse;width:100%}
td,th{text-align:left;vertical-align:top;padding:7px 8px;border-bottom:1px solid var(--line)}
th{font-weight:600;white-space:nowrap}
td.v{white-space:nowrap;font-weight:600;font-size:.85rem;width:5.5em}
tr.ok td.v{color:var(--ok)} tr.check td.v{color:var(--check)} tr.info td.v{color:var(--muted)}
.mark{display:inline-block;width:1.1em;text-align:center}
.todo{color:var(--muted);font-size:.9rem;margin-top:2px}
.badge{font-size:.8rem;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid currentColor}
.badge.ok{color:var(--ok)} .badge.check{color:var(--check)}
.figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));gap:12px 24px;margin-top:16px}
figure{margin:0} figcaption{font-size:.85rem;color:var(--muted);margin-bottom:4px}
svg{width:100%;height:auto;display:block;overflow:visible}
.bars rect{fill:var(--bar)} .bars rect:hover{fill:var(--muted)}
.axis{stroke:var(--line)} svg text{fill:var(--muted);font-size:11px}
@media (max-width:560px){th{white-space:normal}}
"""


def report_html(devices, results, sources):
    secs = "".join(device_html(devices[n], results[n]) for n in devices)
    src = ", ".join(html.escape(Path(p).name) for p in sources[:6]) + (f" and {len(sources) - 6} more" if len(sources) > 6 else "")
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>Data health</title><style>{CSS}</style></head><body><main><h1>Data health</h1>'
            f'<p class="sub">{len(sources)} drawing file{"s" * (len(sources) != 1)}: {src}. One section per device. Hover a bar for its count.</p>'
            f'{secs}</main></body></html>')


def plain(s):
    """Console-safe text (Windows consoles often cannot print these characters)."""
    for a, b in (("–", "-"), ("×", "x"), ("µm", "um"), ("°", " deg"), ("…", ".."), ("→", "->")):
        s = s.replace(a, b)
    return s


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="a drawing (.json / .json.gz) or a folder of them")
    ap.add_argument("-o", "--out", help="HTML report path (default: health.html next to the input)")
    a = ap.parse_args()
    p = Path(a.path)
    files = sorted(p.glob("*.json*")) if p.is_dir() else [p]
    if not files:
        sys.exit(f"No drawings found in {p}")
    devices = collect(files)
    results = {n: checks(d) for n, d in devices.items()}
    for n, rows in results.items():
        d = devices[n]
        print(f"\n== {n}: {len(d.drawings)} drawing(s), {d.strokes} strokes, {d.samples} samples")
        for v, t, f, todo in rows:
            print(plain(f"  [{ICON[v][1]:5}] {t}: {f}"))
            if todo:
                print(plain(f"          -> {todo}"))
    out = Path(a.out) if a.out else (p if p.is_dir() else p.parent) / "health.html"
    out.write_text(report_html(devices, results, [str(f) for f in files]), encoding="utf-8")
    print(f"\nReport: {out}")


if __name__ == "__main__":
    main()
