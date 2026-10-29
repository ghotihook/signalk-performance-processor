<img src="public/icon.svg" width="72" align="right" alt="">

# signalk-performance-processor

**True wind direction that holds steady when you tack.**

If your TWD swings 5–10° every time you tack or gybe, the wind hasn't shifted: your true wind calibration is off. It makes real shifts hard to call, puts laylines in the wrong place, and feeds bad numbers into your polars and targets.

This plugin does the calibration job of a B&G H5000-class instrument processor inside Signal K. It corrects boat speed and leeway, then applies H5000-style TWA and TWS correction tables, and publishes corrected true wind and current. You edit everything in a webapp and can watch each correction work live. Run it in **Shadow mode** first: it publishes alongside your existing instruments without changing anything they do.

> **Proof of concept (0.1.0).** Compare it against your instruments in Shadow mode before relying on it. See the [changelog](CHANGELOG.md).

## Why it exists

True wind is worked out from apparent wind, boat speed and heading, so it inherits every error in them. The masthead sensor reads a bent airflow upwind, the paddlewheel misreads when heeled, and the boat slides sideways. None of these is the same on every point of sail, and some flip from one tack to the other. That is why an uncalibrated TWD jumps through every tack.

Instrument processors fix this with calibration tables, but:

- **The tables are locked in the box.** You edit them through display menus, cannot see what each one is doing at any moment, and keep no history of what you changed or why.
- **Older and simpler systems have less to work with.** An H2000, for example, has a TWS correction that only applies downwind, and many systems have no tables at all.
- **Formula-based corrections don't fit every boat.** A single upwash formula cannot follow a boat whose correction is twice as big in light air as in a breeze at the same apparent wind angle. That was the case on the boat this was built for; a table can follow it.

This plugin moves the calibration into Signal K, where you can see it, change it, log it and fit it from your own race data:

- **The H5000's tables, in the H5000's layout:** a boat speed / heel table (heel 0, 10, 20° × boat speed 0–30 kn), leeway (K × heel ÷ boat speed²), a TWA table with rows at TWA 40°, 90° and 165° by TWS 0–30 kn, and a TWS table with its down angle. An H5000 calibration carries across cell for cell, and the H5000 tuning rule ("TWD lifts on every tack: take half the error off TWA") works unchanged. Every table can be pasted in as text, which is what boatcal's `plugincal` fitting tool prints.
- **Every correction has a switch and a live readout,** so you can see what each one does to the numbers right now.
- **The calibration is a versioned JSON file,** easy to back up, compare and fit from logged races offline.
- **It is safe to try.** Shadow mode publishes `…Corrected` paths beside your instruments. Replace mode takes over the standard paths only when you choose it.

### On the boat it was built for

