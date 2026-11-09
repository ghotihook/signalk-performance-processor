const test = require('node:test')
const assert = require('node:assert')
const { Analyst, fit, RESUME_CONTEXT_S, _internals: { WIN_S, VERSION } } = require('../lib/analysis')
const { normalizeConfig } = require('../lib/processor')

const R = Math.PI / 180
const CFG = normalizeConfig({}).config // the tables in use: the fit must not depend on them
const norm360 = d => (d % 360 + 360) % 360

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
  const heel = 'heel' in o ? o.heel : -Math.sign(twa) * (Math.abs(twa) < 90 ? 15 : 1)
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

function run (rows) {
  const out = []
  const a = new Analyst(f => out.push(f))
  rows.forEach(r => a.add(r))
  a.flush()
  return out
}

const T0 = 1_700_000_000 - (1_700_000_000 % 1200)

test('a tack: the raw TWD step is twice the TWA error, and the finding holds raw inputs only', () => {
  const rows = []
  for (let i = 0; i < 900; i++) rows.push(row(T0 + i, i < 450 ? 40 : -40, { twaErr: 3 }))
  const m = run(rows).filter(f => f.type === 'mnv')
  assert.deepStrictEqual(m.map(f => [f.kind, f.from]), [['tack', 1]])
  assert.ok(Math.abs(m[0].step + 6) < 0.1, `step ${m[0].step}`)
  assert.ok(Math.abs(m[0].twaAdd + 3) < 0.1)
  assert.ok(m[0].stable && m[0].compliant)
  assert.strictEqual(m[0].v, VERSION)
  assert.ok(Math.abs(m[0].before.stw - 6) < 1e-6 && Math.abs(m[0].before.heel + 15) < 1e-6)
  assert.ok(!('tables' in m[0]), 'nothing from the tables in use')
})

test('a gybe from port: the sign follows the side', () => {
  const rows = []
  for (let i = 0; i < 900; i++) rows.push(row(T0 + i, i < 450 ? -150 : 150, { twaErr: -2 }))
  const m = run(rows).filter(f => f.type === 'mnv')
  assert.deepStrictEqual(m.map(f => [f.kind, f.from]), [['gybe', -1]])
  assert.ok(Math.abs(m[0].twaAdd - 2) < 0.1, `twaAdd ${m[0].twaAdd}`)
})

test('windows: class, compliant and stable on raw values; no window for padding, none stable on a few seconds', () => {
  const rows = []
  for (let i = 0; i < 5 * WIN_S; i++) {
    const r = row(T0 + i, i < 3 * WIN_S ? 40 : 140)
    if (i < WIN_S) { r.awa = r.aws = r.stw = r.hdg = r.heel = null } // the reader's padding
    if (i >= WIN_S && i < WIN_S + 100) { r.awa = r.aws = null } // wind starts late
    if (i >= 4 * WIN_S) r.heel = null
    rows.push(r)
  }
  const w = run(rows).filter(f => f.type === 'win')
  assert.deepStrictEqual(w.map(f => [f.t - T0, f.cls, f.compliant, f.stable]), [
    [WIN_S, 'up', false, false], [2 * WIN_S, 'up', true, true], [3 * WIN_S, 'down', true, true], [4 * WIN_S, null, false, false]])
  assert.deepStrictEqual(w[0].why, ['no apparentWind'])
  assert.strictEqual(w[0].unsteady[0], 'too few good seconds')
  assert.deepStrictEqual(w[3].why, ['no attitude'])
  assert.ok(Math.abs(w[1].tws - 12) < 0.01 && Math.abs(w[1].twd - 200) < 0.1 && Math.abs(w[1].stw - 6) < 1e-6)
})

test('a turning boat is unstable', () => {
  const rows = []
  for (let i = 0; i < WIN_S; i++) rows.push(row(T0 + i, 40 + i * 0.5))
  const [w] = run(rows).filter(f => f.type === 'win')
  assert.strictEqual(w.stable, false)
  assert.ok(w.unsteady.includes('heading'))
})

test('fed in chunks, as every few minutes, the findings are the same as all at once', () => {
  const rows = []
  for (let i = 0; i < 1800; i++) rows.push(row(T0 + i, Math.floor(i / 450) % 2 ? -40 : 40, { twaErr: 2 }))
  const once = run(rows)
  const out = []
  const a = new Analyst(f => out.push(f))
  for (let k = 0; k < rows.length; k += 300) rows.slice(k, k + 300).forEach(r => a.add(r))
  a.flush()
  assert.deepStrictEqual(out, once)
  assert.strictEqual(once.filter(f => f.type === 'mnv').length, 3)
})

test('resuming from safe(): nothing lost, nothing twice', () => {
  const rows = []
  for (let i = 0; i < 1800; i++) rows.push(row(T0 + i, Math.floor(i / 450) % 2 ? -40 : 40))
  const all = run(rows)
  const first = []
  const a = new Analyst(f => first.push(f))
  rows.slice(0, 1000).forEach(r => a.add(r)) // stopped here, no flush
  const safe = a.safe()
  assert.ok(safe.win <= T0 + 1000 && safe.learn < safe.win, JSON.stringify(safe))
  const second = []
  const b = new Analyst(f => second.push(f), { resume: safe })
  rows.filter(r => r.t >= Math.min(safe.win, safe.learn) - RESUME_CONTEXT_S).forEach(r => b.add(r))
  b.flush()
  const key = f => `${f.type} ${f.t}`
  assert.deepStrictEqual([...first, ...second].filter(f => f.type !== 'leg').map(key).sort(), all.filter(f => f.type !== 'leg').map(key).sort())
})

