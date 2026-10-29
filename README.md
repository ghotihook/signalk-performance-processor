<img src="public/icon.svg" width="72" align="right" alt="">

# signalk-performance-processor

**Steady true wind direction through tacks and gybes: true wind calibrated in Signal K, the way a B&G H5000 does it.**

**The problem.** If your TWD swings 5–10° every time you tack or gybe, the wind hasn't shifted: your true wind is miscalibrated. True wind is worked out from apparent wind, boat speed and heading, so it inherits their errors. The masthead reads a bent airflow upwind, the paddlewheel misreads when heeled, and neither error is the same on both tacks. You can't call real shifts, laylines land in the wrong place, and polars and targets get bad numbers.

**What it does.** It works out true wind again in Signal K from the raw apparent wind, boat speed and heading, and corrects it as an H5000 does: a boat speed / heel table, then TWA and TWS correction tables, then damping. It publishes corrected TWA, TWS and TWD, with boat speed, leeway, current and ground wind.

**How it is calibrated.** From your own sailing. TWD should not change when the boat tacks or gybes, so every manoeuvre in your logs measures how far TWA is out; boatcal's [`plugincal`](https://github.com/ghotihook/boatcal/tree/main/plugincal) fits the tables from them, and the GPS fits the boat speed table. Paste the result into the webapp, watch each step work live, and run it in **Shadow mode** beside your instruments until you trust it.

![The Live page: one row per value sent to Signal K, each step with its value now](docs/screenshots/live.png)

## Why in Signal K

