'use strict'

// The processing pipeline, free of Signal K so it can be tested and replayed against
// logged data. Units throughout: degrees and knots. Angles are signed, + = starboard;
// heel + = starboard side down; leeway + = sliding to starboard.
//
// Order of work:
//   input corrections  (CORRECTIONS with stage 'input')
//   true wind          apparent wind minus boat velocity through the water
//   true wind corrections (stage 'trueWind')
//   derived            TWD and current
//
// A new correction is one more entry in CORRECTIONS plus its defaults in defaults.js;
// the pipeline, the Live view and the enable switch pick it up from there.

const { DEFAULTS } = require('./defaults')
// The tables' layout (the H5000's) and text format, shared with the webapp.
const { AXES, fillGaps, resampleStw } = require('../public/tables')

const MAX_LEEWAY_DEG = 15
// K x heel / STW^2 grows without bound as the boat slows, so leeway fades in with speed:
// none below the first value, in full from the second, linear between. Without the
// fade it snapped from nothing to the 15 degree cap as the boat came off the line.
const LEEWAY_FADE_KN = [1.5, 3]
// The TWA correction fades out towards head to wind and dead downwind: in full from
// TWA_TAPER_UP_DEG off the wind and up to TWA_TAPER_DOWN_DEG short of dead downwind,
// none at 0 and 180. Applied in full there, it held TWA at 0 through every tack (so TWD
// followed the bow) and made TWA jump as it crossed 180. Upwind the boat is inside the
// fade only while tacking; sailing deeper than 170 gets part of the correction. With the table values kept
// smaller than the taper (normalizeConfig checks), corrected TWA always moves the same
// way as uncorrected TWA.
const TWA_TAPER_UP_DEG = 30
const TWA_TAPER_DOWN_DEG = 10
const twaTaper = abs => Math.max(0, Math.min(1, abs / TWA_TAPER_UP_DEG, (180 - abs) / TWA_TAPER_DOWN_DEG))
// The STW table's correction fades to nothing below this boat speed, so a stopped boat
// is not given speed by the 0 kn column.
const STW_FADE_KN = 1
// The TWS correction applies downwind: none below this |TWA|, in full from the table's
// down angle for that TWS (165 by default), linear between.
const TWS_NONE_BELOW_DEG = 90

const norm360 = d => ((d % 360) + 360) % 360
const norm180 = d => { const n = norm360(d); return n > 180 ? n - 360 : n }
const rad = d => d * Math.PI / 180
const deg = r => r * 180 / Math.PI

// Linear interpolation, holding the end values beyond either end.
function interp (xs, ys, x) {
  if (x <= xs[0]) return ys[0]
  const n = xs.length - 1
  if (x >= xs[n]) return ys[n]
  let i = 0
  while (xs[i + 1] < x) i++
  const t = (x - xs[i]) / (xs[i + 1] - xs[i])
  return ys[i] + (ys[i + 1] - ys[i]) * t
}

// H5000 rows: upwind in full up to its angle (40), reach at its angle (90), downwind in
// full from its angle (165), linear in |TWA| between.
function blendRows (absTwa, angles, up, reach, down) {
  if (absTwa <= angles.upwind) return up
  if (absTwa <= angles.reach) return up + (reach - up) * (absTwa - angles.upwind) / (angles.reach - angles.upwind)
  if (absTwa <= angles.downwind) return reach + (down - reach) * (absTwa - angles.reach) / (angles.downwind - angles.reach)
  return down
}

// Interpolate along a row whose blank cells (null) mean "not measured": use only the
// measured cells, holding the nearest one beyond them. An all-blank row is zero.
function interpRow (xs, ys, x) {
  const kx = []; const ky = []
  ys.forEach((y, i) => { if (y != null) { kx.push(xs[i]); ky.push(y) } })
  return kx.length ? interp(kx, ky, x) : 0
}

function tableLookup (table, angles, absTwa, tws) {
  return blendRows(absTwa, angles,
    interpRow(table.tws, table.upwind, tws),
    interpRow(table.tws, table.reach, tws),
    interpRow(table.tws, table.downwind, tws))
}

