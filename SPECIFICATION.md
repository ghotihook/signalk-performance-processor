# Specification: the maths

The master record of every equation, interpolation, fade, limit and damping rule in
signalk-performance-processor, and of how boatcal fits the tables. The code is
the implementation; this document is what it must do. **Change one, change the other**, in
the same commit, and note the change in [CHANGELOG.md](CHANGELOG.md).

Written for 0.3.2 (config schema 7) and boatcal after 1.4.0 (fine grids, §9).

| Section | Code |
|---|---|
| 1 Conventions | everywhere |
| 2 Inputs | `index.js` (`onDelta`, `chooseSensor`, `windPairComplete`, `fresh`) |
| 3 Heading, variation, COG, heel | `index.js` (`trueHeading`, `variationDeg`, `cogTrue`, `rollDeg`), `lib/processor.js` (`process`) |
| 4 Table lookups | `public/tables.js` (`interp`, `fromZero`, `bracket`, `lookup`, `fillGaps`, `checkAxis`) |
| 5 The pipeline | `lib/processor.js` (`CORRECTIONS`, `process`) |
| 6 Damping | `lib/damping.js`, `index.js` (`onWind`, `onHeading`, `onStw`, `onDelta`) |
| 7 Publishing | `index.js` (`onWind`, `onHeading`, `onStw`, `publish`, `OUTPUTS`) |
| 8 Configuration | `lib/processor.js` (`normalizeConfig`, `salvage`, `upgrade`, `toGrids`, `addSlowColumn`, `checkTable`, `twaTooSteep`), `public/tables.js` (`twaFromRows`, `twsFromRows`), `lib/defaults.js` |
| 9 Calibration fits | boatcal `boatcal/fit.py`, `boatcal/events.py`, `boatcal/decompose.py`, `boatcal/settings.py`; for a user's own data, [AGENTS.md](AGENTS.md) "Calibrating a boat" |
| 10 Constants | all of the above |
| 11 Learning (in progress) | `lib/history.js`, `lib/learn.js`, `index.js` (`runLearn`, `startLearn`) |
| 12 Analysis (beta) | `lib/analysis.js`, `index.js` (`analyseOnce`, `startAnalysis`) |

---

## 1 Conventions

- **Units inside the pipeline:** degrees and knots. Signal K is SI: radians and m/s.
  `1 m/s = 1.94384 kn`.
- **Angles relative to the bow** (AWA, TWA, ground wind angle, leeway) are signed:
  **+ = starboard**, in (−180°, 180°].
- **Directions** (heading, COG, TWD, ground wind direction, current set) are true, in
  [0°, 360°). TWD and ground wind direction are where the wind **comes from**; current set
  is where the water **goes to**.
- **Heel** = Signal K `navigation.attitude.roll` in degrees, **+ = starboard side down**.
- **Leeway** + = sliding to starboard.
- `wrap180(d) = ((d + 180) mod 360 + 360) mod 360 − 180`
- `norm360(d) = (d mod 360 + 360) mod 360`
- `clamp(x, lo, hi) = max(lo, min(hi, x))`

---

## 2 Inputs

### 2.1 Paths and groups

Inputs are chosen in groups. One source is used per group.

| Group | Paths |
|---|---|
| apparentWind | `environment.wind.angleApparent`, `environment.wind.speedApparent` |
| stw | `navigation.speedThroughWater` |
| heading | `navigation.headingMagnetic`, `navigation.headingTrue` |
| attitude | `navigation.attitude` |
| gps | `navigation.speedOverGround`, `navigation.courseOverGroundTrue`, `navigation.courseOverGroundMagnetic` |
| variation | `navigation.magneticVariation` |

The plugin subscribes with `sourcePolicy: 'all'` and chooses itself. Its own output
(`$source` = the plugin id, or the id followed by `.`) is always ignored. A value that is null,
or not finite (any path except attitude), is ignored.

### 2.2 Choosing the source

- A source is a **sensor** when its update carries a `source` object (a data connection);
  otherwise it is **another plugin's output**.
- **Chosen in Settings:** only that source is read, sensor or plugin.
- **Auto** (none chosen): sensors only, never another plugin.
  1. The first sensor seen is used, and the clock starts.
  2. On the first sensor message at least `LOCK_WINDOW = 2 s` later, the sensor with the
     most messages in the last `RATE_WINDOW = 10 s` is chosen (a tie keeps the one seen first).
  3. That choice holds while the sensor sends. If it changed, the input's damping restarts
     (heel, for attitude; heading is not damped).
  4. If the sensor in use has been silent for the input's freshness limit (2.3) when another
     sensor's message arrives, the sensor with the most messages in `RATE_WINDOW`, of those
     heard within that limit, is chosen at once. Damping restarts as in 3, the server log
     gets a line, and the status names the new sensor for `SWITCH_NOTE = 60 s`. This is also
     how an NMEA 2000 device is followed when the server renames it (`n2k-tcp.100` to
     `n2k-tcp.<canName>`) on learning its CAN name. A chosen source is never replaced.
- **Message counting:** a message counts once even when it arrives as several deltas: a
  repeat of the same timestamp from the same source is not counted again.
- **Rate** (Settings, Live page): `(n − 1) / (t_last − t_first)` over the last 10 s, to 0.1 Hz
  (shown whole from 2 Hz); 0 for a source that has stopped. Outputs' send rates likewise.

### 2.3 Freshness

An input is used only if it arrived within `STALE = 3 s`; variation within 10 minutes.
Every age and every damping step is measured on a clock that never goes back: a time fix
that sets the system clock back continues from where it was.

### 2.4 Apparent wind pairing

AWA and AWS come in one sensor message but reach the plugin as two deltas. True wind is
worked out when both halves of a message (the same timestamp) have arrived, so a new AWA is
never paired with the last message's AWS. If timestamps are missing, or a source's halves
never share a timestamp, it is worked out on every value.

AWA is normalised: `AWA = wrap180(awa_rad × 180/π)`.

