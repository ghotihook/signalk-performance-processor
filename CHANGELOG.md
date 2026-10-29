# Changelog

## 0.2.4 — 2026-10-30

- **The pipeline's boxes are all one size and stay put.** Each box is fixed in size, so nothing moves as the values change: a long value is cut with "…" and a long note stops after two lines, with the whole note on hover. Damping is a box like the others ("Damping, 3 s"), and the sent values sit in boxes of one size on the right.
- **Screenshots** for the README and the Signal K App Store (`signalk.screenshots`): the Live page (light, dark and phone), the TWA and boat speed tables, and Settings, in `docs/screenshots/`.
- **The description says what it is for**: the problem (TWD swinging through tacks and gybes), what it does (true wind calibrated in Signal K the way an H5000 does) and how it is calibrated (from your own sailing), before the features. In `package.json` and at the top of the README.
- **The App Store icon**: `icon.svg` is now also at the package root, where `appIcon` points.

## 0.2.3 — 2026-10-30

- **No longer marked a proof of concept**: the README's banner is gone (the advice to start in Shadow mode stays, in Calibrating your boat), and the changelog link moves into the introduction.
- **Light air and missing inputs mention ground wind**: in light air its direction and angle are held back with TWA and TWD, and without heading, SOG or COG there is none; the README, Settings and the status line now say so.
- **The documentation says apparent wind must be raw**: AWA and AWS as the masthead measures them, uncorrected and undamped, since the plugin corrects and damps them itself. Stated at the top of "Calibrating your boat" in the README and under Input sources in Settings, with how to get it (wind tables out and wind damping at 0 in the instrument, or a source ahead of it) and the one exception (masthead alignment stays in the instrument).

## 0.2.2 — 2026-10-30

- **Ground wind**: the wind over the ground, true wind plus current, so the tables apply to it too. Published as `environment.wind.speedOverGround`, `angleTrueGround` and `directionGround` (the last is not in the Signal K schema, so it carries `meta`; in Shadow mode all three get the `Corrected` suffix), damped as true wind, with direction and angle held back in light air.
- **The Live pipeline as one chain per value sent**, checked against the code: each row reads left to right, what it uses, each step with its value now, the damping, and on the far right what is sent. A value made by another chain is marked "from boat speed" and so on, instead of a crossing line. So heel and corrected STW go into leeway; corrected STW, leeway, heading and SOG/COG into current; STW is sent from the STW table; and TWA is sent as the damped TWD less the heading. On a narrow screen each chain stacks. The README has the same chains as a table.
- **Releases on GitHub carry their changelog section.** A new workflow (`release.yml`, Linux, seconds) makes a GitHub release for each version tag, its notes that version's section of this file; run it by hand to add one for an existing tag.
- **The TWS table says how it blends in.** The Calibration page explains that it ramps in with TWA rather than switching on, with a worked example from the values being edited ("at 10 kn TWS: nothing at 90° TWA or less, −0.50 kn at 128°, the full −1.00 kn from 165° to 180°"), and that a down angle near 90° makes the ramp short and steep. On the Live diagram the TWA and TWS table boxes show the table's own account, including how much of the row applies while it blends in or fades out.

## 0.2.1 — 2026-10-30

### Added

