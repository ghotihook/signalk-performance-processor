'use strict'
// Analysis (SPECIFICATION.md §12, beta): findings from the boat's sailing, a few minutes at a
// time, kept so that over many days they add up to histograms for the tables. No Signal K
// here: index.js reads the History API every few minutes and feeds the 1 Hz rows of
// lib/history.js, one per second, to a long-lived Analyst.
//
// Findings hold raw inputs only (STW, AWA, AWS, heading, heel, SOG/COG and the true wind
// worked out from them with no tables), so the tables in use never change what is learned.
// fit() works every table out from them, in the pipeline's order (§5): the STW table and K
// from the GPS, then the TWA table from tacks and gybes with that STW table, then the TWS
// table from off-wind windows against the beats with both.
//
//   const a = new Analyst(finding => ..., { resume })
//   a.add({ t, awa, aws, stw, heel, hdg, sog, cog, variation })   hdg: true heading
//   a.safe()    { win, learn }: epoch s before which every window, and every manoeuvre and
//               leg, has been emitted. A new Analyst given it as `resume`, and fed from
//               RESUME_CONTEXT_S before the earlier of the two, carries on without repeats.
//   a.flush()   end of data (the boat stopped)
//   fit(findings, config)   histograms and proposed tables on config's axes

const { Learner, rawTwa } = require('./learn')
const { process, _internals: { stwGridLookup } } = require('./processor')

const WIN_S = 120 // a window
const MIN_SHARE = 0.8 // compliant: each required input, and good seconds, in this share of the window
const MIN_STW = 1 // kn: a good second, as lib/learn.js
const UP_DEG = 70
const OFF_DEG = 80
const DOWN_DEG = 120
// Stable: steady enough that a mean means something. Standard deviations over the window
// (or each manoeuvre window), on good seconds, all raw.
const STABLE_HDG_SD = 6 // deg
const STABLE_TWA_SD = 6 // deg
const STABLE_TWD_SD = 8 // deg
const STABLE_STW_SD = 0.5 // kn
const STABLE_TWS_CV = 0.2 // TWS sd / mean, and a manoeuvre's TWS change / mean
const RESUME_CONTEXT_S = 420 // lib/learn.js's buffer
const VERSION = 2 // the findings' layout (1: values through the tables in use)

// fit(): boatcal's method (its SPECIFICATION.md 5 to 8) on findings rather than 5 s rows.
const CURRENT_S = 20 * 60 // current constant over this
const CURRENT_MIN_WINS = 5 // windows a current estimate needs
const CURRENT_MIN_SPREAD = 0.05 // 1 − |mean unit heading vector|: gybes 36° apart (boatcal 0.15, on all its rows)
const CURRENT_MAX_KN = 4
// boatcal alternates 5 passes; the current takes longer to separate from a steady
// paddlewheel error (gybes 40° apart leave cos² 20° of it each pass), so until no cell
// moves by more than CONVERGED_KN, at most MAX_PASSES.
const MAX_PASSES = 200
const CONVERGED_KN = 0.002
const K_MIN_HEEL = 4 // deg
const UPRIGHT_DEG = 5 // the current comes from windows heeled less than this
const K_MIN_STW = 3 // kn: leeway is faded in below
const PAIR_S = 30 * 60 // TWS: upwind windows this close are the reference
const MIN_REF_KN = 3
const MIN_N = { stw: 8, twa: 3, tws: 8 } // a proposed cell: windows (2 min each) or manoeuvres

const R = Math.PI / 180
const fin = x => typeof x === 'number' && Number.isFinite(x)
const wrap180 = d => ((d + 180) % 360 + 360) % 360 - 180
const norm360 = d => (d % 360 + 360) % 360
const round = (x, d = 2) => fin(x) ? Math.round(x * 10 ** d) / 10 ** d : null
const good = r => !!r && fin(r.awa) && fin(r.aws) && fin(r.stw) && fin(r.hdg) && fin(r.heel) && r.stw > MIN_STW
const rawTws = r => { const a = r.awa * R; return Math.hypot(r.aws * Math.cos(a) - r.stw, r.aws * Math.sin(a)) }

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

