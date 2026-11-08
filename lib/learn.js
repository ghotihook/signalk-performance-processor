'use strict'
// Learning (SPECIFICATION.md §11): classes, manoeuvres, legs and 5 s records from 1 Hz rows
// of raw inputs. No Signal K here: index.js feeds one row per second and writes the records.
//
//   const l = new Learner(record => ...)
//   l.add({ t, awa, aws, stw, heel, hdg, sog, cog, variation })   t: whole seconds (epoch)
//   l.flush()                                                     end of data
//
// hdg is the true heading H (§3.2). Records: { type: 's5' | 'mnv' | 'leg', ... }.

const BUFFER_S = 420 // §11.4: 7 minutes
const CONTEXT_S = 180 // either side of the middle minute
const MIN_STW = 1 // kn, a good second
const LEG_SMOOTH_S = 30
const UP_DEG = 70
const OFF_DEG = 80
const DOWN_DEG = 120
const TWA_SMOOTH_S = 15
const TWA_SMOOTH_MIN = 8
const MERGE_S = 10
const ISOLATION_S = 5
const MIN_COVER = 0.5
const WINDOW_MIN_STW = 2.5
const MIN_HEEL_UPWIND = 4
const JOIN_S = 90
const MIN_LEG_S = 180
const S5 = 5
const WINDOWS = {
  tack: [[-50, -20], [30, 60]],
  gybe: [[-50, -20], [30, 60]],
  rounding: [[-120, -30], [45, 135]]
}

const R = Math.PI / 180
const fin = x => typeof x === 'number' && Number.isFinite(x)

// §11.3: true wind before the tables, with the STW table off.
function rawTwa (r) {
  const a = r.awa * R
  return Math.atan2(r.aws * Math.sin(a), r.aws * Math.cos(a) - r.stw) / R
}

const good = r => !!r && fin(r.awa) && fin(r.aws) && fin(r.stw) && fin(r.hdg) && fin(r.heel) && r.stw > MIN_STW

function circMean (deg) {
  let s = 0; let c = 0
  for (const d of deg) { s += Math.sin(d * R); c += Math.cos(d * R) }
  return Math.atan2(s, c) / R
}

