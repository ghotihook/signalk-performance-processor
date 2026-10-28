<img src="public/icon.svg" width="72" align="right" alt="">

# signalk-performance-processor

**True wind direction that holds steady when you tack.**

If your TWD swings 5–10° every time you tack or gybe, the wind hasn't shifted: your true wind calibration is off. It makes real shifts hard to call, puts laylines in the wrong place, and feeds bad numbers into your polars and targets.

This plugin does the calibration job of a B&G H5000-class instrument processor inside Signal K. It corrects boat speed and leeway, then applies H5000-style TWA and TWS correction tables, and publishes corrected true wind and current. You edit everything in a webapp and can watch each correction work live. Run it in **Shadow mode** first: it publishes alongside your existing instruments without changing anything they do.

> **Proof of concept (0.0.3).** Compare it against your instruments in Shadow mode before relying on it. See the [changelog](CHANGELOG.md).

## Why it exists

True wind is worked out from apparent wind, boat speed and heading, so it inherits every error in them. The masthead sensor reads a bent airflow upwind, the paddlewheel misreads when heeled, and the boat slides sideways. None of these is the same on every point of sail, and some flip from one tack to the other. That is why an uncalibrated TWD jumps through every tack.

Instrument processors fix this with calibration tables, but:

- **The tables are locked in the box.** You edit them through display menus, cannot see what each one is doing at any moment, and keep no history of what you changed or why.
- **Older and simpler systems have less to work with.** An H2000, for example, has a TWS correction that only applies downwind, and many systems have no tables at all.
- **Formula-based corrections don't fit every boat.** A single upwash formula cannot follow a boat whose correction is twice as big in light air as in a breeze at the same apparent wind angle. That was the case on the boat this was built for; a table can follow it.

This plugin moves the calibration into Signal K, where you can see it, change it, log it and fit it from your own race data:

- **The same shape as an H5000:** boat speed linearity and heel correction, leeway, and TWA/TWS tables by wind speed with upwind, reach and downwind rows. An existing calibration carries across, and the H5000 tuning rule ("TWD lifts on every tack: take half the error off TWA") works unchanged.
- **Every correction has a switch and a live readout,** so you can see what each one does to the numbers right now.
- **The calibration is a versioned JSON file,** easy to back up, compare and fit from logged races offline.
- **It is safe to try.** Shadow mode publishes `…Corrected` paths beside your instruments. Replace mode takes over the standard paths only when you choose it.

### On the boat it was built for

