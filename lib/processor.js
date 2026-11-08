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
// The tables' lookup and text format, shared with the webapp.
const T = require('../public/tables')
const { lookup, fillGaps, checkAxis } = T

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

// Every table is a grid (tables.js): along each row by speed from zero at 0 kn, linear
// between rows, the end rows held beyond them. Blank cells take the value to their left
// (fillGaps), worked out once per table.
const filledCache = new WeakMap()
function filled (t) {
  let f = filledCache.get(t)
  if (!f) { f = fillGaps(t.add); filledCache.set(t, f) }
  return f
}

// Boat speed / heel: rows by heel (+ = starboard side down), columns by boat speed.
const stwGridLookup = (t, heel, stw) => lookup(t.heel, t.stw, filled(t), heel, stw)
// TWA and TWS tables: rows by |TWA|, columns by TWS.
const tableLookup = (t, absTwa, tws) => lookup(t.twa, t.tws, filled(t), absTwa, tws)

const fmt = (v, d = 1) => (v > 0 ? '+' : '') + v.toFixed(d)

const CORRECTIONS = [
  {
    id: 'stw',
    stage: 'input',
    name: 'Boat speed (STW)',
    apply (c, cfg) {
      const add = stwGridLookup(cfg, c.heel == null ? 0 : c.heel, c.stw)
      const before = c.stw
      c.stw = Math.max(0, c.stw + add)
      return {
        input: `${before.toFixed(2)} kn` + (c.heel == null ? ' · no heel data, upright row used' : ` · heel ${Math.abs(c.heel).toFixed(0)}° ${c.heel < 0 ? 'port' : 'stbd'}`),
        detail: `${fmt(add, 2)} kn from the boat speed / heel table` + (before < cfg.stw[0] ? ' (towards nothing at 0 kn)' : ''),
        output: `${c.stw.toFixed(2)} kn`
      }
    }
  },
  {
    id: 'leeway',
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
    stage: 'trueWind',
    name: 'TWA table',
    apply (c, cfg) {
      const abs = Math.abs(c.twa)
      const table = tableLookup(cfg, abs, c.tws)
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
    stage: 'trueWind',
    name: 'TWS table',
    apply (c, cfg) {
      const add = tableLookup(cfg, Math.abs(c.twa), c.tws)
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
      steps.push({ id: corr.id, name: corr.name, enabled: false })
      continue
    }
    const r = corr.apply(c, cfg)
    steps.push({ id: corr.id, name: corr.name, enabled: true, ...r })
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
// Every saved config carries `schema`, the version of its shape. Schema 7 (0.3.0 on): every
// table is a grid that carries its own axes (tables.js), so a table can be as coarse or as
// fine as its data allows. Schema 6 (0.2.12 to 0.2.17) was the H5000's 2018 layout with a
// 1 kn boat speed column, its TWA and TWS tables in three rows blended by TWA: each becomes
// the grid that looks up the same (twaFromRows, twsFromRows), so it works as before.
// Schema 5 (0.2.7 to 0.2.11) lacked the 1 kn column: its boat speed table is given one that
// keeps it working exactly as before (addSlowColumn), and a notice asks for a refit. Earlier
// files keep their settings and leeway K, and any table whose layout still fits; the rest
// are reset to the defaults (a fit for one layout is not a fit for another) and the plugin
// goes to Shadow mode until they are refitted and saved. Schema 4 (0.2.6) had the TWA table
// by 2.5 to 15 kn; schema 3 (0.1.0 to 0.2.5) every table in another layout. Older files are
// refused, and so is a file from a newer release, rather than guessed at.

const CONFIG_SCHEMA = 7
// The three tables: their name in errors, in upgrade notices, and a row's label.
const TABLES = {
  stw: { name: 'STW table', short: 'boat speed', row: v => `heel ${v}°` },
  twa: { name: 'TWA table', short: 'TWA', row: v => `${v}° TWA` },
  tws: { name: 'TWS table', short: 'TWS', row: v => `${v}° TWA` }
}
const KEPT_FROM = { 3: ['leeway'], 4: ['stw', 'leeway', 'tws'] } // corrections that keep their layout
const SLOW_KN = 1 // the boat speed column schema 6 added

// A boat speed table saved without the 1 kn column, given one: the value its straight line
// to zero gave at 1 kn, and its first column filled if blank, so every lookup is unchanged.
function addSlowColumn (t) {
  if (!isPlainObject(t) || !Array.isArray(t.stw) || !Array.isArray(t.add) || t.stw[0] === SLOW_KN) return t
  if (!t.add.every(r => Array.isArray(r) && r.length === t.stw.length)) return t // normalizeConfig reports it
  const filled = fillGaps(t.add)
  const add = t.add.map((row, i) => row.every(v => v == null)
    ? [null].concat(row)
    : [Math.round(filled[i][0] * SLOW_KN / t.stw[0] * 1000) / 1000, filled[i][0]].concat(row.slice(1)))
  return { ...t, stw: [SLOW_KN].concat(t.stw), add }
}

// Schema 3 and 4 to schema 6.
function moveForward (raw) {
  const keep = KEPT_FROM[raw.schema]
  const c = isPlainObject(raw.corrections) ? raw.corrections : {}
  const reset = Object.keys(TABLES).filter(k => !keep.includes(k)).map(k => TABLES[k].short)
  const list = reset.length > 1 ? `${reset.slice(0, -1).join(', ')} and ${reset[reset.length - 1]} tables` : `${reset[0]} table`
  return {
    raw: { ...raw, schema: 6, mode: 'shadow', corrections: Object.fromEntries(keep.filter(k => isPlainObject(c[k])).map(k => [k, c[k]])) },
    notice: `Upgraded from an earlier release: settings kept; the ${list} reset to the defaults, and Shadow mode on. Refit them (README: Calibrating) and Save`
  }
}

// A schema 6 TWS table good enough to convert: rows of one length, up angle < 90 < down angle.
function tws6Valid (t) {
  const rows = ['upwind', 'reach', 'downwind', 'upAngle', 'downAngle']
  if (!Array.isArray(t.tws) || !rows.every(r => Array.isArray(t[r]) && t[r].length === t.tws.length)) return false
  const num = v => typeof v === 'number' && Number.isFinite(v)
  return t.upAngle.every(v => num(v) && v >= 0 && v < T.REACH_DEG) && t.downAngle.every(v => num(v) && v > T.REACH_DEG && v <= 180)
}

// Schema 6 to schema 7: the TWA and TWS tables' three rows become grids that look up the same.
function toGrids (raw) {
  const c = isPlainObject(raw.corrections) ? { ...raw.corrections } : {}
  const rows6 = t => isPlainObject(t) && ['upwind', 'reach', 'downwind', 'upAngle', 'downAngle'].some(k => k in t)
  const notices = []
  let moved = false
  if (rows6(c.twa)) { c.twa = { enabled: c.twa.enabled, ...T.twaFromRows(c.twa) }; moved = true }
  if (rows6(c.tws)) {
    if (tws6Valid(c.tws)) {
      const { exact, table } = T.twsFromRows(c.tws)
      c.tws = { enabled: c.tws.enabled, ...table }
      moved = true
      if (!exact) notices.push('Upgraded from an earlier release: the TWS table\'s up and down angles changed with TWS, so it is now a grid with a row at each of those angles. It is the same at each TWS column and close between them: refit it and Save')
    } else {
      delete c.tws
      notices.push('Upgraded from an earlier release: the TWS table could not be read in the earlier layout, so it is reset to the defaults. Refit it and Save')
    }
  }
  if (moved && !notices.length) notices.push('Upgraded from an earlier release: the TWA and TWS tables are now grids with rows by TWA, and work exactly as before. Save to keep them in the new format')
  return { raw: { ...raw, schema: CONFIG_SCHEMA, corrections: c }, notices }
}

function checkSchema (raw) {
  const v = raw.schema
  if (v === CONFIG_SCHEMA) return null
  if (Number.isInteger(v) && v > CONFIG_SCHEMA) return `schema ${v} was saved by a newer version of this plugin (this one reads ${CONFIG_SCHEMA}); update the plugin`
  return `schema ${v} has the tables of an earlier release (a different layout): Reset to defaults, refit (README: Calibrating), and Save`
}

// Earlier schemas moved forward one step at a time, with what to tell the user.
function upgrade (raw) {
  const notices = []
  if (raw.schema === 5) {
    const c = isPlainObject(raw.corrections) ? raw.corrections : {}
    raw = { ...raw, schema: 6, corrections: c.stw ? { ...c, stw: addSlowColumn(c.stw) } : c }
    if (c.stw) notices.push('Upgraded from an earlier release: the boat speed table has a new 1 kn column, set so it works as before. Refit it (README: Calibrating) to use it, and Save')
  }
  if (KEPT_FROM[raw.schema]) {
    const m = moveForward(raw); raw = m.raw; notices.push(m.notice)
    if (raw.corrections.stw) raw.corrections.stw = addSlowColumn(raw.corrections.stw)
  }
  if (raw.schema === 6) {
    const g = toGrids(raw); raw = g.raw
    // After a notice that already asks for a refit, saying the tables work as before is noise.
    if (!notices.length) notices.push(...g.notices)
  }
  return { raw, notices }
}

// ---- checking the tables -------------------------------------------------------


// Axes, then a row of values per row and a value (or blank) per column. True if sound.
function checkTable (errors, id, t) {
  const { name, row } = TABLES[id]
  const k = T.KINDS[id]
  const n = errors.length
  const extra = Object.keys(t).filter(key => !['enabled', k.rows, k.cols, 'add'].includes(key))
  if (extra.length) errors.push(`${name}: unknown field${extra.length > 1 ? 's' : ''} ${extra.join(', ')} (a table is its ${k.rows} rows, ${k.cols} columns and add)`)
  for (const axis of [k.rows, k.cols]) {
    const e = checkAxis(axis, t[axis])
    if (e) errors.push(`${name} ${e}`)
  }
  if (errors.length > n) return false
  if (!Array.isArray(t.add) || t.add.length !== t[k.rows].length) {
    errors.push(`${name}: needs ${t[k.rows].length} rows of values, one per ${T.AXIS_RANGE[k.rows].what.replace(/ rows$/, '')} row`)
    return false
  }
  t.add.forEach((r, i) => checkRow(errors, `${name} ${row(t[k.rows][i])} row`, r, t[k.cols].length, true))
  return errors.length === n
}

// The TWA table must keep corrected TWA moving the same way as TWA, and no more than twice
// as fast, at every TWS. Corrected |TWA| is a + taper(a)·table(a), whose slope along a is
// 1 + taper'(a)·table(a) + taper(a)·table'(a). Between the rows and the taper's corners
// both are straight lines, so the slope is a straight line too: within its limits at both
// ends of each piece, it is within them throughout. Between TWS columns the table is a
// mix of the columns either side (and below the first, of that column and none), so
// checking each column is enough. For rows at 40 and 165 this is the H5000-style limit:
// within ±30° upwind and ±10° downwind (the taper).
const TWA_SLOPE_MAX = 2
function twaTooSteep (t) {
  const f = fillGaps(t.add)
  const knots = Array.from(new Set([0, TWA_TAPER_UP_DEG, 180 - TWA_TAPER_DOWN_DEG, 180].concat(t.twa.filter(a => a > 0 && a < 180)))).sort((a, b) => a - b)
  for (let j = 0; j < t.tws.length; j++) {
    const col = f.map(r => r[j])
    const table = a => T.interp(t.twa, col, a)
    for (let i = 0; i + 1 < knots.length; i++) {
      const [a0, a1] = [knots[i], knots[i + 1]]
      const dTable = (table(a1) - table(a0)) / (a1 - a0)
      const dTaper = (twaTaper(a1) - twaTaper(a0)) / (a1 - a0)
      for (const a of [a0, a1]) {
        const slope = 1 + dTaper * table(a) + twaTaper(a) * dTable
        if (!(slope > 0 && slope < TWA_SLOPE_MAX)) return { tws: t.tws[j], from: a0, to: a1, backwards: slope <= 0 }
      }
    }
  }
  return null
}

// Merge a stored or submitted config over the defaults and check it. Numbers typed
// into a form arrive as strings, so coerce numeric-looking strings first. base: what the
// input is laid over (the defaults, unless given).
function normalizeConfig (input, base = DEFAULTS) {
  const coerce = v => {
    if (Array.isArray(v)) return v.map(coerce)
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, coerce(x)]))
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
    return v
  }
  const up = upgrade(isPlainObject(input) ? { schema: CONFIG_SCHEMA, ...input } : { schema: CONFIG_SCHEMA })
  const raw = up.raw
  const notices = up.notices
  const bad = checkSchema(raw)
  if (bad) return { config: { ...clone(DEFAULTS), schema: CONFIG_SCHEMA }, errors: [bad], notices }
  // Source names are text even when they look numeric.
  const keepText = { sources: raw.sources, mode: raw.mode }
  const config = merge({ schema: CONFIG_SCHEMA, ...base }, { ...coerce(raw), ...Object.fromEntries(Object.entries(keepText).filter(([, v]) => v !== undefined)) })
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

  if (checkTable(errors, 'stw', k.stw) && !k.stw.add.some(r => r.some(v => v !== null))) errors.push('STW table: has no values at all')

  checkNumber(errors, 'Leeway K', k.leeway.k)

  const dmp = config.damping
  // Heading damping was a setting before 0.3.2. Heading must lag as apparent wind does, and
  // apparent wind must be raw, so heading is never damped: a saved value is dropped.
  if ('headingS' in dmp) {
    const was = dmp.headingS
    delete dmp.headingS
    if (Number(was) > 0) notices.push(`Heading damping (${was} s) is no longer a setting: heading is never damped, so apparent wind must arrive undamped. Turn off wind damping at the instrument, and Save`)
  }
  for (const [key, label, max] of [['heelS', 'Heel damping', 30], ['trueWindS', 'True wind damping', 30], ['twaS', 'TWA damping', 30], ['stwS', 'STW damping', 30], ['currentS', 'Current damping', 300]]) {
    const v = dmp[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) errors.push(`${label}: must be between 0 and ${max} seconds`)
  }

  if (checkTable(errors, 'twa', k.twa)) {
    const steep = twaTooSteep(k.twa)
    if (steep) {
      errors.push(`TWA table at ${steep.tws} kn TWS, between ${steep.from}° and ${steep.to}° TWA: the correction changes too fast, so corrected TWA would ${steep.backwards ? 'go backwards as TWA goes up' : `move over ${TWA_SLOPE_MAX} times as fast as TWA`}. ` +
        `Near head to wind keep it within ±${TWA_TAPER_UP_DEG}°, near dead downwind within ±${TWA_TAPER_DOWN_DEG}°, and between rows change it by less than the rows are apart`)
    }
  }
  checkTable(errors, 'tws', k.tws)

  for (const [id, c] of Object.entries(k)) {
    if (!isPlainObject(c) || typeof c.enabled !== 'boolean') errors.push(`${id}: enabled must be true or false`)
  }
  return { config, errors, notices }
}