### 2.5 Plausibility

| Input | Not used when |
|---|---|
| AWS | < 0 or > 120 kn: nothing published, status says why |
| STW | < 0 or > 60 kn: nothing published, status says why; corrected STW not republished |
| Heel | not finite, or abs > 90° → treated as missing |
| SOG | < 0 or > 60 kn → treated as missing |
| AWA, heading, COG | abs > 2π (degrees on a radian path) → treated as missing |
| Variation | abs > π → treated as missing |
| True wind | not finite: nothing from the wind calculation published, status says why |

Nothing that is not a finite number is ever published.

---

## 3 Heading, variation, COG, heel

### 3.1 Variation

```
var = magneticVariation (deg), if fresh within 10 min
    = config.variation (fallback, default 12.8° E), otherwise
```

### 3.2 True heading H

```
H = H_true                  if the heading source sends navigation.headingTrue (fresh)
  = norm360(H_mag + var)    otherwise
```

`H_true` and `H_mag` are the latest values, never damped (§6.2).

### 3.3 COG (true)

```
COG = COG_true                      if fresh
    = norm360(COG_mag + var)        otherwise (GPSs that send COG referenced to magnetic)
```

### 3.4 Heel

`heel = roll × 180/π`, plausible only if abs(heel) ≤ 90°. Damped on every attitude message
(§6). Missing heel: the STW table is looked up at heel 0, and leeway is 0.

---

## 4 Table lookups (shared by the plugin, the webapp and boatcal)

### 4.1 Linear interpolation, ends held

```
interp(xs, ys, x) = ys[0]                      if x ≤ xs[0]
                  = ys[n]                      if x ≥ xs[n]
                  = ys[i] + (ys[i+1] − ys[i]) · (x − xs[i]) / (xs[i+1] − xs[i])   otherwise
```

### 4.2 Along a row by speed, from zero

```
fromZero(xs, ys, x) = 0                        if x ≤ 0
                    = ys[0] · x / xs[0]        if 0 < x < xs[0]
                    = interp(xs, ys, x)        otherwise
```

So nothing is added at 0 kn, the first column is reached in a straight line, and the last
column is held beyond it.

### 4.3 A table: rows, then speed

Every table is a grid with its own axes: rows `R` (heel, or |TWA|), columns `C` (a speed),
cells `add[i][j]`. Each axis has at least one entry and goes up strictly; columns start
above 0 kn (§8.1).

```
bracket(R, r)      = [0, 0, 0]                       if r ≤ R[0]
                   = [n, n, 0]                       if r ≥ R[n]
                   = [i, i+1, (r − R[i])/(R[i+1] − R[i])]   with R[i] < r ≤ R[i+1]
F                  = fillGaps(add)
[i, j, f]          = bracket(R, r)
lookup(r, s)       = fromZero(C, F[i], s)·(1 − f) + fromZero(C, F[j], s)·f
```

Along each row by speed from zero (§4.2), then linear between the rows either side, the end
rows held beyond them. Linear in the cells, and continuous everywhere.

### 4.3a Blending three rows by |TWA| (schema 6 only)

Used only to read a schema 6 TWS table (§8.2):

```
blendRows(a, A1, A2, A3, r1, r2, r3) = r1                                   if a ≤ A1
                                     = r1 + (r2 − r1)(a − A1)/(A2 − A1)     if a ≤ A2
                                     = r2 + (r3 − r2)(a − A2)/(A3 − A2)     if a ≤ A3
                                     = r3                                   otherwise
```

### 4.4 Blank cells (`null`, "not measured")

`fillGaps(grid)`:
1. Along each row, a blank takes the value to its left (forward pass), then any blanks still
   at the start take the value to their right (backward pass).
2. A row with no values takes a copy of the nearest row with data: distance 1 first,
   the row before preferred to the row after; then distance 2, and so on.
3. Anything still blank (a table with no values at all) is 0.

---

## 5 The pipeline

Order: STW table → leeway → true wind → TWA table → TWS table → TWD → current → ground wind.
Each step works on the result of the one before. A switched-off correction passes its input
through unchanged.

### 5.1 Boat speed (STW) table

Rows by **heel** (°, + = starboard side down), columns by **STW** (kn), any axes (§8.1).
Default: heel −30 to 30 by 5°, STW 1 to 15 by 1 kn. A column at 1 kn catches the paddlewheel's
stall, which the H5000's first column, 2.5 kn, misses.

```
add(h, v) = lookup(heel table, h, v)          (§4.3; heel missing → 0)
STW_c     = max(0, STW + add(h, STW))
```

More heel than the end rows uses the end row. Below the first column the correction runs
straight from 0 at 0 kn: a stopped boat is never given speed.

### 5.2 Leeway

```
fade = clamp((STW_c − 1.5) / (3 − 1.5), 0, 1)
λ    = 0                                              if fade = 0, or heel missing
     = fade · clamp(K · heel / STW_c², −15°, +15°)    otherwise
```

Uses the corrected STW. Leeway is **not** used in true wind (the TWA table takes up its
effect, as on the H5000 by default); it is used for current.

### 5.3 True wind, before the tables

Apparent wind less the boat's velocity through the water along the heading:

```
x    = AWS · cos(AWA) − STW_c
y    = AWS · sin(AWA)
TWA0 = atan2(y, x)        (deg, signed)
TWS0 = √(x² + y²)
```

### 5.4 TWA table

Rows by **|TWA|** (°, 0 to 180), columns by **TWS** (kn), any axes (§8.1). Default: TWA 30 to
180 by 10°, TWS 4 to 30 by 2 kn. Degrees added to |TWA|; negative = TWA read too wide.

```
a       = |TWA0|
table   = lookup(TWA table, a, TWS0)                            (§4.3)
taper   = clamp(min(a / 30, (180 − a) / 10), 0, 1)
TWA1    = sign(TWA0) · clamp(a + table · taper, 0, 180)        (sign(0) taken as +)
```