From the offline model the defaults were fitted with: trained on 2025 race logs, tested on Jan–Mar 2026 races it had not seen, and measured by how far true wind direction jumps through each manoeuvre (median). The shipped defaults differ (the owner's leeway K, full STW table and TWA table from a later calibration fit), so treat these as an indication, not a guarantee.

| | Uncorrected | Instrument (H2000) | This plugin |
|---|---|---|---|
| Tacks (41) | 6.2° | 2.5° | 2.2° |
| Gybes (5) | 2.4° | 4.7° | 1.1° |
| Roundings (38) | 9.3° | 9.7° | 7.3° |
| Current step through manoeuvres | 0.65 kn | 0.65 kn | 0.37 kn |

These figures are one boat's, and the defaults are that boat's. On a different boat, start from the defaults in Shadow mode and refit. After the boat's own rig and log changes in late 2026, the defaults needed refitting too.

## Who it's for

- **Racing sailors running Signal K** who want TWD they can call shifts on, and polars built on corrected wind.
- **Boats with an older or limited instrument processor,** or none, that still have apparent wind, a paddlewheel, heading and heel on the network.
- **Anyone who wants to see and log** what their wind calibration is doing, rather than trust a box.

You need apparent wind, boat speed through the water and heading in Signal K. Heel (`navigation.attitude`) enables the heel and leeway corrections; SOG and COG enable current.

## What it does

The corrections run in this order, each on the output of the one before:

| Step | What | Default |
|---|---|---|
| Boat speed (STW) | Knots added to the paddlewheel from the H5000 **boat speed / heel table**: heel 0, 10, 20° (either side) × boat speed 0, 5 … 30 kn, bilinear. Fades out below 1 kn, so a stopped boat is not given speed | On |
| Leeway | Leeway = K × heel ÷ STW², turning the boat's velocity to leeward. Capped at 15°, and faded in with speed: none below 1.5 kn, in full from 3 kn, so it does not snap on as the boat gets going | On, K = 7.9446 |
| True wind | Apparent wind minus the boat's velocity through the water | Always |
| TWA table | Degrees added to \|TWA\| by TWS, the H5000 TWA correction table: rows at TWA 40°, 90° and 165° by TWS 0, 5 … 30 kn, linear between rows and columns. In full from 30° off the wind to 10° short of dead downwind, fading to none at 0° and 180°, so TWA passes smoothly through head to wind and dead downwind | On |
| TWS table | Knots added to TWS by TWS, the H5000 TWS correction with its down angle: none below 90° TWA, in full from the down angle (165° by default), linear between | Off |
| TWD, current | TWD from heading and corrected TWA; current from SOG/COG minus water velocity | Always, when heading and GPS are available |

### Inputs

| Input | Signal K path |
|---|---|
| Apparent wind | `environment.wind.angleApparent`, `environment.wind.speedApparent` |
| Speed through water | `navigation.speedThroughWater` |
| Heading | `navigation.headingTrue`; otherwise `navigation.headingMagnetic` + `navigation.magneticVariation` (normally from the GPS); otherwise magnetic heading + the fallback variation in Settings |
| Heel | `navigation.attitude` (roll) |
| SOG and COG | `navigation.speedOverGround`, `navigation.courseOverGroundTrue` |

True wind is worked out on every apparent wind update. Inputs older than 3 seconds are not used. Without STW there is no true wind. Without heel, the heel correction and leeway are skipped. Without heading, there is no TWD or current.

**Light air.** Below 1.5 kn of TWS, wind direction is noise, so TWA and TWD are not published (TWS still is) and the status says so. They come back once TWS reaches 2 kn; the gap stops them flickering on and off.

**Smooth through tacks and gybes.** A table correction applied in full right up to head to wind would hold TWA at 0° for as many degrees as the correction (12.6° at 10 kn), so TWD would follow the bow through every tack; at dead downwind a negative correction would make TWA jump as it crossed 180°. The correction therefore fades out over the last 30° to head to wind and the last 10° to dead downwind. Upwind the boat is inside the fade only while tacking; downwind, sailing deeper than 170° gets part of the correction (in the 2026 race logs, about 3% of racing time was inside 30° and 2% beyond 170°). To keep corrected TWA moving with uncorrected TWA, the 40° row's values must be within ±30° and the 165° row's within ±10°; both rows sit outside the fades, so the fades only ever scale a single row.

Feed it **measured** apparent wind and **raw** paddlewheel speed. Unless you choose an STW source in Settings, STW is read **from sensors only**: updates that came in through a data connection (NMEA 0183, NMEA 2000), which carry a `source` object, and not STW published by another plugin, which does not. See [Running alongside other STW plugins](#running-alongside-other-stw-plugins).

### Running alongside other STW plugins

This plugin publishes STW too, so it must never correct another plugin's STW and hand the result back. Two correctors on `navigation.speedThroughWater` that each take any source but their own correct each other's output without end: STW, and true wind with it, run away. Signal K's own pattern for correction plugins (subscribe with `sourcePolicy: 'all'`, skip your own `$source`, publish on the same path) does not cover this case, because neither plugin ever sees its own source come back.

- **By default it reads STW from sensors only**, so another corrector's output is ignored and no loop can form.
- **Choosing a source in Settings overrides this**, including choosing another plugin, for a deliberate chain such as `signalk-stw-heel-correction` → this plugin with the STW correction here turned off. That plugin must then read only the paddlewheel (its own default from 0.3.0).
- **Circuit breaker:** whatever the sources, the plugin never publishes a path more often than 20 Hz: an update less than 50 ms after the last one on that path is not published. A loop's next hop arrives within the same millisecond, so the chain ends at the first repeat instead of running away, and the server stays responsive. A backlog flushed after a dropout is thinned, not stopped. Nothing latches. While updates are being dropped the status and the Live page end with `Rate limited: N updates over 20 Hz not published in the last 10 s, driven by "…"`, naming the source. If it stays up, look for a loop with another STW plugin; a loop that is cut still leaves STW corrected twice.

Only one plugin should correct STW. Otherwise the correction is applied twice even without a loop. In Shadow mode, note that `signalk-stw-heel-correction` also uses `navigation.speedThroughWaterCorrected` for its separate-path output, so the two would overwrite each other there.

### Outputs

| Output | Replace mode | Shadow mode |
|---|---|---|
| True wind angle | `environment.wind.angleTrueWater` | `environment.wind.angleTrueWaterCorrected` |
| True wind speed | `environment.wind.speedTrue` | `environment.wind.speedTrueCorrected` |
| True wind direction | `environment.wind.directionTrue` | `environment.wind.directionTrueCorrected` |
| Speed through water (when on) | `navigation.speedThroughWater` | `navigation.speedThroughWaterCorrected` |
| Leeway (when on) | `navigation.leewayAngle` | `navigation.leewayAngleCorrected` |
| Current | `environment.current` (`drift`, `setTrue`) | `environment.currentCorrected` |

Everything is published under this plugin's own `$source`. Corrected STW goes out each time the paddlewheel reports, while the STW correction is on; the rest goes out with each apparent wind update (TWA and TWD not in light air, see above). No path goes out more often than 20 Hz (see **Circuit breaker** under [Running alongside other STW plugins](#running-alongside-other-stw-plugins)). Shadow paths carry `meta` with units, since they are not in the Signal K schema.

## Modes

- **Shadow** (default) publishes to separate `…Corrected` paths. Your instruments and displays carry on unchanged, and you can log both side by side.
- **Replace** publishes on the standard paths. Then:
  1. In **Server → Source Priorities**, rank `signalk-performance-processor` above the instrument for each output path.
  2. Zero the instrument's own TWA/TWS correction tables and leeway, so nothing is corrected twice. Keep the masthead unit alignment and the boat speed calibration factor in the instrument.

## The webapp

Open **Webapps → Performance Processor**.

- **Live**: the outputs next to their uncorrected values; the pipeline, with each step's result tagged **Published** (sent to Signal K) or **Working** (only feeds the next step); a **Published to Signal K** table listing every value sent and its path; and which source and how fresh each input is.
- **Calibration**: every correction in pipeline order with an on/off switch. Select one to edit its values, then **Save**. Every table has the H5000's layout: its headings (the breakpoints) are fixed and only the values are edited, with blank cells allowed where a table says so. Every table also has **Paste a table**, which reads the text the `plugincal` tool prints (and the same text from a spreadsheet), and **Copy this table**, which writes it. The boat speed table also accepts the `signalk-stw-heel-correction` CSV, and resamples it onto the H5000 layout. **Reset to defaults** puts back this boat's values for that correction.
- **Built-in limits** are listed where they apply: under each correction on the Calibration page (fades, caps, held edge values) and on the Settings page (light air, stale inputs, rate limit, implausible input). The numbers come from the plugin itself, so they always match the code.
- **Settings**: Shadow or Replace, the fallback magnetic variation, and which source to read for each input. **Any** takes every source; for STW the blank choice is **Auto (sensors only)**.

All configuration lives in the webapp. It is saved to `config.json` in the plugin's data directory (under `~/.signalk/plugin-config-data/`), not in the admin **Plugin Config** form, which only points here; saving that form cannot overwrite the tables. Saving needs write access when Signal K security is on.

## Defaults for this boat

What a fresh install starts with. Every value can be changed in the webapp.

- **STW (kn added):** the owner's measured heel × STW table, resampled onto the H5000 layout (port and starboard averaged):

  | Heel \ STW (kn) | 0 | 5 | 10 | 15 | 20 | 25 | 30 |
  |---|---|---|---|---|---|---|---|
  | 0° | 0 | +0.05 | 0 | 0 | 0 | 0 | 0 |
  | 10° | 0 | +0.01 | −0.03 | −0.03 | −0.03 | −0.03 | −0.03 |
  | 20° | 0 | −0.08 | −0.13 | −0.13 | −0.13 | −0.13 | −0.13 |

  Blank cells are filled from the nearest value in their row.
- **Leeway:** K = 7.9446, one value for every sail.
- **TWA table (°)**, from the owner's calibration fit (blank = too little data). That fit was made for rows at 70°, 100° and 130°; refit it for the H5000 rows with `plugincal`:

  | TWA \ TWS (kn) | 0 | 5 | 10 | 15 | 20 | 25 | 30 |
  |---|---|---|---|---|---|---|---|
  | 40° | 0 | −7.6 | −12.6 | −5.8 | −5.7 | +0.2 | |
  | 90° | 0 | −2.4 | −4.4 | −5.4 | +1.4 | +3.9 | +1.0 |
  | 165° | 0 | +1.2 | −3.5 | +1.0 | | | |

  A blank TWA cell uses the measured cells either side, holding the nearest one at the ends. The 0 kn column fades the correction out in no wind, as on the H5000.
- **TWS table (kn):** off. Correction 0, −0.5, −1, −1.5, −2, −2.5, −3 (−10% of each column), down angle 165° throughout.
- **Fallback variation:** 12.8° E, used only when nothing on the boat sends true heading or magnetic variation. The Live page shows which applies.

## Configuration file

`config.json` in the plugin's data directory, written by the webapp:

```json
{
  "schema": 3,
  "mode": "shadow",
  "variation": 12.8,
  "sources": { "apparentWind": "", "stw": "", "heading": "", "attitude": "", "gps": "", "variation": "" },
  "corrections": {
    "stw": { "enabled": true, "heel": [0, 10, 20], "stw": [0, 5, …, 30], "add": [[…], […], […]] },
    "leeway": { "enabled": true, "k": 7.9446 },
    "twa": { "enabled": true, "tws": [0, 5, …, 30], "upwind": […], "reach": […], "downwind": […] },
    "tws": { "enabled": false, "tws": [0, 5, …, 30], "correction": […], "downAngle": […] }
  }
}
```

`schema` is the version of the file's shape. A release that changes the shape bumps `CONFIG_SCHEMA` in `lib/processor.js` and adds a migration from the previous version, so older files are upgraded as they load and nothing is reset. A file without `schema` (saved by 0.0.1) is read as schema 1. Schema 1 files (0.0.1–0.0.3) are upgraded to 2: their two STW rows become the grid they describe, and their TWS percentages become knots. Schema 2 files (0.0.4–0.0.6) are upgraded to 3, the H5000 layout: the signed heel × STW grid is resampled onto heel 0/10/20 × 0–30 kn (port and starboard averaged); the TWA rows keep their values with a 0 kn column added, but are now anchored at TWA 40°, 90° and 165°, so a TWA table fitted for the old row angles should be refitted; the TWS table keeps its downwind row as the correction, with a 165° down angle. The axes are fixed: a file with any other table layout is refused with the reason. Blank table cells are stored as `null`. A file from a newer release is refused rather than guessed at, and is never overwritten by an older plugin.

## Adding a correction

Corrections live in `lib/processor.js` as entries in `CORRECTIONS`, each with a stage (`input` before true wind, `trueWind` after) and an `apply` function. Their defaults go in `lib/defaults.js`. The pipeline, the Live view and the enable switch pick a new entry up from there; the Calibration page needs an editor for its values in `public/app.js`.

## API

Under `/plugins/signalk-performance-processor`:

- `GET /calibration` returns the configuration in use, the defaults, and `behaviour`: the built-in limits (leeway cap and fade, TWA fades, light-air thresholds, stale age, rate limit).
- `PUT /calibration` validates, saves and restarts with a new configuration. It returns 400 with the reasons if the configuration is invalid.
- `GET /live` returns the latest result, each step, input ages and the sources seen.

## Development

```bash
npm test          # node --test
```

To run it from a working copy on a Signal K server:

```bash
cd ~/.signalk && npm install /path/to/signalk-performance-processor
sudo systemctl restart signalk
```

## Licence

MIT
