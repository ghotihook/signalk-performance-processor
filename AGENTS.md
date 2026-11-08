# Agent instructions

Signal K plugin and webapp that calibrates true wind. [README.md](README.md) says what it does and how it is used; [SPECIFICATION.md](SPECIFICATION.md) holds the maths.

An agent is here for one of two jobs:

- **[Calibrating a boat](#calibrating-a-boat-fit-the-tables-from-the-users-own-data):** a user has given you a log of their sailing and wants the tables for this plugin. Follow that section in full. You do not need to change any code.
- **[Changing this plugin](#changing-this-plugin):** working on the code in this repository.

---

## Calibrating a boat: fit the tables from the user's own data

The user hands you a log of their sailing (a Signal K history export, InfluxDB or QuestDB, Parquet, CSV, an Expedition or NMEA log) and wants back the boat speed / heel table, leeway K, the TWA table and the TWS table, for *this plugin's* arithmetic. Work through the steps in order. **Stop and ask the user** wherever a step says so: a confident table fitted from corrected or mislabelled data is worse than no table, because it looks right.

### 0. Read first

- [SPECIFICATION.md](SPECIFICATION.md) §1 (sign conventions), §4 (lookups and blank cells), §5 (the pipeline, in order: each table is fitted on the output of the one before), §5.4 (the TWA table's limit), §8.1 (what a table may hold), §9 (the fitting method).
- [boatcal](https://github.com/ghotihook/boatcal) is the working implementation of the method, and the reference: its `SPECIFICATION.md` is the master of the method and every threshold, and `boatcal/fit.py`, `events.py`, `decompose.py` and `settings.py` are the code. It reads its author's database (`data.py`); for the user's data, write an adapter that produces the same rows, or follow the same steps. **Follow the method; don't invent one.**
- **Use the plugin's own code for every lookup and for true wind**, never a copy: `lib/processor.js` (`process`, `normalizeConfig`, `_internals`) and `public/tables.js` (`lookup`, `fillGaps`, `parse`, `format`). boatcal's `boatcal/pipeline.js` shows how to call them from outside, and how to get each table's weights by probing its lookup one cell at a time. The fits are least squares in the cells with those weights as the design matrix.

### 1. Get the data into one table

1 Hz rows, in degrees and knots, these columns:

| Column | What | Where from |
|---|---|---|
| `ts` | UTC time | Group by the boat's *local* day: a day is the unit for held-out scoring |
| `awa`, `aws` | apparent wind, signed ±180°, + = from starboard | The masthead unit. Signal K `environment.wind.angleApparent`, `speedApparent` |
| `stw` | paddlewheel boat speed | Signal K `navigation.speedThroughWaterRaw` if this plugin has run in Replace mode (then `speedThroughWater` is its corrected output), else `speedThroughWater` |
| `hdg` | magnetic heading, plus `variation` | `navigation.headingMagnetic` and `navigation.magneticVariation`. Not `headingTrue` if this plugin has run in Replace mode: that is its own output |
| `heel` | roll, + = starboard side down | `navigation.attitude.roll` |
| `sog`, `cog` | GPS | `navigation.speedOverGround`, `courseOverGroundTrue`. Needed for the boat speed table and K |

Convert Signal K's radians and m/s. Take the median of faster data into each second; leave a gap as a gap rather than filling it. Each column must come from **one** sensor: where Signal K holds the same path from several sources, use the one the user names, and never a source that is a plugin (`$source` like `signalk-…` or `derived-data`).

### 2. Check that the inputs are raw: stop if they are not

This plugin applies every correction and all the damping itself. Anything an instrument or another plugin has already done to the inputs gets done twice, and the fit then calibrates the wrong thing. Do every check below, report each result to the user, and **stop and ask** on any that fails or that you cannot settle from the data.

1. **Ask the user where each column came from**, and what the instrument does to it: wind correction tables (B&G "TWA/TWS correction", Expedition calibration), wind damping, a boat speed / heel table, a speed factor, compass deviation. The answer you need: apparent wind straight from the masthead unit with no tables and no damping; boat speed with at most a single speed factor; heading straight from the compass. A masthead alignment offset set on the sensor is fine.
2. **Not this plugin's output, or another's.** No column may be a `…Corrected` path, a true wind path, or any value from `signalk-performance-processor` (feedback loop). In Replace mode it publishes `navigation.speedThroughWater`, `navigation.headingTrue` and the true wind paths: use the raw paths in step 1.
3. **Wind tables already applied.** If the log has the instrument's own TWA or TWD, compare them with this plugin's true wind with every table off (`process` with `stw`, `twa`, `tws` disabled, on raw STW). The difference binned by |TWA| and TWS should be noise around a constant. A pattern that follows TWA and TWS is the instrument's tables, and the apparent wind may be corrected too: find out what it did before going on.
4. **Damped wind.** Over tacks and gybes, cross-correlate the rate of change of heading with the rate of change of AWA. They should line up within about 1 s. If AWA lags heading, the wind is damped (or the heading is): true wind then swings with every yaw, and the TWA fit will soak that up as a calibration error. Ask the user to turn wind damping to 0 or log from ahead of it.
5. **Signs.** On starboard tack upwind (AWA > 0) a boat heels to port, so upwind heel and AWA have opposite signs: check the correlation. A wrong sign on AWA or heel fits a confidently wrong table.
6. **Units and labels.** Angles within ±180 or 0–360, not radians; speeds plausible in knots, not m/s. Heading magnetic, not true: on straight legs in little current, COG − heading should sit near the variation plus a few degrees of leeway, not near zero (or the reverse if the column is true).
7. **Masthead alignment.** Median upwind |TWA| on port and starboard tack, in similar wind: more than about 2° apart suggests a masthead offset. The tables use |TWA| and cannot correct it. Report it and have it fixed on the sensor; don't fit around it.
8. **Heel offset.** Median heel when upright (dead downwind in light air, or moored) should be near 0.
9. **Faults.** Rows where the AWA sign disagrees with the instrument's TWA (if logged), or TWD is far from heading + TWA; days with a fouled paddlewheel (STW against SOG way off for a whole day), motoring, or moored. Leave them out and say so.
10. **One setup.** Use only data since the rig, sails, masthead unit or instrument calibration last changed. **Ask the user for that date.**

### 3. Fit, in pipeline order, each on the output of the one before

Thresholds, smoothing and support rules are boatcal's (its `settings.py` and `SPECIFICATION.md`).

1. **Boat speed / heel table and leeway K, from the GPS.** Current fitted per 20-minute window where headings vary; the paddlewheel's forward error along the boat, fitted through the plugin's lookup weights. K from the sideways slip upwind. Skip it, and leave the user's table, if there is no GPS or the current cannot be separated (too little spread of heading).
2. **TWA table, from manoeuvres.** TWD should not step across a tack, gybe or mark rounding. Run the data through the plugin with the new boat speed table on and the TWA and TWS tables off; find the crossings; fit the cells against the TWD steps (Huber), neighbours tied. **The fit must keep the plugin's TWA limit** (specification §5.4: corrected TWA moves the same way as TWA, at most twice as fast), or the plugin refuses the table.
3. **TWS table, from off-wind legs.** TWS should not change when the boat bears away: each reaching or downwind leg against the upwind legs either side, band by band of |TWA|, on TWA corrected by the new TWA table. Rows under 80° are the upwind reference and stay 0.

**Layout.** Use the plugin's default axes (`lib/defaults.js`: heel −30…30 by 5° × 1…15 kn; TWA 30…180 by 10° × TWS 4…30 by 2 kn) unless the data is too thin for them, in which case use coarser axes rather than a table that is mostly blank. A table may have any axes (specification §8.1). **Leave a cell blank (`null`) where the data is thin.** Don't put 0 there and don't interpolate: a blank takes the value to its left in its row (specification §4.4), and the user should see which cells are measured.

### 4. Check before handing over

- **Valid:** `normalizeConfig` in `lib/processor.js` returns no errors for the config.
- **It works:** replay the whole log through the plugin with the new tables. TWD steps across tacks and gybes should shrink and centre near 0; off-wind TWS should match the beats either side. Report before and after.
- **Held out:** refit leaving out each day (or group of days) and score the day left out. A cell that only helps the day it was fitted on isn't real. Report the spread per cell, not only the fit.
- **Sane:** TWA corrections of a few degrees, largest in light air; TWS mostly negative off the wind; boat speed corrections of tenths of a knot. A 15° TWA cell or a 3 kn boat speed cell is a data problem until shown otherwise: go back to step 2.
- **Enough data:** say how many tacks, gybes, roundings and off-wind legs each table rests on, and the support per cell. With fewer than about 10 tacks and gybes in steady wind, say so and leave the TWA table thin rather than fit noise.

### 5. Hand over

- **The tables:** each in the paste format (`format` in `public/tables.js`) for **Calibration → Paste a table**, and/or a complete config with `"schema": 7` for `config.json` or `PUT /calibration`, carrying over the user's other settings (ask for their current `config.json`).
- **A short report:** the data used (dates, hours, manoeuvre counts), what was left out and why, every result of step 2, before and after, held-out spread, cells left blank.
- **Tell the user:** run in **Shadow mode** beside their instruments first, and take the instrument's own wind tables out before going to Replace mode (README "Getting started").

### Don't

- Fit from this plugin's own output, or from values another plugin or an instrument has already corrected.
- Fit absolute TWS or a masthead offset. Tacks and gybes cannot see them (README "Limitations"); they belong in the instrument.
- Fill thin cells with guesses, or make a table finer than its data.
- Change `lib/defaults.js`: that is the author's boat.

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
