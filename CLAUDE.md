# Natural Hand — project context for Claude

## What this is

Dimitar is an ink artist (and self-taught fullstack engineer, based in Bulgaria). The goal of this project is a **generator of his own hand**: a system that learns *how* he draws (the movement: path, rhythm, speed, pressure, tilt, pauses, corrections) from tablet data, and then generates new drawings in his hand, endlessly.

His work: dense, accretive black-ink drawings (originally pen on paper). Organic-mechanical masses that look grown rather than designed: tangles, contours with a fringe of short perpendicular hairs, stipple, cross-hatching, solid black fills (often leaving white negative shapes), drips, ribbed/segmented forms, coiled shells, and **body figures**: pale skull-faced heads with dark eye sockets, small figures and crowds, half-swallowed by the mass. **The figures are the most important element to him.** He seems to work in passes: light construction lines, then contours, fringe, stipple, fills, drips (to be confirmed by the data).

The original brief framed this with Kant's Critique of Judgment (§45–47: art that seems like nature; genius; following vs. imitating an exemplar). He later said plainly: "I just want to create a generator of me." The research/philosophy angle is optional and can come back later (dataset, motor signatures, co-drawing, Kant as exhibition frame). Never claim results "prove" anything.

## Current status

**Phase 1, the capture app, is built and live** (v0.6.2):
- Repo: https://github.com/DimitarPetrov77/natural-hand (public, `main` branch, GitHub Pages, `.nojekyll`)
- App: https://dimitarpetrov77.github.io/natural-hand/
- Local folder: `C:\Users\Dima\Desktop\natural-hand\natural-hand`
- Devices: Wacom on a Windows PC (Chrome, Windows Ink), Galaxy Tab S7, Galaxy S26 Ultra (S Pen). Installed as a PWA on the Android devices.
- Google Drive sync: Google Cloud project `natural-hand`, OAuth Web client (ID in `config.js`, public by design), scope `drive.file` only, app in Testing mode with Dimitar's Gmail as test user. No client secret is used anywhere (an old one from a different project was exposed in chat and should be deleted).

**Next phase:** Dimitar collects real drawings. Then: a data health report per device, stroke-vocabulary analysis, then the model.

## Files

- `index.html` — UI markup and all CSS (no framework, no build step)
- `app.js` — the whole app (vanilla JS, one IIFE). Bump `APP_VERSION` on every change.
- `sw.js` — service worker, offline shell, stale-while-revalidate. Bump `CACHE` on every release or installed copies keep old files.
- `config.js` — Google client ID
- `vendor/mp4-muxer.js` — MIT library (Vanilagy, v5.2.2) used for MP4 video export, bundled so it works offline
- `tools/load.py` — Python loader for exported drawings (`.json` / `.json.gz`) into NumPy
- `tools/health.py` — data health report per device (sample rate, gaps, pressure saturation, tilt, hover, calibration), console summary + `health.html`
- `update.ps1` — old copy-and-push helper from before Claude Code; not needed now
- `README.md` — user-facing documentation; keep it in sync with features

## app.js map (search for the section comments)

storage (IndexedDB: `drawings`, `strokes` keyed `[drawing, i]`, `events`) · state `S` · view canvas + transform (`screen = R(rot)·(doc_mm·ppmm·zoom) + t`) · sharp layer (vector re-render at screen resolution when the view is idle; page bitmap max 4096 px used during gestures) · page bitmap / bounds / endless pages · smoothing (`smoothStep`, `smoothRows`, `normalizeStroke` migration) · widths from pressure (`BRUSHES`, `pressure_gamma`) · `strokeRuns` / `drawStroke` (shared by canvas and SVG) · vector eraser `computeErasure` · capture (`sampleOf`, pointer handlers, coalesced events, hover) · touch gestures · actions (undo/redo/figure/fill) · drawings (open/new/export JSON) · Google Drive (`Drive`, sync, cross-device `mergeData`) · images (PNG/SVG) · `Replay` · `Video` (WebCodecs + mp4-muxer) · life size · session prompts · time away · pressure feel · diagnostics · UI.

Test hook: `window.__nh` exposes state and key functions for automated tests.

## Data principles (agreed, keep them)

