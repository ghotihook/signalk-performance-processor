'use strict'
// Analysis (SPECIFICATION.md §12, beta): boatcal's calibration on the boat's own sailing as it
// is recorded. Every few minutes index.js reads the chunk of history since the last, through
// lib/history.js, as 1 Hz rows; analyseChunk() takes what boatcal fits from out of it, and the
// tables are fitted again from everything so far. No Signal K here.
//
// Findings hold raw inputs only, in boatcal's units, from lib/learn.js:
//   s5    5 s medians of the raw inputs (STW, AWA, AWS, heading, heel, ground velocity), the
//         class, and how many of the 5 seconds were good: the boat speed table, K, and (as
//         legs, found from their classes) the TWS table
//   mnv   a tack, gybe or rounding: the raw means of its two windows: the TWA table
// The tables in use are never applied, so they cannot change what is learned.
//
//   analyseChunk(rows, keepFrom, keepTo)   rows: from CONTEXT_S before keepFrom to the chunk's
//       end, at least MARGIN_S after keepTo; findings with their time in [keepFrom, keepTo)
//   fit(findings, config, { dayOf })   histograms and proposed tables on config's axes

const { Learner, Legs, rawTwa } = require('./learn')
const { process, _internals: { stwGridLookup } } = require('./processor')

const VERSION = 4 // the findings' layout (1: through the tables in use; 2: 2-minute windows; 3: with legs)
const CONTEXT_S = 420 // read before a chunk: lib/learn.js's buffer
const MARGIN_S = 180 // a chunk keeps findings up to this before the end of what was read: a rounding needs 135 s after its crossing
const S5 = 5
const S5_MIN_GOOD = 4 // of its 5 seconds, for an s5 record to be compliant
const MIN_STW = 1 // kn: a good second, as lib/learn.js

// boatcal 5: boat speed samples and current.
const SAMPLE_MIN_KN = 0.5 // STW and SOG
const SAMPLE_MIN_TWA = 30 // |raw TWA|
const CURRENT_S = 20 * 60
const CURRENT_MIN_SAMPLES = 60
// 1 − |mean unit heading vector|. boatcal: 0.15, over all its rows. Here over upright samples
// only (below), where gybes 40° apart (0.06) must count.
const CURRENT_MIN_SPREAD = 0.05
const CURRENT_MAX_KN = 4
const UPRIGHT_DEG = 5
const TRIM_SHARE = 0.1 // the current's mean leaves out this share at each end
const MAX_PASSES = 500
const CONVERGED_KN = 0.001
const STW_SUPPORT = { samples: 200, area: 10 * 2.5 } // boatcal: 200 samples per 10° × 2.5 kn
// boatcal 6: K.
const K_MIN_HEEL = 4
const K_MIN_STW = 3
const K_MIN_DAYS = 5
// boatcal 7: TWA. boatcal needs half a manoeuvre per 50° × 5 kn of a cell's area, which a
// binned median cannot use (each manoeuvre lands in one cell): 3 manoeuvres a cell.
const TWA_MIN_N = 3
// boatcal 8: TWS.
const TRIM_S = 120 // dropped at each end of a leg
const BAND_DEG = 10
const BAND_MIN_S = 60
const REF_MIN_S = 60
const PAIR_S = 30 * 60
const MIN_REF_KN = 3
const OFF_DEG = 80
const TWS_SUPPORT = { seconds: 15 * 60, area: 40 * 5 } // boatcal: 15 minutes per 40° × 5 kn

const R = Math.PI / 180
const fin = x => typeof x === 'number' && Number.isFinite(x)
const wrap180 = d => ((d + 180) % 360 + 360) % 360 - 180
const norm360 = d => (d % 360 + 360) % 360
const round = (x, d = 2) => fin(x) ? (d === null ? x : Math.round(x * 10 ** d) / 10 ** d) : null // d null: as it is
const good = r => !!r && fin(r.awa) && fin(r.aws) && fin(r.stw) && fin(r.hdg) && fin(r.heel) && r.stw > MIN_STW
const unit = deg => [Math.cos(deg * R), Math.sin(deg * R)]
const clone = o => JSON.parse(JSON.stringify(o))

