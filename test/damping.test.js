const test = require('node:test')
const assert = require('node:assert')
const { Smooth, SmoothAngle, SmoothVector } = require('../lib/damping')

test('Smooth: one time constant reaches 63% of a step, whatever the update rate', () => {
  for (const dt of [100, 500, 1000]) {
    const s = new Smooth()
    s.update(0, 0, 2)
    let v
    for (let t = dt; t <= 2000; t += dt) v = s.update(10, t, 2)
    assert.ok(Math.abs(v - 10 * (1 - Math.exp(-1))) < 1e-9, `${dt} ms steps: ${v}`)
  }
})

test('Smooth: 0 is no damping; a repeat time changes nothing; a long gap restarts', () => {
  const s = new Smooth()
  assert.strictEqual(s.update(3, 0, 0), 3)
  assert.strictEqual(s.update(5, 100, 0), 5)
  const d = new Smooth()
  d.update(0, 0, 5); const a = d.update(10, 1000, 5)
  assert.strictEqual(d.update(10, 1000, 5), a, 'same time, same value')
  assert.strictEqual(d.update(7, 30000, 5), 7, 'after a 29 s gap the new value stands')
})

test('SmoothAngle: averages across north, not through south', () => {
  const s = new SmoothAngle()
  s.update(350, 0, 1)
  const v = s.update(10, 1000, 0.0001) // a very short time constant: lands on 10
  assert.ok(Math.abs(v - 10) < 1e-6)
  const m = new SmoothAngle()
  m.update(350, 0, 1)
  const half = m.update(10, Math.log(2) * 1000, 1) // half way in vector terms
  assert.ok(half > 355 || half < 5, `stays near north: ${half}`)
})

test('SmoothVector: current smoothed as a vector', () => {
  const s = new SmoothVector()
  s.update(1, 90, 0, 10)
  // The current reverses; one time constant later the average has passed through slack
  // water and is setting the new way (an average of the directions would say 1 kn to 180).
  const v = s.update(1, 270, 10000, 10)
  assert.ok(Math.abs(v.speed - (2 * (1 - Math.exp(-1)) - 1)) < 1e-9, `speed ${v.speed}`)
  assert.ok(Math.abs(v.deg - 270) < 1e-9, `set ${v.deg}`)
})

test('a gap restarts only when longer than both 10 s and the time constant', () => {
  const d = new Smooth()
  d.update(0, 0, 120)
  const v = d.update(10, 12000, 120) // a 12 s dropout in a 120 s average
  assert.ok(Math.abs(v - 10 * (1 - Math.exp(-12 / 120))) < 1e-9, `blended, not restarted: ${v}`)
  assert.strictEqual(d.update(4, 12000 + 121000, 120), 4, 'restarted after more than the time constant')
  const s = new Smooth()
  s.update(0, 0, 3)
  assert.strictEqual(s.update(9, 10500, 3), 9, 'a short time constant still restarts after 10 s')
  const a = new SmoothAngle()
  a.update(10, 0, 120)
  assert.ok(a.update(20, 12000, 120) < 12, 'directions likewise')
  const c = new SmoothVector()
  c.update(1, 0, 0, 120)
  assert.ok(c.update(5, 90, 12000, 120).speed < 1.5, 'and current')
})
