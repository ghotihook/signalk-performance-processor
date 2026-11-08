# Specification: the maths

The master record of every equation, interpolation, fade, limit and damping rule in
signalk-performance-processor, and of how boatcal fits the tables. The code is
the implementation; this document is what it must do. **Change one, change the other**, in
the same commit, and note the change in [CHANGELOG.md](CHANGELOG.md).

Written for 0.3.1 (config schema 7) and boatcal after 1.4.0 (fine grids, §9).

| Section | Code |
|---|---|
| 1 Conventions | everywhere |
| 2 Inputs | `index.js` (`onDelta`, `chooseSensor`, `windPairComplete`, `fresh`) |
| 3 Heading, variation, COG, heel | `index.js` (`trueHeading`, `variationDeg`, `cogTrue`, `rollDeg`), `lib/processor.js` (`process`) |
| 4 Table lookups | `public/tables.js` (`interp`, `fromZero`, `bracket`, `lookup`, `fillGaps`, `checkAxis`) |
| 5 The pipeline | `lib/processor.js` (`CORRECTIONS`, `process`) |
| 6 Damping | `lib/damping.js`, `index.js` (`onWind`, `onHeading`, `onStw`, `onDelta`) |
| 7 Publishing | `index.js` (`onWind`, `onHeading`, `onStw`, `publish`, `OUTPUTS`) |
| 8 Configuration | `lib/processor.js` (`normalizeConfig`, `upgrade`, `toGrids`, `addSlowColumn`, `checkTable`, `twaTooSteep`), `public/tables.js` (`twaFromRows`, `twsFromRows`), `lib/defaults.js` |
| 9 Calibration fits | boatcal `boatcal/fit.py`, `boatcal/events.py`, `boatcal/decompose.py`, `boatcal/settings.py`; for a user's own data, [AGENTS.md](AGENTS.md) "Calibrating a boat" |
| 10 Constants | all of the above |
| 11 Learning (in progress) | `lib/history.js`, `lib/learn.js`, `index.js` (`runLearn`, `startLearn`) |

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
     (heel for attitude; both heading smoothers for heading).
  4. If the sensor in use has been silent for the input's freshness limit (2.3) when another
     sensor's message arrives, the sensor with the most messages in `RATE_WINDOW`, of those
     heard within that limit, is chosen at once. Damping restarts as in 3, the server log
     gets a line, and the status names the new sensor for `SWITCH_NOTE = 60 s`. This is also
     how an NMEA 2000 device is followed when the server renames it (`n2k-tcp.100` to
     `n2k-tcp.<canName>`) on learning its CAN name. A chosen source is never replaced.
- **Message counting:** a message counts once even when it arrives as several deltas: a
  repeat of the same timestamp from the same source is not counted again.
- **Rate shown in Settings:** `(n − 1) / (t_last − t_first)` over the last 10 s, to 0.1 Hz;
  0 for a source that has stopped.

### 2.3 Freshness

An input is used only if it arrived within `STALE = 3 s`; variation within 10 minutes.

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

`H_true` and `H_mag` are the damped values (§6). Heading damping is applied before
variation; variation is constant over the damping time, so the order does not matter.

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
- First sample, τ = 0, or a gap longer than **10 s**: the new value is taken as it is.
- A repeat of the same time: no change.
- **Directions** (`SmoothAngle`): smoothed on the unit circle, sin and cos separately, so 359°
  and 1° average to 0°.
- **Vectors** (`SmoothVector`, current): the east and north components smoothed separately.

### 6.2 What is damped, and when

| Quantity | τ (setting, default) | Updated on |
|---|---|---|
| Heading (magnetic and true, separately) | `headingS`, 0 s | each heading message |
| Heel | `heelS`, 2 s | each attitude message (plausible) |
| Published STW | `stwS`, 1 s | each STW message |
| TWD, TWS | `trueWindS`, 3 s | each apparent wind message |
| TWA, only when there is no heading | `trueWindS` | each apparent wind message |
| Ground wind direction and speed | `trueWindS` | each apparent wind message |
| Current (as a vector) | `currentS`, 120 s | each apparent wind message |

Limits (load and save): heel, heading, true wind and STW 0–30 s; current 0–300 s.

**Heading must have the same lag as apparent wind**, or every yaw swings TWD: with raw,
undamped apparent wind, heading damping is 0.

### 6.3 Published TWA and ground wind angle

TWA is not damped on its own. It is the damped TWD less the heading **now**, so it answers
the helm at once while the wind itself is steady:

```
TWA_pub = wrap180(TWD_d − H)       on each apparent wind message, and on each heading message
GWA_pub = wrap180(GWD_d − H)       likewise
```

On a heading message these use the last wind result's damped TWD and GWD, if that result is
under 3 s old and had a heading. When heading and wind arrive in one delta, only the wind's
TWA is sent. Without a heading, `TWA_pub` is the damped TWA.

---

## 7 Publishing

### 7.1 Triggers

| Output | Sent on |
|---|---|
| STW (STW table on) | each STW message: `STW_c` from the raw STW and the damped heel, then damped |
| True heading | each heading message, as `H`, unless the heading sensor sends true heading itself |
| TWA, ground wind angle | each heading message (§6.3) and each apparent wind message |
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

In light air **TWD, ground wind direction and ground wind angle are not sent**. **TWA, TWS
and ground wind speed always are**: TWA is what the crew sails by.

### 7.3 Rate limit

No output is sent more often than 20 Hz (50 ms apart), counted per output and per trigger
(TWA sent on heading and TWA sent on wind are limited separately). A dropped update is a
sign of a feedback loop: the status flags it from 5 drops in 10 s.

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
no values, the TWA constraint of §5.4, damping outside its limits, variation outside ±180°, a
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
plugin does not run, and says why. Saving over such a file first copies it to
`config.json.bad`.

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
| Max plausible AWS / STW / heel | 120 kn / 60 kn / 90° | `index.js` |
| Rate limit | 50 ms (20 Hz) | `index.js` `MIN_PUBLISH_INTERVAL_MS` |
| Loop flag | 5 drops in 10 s | `index.js` `RATE_FLAG_MIN`, `RATE_NOTE_MS` |
| Light air off / on | 1.5 / 2.0 kn | `index.js` `LIGHT_AIR_OFF_KN`, `LIGHT_AIR_ON_KN` |
| Status refresh | 1 s | `index.js` `STATUS_INTERVAL_MS` |
| Damping reset gap | 10 s | `lib/damping.js` `RESET_S` |
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
| `s5` | 5 s medians of the 1 Hz rows (angles through their sine and cosine): AWA, AWS, STW, heel, H, SOG, COG, variation; the class | STW table, current, K, TWS legs |
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