From the offline model the defaults were fitted with: trained on 2025 race logs, tested on Jan–Mar 2026 races it had not seen, and measured by how far true wind direction jumps through each manoeuvre (median). The shipped defaults differ slightly (the owner's leeway K, and the TWA table resampled to H5000 breakpoints).

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
| Boat speed (STW) | Knots added to the paddlewheel: a **linearity** row by speed plus a **heel correction** row by heel, the same split as the H5000 | On |
| Leeway | Leeway = K × heel ÷ STW², turning the boat's velocity to leeward | On, K = 7.9446 |
| True wind | Apparent wind minus the boat's velocity through the water | Always |
| TWA table | Degrees added to \|TWA\| by TWS, with upwind, reach and downwind rows blended by TWA (70° / 100° / 130°) | On |
| TWS table | Percent applied to TWS by TWS, same rows and blending | Off |
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

Feed it **measured** apparent wind and **raw** paddlewheel speed. If another plugin already corrects STW (for example `signalk-stw-heel-correction`), choose the instrument as the STW source in Settings, or the correction is applied twice.

### Outputs

| Output | Replace mode | Shadow mode |
|---|---|---|
| True wind angle | `environment.wind.angleTrueWater` | `environment.wind.angleTrueWaterCorrected` |
| True wind speed | `environment.wind.speedTrue` | `environment.wind.speedTrueCorrected` |
| True wind direction | `environment.wind.directionTrue` | `environment.wind.directionTrueCorrected` |
| Speed through water (when on) | `navigation.speedThroughWater` | `navigation.speedThroughWaterCorrected` |
| Leeway (when on) | `navigation.leewayAngle` | `navigation.leewayAngleCorrected` |
| Current | `environment.current` (`drift`, `setTrue`) | `environment.currentCorrected` |

Everything is published under this plugin's own `$source`. Corrected STW goes out each time the paddlewheel reports, while the STW correction is on; the rest goes out with each apparent wind update. Shadow paths carry `meta` with units, since they are not in the Signal K schema.

## Modes

- **Shadow** (default) publishes to separate `…Corrected` paths. Your instruments and displays carry on unchanged, and you can log both side by side.
- **Replace** publishes on the standard paths. Then:
  1. In **Server → Source Priorities**, rank `signalk-performance-processor` above the instrument for each output path.
  2. Zero the instrument's own TWA/TWS correction tables and leeway, so nothing is corrected twice. Keep the masthead unit alignment and the boat speed calibration factor in the instrument.

## The webapp

Open **Webapps → Performance Processor**.

- **Live**: the outputs next to their uncorrected values, what each step is doing right now, and which source and how fresh each input is.
- **Calibration**: every correction in pipeline order with an on/off switch. Select one to edit its values, then **Save**. **Reset to defaults** puts back this boat's fitted values for that correction.
- **Settings**: Shadow or Replace, the fallback magnetic variation, and which source to read for each input.

All configuration lives in the webapp. It is saved to `config.json` in the plugin's data directory (under `~/.signalk/plugin-config-data/`), not in the admin **Plugin Config** form, which only points here; saving that form cannot overwrite the tables. Saving needs write access when Signal K security is on.

## Defaults for this boat

Fitted to the 2025 race logs and checked on Jan–Mar 2026 races not used in fitting, by how little true wind direction and current jump through tacks, gybes and roundings.

- **STW:** linearity +0.58 kn at 0.5 kn falling to 0 at 8.5 kn (tapering to 0 below 0.5 kn); heel 0 to −0.29 kn at 30°. This is the owner's measured heel × STW table, reduced to two rows within 0.03 kn of every cell.
- **Leeway:** K = 7.9446, one value for every sail.
- **TWA table (°):**

  | TWS (kn) | 5 | 10 | 15 | 20 | 25 | 30 |
  |---|---|---|---|---|---|---|
  | Upwind | −12.0 | −13.4 | −5.7 | −4.3 | −4.3 | −4.3 |
  | Reach | −10.7 | −10.7 | −10.7 | −10.7 | −10.7 | −10.7 |
  | Downwind | −4.2 | −3.5 | −1.6 | −1.3 | −1.3 | −1.3 |

  The reach row is provisional: it rests on roundings only.
- **TWS table (%):** off. Downwind −11.1% at 15 kn and −14.4% from 20 kn; light air and upwind left at 0.
- **Fallback variation:** 12.8° E, used only when nothing on the boat sends true heading or magnetic variation. The Live page shows which applies.

## Configuration file

`config.json` in the plugin's data directory, written by the webapp:

```json
{
  "schema": 1,
  "mode": "shadow",
  "variation": 12.8,
  "sources": { "apparentWind": "", "stw": "", "heading": "", "attitude": "", "gps": "", "variation": "" },
  "corrections": { "stw": { … }, "leeway": { … }, "twa": { … }, "tws": { … } }
}
```

`schema` is the version of the file's shape. A release that changes the shape bumps `CONFIG_SCHEMA` in `lib/processor.js` and adds a migration from the previous version, so older files are upgraded as they load and nothing is reset. A file without `schema` (saved by 0.0.1) is read as schema 1. A file from a newer release is refused rather than guessed at, and is never overwritten by an older plugin.

## Adding a correction

Corrections live in `lib/processor.js` as entries in `CORRECTIONS`, each with a stage (`input` before true wind, `trueWind` after) and an `apply` function. Their defaults go in `lib/defaults.js`. The pipeline, the Live view and the enable switch pick a new entry up from there; the Calibration page needs an editor for its values in `public/app.js`.

## API

Under `/plugins/signalk-performance-processor`:

- `GET /calibration` returns the configuration in use and the defaults.
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