// ---- boat speed / heel table ------------------------------------------------------

function bracket (bins, v) {
  if (v <= bins[0]) return [0, 0, 0]
  const n = bins.length - 1
  if (v >= bins[n]) return [n, n, 0]
  let i = 0
  while (bins[i + 1] < v) i++
  return [i, i + 1, (v - bins[i]) / (bins[i + 1] - bins[i])]
}

// The filled grid is worked out once per config object, not on every update.
const filledCache = new WeakMap()
function filledGrid (cfg) {
  let f = filledCache.get(cfg)
  if (!f) { f = fillGaps(cfg.add); filledCache.set(cfg, f) }
  return f
}

// H5000 layout: rows by heel either side (0, 10, 20), columns by boat speed (0 to 30).
// Bilinear, holding the edge values beyond the grid (more heel than the last row uses
// the last row). Blank cells are filled from the nearest value in their row. Below
// STW_FADE_KN the correction fades to nothing at 0 kn.
function stwGridLookup (cfg, heel, stw) {
  const t = filledGrid(cfg)
  const [h0, h1, ht] = bracket(cfg.heel, Math.abs(heel))
  const [j0, j1, st] = bracket(cfg.stw, stw)
  const v = t[h0][j0] * (1 - ht) * (1 - st) + t[h0][j1] * (1 - ht) * st + t[h1][j0] * ht * (1 - st) + t[h1][j1] * ht * st
  return v * Math.max(0, Math.min(1, stw / STW_FADE_KN))
}

// TWS correction (kn) and how much of it applies at this |TWA|: none below
// TWS_NONE_BELOW_DEG, all from the down angle for this TWS.
function twsLookup (cfg, absTwa, tws) {
  // Blank correction cells mean no correction there (the TWS table's convention).
  const kn = interp(cfg.tws, cfg.correction.map(v => v == null ? 0 : v), tws)
  const down = interpRow(cfg.tws, cfg.downAngle, tws) || AXES.twaRows.downwind
  const share = Math.max(0, Math.min(1, (absTwa - TWS_NONE_BELOW_DEG) / Math.max(1, down - TWS_NONE_BELOW_DEG)))
  return { kn, share }
}

const fmt = (v, d = 1) => (v > 0 ? '+' : '') + v.toFixed(d)

