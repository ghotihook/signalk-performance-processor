# Agent instructions

Signal K plugin and webapp that calibrates true wind. [README.md](README.md) says what it does; [SPECIFICATION.md](SPECIFICATION.md) holds the maths. Two jobs:

- **[Calibrating a boat](#calibrating-a-boat):** fit a user's tables from their logs. No code changes.
- **[Changing this plugin](#changing-this-plugin):** working on this repository.

---

## Calibrating a boat

The user gives you a log of their sailing and wants the boat speed / heel table, leeway K, the TWA table and the TWS table for *this plugin's* arithmetic. Work through the steps in order. **Stop and ask** wherever a step says so: a table fitted from corrected or mislabelled data looks just as convincing as a right one.

### 0. Read first

- SPECIFICATION.md §1 (signs), §4 (lookups, blanks), §5 (the pipeline, in order), §5.4 (the TWA limit), §8.1 (what a table may hold), §9 (method).
- [boatcal](https://github.com/ghotihook/boatcal): the reference implementation. Its `SPECIFICATION.md` is the master of the method and every threshold; `boatcal/fit.py`, `events.py`, `decompose.py`, `settings.py` are the code. Follow it; don't invent a method.
- **Use the plugin's own code** for true wind and every lookup: `lib/processor.js` (`process`, `normalizeConfig`, `_internals`), `public/tables.js` (`lookup`, `fillGaps`, `parse`, `format`). boatcal's `boatcal/pipeline.js` shows how, including probing each lookup one cell at a time for the fit's design matrix.

### 1. Get the data into one table

1 Hz rows, degrees and knots, one sensor per column:

| Column | What | From |
|---|---|---|
| `ts` | UTC | Group by the boat's local day (the unit for held-out scoring) |
| `awa`, `aws` | apparent wind, ±180°, + = starboard | masthead unit; Signal K `environment.wind.angleApparent`, `speedApparent` |
| `stw` | paddlewheel | `navigation.speedThroughWaterRaw` if this plugin ran in Replace mode, else `speedThroughWater` |
| `hdg`, `variation` | magnetic heading | `navigation.headingMagnetic`, `magneticVariation` (not `headingTrue` if this plugin ran in Replace mode) |
| `heel` | roll, + = starboard down | `navigation.attitude.roll` |
| `sog`, `cog` | GPS | `navigation.speedOverGround`, `courseOverGroundTrue` |

Convert radians and m/s. Median faster data into each second; leave gaps as gaps. Never use a source that is a plugin (`$source` like `signalk-…`, `derived-data`) unless the user says so.

**From NMEA logs:**

- Every line needs its arrival time (Signal K Data Logging, Actisense, Yacht Devices, `candump`). If only `RMC`/`ZDA` carry time, stop and ask for a timestamped log.
- Decode NMEA 2000 with canboat; keep each message's source address. Drop lines that fail checksums; say how many.
- Take only: `MWV` reference `R` (0–360 → ±180; units N/K/M) or PGN 130306 reference Apparent; `VHW` or 128259; `HDG`/`HDM` or 127250 Magnetic; `XDR` roll or 127257; `RMC`/`VTG` or 129026; variation from `RMC`, `HDG` or 127258.
- Never `MWV` `T`, 130306 true references, `MWD`, `VWT` (true wind). Treat `HDT` and true 127250 as computed.
- List every talker or source address per input with its rate, and show the user. Where there are two, the user picks the sensor: a processor re-sends corrected values on the same sentence or PGN. Never merge two.

### 2. Check the inputs are raw: stop if not

Report every result. Stop and ask on any that fails or that the data cannot settle.

1. **Ask** where each column came from and what the instrument does to it: wind tables, wind damping, boat speed table or factor, compass deviation. Wanted: masthead wind with no tables or damping; boat speed with at most one factor; compass heading. A masthead alignment offset on the sensor is fine.
2. **Not this plugin's output**, or another plugin's: no `…Corrected` or true wind paths. In Replace mode it publishes `speedThroughWater`, `headingTrue` and true wind.
3. **Instrument wind tables:** if the log has the instrument's TWA or TWD, compare with this plugin's true wind with all tables off, on raw STW. Binned by |TWA| and TWS, the difference should be noise around a constant. A pattern means its tables were on, and the apparent wind may be corrected too.
4. **Damped wind:** over tacks and gybes, heading rate and AWA rate should line up within about 1 s. A lag means damping.
5. **Signs:** upwind, heel and AWA have opposite signs (starboard tack heels to port).
6. **Units and labels:** degrees not radians; knots not m/s; heading magnetic (on straight legs in little current, COG − heading ≈ variation + a few degrees).
7. **Masthead alignment:** median upwind |TWA| port vs starboard more than ~2° apart. The tables can't fix it: report it.
8. **Heel offset:** median heel upright should be ~0.
9. **Faults:** AWA sign disagreeing with the instrument's TWA; TWD far from heading + TWA; days with a fouled paddlewheel, motoring or moored. Leave them out and say so.
10. **One setup:** ask the date the rig, sails, masthead unit or calibration last changed; use data since then.

### 3. Fit, in pipeline order

Each on the output of the one before; thresholds from boatcal.

1. **Boat speed / heel table and K**, from the GPS: current per 20-minute window with varied headings; the paddlewheel's forward error through the lookup weights; K from upwind slip. Skip if there's no GPS or the current can't be separated.
2. **TWA table**, from manoeuvres: TWD should not step across a tack, gybe or rounding. New STW table on, wind tables off. **Keep the plugin's TWA limit (§5.4)** or the plugin refuses the table.
3. **TWS table**, from off-wind legs against the beats either side, band by band of |TWA|, on the new TWA. Rows under 80° stay 0.

**Layout:** the plugin's default axes (`lib/defaults.js`) unless the data is too thin; then coarser rather than mostly blank. **Thin cells stay blank (`null`)**: not 0, not interpolated.

### 4. Check before handing over

- `normalizeConfig` returns no errors.
- Replay the log with the new tables: TWD steps across tacks and gybes shrink, centred near 0; off-wind TWS matches the beats.
- Held out by day: score each day with tables fitted without it; report the spread per cell.
- Sane sizes: TWA a few degrees, largest in light air; TWS mostly negative off the wind; boat speed tenths of a knot. A 15° or 3 kn cell is a data problem: back to step 2.
- Support: tacks, gybes, roundings and legs per table and per cell. Under about 10 tacks and gybes, say so and keep the TWA table thin.

### 5. Hand over

- Each table in paste format (`format`), and/or a `"schema": 7` config carrying over the user's other settings.
- A short report: data used and left out, every step 2 result, before and after, held-out spread, blank cells.
- Tell the user: Shadow mode first; instrument wind tables out before Replace mode.

### Don't

- Fit from corrected data or this plugin's output.
- Fit absolute TWS or a masthead offset (tacks can't see them).
- Fill thin cells, or make a table finer than its data.
- Change `lib/defaults.js` (the author's boat).

---

## Changing this plugin

### Commands

- `npm test` runs everything. There are no dependencies and no build step.
- Commit, tag, push or publish only when asked.

### Rules

- **The specification is the master record of the maths.** Change it in the same commit as the code, and add a `CHANGELOG.md` entry.
- **boatcal runs this code.** It uses `lib/processor.js` (its exports and `_internals`) and `public/tables.js`: check boatcal's `boatcal/pipeline.js` before changing them.
- **`lib/processor.js` stays free of Signal K**, so it can be tested and replayed. Anything Signal K goes in `index.js`.
- **Units:** degrees and knots inside the pipeline, radians and m/s in Signal K. Keep the sign conventions in specification §1.
- **A change to the config layout** means bumping `CONFIG_SCHEMA`, adding an upgrade path and testing it. Never overwrite a file from a newer release.
- **No feedback loops.** The plugin never reads its own output, and reads another plugin's only if that source is chosen in Settings.
- **`plugin.schema` stays empty.** Everything is set in the webapp: saving the admin form could otherwise overwrite the tables.
- **Don't add `GET` or `POST /config` routes.** The server owns them on every plugin's router.

### Gotchas

- **The webapp has no tests.** Check its changes in a browser. Most boats reach Signal K over plain `http://`, where browsers offer no `navigator.clipboard`, and `localhost` hides that: test on a LAN address.
- **Live page step boxes are a fixed size on purpose**, so values don't shift the layout.
- **A blank table cell** takes the value to its left, or at the start of a row the first value to its right (`fillGaps`). Don't call it "nearest".
- **`lib/defaults.js` is one real boat's calibration.** Change it only from a boatcal fit, and update the note at the top saying where it came from.
- **Screenshots** in `docs/screenshots/` are listed in `package.json` and shown in the README. Regenerate them when the UI text or defaults change; the tooling is not in this repo.

### Release

1. Bump the version in `package.json` and add the `CHANGELOG.md` section (`## x.y.z — date`).
2. Update the "Written for" line in `SPECIFICATION.md`.
3. Merge to `main`.
4. Tag `vx.y.z` and push it: that makes the GitHub release from the changelog section and runs Signal K's plugin CI.
5. `npm publish`.

### Beta

Betas come from the `dev` branch and never reach the Signal K app store, which follows npm's `latest` tag.

1. `npm version prerelease --preid beta --no-git-tag-version` (0.3.0-beta.0, -beta.1, …).
2. `npm publish --tag beta`. `scripts/check-publish-tag.js` refuses a prerelease without a non-`latest` tag, and a release with one.
3. Don't push a `v…` git tag for a beta: it makes a GitHub release and runs Signal K's plugin CI.
4. Install on a boat with `npm install signalk-performance-processor@beta` in `~/.signalk`; `@latest` goes back.
5. To release, merge `dev` into `main` and follow Release with a plain version.