Instrument processors correct true wind with tables too, but the tables are locked in the box: edited through display menus, invisible while sailing, with no history. Older systems have less (an H2000's TWS correction is downwind only), and a single upwash formula cannot follow a boat whose correction is twice as big in light air as in a breeze. Here the H5000's tables are in Signal K, where you can see them, log them and fit them from race data:

- **An H5000 calibration carries across cell for cell**, and the H5000 rule ("TWD lifts on every tack: take half the error off TWA") works unchanged.
- **Every correction has a switch and a live readout.**
- **The calibration is a JSON file**, easy to back up, compare and fit offline.
- **It is safe to try:** Shadow mode publishes `…Corrected` paths and changes nothing else.

What changed in each release is in the [changelog](CHANGELOG.md).

## On the boat it was built for

The defaults were fitted by `plugincal` on every labelled race leg from January 2025 to March 2026 (`python -m plugincal --since 2025-01-01 --until 2026-03-31 --labelled`). Each day held out in turn (scored with tables fitted without it), the TWD step across each manoeuvre, median:

| | Uncorrected | H2000 (its own tables) | **This plugin, held out** |
|---|---|---|---|
| Tacks (158) | 17.5° | 8.2° | **6.8°** |
| Gybes (28) | 7.8° | 9.6° | **4.4°** |
| Correction still needed, tacks / gybes | −9.0° / −4.2° | −2.2° / −4.8° | **−0.4° / +0.2°** |

What it publishes, tables and damping together, replayed second by second through every tack and gybe from January 2025 to September 2026, against the TWD the H2000 displayed:

| | Uncorrected | H2000 | **This plugin** |
|---|---|---|---|
| TWD step, tacks (197) / gybes (70), median | 17.9° / 7.8° | 8.4° / 8.0° | **6.2° / 4.7°** |
| … on the 65 manoeuvres outside race legs, never fitted on | 16.0° / 8.6° | 7.4° / 8.0° | **6.9° / 5.5°** |
| Largest TWD swing during the turn, tacks / gybes | 27.5° / 16.3° | 13.7° / **10.6°** | **11.4°** / 13.5° |
| One-second TWD jumps over 5° on straight legs, per hour | 439 | **31** | 40 |

The boat speed / heel table looks coarse, three heel rows shared by both sides, but held out by day it is as good as a fine one: 0.380 kn RMS against the GPS, against 0.375 kn for a 15 × 17 table with each side separate (0.421 kn uncorrected). The one thing a shared row cannot follow is a difference between sides: on this boat the paddlewheel reads about 0.1 kn low heeled 15–25° to port, and the table leaves that in.

These are one boat's figures, and the defaults are that boat as it was: after its September 2026 rig tune it needs much less correction, and these defaults over-correct it. A table belongs to one setup of one boat: fit your own.

## Calibrating your boat

> **Apparent wind must be raw: AWA and AWS as the masthead measures them, uncorrected and undamped.** The plugin applies the calibration and the damping itself. Wind that an instrument has already corrected gets corrected twice, and wind it has already damped lags heading and boat speed, so TWD swings with every yaw. In the instrument, take the wind tables out and set wind damping to 0, or read apparent wind from a source ahead of it. Masthead alignment (an offset fixed on the sensor) is the exception: keep it in the instrument.

1. **Install and leave it in Shadow mode.** It needs apparent wind, boat speed through water and heading in Signal K; heel (`navigation.attitude`) adds the heel corrections and leeway, SOG and COG add current. Feed it **raw** apparent wind (above) and the **raw** paddlewheel.
2. **Get boat speed right in the instrument first**, then log some sailing: a session with 10 or more tacks and gybes in steady wind, some reaching and a few roundings, covers the wind speeds sailed.
3. **Fit** with boatcal: `python -m plugincal --since <the day your setup last changed>`. Paste each printed table into the Calibration page (or load the config it writes), and **Save**.
4. **Compare** the `…Corrected` paths with your instruments on the next races. Refit after a rig tune, new sails or a boat speed calibration change.
5. **Replace mode**, once you trust it: rank this plugin first for each output path in **Server → Source Priorities**, and zero the instrument's own TWA / TWS tables so nothing is corrected twice. Keep the masthead alignment and boat speed calibration in the instrument.

An H5000 calibration can be typed or pasted in directly: the tables have the same rows, columns and meaning.

## What it does

One chain per value sent to Signal K. Inputs in *italics* are made by another chain.

| Chain | Uses | Steps | Sent (damping as in Settings) |
|---|---|---|---|
| Boat speed | paddlewheel, heel | STW table → damping | STW |
| Leeway | heel, *STW* | K × heel ÷ STW² | leeway |
| True wind | apparent wind, *STW* | apparent wind − STW along the heading → TWA table → TWS table → damping | TWS |
| Direction | *TWA*, heading | heading + TWA → damping | TWD, and TWA as the damped TWD − heading |
| Current | SOG, COG, heading, *STW*, *leeway* | ground velocity − water velocity → damping | current |
| Ground wind | *TWD*, *TWS*, *current* | true wind + current → damping | ground wind speed, direction and angle |

The Live page shows the same chains with each value now. The steps:

| Step | What | Default |
|---|---|---|
| Boat speed (STW) | Knots added to the paddlewheel from the **boat speed / heel table**: heel 0, 10, 20° (either side) × boat speed 0, 5 … 30 kn, bilinear. Fades out below 1 kn, so a stopped boat is not given speed | On |
| Leeway | K × heel ÷ STW², capped at 15°, faded in from 1.5 to 3 kn. Published and used for current; **not** used in true wind, as on the H5000 by default (the TWA table takes up its effect) | On, K = 8.568 |
| True wind | Apparent wind minus the boat's velocity through the water, along the heading | Always |
| TWA table | Degrees added to \|TWA\| by TWS: rows at TWA 40°, 90° and 165° × TWS 0, 5 … 30 kn, linear between rows and columns. In full from 30° off the wind to 10° short of dead downwind, fading to none at 0° and 180° | On |
| TWS table | Knots added to TWS by TWS, with the H5000's down angle: none below 90° TWA, in full from the down angle (165° by default) | Off |
| TWD, current | TWD = heading + TWA; current = ground velocity − water velocity (STW along the heading turned by leeway) | With heading and GPS |
| Ground wind | The wind over the ground: true wind plus current, so the tables apply to it too | With heading and GPS |

**Damping**, in seconds as on the H5000 (0 = none), set in Settings:

| Setting | Default | |
|---|---|---|
| Heading | 2 s | Heading before true wind, to line up with an apparent wind the instrument has already damped: a yaw then cancels instead of swinging TWD |
| Heel | 2 s | Heel before the STW table and leeway: takes most of the roll out |
| True wind | 3 s | TWD, TWS and ground wind. TWA is the damped TWD less the heading, so it still answers the helm at once; the ground wind angle likewise |
| STW | 1 s | The published STW |
| Current | 10 s | Current, as a vector |

Undamped, TWD jumps by more than 5° about 480 times an hour on a straight leg; these defaults bring that to 40. More true wind damping smooths further but shows a real shift later.

**Current is a trend, not a live number.** It is ground velocity less water velocity, two vectors of about boat speed, so 1% of boat speed or 1° of heading is 0.1 kn of current. On this boat current changes by 0.36 kn (median) across a tack, the same water a minute apart, so most of what is shown on a single heading is instrument error: largely the paddlewheel's speed scale, which moves by a few percent from one day to the next. It does not average out within a leg, so more damping barely helps (10 s to 120 s takes the median shown from 0.38 to 0.35 kn). Read current averaged over both tacks of a beat.

### Built-in behaviour

The webapp lists these with the plugin's own numbers.

- **Through tacks and gybes.** A TWA correction applied in full up to head to wind would hold TWA at 0° for as many degrees as the correction, so TWD would follow the bow through every tack. So the correction fades out over the last 30° to head to wind and the last 10° to dead downwind, and the 40° row must be within ±30° and the 165° row within ±10°: corrected TWA then always moves with uncorrected TWA.
- **Light air.** Below 1.5 kn of TWS, wind direction is noise: TWA, TWD and the ground wind direction and angle are not published (TWS and ground wind speed still are) until TWS is back to 2 kn.
- **Stale or implausible input.** Inputs older than 3 s are not used. Without STW there is no true wind; without heel, no heel correction or leeway; without heading, no TWD, current or ground wind; without SOG and COG, no current or ground wind. Apparent wind over 120 kn, STW over 60 kn or heel beyond ±90° is ignored, and the status says why.
- **Heading.** `navigation.headingTrue` if present; otherwise magnetic heading plus `navigation.magneticVariation` (normally from the GPS); otherwise the fallback variation in Settings.

### Other STW plugins

This plugin publishes STW too, so two STW correctors that each read the other would correct each other's output without end.

- **STW is read from sensors only** (updates from an NMEA connection, which carry a `source` object) unless you choose a source in Settings. Another plugin's STW is ignored, so no loop can form.
- **`signalk-stw-heel-correction` is not needed with this plugin**: the boat speed / heel table does its job as well (see above). Only one plugin should correct STW. To chain another corrector in front deliberately, choose it as the STW source in Settings and switch this plugin's STW table off.
- **Circuit breaker:** no path is published more often than 20 Hz. A loop's next hop arrives within the same millisecond, so it ends at the first repeat; the status names the source driving it.

## Outputs

| Output | Shadow mode (default) | Replace mode |
|---|---|---|
| True wind angle | `environment.wind.angleTrueWaterCorrected` | `environment.wind.angleTrueWater` |
| True wind speed | `environment.wind.speedTrueCorrected` | `environment.wind.speedTrue` |
| True wind direction | `environment.wind.directionTrueCorrected` | `environment.wind.directionTrue` |
| Speed through water (when on) | `navigation.speedThroughWaterCorrected` | `navigation.speedThroughWater` |
| Leeway (when on) | `navigation.leewayAngleCorrected` | `navigation.leewayAngle` |
| Current | `environment.currentCorrected` | `environment.current` (`drift`, `setTrue`) |
| Ground wind speed | `environment.wind.speedOverGroundCorrected` | `environment.wind.speedOverGround` |
| Ground wind angle, from the bow | `environment.wind.angleTrueGroundCorrected` | `environment.wind.angleTrueGround` |
| Ground wind direction | `environment.wind.directionGroundCorrected` | `environment.wind.directionGround` (not in the Signal K schema, which has no ground wind direction; sent with `meta`) |

Everything is published under this plugin's own `$source`: STW each time the paddlewheel reports, the rest with each apparent wind update. Shadow paths carry `meta` with units. The plugin publishes into Signal K only; your instrument displays show the instrument's own numbers unless something forwards these to NMEA 2000.

## The webapp

Open **Webapps → Performance Processor**.

| | |
|---|---|
| ![Calibration: the TWA table, in the H5000 layout](docs/screenshots/calibration-twa.png) | ![Calibration: the boat speed / heel table](docs/screenshots/calibration-stw.png) |
| ![Settings: output mode, damping, input sources](docs/screenshots/settings.png) | ![The Live page in dark mode](docs/screenshots/live-dark.png) |

On a phone each chain stacks: ![The Live page on a phone](docs/screenshots/live-phone.png)

- **Live**: the published values, with the undamped and uncorrected ones under them; the pipeline, one chain per value sent: what it uses, each step with its value now and what it changed, the damping, and on the right what is sent (switched-off steps dashed), and under **Step by step** the same as a table; every path sent; each input's source and age.
- **Calibration**: the corrections in pipeline order, each with an on/off switch and its editor. Table headings are fixed (the H5000 layout); blank cells are allowed where a table says so. **Paste a table** reads the text `plugincal` prints (or the same from a spreadsheet); **Copy this table** writes it. **Reset to defaults** puts back the defaults for that correction. **Save** to apply.
- **Settings**: Shadow or Replace, damping, the fallback variation, and the source for each input.

Configuration is saved to `config.json` in the plugin's data directory (`~/.signalk/plugin-config-data/signalk-performance-processor/`), not in the admin **Plugin Config** form. Saving needs write access when Signal K security is on.

## Defaults for this boat

What a fresh install starts with (see [On the boat it was built for](#on-the-boat-it-was-built-for)).

- **Boat speed / heel table (kn added)**, relative to the H2000 boat speed setting then in force (4.24). Blank = too little data, filled from the nearest value in its row:

  | Heel \ STW (kn) | 0 | 5 | 10 | 15 | 20 | 25 | 30 |
  |---|---|---|---|---|---|---|---|
  | 0° | +0.60 | 0 | +0.07 | | | | |
  | 10° | +0.57 | +0.03 | +0.12 | | | | |
  | 20° | | −0.20 | −0.15 | | | | |

  The 0 kn column is the paddlewheel reading low when slow; it fades out below 1 kn.
- **Leeway:** K = 8.568, from the GPS.
- **TWA table (°)**. Blank = too little data: the nearest measured cell in the row is used. The 90° row is the least certain (few reaching manoeuvres):

  | TWA \ TWS (kn) | 0 | 5 | 10 | 15 | 20 | 25 | 30 |
  |---|---|---|---|---|---|---|---|
  | 40° | 0 | −8.6 | −11.5 | −5.1 | −3.7 | +0.6 | |
  | 90° | 0 | −10.0 | −14.2 | −7.3 | −2.5 | | |
  | 165° | 0 | +1.3 | −0.2 | −5.0 | +0.2 | | |

- **TWS table:** off. Correction 0, −0.5, −1 … −3 kn (−10% of each column), down angle 165°.
- **Fallback variation:** 12.8° E (Sydney).

## Configuration file

```json
{
  "schema": 3,
  "mode": "shadow",
  "variation": 12.8,
  "damping": { "heelS": 2, "headingS": 2, "trueWindS": 3, "stwS": 1, "currentS": 10 },
  "sources": { "apparentWind": "", "stw": "", "heading": "", "attitude": "", "gps": "", "variation": "" },
  "corrections": {
    "stw": { "enabled": true, "heel": [0, 10, 20], "stw": [0, 5, …, 30], "add": [[…], […], […]] },
    "leeway": { "enabled": true, "k": 8.568 },
    "twa": { "enabled": true, "tws": [0, 5, …, 30], "upwind": […], "reach": […], "downwind": […] },
    "tws": { "enabled": false, "tws": [0, 5, …, 30], "correction": […], "downAngle": […] }
  }
}
```

Blank cells are `null`. The table axes are fixed: a file with any other layout is refused with the reason. A file from before 0.1.0 is refused (its tables do not apply: **Reset to defaults** and refit), and a file from a newer release is refused and never overwritten.

## API

Under `/plugins/signalk-performance-processor`:

- `GET /calibration`: the configuration in use, the defaults, and `behaviour`, the built-in limits the webapp describes.
- `PUT /calibration`: validate, save and restart with a new configuration; 400 with the reasons if it is invalid.
- `GET /live`: the latest result, each step, input ages and the sources seen.

## Development

```bash
npm test          # node --test
cd ~/.signalk && npm install /path/to/signalk-performance-processor && sudo systemctl restart signalk
```

`lib/processor.js` is the pipeline, free of Signal K so it can be tested and replayed (`plugincal` runs it directly). Each correction is an entry in its `CORRECTIONS`, with its defaults in `lib/defaults.js` and its editor in `public/app.js`. `public/tables.js` is the table layout and text format, shared by the plugin, the webapp and `plugincal`. `lib/damping.js` is the damping; `index.js` the Signal K side.

## Licence

MIT