function median (xs) {
  const v = xs.filter(fin).sort((a, b) => a - b)
  if (!v.length) return null
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

const mean = xs => { const v = xs.filter(fin); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN }

function classOf (m) {
  if (m == null) return 'other'
  if (m < UP_DEG) return 'sailUp'
  if (m <= OFF_DEG) return 'other'
  return m <= DOWN_DEG ? 'sailReach' : 'sailDown'
}
const legKind = c => c === 'sailUp' ? 'up' : (c === 'sailReach' || c === 'sailDown') ? 'off' : ''

// Manoeuvres with their crossing in [lo, hi), found on rows[0..n) (rows[i] at t0 + i, or null).
function manoeuvres (rows, t0, lo, hi) {
  const n = rows.length
  const ok = rows.map(good)
  const twa = rows.map((r, i) => ok[i] ? rawTwa(r) : NaN)
  const h = (TWA_SMOOTH_S - 1) >> 1
  const sm = new Array(n).fill(NaN)
  for (let i = 0; i < n; i++) {
    let s = 0; let c = 0; let k = 0
    for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) {
      if (ok[j]) { s += Math.sin(twa[j] * R); c += Math.cos(twa[j] * R); k++ }
    }
    if (k >= TWA_SMOOTH_MIN) sm[i] = Math.atan2(s / k, c / k) / R
  }
  const cross = []
  for (let i = 1; i < n; i++) {
    const a = sm[i - 1]; const b = sm[i]
    if (!fin(a) || !fin(b)) continue
    if (Math.sign(a) * Math.sign(b) < 0) cross.push([i, 'side'])
    if (Math.sign(Math.abs(a) - 90) * Math.sign(Math.abs(b) - 90) < 0) cross.push([i, 'beam'])
  }
  cross.sort((x, y) => x[0] - y[0])
  const merged = []
  for (const [i, kind] of cross) {
    const last = merged[merged.length - 1]
    if (last && i - last[0] < MERGE_S && last[1] === kind) continue
    merged.push([i, kind])
  }
  const out = []
  for (const [i, kind] of merged) {
    if (t0 + i < lo || t0 + i >= hi) continue
    const k = kind === 'beam' ? 'rounding' : (Math.abs(sm[i]) < 90 ? 'tack' : 'gybe')
    const [[b0, b1], [a0, a1]] = WINDOWS[k]
    if (i + b0 < 0 || i + a1 >= n) continue
    if (!ok.slice(i + a1).some(Boolean)) continue // the data runs past the windows, as boatcal's day does
    if (merged.some(([j]) => j !== i && j > i + b0 - ISOLATION_S && j < i + a1 + ISOLATION_S)) continue
    const wins = []
    for (const [w0, w1] of [[b0, b1], [a0, a1]]) {
      const idx = []; for (let j = i + w0; j < i + w1; j++) idx.push(j)
      const g = idx.filter(j => ok[j])
      if (g.length / idx.length < MIN_COVER) break
      if (mean(g.map(j => rows[j].stw)) < WINDOW_MIN_STW) break
      if (mean(g.map(j => Math.abs(twa[j]))) < 90 && mean(g.map(j => Math.abs(rows[j].heel))) < MIN_HEEL_UPWIND) break
      wins.push(g)
    }
    if (wins.length < 2) continue
    const winTwa = (w0, w1) => { const v = []; for (let j = i + w0; j < i + w1; j++) if (rows[j] && fin(rows[j].awa) && fin(rows[j].aws) && fin(rows[j].stw)) v.push(rawTwa(rows[j])); return v }
    const mb = circMean(winTwa(b0, b1)); const ma = circMean(winTwa(a0, a1))
    let name
    if (k === 'tack') { if (!(Math.abs(mb) < 90 && Math.abs(ma) < 90 && Math.sign(mb) !== Math.sign(ma))) continue; name = 'mnvTack' }
    if (k === 'gybe') { if (!(Math.abs(mb) > 90 && Math.abs(ma) > 90 && Math.sign(mb) !== Math.sign(ma))) continue; name = 'mnvGybe' }
    if (k === 'rounding') {
      if (Math.abs(mb) < 80 && Math.abs(ma) > 100) name = 'mnvComeDown'
      else if (Math.abs(mb) > 100 && Math.abs(ma) < 80) name = 'mnvComeUp'
      else continue
    }
    const pick = g => g.map(j => { const r = rows[j]; return [t0 + j, r.awa, r.aws, r.stw, r.heel, r.hdg, r.variation ?? null] })
    out.push({ type: 'mnv', kind: name, t: t0 + i, s: mb > 0 ? 1 : -1, before: pick(wins[0]), after: pick(wins[1]) })
  }
  return out
}

// §11.5 legs, fed one good second at a time, in time order. As boatcal's TWS legs: a run of
// one kind ends at another kind or a gap over JOIN_S; a stretch of `other` joins the leg when
// the same kind resumes no more than JOIN_S after the leg's last second.
class Legs {
  constructor (emit) { this.emit = emit; this.leg = null; this.pend = null }
  second (t, kind) {
    const L = this.leg
    if (L && t - (this.pend ? this.pend.t1 : L.t1) > JOIN_S) this.close()
    if (kind === '') {
      if (this.leg) this.pend = { n: (this.pend ? this.pend.n : 0) + 1, t1: t }
      return
    }
    if (this.leg && this.leg.kind === kind && (!this.pend || t - this.leg.t1 <= JOIN_S)) {
      this.leg.n += 1 + (this.pend ? this.pend.n : 0)
      this.leg.t1 = t
      this.pend = null
      return
    }
    this.close()
    this.leg = { kind, t0: t, t1: t, n: 1 }
  }

