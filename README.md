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

**Opening a drawing.** While a drawing opens, a loading screen shows its preview and what is happening (reading lines, drawing the page) with a progress bar; the pen does nothing until the drawing is ready. Drawings made with older versions do some one-time work the first time they open (converting figures to parts, working out erased lines), and the screen says so. Changes from your other devices are pulled in after the drawing is on screen, in the background; you can keep drawing meanwhile.

Updates install themselves in the background. When one is ready, a dark **New version ready. Reload** chip appears in the top corner; tap it when you are between strokes. It saves first, then reloads. The app checks for updates each time you come back to it, and every 30 minutes while it is open.

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
| White ink (and back to black) | width button, Black / White | W |
| Eraser: whole lines or cut through | eraser button, or the Wacom eraser end | E |
| Undo / redo | arrows | Ctrl+Z / Ctrl+Shift+Z |
| Start / end a part (figure, head, structure...) | part button, or the pen's side button; press again when it is done | F |
| Choose the kind of part, or start one inside another | hold the part button (or right-click it) | Shift+F |
| Mark black fill | fill button | G |
| Move, zoom, rotate page | one or two fingers | Space+drag, wheel, Shift+wheel |
| Fit page | fit button | 0 |
| Life size (1:1) | zoom chip at the top | L |
| Replay | menu, Replay | R, then Space to pause, Esc to close |
| Label parts afterwards | Replay, Label parts | |
| See, rename or remove parts | menu, Parts (or Parts in replay labelling) | |
| Replay video | menu, Export video | |
| Live pen data | menu | D |

Finger touches are ignored for a moment after the pen was near the screen, so a resting palm does not move the page. You can switch finger navigation off in the menu.

**Mark parts.** A part is one thing in the drawing: a figure, a head, a mass, a shell, a ribbed form, whatever you call it. Press the part button when you start one and again when it is finished; every stroke in between belongs to it. The small word under the button is the kind it will start. Hold the button to choose another kind. If a part is already open, the one you choose starts inside it (a head inside a figure, a figure inside a mass), and the next press ends the inner one. A part ended with nothing drawn in it is not kept. This is how the generator will learn your figures and structures as their own things, so it is worth the second it takes.

**Kinds.** Hold the part button, then Edit kinds, to make the list your own words. The list lives on each device; parts you already marked keep their kind. Mark only what something *is* here. How it is drawn (stipple, fringe, hatching, drips) can be found from the movement itself later, so there is no need to label it.

**Label afterwards.** In replay, press Label parts. Scrub to where a thing starts and press From here, then scrub to where it ends: everything drawn in between turns blue. Draw a loop around the thing on the page to leave out what is nearby; tap the page to drop the loop. Choose the kind and press Label. The next selection starts where the last one ended, so you can work through a drawing in order. A part labelled inside another is stored as inside it. Parts (in the labelling row, or in the menu) lists every part: change its kind, show its strokes, or remove it. Removing only takes the label back; strokes are never changed.

**Mark black fills** with the fill button, so scrubbing strokes do not distort the speed and pressure statistics.

Undo never deletes data: undone strokes stay in the file, marked with the time they were undone.

**Pen side button.** On the S Pen, press the side button while the pen hovers to start a part, and again to finish it. The phone gives a short buzz. On the Wacom, the lower barrel button does the same when it is set to right-click (the default). You can turn this off in the menu.

**Life size.** The zoom chip at the top shows the zoom. Tap it to see the page at real size (100% means 1 mm on screen is 1 mm on paper, if the device is calibrated); tap again to fit the page. Drawing mostly at life size keeps your hand movements comparable between drawings.

**Pages.** A5 to A1, a 30 cm square, or an endless page that grows in any direction as you draw near its edge.

**Replay.** Menu, Replay. The drawing redraws itself in the order and at the speed you made it, with a cursor where the pen was, including where it hovered. Erasing and undo happen when they happened. Skip pauses shortens breaks longer than 1.5 seconds; turn it off to see real time. You can zoom and move the page while it plays.

**Export video.** Menu, Export video, or the button in the replay bar. The replay is drawn frame by frame from your stroke data at the size you choose, not recorded from the screen, so lines stay sharp. Choose the shape (same as the page, 9:16 for Reels and Shorts, 4:5, square, 16:9), resolution up to 4K, length (fit into 15 s, 30 s, 1 min, 3 min, or a fixed speed), frame rate, quality, and whether to show the pen and skip pauses. The result is an MP4 (H.264 where the device supports it) that downloads, and on Android can be shared directly. It works offline; the MP4 packing uses the bundled mp4-muxer library (MIT licence, in `vendor/`).

**Export image.** Menu, Export image: PNG at 150, 300 or 600 dpi, or SVG with real millimetre sizes for Illustrator or Inkscape, with a white or transparent background. On Android you can share it directly. Endless pages are cropped to the ink.

**Sessions.** Menu, Start a session: pick a prompt (figures only, fast gestures, your own) and a time. Every stroke drawn during it carries the session, and a timer shows at the top. When time is up the phone buzzes and the session ends; you can keep drawing.

**Pressure feel.** Menu, This device: set how hard you press for the ink pen and brush pen to reach full width, separately for each device, so the S Pen and the Wacom feel alike. It changes only the drawn width; recorded pressure stays raw, and each stroke stores the setting.

**White ink.** In the width button, choose White to draw in white: white dots, white hairs, white lines carved into a black mass. White paints over what is already there, and anything drawn after it paints over the white, exactly in the order you drew. The pen button shows a white line on black while white is on; W switches back and forth. Width and pen type are shared with black. White marks are recorded as lines with `"ink": "white"`: they are drawing, not corrections, and the eraser and undo work on them like on any line.