The taper fades the correction to none at 0° and 180°: in full from 30° to 170°, so TWA
and TWD pass through tacks and gybes without a flat spot or a jump.

**Constraint (checked on load and save):** at every TWS, `0 < d(TWA1)/d(TWA0) < 2`: corrected
TWA always moves the same way as TWA, and at most twice as fast. With `g(a) = a + taper(a)·table(a)`,

```
g'(a) = 1 + taper'(a)·table(a) + taper(a)·table'(a)
```

Between the knots {0, 30, 170, 180, every row inside (0, 180)}, both `taper` and `table` are
straight lines, so `g'` is a straight line too: it is checked at both ends of each piece,
which bounds it throughout. Between TWS columns the table is a weighted mix of the two columns
either side (below the first column, of that column and zero), so `g'` is the same mix and
checking each column is enough. Blanks are checked as what they take (§4.4). For rows at 40°
and 165° this is exactly the H5000-style limit: upwind row within ±30°, downwind row within ±10°.

### 5.5 TWS table

Laid out like the TWA table: rows by **|TWA|**, columns by **TWS**, any axes; same default.
Knots added to TWS.

```
a     = |TWA1|                               (the TWA after its table)
add   = lookup(TWS table, a, TWS0)           (§4.3)
TWS1  = max(0, TWS0 + add)
```

### 5.6 TWD

Only with a heading:

```
TWD = norm360(H + TWA1)
```

### 5.7 Current

Only with heading, SOG and COG. Ground velocity less water velocity, the water velocity
along the heading turned by leeway:

```
e = SOG · sin(COG) − STW_c · sin(H + λ)
n = SOG · cos(COG) − STW_c · cos(H + λ)
drift = √(e² + n²)
set   = norm360(atan2(e, n))          (where the water goes)
```

### 5.8 Ground wind

The wind over the ground: true wind (over the water) plus the current carrying that water.
Built on TWS1 and TWD, so the tables apply to it.

```
to  = TWD + 180                        (where the air goes)
g_e = TWS1 · sin(to) + e
g_n = TWS1 · cos(to) + n
GWS = √(g_e² + g_n²)
GWD = norm360(atan2(g_e, g_n) + 180)   (where it comes from)
GWA = wrap180(GWD − H)
```

---

## 6 Damping

### 6.1 The filter

First-order exponential smoothing over the real time between samples, as the H5000's
damping: τ in seconds, 0 = none.

```
α = 1 − e^(−Δt/τ)                      Δt = time since the last sample (s)
y ← y + α · (x − y)
```

- Independent of the update rate: n samples of Δt compound to exactly one of nΔt, so τ
  reaches `1 − e⁻¹ ≈ 63%` of a step after τ seconds at any rate.
