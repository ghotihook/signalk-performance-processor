const test = require('node:test')
const assert = require('node:assert')
const { Learner, rawTwa } = require('../lib/learn')

// A boat beating at TWA ±40 in 12 kn of true wind, 6 kn through the water, heeled 15°.
function row (t, twa, opts = {}) {
  const tws = 12; const stw = opts.stw ?? 6
  const x = tws * Math.cos(twa * Math.PI / 180) + stw
  const y = tws * Math.sin(twa * Math.PI / 180)
  return {
    t, awa: Math.atan2(y, x) * 180 / Math.PI, aws: Math.hypot(x, y), stw,
    heel: opts.heel ?? -Math.sign(twa) * 15, hdg: (200 - twa + 360) % 360, sog: stw, cog: 0, variation: 12
  }
}

function run (rows) {
  const out = []
  const l = new Learner(r => out.push(r))
  rows.forEach(r => l.add(r))
  l.flush()
  return out
}

test('rawTwa: the apparent wind of a known true wind comes back', () => {
  assert.ok(Math.abs(rawTwa(row(0, 40)) - 40) < 1e-9)
  assert.ok(Math.abs(rawTwa(row(0, -150)) + 150) < 1e-9)
})

test('Learner: one tack, centred, and the upwind leg either side', () => {
  const t0 = 1_700_000_000 - (1_700_000_000 % 60)
  const rows = []
  for (let i = 0; i < 900; i++) rows.push(row(t0 + i, i < 450 ? 40 : -40))
  const out = run(rows)
  const tacks = out.filter(r => r.type === 'mnv')
  assert.deepStrictEqual(tacks.map(r => r.kind), ['mnvTack'])
  assert.ok(Math.abs(tacks[0].t - (t0 + 450)) <= 1, `crossing at ${tacks[0].t - t0}`)
  assert.strictEqual(tacks[0].before.length, 30)
  const legs = out.filter(r => r.type === 'leg')
  assert.deepStrictEqual(legs.map(r => [r.kind, r.n]), [['up', 900]])
  const s5 = out.filter(r => r.type === 's5')
  assert.strictEqual(s5.length, 180)
  assert.ok(s5.every(r => r.cls === 'sailUp'))
})

test('Learner: no tack when motoring upright, nor when the data stops inside the after window', () => {
  const t0 = 1_700_000_000 - (1_700_000_000 % 60)
  const upright = []
  for (let i = 0; i < 900; i++) upright.push(row(t0 + i, i < 450 ? 40 : -40, { heel: 0 }))
  assert.strictEqual(run(upright).filter(r => r.type === 'mnv').length, 0)
  const short = []
  for (let i = 0; i < 505; i++) short.push(row(t0 + i, i < 450 ? 40 : -40))
  assert.strictEqual(run(short).filter(r => r.type === 'mnv').length, 0)
})

test('Learner: a bear-away is mnvComeDown, and gives an upwind then an off-wind leg', () => {
  const t0 = 1_700_000_000 - (1_700_000_000 % 60)
  const rows = []
  for (let i = 0; i < 1200; i++) rows.push(row(t0 + i, i < 600 ? 40 : 140, { heel: i < 600 ? -15 : -3 }))
  const out = run(rows)
  assert.deepStrictEqual(out.filter(r => r.type === 'mnv').map(r => r.kind), ['mnvComeDown'])
  assert.deepStrictEqual(out.filter(r => r.type === 'leg').map(r => r.kind), ['up', 'off'])
})