// What is unsteady about some good seconds, on raw values.
function unsteady (g) {
  const hdg = circ(g.map(r => r.hdg))
  const twa = g.map(r => rawTwa(r))
  const twaC = circ(twa)
  const twd = circ(g.map((r, i) => r.hdg + twa[i]))
  const tws = g.map(rawTws)
  const twsMean = mean(tws)
  const stwSd = sd(g.map(r => r.stw))
  const out = []
  if (!(hdg.sd <= STABLE_HDG_SD)) out.push('heading')
  if (!(twaC.sd <= STABLE_TWA_SD)) out.push('TWA')
  if (!(twd.sd <= STABLE_TWD_SD)) out.push('TWD')
  if (!(stwSd <= STABLE_STW_SD)) out.push('STW')
  if (!(twsMean > 0 && sd(tws) / twsMean <= STABLE_TWS_CV)) out.push('TWS')
  return { out, hdg, twa: twaC, twd, tws: twsMean, twsSd: sd(tws), stwSd }
}

// Raw means of some good seconds: what fit() recomputes true wind from.
function rawMeans (g) {
  const gps = g.filter(r => fin(r.sog) && fin(r.cog))
  return {
    awa: round(circ(g.map(r => r.awa)).mean, 2),
    aws: round(mean(g.map(r => r.aws)), 3),
    stw: round(mean(g.map(r => r.stw)), 3),
    heel: round(mean(g.map(r => r.heel)), 2),
    hdg: round(norm360(circ(g.map(r => r.hdg)).mean), 2),
    // Velocities, kn, north and east: over the ground (GPS), through the water (raw STW
    // along the heading). Means of vectors, so a turn inside the window is not lost.
    gN: gps.length ? round(mean(gps.map(r => r.sog * Math.cos(r.cog * R))), 3) : null,
    gE: gps.length ? round(mean(gps.map(r => r.sog * Math.sin(r.cog * R))), 3) : null,
    wN: round(mean(g.map(r => r.stw * Math.cos(r.hdg * R))), 3),
    wE: round(mean(g.map(r => r.stw * Math.sin(r.hdg * R))), 3),
    gps: gps.length
  }
}

// A window of up to WIN_S rows (any may be missing) as a finding; null with no input in it.
function windowFinding (t0, rows) {
  const present = rows.filter(Boolean)
  const share = Object.fromEntries(Object.entries(REQUIRED).map(([g, ok]) => [g, present.filter(ok).length / WIN_S]))
  if (!Object.values(share).some(s => s > 0)) return null // the reader's padding, not sailing
  const g = present.filter(good)
  const why = Object.entries(share).filter(([, s]) => s < MIN_SHARE).map(([k]) => `no ${k}`)
  if (g.length / WIN_S < MIN_SHARE && !why.length) why.push(`STW ≤ ${MIN_STW} kn`)
  const u = unsteady(g)
  if (g.length < MIN_SHARE * WIN_S) u.out.unshift('too few good seconds')
  return {
    type: 'win',
    t: t0,
    s: WIN_S,
    n: present.length,
    good: g.length,
    compliant: !why.length,
    why,
    cls: classOf(median(g.map(r => Math.abs(rawTwa(r))))),
    stable: !u.out.length,
    unsteady: u.out,
    side: g.length ? Math.sign(u.twa.mean) || 1 : null,
    ...(g.length ? rawMeans(g) : {}),
    twa: round(u.twa.mean, 1), // raw true wind: no tables
    tws: round(u.tws),
    twd: u.twd.mean === null ? null : round(norm360(u.twd.mean), 1),
    hdgSd: round(u.hdg.sd, 1),
    twaSd: round(u.twa.sd, 1),
    twdSd: round(u.twd.sd, 1),
    twsSd: round(u.twsSd),
    stwSd: round(u.stwSd),
    sog: round(median(g.map(r => r.sog))),
    variation: round(median(g.map(r => r.variation)), 1)
  }
}

const MNV_KIND = { mnvTack: 'tack', mnvGybe: 'gybe', mnvComeUp: 'comeUp', mnvComeDown: 'comeDown' }

