# TODO

## Correction tables from Signal K history

Fit the TWA, TWS and boat speed tables from the server's own logged data, through the Signal K History API, so a boat can calibrate without exporting logs and running boatcal's `plugincal`.

- Read raw apparent wind, boat speed, heading, heel and GPS for a chosen date range ("since my setup last changed") from the History API, where a history provider (such as signalk-to-influxdb) is installed. Say so plainly when none is.
- Fit the tables as `plugincal` does (SPECIFICATION.md), not a new method: the same manoeuvre detection, legs and limits, so the two give the same tables from the same data.
- Show the fit in the webapp next to the current tables (counts of tacks, gybes and legs per cell, and the change), and apply it only on **Save**.
- Keep `lib/processor.js` free of Signal K: the History API calls go in `index.js`, the fit in its own module that can be tested on recorded data.
- No feedback loop: fit only from raw inputs, never from this plugin's output or another plugin's.

Open questions:

- Port the fit from `plugincal` (Python) to JavaScript, or share it some other way? Two copies can drift.
- Which history providers return data at the rate and resolution the fit needs?
- How long a fit takes on a Raspberry Pi, and whether it must run in the background.

## Guide for an AI agent: fit the tables from a user's own data

Write this up as `CALIBRATING.md` (or a section of the README) once it has been tried on a real data set. Until then it is the brief.

The aim: a user hands an agent a log of their sailing (CSV, Parquet, an InfluxDB or Signal K history export, an Expedition or NMEA log) and gets back the three tables to paste into the **Calibration** page, or a `config.json` to `PUT /calibration`. The tables must be right for *this plugin's* arithmetic, not for an instrument's.

### Read first

- `SPECIFICATION.md` §5 (the pipeline, in order), §4 (lookups, blanks), §5.4 and §5.5 (the TWA and TWS constraints a table must meet), and §9 (**the fitting method: follow it, don't invent one**).
- boatcal `plugincal/` is the working implementation of §9: `fit.py`, `events.py`, `decompose.py`, and `settings.py` for every threshold. It reads boatcal's own Postgres table (`data.py`), so a user's data needs an adapter in front of it, or a port of the fit.
- `plugincal/pipeline.js` shows how to run rows through `lib/processor.js` from outside. **Use the plugin's own code for every lookup**, never a re-implementation: the fit is least squares in the cells with the plugin's lookup weights (`twaWeights`, `stwWeights`) as the design matrix.

### 1 Get the data into one table

1 Hz rows (resample if faster; 5 s medians for the STW fit, §9.1), in degrees and knots, with these columns:

| Column | What | Notes |
|---|---|---|
| `ts` | UTC time | Group by *local* day: a day is the unit for hold-outs |
| `awa`, `aws` | apparent wind | **Raw** masthead values: no instrument wind tables, no damping. Wind an instrument already corrected gets corrected twice. AWA signed ±180, + = starboard |
| `stw` | paddlewheel boat speed | Raw, but with the instrument's single speed factor if one is set (plugincal's `man_bsp_adj`) |
| `hdg` | magnetic heading | Plus `variation`; or true heading with variation 0 |
| `heel` | roll | + = starboard side down (spec §1). Check the sign: on starboard tack upwind (wind from starboard) the boat heels to port |
| `sog`, `cog` | GPS | COG true. Needed for the STW table and leeway K |

Signal K paths are in README "Requirements". Convert radians and m/s. Check and fix before fitting:

- **Sign conventions** (spec §1). A flipped AWA or heel sign fits a confidently wrong table.
- **Is the wind raw?** If the log has the instrument's TWA/TWD as well, compare them with the plugin's untabled true wind (`want: "pre"`). A difference that follows TWA and TWS (a pattern, not noise) is the instrument's own tables, and the awa/aws were probably corrected too: find out what it did before going on.
- **Faults:** rows where the AWA sign disagrees with the instrument's TWA, or TWD is far from heading + TWA (plugincal `data.clean`). Also days with a fouled paddlewheel, motoring, moored.
- **One setup:** only data since the rig, sails or instrument calibration last changed. Ask the user for that date.

### 2 Fit in pipeline order, each on the output of the one before

1. **STW table and leeway K** from the GPS (§9.1): fit current in 20-minute windows, find the paddlewheel's forward error per heel and speed cell, then K from upwind sideslip. Skip it, and keep the defaults or a zero table, if there's no GPS or the current is unknowable (little heading spread).
2. **TWA table** from manoeuvres (§9.2): TWD should not step across a tack, gybe or rounding. Run the data through the plugin with the TWA and TWS tables **off** and the new STW table **on**, find the crossings, then fit the cells against the TWD steps with the Huber loss and the smoothing of §9.2.
3. **TWS table** from off-wind legs against the beats either side (§9.3), on TWA corrected by the new TWA table.

Leave a cell **blank** (`null`) where the data is thin (the support thresholds in §9). Don't put 0 there and don't interpolate: a blank takes the value to its left (`fillGaps`, §4.4), and that's what the user should see.

### 3 Check before handing over

- **Valid:** `normalizeConfig` in `lib/processor.js` returns no errors (TWA upwind cells inside ±30°, downwind inside ±10°, TWS up angle < 90 < down angle).
- **It works:** replay the whole log through the plugin with the new tables. TWD steps across tacks and gybes should shrink, centred near 0, and the mean TWS off the wind should match the beats either side. Report before and after.
- **Held out:** refit leaving out each day (or group of days) and score the left-out day. A cell that only helps the day it was fitted on isn't real. Report the spread per cell, not only the fit.
- **Sanity:** the numbers should look like the defaults' shape (`lib/defaults.js`, one real boat): TWA corrections of a few degrees, largest in light air; TWS mostly negative off the wind. A 15° cell or a 3 kn STW cell is a data problem until shown otherwise.
- **Enough data:** say how many tacks, gybes, roundings and off-wind legs each cell rests on. The README asks for 10 or more tacks and gybes in steady wind. With fewer, say so and leave the TWA table thin, rather than fit noise.

### 4 Hand over

- Each table in the paste format (`public/tables.js` `format`; header at the top of that file), ready for **Paste a table**, or a complete config with `"schema": 6` (§8.1) for `config.json` or `PUT /calibration`, carrying over the user's other settings.
- A short report: the data used (dates, hours, manoeuvre counts), what was excluded and why, before and after, held-out spread, and any cell left blank.
- Tell the user to run **Shadow mode** beside their instruments first, and to take the instrument's own wind tables out before going to Replace (README "Getting started").

### Don't

- Fit from the plugin's own output or a value another plugin already corrected (no feedback loops).
- Change `lib/defaults.js` with a user's fit. It's the author's boat.
- Change the table axes to suit the data. The layout is fixed (§8.1).
- Fit absolute TWS or a masthead offset. Tacks and gybes can't see them (README "Limitations"); they belong in the instrument.
