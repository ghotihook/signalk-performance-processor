'use strict'
// Analysis (SPECIFICATION.md §12, beta): findings from the boat's sailing, a few minutes at a
// time, kept so that over many days they add up to histograms for the tables. No Signal K
// here: index.js reads the History API every few minutes and feeds the 1 Hz rows of
// lib/history.js, one per second, to a long-lived Analyst.
//
//   const a = new Analyst(finding => ..., config, { resume })
//   a.add({ t, awa, aws, stw, heel, hdg, sog, cog, variation })   hdg: true heading
//   a.safe()    { win, learn }: epoch s before which every window, and every manoeuvre and
//               leg, has been emitted. A new Analyst given it as `resume`, and fed from
//               RESUME_CONTEXT_S before the earlier of the two, carries on without repeats.
//   a.flush()   end of data (the boat stopped)
//
// Findings, never the data itself:
//   win   every WIN_S of sailing: class, stable, compliant, medians raw and corrected
//   mnv   a tack, gybe or rounding (lib/learn.js): TWD either side, raw and corrected, and
//         for a tack or gybe the TWA correction it implies
//   leg   an upwind or off-the-wind leg (lib/learn.js)
// summarise(findings, config) bins them on the tables' own axes.

const { Learner, rawTwa } = require('./learn')
const { process } = require('./processor')

const WIN_S = 120 // a window
const MIN_SHARE = 0.8 // compliant: each required input in this share of the window's seconds
const MIN_STW = 1 // kn: a good second, as lib/learn.js
const UP_DEG = 70
const OFF_DEG = 80
const DOWN_DEG = 120
// Stable: steady enough that a mean means something. Standard deviations over the window
// (or each manoeuvre window), on good seconds.
const STABLE_HDG_SD = 6 // deg
const STABLE_TWA_SD = 6 // deg, raw TWA
const STABLE_TWD_SD = 8 // deg, corrected TWD
const STABLE_STW_SD = 0.5 // kn
const STABLE_TWS_CV = 0.2 // TWS sd / mean, and a manoeuvre's TWS change / mean
const RESUME_CONTEXT_S = 420 // lib/learn.js's buffer
const PAIR_S = 20 * 60 // summarise: upwind windows this close pair with an off-wind one
const VERSION = 1 // the findings' layout

const R = Math.PI / 180
const fin = x => typeof x === 'number' && Number.isFinite(x)
const wrap180 = d => ((d + 180) % 360 + 360) % 360 - 180
const norm360 = d => (d % 360 + 360) % 360
const round = (x, d = 2) => fin(x) ? Math.round(x * 10 ** d) / 10 ** d : null
const good = r => !!r && fin(r.awa) && fin(r.aws) && fin(r.stw) && fin(r.hdg) && fin(r.heel) && r.stw > MIN_STW

// Required inputs and what each needs in a row, for compliance.
const REQUIRED = {
  apparentWind: r => fin(r.awa) && fin(r.aws),
  stw: r => fin(r.stw),
  heading: r => fin(r.hdg),
  attitude: r => fin(r.heel)
}