function mean (xs) { const v = xs.filter(fin); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
function median (xs) {
  const v = xs.filter(fin).sort((a, b) => a - b)
  if (!v.length) return null
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
function trimmedMean (xs) {
  const v = xs.filter(fin).sort((a, b) => a - b)
  const cut = Math.floor(v.length * TRIM_SHARE)
  return mean(v.slice(cut, v.length - cut))
}
// Circular mean and standard deviation, degrees.
function circ (deg) {
  const v = deg.filter(fin); if (!v.length) return { mean: null, sd: null }
  let s = 0; let c = 0
  for (const d of v) { s += Math.sin(d * R); c += Math.cos(d * R) }
  const len = Math.min(1, Math.hypot(s, c) / v.length)
  return { mean: Math.atan2(s, c) / R, sd: v.length > 1 ? Math.sqrt(-2 * Math.log(Math.max(len, 1e-12))) / R : null }
}
const angle = (c, s) => fin(c) && fin(s) && (c || s) ? Math.atan2(s, c) / R : null

// ---- findings ----------------------------------------------------------------------------

// A lib/learn.js 5 s record, as a finding: angles in degrees, rounded.
function s5Finding (r) {
  const hdg = angle(r.hdgC, r.hdgS)
  return {
    type: 's5',
    t: r.t,
    n: r.n,
    good: r.good,
    compliant: r.good >= S5_MIN_GOOD,
    cls: r.cls,
    awa: round(angle(r.awaC, r.awaS), 2),
    aws: round(r.aws, 3),
    stw: round(r.stw, 3),
    heel: round(r.heel, 2),
    hdg: hdg === null ? null : round(norm360(hdg), 2),
    gN: round(r.sogN, 3), // ground velocity, kn north and east
    gE: round(r.sogE, 3),
    variation: round(r.variation, 1)
  }
}

const MNV_KIND = { mnvTack: 'tack', mnvGybe: 'gybe', mnvComeUp: 'comeUp', mnvComeDown: 'comeDown' }

// A lib/learn.js manoeuvre as a finding: the raw means of each window's good seconds.
function manoeuvreFinding (m) {
  const side = rows => {
    const g = rows.map(([t, awa, aws, stw, heel, hdg]) => ({ t, awa, aws, stw, heel, hdg })).filter(good)
    const twa = g.map(r => rawTwa(r))
    const twd = circ(g.map((r, i) => r.hdg + twa[i]))
    return {
      n: g.length,
      awa: round(circ(g.map(r => r.awa)).mean, 2),
      aws: round(mean(g.map(r => r.aws)), 3),
      stw: round(mean(g.map(r => r.stw)), 3),
      heel: round(mean(g.map(r => r.heel)), 2),
      hdg: round(norm360(circ(g.map(r => r.hdg)).mean), 2),
      twa: round(circ(twa).mean, 1), // raw true wind, no tables
      tws: round(mean(g.map(r => { const a = r.awa * R; return Math.hypot(r.aws * Math.cos(a) - r.stw, r.aws * Math.sin(a)) })), 2),
      twd: round(norm360(twd.mean), 1),
      twdSd: round(twd.sd, 1)
    }
  }
  const before = side(m.before); const after = side(m.after)
  const kind = MNV_KIND[m.kind]
  const step = wrap180(after.twd - before.twd)
  const f = { type: 'mnv', t: m.t, kind, from: m.s, compliant: true, before, after, step: round(step, 1) }
  if (kind === 'tack' || kind === 'gybe') f.twaAdd = round(m.s * step / 2, 2) // raw, for a look at one tack
  return f
}

// One chunk's findings: the rows (1 Hz, in time order) through lib/learn.js, keeping the 5 s
// records and manoeuvres timed in [keepFrom, keepTo). The rows before keepFrom are context
// only, as are those after keepTo: the next chunk keeps what falls there.
function analyseChunk (rows, keepFrom, keepTo) {
  const out = []
  const keep = f => { if (f.t >= keepFrom && f.t < keepTo) out.push({ v: VERSION, ...f }) }
  const l = new Learner(r => {
    if (r.type === 's5') keep(s5Finding(r))
    else if (r.type === 'mnv') keep(manoeuvreFinding(r))
  })
  for (const r of rows) l.add(r)
  l.flush()
  return out
}

// boatcal's legs (lib/learn.js, §11.5) from the 5 s records: each compliant record is 5 good
// seconds of its class, a record that is not is a gap.
const LEG_KIND = { sailUp: 'up', sailReach: 'off', sailDown: 'off', other: '' }
function legsOf (s5) {
  const legs = []
  const L = new Legs(r => legs.push({ kind: r.kind, t: r.t0, t1: r.t1, n: r.n }))
  for (const f of s5) for (let i = 0; i < S5; i++) L.second(f.t + i, LEG_KIND[f.cls] ?? '')
  L.close()
  return legs
}

// ---- fitting the tables from findings ----------------------------------------------------

// The index of the axis value nearest x (each cell is the table's own point).
function binOf (axis, x) {
  if (!fin(x) || !axis || !axis.length) return null
  let best = 0
  for (let i = 1; i < axis.length; i++) if (Math.abs(axis[i] - x) < Math.abs(axis[best] - x)) best = i
  return best
}

// A cell's width along an axis: half the gap to each neighbour, the gap to its one neighbour
// at an end (boatcal section 10).
function width (axis, i) {
  if (axis.length < 2) return 1
  if (i === 0) return axis[1] - axis[0]
  if (i === axis.length - 1) return axis[i] - axis[i - 1]
  return (axis[i + 1] - axis[i - 1]) / 2
}

// Weighted median and quartiles of [value, weight] pairs.
function wstats (items, d) {
  const v = items.filter(([x, w]) => fin(x) && w > 0).sort((a, b) => a[0] - b[0])
  const total = v.reduce((a, [, w]) => a + w, 0)
  const q = p => {
    let acc = 0
    for (const [x, w] of v) { acc += w; if (acc >= p * total) return x }
    return v.length ? v[v.length - 1][0] : null
  }
  return { n: v.length, weight: round(total, 0), median: round(q(0.5), d), p25: round(q(0.25), d), p75: round(q(0.75), d) }
}

// A histogram on a table's axes: each cell's stats beside the table's value now, and a
// proposed table of the medians where a cell's support (its items' weight) reaches need(i, j).
function grid (rowsAxis, colsAxis, now, items, need, d) {
  const cells = rowsAxis.map(() => colsAxis.map(() => []))
  for (const [r, c, v, w = 1] of items) {
    const i = binOf(rowsAxis, r); const j = binOf(colsAxis, c)
    if (i !== null && j !== null && fin(v)) cells[i][j].push([v, w])
  }
  const st = cells.map((row, i) => row.map((vs, j) => vs.length ? { ...wstats(vs, d), table: now ? now[i][j] : null, need: need(i, j) } : null))
  return { cells: st, proposed: st.map(row => row.map(c => c && c.weight >= c.need ? c.median : null)) }
}
const areaNeed = (rows, cols, per, perArea) => (i, j) => Math.ceil(per * width(rows, i) * width(cols, j) / perArea)

// Current for each sample: the mean of ground − water velocity over the upright samples of
// its CURRENT_S group, if enough with varied headings; else over its day's; else none.
// waterOf (kn north and east) carries the forward correction found so far.
//
// Only upright samples (|heel| under UPRIGHT_DEG): there leeway is next to nothing, and both
// gybes share the heel-0 cells. On a beat, a current up the middle of the two headings looks
// exactly like a paddlewheel error plus leeway mirrored on each tack, so a beat alone cannot
// tell them apart. With no upright sailing, the STW table is not fitted.
//
// A mean, trimmed by TRIM_SHARE at each end against outliers, not boatcal's median: a group is
// often two headings (the gybes), and a median then sits inside whichever has more samples,
// leaving part of the paddlewheel's error in the current.
function currents (samples, waterOf, dayOf) {
  const est = all => {
    const ws = all.filter(w => Math.abs(w.heel) < UPRIGHT_DEG)
    if (ws.length < CURRENT_MIN_SAMPLES) return null
    const u = ws.map(w => unit(w.hdg))
    if (1 - Math.hypot(mean(u.map(x => x[0])), mean(u.map(x => x[1]))) < CURRENT_MIN_SPREAD) return null
    const c = ws.map(w => { const [n, e] = waterOf(w); return [w.gN - n, w.gE - e] })
    const n = trimmedMean(c.map(x => x[0])); const e = trimmedMean(c.map(x => x[1]))
    return Math.hypot(n, e) < CURRENT_MAX_KN ? [n, e] : null
  }
  const by = key => { const m = new Map(); for (const w of samples) { const k = key(w); if (!m.has(k)) m.set(k, []); m.get(k).push(w) } return m }
  const dayEst = new Map([...by(w => dayOf(w.t))].map(([k, ws]) => [k, est(ws)]))
  const out = new Map()
  for (const [, ws] of by(w => Math.floor(w.t / CURRENT_S))) {
    const c = est(ws)
    for (const w of ws) out.set(w, c || dayEst.get(dayOf(w.t)))
  }
  return out
}

// Ground − current in the boat's frame: forward (kn) and sideways (kn, + to starboard).
function decompose (w, c) {
  const vn = w.gN - c[0]; const ve = w.gE - c[1]
  const [hn, he] = unit(w.hdg)
  return { fwd: vn * hn + ve * he, side: -vn * he + ve * hn }
}

function localDay (t) {
  const d = new Date(t * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// findings: as written, in any order. config: the tables in use, for their axes and to show
// beside what the findings say. dayOf: epoch s to a local day (the server's, by default).
function fit (findings, config, { dayOf = localDay } = {}) {
  const all = findings.filter(f => f && f.v === VERSION)
  const k = config.corrections

  // What there is: seconds of sailing by class (all, and good in compliant records),
  // manoeuvres, legs.
  const counts = { seconds: {}, manoeuvres: {}, legs: {} }
  for (const f of all) {
    if (f.type === 's5') {
      const c = counts.seconds[f.cls] = counts.seconds[f.cls] || { all: 0, compliant: 0 }
      c.all += f.n; if (f.compliant) c.compliant += f.good
    } else if (f.type === 'mnv') counts.manoeuvres[f.kind] = (counts.manoeuvres[f.kind] || 0) + 1
  }
  const s5 = all.filter(f => f.type === 's5' && f.compliant && [f.awa, f.aws, f.stw, f.heel, f.hdg].every(fin)).sort((a, b) => a.t - b.t)
  const legs = legsOf(s5)
  for (const L of legs) counts.legs[L.kind] = (counts.legs[L.kind] || 0) + 1

  // 1. STW table and K from the GPS (boatcal 5, 6): the current and the table in turn, from
  // no table. The forward error is against raw STW, at raw STW and heel, as looked up.
  const samples = s5.filter(w => fin(w.gN) && fin(w.gE) && w.stw > SAMPLE_MIN_KN && Math.hypot(w.gN, w.gE) > SAMPLE_MIN_KN && Math.abs(rawTwa(w)) > SAMPLE_MIN_TWA)
  // A new table object each pass: lookups cache the filled grid by the object.
  const stwTable = add => ({ ...clone(k.stw), enabled: true, add })
  let stwT = stwTable(k.stw.add.map(r => r.map(() => null)))
  const stwOf = w => Math.max(0, w.stw + stwGridLookup(stwT, w.heel, w.stw))
  const waterOf = w => { const s = stwOf(w); const [hn, he] = unit(w.hdg); return [s * hn, s * he] }
  const stwNeed = areaNeed(k.stw.heel, k.stw.stw, STW_SUPPORT.samples, STW_SUPPORT.area)
  let stwGrid = grid(k.stw.heel, k.stw.stw, k.stw.add, [], stwNeed, 2)
  let cur = new Map()
  for (let pass = 0, moved = Infinity; pass < MAX_PASSES && moved > CONVERGED_KN && samples.length; pass++) {
    const was = stwT.add
    cur = currents(samples, waterOf, dayOf)
    const items = samples.filter(w => cur.get(w)).map(w => [w.heel, w.stw, decompose(w, cur.get(w)).fwd - w.stw])
    // Unrounded: rounded, a cell stops moving before the current has settled.
    stwGrid = grid(k.stw.heel, k.stw.stw, k.stw.add, items, stwNeed, null)
    stwT = stwTable(stwGrid.cells.map(r => r.map(c => c ? c.median : null))) // every cell, for the next pass's current
    moved = Math.max(0, ...stwT.add.flatMap((r, i) => r.map((v, j) => fin(v) ? Math.abs(v - (was[i][j] ?? 0)) : 0)))
  }
  stwT = stwTable(stwGrid.proposed)
  const shown = (c, d) => c && { ...c, median: round(c.median, d), p25: round(c.p25, d), p75: round(c.p75, d) }
  stwGrid = { cells: stwGrid.cells.map(r => r.map(c => shown(c, 2))), proposed: stwGrid.proposed.map(r => r.map(v => round(v, 2))) }
  const withCurrent = samples.filter(w => cur.get(w)).length

  const kSamples = samples.filter(w => w.cls === 'sailUp' && cur.get(w) && Math.abs(w.heel) >= K_MIN_HEEL && stwOf(w) >= K_MIN_STW)
  const K = { ...wstats(kSamples.map(w => { const s = stwOf(w); const d = decompose(w, cur.get(w)); return [Math.atan2(d.side, d.fwd) / R * s * s / w.heel, 1] }), 2), now: k.leeway.k }
  K.days = new Set(kSamples.map(w => dayOf(w.t))).size
  K.proposed = K.days >= K_MIN_DAYS ? K.median : null

  // 2. TWA table from tacks and gybes (boatcal 7): true wind again with the proposed STW
  // table, wind tables off; s · step / 2 at the two sides' mean |TWA| and TWS.
  const base = clone(config)
  base.corrections.stw = stwT
  base.corrections.twa = { ...base.corrections.twa, enabled: false }
  base.corrections.tws = { ...base.corrections.tws, enabled: false }
  const wind = (x, cfg) => process({ awa: x.awa, aws: x.aws, stw: x.stw, heel: x.heel, headingTrue: x.hdg }, cfg).out
  const mnv = all.filter(f => f.type === 'mnv' && (f.kind === 'tack' || f.kind === 'gybe') && f.before.n && f.after.n)
  const twaItems = mnv.map(f => {
    const b = wind(f.before, base); const a = wind(f.after, base)
    return [(Math.abs(b.twa) + Math.abs(a.twa)) / 2, (b.tws + a.tws) / 2, f.from * wrap180(a.twd - b.twd) / 2]
  })
  const twaGrid = grid(k.twa.twa, k.twa.tws, k.twa.add, twaItems, () => TWA_MIN_N, 1)

  // 3. TWS table from off-wind legs against the beats (boatcal 8): with the proposed STW and
  // TWA tables, TWS table off. Each leg trimmed by TRIM_S at each end. The reference is the
  // median TWS of the upwind leg before and of the one after (each within PAIR_S, the same
  // day, with REF_MIN_S), the mean of the two where there are both. Each BAND_DEG band of
  // |TWA| with BAND_MIN_S gives reference − median TWS, weighted by its seconds.
  const cfg2 = clone(base)
  cfg2.corrections.twa = { ...clone(k.twa), enabled: true, add: twaGrid.proposed }
  const inLeg = L => s5.filter(w => w.t >= L.t + TRIM_S && w.t + S5 <= L.t1 + 1 - TRIM_S).map(w => wind(w, cfg2))
  const refs = legs.filter(L => L.kind === 'up').map(L => {
    const o = inLeg(L)
    return { L, tws: o.length * S5 >= REF_MIN_S ? median(o.map(x => x.tws)) : null }
  }).filter(u => fin(u.tws))
  const twsItems = []
  let twsLegs = 0
  for (const L of legs.filter(x => x.kind === 'off')) {
    const day = dayOf(L.t)
    const before = refs.filter(u => u.L.t1 <= L.t && L.t - u.L.t1 <= PAIR_S && dayOf(u.L.t) === day).pop()
    const after = refs.find(u => u.L.t >= L.t1 && u.L.t - L.t1 <= PAIR_S && dayOf(u.L.t) === day)
    const sides = [before, after].filter(Boolean).map(u => u.tws)
    if (!sides.length) continue
    const ref = mean(sides)
    if (ref < MIN_REF_KN) continue
    const bands = new Map()
    for (const o of inLeg(L)) {
      const b = Math.floor(Math.abs(o.twa) / BAND_DEG)
      if (!bands.has(b)) bands.set(b, [])
      bands.get(b).push(o)
    }
    let used = false
    for (const os of bands.values()) {
      if (os.length * S5 < BAND_MIN_S) continue
      const tws = median(os.map(o => o.tws))
      twsItems.push([median(os.map(o => Math.abs(o.twa))), tws, ref - tws, os.length * S5])
      used = true
    }
    if (used) twsLegs++
  }
  const twsGrid = grid(k.tws.twa, k.tws.tws, k.tws.add, twsItems, areaNeed(k.tws.twa, k.tws.tws, TWS_SUPPORT.seconds, TWS_SUPPORT.area), 2)
  twsGrid.proposed = twsGrid.proposed.map((r, i) => k.tws.twa[i] < OFF_DEG ? r.map(() => 0) : r)

  // How far each table has got, and what it is waiting for.
  const offLegs = legs.filter(L => L.kind === 'off').length
  const progress = (g, waiting) => {
    const cells = g.cells.flat(); const proposed = g.proposed.flat()
    return { withData: cells.filter(Boolean).length, proposed: cells.filter((c, i) => c && proposed[i] != null).length, waiting }
  }
  const stwWaiting = !samples.length
    ? 'needs SOG and COG from the GPS while sailing'
    : !withCurrent
        ? 'needs upright sailing (heel under 5°) on two or more headings, such as a run with gybes: there the current can be told from boat speed error'
        : null
  const kWaiting = !K.n ? 'needs upwind sailing with a current found' : K.days < K_MIN_DAYS ? `${K.days} of ${K_MIN_DAYS} days of upwind` : null
  const twaWaiting = !twaItems.length ? 'needs tacks or gybes' : null
  const twsWaiting = !refs.length
    ? `needs an upwind leg of at least ${(2 * TRIM_S + REF_MIN_S) / 60} minutes`
    : !offLegs
        ? `needs an off-wind leg of at least ${(2 * TRIM_S + BAND_MIN_S) / 60} minutes`
        : !twsLegs ? `needs an off-wind leg within ${PAIR_S / 60} minutes of an upwind leg, the same day` : null

  const times = all.map(f => f.t)
  return {
    findings: all.length,
    from: times.length ? Math.min(...times) : null,
    to: times.length ? Math.max(...times) : null,
    days: new Set(s5.map(w => dayOf(w.t))).size,
    counts,
    stw: { note: `kn to add to raw STW, by heel (rows) and raw STW (columns): GPS speed along the heading less current, against raw STW. ${samples.length} samples of 5 s, ${withCurrent} with a current (from upright sailing). A cell needs ${STW_SUPPORT.samples} samples per 10° × 2.5 kn of its area`, heel: k.stw.heel.slice(), stw: k.stw.stw.slice(), unit: 'samples', ...stwGrid, progress: progress(stwGrid, stwWaiting) },
    leeway: { note: `K = leeway × STW² ÷ heel, leeway from the sideways slip of upwind samples; proposed only with ${K_MIN_DAYS} or more days of upwind`, ...K, minDays: K_MIN_DAYS, progress: { waiting: kWaiting } },
    twa: { note: `degrees to add to |TWA|: s × TWD step ÷ 2 of ${twaItems.length} tacks and gybes, with the proposed STW table. A cell needs ${TWA_MIN_N}`, twa: k.twa.twa.slice(), tws: k.twa.tws.slice(), unit: 'manoeuvres', ...twaGrid, progress: progress(twaGrid, twaWaiting) },
    tws: { note: `kn to add to TWS: the upwind legs' TWS before and after less off-wind TWS, by ${BAND_DEG}° band of |TWA|, ${twsLegs} off-wind legs, with the proposed STW and TWA tables; rows under ${OFF_DEG}° are 0. A cell needs ${TWS_SUPPORT.seconds / 60} minutes per 40° × 5 kn of its area`, twa: k.tws.twa.slice(), tws: k.tws.tws.slice(), unit: 'seconds', ...twsGrid, progress: progress(twsGrid, twsWaiting) }
  }
}

module.exports = {
  fit,
  analyseChunk,
  s5Finding,
  manoeuvreFinding,
  CONTEXT_S,
  MARGIN_S,
  _internals: { VERSION, PAIR_S, TRIM_S, binOf, width, wstats, currents, decompose, localDay, legsOf }
}