- **Never lose movement data.** Raw device samples are always kept: if smoothing > 0, `samples` is the smoothed path and `raw` holds the device samples.
- **Nothing is deleted.** Undo marks `undone_at`; the eraser marks ranges in `erased` (`[[first, last, eraser_i]]`); eraser strokes stay in the data.
- Every coalesced sample is recorded. Hover (pen in the air before each stroke) is recorded with negative `dt`.
- Coordinates are paper millimetres (calibrated `ppmm` per device); each stroke stores its view and ppmm.
- Times: stroke `t0` is wall-clock epoch ms, corrected for device sleep (`clockDrift`); `away_start`/`away_end` events mark when the app was hidden.
- Cross-device merge identifies strokes by `(session, t0)`; figure numbers that collide are renumbered.
- Per-stroke context: device session, brush, width, smoothing, pressure_gamma, figure id, fill tag, session prompt.
- Format name `natural-hand/1`; the export includes `sample_fields` and a `units` block describing every field.

## Features and Dimitar's choices

- Pens: Technical (constant width, like Sketchbook's technical pen, which he likes), Ink pen and Brush pen (width from pressure). Widths 0.1–2.0 mm. Smoothing 0–100 (time-based, changes recorded samples, raw kept).
- **Eraser: always the pen's width, no size setting.** Only choice: *Whole lines* (deletes every line it touches, as recorded; default) or *Cut through*. He asked for exactly this; don't add eraser settings.
- Figure marking: button, `F`, or the pen side button (S Pen side button while hovering; Wacom lower barrel button as right-click).
- Fill marking (`G`) so scrubbing strokes can be excluded from motor statistics.
- Pages A5–A1, 30 cm square, Endless (grows near its edges). Life-size 1:1 zoom chip. Pressure feel per device.
- Replay (real order and speed, cursor incl. hover, erasing/undo at the right moment, skip pauses, up to 64×), PNG/SVG export, MP4 replay video export (shapes incl. 9:16, up to 4K, fit to length, fps, quality).
- Session prompts with timer (pauses while away).
- Recommendation he accepted implicitly: avoid layers, shape tools, rulers, symmetry, copy/paste, transform, fill bucket — they create marks his hand didn't make. If ever added, tag those strokes so they can be excluded from training.

## How to work on this

- Dimitar wants changes made directly in this folder and pushed, not files to copy by hand. After a change: bump `APP_VERSION` (app.js) and `CACHE` (sw.js), update README if user-facing, commit, push to `main`. Pages deploys in 1–2 minutes; installed PWAs pick up the update on the second launch.
- Test before pushing. The in-app browser pane cannot register service workers, so use Playwright for anything involving `sw.js`. Previous testing used Python Playwright with headless Chromium: serve the folder with `python -m http.server`, drive pen input with CDP `Input.dispatchMouseEvent` (`pointerType: 'pen'`, `force`, `tiltX/Y`), check state through `window.__nh`, screenshot the UI (landscape ~1280×800 and phone ~412×900). Google Drive was tested against a mocked Drive API via `context.route`. Videos were checked with ffprobe/ffmpeg.
- Keep it dependency-free (no framework, no build). Writing style for UI text: plain, sentence case, says what happens.
- Things not yet verified on real devices: S Pen tilt and sample rate in Chrome, side button vs. Samsung Air Command, Wacom barrel button mapping, real-device video encoding speed.

## Open items / ideas

- Auto-update notice built in 0.6.2 (`watchForUpdates`: chip on `controllerchange`, update check on return to foreground and every 30 min; sw install bypasses HTTP cache).
- Data health report built (`tools/health.py`); next: run it on Dimitar's first real drawing from each device.
- Then analysis: cluster stroke types (contour, fringe, stipple, fill, drips…), pass/phase structure over a drawing's timeline, how figures are constructed.
- Model plan (discussed and agreed in outline): autoregressive transformer with a mixture-density output over `(dx, dy, dt, pressure, tilt, pen state)`, conditioned on recent strokes plus a CNN-encoded canvas patch around the pen; three levels (planner: what/where next; stroke model; dedicated figure model trained on tagged figures); maximum likelihood training in PyTorch; later preference fine-tuning (e.g. DPO) from his ratings; diffusion over whole strokes as a later comparison. No pixel image generators (they learn the look, not the movement). First experiment: given a contour, does the model fringe it like him? Unknown yet: his GPU / whether to train in the cloud.