- On a steady ramp the output lags by τ seconds.
- White noise on each sample is reduced to about `√(Δt / 2τ)` of its size.
- First sample, τ = 0, or a gap longer than both **10 s** and τ: the new value is taken as
  it is. (A shorter gap keeps a long average, such as current's, through a dropout.)
- A repeat of the same time: no change.
- **Directions** (`SmoothAngle`): smoothed on the unit circle, sin and cos separately, so 359°
  and 1° average to 0°.
- **Vectors** (`SmoothVector`, current): the east and north components smoothed separately.

### 6.2 What is damped, and when

| Quantity | τ (setting, default) | Updated on |
|---|---|---|
| Heel | `heelS`, 2 s | each attitude message (plausible) |
| Published STW | `stwS`, 1 s | each STW message |
| TWD, TWS | `trueWindS`, 3 s | each apparent wind message |
| Published TWA and ground wind angle, with a heading (§6.3) | `twaS`, 1 s | each heading message |
| TWA, only when there is no heading | `trueWindS` | each apparent wind message |
| Ground wind direction and speed | `trueWindS` | each apparent wind message |
| Current (as a vector) | `currentS`, 120 s | each apparent wind message |

Limits (load and save): heel, true wind, TWA and STW 0–30 s; current 0–300 s.

**Heading is never damped**, and is not a setting. It must have the same lag as apparent
wind, or every yaw swings TWD, and apparent wind must arrive raw (README). A saved
`damping.headingS` (before 0.3.2) is dropped on load, with a notice if it was above 0.

### 6.3 Published TWA and ground wind angle

The damped TWD less the heading **now**, then damped for reading, on each heading message
only (not with apparent wind):

```
TWA_pub = wrap180(D_twaS(TWD_d − H))
GWA_pub = wrap180(D_twaS(GWD_d − H))
```

`D_twaS` is §6.1 on the unit circle, τ = `twaS` (default 1 s; 0 = every yaw as it happens).
TWD itself uses the undamped heading (§3.2), so a yaw still cancels in it. TWD_d and GWD_d
come from the last wind result, if under 3 s old and with a heading. In a delta with both,
wind is worked out first. The status and the Live page show the TWA last published.

**Without a heading** there is no TWD: `TWA_pub` is the damped TWA, sent with each apparent
wind message, and there is no ground wind angle.

---

## 7 Publishing

### 7.1 Triggers

| Output | Sent on |
|---|---|
| STW (STW table on) | each STW message: `STW_c` from the raw STW and the damped heel, then damped |
| True heading | each heading message, as `H`, unless the heading sensor sends true heading itself |
| TWA, ground wind angle | each heading message (§6.3); TWA with each apparent wind message only when there is no heading |
| TWS, TWD, leeway (on), current, ground wind speed and direction | each apparent wind message |

Shadow mode publishes on each standard path with `Corrected` appended; Replace mode on the
standard paths. Ground wind direction (`environment.wind.directionGround`) is not in the
Signal K schema and is sent with `meta`.

### 7.2 Light air

Hysteresis on the damped TWS:

```
lightAir = TWS_d < 2.0 kn     if lightAir was already on
         = TWS_d < 1.5 kn     otherwise
```

In light air **TWD is not sent**. Ground wind direction and angle follow the same rule on the
damped ground wind speed. **TWA, TWS and ground wind speed always are**: TWA is what the crew
sails by.

### 7.3 Rate limit

An update driven by another plugin's output (read only when chosen, §2.2) is sent at most
every 20 ms per output (50 Hz); faster ones are dropped, and the status flags a feedback loop
from 5 drops in 10 s. Updates driven by a sensor are never limited.

### 7.4 Stopped wind

When apparent wind is not fresh, nothing from the wind calculation (§5) is published; true
heading and STW still go out with their own sensors. The status says
"No apparent wind for N s", checked on every other input and once a second.

### 7.5 Raw STW

Every plausible STW from the sensor in use (§2.2, §2.5) also goes out unchanged, undamped and
without the STW table, on `navigation.speedThroughWaterRaw` (sent with `meta`), in the same
delta as corrected STW, in both modes and with the STW table off. It is the sensor's value, not
an output: in Replace mode a source priority on `navigation.speedThroughWater` puts this
plugin first, so instruments see only corrected STW. The server drops the losing sources before
anything downstream sees them, history providers included, so without this path raw STW never
reaches history (§11.2). Paths with no priority are recorded from every source. The plugin reads it back only for learning, never live.

---

## 8 Configuration

### 8.1 Schema 7 layout

Saved in `config.json` with `"schema": 7`. Each table carries its axes:

```
stw: { enabled, heel: [...], stw: [...], add: [[...], ...] }     add[heel row][speed column]
twa: { enabled, twa:  [...], tws: [...], add: [[...], ...] }     add[TWA row][TWS column]
tws: { enabled, twa:  [...], tws: [...], add: [[...], ...] }
```

| Axis | Range | |
|---|---|---|
| `heel` | −90 to 90° | |
| `stw` | above 0, to 60 kn | from zero below the first (§4.2) |
| `twa` | 0 to 180° | |
| `tws` | above 0, to 120 kn | from zero below the first |

Each axis has 1 to 100 entries, all numbers, going up strictly. Blank cells are `null` (§4.4).
Validation refuses: an axis outside that, a table with fields other than `enabled`, its two
axes and `add`, the wrong number of rows or of values in a row, a non-number, an STW table with
no values, a cell beyond ±5 kn (STW), ±30° (TWA) or ±10 kn (TWS), leeway K outside 0–30,
the TWA constraint of §5.4, damping outside its limits, variation outside ±180°, a
section that is not an object, a source that is not a name.

The text format (`public/tables.js` `format`, `parse`): a header row `heel\stw` or `TWA\TWS`
then the columns; then one row per table row, its heel or TWA first. Rows may come in any
order and are sorted; two rows at the same value are refused.

### 8.2 Upgrading a schema 6 file (0.2.12 to 0.2.17)

Schema 6 was the H5000's 2018 layout: STW table heel −20 to 20 by 10 × 1, 2.5 … 15 kn; TWA
table rows `upwind`, `reach`, `downwind` by TWS 5 … 30, blended by `blendRows(a, 40, 90, 165, …)`;
TWS table the same rows blended by `blendRows(a, upAngle(TWS), 90, downAngle(TWS), …)`, with
an up and a down angle per column. Each becomes the grid that looks up the same:

- **STW:** unchanged (its axes are now its own).
- **TWA:** `twa = [40, 90, 165]`, `add = [upwind, reach, downwind]`. Exact: `blendRows` with
  the end rows held is `lookup` along those rows.
- **TWS**, when every up angle is the same and every down angle is the same: `twa = [up, 90,
  down]`, `add = [upwind, reach, downwind]`. Exact.
- **TWS**, when the angles change with TWS: `twa` = every up angle, 90 and every down angle,
  sorted, each cell the schema 6 value at that TWA and column (from the filled rows, rounded
  to 0.001 kn). The same at each column, and close between them. The status asks for a refit.
- A schema 6 TWS table that cannot be read that way (rows of different lengths, angles that
  are not 0 ≤ up < 90 < down ≤ 180) is reset to the defaults, and the status says so.

Blanks are kept as blanks, except in the last case. Nothing changes the mode. A schema 6 TWS
table pasted as text (rows `upwind`, `reach`, `downwind`, `up angle`, `down angle`) and TWA rows
named `upwind`, `reach`, `downwind` (40°, 90°, 165°) are read the same way.

### 8.2a Upgrading a schema 5 file (0.2.7 to 0.2.11)

Schema 5's STW table had columns 2.5 … 15 kn. It gains a 1 kn column that leaves every
lookup unchanged:

```
filled  = fillGaps(add)
row'    = [ round(filled[i][0] · 1/2.5, 0.001), filled[i][0], row[1..] ]   (a row with data)
        = [ null ] + row                                                   (an all-blank row)
```

A straight line from 0 through the 2.5 kn value passes 1 kn at 0.4 of that value, so the
new cell lies on the line the table already used. The first cell is filled explicitly
because a blank there would now take the new 1 kn cell's value instead. It then upgrades as
schema 6.

Older schemas (3: 0.1.0–0.2.5; 4: 0.2.6) keep their settings and leeway K; their tables are
reset to the defaults (schema 4 keeps its STW and TWS tables, which then upgrade as schema 6),
and the mode goes to Shadow.

### 8.3 Loading and saving

A saved file that cannot be read (not JSON, or not a JSON object) is not the defaults: the
plugin does not run, and says why. Nor does it run on a file that fails its checks (§8.1).
For the webapp, such a file is taken apart (`lib/processor.js` `salvage`): the mode, the
fallback variation, the sources, the damping and each table are checked on their own and
kept if they pass; the rest come from the defaults. `GET /calibration` shows that, with
`problem: { errors, reset }` naming what failed and what was reset, so a Save fixes the
boat's own values instead of replacing them. Saving over a file that cannot be read or fails
its checks first copies it to `config.json.bad`.

`PUT /calibration`: a body with `schema` is a whole configuration, laid over the defaults; a
body without it is laid over the configuration in use. Objects merge, arrays replace. A body
that is not a JSON object is refused. While the plugin is disabled in the server, a save is
kept but nothing starts.

---

## 9 Calibration fits (boatcal)

A summary. **boatcal's SPECIFICATION.md is the master of the method** and of every threshold,
smoothing weight and support rule; it is not repeated here, so the two cannot drift. An agent
fitting a user's tables follows [AGENTS.md](AGENTS.md) "Calibrating a boat", which uses the same
method on the user's data.

Each item is fitted on the output of the ones before, in the order the plugin applies them,
through the plugin's own arithmetic (boatcal's `boatcal/pipeline.js` calls `lib/processor.js`
and `public/tables.js`). The table lookups (§4.3) are linear in the cell values, so each fit is
a least-squares problem in the cells, with the plugin's lookup as the design matrix (probed one
cell at a time). Neighbouring cells are tied together; a cell with too little data is left blank
(§4.4). "Held out" scores each day with a fit made without it.