function mean (xs) { const v = xs.filter(fin); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
function sd (xs) {
  const v = xs.filter(fin); if (v.length < 2) return null
  const m = mean(v); return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1))
}
function median (xs) {
  const v = xs.filter(fin).sort((a, b) => a - b)
  if (!v.length) return null
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
function quantile (sorted, q) {
  if (!sorted.length) return null
  const i = (sorted.length - 1) * q; const lo = Math.floor(i); const hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}
// Circular mean and standard deviation, degrees.
function circ (deg) {
  const v = deg.filter(fin); if (!v.length) return { mean: null, sd: null }
  let s = 0; let c = 0
  for (const d of v) { s += Math.sin(d * R); c += Math.cos(d * R) }
  const len = Math.min(1, Math.hypot(s, c) / v.length)
  return { mean: Math.atan2(s, c) / R, sd: v.length > 1 ? Math.sqrt(-2 * Math.log(Math.max(len, 1e-12))) / R : null }
}

function classOf (absTwa) {
  if (!fin(absTwa)) return null
  if (absTwa < UP_DEG) return 'up'
  if (absTwa <= OFF_DEG) return 'between'
  return absTwa <= DOWN_DEG ? 'reach' : 'down'
}

// One row through the plugin's own pipeline with the tables in use.
function corrected (r, config) {
  if (!good(r)) return null
  const input = { awa: r.awa, aws: r.aws, stw: r.stw, heel: r.heel, headingTrue: r.hdg }
  if (fin(r.sog) && fin(r.cog)) { input.sog = r.sog; input.cog = r.cog }
  const { out } = process(input, config)
  return out
}

// A short hash of the tables in use, so findings can be split by the tables they were made with.
function tablesId (config) {
  const s = JSON.stringify(config.corrections)
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// A window of up to WIN_S rows (any may be missing) as a finding.
function windowFinding (t0, rows, config) {
  const present = rows.filter(Boolean)
  if (!present.length) return null
  const share = Object.fromEntries(Object.entries(REQUIRED).map(([g, ok]) => [g, present.filter(ok).length / WIN_S]))
  const g = present.filter(good)
  const why = Object.entries(share).filter(([, s]) => s < MIN_SHARE).map(([k]) => `no ${k}`)
  if (g.length / WIN_S < MIN_SHARE && !why.length) why.push(`STW ≤ ${MIN_STW} kn`)
  const raw = g.map(r => rawTwa(r))
  const out = g.map(r => corrected(r, config))
  const absTwa = median(raw.map(Math.abs))
  const cls = classOf(absTwa)
  const hdg = circ(g.map(r => r.hdg))
  const twaRaw = circ(raw)
  const twd = circ(out.map(o => o.twd))
  const tws = out.map(o => o.tws)
  const stw = g.map(r => r.stw)
  const twsMean = mean(tws)
  const why2 = []
  if (!(hdg.sd <= STABLE_HDG_SD)) why2.push('heading')
  if (!(twaRaw.sd <= STABLE_TWA_SD)) why2.push('TWA')
  if (!(twd.sd <= STABLE_TWD_SD)) why2.push('TWD')
  if (!(sd(stw) <= STABLE_STW_SD)) why2.push('STW')
  if (!(twsMean > 0 && sd(tws) / twsMean <= STABLE_TWS_CV)) why2.push('TWS')
  const cur = out.filter(o => o.current)
  const ce = mean(cur.map(o => o.current.drift * Math.sin(o.current.set * R)))
  const cn = mean(cur.map(o => o.current.drift * Math.cos(o.current.set * R)))
  return {
    type: 'win',
    t: t0,
    s: WIN_S,
    n: present.length,
    good: g.length,
    compliant: !why.length,
    why,
    cls,
    stable: !!g.length && !why2.length,
    unsteady: why2,
    side: g.length ? Math.sign(twaRaw.mean) || 1 : null,
    awa: round(circ(g.map(r => r.awa)).mean, 1),
    aws: round(median(g.map(r => r.aws))),
    stwRaw: round(median(stw)),
    heel: round(median(g.map(r => r.heel)), 1),
    hdg: round(hdg.mean === null ? null : norm360(hdg.mean), 1),
    hdgSd: round(hdg.sd, 1),
    sog: round(median(g.map(r => r.sog))),
    twaRaw: round(twaRaw.mean, 1),
    twaRawSd: round(twaRaw.sd, 1),
    twsRaw: round(median(g.map(r => { const a = r.awa * R; return Math.hypot(r.aws * Math.cos(a) - r.stw, r.aws * Math.sin(a)) }))),
    stw: round(median(out.map(o => o.stw))),
    twa: round(circ(out.map(o => o.twa)).mean, 1),
    tws: round(median(tws)),
    twsSd: round(sd(tws)),
    twd: round(twd.mean === null ? null : norm360(twd.mean), 1),
    twdSd: round(twd.sd, 1),
    leeway: round(median(out.map(o => o.leeway)), 1),
    drift: cur.length ? round(Math.hypot(ce, cn)) : null,
    set: cur.length ? round(norm360(Math.atan2(ce, cn) / R), 0) : null
  }
}

const MNV_KIND = { mnvTack: 'tack', mnvGybe: 'gybe', mnvComeUp: 'comeUp', mnvComeDown: 'comeDown' }

// A lib/learn.js manoeuvre as a finding: true wind either side, raw and with the tables.
function manoeuvreFinding (m, config) {
  const side = rows => {
    const rs = rows.map(([t, awa, aws, stw, heel, hdg]) => ({ t, awa, aws, stw, heel, hdg })).filter(good)
    const out = rs.map(r => corrected(r, config))
    const raw = rs.map(r => rawTwa(r))
    const twsRaw = rs.map(r => { const a = r.awa * R; return Math.hypot(r.aws * Math.cos(a) - r.stw, r.aws * Math.sin(a)) })
    const twd = circ(out.map(o => o.twd))
    return {
      n: rs.length,
      twaRaw: circ(raw).mean,
      twsRaw: mean(twsRaw),
      twdRaw: circ(rs.map((r, i) => r.hdg + raw[i])).mean,
      twa: circ(out.map(o => o.twa)).mean,
      tws: mean(out.map(o => o.tws)),
      twd: twd.mean,
      twdSd: twd.sd,
      stw: mean(rs.map(r => r.stw))
    }
  }
  const b = side(m.before); const a = side(m.after)
  const kind = MNV_KIND[m.kind]
  const step = wrap180(a.twd - b.twd)
  const stepRaw = wrap180(a.twdRaw - b.twdRaw)
  const tws = (b.tws + a.tws) / 2
  const why = []
  if (!(b.twdSd <= STABLE_TWD_SD && a.twdSd <= STABLE_TWD_SD)) why.push('TWD')
  if (!(Math.abs(a.tws - b.tws) / tws <= STABLE_TWS_CV)) why.push('TWS')
  const f = {
    type: 'mnv',
    t: m.t,
    kind,
    from: m.s, // side before: + starboard tack
    compliant: true, // lib/learn.js keeps only manoeuvres with good data both sides
    why: [],
    stable: !why.length,
    unsteady: why,
    twaBefore: round(b.twa, 1),
    twaAfter: round(a.twa, 1),
    twaRawBefore: round(b.twaRaw, 1),
    twaRawAfter: round(a.twaRaw, 1),
    tws: round(tws),
    twsBefore: round(b.tws),
    twsAfter: round(a.tws),
    twsRaw: round((b.twsRaw + a.twsRaw) / 2),
    stw: round((b.stw + a.stw) / 2),
    twdBefore: round(norm360(b.twd), 1),
    twdAfter: round(norm360(a.twd), 1),
    step: round(step, 1),
    stepRaw: round(stepRaw, 1)
  }
  // A tack or gybe crosses at the same |TWA| either side: TWD reads TWD + s·e on side s
  // when |TWA| reads e too wide, so the step is −2·s·e and the table needs s·step / 2 more.
  if (kind === 'tack' || kind === 'gybe') {
    f.absTwa = round((Math.abs(b.twa) + Math.abs(a.twa)) / 2, 1)
    f.absTwaRaw = round((Math.abs(b.twaRaw) + Math.abs(a.twaRaw)) / 2, 1)
    f.twaAdd = round(m.s * step / 2, 2) // more on top of the tables in use
    f.twaAddRaw = round(m.s * stepRaw / 2, 2) // from no tables at all
  }
  return f
}

class Analyst {
  constructor (emit, config, { resume = null } = {}) {
    this.resume = { win: -Infinity, learn: -Infinity, ...(resume || {}) }
    this.config = config
    this.tables = tablesId(config)
    this.out = f => {
      if (f.t < (f.type === 'win' ? this.resume.win : this.resume.learn)) return
      emit({ v: VERSION, tables: this.tables, ...f })
    }
    this.learner = new Learner(r => this.learned(r))
    this.win = null // { t0, rows: [] }
    this.last = null
  }

  setConfig (config) { this.config = config; this.tables = tablesId(config) }

  learned (r) {
    if (r.type === 'mnv') this.out(manoeuvreFinding(r, this.config))
    else if (r.type === 'leg') this.out({ type: 'leg', t: r.t0, kind: r.kind, t1: r.t1, n: r.n, compliant: true, stable: true })
  }

  add (row) {
    const t = Math.floor(row.t)
    if (this.last != null && t <= this.last) return
    const w0 = Math.floor(t / WIN_S) * WIN_S
    if (this.win && this.win.t0 !== w0) this.closeWindow()
    if (!this.win) this.win = { t0: w0, rows: new Array(WIN_S).fill(null) }
    this.win.rows[t - w0] = row
    this.last = t
    this.learner.add({ ...row, t })
  }

  closeWindow () {
    const w = this.win
    this.win = null
    if (!w) return
    const f = windowFinding(w.t0, w.rows, this.config)
    if (f) this.out(f)
  }

  flush () {
    this.closeWindow()
    this.learner.flush()
  }

  // Before these, everything has been emitted: windows before the open one, manoeuvres and
  // legs before the learner's next minute. A leg still open is not held back for: one that
  // spans a restart is lost.
  safe () {
    const l = this.learner
    const end = this.last != null ? this.last + 1 : null
    return {
      win: this.win ? this.win.t0 : end,
      learn: l.next != null && l.last != null && l.next <= l.last ? l.next : end
    }
  }
}

// ---- summarising findings ----------------------------------------------------------------

// The index of the axis value nearest x (each cell is the table's own point).
function binOf (axis, x) {
  if (!fin(x) || !axis || !axis.length) return null
  let best = 0
  for (let i = 1; i < axis.length; i++) if (Math.abs(axis[i] - x) < Math.abs(axis[best] - x)) best = i
  return best
}

function stats (xs) {
  const v = xs.filter(fin).sort((a, b) => a - b)
  return { n: v.length, median: round(quantile(v, 0.5)), p25: round(quantile(v, 0.25)), p75: round(quantile(v, 0.75)) }
}

// A grid on a table's axes (rows |TWA|, columns TWS) of the stats of each cell's values.
function grid (table, items) {
  const cells = table.twa.map(() => table.tws.map(() => []))
  for (const [absTwa, tws, v] of items) {
    const i = binOf(table.twa, absTwa); const j = binOf(table.tws, tws)
    if (i !== null && j !== null && fin(v)) cells[i][j].push(v)
  }
  return {
    twa: table.twa.slice(),
    tws: table.tws.slice(),
    cells: cells.map((row, i) => row.map((vs, j) => vs.length ? { ...stats(vs), table: table.add[i][j] } : null))
  }
}

// findings: as written, in any order. The corrections still needed (twa, tws) use only the
// findings made with the tables in use (or options.tables); twaRaw, the whole TWA table from
// no tables at all, uses every finding.
function summarise (findings, config, options = {}) {
  const all = findings.filter(f => f && f.v === VERSION)
  const id = options.tables || tablesId(config)
  const fs = all.filter(f => f.tables === id)
  const counts = {}
  const bump = (...k) => { const key = k.join(' '); counts[key] = (counts[key] || 0) + 1 }
  for (const f of all) {
    const kind = f.type === 'win' ? (f.cls || 'none') : f.kind
    bump(f.type, kind, f.compliant ? 'compliant' : 'noncompliant', f.stable ? 'stable' : 'unstable')
  }
  const k = config.corrections
  const use = f => f.compliant && f.stable

  // TWA: what each tack and gybe says the table needs on top of what it holds.
  const mnv = fs.filter(f => f.type === 'mnv' && fin(f.twaAdd) && use(f))
  const twa = grid(k.twa, mnv.map(f => [f.absTwa, f.tws, f.twaAdd]))
  const twaRaw = grid(k.twa, all.filter(f => f.type === 'mnv' && fin(f.twaAddRaw) && use(f)).map(f => [f.absTwaRaw, f.twsRaw, f.twaAddRaw]))

  // TWS: each steady off-wind window against the steady upwind windows within PAIR_S of it
  // (the wind the beats measured), band by band of |TWA|, as boatcal's legs.
  const wins = fs.filter(f => f.type === 'win' && use(f)).sort((a, b) => a.t - b.t)
  const up = wins.filter(f => f.cls === 'up')
  const pairs = []
  for (const f of wins) {
    if (f.cls !== 'reach' && f.cls !== 'down') continue
    const near = up.filter(u => Math.abs(u.t - f.t) <= PAIR_S && u.tables === f.tables)
    if (!near.length) continue
    pairs.push([Math.abs(f.twa), f.tws, mean(near.map(u => u.tws)) - f.tws])
  }
  const tws = grid(k.tws, pairs)

  const times = all.map(f => f.t)
  return {
    findings: all.length,
    withTables: fs.length,
    from: times.length ? Math.min(...times) : null,
    to: times.length ? Math.max(...times) : null,
    tables: id,
    counts,
    twa: { note: 'degrees more to add to the TWA table, from tacks and gybes (compliant, stable)', ...twa },
    twaRaw: { note: 'the whole TWA table from tacks and gybes with no tables (raw |TWA| and TWS), every finding (compliant, stable); its table column is the table in use', ...twaRaw },
    tws: { note: 'knots more to add to the TWS table, off-wind windows against upwind windows within ' + PAIR_S / 60 + ' min (compliant, stable)', ...tws }
  }
}

module.exports = {
  Analyst,
  summarise,
  windowFinding,
  manoeuvreFinding,
  tablesId,
  RESUME_CONTEXT_S,
  _internals: { WIN_S, MIN_SHARE, PAIR_S, VERSION, binOf, classOf, circ }
}
