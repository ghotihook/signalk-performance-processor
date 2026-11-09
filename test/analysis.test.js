const test = require('node:test')
const assert = require('node:assert')
const { analyseChunk, fit, CONTEXT_S, MARGIN_S, _internals: { VERSION, width, wstats, legsOf } } = require('../lib/analysis')
const { normalizeConfig } = require('../lib/processor')

const R = Math.PI / 180
const CFG = normalizeConfig({}).config // the tables in use: the fit must not depend on them
const norm360 = d => (d % 360 + 360) % 360
const DAY = () => 'd' // every finding on one day

// A boat in a steady wind from 200°, true TWS `tws`, sailing at true TWA `twa` and true
// speed `stw` through the water. Its instruments are wrong in known ways:
//   stwErr   the paddlewheel reads this much low
//   twaErr   the masthead reads |TWA| this much too wide
//   twsErr   and TWS this much high
//   k        leeway = k × heel / STW² turns its track; current (kn, towards N and E) moves it
// Apparent wind is built from the measured TWA and TWS with the true STW, so raw true wind
// with a right STW table gives back exactly the measured TWA and TWS.
function row (t, twa, o = {}) {
  const tws = o.tws ?? 12; const stw = o.stw ?? 6; const twaErr = o.twaErr ?? 0
  const heel = 'heel' in o ? o.heel : -Math.sign(twa) * (Math.abs(twa) < 90 ? 15 : 0)
  const meas = twa + Math.sign(twa) * twaErr
  const mTws = tws + (o.twsErr ?? 0)
  const x = mTws * Math.cos(meas * R) + stw; const y = mTws * Math.sin(meas * R)
  const hdg = norm360(200 - twa)
  const lee = (o.k ?? 0) * (heel ?? 0) / (stw * stw)
  const [cn, ce] = o.current ?? [0, 0]
  const gn = stw * Math.cos((hdg + lee) * R) + cn; const ge = stw * Math.sin((hdg + lee) * R) + ce
  return {
    t, awa: Math.atan2(y, x) / R, aws: Math.hypot(x, y), stw: stw - (o.stwErr ?? 0), heel, hdg,
    sog: Math.hypot(gn, ge), cog: norm360(Math.atan2(ge, gn) / R), variation: 12
  }
}

// All the rows as one chunk.
const run = rows => analyseChunk(rows, -Infinity, Infinity)

// The rows in chunks of `size` seconds, as the plugin reads them every few minutes: each
// with CONTEXT_S before and MARGIN_S after, keeping only its own stretch.
function chunked (rows, size) {
  const out = []
  const t0 = rows[0].t; const t1 = rows[rows.length - 1].t + 1
  for (let a = t0; a < t1; a += size) {
    const b = Math.min(a + size, t1)
    const last = b === t1
    out.push(...analyseChunk(rows.filter(r => r.t >= a - CONTEXT_S && r.t < b + MARGIN_S), a, last ? Infinity : b))
  }
  return out
}

const T0 = 1_700_000_000 - (1_700_000_000 % 1200)

test('a tack: the raw TWD step is twice the TWA error; findings hold raw inputs only', () => {
  const rows = []
  for (let i = 0; i < 900; i++) rows.push(row(T0 + i, i < 450 ? 40 : -40, { twaErr: 3 }))
  const out = run(rows)
  const m = out.filter(f => f.type === 'mnv')
  assert.deepStrictEqual(m.map(f => [f.kind, f.from]), [['tack', 1]])
  assert.ok(Math.abs(m[0].step + 6) < 0.1, `step ${m[0].step}`)
  assert.ok(Math.abs(m[0].twaAdd + 3) < 0.1)
  assert.strictEqual(m[0].v, VERSION)
  assert.ok(Math.abs(m[0].before.stw - 6) < 1e-6 && Math.abs(m[0].before.heel + 15) < 1e-6)
  assert.ok(out.every(f => !('tables' in f)), 'nothing from the tables in use')
})

test('a gybe from port: the sign follows the side', () => {
  const rows = []
  for (let i = 0; i < 900; i++) rows.push(row(T0 + i, i < 450 ? -150 : 150, { twaErr: -2 }))
  const m = run(rows).filter(f => f.type === 'mnv')
  assert.deepStrictEqual(m.map(f => [f.kind, f.from]), [['gybe', -1]])
  assert.ok(Math.abs(m[0].twaAdd - 2) < 0.1, `twaAdd ${m[0].twaAdd}`)
})

