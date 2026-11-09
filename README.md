# Natural Hand: capture app

Draw with a technical pen on your Wacom (PC), Galaxy Tab S7 and Galaxy S26 Ultra. Every pen sample is recorded raw: position, timing, pressure, tilt, and the pen's path in the air between strokes. Drawings are saved on the device as you draw and sync to a `Natural Hand` folder in your Google Drive.

This is phase 1 of the generator. The model is trained on what this app records.

## 1. Put it online (GitHub Pages)

The app must be served over HTTPS to install on Android and to sign in to Google.

1. Create a GitHub repository, for example `natural-hand`, and upload every file in this folder.
2. In the repository: Settings, Pages, Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. After a minute the app is at `https://<your-username>.github.io/natural-hand/`.

To test on the PC first: run `python -m http.server 8000` in this folder and open `http://localhost:8000`.

## 2. Connect Google Drive (one time, about 10 minutes)

1. Open <https://console.cloud.google.com/>, create a project (any name).
2. APIs & Services, Library: enable **Google Drive API**.
3. APIs & Services, OAuth consent screen: choose External, fill in the app name and your email. Under Test users, add your own Google account. Leave the app in Testing.
4. APIs & Services, Credentials: Create credentials, OAuth client ID, type **Web application**. Under Authorized JavaScript origins add `https://<your-username>.github.io` (and `http://localhost:8000` for local testing).
5. Copy the client ID into `config.js`:
   ```js
   window.NH_CONFIG = { googleClientId: '1234-abc.apps.googleusercontent.com' };
   ```
6. Upload the changed `config.js` to GitHub.

The app asks only for the `drive.file` permission: it can see the files it creates and nothing else in your Drive.

Google's sign-in lasts about an hour. When it runs out, the Drive chip in the top corner says "Reconnect Drive"; tap it. Nothing is lost meanwhile, because drawings are always saved on the device first and sync when you reconnect.

## 3. Install on the tablet and phone

Open the GitHub Pages address in Chrome, then menu, **Add to home screen** (or Install app). It opens full screen and works offline.

## 4. Set up each device

The first launch asks for a device name and a size calibration. Do both on every device: they are stored with every stroke, so the model can tell your hands on different surfaces apart, and strokes are stored in real millimetres.

Then open the menu, turn on **Show live pen data**, and draw a few lines. The panel tells you what this device really delivers: pressure, tilt, hover, samples per second. Check this before recording serious work.

- **Wacom on Windows:** if the panel says the pen arrives as a mouse, open Wacom Tablet Properties, Mapping, and turn on **Use Windows Ink**. Note your pressure feel setting in the menu field and keep it fixed.
- **S Pen:** pressure and hover should appear. Tilt support in Chrome varies by device, so check the panel.
- **Twist** is only reported by Wacom's Art Pen.

## 5. Drawing

| Action | Pen and touch | Keyboard |
|---|---|---|
| Draw | pen | mouse also works |
| Pen type: technical, ink pen, brush pen | width button, top row | B |
| Pen width (0.1 to 2.0 mm) | width button | 1 to 7 |
| Smoothing (0 to 100) | slider under the widths | [ and ] |
| Eraser (0.5 to 8 mm, own width) | eraser button, or the Wacom eraser end | E |
| Undo / redo | arrows | Ctrl+Z / Ctrl+Shift+Z |
| Mark a figure | figure button, press again when the figure is done | F |
| Mark black fill | fill button | G |
| Move, zoom, rotate page | one or two fingers | Space+drag, wheel, Shift+wheel |
| Fit page | fit button | 0 |
| Live pen data | menu | D |

Finger touches are ignored for a moment after the pen was near the screen, so a resting palm does not move the page. You can switch finger navigation off in the menu.

**Mark your figures.** Press the figure button when you start a body and again when it is finished. Every stroke in between gets that figure's number. This is how the generator will learn your figures as their own thing, so it is worth the second it takes. Mark solid black fills the same way, so scrubbing strokes do not distort the speed and pressure statistics.

Undo never deletes data: undone strokes stay in the file, marked with the time they were undone.

**Pen types.** Technical pen keeps one width. Ink pen and brush pen change width with pressure: ink pen gently, brush pen strongly, with thin starts and ends. The pressure itself is recorded the same way for all three.

**Eraser.** It cuts the ink it passes over, in the data as well as on screen. Erased parts are marked on the stroke they belong to (`erased`) and left out of the final drawing. The ink is kept underneath, so undoing the eraser brings it back, and the eraser strokes themselves stay in the file as part of how you work.

**Smoothing.** It changes the recorded line, not just the screen: `samples` holds the smoothed path you see. When smoothing is above 0, the unsmoothed device samples are kept next to it as `raw`, so nothing about your real movement is lost. Smoothing is time-based, so a level feels the same on the Wacom, the tablet and the phone.

## 6. Data format

One file per drawing: `<id>.json.gz` in Drive (plain `<id>.json` from Download JSON), plus a `<id>.png` preview.

```
{
  "format": "natural-hand/1",
  "id", "title", "tags", "notes", "paper": { "name", "w_mm", "h_mm" },
  "sessions": [ { "id", "started", "device": { "name", "ppmm", ... }, "screen", "user_agent" } ],
  "sample_fields": ["dt_ms","x_mm","y_mm","pressure","tiltX","tiltY","twist","altitude","azimuth","tangential","width_px","height_px","buttons"],
  "strokes": [ {
      "i", "session", "t0" (epoch ms), "tool", "width_mm", "figure", "tags", "pointer_type",
      "view": [zoom, rotation_rad, tx, ty], "ppmm",
      "hover": [ [dt_ms (negative), x_mm, y_mm, ...], ... ],
      "samples": [ [dt_ms, x_mm, y_mm, pressure, ...], ... ],   (the drawn, smoothed path)
      "raw": [ ... ],                                          (device samples, when smoothing > 0)
      "brush", "smoothing", "smoothing_tau_ms", "erased": [[first, last, eraser_i], ...],
      "undone_at", "cancelled"
  } ],
  "events": [ { "t", "type": "undo" | "redo" | "figure_start" | "figure_end" | "fill_start" | "fill_end", ... } ]
}
```

Positions are paper millimetres from the top-left corner. Every coalesced sample the device delivers is kept, with no resampling; `raw` (or `samples` when smoothing was 0) is exactly what the device reported. The last sample of each stroke is the pen-up event (pressure 0). Each stroke carries the page view at that moment, so its screen-space and physical movement can be reconstructed: `screen_px = R(rotation) * (mm * ppmm * zoom) + (tx, ty)`.

`tools/load.py` reads these files into NumPy arrays:

```
python tools/load.py path/to/folder
```

## Known limits

- Each drawing lives on the device where it was started; Drive holds the copies. Continuing one drawing across devices is not supported yet.
- The page is held as a 4096-pixel bitmap, so ink softens when zoomed far in. The recorded data is unaffected.
- Very long sessions make big files (tens of MB uncompressed for many hours of drawing). Drive stores them compressed.
- After updating files on GitHub, bump `CACHE` in `sw.js` so installed copies pick up the new version.