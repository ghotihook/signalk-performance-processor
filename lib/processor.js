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
const { AXES, REACH_DEG, fromZero, blendRows, fillGaps, twsCorrection } = require('../public/tables')

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

const norm360 = d => ((d % 360) + 360) % 360
const norm180 = d => { const n = norm360(d); return n > 180 ? n - 360 : n }
const rad = d => d * Math.PI / 180
const deg = r => r * 180 / Math.PI

// TWA table: the H5000's rows (upwind in full up to 40, reach at 90, downwind in full
// from 165, linear in |TWA| between), each row by TWS from zero at 0 kn. Blank cells take
// the nearest value in their row.
const filledCache = new WeakMap()
function filled (cfg, rows) {
  let f = filledCache.get(cfg)
  if (!f) { f = fillGaps(rows(cfg)); filledCache.set(cfg, f) }
  return f
}
function tableLookup (table, angles, absTwa, tws) {
  const [up, reach, down] = filled(table, t => [t.upwind, t.reach, t.downwind]).map(r => fromZero(table.tws, r, tws))
  return blendRows(absTwa, angles.upwind, angles.reach, angles.downwind, up, reach, down)
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

// The H5000 layout, with a 1 kn column: rows by heel (-20 to 20, + = starboard side down), columns by boat speed
// (1, then the H5000's 2.5 to 15). Linear between heel rows, more heel than the last row using the last row;
// along each row from zero at 0 kn (so a stopped boat is not given speed), the last column
// held beyond it. Blank cells take the nearest value in their row.
function stwGridLookup (cfg, heel, stw) {
  const t = filled(cfg, c => c.add)
  const [h0, h1, ht] = bracket(cfg.heel, heel)
  return fromZero(cfg.stw, t[h0], stw) * (1 - ht) + fromZero(cfg.stw, t[h1], stw) * ht
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
        input: `${before.toFixed(2)} kn` + (c.heel == null ? ' · no heel data, upright row used' : ` · heel ${Math.abs(c.heel).toFixed(0)}° ${c.heel < 0 ? 'port' : 'stbd'}`),
        detail: `${fmt(add, 2)} kn from the boat speed / heel table` + (before < AXES.stwSpeed[0] ? ' (towards nothing at 0 kn)' : ''),
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
      const add = twsCorrection(cfg, Math.abs(c.twa), c.tws) // tables.js: rows blended by |TWA|
      const before = c.tws
      c.tws = Math.max(0, c.tws + add)
      return {
        input: `TWS ${before.toFixed(1)} kn · TWA ${Math.abs(c.twa).toFixed(0)}°`,
        detail: `${fmt(add, 2)} kn at ${Math.abs(c.twa).toFixed(0)}° TWA`,
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
    const r = corr.apply(c, cfg)
    steps.push({ id: corr.id, name: corr.name, produces: corr.produces, enabled: true, ...r })
  }
}

// Input corrections only: STW and leeway from raw STW and heel. Used on its own to
// republish corrected STW as soon as the paddlewheel reports.
function correctInputs (input, config) {
  const c = { stw: input.stw, heel: input.heel ?? null, leeway: 0 }
  const steps = []
  runStage('input', c, config, steps)
  return { c, steps }
}

// input: { awa, aws, stw, heel?, headingMagnetic?, headingTrue?, variation?, sog?, cog? }
// returns { out: { stw, leeway, twa, tws, heading?, twd?, current?, groundWind? }, steps }
function process (input, config) {
  const { c, steps } = correctInputs(input, config)

  // True wind: apparent wind minus the boat's velocity through the water, along the
  // heading. Leeway is left out, as on the H5000 by default: the TWA table takes up its
  // effect. Leeway still turns the water track for current.
  const a = rad(input.awa)
  const x = input.aws * Math.cos(a) - c.stw
  const y = input.aws * Math.sin(a)
  c.twa = deg(Math.atan2(y, x))
  c.tws = Math.hypot(x, y)
  steps.push({
    id: 'truewind',
    produces: ['twa', 'tws'],
    name: 'True wind, before tables',
    enabled: true,
    input: `AWA ${Math.abs(input.awa).toFixed(1)}° · ${input.aws.toFixed(1)} kn`,
    detail: 'apparent wind − boat velocity along the heading',
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

      // Ground wind: the wind over the ground, which is true wind (over the water) plus the
      // current carrying that water. Built on the corrected TWD and TWS, so the tables apply
      // to it too. Directions are where the wind comes from; set is where the current goes.
      const to = rad(out.twd + 180)
      const ge = c.tws * Math.sin(to) + e
      const gn = c.tws * Math.cos(to) + n
      const gwd = norm360(deg(Math.atan2(ge, gn)) + 180)
      out.groundWind = { speed: Math.hypot(ge, gn), direction: gwd, angle: norm180(gwd - heading) }
      steps.push({
        id: 'groundwind',
        produces: ['groundWind'],
        name: 'Ground wind',
        enabled: true,
        input: `TWD ${out.twd.toFixed(0)}° · ${c.tws.toFixed(1)} kn`,
        detail: 'true wind + current',
        output: `${out.groundWind.direction.toFixed(0)}° · ${out.groundWind.speed.toFixed(1)} kn`
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

// ---- file format version -----------------------------------------------------
//
// Every saved config carries `schema`, the version of its shape. Schema 6 (0.2.12 on) is
// the H5000's 2018 layout with a 1 kn column added to the boat speed table: heel rows each
// side x 1, 2.5 to 15 kn of boat speed (a paddlewheel stalls below about 2 kn, and from 2.5
// alone a straight line to zero under-corrects there), the TWA and TWS tables by 5 to 30 kn
// of TWS. Schema 5 (0.2.7 to 0.2.11) lacked the 1 kn column: its boat speed table is given
// one that keeps it working exactly as before (addSlowColumn), and a notice asks for a
// refit. Earlier files keep their settings and leeway K, and any table whose layout still
// fits; the rest are reset to the defaults (a fit for one layout is not a fit for another)
// and the plugin goes to Shadow mode until they are refitted and saved. Schema 4 (0.2.6) had
// the TWA table by 2.5 to 15 kn; schema 3 (0.1.0 to 0.2.5) every table in another layout.
// Older files are refused, and so is a file from a newer release, rather than guessed at.

const CONFIG_SCHEMA = 6
const KEPT_FROM = { 3: ['leeway'], 4: ['stw', 'leeway', 'tws'] } // corrections that keep their layout
const TABLE_NAMES = { stw: 'boat speed', twa: 'TWA', tws: 'TWS' }

// A boat speed table saved without the 1 kn column, given one: the value its straight line
// to zero gave at 1 kn, and its first column filled if blank, so every lookup is unchanged.
function addSlowColumn (t) {
  if (!isPlainObject(t) || !Array.isArray(t.stw) || !Array.isArray(t.add) || t.stw[0] === AXES.stwSpeed[0]) return t
  if (!t.add.every(r => Array.isArray(r) && r.length === t.stw.length)) return t // normalizeConfig reports it
  const filled = fillGaps(t.add)
  const add = t.add.map((row, i) => row.every(v => v == null)
    ? [null].concat(row)
    : [Math.round(filled[i][0] * AXES.stwSpeed[0] / t.stw[0] * 1000) / 1000, filled[i][0]].concat(row.slice(1)))
  return { ...t, stw: [AXES.stwSpeed[0]].concat(t.stw), add }
}

function moveForward (raw) {
  const keep = KEPT_FROM[raw.schema]
  const c = isPlainObject(raw.corrections) ? raw.corrections : {}
  const reset = Object.keys(TABLE_NAMES).filter(k => !keep.includes(k)).map(k => TABLE_NAMES[k])
  const list = reset.length > 1 ? `${reset.slice(0, -1).join(', ')} and ${reset[reset.length - 1]} tables` : `${reset[0]} table`
  return {
    raw: { ...raw, schema: CONFIG_SCHEMA, mode: 'shadow', corrections: Object.fromEntries(keep.filter(k => isPlainObject(c[k])).map(k => [k, c[k]])) },
    notice: `Upgraded from an earlier release: settings kept; the ${list} reset to the defaults in the new layout, and Shadow mode on. Refit with boatcal plugincal and Save`
  }
}

function checkSchema (raw) {
  const v = raw.schema
  if (v === CONFIG_SCHEMA) return null
  if (Number.isInteger(v) && v > CONFIG_SCHEMA) return `schema ${v} was saved by a newer version of this plugin (this one reads ${CONFIG_SCHEMA}); update the plugin`
  return `schema ${v} has the tables of an earlier release (a different layout): Reset to defaults, refit with boatcal plugincal, and Save`
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
  let raw = isPlainObject(input) ? { schema: CONFIG_SCHEMA, ...input } : { schema: CONFIG_SCHEMA }
  const notices = []
  if (raw.schema === 5) {
    const c = isPlainObject(raw.corrections) ? raw.corrections : {}
    raw = { ...raw, schema: CONFIG_SCHEMA, corrections: c.stw ? { ...c, stw: addSlowColumn(c.stw) } : c }
    if (c.stw) notices.push('Upgraded from an earlier release: the boat speed table has a new 1 kn column, set so it works as before. Refit it with boatcal plugincal to use it, and Save')
  }
  if (KEPT_FROM[raw.schema]) {
    const m = moveForward(raw); raw = m.raw; notices.push(m.notice)
    if (raw.corrections.stw) raw.corrections.stw = addSlowColumn(raw.corrections.stw)
  }
  const bad = checkSchema(raw)
  if (bad) return { config: { ...clone(DEFAULTS), schema: CONFIG_SCHEMA }, errors: [bad], notices }
  // Source names are text even when they look numeric.
  const keepText = { sources: raw.sources, mode: raw.mode }
  const config = merge({ schema: CONFIG_SCHEMA, ...DEFAULTS }, { ...coerce(raw), ...Object.fromEntries(Object.entries(keepText).filter(([, v]) => v !== undefined)) })
  const errors = []
  // Each section must be an object before anything inside it is checked: a null (as
  // merge keeps it) would otherwise be read as one.
  const sections = [['sources', config.sources], ['damping', config.damping], ['corrections', config.corrections]]
    .concat(Object.keys(DEFAULTS.corrections).map(id => [`corrections.${id}`, config.corrections && config.corrections[id]]))
  for (const [label, v] of sections) if (!isPlainObject(v)) errors.push(`${label}: must be an object`)
  if (errors.length) return { config: { ...clone(DEFAULTS), schema: CONFIG_SCHEMA }, errors, notices }
  const k = config.corrections

  if (!['shadow', 'replace'].includes(config.mode)) errors.push('mode: must be shadow or replace')
  checkNumber(errors, 'variation', config.variation)
  if (Math.abs(config.variation) > 180) errors.push('variation: must be between -180 and 180 degrees')
  if (!Object.values(config.sources).every(v => typeof v === 'string')) errors.push('sources: each must be a source name, or blank for Auto')

  const fixedAxis = (label, xs, axis, layout = 'the H5000 layout') => {
    if (!Array.isArray(xs) || xs.length !== axis.length || xs.some((v, i) => v !== axis[i])) errors.push(`${label}: must be ${axis.join(', ')} (${layout})`)
  }
  fixedAxis('STW table heel rows', k.stw.heel, AXES.stwHeel)
  fixedAxis('STW table boat speed columns', k.stw.stw, AXES.stwSpeed, 'the H5000 layout, with a 1 kn column')
  const g = k.stw.add
  if (!Array.isArray(g) || g.length !== AXES.stwHeel.length) errors.push('STW table: needs one row per heel angle')
  else {
    g.forEach((row, i) => checkRow(errors, `STW table heel ${AXES.stwHeel[i]}° row`, row, AXES.stwSpeed.length, true))
    if (!g.some(r => Array.isArray(r) && r.some(v => v !== null))) errors.push('STW table: has no values at all')
  }

  checkNumber(errors, 'Leeway K', k.leeway.k)

  const dmp = config.damping
  for (const [key, label, max] of [['heelS', 'Heel damping', 30], ['headingS', 'Heading damping', 30], ['trueWindS', 'True wind damping', 30], ['stwS', 'STW damping', 30], ['currentS', 'Current damping', 120]]) {
    const v = dmp[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) errors.push(`${label}: must be between 0 and ${max} seconds`)
  }

  fixedAxis('TWA table TWS columns', k.twa.tws, AXES.twaTws)
  for (const row of ['upwind', 'reach', 'downwind']) checkRow(errors, `TWA table ${AXES.twaRows[row]}° row`, k.twa[row], AXES.twaTws.length, true)
  // Corrections smaller than the taper keep corrected TWA moving the same way as
  // uncorrected TWA near head to wind and dead downwind (see TWA_TAPER_UP_DEG).
  const within = (row, lim) => (k.twa[row] || []).every(v => v == null || typeof v !== 'number' || Math.abs(v) < lim)
  if (!within('upwind', TWA_TAPER_UP_DEG)) errors.push(`TWA table ${AXES.twaRows.upwind}° row: values must be within ±${TWA_TAPER_UP_DEG - 0.1}°`)
  if (!within('downwind', TWA_TAPER_DOWN_DEG)) errors.push(`TWA table ${AXES.twaRows.downwind}° row: values must be within ±${TWA_TAPER_DOWN_DEG - 0.1}°`)

  fixedAxis('TWS table TWS columns', k.tws.tws, AXES.twsTws)
  for (const row of ['upwind', 'reach', 'downwind']) checkRow(errors, `TWS table ${row} row`, k.tws[row], AXES.twsTws.length, true)
  // Up angle < 90 < down angle: the correction then blends everywhere and never steps.
  checkRow(errors, 'TWS table up angle row', k.tws.upAngle, AXES.twsTws.length, false)
  checkRow(errors, 'TWS table down angle row', k.tws.downAngle, AXES.twsTws.length, false)
  const angles = (row, ok) => Array.isArray(k.tws[row]) && k.tws[row].every(v => typeof v !== 'number' || ok(v))
  if (!angles('upAngle', v => v >= 0 && v < REACH_DEG)) errors.push(`TWS table up angle row: each must be below ${REACH_DEG}° (the upwind correction applies in full up to it, the reaching correction at ${REACH_DEG}°)`)
  if (!angles('downAngle', v => v > REACH_DEG && v <= 180)) errors.push(`TWS table down angle row: each must be above ${REACH_DEG}° and at most 180° (the downwind correction applies in full from it)`)

  for (const [id, c] of Object.entries(k)) {
    if (typeof c.enabled !== 'boolean') errors.push(`${id}: enabled must be true or false`)
  }
  return { config, errors, notices }
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
  TWA_TAPER_UP_DEG,
  TWA_TAPER_DOWN_DEG,
  _internals: { stwGridLookup, twaTaper, tableLookup } // for the tests, and boatcal plugincal's pipeline.js
}
