<img src="public/icon.svg" width="72" align="right" alt="">

# signalk-performance-processor

**Steady true wind direction through tacks and gybes: true wind calibrated in Signal K, the way a B&G H5000 does it.**

**The problem.** If your TWD swings 5–10° every time you tack or gybe, the wind hasn't shifted: your true wind is miscalibrated. True wind is worked out from apparent wind, boat speed and heading, so it inherits their errors. The masthead reads a bent airflow upwind, the paddlewheel misreads when heeled, and neither error is the same on both tacks. You can't call real shifts, laylines land in the wrong place, and polars and targets get bad numbers.

**What it does.** It works out true wind again in Signal K from raw apparent wind, boat speed and heading, and corrects it as an H5000 does: a boat speed / heel table, then TWA and TWS correction tables, then damping. It publishes corrected TWA, TWS and TWD, with boat speed, leeway, current and ground wind.

**How it is calibrated.** From your own sailing. TWD should not change when the boat tacks or gybes, so every manoeuvre in your logs measures how far TWA is out; TWS should not change when the boat bears away, so each reaching or downwind leg against the beats either side measures how far TWS is out off the wind; the GPS measures the boat speed table. **Give your raw logs to your own AI agent** and point it at [AGENTS.md](AGENTS.md), which takes it through the checks and the fit ([Calibrating](#calibrating-give-your-data-to-your-ai-agent)). Paste the result into the webapp, watch each step work live, and run it in **Shadow mode** beside your instruments until you trust it.

![The Live page: one row per calculation, each step with its value now, what is sent on the right](docs/screenshots/live.png)

## Features

- **The H5000's tables, as fine as your data allows**: boat speed / heel, TWA and TWS, each a grid whose rows and columns you choose by pasting it in. The defaults are fine grids (heel every 5° × boat speed every 1 kn; TWA every 10° × TWS every 2 kn), and an H5000 calibration still pastes in cell for cell. A 1 kn boat speed column catches a paddlewheel's stall (for an H5000 table, fill it with 0.4 × the 2.5 kn value to keep it as it was).
- **Fitted from your own logs** by your own AI agent, following [AGENTS.md](AGENTS.md), and pasted straight into the webapp.
- **Every step visible live**: what each calculation uses, what each correction changed, and what is sent.
- **Damping as on the H5000**, set separately for heading, heel, true wind, boat speed and current.
- **Safe to try**: Shadow mode publishes separate `…Corrected` paths and changes nothing else.
- **Leeway, current and ground wind** as well as true wind.
- **A plain JSON configuration**, easy to back up and compare.

## Requirements

- A Signal K server (2.x) on Node 18 or newer. Replace mode uses the server's **Source Priorities**.
- These inputs in Signal K:

| Input | Path | Needed for |
|---|---|---|
| Apparent wind, **raw** | `environment.wind.angleApparent`, `speedApparent` | everything |
| Boat speed | `navigation.speedThroughWater` | everything |
| Heading | `navigation.headingTrue`, or `headingMagnetic` with `navigation.magneticVariation` | TWD, current, ground wind |
| Heel | `navigation.attitude` (roll) | the STW table's heel rows, leeway |
| SOG, COG | `navigation.speedOverGround`, `courseOverGroundTrue` (or `courseOverGroundMagnetic` + variation) | current, ground wind |

> **Apparent wind must be raw: AWA and AWS as the masthead measures them, uncorrected and undamped.** The plugin applies the calibration and the damping itself. Wind that an instrument has already corrected gets corrected twice, and wind it has already damped lags heading and boat speed, so TWD swings with every yaw. In the instrument, take the wind tables out and set wind damping to 0, or read apparent wind from a source ahead of it. Masthead alignment (an offset fixed on the sensor) is the exception: keep it in the instrument.
>
> **Boat speed** is the paddlewheel with the instrument's boat speed calibration (its speed factor) and nothing else: no heel correction in the instrument.

## Installation

1. In the Signal K admin UI, **Appstore → Available**, search for **Performance Processor**, **Install**, and restart the server when asked.
2. **Server → Plugin Config**: enable **gh - Performance Processor** (it ships disabled).
3. Open **Webapps → Performance Processor**. It starts in Shadow mode with the defaults.

## Getting started

1. **Check the inputs.** The Live page lists every input with its source and age. Each input is read from one sensor, never from another plugin: Auto takes the one with the highest data rate in the first 2 s, not necessarily the most accurate, and moves to another only if that one stops. **Settings → Input sources** lists every source of each input with its rate: where two instruments send the same thing (a compass and an IMU both sending heel, say), choose the right one there.
2. **Calibrate.** Give your logs to an AI agent, as in [Calibrating](#calibrating-give-your-data-to-your-ai-agent) below, paste each table it gives you into the **Calibration** page, and **Save**. By hand, the H5000 rule works unchanged: if TWD lifts on every tack, take half the error off TWA in that cell.
3. **Compare.** Sail in Shadow mode and compare the `…Corrected` paths with your instruments. Anything else that uses true wind or boat speed (a polar or performance plugin, a display) still reads the standard paths until you go live: point it at the `…Corrected` paths to see its numbers on the corrected values first.
4. **Go live** with Replace mode once you trust it: rank this plugin first for each output path in **Server → Source Priorities**, and take the instrument's own TWA / TWS tables out so nothing is corrected twice. This plugin sends true heading too: turn off any other plugin that works it out (such as derived-data's true heading), so one value goes to the whole boat.

Refit after anything that changes the boat or what the instruments read: a rig tune, new sails, a boat speed calibration change, a new masthead unit.

## Calibrating: give your data to your AI agent

The tables are fitted from your own sailing. The best way to get them is to give an AI agent that can run code (Claude Code, Codex or similar) your **raw** logs and have it work through the same analysis this plugin's author uses. [AGENTS.md](AGENTS.md) is written for that agent: what data to ask for, the checks that the inputs are raw, the method, the checks before it hands anything over, and what to hand over.

**1. Log the right sailing.** Since your setup last changed (rig tune, sails, masthead unit, instrument calibration): 10 or more tacks and gybes in steady wind, some reaching, a few mark roundings, and windward-leeward laps for the TWS table. More days is better: each day is held out in turn to check the fit.

**2. Export it raw.** Apparent wind angle and speed straight from the masthead unit, paddlewheel boat speed, magnetic heading and variation, heel, SOG and COG, at 1 Hz or faster, for the whole period. From Signal K, a history provider (signalk-to-influxdb2, signalk-questdb, signalk-parquet) holds these on the paths in [Requirements](#requirements); if this plugin has run in Replace mode, export `navigation.speedThroughWaterRaw` and `navigation.headingMagnetic`, not its own outputs. A log from your instrument system or a navigation program works too, as long as it is the raw values. **Raw matters most:** apparent wind that an instrument has already corrected or damped, or boat speed it has already corrected for heel, gets corrected twice. If you don't know whether your log is raw, say so: the agent checks.

**3. Give it to your agent** with this repository (or this plugin's folder in `~/.signalk/node_modules`), and a prompt like:

> Read AGENTS.md in signalk-performance-processor and follow "Calibrating a boat" to fit my tables from this data: `<files or database>`. My setup last changed on `<date>`. My instrument is `<make and model>`; its wind tables are `<on/off/don't know>`. Here is my current `config.json`. Check the inputs are raw before fitting anything, and stop and ask me if they might not be.

**4. Expect questions.** The agent should ask where each input came from and what your instruments do to it, report every check (raw inputs, signs, units, damping, masthead alignment, faults), and stop if something is wrong. That is the point: a table fitted from corrected data looks just as convincing as a right one.

**5. Check what you get back:** each table in the paste format, or a complete `config.json`, and a report of the data used, what was left out and why, how much each table improved things on days it was not fitted on, and which cells are blank for lack of data. Paste the tables into **Calibration** (or send the config with `PUT /calibration`), **Save**, and sail in **Shadow mode** until you trust them.

[boatcal](https://github.com/ghotihook/boatcal) is the author's implementation of the same method, against the author's own database: the reference for the method, and the agent's to read.

## How it works

One chain per calculation, from its inputs to what it sends. Inputs in *italics* are made by another chain. The Live page shows the same chains with each value now.

| Chain | Uses | Steps | Sends |
|---|---|---|---|
| Heading | compass, variation | magnetic + variation → damping | true heading, with each compass update (not when the heading sensor sends true heading itself) |
| Boat speed | paddlewheel, heel | STW table → damping | STW |
| Leeway | heel, *STW* | K × heel ÷ STW² | leeway |
| True wind | apparent wind, *STW*, heading | apparent wind − STW along the heading → TWA table → TWS table → heading + TWA → damping | TWD, TWS, and TWA as the damped TWD less the heading. TWA goes out with each heading update too, so it follows a tack at the compass's rate |
| Current | SOG, COG, heading, *STW*, *leeway* | ground velocity − water velocity → damping | current |
| Ground wind | *TWD*, *TWS*, *current* | true wind + current → damping | ground wind speed, direction and angle (the angle with each heading update too) |

| Correction | What it does | Default |
|---|---|---|
| STW table | Knots added to the paddlewheel, by heel (rows, + = starboard side down; default −30 to 30 by 5°) and boat speed (columns; default 1 to 15 by 1 kn), bilinear, the end rows and the last column held beyond them. Below 1 kn the correction runs in a straight line to nothing at 0 kn, so a stopped boat is not given speed. The 1 kn column is not on the H5000: a paddlewheel stalls below about 2 kn and reads up to 0.6 kn low there, which a straight line from 2.5 kn misses, and in light air that is several degrees of TWA. **Edit symmetrically** on the Calibration page keeps port and starboard rows the same (when the heel rows mirror each other) | On |
| Leeway | K × heel ÷ STW², capped at 15°, faded in from 1.5 to 3 kn. Used for current, **not** for true wind, as on the H5000 by default: the TWA table takes up its effect | On |
| TWA table | Degrees added to \|TWA\|, by TWA (rows; default 30 to 180 by 10°) and TWS (columns; default 4 to 30 by 2 kn), bilinear, the end rows held beyond them, and from nothing at 0 kn below the first column. In full from 30° to 170° TWA, fading to none at 0° and 180°, so TWD passes smoothly through tacks and gybes. Corrected TWA must move the same way as TWA and at most twice as fast: within ±30° near head to wind, ±10° near dead downwind, and from row to row a change smaller than the rows are apart | On |
| TWS table | Knots added to TWS, laid out as the TWA table: by TWA (rows) and TWS (columns), bilinear, never a step, looked up at the TWA after the TWA table. Masthead units read high off the wind (the sails speed the air up over the rig), so this mostly takes off. (An H5000-style table, with upwind, reaching and downwind rows and up and down angles, pastes in as the grid that works the same) | On |

**Damping**, in seconds (0 = none), as on the H5000:

| Value | Default | |
|---|---|---|
| Heading | 0 s | Heading, before true wind. Keep it at apparent wind's lag: 0 for raw apparent wind, or a yaw swings TWD |
| Heel | 2 s | Heel, before the STW table and leeway, from every attitude message at the sensor's rate: takes most of the roll out |
| True wind | 3 s | TWD, TWS and ground wind. TWA is the damped TWD less the heading now, sent with each heading update, so it answers the helm at once |
| STW | 1 s | The published STW |
| Current | 10 s | Current, as a vector |

More true wind damping gives a steadier TWD but shows a real shift later.

**Built in**, with the plugin's own numbers listed in the webapp:

- **Light air.** Below 1.5 kn of TWS, wind direction is noise: TWD and the ground wind direction and angle are not published until TWS is back to 2 kn. TWA, TWS and ground wind speed still are: in light air TWA is what you sail by, so it is never held back.
- **Stale or implausible input.** Inputs older than 3 s are not used. When apparent wind stops nothing is published: Signal K keeps the last values, so the status says so and the Live page greys them out. Apparent wind over 120 kn or STW over 60 kn is ignored and the status says why; heel beyond ±90° counts as no heel.
- **Heading.** `navigation.headingTrue` from the heading sensor if it sends it; otherwise magnetic heading plus `navigation.magneticVariation` (normally from the GPS); otherwise the fallback variation in Settings.
- **Inputs from sensors, one each.** Unless you choose a source in Settings, every input is read from data connections only, never from another plugin (its value is a copy, later and slower, or already corrected, and in Replace mode it may be this plugin's own output fed back), and from one sensor: for its first 2 s the first seen, then the one sending most often (the highest data rate, not necessarily the most accurate), kept while it sends. Two sensors that disagree are never mixed. If that sensor goes quiet for 3 s (10 minutes for variation) and another sensor is sending the input, the other sensor takes over at once and the status says so for a minute: it may not be the one the tables were fitted to, so if you would rather have no value than a different sensor's, choose a source in Settings. A chosen source is never replaced: if it goes quiet the input is missing, and the status names any other sensor sending it.
- **No loops with other plugins**, as above, and no path is published more often than 20 Hz.

## The webapp

**Webapps → Performance Processor.**

- **Live**: the published values, with the undamped and uncorrected ones under them; the pipeline, one row per calculation; every value the plugin has sent in the last few seconds, with its path; each input's source and age.
- **Calibration**: the corrections in pipeline order, each with an on/off switch, its table, its built-in limits, **Paste a table** (the text boatcal or your agent prints, or the same from a spreadsheet), **Copy this table** and **Reset to defaults**. **Save** to apply.
- **Settings**: Shadow or Replace, damping, the fallback variation, and the source for each input: every source seen, with its rate and whether it is another plugin, and which sensor Auto (the highest-rate sensor) is using.

| | |
|---|---|
| ![Calibration: the TWA table](docs/screenshots/calibration-twa.png) | ![Calibration: the boat speed / heel table](docs/screenshots/calibration-stw.png) |
| ![Calibration: the TWS table](docs/screenshots/calibration-tws.png) | ![Settings: output mode, damping, input sources](docs/screenshots/settings.png) |
| ![The Live page in dark mode](docs/screenshots/live-dark.png) | |

On a phone each row stacks: ![The Live page on a phone](docs/screenshots/live-phone.png)

## Outputs

| Output | Shadow mode (default) | Replace mode |
|---|---|---|
| True wind angle | `environment.wind.angleTrueWaterCorrected` | `environment.wind.angleTrueWater` |
| True wind speed | `environment.wind.speedTrueCorrected` | `environment.wind.speedTrue` |
| True wind direction | `environment.wind.directionTrueCorrected` | `environment.wind.directionTrue` |
| True heading (from compass + variation) | `navigation.headingTrueCorrected` | `navigation.headingTrue` |
| Speed through water (STW table on) | `navigation.speedThroughWaterCorrected` | `navigation.speedThroughWater` |
| Leeway (on) | `navigation.leewayAngleCorrected` | `navigation.leewayAngle` |
| Current | `environment.currentCorrected` | `environment.current` (`drift`, `setTrue`) |
| Ground wind speed | `environment.wind.speedOverGroundCorrected` | `environment.wind.speedOverGround` |
| Ground wind angle, from the bow | `environment.wind.angleTrueGroundCorrected` | `environment.wind.angleTrueGround` |
| Ground wind direction | `environment.wind.directionGroundCorrected` | `environment.wind.directionGround` (not in the Signal K schema; sent with `meta`) |
| Raw STW, as the paddlewheel sent it (always) | `navigation.speedThroughWaterRaw` | `navigation.speedThroughWaterRaw` (not in the schema; sent with `meta`). So a history provider records raw STW for learning: in Replace mode the corrected value wins `navigation.speedThroughWater` |

Everything is published under this plugin's own `$source`: STW each time the paddlewheel reports; true heading, TWA and ground wind angle with each heading update; TWA and everything else with each apparent wind update. Shadow paths carry `meta` with their units.

## Configuration

Everything is set in the webapp and saved to `config.json` in the plugin's data directory (`~/.signalk/plugin-config-data/signalk-performance-processor/`), not in the admin **Plugin Config** form. Saving needs write access when Signal K security is on. A complete config from calibrating (`"schema": 7`) can be copied there (then restart) or sent with `PUT /calibration`.

```json
{
  "schema": 7,
  "mode": "shadow",
  "variation": 12.8,
  "damping": { "heelS": 2, "headingS": 0, "trueWindS": 3, "stwS": 1, "currentS": 10 },
  "sources": { "apparentWind": "", "stw": "", "heading": "", "attitude": "", "gps": "", "variation": "" },
  "corrections": {
    "stw": { "enabled": true, "heel": [-30, -25, …, 30], "stw": [1, 2, …, 15], "add": [[…], …] },
    "leeway": { "enabled": true, "k": 8.396 },
    "twa": { "enabled": true, "twa": [30, 40, …, 180], "tws": [4, 6, …, 30], "add": [[…], …] },
    "tws": { "enabled": true, "twa": [30, 40, …, 180], "tws": [4, 6, …, 30], "add": [[…], …] }
  }
}
```

Blank table cells are `null`: a blank takes the value to its left in its row (at the start of a row, the first value to its right; it is not interpolated between its neighbours), and a row with none takes the nearest row. `add` has a row per row value and a value per column. Each table's axes are saved with it: any number of rows and columns (up to 100), each going up, heel within ±90°, TWA 0 to 180°, speeds above 0. A file from 0.2.12 to 0.2.17 keeps every table exactly: the TWA table becomes a grid with rows at 40°, 90° and 165°, and the TWS table one with rows at its up angle, 90° and its down angle, so nothing changes until you paste or reset to the finer layout. Older files keep their settings, leeway K and any table whose layout still fits. From 0.2.7 to 0.2.11 that is every table: the boat speed table gets a 1 kn column set so it works exactly as before, and the status asks for a refit until you Save. From 0.2.6 the TWA table, and from 0.1.0 to 0.2.5 all three, are reset to the defaults and the plugin runs in Shadow mode until you refit them and Save (the status says so). A file with any other layout is refused with the reason, and so is a file from a newer release, which is never overwritten. A file that cannot be read is refused too: the plugin does not run, rather than run on the defaults, and if you then Save, the old file is kept as `config.json.bad`.

**The defaults are the author's boat** (before its 2026 rig tune), fitted by boatcal. They will be wrong for yours: refit, or use **Reset to defaults** and enter your own.

## Limitations

- **Your instrument displays show the instrument's numbers.** The plugin publishes into Signal K only. To see its values on the boat's displays, forward them to NMEA 2000 (for example with `signalk-to-nmea2000`). If you forward STW or true heading, choose your paddlewheel and compass as the STW and heading sources in Settings: a value coming back from the bus would otherwise look like a sensor, and Auto could pick it and correct it again.
- **Damped apparent wind needs damped heading.** If your apparent wind arrives damped by the instrument, damp heading to the same lag, so a yaw does not swing TWD on the Live page.
- **Current is a trend, not a live number.** It is the small difference between two vectors of about boat speed, so 1% of boat speed or 1° of heading makes 0.1 kn of current, and a paddlewheel's error changes from day to day. Read it averaged over both tacks of a beat.
- **Absolute TWS and TWD** (a masthead offset, an AWS scale error) are the same on both tacks, so they cannot be fitted from tacks and gybes: set them in the instrument. The TWS table corrects TWS off the wind *relative to upwind*; it cannot tell whether the upwind reading itself is right.

## Troubleshooting

The plugin's status line (in the admin UI and at the top of the webapp) says what it is doing.

| Status | Meaning |
|---|---|
| Waiting for apparent wind | No `angleApparent` / `speedApparent` yet from the sensor in use (or the chosen source) |
| No apparent wind for N s: nothing published | Apparent wind stopped. Nothing is published, but Signal K keeps the last values, so displays may still show them: the Live page greys them out |
| Waiting for speed through water | No STW in the last 3 s |
| (X sends it: choose it in Settings) | After any missing input: another sensor sends it, and a chosen source is never replaced. Choose X if it is the right one. On Auto you see this only for the 3 s before X takes over |
| … from X: Y stopped sending | Auto has moved that input to sensor X, shown for a minute. Normal about 30 s after a boot on NMEA 2000, when the server renames a device from its address to its CAN name. Otherwise a sensor has failed: X may not be the sensor your tables were fitted to, so check it or choose a source in Settings |
| (only from X, another plugin: …) | After any missing input: only another plugin sends it, which is ignored unless chosen (derived-data's COG true or true heading, another STW corrector). Choose it in Settings, or better, read the sensor it is made from |
| Not publishing — … is not plausible | An input is out of range (a sensor fault); nothing is published from it |
| … light air … | TWS is below 1.5 kn: TWD and ground wind direction are held back until 2 kn; TWA still goes out |
| … no heel / no heading / no SOG/COG | Running without that input: no heel correction or leeway / no TWD, current or ground wind / no current or ground wind. As above, it names anything else sending it |
| Rate limited … | Something is updating faster than 20 Hz, usually a loop with another plugin; the status names its source |
| Configuration: … | The saved configuration is invalid or cannot be read, and the plugin is not running; the message says why, in the admin UI and as "Plugin not running: …" in the webapp. Fix it in the webapp, or restore your backup |
| Upgraded from an earlier release … | A configuration saved by an earlier release. From 0.2.12–0.2.17: every table is kept and works exactly as before, now as a grid (a TWS table whose up and down angles changed with TWS is close between columns, and the notice asks for a refit). From 0.2.7–0.2.11: everything is kept, and the boat speed table has a new 1 kn column set so it works as before; refit it to use it. From earlier: settings are kept, the tables it names are reset to the defaults, and Shadow mode is on; refit them. Save to clear the notice |

## API

Under `/plugins/signalk-performance-processor`:

- `GET /calibration`: the configuration in use, the defaults, and the built-in limits.
- `PUT /calibration`: validate, save and restart with a new configuration; 400 with the reasons if it is invalid. A body with `schema` is a whole configuration; without it, the changes are laid over the configuration in use. If the plugin is disabled it is saved for when it is enabled, and nothing starts.
- `GET /live`: the latest result, each step, input ages, the sources seen, `sent` (the outputs sent in the last 3 s), and `error`: why the plugin is not running, if it is not.
- `PUT /learn/scan` `{since, until}` and `GET /learn/status`: **in progress**, learning the tables on the boat from Signal K history (SPECIFICATION.md §11). They scan days into files; nothing is fitted or applied yet.

## Development

```bash
npm test          # node --test
cd ~/.signalk && npm install /path/to/signalk-performance-processor && sudo systemctl restart signalk
```

`lib/processor.js` is the calculation, free of Signal K so it can be tested and replayed (boatcal runs it directly, through its exports and `_internals`, and `public/tables.js`: check boatcal's `boatcal/pipeline.js` before changing them). Each correction is an entry in its `CORRECTIONS`, with its defaults in `lib/defaults.js` and its editor in `public/app.js`. `public/tables.js` is the table layout and text format, shared by the plugin, the webapp and boatcal. `lib/damping.js` is the damping; `index.js` the Signal K side.

Every equation, interpolation, fade, limit and damping rule, and how boatcal fits the tables: [SPECIFICATION.md](SPECIFICATION.md), the master record of the maths. Change it with the code.

What changed in each release: [CHANGELOG.md](CHANGELOG.md).

## Licence

MIT
