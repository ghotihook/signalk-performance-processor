<img src="public/icon.svg" width="72" align="right" alt="">

# signalk-performance-processor

**True wind direction that holds steady when you tack.**

If your TWD swings 5–10° every time you tack or gybe, the wind hasn't shifted: your true wind calibration is off. It makes real shifts hard to call, puts laylines in the wrong place, and feeds bad numbers into your polars and targets.

This plugin does the calibration job of a B&G H5000-class instrument processor inside Signal K. It corrects boat speed and leeway, then applies H5000-style TWA and TWS correction tables, and publishes corrected true wind and current. You edit everything in a webapp and can watch each correction work live. Run it in **Shadow mode** first: it publishes alongside your existing instruments without changing anything they do.

> **Proof of concept (0.0.6).** Compare it against your instruments in Shadow mode before relying on it. See the [changelog](CHANGELOG.md).

## Why it exists

True wind is worked out from apparent wind, boat speed and heading, so it inherits every error in them. The masthead sensor reads a bent airflow upwind, the paddlewheel misreads when heeled, and the boat slides sideways. None of these is the same on every point of sail, and some flip from one tack to the other. That is why an uncalibrated TWD jumps through every tack.

Instrument processors fix this with calibration tables, but:

- **The tables are locked in the box.** You edit them through display menus, cannot see what each one is doing at any moment, and keep no history of what you changed or why.
- **Older and simpler systems have less to work with.** An H2000, for example, has a TWS correction that only applies downwind, and many systems have no tables at all.
- **Formula-based corrections don't fit every boat.** A single upwash formula cannot follow a boat whose correction is twice as big in light air as in a breeze at the same apparent wind angle. That was the case on the boat this was built for; a table can follow it.

This plugin moves the calibration into Signal K, where you can see it, change it, log it and fit it from your own race data:

- **The same shape as an H5000:** a boat speed table by heel and speed, leeway (K × heel ÷ boat speed²), and TWA/TWS tables by wind speed with upwind, reach and downwind rows. An existing calibration carries across, and the H5000 tuning rule ("TWD lifts on every tack: take half the error off TWA") works unchanged.
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
| Boat speed (STW) | Knots added to the paddlewheel from a **heel × speed table** (signed heel rows, STW columns), like the H5000's boat speed / heel table | On |
| Leeway | Leeway = K × heel ÷ STW², turning the boat's velocity to leeward. Capped at 15°, and faded in with speed: none below 1.5 kn, in full from 3 kn, so it does not snap on as the boat gets going | On, K = 7.9446 |
| True wind | Apparent wind minus the boat's velocity through the water | Always |
| TWA table | Degrees added to \|TWA\| by TWS, with upwind, reach and downwind rows blended by TWA (70° / 100° / 130°). In full from 30° off the wind to 10° short of dead downwind, fading to none at 0° and 180°, so TWA passes smoothly through head to wind and dead downwind | On |
| TWS table | Knots added to TWS by TWS, same rows and blending (H5000 units) | Off |
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

**Smooth through tacks and gybes.** A table correction applied in full right up to head to wind would hold TWA at 0° for as many degrees as the correction (12.6° at 10 kn), so TWD would follow the bow through every tack; at dead downwind a negative correction would make TWA jump as it crossed 180°. The correction therefore fades out over the last 30° to head to wind and the last 10° to dead downwind. Upwind the boat is inside the fade only while tacking; downwind, sailing deeper than 170° gets part of the correction (in the 2026 race logs, about 3% of racing time was inside 30° and 2% beyond 170°). To keep corrected TWA moving with uncorrected TWA, upwind values must be within ±30° and downwind values within ±10°, and the row angles must sit outside the fades (upwind ≥ 30°, downwind ≤ 170°).

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
- **Calibration**: every correction in pipeline order with an on/off switch. Select one to edit its values, then **Save**. Table headings (the breakpoints) are fixed; only the values are edited, and blank cells are allowed where a table says so. The boat speed table also has **Paste a table**, which reads the `signalk-stw-heel-correction` CSV format. **Reset to defaults** puts back this boat's values for that correction.
- **Built-in limits** are listed where they apply: under each correction on the Calibration page (fades, caps, held edge values) and on the Settings page (light air, stale inputs, rate limit, implausible input). The numbers come from the plugin itself, so they always match the code.
- **Settings**: Shadow or Replace, the fallback magnetic variation, and which source to read for each input. **Any** takes every source; for STW the blank choice is **Auto (sensors only)**.

All configuration lives in the webapp. It is saved to `config.json` in the plugin's data directory (under `~/.signalk/plugin-config-data/`), not in the admin **Plugin Config** form, which only points here; saving that form cannot overwrite the tables. Saving needs write access when Signal K security is on.

## Defaults for this boat

What a fresh install starts with. Every value can be changed in the webapp.

- **STW:** the owner's measured heel × STW table, 15 heel rows (−35° to +35°) by 17 speed columns (0.5 to 8.5 kn), in knots added. Blank cells (corners the boat never sails in) are filled from the nearest value in their row; below 0.5 kn the correction tapers to zero. A table in the same CSV format as `signalk-stw-heel-correction` can be pasted straight into the webapp.
- **Leeway:** K = 7.9446, one value for every sail.
- **TWA table (°)**, from the owner's calibration fit (blank = too little data):

  | TWS (kn) | 5 | 10 | 15 | 20 | 25 | 30 |
  |---|---|---|---|---|---|---|
  | Upwind | −7.6 | −12.6 | −5.8 | −5.7 | +0.2 | |
  | Reach | −2.4 | −4.4 | −5.4 | +1.4 | +3.9 | +1.0 |
  | Downwind | +1.2 | −3.5 | +1.0 | | | |

  A blank TWA cell uses the measured cells either side, holding the nearest one at the ends: upwind at 30 kn uses +0.2, downwind from 20 kn uses +1.0.
- **TWS table (kn):** off. Downwind −0.5, −1, −1.5, −2, −2.5, −3 (−10% of each column); upwind and reach blank, which in this table means no correction.
- **Fallback variation:** 12.8° E, used only when nothing on the boat sends true heading or magnetic variation. The Live page shows which applies.

## Configuration file

`config.json` in the plugin's data directory, written by the webapp:

```json
{
  "schema": 2,
  "mode": "shadow",
  "variation": 12.8,
  "sources": { "apparentWind": "", "stw": "", "heading": "", "attitude": "", "gps": "", "variation": "" },
  "corrections": {
    "stw": { "enabled": true, "heel": [-35, …, 35], "stw": [0.5, …, 8.5], "add": [[…], …] },
    "leeway": { "enabled": true, "k": 7.9446 },
    "twa": { "enabled": true, "tws": [5, …, 30], "upwind": […], "reach": […], "downwind": […], "angles": { … } },
    "tws": { "enabled": false, "tws": [5, …, 30], "upwind": […], "reach": […], "downwind": […] }
  }
}
```

`schema` is the version of the file's shape. A release that changes the shape bumps `CONFIG_SCHEMA` in `lib/processor.js` and adds a migration from the previous version, so older files are upgraded as they load and nothing is reset. A file without `schema` (saved by 0.0.1) is read as schema 1. Schema 1 files (0.0.1–0.0.3) are upgraded to 2: their two STW rows become the grid they describe, and their TWS percentages become knots. Blank table cells are stored as `null`. A file from a newer release is refused rather than guessed at, and is never overwritten by an older plugin.

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
