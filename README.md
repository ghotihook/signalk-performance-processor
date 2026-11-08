<img src="public/icon.svg" width="72" align="right" alt="">

# signalk-performance-processor

**True wind you can trust, in Signal K: TWD steady through tacks and gybes, TWS the same upwind and down, TWA as quick as your compass.**

**The problem.** If TWD swings 5–10° on every tack or gybe, or TWS jumps when you bear away, the wind hasn't changed: your true wind is miscalibrated. It inherits the errors of its inputs: the masthead reads air bent by the sails, the paddlewheel misreads when heeled, and neither error is the same on both tacks. Shifts, laylines, polars and routing all suffer.

**How it works.** From *raw* apparent wind, paddlewheel speed, heading and heel, it works true wind out again, as a B&G H5000 does:

1. **Boat speed table** (by heel and boat speed) corrects the paddlewheel; leeway follows from heel.
2. **True wind** = apparent wind − the boat's motion through the water.
3. **TWA and TWS tables** (by TWA and TWS) correct what the masthead gets wrong.
4. **Fast TWA**: TWD is damped, where the wind is steady, and TWA = damped TWD − heading is sent with *every compass update* ([Heading fusion](#how-it-works)).

It publishes TWA, TWS, TWD, boat speed, leeway, current and ground wind.

**The tables come from your own sailing.** TWD should not change across a tack, gybe or rounding; TWS should not change when you bear away; the GPS shows what the paddlewheel misses. Give your logs to your own AI agent with [AGENTS.md](AGENTS.md) and it fits them ([Calibrating](#calibrating)).

**What it can do:**

- **TWA at your compass's rate**: 10 Hz or more, not the wind sensor's 1–4 Hz. It moves with the helm through every wave and tack while TWD stays steady. Damped 1 s to read; 0 for an autopilot.
- **Tables of any shape**: an H5000 or H2000 calibration cell for cell, or a fine grid ([Tables](#tables-of-any-shape)).
- **Shadow mode**: run beside your instruments on separate `…Corrected` paths until you trust it.
- **Every step live** in a webapp: what each calculation uses, changes and sends.
- **Damping** per value, as on the H5000.
- **Leeway, current and ground wind**, and a plain JSON configuration.

![The Live page: one row per calculation, each step with its value now, what is sent on the right](docs/screenshots/live.png)

## Requirements

A Signal K server (2.x, Node 18+) with:

| Input | Path | Needed for |
|---|---|---|
| Apparent wind, **raw** | `environment.wind.angleApparent`, `speedApparent` | everything |
| Boat speed | `navigation.speedThroughWater` | everything |
| Heading | `navigation.headingTrue`, or `headingMagnetic` + `magneticVariation` | TWD, fast TWA, current, ground wind |
| Heel | `navigation.attitude` (roll) | boat speed table, leeway |
| SOG, COG | `navigation.speedOverGround`, `courseOverGroundTrue` | current, ground wind |

> **Apparent wind must be raw**: as the masthead measures it, with no instrument wind tables and no damping, or it is corrected twice and TWD swings with every yaw. Keep the masthead alignment offset in the instrument. **Boat speed**: the paddlewheel with at most a single speed factor.

## Installation

1. **Appstore → Available**, search **Performance Processor**, install, restart.
2. **Server → Plugin Config**: enable **gh - Performance Processor**.
3. **Webapps → Performance Processor**. It starts in Shadow mode with the defaults.

## Getting started

1. **Check the inputs** on the Live page (source and age of each). Where two sensors send the same thing, choose one in **Settings → Input sources**; Auto takes the highest-rate one.
2. **Calibrate** ([below](#calibrating)), paste the tables into **Calibration**, **Save**.
3. **Compare** the `…Corrected` paths with your instruments while sailing.
4. **Go live** with Replace mode: rank this plugin first in **Server → Source Priorities**, take the instrument's own wind tables out, and turn off any other plugin that makes true heading.

Refit after a rig tune, new sails, a boat speed calibration change or a new masthead unit.

## Calibrating

Give an AI agent that can run code (Claude Code, Codex…) your **raw** logs and [AGENTS.md](AGENTS.md). It checks the data, fits the tables the same way the author does, and reports.

1. **Log** since your setup last changed: 10+ tacks and gybes in steady wind, some reaching, a few roundings, windward-leeward laps. More days is better.
2. **Export raw**: apparent wind, paddlewheel speed, magnetic heading and variation, heel, SOG and COG, 1 Hz or faster. From Signal K history, or NMEA logs ([below](#from-nmea-logs)). If this plugin ran in Replace mode, use `navigation.speedThroughWaterRaw` and `headingMagnetic`, not its outputs.
3. **Prompt** your agent:
   > Read AGENTS.md in signalk-performance-processor and follow "Calibrating a boat" with this data: `<files>`. My setup last changed on `<date>`. My instrument is `<make, model>`; its wind tables are `<on/off/don't know>`, wind damping `<value>`. Here is my `config.json`. Check every input is raw before fitting, and ask me if unsure.
4. **Expect questions**: where each input came from, and what your instruments do to it. It should stop if the data isn't raw.
5. **You get** the tables to paste (or a `config.json`), and a report: data used and left out, improvement on days not fitted, cells left blank. Paste, **Save**, sail in Shadow mode.

**Know before you start**: does your instrument apply wind tables or wind damping? Any boat speed calibration? Is heading magnetic or true, deviation corrected? Which way does heel read positive? What sits between sensors and log (processor, multiplexer, plugins)? When did the setup last change?

### From NMEA logs

Log with **a time on every line**: Signal K's **Data Logging** on each data connection does this for 0183 and 2000; so do Actisense, Yacht Devices and `candump` logs.

| Input | NMEA 0183 | NMEA 2000 | Watch for |
|---|---|---|---|
| Apparent wind | `MWV`, reference `R` | 130306, reference Apparent | `T` / true references are true wind; a processor may re-send corrected apparent wind |
| Boat speed | `VHW` | 128259 | may be the processor's corrected STW |
| Heading | `HDG`, `HDM` | 127250, Magnetic | `HDT` is often computed |
| Heel | `XDR` roll | 127257 | sign varies by maker |
| SOG, COG | `RMC`, `VTG` | 129026 | true or magnetic COG |

### Pitfalls

- **Corrected data that looks raw**: the commonest mistake, and it gives a confident, wrong table. Know which device sent each value.
- **Damped wind**: AWA lags heading and the fit mistakes it for calibration error. Wind damping 0 while logging.
- **Two sensors mixed** in one input; **no timestamps**; **signs and units** (heel sign, AWA 0–360, knots vs m/s).
- **This plugin's own output** in a Replace-mode log.
- **Mixed setups**, or **too little sailing**: thin tables are better than noise.
- **Not fixable by tables**: masthead offset, AWS scale, compass deviation. Fix them in the instrument.

[boatcal](https://github.com/ghotihook/boatcal) is the author's implementation of the method.

## Tables of any shape

Each table is a grid; **you choose its rows and columns** by pasting (**Calibration → Paste a table**). Lookups are straight lines between cells, end rows held, and nothing at 0 kn below the first column. Rows and columns are any rising numbers (up to 100); a blank cell takes the value to its left.

**H5000**: boat speed / heel (add a 1 kn column at 0.4 × the 2.5 kn value to keep it as it was):

```
heel\stw, 2.5, 5, 7.5, 10, 12.5, 15
-20, 0.4, 0.2, 0, -0.1, -0.1, -0.2
-10, 0.3, 0.1, 0, 0, 0, 0
0, 0.3, 0.05, 0, 0, 0, 0
10, 0.3, 0.1, 0, 0, 0, 0
20, 0.35, 0.15, -0.05, -0.1, -0.1, -0.1
```

TWA, rows at 40°, 90° and 165°:

```
TWA\TWS, 5, 10, 15, 20, 25, 30
40, -9, -7, -5, -2, 3, 6
90, -3, -2, -1, 0, 1, 2
165, 2, 1, 0, -1, -2, -3
```

TWS, in the H5000's own rows (read as a grid at the up angle, 90° and the down angle):

```
TWS, 5, 10, 15, 20, 25, 30
upwind, 0, 0, 0, 0, 0, 0
reach, -0.2, -0.4, -0.6, -0.8, -1, -1.2
downwind, -0.8, -1.5, -2.3, -3, -3.8, -4.5
up angle, 50, 50, 50, 50, 50, 50
down angle, 110, 110, 110, 110, 110, 110
```

**H2000** TWA: rows by name, read as 40°, 90° and 165° (label them with other angles if your instrument uses others):

```
TWA\TWS, 5, 10, 15, 20, 25, 30
upwind, -9, -7, -5, -2, 3, 6
reach, -3, -2, -1, 0, 1, 2
downwind, 2, 1, 0, -1, -2, -3
```

**Full table**: the defaults, TWA every 10° × TWS every 2 kn (shortened; **Copy this table** gives it all):

```
TWA\TWS, 4, 6, 8, 10, 12, …, 30
30, , -4.1, -4.1, -4, -3.8, …,
40, -5.2, -5.1, -5.1, -5, -4.8, …,
50, -9.5, -9.5, -9.5, -9.5, -9.2, …,
…
```

One rule for the TWA table (Save names any breach): corrected TWA must move with TWA, at most twice as fast: within ±30° near head to wind, ±10° near dead downwind, and from row to row a change smaller than the rows are apart.

## How it works

| Chain | Uses | Steps | Sends |
|---|---|---|---|
| Heading | compass, variation | + variation (never damped) | true heading (unless the sensor sends it) |
| Boat speed | paddlewheel, heel | STW table → damping | STW |
| Leeway | heel, *STW* | K × heel ÷ STW² | leeway |
| True wind | apparent wind, *STW*, heading | apparent − boat → TWA table → TWS table → + heading → damping | TWD, TWS; TWA = damped TWD − heading, on each heading update (on apparent wind only without a heading) |
| Current | SOG, COG, heading, *STW*, *leeway* | ground − water → damping | current |
| Ground wind | *TWD*, *TWS*, *current* | true wind + current → damping | speed, direction; angle on each heading update |

*Italics*: made by another chain.

| Correction | What it does |
|---|---|
| STW table | Knots added, by heel (+ = starboard down) and boat speed. From nothing at 0 kn to the first column, so a stopped boat gets no speed. A 1 kn column catches the paddlewheel's stall |
| Leeway | K × heel ÷ STW², capped at 15°, faded in from 1.5 to 3 kn. Used for current, not true wind (the TWA table takes up its effect) |
| TWA table | Degrees added to \|TWA\|, by TWA and TWS. In full from 30° to 170°, fading to none at 0° and 180°, so TWD passes smoothly through tacks and gybes |
| TWS table | Knots added, by TWA and TWS, at the corrected TWA. Masthead units read high off the wind, so mostly negative |

**Heading fusion: fast TWA.** The wind changes slowly; the bow changes fast. So the plugin damps TWD, not TWA, and sends TWA = damped TWD − heading *now* with every compass update: a 10 Hz compass gives 10 Hz TWA from 2 Hz wind, while TWD stays put. Without a heading, TWA goes out with apparent wind. Heading is never damped, so apparent wind must be raw too: a lag in either swings TWD with every yaw.

**Damping** (seconds, 0 = none): heel 2, true wind 3 (TWD, TWS, ground wind), TWA 1 (the TWA and ground wind angle sent with each heading update, to read; TWD is unaffected), STW 1, current 120 (it is a trend; up to 300).

**Built in:**

- **Light air**: below 1.5 kn TWS, TWD and ground wind direction and angle are held back until 2 kn; TWA and TWS still go out.
- **Stale or implausible input** (older than 3 s; wind over 120 kn, STW over 60 kn, heel beyond 90°) is not used; the status says why.
- **One sensor per input**, never another plugin's output unless chosen in Settings. Auto picks the busiest sensor and moves only if it stops.
- **No path faster than 50 Hz**, so a loop with another plugin shows up in the status.

## The webapp

- **Live**: published values, the pipeline with each step's value and each input's and output's rate, what is sent, each input's source and age.
- **Calibration**: each correction with its switch, table, limits, **Paste a table**, **Copy this table**, **Reset to defaults**. **Save** applies.
- **Settings**: Shadow or Replace, damping, fallback variation, the source for each input.

| | |
|---|---|
| ![Calibration: the TWA table](docs/screenshots/calibration-twa.png) | ![Calibration: the boat speed / heel table](docs/screenshots/calibration-stw.png) |
| ![Calibration: the TWS table](docs/screenshots/calibration-tws.png) | ![Settings: output mode, damping, input sources](docs/screenshots/settings.png) |
| ![The Live page in dark mode](docs/screenshots/live-dark.png) | ![The Live page on a phone](docs/screenshots/live-phone.png) |

## Outputs

| Output | Shadow mode | Replace mode |
|---|---|---|
| TWA | `environment.wind.angleTrueWaterCorrected` | `environment.wind.angleTrueWater` |
| TWS | `environment.wind.speedTrueCorrected` | `environment.wind.speedTrue` |
| TWD | `environment.wind.directionTrueCorrected` | `environment.wind.directionTrue` |
| True heading | `navigation.headingTrueCorrected` | `navigation.headingTrue` |
| STW | `navigation.speedThroughWaterCorrected` | `navigation.speedThroughWater` |
| Leeway | `navigation.leewayAngleCorrected` | `navigation.leewayAngle` |
| Current | `environment.currentCorrected` | `environment.current` |
| Ground wind speed, angle | `environment.wind.speedOverGroundCorrected`, `angleTrueGroundCorrected` | `environment.wind.speedOverGround`, `angleTrueGround` |
| Ground wind direction | `environment.wind.directionGroundCorrected` | `environment.wind.directionGround` (with `meta`) |
| Raw STW (always) | `navigation.speedThroughWaterRaw` | the same, so history keeps the raw value |

## Configuration

Set in the webapp, saved to `~/.signalk/plugin-config-data/signalk-performance-processor/config.json` (not the admin Plugin Config form). A config from calibrating can be copied there (then restart) or sent with `PUT /calibration`.

```json
{
  "schema": 7,
  "mode": "shadow",
  "variation": 12.8,
  "damping": { "heelS": 2, "trueWindS": 3, "twaS": 1, "stwS": 1, "currentS": 120 },
  "sources": { "apparentWind": "", "stw": "", "heading": "", "attitude": "", "gps": "", "variation": "" },
  "corrections": {
    "stw": { "enabled": true, "heel": [-30, -25, …, 30], "stw": [1, 2, …, 15], "add": [[…], …] },
    "leeway": { "enabled": true, "k": 8.426 },
    "twa": { "enabled": true, "twa": [30, 40, …, 180], "tws": [4, 6, …, 30], "add": [[…], …] },
    "tws": { "enabled": true, "twa": [30, 40, …, 180], "tws": [4, 6, …, 30], "add": [[…], …] }
  }
}
```

Blank cells are `null`. **Upgrading**: files from 0.2.7–0.2.17 keep every table exactly (converted to grids); older files keep settings and K, reset their tables and go to Shadow mode; the status says so until you Save. A file from a newer release is refused and never overwritten. One that can't be read, or fails its checks, stops the plugin; the webapp shows its good parts and says what was reset, and saving keeps the old file as `config.json.bad`. **Going back** to 0.2.x after saving in 0.3 needs a copy of your old `config.json`.

**The defaults are the author's boat.** Refit for yours.

## Limitations

- **Instrument displays** show the instrument's numbers unless you forward these to NMEA 2000 (e.g. `signalk-to-nmea2000`); then choose your own sensors as sources in Settings, so the forwarded values aren't read back.
- **Damped apparent wind** can't be used: heading is never damped, so wind damped at the instrument swings TWD with every yaw. Turn it off.
- **Current is a trend**: 1% of boat speed or 1° of heading is 0.1 kn, so it is damped over 2 minutes by default (up to 5).
- **Absolute TWS and TWD** (masthead offset, AWS scale) can't be fitted from tacks: set them in the instrument. The TWS table corrects off the wind *relative to upwind*.

## Troubleshooting

The status line (admin UI and webapp) says what the plugin is doing.

| Status | Meaning |
|---|---|
| Waiting for apparent wind / speed through water | No recent value from the sensor in use |
| No apparent wind for N s | Nothing published; the Live page greys out the last values |
| (X sends it: choose it in Settings) | Another sensor sends a missing input |
| … from X: Y stopped sending | Auto moved to sensor X. Normal 30 s after boot on NMEA 2000 (device renamed); otherwise check Y |
| (only from X, another plugin) | Only another plugin sends it: choose it in Settings, or read its sensor |
| Not publishing — … not plausible | A sensor fault |
| … light air … | TWS under 1.5 kn: TWD held back |
| … no heel / heading / SOG/COG | Running without it |
| Rate limited … | Over 50 Hz, usually a loop with another plugin |
| Configuration: … | The saved config is invalid or unreadable; not running. Fix it in the webapp |
| Upgraded from an earlier release … | See [Configuration](#configuration). Save to clear |

## API

Under `/plugins/signalk-performance-processor`:

- `GET /calibration`: config in use, defaults, built-in limits, and what is wrong with the saved file, if anything.
- `PUT /calibration`: validate, save, restart; 400 with reasons. With `schema`, a whole config; without, changes laid over the current one.
- `GET /live`: latest result, steps, inputs, sources, what was sent and how often, and any error.
- `PUT /learn/scan`, `GET /learn/status`: **in progress** (learning the tables from Signal K history).

## Development

```bash
npm test
cd ~/.signalk && npm install /path/to/signalk-performance-processor && sudo systemctl restart signalk
```

`lib/processor.js` is the calculation (no Signal K, so boatcal can replay it); `public/tables.js` the tables and text format; `lib/damping.js` the damping; `index.js` the Signal K side. The maths: [SPECIFICATION.md](SPECIFICATION.md). Changes: [CHANGELOG.md](CHANGELOG.md). Agents: [AGENTS.md](AGENTS.md).

## Licence

MIT
