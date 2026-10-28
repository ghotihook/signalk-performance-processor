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

const MAX_LEEWAY_DEG = 15
const MIN_LEEWAY_STW_KN = 1 // below this K x heel / STW^2 blows up; no leeway

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

// Upwind row in full up to angles.upwind, reach row at angles.reach, downwind row from
// angles.downwind, linear in |TWA| between.
function blendRows (absTwa, angles, up, reach, down) {
  if (absTwa <= angles.upwind) return up
  if (absTwa <= angles.reach) return up + (reach - up) * (absTwa - angles.upwind) / (angles.reach - angles.upwind)
  if (absTwa <= angles.downwind) return reach + (down - reach) * (absTwa - angles.reach) / (angles.downwind - angles.reach)
  return down
}

function tableLookup (table, angles, absTwa, tws) {
  return blendRows(absTwa, angles,
    interp(table.tws, table.upwind, tws),
    interp(table.tws, table.reach, tws),
    interp(table.tws, table.downwind, tws))
}

const fmt = (v, d = 1) => (v > 0 ? '+' : '') + v.toFixed(d)

const CORRECTIONS = [
  {
    id: 'stw',
    stage: 'input',
    name: 'Boat speed (STW)',
    apply (c, cfg) {
      // Linearity starts at its first bin; below that taper to zero at 0 kn, so a
      // stopped boat is not given speed.
      const lin = cfg.linearity
      const add1 = c.stw < lin.stw[0]
        ? lin.add[0] * Math.max(0, c.stw) / lin.stw[0]
        : interp(lin.stw, lin.add, c.stw)
      const add2 = c.heel == null ? 0 : interp(cfg.heel.heel, cfg.heel.add, Math.abs(c.heel))
      const before = c.stw
      c.stw = Math.max(0, c.stw + add1 + add2)
      return {
        input: `${before.toFixed(2)} kn` + (c.heel == null ? '' : ` · heel ${Math.abs(c.heel).toFixed(0)}°`),
        detail: `${fmt(add1, 2)} linearity, ${fmt(add2, 2)} heel` + (c.heel == null ? ' (no heel data)' : ''),
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
      c.leeway = c.stw < MIN_LEEWAY_STW_KN
        ? 0
        : Math.max(-MAX_LEEWAY_DEG, Math.min(MAX_LEEWAY_DEG, k * c.heel / (c.stw * c.stw)))
      return {
        input: `heel ${c.heel.toFixed(0)}°`,
        detail: `K ${k} × heel ÷ STW²`,
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
      const add = tableLookup(cfg, cfg.angles, abs, c.tws)
      const before = c.twa
      c.twa = Math.sign(c.twa || 1) * Math.max(0, Math.min(180, abs + add))
      return {
        input: `TWA ${Math.abs(before).toFixed(1)}° · TWS ${c.tws.toFixed(1)}`,
        detail: `${fmt(add)}°`,
        output: `TWA ${Math.abs(c.twa).toFixed(1)}°`
      }
    }
  },
  {
    id: 'tws',
    stage: 'trueWind',
    name: 'TWS table',
    apply (c, cfg, all) {
      const pct = tableLookup(cfg, all.corrections.twa.angles, Math.abs(c.twa), c.tws)
      const before = c.tws
      c.tws = c.tws * (1 + pct / 100)
      return {
        input: `TWS ${before.toFixed(1)} kn`,
        detail: `${fmt(pct)}%`,
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
    const r = corr.apply(c, cfg, config)
    steps.push({ id: corr.id, name: corr.name, enabled: true, ...r })
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

// input: { awa, aws, stw, heel?, headingMagnetic?, headingTrue?, sog?, cog? }
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
    name: 'True wind',
    enabled: true,
    input: `AWA ${Math.abs(input.awa).toFixed(1)}° · ${input.aws.toFixed(1)} kn`,
    detail: 'apparent wind − boat velocity',
    output: `TWA ${Math.abs(c.twa).toFixed(1)}° · ${c.tws.toFixed(1)} kn`
  })

  runStage('trueWind', c, config, steps)

  const out = { stw: c.stw, leeway: c.leeway, twa: c.twa, tws: c.tws }

  const heading = input.headingTrue != null
    ? input.headingTrue
    : input.headingMagnetic != null ? input.headingMagnetic + config.variation : null
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

function checkAxis (errors, label, xs) {
  if (!Array.isArray(xs) || xs.length < 1) { errors.push(`${label}: needs at least one value`); return }
  if (xs.some(v => typeof v !== 'number' || !Number.isFinite(v))) { errors.push(`${label}: every value must be a number`); return }
  for (let i = 1; i < xs.length; i++) {
    if (!(xs[i] > xs[i - 1])) { errors.push(`${label}: must increase from left to right`); return }
  }
}

function checkRow (errors, label, ys, n) {
  if (!Array.isArray(ys) || ys.length !== n) { errors.push(`${label}: needs ${n} values, one per column`); return }
  if (ys.some(v => typeof v !== 'number' || !Number.isFinite(v))) errors.push(`${label}: every value must be a number`)
}

function checkNumber (errors, label, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${label}: must be a number`)
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
  const raw = isPlainObject(input) ? clone(input) : {}
  // Source names are text even when they look numeric.
  const keepText = { sources: raw.sources, mode: raw.mode }
  const config = merge(DEFAULTS, { ...coerce(raw), ...Object.fromEntries(Object.entries(keepText).filter(([, v]) => v !== undefined)) })
  const errors = []
  const k = config.corrections

  if (!['shadow', 'replace'].includes(config.mode)) errors.push('mode: must be shadow or replace')
  checkNumber(errors, 'variation', config.variation)

  checkAxis(errors, 'STW linearity speeds', k.stw.linearity.stw)
  checkRow(errors, 'STW linearity values', k.stw.linearity.add, (k.stw.linearity.stw || []).length)
  checkAxis(errors, 'STW heel angles', k.stw.heel.heel)
  checkRow(errors, 'STW heel values', k.stw.heel.add, (k.stw.heel.heel || []).length)
  if (Array.isArray(k.stw.linearity.stw) && !(k.stw.linearity.stw[0] > 0)) errors.push('STW linearity speeds: must start above 0 kn')

  checkNumber(errors, 'Leeway K', k.leeway.k)

  for (const id of ['twa', 'tws']) {
    const t = k[id]
    const name = id.toUpperCase() + ' table'
    checkAxis(errors, `${name} TWS columns`, t.tws)
    for (const row of ['upwind', 'reach', 'downwind']) checkRow(errors, `${name} ${row} row`, t[row], (t.tws || []).length)
  }
  const ang = k.twa.angles
  ;['upwind', 'reach', 'downwind'].forEach(r => checkNumber(errors, `TWA table ${r} angle`, ang[r]))
  if (!(ang.upwind < ang.reach && ang.reach < ang.downwind && ang.upwind > 0 && ang.downwind < 180)) {
    errors.push('TWA table angles: need 0 < upwind < reach < downwind < 180')
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
  _internals: { interp, blendRows, tableLookup, merge, norm180 }
}