// A saved file that fails its checks, taken apart: each setting and each table checked on its
// own and kept if it passes, the rest from the defaults. For the webapp to show, so a boat's
// own values are fixed rather than lost; never run (the plugin stays stopped until a Save).
// Returns null for a file this release must not touch (a newer schema).
const SALVAGE_PARTS = [['mode', 'output mode'], ['variation', 'fallback variation'], ['sources', 'input sources'], ['damping', 'damping']]
  .concat(Object.keys(DEFAULTS.corrections).map(id => [`corrections.${id}`, CORRECTIONS.find(c => c.id === id).name]))
function salvage (input) {
  if (!isPlainObject(input)) return null
  const up = upgrade({ schema: CONFIG_SCHEMA, ...input })
  if (checkSchema(up.raw)) return null
  let config = { ...clone(DEFAULTS), schema: CONFIG_SCHEMA }
  const reset = []
  for (const [part, label] of SALVAGE_PARTS) {
    const [top, id] = part.split('.')
    const v = id ? (isPlainObject(up.raw.corrections) ? up.raw.corrections[id] : undefined) : up.raw[top]
    if (v === undefined) continue
    const r = normalizeConfig({ schema: CONFIG_SCHEMA, [top]: id ? { [id]: v } : v }, config)
    if (r.errors.length) reset.push(label)
    else config = r.config
  }
  return { config, reset }
}

module.exports = {
  process,
  salvage,
  correctInputs,
  normalizeConfig,
  CORRECTIONS,
  CONFIG_SCHEMA,
  MAX_LEEWAY_DEG,
  LEEWAY_FADE_KN,
  TWA_TAPER_UP_DEG,
  TWA_TAPER_DOWN_DEG,
  TWA_SLOPE_MAX,
  _internals: { stwGridLookup, twaTaper, tableLookup } // for the tests, and boatcal's pipeline.js
}