  close () {
    const L = this.leg
    if (L && L.n >= MIN_LEG_S) this.emit({ type: 'leg', kind: L.kind, t0: L.t0, t1: L.t1, n: L.n })
    this.leg = null; this.pend = null
  }
}

class Learner {
  constructor (emit) {
    this.emit = emit
    this.rows = new Map() // t -> row
    this.next = null // start of the next minute to class
    this.last = null
    this.legs = new Legs(emit)
    this.s5 = null
  }

  add (row) {
    const t = Math.floor(row.t)
    if (this.last != null && t <= this.last) return
    if (this.next == null) this.next = Math.floor(t / 60) * 60
    if (this.last != null && t - this.last > BUFFER_S) {
      this.drain(this.last)
      this.legs.close()
      this.rows.clear()
      this.next = Math.floor(t / 60) * 60
    }
    this.rows.set(t, row)
    this.last = t
    while (t >= this.next + 60 + CONTEXT_S) this.minute()
  }

  flush () {
    if (this.last != null) this.drain(this.last)
    this.legs.close()
    this.flushS5()
  }

  drain (upto) { while (this.next <= upto) this.minute() }

  minute () {
    const m = this.next
    const t0 = m - CONTEXT_S
    const rows = []
    for (let t = t0; t < t0 + BUFFER_S; t++) rows.push(this.rows.get(t) || null)
    const ok = rows.map(good)
    const absTwa = rows.map((r, i) => ok[i] ? Math.abs(rawTwa(r)) : NaN)
    for (let i = CONTEXT_S; i < CONTEXT_S + 60; i++) {
      const w = []
      for (let j = Math.max(0, i - LEG_SMOOTH_S + 1); j <= i; j++) if (ok[j]) w.push(absTwa[j])
      const cls = ok[i] ? classOf(median(w)) : 'other'
      if (ok[i]) this.legs.second(t0 + i, legKind(cls))
      if (rows[i]) this.s5Add(t0 + i, rows[i], cls)
    }
    for (const e of manoeuvres(rows, t0, m, m + 60)) this.emit(e)
    for (const t of this.rows.keys()) if (t < m + 60 - CONTEXT_S) this.rows.delete(t)
    this.next = m + 60
  }

  s5Add (t, r, cls) {
    const b = Math.floor(t / S5) * S5
    if (this.s5 && this.s5.t !== b) this.flushS5()
    if (!this.s5) this.s5 = { t: b, rows: [], cls: [] }
    this.s5.rows.push(r); this.s5.cls.push(cls)
  }

  flushS5 () {
    const b = this.s5
    this.s5 = null
    if (!b) return
    const med = k => median(b.rows.map(r => r[k]))
    const vec = (k, mag) => {
      const ok = b.rows.filter(r => fin(r[k]) && (!mag || fin(r[mag])))
      if (!ok.length) return [null, null]
      const m = r => mag ? r[mag] : 1
      return [median(ok.map(r => m(r) * Math.cos(r[k] * R))), median(ok.map(r => m(r) * Math.sin(r[k] * R)))]
    }
    const count = {}
    for (const c of b.cls) count[c] = (count[c] || 0) + 1
    const cls = Object.keys(count).sort((x, y) => count[y] - count[x])[0]
    const [awaC, awaS] = vec('awa'); const [hdgC, hdgS] = vec('hdg'); const [sogN, sogE] = vec('cog', 'sog')
    this.emit({
      type: 's5', t: b.t, n: b.rows.length, cls,
      awaC, awaS, aws: med('aws'), stw: med('stw'), heel: med('heel'), hdgC, hdgS, sogN, sogE, variation: med('variation')
    })
  }
}

module.exports = { Learner, rawTwa, manoeuvres, Legs, _internals: { WINDOWS, BUFFER_S, CONTEXT_S } }
