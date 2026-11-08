const test = require('node:test')
const assert = require('node:assert')
const { Analyst, summarise, tablesId, RESUME_CONTEXT_S, _internals: { WIN_S } } = require('../lib/analysis')
const { normalizeConfig } = require('../lib/processor')

// Tables off, so corrected true wind is the raw true wind.
const OFF = normalizeConfig({ corrections: { stw: { enabled: false }, leeway: { enabled: false }, twa: { enabled: false }, tws: { enabled: false } } }).config
const ON = normalizeConfig({}).config

// A boat in a steady 12 kn from 200°, sailing at true TWA `twa`, whose masthead reads |TWA|
// `err` degrees too wide (as a TWA table would need -err).
function row (t, twa, opts = {}) {
  const tws = opts.tws ?? 12; const stw = opts.stw ?? 6; const err = opts.err ?? 0
  const meas = twa + Math.sign(twa) * err
  const x = tws * Math.cos(meas * Math.PI / 180) + stw
  const y = tws * Math.sin(meas * Math.PI / 180)
  return {
    t, awa: Math.atan2(y, x) * 180 / Math.PI, aws: Math.hypot(x, y), stw,
    heel: 'heel' in opts ? opts.heel : -Math.sign(twa) * (Math.abs(twa) < 90 ? 15 : 3),
    hdg: ((200 - twa) % 360 + 360) % 360, sog: stw, cog: ((200 - twa) % 360 + 360) % 360, variation: 12
  }
}

function run (rows, config = OFF, opts) {
  const out = []
  const a = new Analyst(f => out.push(f), config, opts)
  rows.forEach(r => a.add(r))
  a.flush()
  return out
}

const T0 = 1_700_000_000 - (1_700_000_000 % 600)

test('a tack: TWD steps by twice the TWA error, and the finding says how much to add', () => {
  const rows = []
  for (let i = 0; i < 900; i++) rows.push(row(T0 + i, i < 450 ? 40 : -40, { err: 3 }))
  const out = run(rows)
  const m = out.filter(f => f.type === 'mnv')
  assert.strictEqual(m.length, 1)
  assert.strictEqual(m[0].kind, 'tack')
  assert.strictEqual(m[0].from, 1)
  assert.ok(Math.abs(m[0].step + 6) < 0.1, `step ${m[0].step}`)
  assert.ok(Math.abs(m[0].twaAdd + 3) < 0.1, `twaAdd ${m[0].twaAdd}`)
  assert.ok(Math.abs(m[0].twaAddRaw + 3) < 0.1)
  assert.ok(Math.abs(m[0].absTwa - 43) < 0.1)
  assert.ok(m[0].stable && m[0].compliant)
  assert.strictEqual(m[0].tables, tablesId(OFF))
})

test('a gybe from port: the sign follows the side', () => {
  const rows = []
  for (let i = 0; i < 900; i++) rows.push(row(T0 + i, i < 450 ? -150 : 150, { err: -2 }))
  const m = run(rows).filter(f => f.type === 'mnv')
  assert.deepStrictEqual(m.map(f => [f.kind, f.from]), [['gybe', -1]])
  assert.ok(Math.abs(m[0].twaAdd - 2) < 0.1, `twaAdd ${m[0].twaAdd}`)
})

