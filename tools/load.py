"""Load Natural Hand drawings (.json or .json.gz) for analysis and training.

Usage:
    from load import load_drawing, iter_drawings
    d = load_drawing("2026-11-09_163308_qdc0.json.gz")
    for st in d.strokes:            # list of Stroke
        st.samples                  # numpy array, columns = d.fields
        st.xy, st.t, st.pressure    # convenience views

    python load.py path/to/folder   # prints a summary of every drawing
"""
from __future__ import annotations
import gzip, json, sys
from dataclasses import dataclass, field
from pathlib import Path
import numpy as np


@dataclass
class Stroke:
    i: int
    t0: float                 # epoch ms
    tool: str                 # "pen" or "eraser"
    width_mm: float
    figure: int | None
    tags: list
    pointer_type: str
    session: str
    undone: bool
    cancelled: bool
    samples: np.ndarray       # drawn path (smoothed positions), (n, len(fields)), nulls become NaN
    hover: np.ndarray         # pen in the air before this stroke, dt negative
    fields: list = field(repr=False)
    raw: np.ndarray = None    # device samples before smoothing (same as samples when smoothing was 0)
    brush: str = "technical"
    smoothing_tau_ms: float = 0.0
    erased: list = field(default_factory=list)   # [[first, last, eraser_i], ...]
    prompt: str | None = None  # session prompt id (see drawing.meta["prompts"])
    pressure_gamma: float = 1.0

    def col(self, name, which="samples"):
        return getattr(self, which)[:, self.fields.index(name)]

    @property
    def t(self): return self.t0 + self.col("dt_ms")
    @property
    def xy(self): return self.samples[:, 1:3]
    @property
    def pressure(self): return self.col("pressure")
    def visible_segments(self):
        """Pieces of the drawn path that survive erasing (list of arrays)."""
        if self.tool == "eraser" or self.undone:
            return []
        keep = np.ones(len(self.samples), bool)
        for a, b, *_ in self.erased:
            keep[a:b + 1] = False
        out, start = [], None
        for i, k in enumerate(np.append(keep, False)):
            if k and start is None:
                start = i
            elif not k and start is not None:
                out.append(self.samples[start:i]); start = None
        return out

    @property
    def drawn(self):
        """Samples while the pen touched the paper (drops the pen-up event)."""
        return self.samples if self.cancelled else self.samples[:-1]


@dataclass
class Drawing:
    id: str
    meta: dict
    fields: list
    strokes: list
    events: list

    def visible(self):
        """Ink strokes on the page (not undone, not eraser strokes)."""
        return [s for s in self.strokes if not s.undone and s.tool != "eraser"]


def _arr(rows, width):
    if not rows:
        return np.zeros((0, width))
    return np.array([[np.nan if v is None else v for v in r] for r in rows], dtype=float)


def load_drawing(path) -> Drawing:
    path = Path(path)
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as f:
        d = json.load(f)
    fields = d["sample_fields"]
    strokes = []
    for s in d["strokes"]:
        hov = s.get("hover") or []
        hov = hov.get("h", []) if isinstance(hov, dict) else hov
        strokes.append(Stroke(
            i=s["i"], t0=s["t0"], tool=s["tool"], width_mm=s["width_mm"], figure=s.get("figure"),
            tags=s.get("tags", []), pointer_type=s.get("pointer_type", ""), session=s.get("session", ""),
            undone=s.get("undone_at") is not None, cancelled=bool(s.get("cancelled")),
            samples=_arr(s["samples"], len(fields)), hover=_arr(hov, len(fields)), fields=fields,
            raw=_arr(s["raw"], len(fields)) if s.get("raw") else _arr(s["samples"], len(fields)),
            brush=s.get("brush") or "technical", smoothing_tau_ms=s.get("smoothing_tau_ms") or 0.0,
            erased=s.get("erased") or [], prompt=s.get("prompt"), pressure_gamma=s.get("pressure_gamma") or 1.0))
    meta = {k: v for k, v in d.items() if k not in ("strokes", "events")}
    return Drawing(d["id"], meta, fields, strokes, d.get("events", []))


def iter_drawings(folder):
    for p in sorted(Path(folder).glob("*.json*")):
        yield load_drawing(p)


def summary(d: Drawing) -> str:
    vis = d.visible()
    n = sum(len(s.samples) for s in vis)
    figs = len({s.figure for s in vis if s.figure is not None})
    dev = {s["device"]["name"] for s in d.meta.get("sessions", [])}
    if vis:
        dur = (vis[-1].t0 + vis[-1].samples[-1, 0] - vis[0].t0) / 60000
    else:
        dur = 0
    return f"{d.id}: {len(vis)} strokes, {n} samples, {figs} figures, {dur:.1f} min span, devices {sorted(dev)}"


if __name__ == "__main__":
    for d in iter_drawings(sys.argv[1] if len(sys.argv) > 1 else "."):
        print(summary(d))
