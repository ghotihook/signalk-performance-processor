<img src="public/icon.svg" width="72" align="right" alt="">

# signalk-performance-processor

> **Proof of concept (0.0.2).** Run it in Shadow mode alongside your instruments and compare before relying on it.

Signal K plugin and webapp that does the calibration job of an instrument processor such as a B&G H5000: it corrects boat speed and leeway, works out true wind from apparent wind, applies H5000-style TWA and TWS correction tables, and publishes true wind and current.

Each correction can be switched on or off and edited in the webapp. A fresh install starts with values fitted to this boat's 2025 race logs.

See the [changelog](CHANGELOG.md) for what changed in each release.

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

- `GET /config` returns the configuration in use and the defaults.
- `PUT /config` validates, saves and restarts with a new configuration. It returns 400 with the reasons if the configuration is invalid.
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