const CORRECTIONS = [
  {
    id: 'stw',
    produces: ['stw'], // quantities this step's result replaces
    stage: 'input',
    name: 'Boat speed (STW)',
    apply (c, cfg) {
      const add = stwGridLookup(cfg, c.heel == null ? 0 : c.heel, c.stw)
      const before = c.stw
      c.stw = Math.max(0, c.stw + add)
      return {
        input: `${before.toFixed(2)} kn` + (c.heel == null ? ' · no heel data, upright row used' : ` · heel ${Math.abs(c.heel).toFixed(0)}°`),
        detail: `${fmt(add, 2)} kn from the boat speed / heel table` + (before < STW_FADE_KN ? ` (fading out below ${STW_FADE_KN} kn)` : ''),
        output: `${c.stw.toFixed(2)} kn`
      }
    }
  },
  {
    id: 'leeway',
    produces: ['leeway'], // quantities this step's result replaces
    stage: 'input',
    name: 'Leeway',
    apply (c, cfg) {
      if (c.heel == null) return { skipped: 'no heel data' }
      const k = cfg.k
      const [lo, hi] = LEEWAY_FADE_KN
      const fade = Math.max(0, Math.min(1, (c.stw - lo) / (hi - lo)))
      c.leeway = fade === 0
        ? 0
        : fade * Math.max(-MAX_LEEWAY_DEG, Math.min(MAX_LEEWAY_DEG, k * c.heel / (c.stw * c.stw)))
      return {
        input: `heel ${c.heel.toFixed(0)}°`,
        detail: `K ${k} × heel ÷ STW²` + (fade < 1 ? ` × ${Math.round(fade * 100)}% (fading in, ${lo}–${hi} kn)` : ''),
        output: `${Math.abs(c.leeway).toFixed(1)}° ${c.leeway < 0 ? 'port' : 'stbd'}`
      }
    }
  },
  {
    id: 'twa',
    produces: ['twa'], // quantities this step's result replaces
    stage: 'trueWind',
    name: 'TWA table',
    apply (c, cfg) {
      const abs = Math.abs(c.twa)
      const table = tableLookup(cfg, AXES.twaRows, abs, c.tws)
      const taper = twaTaper(abs)
      const add = table * taper
      const before = c.twa
      c.twa = Math.sign(c.twa || 1) * Math.max(0, Math.min(180, abs + add))
      return {
        input: `TWA ${Math.abs(before).toFixed(1)}° · TWS ${c.tws.toFixed(1)}`,
        detail: `${fmt(add)}°` + (taper < 1 ? ` (${fmt(table)}° × ${Math.round(taper * 100)}%, fading out near ${abs < 90 ? 'head to wind' : 'dead downwind'})` : ''),
        output: `TWA ${Math.abs(c.twa).toFixed(1)}°`
      }
    }
  },
  {
    id: 'tws',
    produces: ['tws'], // quantities this step's result replaces
    stage: 'trueWind',
    name: 'TWS table',
    apply (c, cfg) {
      const { kn, share } = twsLookup(cfg, Math.abs(c.twa), c.tws)
      const add = kn * share
      const before = c.tws
      c.tws = Math.max(0, c.tws + add)
      return {
        input: `TWS ${before.toFixed(1)} kn · TWA ${Math.abs(c.twa).toFixed(0)}°`,
        detail: `${fmt(add, 2)} kn` + (share < 1 ? ` (${fmt(kn, 2)} × ${Math.round(share * 100)}%, ${share === 0 ? `none below ${TWS_NONE_BELOW_DEG}°` : 'blending in towards the down angle'})` : ''),
        output: `TWS ${c.tws.toFixed(1)} kn`
      }
    }
  }
]

function runStage (stage, c, config, steps) {
  for (const corr of CORRECTIONS.filter(x => x.stage === stage)) {
    const cfg = config.corrections[corr.id]
    if (!cfg || !cfg.enabled) {
      steps.push({ id: corr.id, name: corr.name, produces: corr.produces, enabled: false })
      continue
    }
    const r = corr.apply(c, cfg, config)
    steps.push({ id: corr.id, name: corr.name, produces: corr.produces, enabled: true, ...r })
  }
}

// Input corrections only: STW and leeway from raw STW and heel. Used on its own to
// republish corrected STW as soon as the paddlewheel reports.
function correctInputs (input, config) {
  const c = { stw: input.stw, heel: input.heel == null ? null : input.heel, leeway: 0 }
  const steps = []
  runStage('input', c, config, steps)
  return { c, steps }
}