test('5 s records: one per 5 seconds, compliant with 4 good seconds, raw values', () => {
  const rows = []
  for (let i = 0; i < 600; i++) {
    const r = row(T0 + i, 40)
    if (i >= 300 && i < 305 && i !== 300) r.heel = null // 1 good second of 5
    if (i >= 310 && i < 315 && i === 310) r.awa = null // 4 of 5
    rows.push(r)
  }
  const s5 = run(rows).filter(f => f.type === 's5')
  assert.strictEqual(s5.length, 120)
  const at = t => s5.find(f => f.t === T0 + t)
  assert.deepStrictEqual([at(300).good, at(300).compliant], [1, false])
  assert.deepStrictEqual([at(310).good, at(310).compliant], [4, true])
  const f = at(100)
  assert.strictEqual(f.cls, 'sailUp')
  assert.ok(Math.abs(f.stw - 6) < 1e-6 && Math.abs(f.heel + 15) < 1e-6 && Math.abs(f.hdg - 160) < 0.01)
  assert.ok(Math.abs(Math.hypot(f.gN, f.gE) - 6) < 0.01)
})

test('in 5-minute chunks, the findings are the same as all at once', () => {
  const rows = []
  for (let i = 0; i < 3600; i++) rows.push(row(T0 + i, Math.floor(i / 450) % 2 ? -40 : 40, { twaErr: 2 }))
  const key = f => `${f.type} ${f.t}`
  const once = run(rows)
  const parts = chunked(rows, 300)
  assert.deepStrictEqual(parts.map(key).sort(), once.map(key).sort())
  assert.strictEqual(new Set(parts.map(key)).size, parts.length, 'nothing twice')
  assert.strictEqual(once.filter(f => f.type === 'mnv').length, 7)
})

test('legs from the 5 s records: a stretch of one kind, joined across a short gap', () => {
  const rows = []
  for (let i = 0; i < 1800; i++) rows.push(row(T0 + i, i < 900 ? 40 : 150))
  const legs = legsOf(run(rows).filter(f => f.type === 's5' && f.compliant))
  assert.deepStrictEqual(legs.map(L => L.kind), ['up', 'off'])
  assert.ok(Math.abs(legs[0].t - T0) <= 30 && legs[1].t1 >= T0 + 1790, JSON.stringify(legs))
})

test('support scales with a cell\'s area, as boatcal', () => {
  assert.strictEqual(width([-30, -25, -20], 0), 5)
  assert.strictEqual(width([1, 2, 4], 1), 1.5)
  assert.deepStrictEqual(wstats([[1, 1], [2, 1], [10, 2]], 1), { n: 3, weight: 4, median: 2, p25: 1, p75: 10 })
})

// Two hours: beat, run, beat, run, tacking and gybing every 5 minutes, with every error at
// once. The fit must take them out in the pipeline's order.
function day (errs, t0 = T0) {
  const rows = []
  for (let i = 0; i < 4 * 1800; i++) {
    const leg = Math.floor(i / 1800); const side = Math.floor(i / 300) % 2 ? -1 : 1
    const up = leg % 2 === 0
    rows.push(row(t0 + i, side * (up ? 40 : 150), { ...errs, stw: up ? 6 : 7, twaErr: up ? errs.twaErr : -2, twsErr: up ? 0 : errs.twsErr }))
  }
  return run(rows)
}

test('fit: STW table, K, TWA and TWS tables from raw findings, in pipeline order', () => {
  const out = day({ stwErr: 0.4, k: 8, current: [0.4, -0.3], twaErr: 3, twsErr: 1 })
  const s = fit(out, CFG, { dayOf: DAY })
  assert.ok(s.counts.manoeuvres.tack >= 10 && s.counts.legs.up === 2 && s.counts.legs.off === 2, JSON.stringify(s.counts))
  assert.ok(s.counts.seconds.sailUp.compliant > 3000)
  const c = (g, row, col, axR, axC) => g.cells[g[axR].indexOf(row)][g[axC].indexOf(col)]
  // STW: the paddlewheel reads 0.4 kn low; the current comes from the runs, where both gybes
  // share the upright cells.
  for (const h of [-15, 15]) {
    const cell = c(s.stw, h, 6, 'heel', 'stw')
    assert.ok(cell && cell.weight >= cell.need && Math.abs(cell.median - 0.4) < 0.05, `heel ${h}: ${JSON.stringify(cell)}`)
    assert.strictEqual(s.stw.proposed[s.stw.heel.indexOf(h)][s.stw.stw.indexOf(6)], cell.median)
  }
  assert.strictEqual(c(s.stw, -15, 6, 'heel', 'stw').need, 40, '200 samples per 10° × 2.5 kn, on a 5° × 1 kn cell')
  // K from one day: shown, not proposed (5 days).
  assert.ok(Math.abs(s.leeway.median - 8) < 0.2, `K ${JSON.stringify(s.leeway)}`)
  assert.strictEqual(s.leeway.proposed, null)
  // TWA: 3° too wide upwind, 2° too narrow downwind, with the paddlewheel's error out first.
  const up = c(s.twa, 40, 12, 'twa', 'tws'); const dn = c(s.twa, 150, 12, 'twa', 'tws')
  assert.ok(up && Math.abs(up.median + 3) < 0.2, `up ${JSON.stringify(up)}`)
  assert.ok(dn && Math.abs(dn.median - 2) < 0.2, `down ${JSON.stringify(dn)}`)
  // TWS: 1 kn high downwind, by band, against the beats either side.
  const tw = s.tws.cells[s.tws.twa.indexOf(150)].find(x => x)
  assert.ok(tw && Math.abs(tw.median + 1) < 0.1 && tw.weight >= tw.need, `tws ${JSON.stringify(s.tws.cells[s.tws.twa.indexOf(150)])}`)
  assert.ok(s.tws.proposed.every((r, i) => s.tws.twa[i] >= 80 || r.every(v => v === 0)), 'rows under 80° are 0')
})