1. **STW table and leeway K, from the GPS.** Current fitted per 20-minute window where headings
   vary; ground − current − STW in the boat's frame gives the paddlewheel's forward error, fitted
   by the table, and the sideways slip upwind, fitted by K (§5.2).
2. **TWA table, from manoeuvres.** TWD should not step across a tack (TWA crosses 0°), gybe
   (180°) or mark rounding (|TWA| crosses 90°). On true wind with the new STW table and no wind
   tables, the cells are fitted (Huber) so that the TWD steps vanish, held to §5.4's limit.
3. **TWS table, from off-wind legs.** TWS should not change when the boat bears away: each
   reaching or downwind leg is compared with the upwind legs either side, band by band of |TWA|,
   on TWA corrected by the new TWA table. Rows under 80° are the upwind reference and stay 0.

---

## 10 Constants

| Constant | Value | Where |
|---|---|---|
| Stale input | 3 s | `index.js` `STALE_MS` |
| Variation max age | 10 min | `index.js` `VARIATION_MAX_AGE_MS` |
| Auto lock window | 2 s | `index.js` `LOCK_WINDOW_MS` |
| Status note after Auto changes sensor | 60 s | `index.js` `SWITCH_NOTE_MS` |
| Rate window (Auto, Settings) | 10 s | `index.js` `RATE_WINDOW_MS` |
| Max plausible AWS / STW / SOG / heel | 120 kn / 60 kn / 60 kn / 90° | `index.js` |
| Table cell limits, K range | ±5 kn, ±30°, ±10 kn; 0–30 | `lib/processor.js` `TABLES`, `MAX_LEEWAY_K` |
| Loop guard (another plugin's output only) | 20 ms (50 Hz) | `index.js` `MIN_PUBLISH_INTERVAL_MS` |
| Loop flag | 5 drops in 10 s | `index.js` `RATE_FLAG_MIN`, `RATE_NOTE_MS` |
| Light air off / on | 1.5 / 2.0 kn | `index.js` `LIGHT_AIR_OFF_KN`, `LIGHT_AIR_ON_KN` |
| Status refresh | 1 s | `index.js` `STATUS_INTERVAL_MS` |
| Damping reset gap | 10 s, or τ if longer | `lib/damping.js` `RESET_S` |
| Leeway cap | 15° | `lib/processor.js` `MAX_LEEWAY_DEG` |
| Leeway fade | 1.5 → 3 kn | `lib/processor.js` `LEEWAY_FADE_KN` |
| TWA taper | 30° off the wind, 10° short of dead downwind | `lib/processor.js` `TWA_TAPER_UP_DEG`, `TWA_TAPER_DOWN_DEG` |
| TWA slope limit | 0 < slope < 2 | `lib/processor.js` `TWA_SLOPE_MAX` |
| Schema 6 TWS reach angle | 90° | `public/tables.js` `REACH_DEG` |
| Table axes | §8.1 | `public/tables.js` `AXIS_RANGE`, `MAX_AXIS` |
| Default table axes | §5.1, §5.4 | `lib/defaults.js` |
| Fallback variation | 12.8° E | `lib/defaults.js` |
| Config schema | 7 | `lib/processor.js` `CONFIG_SCHEMA` |

---

## 11 Learning (in progress)

The plugin reads the boat's sailing from the Signal K v2 History API, reduces it to what
boatcal's fits need, and fits the tables on request. Built so far: reading history
(`lib/history.js`), classes, events, legs and day files (`lib/learn.js`), and the scan
(`index.js`, `PUT /learn/scan`, `GET /learn/status`). Not yet: the fits, the Learn page. Definitions follow boatcal's specification (sections 5, 7 and 8 there) so the two give
the same tables from the same data.

### 11.1 Rules

- **Raw inputs only.** Every path is read from the sensor in use (§2), named in the request
  (`path|sourceRef`), never unfiltered: the plugin publishes corrected STW and true heading on
  the same paths as the raw inputs. STW is read from `navigation.speedThroughWaterRaw` (§7.5).
  Nothing has a table applied. Classes come from the raw true wind (11.3), so a saved table
  cannot change how the data is classed.
- **Scan, then fit on request.** A scan reads the chosen local days and writes day files; a
  fit runs only from the Learn page, over the days of one setup, and a table changes only on
  **Save** (§8.3).
- `lib/history.js` and `lib/learn.js` stay free of Signal K, like `lib/processor.js`; the
  History API is called in-process (`app.getHistoryApi()`) from `index.js`. (Over REST the
  server strips `-` from a sourceRef, as of 2.36, so `|n2k-tcp.0` matches nothing there.)

### 11.2 Reading history: the 1 Hz row

A scan takes one local day at a time (the server's time zone).

1. **Where the sailing is:** STW's highest value per minute (`max`, 60 s), from
   `navigation.speedThroughWaterRaw` of this plugin, or, where a day has none (history from
   before §7.5, or recorded in Shadow mode), from `navigation.speedThroughWater` of the STW
   sensor in use. Minutes over 0.5 kn are sailing; each is padded by 4 minutes either side
   (the buffer's context, 11.4), and touching spans are joined.
2. **The sailing, at 1 s** with `first` (one sample, never an average across 0/360 or ±180),
   in requests of at most an hour: AWA and AWS (`environment.wind.angleApparent`,
   `speedApparent`), STW (as in 1), heel (`navigation.attitude.roll`: providers store the
   attitude object's members as paths), heading (`navigation.headingTrue`, else
   `headingMagnetic` + variation), SOG, COG (`courseOverGroundTrue`, else magnetic +
   variation), variation (else `config.variation`).
3. **Carry forward:** a provider may record only changes (signalk-questdb), so an empty second
   takes the input's last value from up to 3 s before (`STALE`, §2.3); after that it is missing.

Required: a sensor in use for apparent wind, STW, heading and heel (a good second needs heel,
11.5). GPS and variation are optional. Without a history provider, or without those sensors,
the scan stops and says why.

### 11.3 Raw true wind

§5.3 with the STW table off (`STW_c = STW`): `TWA_r`, `TWS_r`, `TWD_r = norm360(H + TWA_r)`.
Used for classes and events only. Fits recompute true wind from the recorded inputs with the
tables being fitted.

### 11.4 Cadence

Every 60 s, on a buffer of the last `LEARN_BUFFER` = 7 minutes of 1 Hz rows, the **middle
minute** is classed. The 3 minutes either side are context: a rounding needs 135 s after its
crossing plus the 5 s isolation check. Each second and each event is classed once, by the
run whose middle minute holds it (an event by its crossing). Records lag the boat by about
3.5 minutes.

### 11.5 Classes and events

A second is **good** when AWA, AWS, STW, heading and heel are present and STW > 1 kn; other
seconds are gaps. Per good second of the middle minute, on `|TWA_r|` as a trailing 30 s
median over good seconds:

| Class | Rule |
|---|---|
| `sailUp` | median < 70° |
| `sailReach` | 80° to 120° |
| `sailDown` | > 120° |
| `other` | 70° to 80°, between upwind and off the wind; and every second that is not good |

Events, on `TWA_r` of good seconds smoothed over 15 s (sine and cosine, centred, at least 8
seconds), at a sign change between consecutive seconds; a crossing under 10 s after the last
one of the same kind is the same crossing:

| Event | Crossing | Windows (s from the crossing) |
|---|---|---|
| `mnvTack` | TWA crosses 0° | (−50, −20), (30, 60) |
| `mnvGybe` | TWA crosses 180° | (−50, −20), (30, 60) |
| `mnvComeDown` | \|TWA\| crosses 90°: < 80° before, > 100° after | (−120, −30), (45, 135) |
| `mnvComeUp` | \|TWA\| crosses 90°: > 100° before, < 80° after | (−120, −30), (45, 135) |

An event counts only if good data goes on past its after window, no other crossing is
within its windows (± 5 s), each window has good
data for at least half its seconds and a mean STW of 2.5 kn or more, and an upwind window has
a mean |heel| of 4° or more (not motoring). A tack must have mean |TWA_r| under 90° in both
windows with the sign changed, a gybe over 90° in both with the sign changed, and a rounding
under 80° on one side and over 100° on the other.

**Legs** are joined across minutes, as boatcal's TWS legs: pieces of `sailUp`, or of
`sailReach` and `sailDown` together (off the wind), split at gaps over 10 s; an `other` piece
between two pieces of the same kind no more than 90 s apart takes their kind; a leg ends at a
change of kind or a gap over 90 s, and is kept with 180 good seconds or more. A leg is
written when it closes.

**K uses inferred `sailUp` legs.** The plugin cannot see documented legs. boatcal tested this
(its section 11): on 2025 to March 2026, inferred upwind legs gave K 8.36 against 8.44 from
documented legs, with no difference held out.

### 11.6 Day files

One file per local day scanned, `learn/YYYY-MM-DD.jsonl` in the plugin's data directory, one
record per line, rewritten when the day is scanned again (deleted when it has no sailing). The
history stays the source; the day files only save reading it again:

| Record | Holds | Used by |
|---|---|---|
| `s5` | 5 s medians of the 1 Hz rows (angles through their sine and cosine): AWA, AWS, STW, heel, H, SOG, COG, variation; the class; good seconds | STW table, current, K, TWS legs |
| `mnv` | the event, its crossing time, and the 1 Hz rows of its two windows | TWA table |
| `leg` | class, start and end | TWS table, K |
| `setup` | (planned, with the Learn page) a **New setup**, with its time | which days a fit uses |

About 15 MB for 44 race days (2025 to March 2026) as JSON lines. Days before the current setup can be deleted from
the Learn page.

### 11.7 Fit

The fits of §9, on the records of the setup's days, in pipeline order, held out by day.
Nothing is applied until **Save**.

### 11.8 Before it ships

The module is replayed on boatcal's logged history through boatcal's `pipeline.js`, both
setups (2025 to March 2026; since October 2026), and must match boatcal: the same tacks,
gybes and roundings, centred within a few seconds; legs against the documented ones; and the
tables fitted from day files equal to boatcal's within a stated tolerance: every cell within
half its 95% range in boatcal, and the same cells blank.

Shown so far (2026-11-07): the manoeuvres and legs match boatcal exactly on both setups
(251 and 25 manoeuvres, 189 and 20 legs). The TWS table, boatcal's fit on the 5 s records held
for their 5 seconds against its fit on the 1 Hz rows, with boatcal's STW, K and TWA tables:

| Setup | Cells, \|5 s − 1 Hz\| | Largest share of a cell's 95% half-range | Held-out RMS, 1 Hz / 5 s |
|---|---|---|---|
| 2025 to March 2026 (66 / 68 legs) | mean 0.19 kn, max 0.70 kn (downwind, 5 kn) | 0.39 | 1.75 / 1.77 kn |
| Since October 2026 (9 legs) | mean 0.04 kn, max 0.13 kn | under 0.1 | 1.96 / 2.10 kn |

So the 5 s records are enough for the TWS table: the differences are well inside each cell's
uncertainty, and no cell changes from fitted to blank.

Against a live server (sk.local, Signal K 2.36, signalk-questdb 2.4, a looping log replay):
2 hours read in 4 s, every second with AWA, AWS, STW, heel and heading after the carry
forward, and tacks, gybes, a rounding and six legs found. The same check showed why §7.5 is
needed: questdb holds two or three sources for paths with no priority (apparent and true
wind, attitude), but `navigation.speedThroughWater` only from this plugin (corrected). The
server's priority group for STW lists this plugin, derived-data and NMEA 0183 talkers; the
paddlewheel (NMEA 2000, PGN 128259) is not listed, so it never wins and is never recorded.

| Constant | Value |
|---|---|
| `LEARN_BUFFER` | 7 min, classed every 60 s, middle minute |
| Class thresholds | 70°, 80°, 120° on a trailing 30 s median of \|TWA_r\| |
| Event smoothing, merge | 15 s, 10 s |
| Leg rules | 10 s split, 90 s join, 3 min minimum |
| `s5` bucket | 5 s |
| History: probe, padding, request, aggregate, carry forward | 60 s `max`, 4 min, ≤ 1 h at 1 s, `first`, 3 s |

---

## 12 Analysis (beta)

boatcal's calibration (§9) on the boat's own sailing as it is recorded. Every few minutes the
plugin reads the chunk of history since the last, as §11.2, takes out what boatcal fits from
(**findings**: 5-second samples and manoeuvres, raw), adds them to what it has, and fits the
tables again from all of it, in the pipeline's order, each cell with its histogram. Nothing
here changes a table.

**Raw only.** A finding holds STW (raw, §7.5), AWA, AWS, heading, heel, SOG and COG, and true
wind worked out from them with no tables (§11.3). Classes and compliance are on raw values.
The tables in use are never applied, so they cannot change what is learned: a fit from the
same findings is the same whatever tables are in use.

### 12.1 Chunks

Every 5 minutes (the first a minute after start), one **chunk**: from where the last ended to
`ANALYSIS_LAG` (1 minute, as providers write in batches) and `MARGIN` (3 minutes) ago. It is
read as 1 Hz rows (§11.2) from `CONTEXT` (7 minutes, §11.4's buffer) before it to the margin
after, through `lib/learn.js`, and keeps the 5 s records and manoeuvres timed inside it: the
context gives the first minutes their classes, the margin gives a manoeuvre near the end its
after window (a rounding needs 135 s). Nothing is carried from one chunk to the next but where
it ended (`analysis/state.json`), so a restart carries on from there, and 5-minute chunks find
what one long read would. Legs are found when fitting, from the 5 s records (12.3). The first
chunk ever starts an hour back; after the plugin was off, at most 24 hours back.

**Which sensor.** Each input is read from the source chosen in Settings, else from the
sensor that has sent it most since the plugin started, of those that sent in the last minute
(any, if none has). Never Auto's choice of the moment (§2.2): it moves to another sensor when
one goes quiet for 3 s. **An NMEA 2000 device has two names in history**: the server records it
by its address (`n2k-tcp.100`) until it learns its CAN name, then by that
(`n2k-tcp.c079be00ffd20dcb`), so after each restart the first minutes are under the address.
The plugin learns both from the source of each update (`src` and `canName`) and reads the
device under both, each second from its main name where it has a value, else the other: one
device, never two sensors merged. History providers may hold a sparse source's last value
through the empty seconds after it (signalk-questdb, up to twice its heartbeat), which is why a
name must never be read on its own when it is not the device's main one. `GET /analysis/status`
names the sensors of the last chunk.

### 12.2 Findings

Appended to `analysis/YYYY-MM-DD.jsonl` (local day of the finding) in the plugin's data
directory, one JSON object per line, each with `v` (layout, 4) and `t` (epoch s). Findings of
another layout are ignored. They are boatcal's units (its sections 5 to 8), from `lib/learn.js`
(§11.5), all raw:

| Type | What | Holds | For |
|---|---|---|---|
| `s5` | each 5 seconds of sailing (§11.6) | the medians of AWA (through its sine and cosine), AWS, STW, heel, heading, the velocity over the ground (`gN`, `gE`, kn north and east, from SOG and COG), variation; `cls` (§11.5, on the 30 s median of raw \|TWA\|: `sailUp`, `sailReach`, `sailDown`, `other`); `n` seconds, `good` seconds | STW table, K, TWS table |
| `mnv` | each tack, gybe or rounding (§11.5, boatcal's windows) | `kind`, `from` (side before, + starboard); `before` and `after`: the means of the good seconds of each window (AWA, AWS, STW, heel, heading), raw TWA, TWS, TWD; `step` = raw TWD after − before; `twaAdd` (below) | TWA table |

**Compliant** (for now, the inputs only): an `s5` record with 4 or more good seconds of its 5
(§11.5: AWA, AWS, STW, heading and heel all there and STW over 1 kn). A manoeuvre is compliant
by construction (§11.5 keeps only those with good data either side). Motoring,
a fouled paddlewheel and the like are not yet tested. Nothing is filtered for being steady:
as boatcal, the fits use medians, which turns and gusts do not move.

`twaAdd` = `s · step / 2` (12.3), raw: to read one tack by eye. The fit recomputes it.

About 150 kB an hour of sailing: a reduced copy of the data, as the learning scan's day files
(§11.6), so a table of any layout can be fitted later.

### 12.3 Fit

`GET /analysis/summary?since=&until=` (local days) fits the tables from the compliant
findings, in the order of §5, after boatcal (its sections 5 to 8). Each table comes as a
histogram on the axes of the table in use (each value to the nearest row and column): each
cell `{ n, weight, median, p25, p75, table, need }` (weighted median and quartiles; `weight`,
its support; `need`, the support it must reach; `table`, the cell's value now), and
`proposed`, the medians of the cells with enough support, blank (`null`) otherwise. Support
scales with a cell's area, as boatcal's (its section 10): a cell's width along an axis is half
the gap to each neighbour (the gap to its one neighbour at an end), and a cell needs
`support × its area ÷ the reference area`. With it come seconds of sailing by class (all, and
good in compliant records), manoeuvres by kind, legs by kind, and the days. Each table also
carries `progress`: how many cells have data, how many have enough to propose, and what it
is waiting for if it has nothing yet (GPS, upright sailing on two headings, tacks or gybes,
an upwind leg, an off-wind leg near one).

1. **STW table**, from the `s5` samples with SOG and COG, STW and SOG over 0.5 kn and raw
   \|TWA\| over 30° (boatcal 5). In the boat's frame, ground velocity less current, along
   the heading, less raw STW: the paddlewheel's forward error, at raw STW and heel (as it is
   looked up, §5.1). **Current**: per 20 minutes, ground − water velocity (water with the
   forward correction so far), averaged over the **upright** samples (\|heel\| < 5°), 60 or
   more with headings spread (1 − \|mean unit heading\|) ≥ 0.05 and under 4 kn; else the day's;
   else none, and those samples are not used. A mean, trimmed by 10% at each end: a group is
   often just the two gybes' headings, and a median would sit inside whichever has more
   samples, leaving part of the paddlewheel's error in the current. Current and table in turn,
   from no table, unrounded, until no cell moves more than 0.001 kn (at most 500 passes).
   A cell needs 200 samples per 10° × 2.5 kn (boatcal), 40 on the default 5° × 1 kn.

   Upright only, because on a beat a current up the middle of the two headings looks
   exactly like a paddlewheel error plus leeway mirrored on each tack: a beat alone cannot
   tell them apart, whatever the method. On a run both gybes share the upright cells and
   leeway is next to nothing, so the current is found there and used for the beats around
   it. With no upright sailing there is no STW table. boatcal estimates current from all its
   rows with a median, tying neighbouring cells; its heading spread is 0.15 (gybes 40° apart
   are 0.06). What leeway there is on the runs reads as a little current, so K comes out a
   little low (heel 1° on the runs: about 5%).
2. **K**, from the `sailUp` samples with a current, \|heel\| ≥ 4° and corrected STW ≥ 3 kn:
   leeway = atan2(sideways, forward) of ground − current, K = leeway × STW² ÷ heel; the median.
   Proposed only from 5 or more days of upwind (boatcal 6: one day's K scatters by ±1.7).
3. **TWA table**, from tacks and gybes: true wind of each side's means again through `process`
   (§5) with the proposed STW table, the wind tables off. Either side is at the same \|TWA\|;
   if \|TWA\| reads `e` too wide, TWD reads `TWD + s·e` on side `s` (+1 starboard), so the
   step is `−2·s·e` and the cell needs `s · step / 2`, at the sides' mean \|TWA\| and TWS (as
   looked up, before the TWA table). A rounding is not used: two cells share its step. A cell
   needs 3: boatcal's support (half a manoeuvre per 50° × 5 kn) assumes its least-squares fit,
   in which a manoeuvre informs several cells.
4. **TWS table**, from legs (boatcal 8): found from the compliant `s5` records as §11.5
   finds them from seconds (each record 5 good seconds of its class, any other record a gap;
   `sailUp` up, `sailReach` and `sailDown` off), each trimmed by 2 minutes at either end, its `s5`
   samples through `process` with the proposed STW and TWA tables, the TWS table off. An
   upwind leg with 60 s or more gives its median TWS. An off-wind leg's reference is that of
   the upwind leg ending before it and of the one starting after it, each within 30 minutes
   and on the same day, the mean of the two where there are both, and at least 3 kn. Each
   10° band of its corrected \|TWA\| with 60 s or more gives reference − median TWS, at the
   band's median \|TWA\| and TWS, weighted by its seconds. A cell needs 15 minutes per
   40° × 5 kn (boatcal), 90 s on the default 10° × 2 kn. Rows under 80° are 0 (upwind is the
   reference).

These are binned, weighted medians, not boatcal's regularised least squares: a guide to what
the findings say, cell by cell, to set against boatcal on the same days before a table is
changed. The summary is kept until a chunk adds findings, they are cleared, or the tables
change.

### 12.4 Routes

| Route | |
|---|---|
| `GET /analysis/status` | enabled, running, last run and its chunk, minutes read, findings written, done up to, the sensors read, error |
| `PUT /analysis` `{ enabled }` | pause or resume; kept across restarts |
| `PUT /analysis/run` | run now |
| `PUT /analysis/clear` | delete every finding; where the chunks have got to is kept |
| `GET /analysis/findings?since=&until=&type=&kind=&after=` | the findings as written (`after`: epoch s) |
| `GET /analysis/summary?since=&until=` | 12.3 |

| Constant | Value |
|---|---|
| Chunk every, first after start, lag, margin, context | 5 min, 1 min, 1 min, 3 min, 7 min |
| Sensor read | chosen, else most messages since start of those sent within 1 min |
| Look back: first run, after being off | 1 h, 24 h |
| Compliant `s5` | 4 good seconds of 5 |
| STW samples | STW and SOG > 0.5 kn, raw \|TWA\| > 30° |
| Current | 20 min, upright \|heel\| < 5°, ≥ 60 samples, heading spread ≥ 0.05, < 4 kn, 10% trimmed mean; converged 0.001 kn, ≤ 500 passes |
| Support | STW 200 samples per 10° × 2.5 kn; TWA 3; TWS 15 min per 40° × 5 kn |
| K | \|heel\| ≥ 4°, STW ≥ 3 kn, 5 days |
| TWS legs | trimmed 2 min each end; bands 10°, ≥ 60 s; reference ≥ 60 s, within 30 min, same day, ≥ 3 kn |