// input: { awa, aws, stw, heel?, headingMagnetic?, headingTrue?, variation?, sog?, cog? }
// returns { out: { stw, leeway, twa, tws, heading?, twd?, current? }, steps }
function process (input, config) {
  const { c, steps } = correctInputs(input, config)

  // True wind: apparent wind minus the boat's velocity through the water, which points
  // along the heading turned by leeway.
  const a = rad(input.awa)
  const l = rad(c.leeway)
  const x = input.aws * Math.cos(a) - c.stw * Math.cos(l)
  const y = input.aws * Math.sin(a) - c.stw * Math.sin(l)
  c.twa = deg(Math.atan2(y, x))
  c.tws = Math.hypot(x, y)
  steps.push({
    id: 'truewind',
    produces: ['twa', 'tws'],
    name: 'True wind, before tables',
    enabled: true,
    input: `AWA ${Math.abs(input.awa).toFixed(1)}° · ${input.aws.toFixed(1)} kn`,
    detail: 'apparent wind − boat velocity',
    output: `TWA ${Math.abs(c.twa).toFixed(1)}° · ${c.tws.toFixed(1)} kn`
  })

  runStage('trueWind', c, config, steps)

  const out = { stw: c.stw, leeway: c.leeway, twa: c.twa, tws: c.tws }

  // True heading: from a true-heading source if there is one, otherwise magnetic
  // heading plus variation, taken from Signal K (the GPS) when available and from the
  // configured fallback when not.
  let heading = null
  if (input.headingTrue != null) {
    heading = input.headingTrue
    out.headingFrom = 'true heading'
  } else if (input.headingMagnetic != null) {
    const fromSignalK = input.variation != null
    out.variation = fromSignalK ? input.variation : config.variation
    out.headingFrom = fromSignalK ? 'magnetic + variation from Signal K' : 'magnetic + fallback variation'
    heading = input.headingMagnetic + out.variation
  }
  if (heading != null) {
    out.heading = norm360(heading)
    out.twd = norm360(heading + c.twa)
    if (input.sog != null && input.cog != null) {
      // Current = ground velocity - water velocity; set is where it flows to.
      const cr = rad(input.cog)
      const wr = rad(heading + c.leeway)
      const e = input.sog * Math.sin(cr) - c.stw * Math.sin(wr)
      const n = input.sog * Math.cos(cr) - c.stw * Math.cos(wr)
      out.current = { drift: Math.hypot(e, n), set: norm360(deg(Math.atan2(e, n))) }
      steps.push({
        id: 'current',
        produces: ['current'],
        name: 'Current',
        enabled: true,
        input: `SOG ${input.sog.toFixed(1)} · COG ${input.cog.toFixed(0)}°`,
        detail: 'ground − water velocity',
        output: `${out.current.drift.toFixed(2)} kn → ${out.current.set.toFixed(0)}°`
      })
    }
  }
  return { out, steps }
}

// ---- configuration --------------------------------------------------------

const clone = o => JSON.parse(JSON.stringify(o))

function isPlainObject (o) {
  return o !== null && typeof o === 'object' && !Array.isArray(o)
}

// Defaults first, then whatever the stored config sets. Arrays replace, objects merge.
function merge (base, over) {
  if (!isPlainObject(over)) return base
  const out = clone(base)
  for (const [k, v] of Object.entries(over)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = merge(out[k], v)
    else if (v !== undefined) out[k] = v
  }
  return out
}

function checkRow (errors, label, ys, n, blanksAllowed) {
  if (!Array.isArray(ys) || ys.length !== n) { errors.push(`${label}: needs ${n} values, one per column`); return }
  const ok = v => (blanksAllowed && v === null) || (typeof v === 'number' && Number.isFinite(v))
  if (!ys.every(ok)) errors.push(`${label}: every value must be a number${blanksAllowed ? ' or blank' : ''}`)
}