test('fit: K is proposed with 5 days of upwind', () => {
  const out = []
  for (let d = 0; d < 5; d++) out.push(...day({ k: 8, current: [0.2, 0.1] }, T0 + d * 86400))
  const s = fit(out, CFG, { dayOf: t => Math.floor(t / 86400) })
  assert.strictEqual(s.leeway.days, 5)
  assert.ok(Math.abs(s.leeway.proposed - 8) < 0.2, JSON.stringify(s.leeway))
})

test('fit: a beat alone cannot tell current from paddlewheel error and leeway, so no STW table', () => {
  const rows = []
  for (let i = 0; i < 3600; i++) rows.push(row(T0 + i, Math.floor(i / 300) % 2 ? -40 : 40, { stwErr: 0.4, k: 8, current: [0.3, 0] }))
  const s = fit(run(rows), CFG, { dayOf: DAY })
  assert.ok(s.stw.proposed.every(r => r.every(v => v === null)))
})

test('fit: without the STW stage first, a paddlewheel error would show up in the TWA table', () => {
  const out = day({ stwErr: 0.4, twaErr: 3, twsErr: 0 }).map(f => f.type === 's5' ? { ...f, gN: null, gE: null } : f)
  const s = fit(out, CFG, { dayOf: DAY })
  assert.ok(s.stw.proposed.every(r => r.every(v => v === null)), 'no STW table without GPS')
  const up = s.twa.cells[s.twa.twa.indexOf(40)][s.twa.tws.indexOf(12)]
  assert.ok(up && Math.abs(up.median + 3) > 0.2, `the step is not the TWA error alone: ${JSON.stringify(up)}`)
})

test('fit: the tables in use change nothing', () => {
  const out = day({ stwErr: 0.2, twaErr: 2, twsErr: 0.5 })
  const off = normalizeConfig({ corrections: { stw: { enabled: false }, twa: { enabled: false }, tws: { enabled: false } } }).config
  const a = fit(out, CFG, { dayOf: DAY }); const b = fit(out, off, { dayOf: DAY })
  for (const k of ['stw', 'twa', 'tws']) assert.deepStrictEqual(a[k].proposed, b[k].proposed)
  assert.strictEqual(a.leeway.median, b.leeway.median)
})

test('fit: thin cells stay blank; findings of another layout are ignored', () => {
  const rows = []
  for (let i = 0; i < 900; i++) rows.push(row(T0 + i, i < 450 ? 40 : -40, { twaErr: 3 }))
  const out = run(rows)
  const s = fit([...out, { v: 2, type: 'win', t: T0, compliant: true, stable: true }], CFG, { dayOf: DAY })
  assert.strictEqual(s.findings, out.length)
  const cell = s.twa.cells[s.twa.twa.indexOf(40)][s.twa.tws.indexOf(12)]
  assert.strictEqual(cell.n, 1)
  assert.ok(s.twa.proposed.every(r => r.every(v => v === null)), 'one tack proposes nothing')
})

test('fit: leeway on the runs reads as a little current, and K comes out a little low', () => {
  // Heel 1° on the runs at K 8 slips 0.16°: mirrored on the gybes, it looks like current.
  const rows = []
  for (let i = 0; i < 4 * 1800; i++) {
    const up = Math.floor(i / 1800) % 2 === 0; const side = Math.floor(i / 300) % 2 ? -1 : 1
    rows.push(row(T0 + i, side * (up ? 40 : 150), { stw: up ? 6 : 7, k: 8, heel: up ? -side * 15 : -side }))
  }
  const k = fit(run(rows), CFG, { dayOf: DAY }).leeway.median
  assert.ok(k < 8 && k > 7, `K ${k}`)
})