// Two hours: beat, run, beat, run, tacking and gybing every 5 minutes, with every error at
// once. The fit must take them out in the pipeline's order.
function day (errs) {
  const rows = []
  for (let i = 0; i < 4 * 1800; i++) {
    const leg = Math.floor(i / 1800); const side = Math.floor(i / 300) % 2 ? -1 : 1
    const up = leg % 2 === 0
    rows.push(row(T0 + i, side * (up ? 40 : 150), { ...errs, stw: up ? 6 : 7, twaErr: up ? errs.twaErr : -2, twsErr: up ? 0 : errs.twsErr }))
  }
  return run(rows)
}

test('fit: STW table, K, TWA and TWS tables from raw findings, in pipeline order', () => {
  const errs = { stwErr: 0.4, k: 8, current: [0.4, -0.3], twaErr: 3, twsErr: 1 }
  const s = fit(day(errs), CFG)
  assert.ok(s.counts['mnv tack compliant stable'] >= 10, JSON.stringify(s.counts))
  // STW: the paddlewheel reads 0.4 kn low upwind (heel ±15, 5.6 kn raw) and downwind; the
  // current comes from the runs, where both gybes share the upright cells.
  const c = (g, row, col, axR, axC) => g.cells[g[axR].indexOf(row)][g[axC].indexOf(col)]
  for (const h of [-15, 15]) {
    const cell = c(s.stw, h, 6, 'heel', 'stw')
    assert.ok(cell && cell.n >= 8 && Math.abs(cell.median - 0.4) < 0.05, `heel ${h}: ${JSON.stringify(cell)}`)
    assert.strictEqual(s.stw.proposed[s.stw.heel.indexOf(h)][s.stw.stw.indexOf(6)], cell.median)
  }
  // The runs' own small leeway (heel 1°) reads as a little current: K within 0.6.
  assert.ok(Math.abs(s.leeway.proposed - 8) < 0.6, `K ${JSON.stringify(s.leeway)}`)
  // TWA: 3° too wide upwind, 2° too narrow downwind, with the paddlewheel's error taken out first.
  const up = c(s.twa, 40, 12, 'twa', 'tws'); const dn = c(s.twa, 150, 12, 'twa', 'tws')
  assert.ok(up && Math.abs(up.median + 3) < 0.2, `up ${JSON.stringify(up)}`)
  assert.ok(dn && Math.abs(dn.median - 2) < 0.2, `down ${JSON.stringify(dn)}`)
  // TWS: 1 kn high downwind, on the corrected |TWA| (150 + the -2 error, taken out).
  const tw = s.tws.cells[s.tws.twa.indexOf(150)].find(x => x)
  assert.ok(tw && Math.abs(tw.median + 1) < 0.1, `tws ${JSON.stringify(s.tws.cells[s.tws.twa.indexOf(150)])}`)
  assert.ok(s.tws.proposed.every((r, i) => s.tws.twa[i] >= 80 || r.every(v => v === 0)), 'rows under 80° are 0')
})

test('fit: without the STW stage first, a paddlewheel error would show up in the TWA table', () => {
  // The same boat with no GPS: the STW table cannot be fitted, so TWA carries the error.
  const out = day({ stwErr: 0.4, twaErr: 3, twsErr: 0 }).map(f => f.type === 'win' ? { ...f, gN: null, gE: null } : f)
  const s = fit(out, CFG)
  assert.ok(s.stw.proposed.every(r => r.every(v => v === null)), 'no STW table without GPS')
  const up = s.twa.cells[s.twa.twa.indexOf(40)][s.twa.tws.indexOf(12)]
  assert.ok(up && Math.abs(up.median + 3) > 0.2, `with a paddlewheel error the step is not the TWA error alone: ${JSON.stringify(up)}`)
})

test('fit: the tables in use change nothing', () => {
  const out = day({ stwErr: 0.2, twaErr: 2, twsErr: 0.5 })
  const off = normalizeConfig({ corrections: { stw: { enabled: false }, twa: { enabled: false }, tws: { enabled: false } } }).config
  const a = fit(out, CFG); const b = fit(out, off)
  for (const k of ['stw', 'twa', 'tws']) assert.deepStrictEqual(a[k].proposed, b[k].proposed)
  assert.strictEqual(a.leeway.proposed, b.leeway.proposed)
})

test('fit: thin cells stay blank', () => {
  const rows = []
  for (let i = 0; i < 900; i++) rows.push(row(T0 + i, i < 450 ? 40 : -40, { twaErr: 3 }))
  const s = fit(run(rows), CFG)
  const cell = s.twa.cells[s.twa.twa.indexOf(40)][s.twa.tws.indexOf(12)]
  assert.strictEqual(cell.n, 1)
  assert.ok(s.twa.proposed.every(r => r.every(v => v === null)), 'one tack proposes nothing')
})

test('fit: a beat alone cannot tell current from paddlewheel error and leeway, so no STW table', () => {
  const rows = []
  for (let i = 0; i < 3600; i++) rows.push(row(T0 + i, Math.floor(i / 300) % 2 ? -40 : 40, { stwErr: 0.4, k: 8, current: [0.3, 0] }))
  const s = fit(run(rows), CFG)
  assert.ok(s.stw.proposed.every(r => r.every(v => v === null)))
  assert.strictEqual(s.leeway.proposed, null)
})