function checkNumber (errors, label, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${label}: must be a number`)
}

// ---- file format versions ----------------------------------------------------
//
// Every saved config carries `schema`, the version of its shape. When a release changes
// that shape, bump CONFIG_SCHEMA and add MIGRATIONS[old], a function that turns a
// config of schema `old` into schema `old + 1`. Older files are then upgraded step by
// step as they load and saved back in the current shape; nothing is lost or reset.
//
// Schema 1 (0.0.1–0.0.3): mode, variation, sources, corrections { stw, leeway, twa, tws },
//   with stw as two rows: linearity { stw, add } and heel { heel, add } by |heel|.
// Schema 2 (0.0.4–0.0.6): stw is one grid { heel (signed), stw, add[heel][stw] }, blanks
//   allowed; the TWS table is in knots (was percent); both wind tables allow blanks.
// Schema 3 (0.1.0): the H5000's layout. stw { heel [0, 10, 20] either side, stw [0..30],
//   add }; twa { tws [0..30], upwind, reach, downwind } with rows fixed at TWA 40, 90, 165
//   (no angles); tws { tws [0..30], correction, downAngle }.

const CONFIG_SCHEMA = 3

// A row onto new columns: values at columns it had are kept (blanks too), a 0 kn column
// it lacked is 0, any other new column is interpolated from its measured cells.
function remapRow (xs, ys, cols) {
  return cols.map(c => {
    const i = xs.indexOf(c)
    if (i >= 0) return ys[i] == null ? null : ys[i]
    if (c === 0) return 0
    return ys.some(v => v != null) ? +interpRow(xs, ys, c).toFixed(3) : null
  })
}
const MIGRATIONS = {
  // Two rows become the grid they describe: signed heel rows mirrored from the |heel|
  // row, the linearity speeds as columns, each cell linearity + heel.
  1: cfg => {
    cfg = clone(cfg)
    const t = cfg.corrections && cfg.corrections.tws
    if (t && Array.isArray(t.tws)) {
      // percent of TWS -> knots at each column
      for (const r of ['upwind', 'reach', 'downwind']) {
        if (Array.isArray(t[r])) t[r] = t[r].map((v, j) => typeof v === 'number' ? +(v / 100 * t.tws[j]).toFixed(3) : v)
      }
    }
    const old = cfg.corrections && cfg.corrections.stw
    if (!old || !old.linearity || !old.heel) return cfg
    const ah = old.heel.heel
    const heel = Array.from(new Set(ah.map(h => -h).concat(ah))).sort((x, y) => x - y)
    const stwBins = old.linearity.stw
    const add = heel.map(h => stwBins.map((_, j) => +(old.linearity.add[j] + interp(ah, old.heel.add, Math.abs(h))).toFixed(4)))
    return { ...cfg, corrections: { ...cfg.corrections, stw: { enabled: old.enabled, heel, stw: stwBins, add } } }
  },
  // The H5000 layout. The signed heel x STW grid is resampled (port and starboard
  // averaged); the TWA rows keep their values with a 0 kn column added, but are now
  // anchored at TWA 40 / 90 / 165 rather than the old configurable angles, so a TWA
  // table fitted for the old angles should be refitted; the TWS table keeps its
  // downwind row as the correction, with the H5000's default down angle of 165.
  2: cfg => {
    cfg = clone(cfg)
    const k = cfg.corrections
    if (!k) return cfg
    if (k.stw && Array.isArray(k.stw.heel) && Array.isArray(k.stw.stw) && Array.isArray(k.stw.add)) {
      k.stw = { enabled: k.stw.enabled, ...resampleStw(k.stw) }
    }
    if (k.twa && Array.isArray(k.twa.tws)) {
      const t = k.twa
      k.twa = { enabled: t.enabled, tws: AXES.twaTws.slice() }
      for (const row of ['upwind', 'reach', 'downwind']) if (Array.isArray(t[row])) k.twa[row] = remapRow(t.tws, t[row], AXES.twaTws)
    }
    if (k.tws && Array.isArray(k.tws.tws)) {
      const t = k.tws
      k.tws = { enabled: t.enabled, tws: AXES.twsTws.slice(), downAngle: AXES.twsTws.map(() => AXES.twaRows.downwind) }
      if (Array.isArray(t.downwind)) k.tws.correction = remapRow(t.tws, t.downwind, AXES.twsTws)
    }
    return cfg
  }
}

// Bring a raw config up to the current schema. A config without `schema` predates the
// field and has the schema 1 shape. One from a newer release is refused rather than
// guessed at, since this version cannot know what its fields mean.
function migrate (raw, migrations = MIGRATIONS, current = CONFIG_SCHEMA) {
  let cfg = clone(raw)
  let v = cfg.schema == null ? 1 : cfg.schema
  if (!Number.isInteger(v) || v < 1) return { error: `schema: "${cfg.schema}" is not a schema version` }
  if (v > current) return { error: `schema ${v} was saved by a newer version of this plugin (this one reads up to ${current}); update the plugin` }
  while (v < current) {
    if (!migrations[v]) return { error: `schema: no upgrade from ${v} to ${v + 1}` }
    cfg = migrations[v](cfg)
    v++
  }
  cfg.schema = current
  return { config: cfg }
}

// Merge a stored or submitted config over the defaults and check it. Numbers typed
// into a form arrive as strings, so coerce numeric-looking strings first.
function normalizeConfig (input) {
  const coerce = v => {
    if (Array.isArray(v)) return v.map(coerce)
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, coerce(x)]))
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
    return v
  }
  const migrated = migrate(isPlainObject(input) ? input : {})
  if (migrated.error) return { config: { ...clone(DEFAULTS), schema: CONFIG_SCHEMA }, errors: [migrated.error] }
  const raw = migrated.config
  // Source names are text even when they look numeric.
  const keepText = { sources: raw.sources, mode: raw.mode }
  const config = merge({ schema: CONFIG_SCHEMA, ...DEFAULTS }, { ...coerce(raw), ...Object.fromEntries(Object.entries(keepText).filter(([, v]) => v !== undefined)) })
  const errors = []
  const k = config.corrections

  if (!['shadow', 'replace'].includes(config.mode)) errors.push('mode: must be shadow or replace')
  checkNumber(errors, 'variation', config.variation)

  const fixedAxis = (label, xs, axis) => {
    if (!Array.isArray(xs) || xs.length !== axis.length || xs.some((v, i) => v !== axis[i])) errors.push(`${label}: must be ${axis.join(', ')} (the H5000 layout)`)
  }
  fixedAxis('STW table heel rows', k.stw.heel, AXES.stwHeel)
  fixedAxis('STW table boat speed columns', k.stw.stw, AXES.stwSpeed)
  const g = k.stw.add
  if (!Array.isArray(g) || g.length !== AXES.stwHeel.length) {
    errors.push('STW table: needs one row per heel angle')
  } else if (g.some(r => !Array.isArray(r) || r.length !== AXES.stwSpeed.length)) {
    errors.push('STW table: every row needs one value per boat speed')
  } else if (g.some(r => r.some(v => v !== null && (typeof v !== 'number' || !Number.isFinite(v))))) {
    errors.push('STW table: every value must be a number or blank')
  } else if (!g.some(r => r.some(v => v !== null))) {
    errors.push('STW table: has no values at all')
  }

  checkNumber(errors, 'Leeway K', k.leeway.k)

  fixedAxis('TWA table TWS columns', k.twa.tws, AXES.twaTws)
  for (const row of ['upwind', 'reach', 'downwind']) checkRow(errors, `TWA table ${AXES.twaRows[row]}° row`, k.twa[row], AXES.twaTws.length, true)
  // Corrections smaller than the taper keep corrected TWA moving the same way as
  // uncorrected TWA near head to wind and dead downwind (see TWA_TAPER_UP_DEG).
  const within = (row, lim) => (k.twa[row] || []).every(v => v == null || typeof v !== 'number' || Math.abs(v) < lim)
  if (!within('upwind', TWA_TAPER_UP_DEG)) errors.push(`TWA table ${AXES.twaRows.upwind}° row: values must be within ±${TWA_TAPER_UP_DEG - 0.1}°`)
  if (!within('downwind', TWA_TAPER_DOWN_DEG)) errors.push(`TWA table ${AXES.twaRows.downwind}° row: values must be within ±${TWA_TAPER_DOWN_DEG - 0.1}°`)

  fixedAxis('TWS table TWS columns', k.tws.tws, AXES.twsTws)
  checkRow(errors, 'TWS table correction row', k.tws.correction, AXES.twsTws.length, true)
  checkRow(errors, 'TWS table down angle row', k.tws.downAngle, AXES.twsTws.length, false)
  if (Array.isArray(k.tws.downAngle) && k.tws.downAngle.some(v => typeof v === 'number' && !(v > TWS_NONE_BELOW_DEG && v <= 180))) {
    errors.push(`TWS table down angle row: each must be above ${TWS_NONE_BELOW_DEG}° and at most 180°`)
  }

  for (const [id, c] of Object.entries(k)) {
    if (typeof c.enabled !== 'boolean') errors.push(`${id}: enabled must be true or false`)
  }
  return { config, errors }
}

module.exports = {
  process,
  correctInputs,
  normalizeConfig,
  CORRECTIONS,
  CONFIG_SCHEMA,
  AXES,
  MAX_LEEWAY_DEG,
  LEEWAY_FADE_KN,
  STW_FADE_KN,
  TWS_NONE_BELOW_DEG,
  TWA_TAPER_UP_DEG,
  TWA_TAPER_DOWN_DEG,
  _internals: { interp, interpRow, blendRows, tableLookup, merge, norm180, migrate, fillGaps, stwGridLookup, twsLookup, twaTaper, remapRow }
}
