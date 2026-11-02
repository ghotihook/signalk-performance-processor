# Specification: the maths

The master record of every equation, interpolation, fade, limit and damping rule in
signalk-performance-processor, and of how boatcal's `plugincal` fits the tables. The code is
the implementation; this document is what it must do. **Change one, change the other**, in
the same commit, and note the change in [CHANGELOG.md](CHANGELOG.md).

Written for 0.2.16 (config schema 6) and plugincal 1.3.3.

| Section | Code |
|---|---|
| 1 Conventions | everywhere |
| 2 Inputs | `index.js` (`onDelta`, `chooseSensor`, `windPairComplete`, `fresh`) |
| 3 Heading, variation, COG, heel | `index.js` (`trueHeading`, `variationDeg`, `cogTrue`, `rollDeg`), `lib/processor.js` (`process`) |
| 4 Table lookups | `public/tables.js` (`interp`, `fromZero`, `blendRows`, `fillGaps`, `twsCorrection`) |
| 5 The pipeline | `lib/processor.js` (`CORRECTIONS`, `process`) |
| 6 Damping | `lib/damping.js`, `index.js` (`onWind`, `onHeading`, `onStw`, `onDelta`) |
| 7 Publishing | `index.js` (`onWind`, `onHeading`, `onStw`, `publish`) |
| 8 Configuration | `lib/processor.js` (`normalizeConfig`, `addSlowColumn`), `lib/defaults.js` |
| 9 Calibration fits | boatcal `plugincal/fit.py`, `plugincal/plugincal.py`, `plugincal/events.py` |
| 10 Constants | all of the above |

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

## 4 Table lookups (shared by the plugin, the webapp and plugincal)

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

### 4.3 Blending three rows by |TWA|

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

Layout (fixed): rows **heel −20, −10, 0, 10, 20°**; columns **STW 1, 2.5, 5, 7.5, 10, 12.5,
15 kn**. The H5000's layout, with the 1 kn column added for paddlewheel stall.

```
rows      = fillGaps(add)
h         = clamp(heel, −20, 20)             (heel missing → 0)
[i, j, f] = bracket of h in the heel rows    (f = (h − heel_i)/(heel_j − heel_i))
add(h, v) = fromZero(cols, rows[i], v)·(1 − f) + fromZero(cols, rows[j], v)·f
STW_c     = max(0, STW + add(h, STW))
```

Below 1 kn the correction runs straight from 0 at 0 kn to the 1 kn cell: a stopped boat is
never given speed.

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

Layout (fixed): rows at **TWA 40° (upwind), 90° (reach), 165° (downwind)**; columns
**TWS 5, 10, 15, 20, 25, 30 kn**. Degrees added to |TWA|; negative = TWA read too wide.

```
a       = |TWA0|
[u,r,d] = fillGaps([upwind, reach, downwind]) each through fromZero(cols, row, TWS0)
table   = blendRows(a, 40, 90, 165, u, r, d)
taper   = clamp(min(a / 30, (180 − a) / 10), 0, 1)
TWA1    = sign(TWA0) · clamp(a + table · taper, 0, 180)        (sign(0) taken as +)
```

The taper fades the correction to none at 0° and 180°: in full from 30° to 170°, so TWA
and TWD pass through tacks and gybes without a flat spot or a jump.

**Constraint (checked on load and save):** every upwind-row value strictly inside ±30° and
every downwind-row value strictly inside ±10° (the limits of the taper). Then `d(TWA1)/d(TWA0) > 0` near 0° and 180°:
corrected TWA always moves the same way as uncorrected TWA.

### 5.5 TWS table

Layout (fixed): columns **TWS 5, 10, 15, 20, 25, 30 kn**; rows **upwind, reach, downwind**
(kn added), **up angle**, **down angle** (deg, one per column, no blanks).

```
a       = |TWA1|                               (the TWA after its table)
[u,r,d] = fillGaps([upwind, reach, downwind]) each through fromZero(cols, row, TWS0)
A_up    = min(89, interp(cols, upAngle,   TWS0))
A_down  = max(91, interp(cols, downAngle, TWS0))
add     = blendRows(a, A_up, 90, A_down, u, r, d)
TWS1    = max(0, TWS0 + add)
```

**Constraint:** 0 ≤ up angle < 90 < down angle ≤ 180, so the correction blends everywhere
and never steps. (The clamps to 89 and 91 only guard against division by zero.)

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
| Current (as a vector) | `currentS`, 10 s | each apparent wind message |

Limits (load and save): heel, heading, true wind and STW 0–30 s; current 0–120 s.

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

---

## 8 Configuration

### 8.1 Schema 6 layout

Fixed axes, as in §5. Saved in `config.json` with `"schema": 6`. Blank cells are `null`
(§4.4). Validation refuses: an axis that differs from the layout, a row of the wrong length,
a non-number (blanks allowed only in correction rows, not angle rows), an STW table with no
values, the TWA and TWS constraints of §5.4 and §5.5, damping outside its limits,
variation outside ±180°, a section that is not an object, a source that is not a name.

### 8.2 Upgrading a schema 5 file (0.2.7 to 0.2.11)

Schema 5's STW table had columns 2.5 … 15 kn. It gains a 1 kn column that leaves every
lookup unchanged:

```
filled  = fillGaps(add)
row'    = [ round(filled[i][0] · 1/2.5, 0.001), filled[i][0], row[1..] ]   (a row with data)
        = [ null ] + row                                                   (an all-blank row)
```

A straight line from 0 through the 2.5 kn value passes 1 kn at 0.4 of that value, so the
new cell lies on the line the table already used. The first cell is filled explicitly
because a blank there would now take the new 1 kn cell's value instead.

Older schemas (3: 0.1.0–0.2.5; 4: 0.2.6) keep their settings and leeway K; their tables are
reset to the defaults (schema 4 keeps its STW and TWS tables), and the mode goes to Shadow.

### 8.3 Loading and saving

A saved file that cannot be read (not JSON, or not a JSON object) is not the defaults: the
plugin does not run, and says why. Saving over such a file first copies it to
`config.json.bad`.

`PUT /calibration`: a body with `schema` is a whole configuration, laid over the defaults; a
body without it is laid over the configuration in use. Objects merge, arrays replace. A body
that is not a JSON object is refused. While the plugin is disabled in the server, a save is
kept but nothing starts.

---

## 9 Calibration fits (boatcal `plugincal`)

Each item is fitted on the output of the ones before, in the order the plugin applies them,
through the plugin's own arithmetic (`plugincal/pipeline.js` calls `lib/processor.js` and
`public/tables.js`). The table lookups are linear in the cell values, so each fit is a
least-squares problem in the cells, with the plugin's lookup as the design matrix (probed
one cell at a time). "Held out" scores each day with a fit made without it.

### 9.1 STW table and leeway K (from the GPS)

Data: 5 s samples; `--labelled` uses race legs plus the sailing under 2.5 kn from all days.
The manual boat speed factor (`man_bsp_adj`) is applied throughout; |TWA| > 30°; STW and SOG > 0.5 kn.

1. **Current** is fitted per 20-minute window where the headings vary enough (circular
   spread ≥ 0.15, ≥ 60 samples, drift ≤ 4 kn), by `stw_leeway`.
2. The heading for the boat's frame is magnetic plus the offset that makes the water track
   symmetric across tacks (falling back to the GPS variation when too few tacks). In that
   frame, `ground − current − STW` gives the paddlewheel's **forward error** `o_x` and the
   **sideways slip** `o_y`.
3. **STW table:** cells `c` minimise
   ```
   Σ softL1(W·c − o_x; 0.25 kn) + 0.5 Σ_neighbours (c_a − c_b)² + Σ (0.01·c)²
   ```
   with `W` the plugin's lookup weights. A cell weighted by under 200 samples is left blank.
4. **K:** upwind samples (|TWA| < 70°), minimise `Σ softL1(o_y − STW_c·sin λ(K); 0.25 kn)`,
   K in [0, 30], with λ from §5.2.

### 9.2 TWA table (from manoeuvres)

TWD should not step across a tack (TWA crosses 0°), gybe (crosses 180°) or rounding (|TWA|
crosses 90°). Found on TWA0 smoothed over 15 s. Windows before and after (s from the
crossing): tacks and gybes (−50, −20) and (30, 60); roundings (−120, −30) and (45, 135).
Each window needs ≥ 50% good data, heading s.d. ≤ 12°, mean STW ≥ 2.5 kn, and mean |heel| ≥ 4°
when upwind (not motoring).

Per manoeuvre `i`: `step_i` = circular-mean TWD after − before (no TWA table);
`dA_i` = the change across it of `sign(TWA)·W_TWA` (the lookup weights with the taper);
`d|TWA|_i` = the change of |TWA|. Cells `c` and a wind-shift term `k` per kind minimise

```
Σ w_i · huber(step_i + dA_i·c + k_kind·d|TWA|_i; 4°)
  + 32 Σ_columns (c_a − c_b)² + 0.5 Σ_rows (c_a − c_b)² + Σ (0.03·c)²
```

with weights tack 1, gybe 1, rounding 0.5; bounds inside the §5.4 constraints by 0.1°; k in
±3. A cell with under 0.5 manoeuvres' worth of support is left blank.

### 9.3 TWS table (from off-wind legs)

TWS should not change when the boat bears away. Each reaching or downwind leg (|TWA| > 80°,
≥ 3 min) is compared with the upwind legs (|TWA| < 70°) either side, within 30 min, with
2 min trimmed from each leg end and TWS ≥ 3 kn, band by band of |TWA| (10° bands, ≥ 60 s
each). The upwind row is the reference (0) with up angle 50°; the reach and downwind rows are
fitted with the plugin's blend (§5.5), Huber 0.5 kn, neighbouring columns tied with weight 4.
The down angle is chosen from 95°, 100° … 180° as the one that does best held out. A cell
with under 15 minutes of sailing is 0 when lighter than its row's first fitted cell, blank
beyond it; a row with no fitted cell is 0.

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
| TWS reach angle | 90° | `public/tables.js` `REACH_DEG` |
| Table layout | §5.1, §5.4, §5.5 | `public/tables.js` `AXES` |
| Fallback variation | 12.8° E | `lib/defaults.js` |
| Config schema | 6 | `lib/processor.js` `CONFIG_SCHEMA` |