**Pen types.** Technical pen keeps one width. Ink pen and brush pen change width with pressure: ink pen gently, brush pen strongly, with thin starts and ends. The pressure itself is recorded the same way for all three.

**Eraser.** It is always as wide as the pen and has one choice, in the width button while the eraser is on: **Whole lines** deletes every line it touches, exactly as the line was recorded; **Cut through** removes only the parts it passes over. Either way the ink is marked as erased in the data (`erased`) and left out of the final drawing, undoing the eraser brings it back, and the eraser strokes stay in the file as part of how you work.

**Smoothing.** It changes the recorded line, not just the screen: `samples` holds the smoothed path you see. When smoothing is above 0, the unsmoothed device samples are kept next to it as `raw`, so nothing about your real movement is lost. Smoothing is time-based, so a level feels the same on the Wacom, the tablet and the phone.

**Time away.** Stroke times are real clock times. When you lock the screen or switch apps, the data records `away_start` and `away_end` (with how long you were gone), so a pause to think and a break can be told apart. A session timer pauses while you are away. Phones stop their precise clock while asleep; the app corrects for that, so a 20-minute break shows as 20 minutes.

## 6. Data format

One file per drawing: `<id>.json.gz` in Drive (plain `<id>.json` from Download JSON), plus a `<id>.png` preview.

```
{
  "format": "natural-hand/1",
  "id", "title", "tags", "notes", "paper": { "name", "w_mm", "h_mm" },
  "sessions": [ { "id", "started", "device": { "name", "ppmm", ... }, "screen", "user_agent" } ],
  "sample_fields": ["dt_ms","x_mm","y_mm","pressure","tiltX","tiltY","twist","altitude","azimuth","tangential","width_px","height_px","buttons"],
  "strokes": [ {
      "i", "session", "t0" (epoch ms), "tool", "ink" ("black" or "white"; absent means black), "width_mm", "parts": [part ids], "tags", "pointer_type",
      "view": [zoom, rotation_rad, tx, ty], "ppmm",
      "hover": [ [dt_ms (negative), x_mm, y_mm, ...], ... ],
      "samples": [ [dt_ms, x_mm, y_mm, pressure, ...], ... ],   (the drawn, smoothed path)
      "raw": [ ... ],                                          (device samples, when smoothing > 0)
      "brush", "smoothing", "smoothing_tau_ms", "pressure_gamma", "prompt", "erased": [[first, last, eraser_i], ...],
      "undone_at", "cancelled"
  } ],
  "parts": { "<id>": { "kind", "parent" (id or null), "source": "live" | "replay" | "figure", "session", "created", "removed_at"? } },
  "prompts": [ { "id", "text", "minutes", "started", "ended" } ],
  "events": [ { "t", "type": "undo" | "redo" | "part_start" | "part_end" | "part_label" | "part_kind" | "part_remove" | "fill_start" | "fill_end" | "prompt_start" | "prompt_end" | "away_start" | "away_end", ... } ]
}
```

A stroke lists every part it belongs to; nesting is in each part's `parent`. Parts with `removed_at` were taken back and should be ignored. Drawings from before parts existed have a `figure` number on strokes; these open as parts `fig-N` of kind Figure, and the number is kept.

Positions are paper millimetres from the top-left corner. Every coalesced sample the device delivers is kept, with no resampling; `raw` (or `samples` when smoothing was 0) is exactly what the device reported. The last sample of each stroke is the pen-up event (pressure 0). Each stroke carries the page view at that moment, so its screen-space and physical movement can be reconstructed: `screen_px = R(rotation) * (mm * ppmm * zoom) + (tx, ty)`.

`tools/load.py` reads these files into NumPy arrays:

```
python tools/load.py path/to/folder
```

`tools/health.py` checks that each device records what it should. Run it on the first drawings from every device, before collecting a lot more:

```
python tools/health.py path/to/folder
```

It prints a summary per device and writes `health.html` next to the drawings. The report covers the real sample rate and gaps (dropped samples), whether pressure tops out, whether tilt and hover are reported, and calibration, each marked OK, Check or Info with what to do. It also has histograms of sample timing, pressure, speed and tilt.

`tools/hand.py` describes how you draw, from the movement in one drawing or a whole folder of them:

```
python tools/hand.py path/to/folder
```

It writes `hand.html` next to the drawings:
- your marks by size (dots, ticks, short and long lines), with real examples of each
- peak speed against length
- how pressure rises and falls through a line
- the directions lines travel
- pauses and pen travel in the air between lines
- white marks made with the eraser, as marks of their own (cutting white into the ink is drawing, not correcting)
- lines inside each kind of part compared with the rest, and a summary per device
- for each drawing: a timeline of what you drew in order, frames of how it grew, and the drawing coloured by when each line was drawn

The statistics use the device samples as recorded. Lines tagged as fill are left out; white marks are measured on their own. The report describes; it does not prove anything, and it gets more reliable with every drawing added. Drawings are personal: keep the reports out of the public repository.

## Known limits

- Each drawing lives on the device where it was started; Drive holds the copies. Continuing one drawing across devices is not supported yet.
- The page is held as a 4096-pixel bitmap, so ink softens when zoomed far in. The recorded data is unaffected.
- Very long sessions make big files (tens of MB uncompressed for many hours of drawing). Drive stores them compressed.
- After updating files on GitHub, bump `CACHE` in `sw.js` so installed copies pick up the new version.