// A lib/learn.js manoeuvre as a finding: the raw inputs either side, and raw true wind.
function manoeuvreFinding (m) {
  const side = rows => {
    const g = rows.map(([t, awa, aws, stw, heel, hdg]) => ({ t, awa, aws, stw, heel, hdg })).filter(good)
    const u = unsteady(g)
    return { ...rawMeans(g), n: g.length, twa: round(u.twa.mean, 1), tws: round(u.tws), twd: round(norm360(u.twd.mean), 1), twdSd: round(u.twd.sd, 1) }
  }
  const before = side(m.before); const after = side(m.after)
  const tws = (before.tws + after.tws) / 2
  const why = []
  if (!(before.twdSd <= STABLE_TWD_SD && after.twdSd <= STABLE_TWD_SD)) why.push('TWD')
  if (!(Math.abs(after.tws - before.tws) / tws <= STABLE_TWS_CV)) why.push('TWS')
  const step = wrap180(after.twd - before.twd)
  const kind = MNV_KIND[m.kind]
  const f = {
    type: 'mnv',
    t: m.t,
    kind,
    from: m.s, // side before: + starboard tack
    compliant: true, // lib/learn.js keeps only manoeuvres with good data both sides
    why: [],
    stable: !why.length,
    unsteady: why,
    before,
    after,
    tws: round(tws),
    step: round(step, 1) // raw TWD after − before
  }
  if (kind === 'tack' || kind === 'gybe') f.twaAdd = round(m.s * step / 2, 2) // §12.2, raw
  return f
}

class Analyst {
  constructor (emit, { resume = null } = {}) {
    this.resume = { win: -Infinity, learn: -Infinity, ...(resume || {}) }
    this.out = f => {
      if (f.t < (f.type === 'win' ? this.resume.win : this.resume.learn)) return
      emit({ v: VERSION, ...f })
    }
    this.learner = new Learner(r => this.learned(r))
    this.win = null // { t0, rows: [] }
    this.last = null
  }