test('windows: class, stable and compliant; a missing input makes one noncompliant', () => {
  const rows = []
  for (let i = 0; i < 4 * WIN_S; i++) rows.push(row(T0 + i, i < 2 * WIN_S ? 40 : 140, { heel: i >= 3 * WIN_S ? null : undefined }))
  for (const r of rows) if (r.heel === undefined) r.heel = -Math.sign(r.t - T0 < 2 * WIN_S ? 40 : 140) * 10
  const w = run(rows).filter(f => f.type === 'win')
  assert.deepStrictEqual(w.map(f => [f.cls, f.compliant, f.stable]), [['up', true, true], ['up', true, true], ['down', true, true], [null, false, false]])
  assert.deepStrictEqual(w[3].why, ['no attitude'])
  assert.ok(Math.abs(w[0].tws - 12) < 0.01 && Math.abs(w[0].twd - 200) < 0.1)
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
  for (let i = 0; i < 1800; i++) rows.push(row(T0 + i, Math.floor(i / 450) % 2 ? -40 : 40, { err: 2 }))
  const once = run(rows)
  const out = []
  const a = new Analyst(f => out.push(f), OFF)
  for (let k = 0; k < rows.length; k += 300) rows.slice(k, k + 300).forEach(r => a.add(r))
  a.flush()
  assert.deepStrictEqual(out, once)
  assert.ok(once.filter(f => f.type === 'mnv').length === 3)
})

test('resuming: since drops what was found before, safe() is where to resume', () => {
  const rows = []
  for (let i = 0; i < 1800; i++) rows.push(row(T0 + i, Math.floor(i / 450) % 2 ? -40 : 40))
  const all = run(rows)
  // Stop after 1000 s (no flush), resume from safe() with the learner's context before it.
  const first = []
  const a = new Analyst(f => first.push(f), OFF)
  rows.slice(0, 1000).forEach(r => a.add(r))
  const safe = a.safe()
  assert.ok(safe.win <= T0 + 1000 && safe.learn < safe.win && safe.learn > T0 + 600, JSON.stringify(safe))
  const second = []
  const b = new Analyst(f => second.push(f), OFF, { resume: safe })
  rows.filter(r => r.t >= Math.min(safe.win, safe.learn) - RESUME_CONTEXT_S).forEach(r => b.add(r))
  b.flush()
  const key = f => `${f.type} ${f.t}`
  const got = [...first, ...second].filter(f => f.type !== 'leg').map(key).sort()
  assert.deepStrictEqual(got, all.filter(f => f.type !== 'leg').map(key).sort())
})

test('summarise: tacks binned on the TWA table, off-wind TWS against the beats', () => {
  const rows = []
  // Beat, run, beat; the masthead reads 1 kn high on the run.
  for (let i = 0; i < 1800; i++) {
    const phase = Math.floor(i / 600)
    if (phase === 1) rows.push(row(T0 + i, Math.floor(i / 150) % 2 ? -150 : 150, { tws: 13 }))
    else rows.push(row(T0 + i, Math.floor(i / 150) % 2 ? -42 : 42, { err: 3 }))
  }
  const out = run(rows)
  const s = summarise(out, OFF)
  assert.strictEqual(s.tables, tablesId(OFF))
  const i40 = OFF.corrections.twa.twa.indexOf(40); const j12 = OFF.corrections.twa.tws.indexOf(12)
  const c = s.twa.cells[i40][j12]
  assert.ok(c && c.n >= 3, JSON.stringify(s.twa.cells.map(r => r.filter(Boolean))))
  assert.ok(Math.abs(c.median + 3) < 0.2)
  const i150 = OFF.corrections.tws.twa.indexOf(150); const j13 = OFF.corrections.tws.tws.indexOf(14)
  const tc = s.tws.cells[i150][j13] || s.tws.cells[i150][OFF.corrections.tws.tws.indexOf(12)]
  assert.ok(tc && Math.abs(tc.median + 1) < 0.05, JSON.stringify(tc))
  assert.ok(s.counts['win up compliant stable'] > 0)
  assert.ok(s.counts['mnv tack compliant stable'] >= 3)
})

test('summarise: corrections still needed use only findings made with the tables in use', () => {
  const rows = []
  for (let i = 0; i < 900; i++) rows.push(row(T0 + i, i < 450 ? 40 : -40, { err: 3 }))
  const out = run(rows, OFF)
  const s = summarise(out, ON)
  assert.strictEqual(s.withTables, 0)
  assert.ok(s.twa.cells.every(r => r.every(c => c === null)))
  assert.ok(s.twaRaw.cells.some(r => r.some(c => c && c.n === 1)))
})