- **The pipeline as a diagram** on the Live page: one lane each for boat speed, true wind and direction, from the inputs to what is published, with each step's value now and what it changed. Switched-off steps are dashed. On a narrow screen it turns on its side. The step table is kept under **Step by step**, and the README has the same diagram.
- **README:** how good the boat speed / heel table is (held out, within 0.005 kn RMS of a fine table with each side separate; it cannot follow a difference between sides), so `signalk-stw-heel-correction` is not needed alongside; and why current is a trend rather than a live number (on this boat 0.36 kn of change across a tack, mostly the paddlewheel's day-to-day speed scale, which damping does not remove). The Live page's Current tile says the same in brief.

## 0.2.0 — 2026-10-29

**Upgrading:** a saved configuration from 0.1.x loads, but its TWA table was fitted with leeway in true wind and now over-corrects. Reset the TWA table to defaults, or better, refit with boatcal `plugincal` 1.3.0 and paste or load the result.

### Changed

- **Leeway is out of true wind**, as on the H5000 by default ("Leeway corrected wind" off). True wind is apparent wind minus the boat's velocity along the heading, and the TWA table takes up leeway's effect. Leeway is still published and still used for current. There is no switch: one way, one table to fit, and a table from an H5000 or `plugincal` means the same thing here.
- **Defaults refitted** by `plugincal` 1.3.0 on the same data as 0.1.1 (every labelled race leg, January 2025 to March 2026): the TWA table for leeway-free true wind, and leeway K from the GPS (8.568, was 7.9446). Held out by day: tacks 6.8°, gybes 4.4° (the H2000 8.2°, 9.6°).

### Added

- **Damping**, in seconds as on the H5000, in Settings (0 = none): heading 2 s and heel 2 s on the way in; true wind 3 s (TWD and TWS; TWA is the damped TWD less the heading, so it answers the helm at once), STW 1 s and current 10 s on the way out. Replayed through every tack and gybe from January 2025 to September 2026, one-second TWD jumps over 5° on straight legs fall from about 480 an hour to 40 (the H2000's own TWD: 31), and the largest swing during a tack from 23° to 11° (the H2000: 14°), with the TWD step across manoeuvres no worse.
- The Live page shows the published, damped values, with the undamped and uncorrected ones under them.

### Removed

- Upgrading configurations from before 0.1.0 (schemas 1 and 2, and 0.0.1's plugin options). Their tables do not apply now; such a file is refused with that reason, and the webapp opens on the defaults to fix it.
- Pasting a `signalk-stw-heel-correction` CSV into the boat speed table: paste the H5000 layout, which `plugincal` prints.
- The STW echo detector, a second backstop against a loop with another STW plugin: reading STW from sensors only, and the 20 Hz circuit breaker, already stop one.

## 0.1.1 — 2026-10-29

- **Defaults fitted for the H5000 layout.** The STW and TWA tables are now boatcal `plugincal` 1.2.0's fit on every labelled race leg from January 2025 to March 2026 (158 tacks, 27 gybes). Held out by day it beats the H2000 on tacks (6.7° against 8.2°) and gybes (4.7° against 9.6°). 0.1.0's defaults were the older values carried onto the new rows, never fitted for them. This is the boat before its 2026 rig tune and H2000 reset: on the three clean days since, which it never saw, it over-corrects TWA by about 3.5° and the H2000 is ahead, so refit for the boat as it is now. Defaults apply on a fresh install or Reset to defaults; a saved configuration is not changed.
- README: the results table is plugincal's held-out comparison against the H2000.

## 0.1.0 — 2026-10-29

Still a proof of concept: run it in Shadow mode alongside your instruments. **Saved configurations are upgraded to schema 3, the H5000 layout; refit the TWA table** (boatcal `plugincal`), because its rows now sit at different angles.

- **The H5000's table layout.**
  - Boat speed / heel: heel 0, 10, 20° either side × boat speed 0, 5 … 30 kn, bilinear, edges held. The correction fades out below 1 kn, so a stopped boat is not given speed by the 0 kn column. Fitted to two years of race logs, this 9-cell table predicts held-out days almost as well as the old 255-cell signed table (leftover error 0.290 against 0.282 kn RMS); port and starboard rows added nothing.
  - TWA: rows at TWA 40°, 90° and 165° (were configurable, 70° / 100° / 130°), linear between, by TWS 0, 5 … 30 kn. The 0 kn column fades the correction out in no wind. Fitted the same way, these rows predict held-out tacks and gybes better than the old ones, because the upwind correction changes between 40° and 55° of TWA.
  - TWS: one correction row and a down angle row by TWS 0 … 30 kn (were three rows): none below 90° TWA, in full from the down angle (165° by default).
- **Paste a table** for every table, and **Copy this table**, in the text format boatcal `plugincal` prints. The boat speed table still accepts the `signalk-stw-heel-correction` CSV, resampled onto the new layout. The format and its parser are one file, `public/tables.js`, used by the plugin and the webapp alike.
- Defaults: the existing values carried onto the new layout (the STW table resampled, port and starboard averaged, to 0.01 kn), not refitted.
- Built-in limits on the Calibration page describe the new rules.

## 0.0.6 — 2026-10-29

Still a proof of concept: run it in Shadow mode alongside your instruments. Validated against 19 races of 2026 logs; the tables are unchanged.

- **Fix: TWD followed the bow through every tack.** The TWA correction was applied in full right up to head to wind, so any \|TWA\| smaller than the correction read exactly 0° and TWD equalled heading for that part of the tack (correction jumps of up to 22° in a second in race logs). It now fades out over the last 30° to head to wind.
- **Fix: TWA jumped crossing dead downwind** when the downwind correction was negative (5–7° in 7–12 kn of TWS). It now fades out over the last 10° to dead downwind.
- The TWA table's values must now be within ±30° (upwind) and ±10° (downwind), and its row angles outside the fades, so corrected TWA always moves with uncorrected TWA.
- **Fix: leeway snapped from 0° to the 15° cap** as the boat reached 1 kn, and sat at the cap up to about 2.5 kn. It now fades in between 1.5 and 3 kn.
- **Light air:** below 1.5 kn of TWS, TWA and TWD are not published and the status and Live page say so; they return from 2 kn.
- **Self-documenting limits:** each correction on the Calibration page lists its built-in limits (TWA fades and value limits, leeway cap and fade-in, STW taper below the first speed column), and Settings lists light air, stale inputs, the rate limit and implausible input. The numbers come from the plugin's own constants via `GET /calibration`, so the text cannot drift from the code.
- Fix: when STW went stale, the status named the paddlewheel as if it were another plugin. It now names only plugin sources.

## 0.0.5 — 2026-10-29

Still a proof of concept: run it in Shadow mode alongside your instruments.

- **Fix: feedback loop with another STW plugin in Replace mode.** With `signalk-stw-heel-correction` (0.2 or earlier) on the same server, each plugin corrected the other's STW and handed it back, so STW and true wind ran away. Without a chosen STW source, STW is now read from sensors only (updates that carry a `source` object from a data connection), never from another plugin. Choosing a source in Settings still overrides this.
- **Rate limit as a circuit breaker:** no path is published more often than 20 Hz. A feedback loop is cut at its first repeat, and a backlog flushed after a dropout is thinned rather than stopped; nothing latches. While updates are being dropped, the status and the Live page say so, with a count and the source driving them, for 10 s after the last one; the first is logged.
- The status says when STW is arriving only from other plugins, and names them.
- Settings: the STW source's blank choice reads **Auto (sensors only)**.

## 0.0.4 — 2026-10-29

Still a proof of concept: run it in Shadow mode alongside your instruments. Saved configurations are upgraded to schema 2 on first load.

- **STW correction is a heel × speed table** (signed heel rows, STW columns), like the H5000's boat speed / heel table, with bilinear interpolation and blank cells filled from the nearest value. The default is the owner's full measured table. A table in the `signalk-stw-heel-correction` CSV format can be pasted into the webapp.
- **TWS table is in knots** (H5000 units). Default downwind −0.5 … −3 kn (−10% of each column); upwind and reach blank, meaning no correction.
- **New TWA table defaults** from the owner's calibration fit. Blank TWA cells mean too little data and use the nearest measured cells in the row.
- Config file schema 2. Schema 1 files are upgraded on load: the two STW rows become their grid and TWS percentages become knots.
- Live pipeline: each step's result is tagged **Published** or **Working**, worked out from what later enabled steps replace, so intermediate values are not mistaken for outputs.
- Calibration tables: the breakpoints (TWS columns, STW speeds, heel angles) are fixed labels, not editable fields; only the correction values are edited.
- Live page: a "Published to Signal K" table lists exactly what the plugin sends and on which path. The pipeline's true wind step is labelled "before tables", so its working TWA is not mistaken for a second output.

## 0.0.3 — 2026-10-29

Still a proof of concept: run it in Shadow mode alongside your instruments.

- Fix: the Calibration and Settings pages were empty on a real server. The plugin's `/config` endpoint was shadowed by the server's own route of that name; it is now `/calibration`, and the webapp says so if the calibration cannot be loaded.
- README and App Store description explain the problem this solves, who it is for, and the results on the boat it was built for.

## 0.0.2 — 2026-10-29

Still a proof of concept: run it in Shadow mode alongside your instruments.

- Heading for TWD and current comes from `navigation.headingTrue` if present, otherwise magnetic heading plus `navigation.magneticVariation` (normally from the GPS). The variation in Settings is now only a fallback, and the Live page says which is in use.
- Configuration is edited only in the webapp and saved to `config.json` in the plugin's data directory. The admin Plugin Config form no longer shows the tables, so saving it cannot overwrite them. A configuration saved by 0.0.1 is picked up until the webapp first saves.
- The configuration file records its format version (`"schema": 1`). Future releases upgrade older files as they load; a file from a newer release is refused and never overwritten.

## 0.0.1 — 2026-10-29

First release, a proof of concept. Run it in Shadow mode alongside your instruments before relying on it.

- Corrections, each with an on/off switch: boat speed (linearity by speed plus heel correction), leeway (K × heel ÷ STW²), and H5000-style TWA and TWS tables with upwind, reach and downwind rows by TWS.
- True wind from apparent wind minus boat velocity including leeway; TWD from heading and variation; current from SOG/COG.
- Shadow mode publishes `…Corrected` paths; Replace mode publishes the standard paths under the plugin's own source for Source Priorities.
- Webapp with Live, Calibration and Settings pages. Configuration is saved as the plugin's options and validated before it is applied.
- Ships with this boat's defaults: the owner's STW table and leeway K, and TWA/TWS tables fitted to the 2025 race logs.
- Loop guard, input plausibility checks, a choice of source per input, and a test suite.