  learned (r) {
    if (r.type === 'mnv') this.out(manoeuvreFinding(r))
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
    const f = windowFinding(w.t0, w.rows)
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

// ---- fitting the tables from findings ----------------------------------------------------

// The index of the axis value nearest x (each cell is the table's own point).
function binOf (axis, x) {
  if (!fin(x) || !axis || !axis.length) return null
  let best = 0
  for (let i = 1; i < axis.length; i++) if (Math.abs(axis[i] - x) < Math.abs(axis[best] - x)) best = i
  return best
}

function stats (xs, d = 2) {
  const v = xs.filter(fin).sort((a, b) => a - b)
  return { n: v.length, median: round(quantile(v, 0.5), d), p25: round(quantile(v, 0.25), d), p75: round(quantile(v, 0.75), d) }
}

// A histogram on a table's axes: each cell's stats beside the table's value now, and a
// proposed table of the medians where a cell has minN or more (blank otherwise).
function grid (rowsAxis, colsAxis, now, items, minN, d) {
  const cells = rowsAxis.map(() => colsAxis.map(() => []))
  for (const [r, c, v] of items) {
    const i = binOf(rowsAxis, r); const j = binOf(colsAxis, c)
    if (i !== null && j !== null && fin(v)) cells[i][j].push(v)
  }
  const st = cells.map((row, i) => row.map((vs, j) => vs.length ? { ...stats(vs, d), table: now ? now[i][j] : null } : null))
  return { cells: st, proposed: st.map(row => row.map(c => c && c.n >= minN ? c.median : null)) }
}

const unit = deg => [Math.cos(deg * R), Math.sin(deg * R)]

// Current for each window: the median of ground − water velocity over the upright windows
// of its CURRENT_S group, if they are enough with varied headings; else over its day's; else
// none. waterOf (kn north and east) carries the forward correction found so far.
//
// Only upright windows (|heel| under UPRIGHT_DEG): there leeway is next to nothing, and both
// gybes share the heel-0 cells. On a beat, a current up the middle of the two headings
// looks exactly like a paddlewheel error plus leeway mirrored on each tack, so a beat alone
// cannot tell them apart. With no upright sailing, the STW table is not fitted.
function currents (wins, waterOf) {
  const est = all => {
    const ws = all.filter(w => Math.abs(w.heel) < UPRIGHT_DEG)
    if (ws.length < CURRENT_MIN_WINS) return null
    const u = ws.map(w => unit(w.hdg))
    if (1 - Math.hypot(mean(u.map(x => x[0])), mean(u.map(x => x[1]))) < CURRENT_MIN_SPREAD) return null
    const c = ws.map(w => { const [n, e] = waterOf(w); return [w.gN - n, w.gE - e] })
    const n = median(c.map(x => x[0])); const e = median(c.map(x => x[1]))
    return Math.hypot(n, e) < CURRENT_MAX_KN ? [n, e] : null
  }
  const by = key => { const m = new Map(); for (const w of wins) { const k = key(w); if (!m.has(k)) m.set(k, []); m.get(k).push(w) } return m }
  const groups = by(w => Math.floor(w.t / CURRENT_S))
  const days = by(w => Math.floor(w.t / 86400))
  const dayEst = new Map([...days].map(([k, ws]) => [k, est(ws)]))
  const out = new Map()
  for (const [, ws] of groups) {
    const c = est(ws) || dayEst.get(Math.floor(ws[0].t / 86400))
    for (const w of ws) out.set(w, c)
  }
  return out
}

// Ground − current in the boat's frame: forward (kn) and sideways (kn, + to starboard).
function decompose (w, c) {
  const vn = w.gN - c[0]; const ve = w.gE - c[1]
  const [hn, he] = unit(w.hdg)
  return { fwd: vn * hn + ve * he, side: -vn * he + ve * hn }
}

const clone = o => JSON.parse(JSON.stringify(o))

// findings: as written, in any order. config: the tables in use, for their axes and to show
// beside what the findings say. Only compliant, stable findings are used.
function fit (findings, config) {
  const all = findings.filter(f => f && f.v === VERSION)
  const counts = {}
  for (const f of all) {
    const key = [f.type, f.type === 'win' ? (f.cls || 'none') : f.kind, f.compliant ? 'compliant' : 'noncompliant', f.stable ? 'stable' : 'unstable'].join(' ')
    counts[key] = (counts[key] || 0) + 1
  }
  const k = config.corrections
  const use = f => f.compliant && f.stable
  const wins = all.filter(f => f.type === 'win' && use(f) && fin(f.stw) && fin(f.heel) && fin(f.hdg))

  // 1. STW table and K from the GPS (boatcal 5, 6): the current and the table in turn,
  // from no table. The forward error is against raw STW, at raw STW and heel, as looked up.
  const gpsWins = wins.filter(w => fin(w.gN) && fin(w.gE) && w.gps >= MIN_SHARE * w.good)
  // A new table object each pass: lookups cache the filled grid by the object.
  const stwTable = add => ({ ...clone(k.stw), enabled: true, add })
  let stwT = stwTable(k.stw.add.map(r => r.map(() => null)))
  const stwOf = w => Math.max(0, w.stw + stwGridLookup(stwT, w.heel, w.stw))
  const waterOf = w => { const f = stwOf(w) / w.stw; return [w.wN * f, w.wE * f] }
  let stwGrid = grid(k.stw.heel, k.stw.stw, k.stw.add, [], MIN_N.stw, 2)
  let cur = new Map()
  for (let pass = 0, moved = Infinity; pass < MAX_PASSES && moved > CONVERGED_KN && gpsWins.length; pass++) {
    const was = stwT.add
    cur = currents(gpsWins, waterOf)
    const items = gpsWins.filter(w => cur.get(w)).map(w => [w.heel, w.stw, decompose(w, cur.get(w)).fwd - w.stw])
    stwGrid = grid(k.stw.heel, k.stw.stw, k.stw.add, items, MIN_N.stw, 2)
    stwT = stwTable(stwGrid.cells.map(r => r.map(c => c ? c.median : null))) // every cell, for the next pass's current
    moved = Math.max(0, ...stwT.add.flatMap((r, i) => r.map((v, j) => fin(v) ? Math.abs(v - (was[i][j] ?? 0)) : 0)))
  }
  stwT = stwTable(stwGrid.proposed)
  const kItems = gpsWins.filter(w => w.cls === 'up' && cur.get(w) && Math.abs(w.heel) >= K_MIN_HEEL).map(w => {
    const s = stwOf(w); const d = decompose(w, cur.get(w))
    return s >= K_MIN_STW ? Math.atan2(d.side, d.fwd) / R * s * s / w.heel : null
  })
  const K = { ...stats(kItems, 2), now: k.leeway.k }
  K.proposed = K.n >= MIN_N.stw ? K.median : null
  const withCurrent = gpsWins.filter(w => cur.get(w)).length

  // 2. TWA table from tacks and gybes (boatcal 7): true wind again with the proposed STW
  // table, wind tables off; s · step / 2 at the two sides' mean |TWA| and TWS.
  const base = clone(config)
  base.corrections.stw = stwT
  base.corrections.twa = { ...base.corrections.twa, enabled: false }
  base.corrections.tws = { ...base.corrections.tws, enabled: false }
  const wind = (x, cfg) => process({ awa: x.awa, aws: x.aws, stw: x.stw, heel: x.heel, headingTrue: x.hdg }, cfg).out
  const mnv = all.filter(f => f.type === 'mnv' && use(f) && (f.kind === 'tack' || f.kind === 'gybe'))
  const twaItems = mnv.map(f => {
    const b = wind(f.before, base); const a = wind(f.after, base)
    return [(Math.abs(b.twa) + Math.abs(a.twa)) / 2, (b.tws + a.tws) / 2, f.from * wrap180(a.twd - b.twd) / 2]
  })
  const twaGrid = grid(k.twa.twa, k.twa.tws, k.twa.add, twaItems, MIN_N.twa, 1)

  // 3. TWS table from off-wind windows against the beats (boatcal 8): with the proposed STW
  // and TWA tables, TWS table off; the reference is the upwind windows within PAIR_S, the
  // mean of those before and those after where there are both. Rows under OFF_DEG are 0.
  const cfg2 = clone(base)
  cfg2.corrections.twa = { ...clone(k.twa), enabled: true, add: twaGrid.proposed }
  const tw = wins.map(w => ({ w, o: wind(w, cfg2) }))
  const up = tw.filter(x => x.w.cls === 'up')
  const twsItems = []
  for (const x of tw) {
    if (x.w.cls !== 'reach' && x.w.cls !== 'down') continue
    const near = (lo, hi) => up.filter(u => u.w.t - x.w.t >= lo && u.w.t - x.w.t <= hi).map(u => u.o.tws)
    const sides = [near(-PAIR_S, 0), near(0, PAIR_S)].filter(s => s.length).map(median)
    if (!sides.length) continue
    const ref = mean(sides)
    if (ref < MIN_REF_KN) continue
    twsItems.push([Math.abs(x.o.twa), x.o.tws, ref - x.o.tws])
  }
  const twsGrid = grid(k.tws.twa, k.tws.tws, k.tws.add, twsItems, MIN_N.tws, 2)
  twsGrid.proposed = twsGrid.proposed.map((r, i) => k.tws.twa[i] < OFF_DEG ? r.map(() => 0) : r)

  const times = all.map(f => f.t)
  return {
    findings: all.length,
    from: times.length ? Math.min(...times) : null,
    to: times.length ? Math.max(...times) : null,
    counts,
    stw: { note: `kn to add to raw STW, by heel (rows) and raw STW (columns): GPS speed along the heading less current, against raw STW; ${gpsWins.length} steady windows with GPS, ${withCurrent} with a current`, heel: k.stw.heel.slice(), stw: k.stw.stw.slice(), minN: MIN_N.stw, ...stwGrid },
    leeway: { note: 'K = leeway × STW² ÷ heel, leeway from the sideways slip of steady upwind windows', ...K },
    twa: { note: `degrees to add to |TWA|: s × TWD step ÷ 2 of ${twaItems.length} steady tacks and gybes, with the proposed STW table`, twa: k.twa.twa.slice(), tws: k.twa.tws.slice(), minN: MIN_N.twa, ...twaGrid },
    tws: { note: `kn to add to TWS: upwind TWS within ${PAIR_S / 60} min less off-wind TWS, ${twsItems.length} windows, with the proposed STW and TWA tables; rows under ${OFF_DEG}° are 0`, twa: k.tws.twa.slice(), tws: k.tws.tws.slice(), minN: MIN_N.tws, ...twsGrid }
  }
}

module.exports = {
  Analyst,
  fit,
  windowFinding,
  manoeuvreFinding,
  RESUME_CONTEXT_S,
  _internals: { WIN_S, MIN_SHARE, PAIR_S, VERSION, MIN_N, binOf, classOf, circ, currents, decompose }
}
