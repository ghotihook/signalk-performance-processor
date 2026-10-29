const test = require('node:test')
const assert = require('node:assert')
const { process, correctInputs, normalizeConfig, _internals } = require('../lib/processor')
const { DEFAULTS } = require('../lib/defaults')
const K = DEFAULTS.corrections.leeway.k

const { interp, interpRow, blendRows, fillGaps, stwGridLookup } = _internals
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`)

// Every correction off: what is left is plain vector arithmetic.
function allOff () {
  const { config } = normalizeConfig({})
  for (const c of Object.values(config.corrections)) c.enabled = false
  return config
}

test('defaults are valid', () => {
  const { errors } = normalizeConfig({})
  assert.deepStrictEqual(errors, [])
})

test('interp holds the end values and is linear between', () => {
  assert.strictEqual(interp([5, 10], [1, 3], 0), 1)
  assert.strictEqual(interp([5, 10], [1, 3], 20), 3)
  assert.strictEqual(interp([5, 10], [1, 3], 7.5), 2)
})

test('rows blend by TWA between the H5000 rows at 40, 90 and 165', () => {
  const a = { upwind: 40, reach: 90, downwind: 165 }
  assert.strictEqual(blendRows(30, a, -10, 0, 4), -10)
  assert.strictEqual(blendRows(65, a, -10, 0, 4), -5)
  assert.strictEqual(blendRows(90, a, -10, 0, 4), 0)
  close(blendRows(127.5, a, -10, 0, 4), 2, 1e-9)
  assert.strictEqual(blendRows(170, a, -10, 0, 4), 4)
})

test('with every correction off, true wind is apparent wind minus boat speed', () => {
  // AWS 10 dead ahead at 4 kn of boat speed: 6 kn of true wind from ahead.
  const r = process({ awa: 0, aws: 10, stw: 4 }, allOff())
  close(r.out.twa, 0, 1e-9)
  close(r.out.tws, 6, 1e-9)
  // Beam reach: AWA 90, AWS 10, 10 kn of boat speed gives TWS sqrt(200) at 135.
  const b = process({ awa: 90, aws: 10, stw: 10 }, allOff())
  close(b.out.twa, 135, 1e-9)
  close(b.out.tws, Math.sqrt(200), 1e-9)
})

test('port and starboard are mirror images', () => {
  const { config } = normalizeConfig({})
  const s = process({ awa: 32, aws: 16.9, stw: 5.6, heel: -23 }, config).out
  const p = process({ awa: -32, aws: 16.9, stw: 5.6, heel: 23 }, config).out
  // The measured heel x STW table is symmetric to within 0.008 kn, so very nearly mirrored.
  close(p.twa, -s.twa, 0.05)
  close(p.tws, s.tws, 0.01)
  close(p.leeway, -s.leeway, 0.01)
})

test('STW: H5000 layout, heel either side x boat speed, exact at its cells, bilinear between', () => {
  const t = { heel: [0, 10, 20], stw: [0, 5, 10, 15, 20, 25, 30], add: [[0, 0.05, 0, 0, 0, 0, 0], [0, 0.01, -0.03, -0.03, -0.03, -0.03, -0.03], [0, -0.08, -0.13, -0.13, -0.13, -0.13, -0.13]] }
  const config = { corrections: { stw: { enabled: true, ...t } } }
  close(stwGridLookup(t, 0, 5), 0.05, 1e-9, 'cell heel 0, 5 kn')
  close(stwGridLookup(t, -20, 10), -0.13, 1e-9, 'port heel uses the same row as starboard')
  close(stwGridLookup(t, 20, 10), -0.13, 1e-9)
  close(stwGridLookup(t, 15, 7.5), ((0.01 + -0.03) / 2 + (-0.08 + -0.13) / 2) / 2, 1e-9, 'bilinear between')
  close(stwGridLookup(t, 30, 10), -0.13, 1e-9, 'more heel than the last row holds the last row')
  close(stwGridLookup(t, 0, 40), 0, 1e-9, 'holds the last column')
  close(correctInputs({ stw: 6, heel: -20 }, config).c.stw, 6 - 0.08 - 0.2 * 0.05, 1e-9)
})

test('STW: the correction fades out below 1 kn, so a stopped boat is not given speed', () => {
  const t = { heel: [0, 10, 20], stw: [0, 5, 10, 15, 20, 25, 30], add: [[0.5, 0.5, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 0, 0, 0, 0]] }
  close(stwGridLookup(t, 0, 0), 0, 1e-9)
  close(stwGridLookup(t, 0, 0.5), 0.25, 1e-9)
  close(stwGridLookup(t, 0, 1), 0.5, 1e-9)
})

test('STW: blank cells take the nearest value in their row', () => {
  const t = { heel: [0, 10, 20], stw: [0, 5, 10, 15, 20, 25, 30], add: [[0, 0.1, 0.2, null, null, null, null], [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]] }
  close(stwGridLookup(t, 0, 20), 0.2, 1e-9)
})

test('fillGaps extends rows, then fills an empty row from its neighbour', () => {
  assert.deepStrictEqual(fillGaps([[null, 1, null], [null, null, null], [2, null, 3]]), [[1, 1, 1], [1, 1, 1], [2, 2, 3]])
})

test('leeway is K x heel / STW^2, to leeward, and needs heel', () => {
  const { config } = normalizeConfig({})
  config.corrections.stw.enabled = false
  const c = correctInputs({ stw: 6, heel: -20 }, config).c
  close(c.leeway, K * -20 / 36, 1e-9)
  assert.ok(c.leeway < 0, 'starboard tack heels to port and slides to port')
  const none = correctInputs({ stw: 6, heel: null }, config)
  assert.strictEqual(none.c.leeway, 0)
  assert.strictEqual(none.steps.find(s => s.id === 'leeway').skipped, 'no heel data')
})

test('leeway stays out of true wind but turns current', () => {
  const { config } = normalizeConfig({})
  for (const id of ['stw', 'twa', 'tws']) config.corrections[id].enabled = false
  const input = { awa: 32, aws: 16.9, stw: 6, heel: -20, headingTrue: 0, sog: 6, cog: 350 }
  const on = process(input, config).out
  const plain = process(input, allOff()).out
  close(on.twa, plain.twa, 1e-9, 'TWA as if there were no leeway')
  close(on.tws, plain.tws, 1e-9)
  close(on.twd, plain.twd, 1e-9)
  assert.ok(on.leeway < -3, 'leeway is still worked out and published')
  assert.ok(Math.abs(on.current.drift - plain.current.drift) > 0.1, 'current uses leeway')
})

test('TWA table narrows TWA by the table value', () => {
  const config = allOff()
  config.corrections.twa.enabled = true
  const plain = process({ awa: 30, aws: 16, stw: 6 }, allOff()).out
  const r = process({ awa: 30, aws: 16, stw: 6 }, config).out
  // Below 40 the upwind row applies alone; beyond, it blends towards the 90 row.
  const up = interpRow(DEFAULTS.corrections.twa.tws, DEFAULTS.corrections.twa.upwind, plain.tws)
  const reach = interpRow(DEFAULTS.corrections.twa.tws, DEFAULTS.corrections.twa.reach, plain.tws)
  const a = Math.abs(plain.twa)
  const expected = a <= 40 ? up : up + (reach - up) * (a - 40) / 50
  close(Math.abs(r.twa), a + expected, 1e-9)
  close(r.tws, plain.tws, 1e-9, 'TWS untouched by the TWA table')
})

// Stopped boat, so TWA = AWA and TWS = AWS: the TWA correction alone, at any angle.
function twaOnly (twa, tws) {
  const config = allOff()
  config.corrections.twa.enabled = true
  return process({ awa: twa, aws: tws, stw: 0 }, config).out.twa
}
const wrapDeg = d => ((d + 180) % 360 + 360) % 360 - 180

test('TWA correction fades out through head to wind: no flat spot, no jump, TWD never follows the bow', () => {
  for (const tws of [5, 10, 15, 25]) {
    let prev = twaOnly(-40, tws)
    for (let a = -39.9; a <= 40; a += 0.1) {
      const t = twaOnly(a, tws)
      assert.ok(t > prev, `TWS ${tws}: corrected TWA must keep rising through ${a.toFixed(1)} (${prev} -> ${t})`)
      assert.ok(t - prev < 0.25, `TWS ${tws}: no jump at ${a.toFixed(1)}`)
      prev = t
    }
    close(twaOnly(0, tws), 0, 1e-9, 'head to wind stays head to wind')
  }
})

test('TWA correction fades out through dead downwind: no jump as TWA crosses 180', () => {
  for (const tws of [5, 10, 15]) {
    let prev = twaOnly(150, tws)
    for (let a = 150.1; a <= 210; a += 0.1) {
      const t = twaOnly(a > 180 ? a - 360 : a, tws)
      const step = wrapDeg(t - prev)
      assert.ok(step > 0 && step < 0.25, `TWS ${tws}: step ${step} at ${a.toFixed(1)}`)
      prev = t
    }
  }
})

test('TWA correction is in full from 30 degrees off the wind to 10 short of dead downwind', () => {
  const { _internals: { twaTaper } } = require('../lib/processor')
  assert.strictEqual(twaTaper(30), 1)
  assert.strictEqual(twaTaper(170), 1)
  assert.strictEqual(twaTaper(15), 0.5)
  assert.strictEqual(twaTaper(175), 0.5)
  assert.strictEqual(twaTaper(0), 0)
  assert.strictEqual(twaTaper(180), 0)
})

test('config: TWA table values must stay inside the taper', () => {
  const bad = (twa, msg) => assert.ok(normalizeConfig({ schema: 3, corrections: { twa } }).errors.some(e => msg.test(e)), msg)
  bad({ upwind: [0, -30, -12, -5, -5, 0, null] }, /40° row: values must be within/)
  bad({ downwind: [0, 1, -10, 1, null, null, null] }, /165° row: values must be within/)
})

test('leeway fades in between 1.5 and 3 kn, with no step', () => {
  const { config } = normalizeConfig({})
  config.corrections.stw.enabled = false
  const lee = stw => correctInputs({ stw, heel: 15 }, config).c.leeway
  assert.strictEqual(lee(1.5), 0)
  assert.strictEqual(lee(0.5), 0)
  close(lee(3), K * 15 / 9, 1e-9, 'in full from 3 kn')
  close(lee(6), K * 15 / 36, 1e-9)
  let prev = lee(0)
  for (let v = 0.01; v <= 8; v += 0.01) {
    const l = lee(v)
    assert.ok(Math.abs(l - prev) < 0.2, `leeway steps ${prev} -> ${l} at ${v.toFixed(2)} kn`)
    prev = l
  }
})

test('TWS table: H5000 single row, none below 90 deg TWA, in full from the down angle', () => {
  const config = allOff()
  config.corrections.tws.enabled = true
  const at = awa => [process({ awa, aws: 12, stw: 0 }, config).out.tws, process({ awa, aws: 12, stw: 0 }, allOff()).out.tws]
  const kn = interp([0, 5, 10, 15, 20, 25, 30], [0, -0.5, -1, -1.5, -2, -2.5, -3], 12)
  let [c, p] = at(80); close(c, p, 1e-9, 'none upwind of 90')
  ;[c, p] = at(170); close(c, p + kn, 1e-9, 'all beyond the down angle')
  ;[c, p] = at(127.5); close(c, p + kn / 2, 1e-9, 'half way from 90 to 165')
  const blank = { ...config, corrections: { ...config.corrections, tws: { ...config.corrections.tws, correction: [0, null, null, null, null, null, null] } } }
  close(process({ awa: 170, aws: 12, stw: 0 }, blank).out.tws, 12, 1e-9, 'blank = no correction')
})

test('config: TWS down angles must be past 90 deg', () => {
  assert.ok(normalizeConfig({ schema: 3, corrections: { tws: { downAngle: [165, 165, 80, 165, 165, 165, 165] } } }).errors.some(e => /down angle/.test(e)))
})

test('TWD and current need heading; current needs SOG and COG', () => {
  const { config } = normalizeConfig({})
  const r = process({ awa: 32, aws: 16.9, stw: 5.6, heel: -23, headingMagnetic: 110, sog: 5.4, cog: 119 }, config).out
  close(r.heading, 122.8, 1e-9)
  close(r.twd, (122.8 + r.twa + 360) % 360, 1e-9)
  assert.ok(r.current && r.current.drift < 0.5)
  const noHdg = process({ awa: 32, aws: 16.9, stw: 5.6 }, config).out
  assert.strictEqual(noHdg.twd, undefined)
  assert.strictEqual(noHdg.current, undefined)
  const t = process({ awa: 32, aws: 16.9, stw: 5.6, headingTrue: 200, headingMagnetic: 1 }, config).out
  close(t.heading, 200, 1e-9, 'true heading wins over magnetic')
  const g = process({ awa: 32, aws: 16.9, stw: 5.6, headingMagnetic: 110, variation: 10 }, config).out
  close(g.heading, 120, 1e-9, 'variation from Signal K beats the fallback')
  assert.strictEqual(g.headingFrom, 'magnetic + variation from Signal K')
  assert.strictEqual(r.headingFrom, 'magnetic + fallback variation')
})

test('a still current is reported as still', () => {
  // Boat moving at 6 kn through still water on 090: SOG/COG match the water track.
  const config = allOff()
  const r = process({ awa: 40, aws: 12, stw: 6, headingTrue: 90, sog: 6, cog: 90 }, config).out
  close(r.current.drift, 0, 1e-9)
})

test('the worked example from the model', () => {
  const { config } = normalizeConfig({})
  const r = process({ awa: 32, aws: 16.9, stw: 5.6, heel: -23, headingMagnetic: 110, sog: 5.4, cog: 119 }, config).out
  close(r.stw, 5.6 - 0.2 + 0.05 * 0.6 / 5, 0.001)
  close(r.leeway, -K * 23 / (5.406 * 5.406), 0.001)
  close(Math.abs(r.twa), 36.73, 0.05)
  close(r.tws, 12.64, 0.05)
})

test('config: strings from forms become numbers, sources stay text', () => {
  const { config, errors } = normalizeConfig({ variation: '11.5', sources: { stw: '123' }, corrections: { leeway: { k: '8' } } })
  assert.deepStrictEqual(errors, [])
  assert.strictEqual(config.variation, 11.5)
  assert.strictEqual(config.corrections.leeway.k, 8)
  assert.strictEqual(config.sources.stw, '123')
  assert.strictEqual(config.corrections.twa.enabled, true, 'unspecified values come from the defaults')
})

test('config: bad tables are reported, not accepted', () => {
  const bad = (over, match) => {
    const { errors } = normalizeConfig(over)
    assert.ok(errors.some(e => e.includes(match)), `expected an error mentioning "${match}", got ${JSON.stringify(errors)}`)
  }
  bad({ mode: 'loud' }, 'mode')
  bad({ schema: 3, corrections: { twa: { tws: [5, 10, 15, 20, 25, 30] } } }, 'H5000 layout')
  bad({ schema: 3, corrections: { twa: { upwind: [1, 2] } } }, 'needs 7 values')
  bad({ schema: 3, corrections: { stw: { heel: [-10, 0, 10] } } }, 'H5000 layout')
  bad({ schema: 3, corrections: { stw: { add: [[0, 0, 0, 0, 0, 0, 0]] } } }, 'one row per heel')
  bad({ schema: 3, corrections: { stw: { add: [[null, null, null, null, null, null, null], [null, null, null, null, null, null, null], [null, null, null, null, null, null, null]] } } }, 'no values')
  bad({ schema: 3, corrections: { twa: { upwind: [0, 'x', 0, 0, 0, 0, 0] } } }, 'number or blank')
  bad({ corrections: { leeway: { k: 'x' } } }, 'Leeway K')
})

test('config carries its schema version, now 3', () => {
  const { CONFIG_SCHEMA } = require('../lib/processor')
  assert.strictEqual(CONFIG_SCHEMA, 3)
  assert.strictEqual(normalizeConfig({}).config.schema, 3)
  assert.strictEqual(normalizeConfig({ schema: 3, variation: 11 }).config.variation, 11)
})

test('a config from a newer release is refused, not guessed at', () => {
  const { config, errors } = normalizeConfig({ schema: 4, corrections: { leeway: { k: 6 } } })
  assert.ok(errors[0].includes('newer version'))
  assert.strictEqual(config.corrections.leeway.k, DEFAULTS.corrections.leeway.k, 'falls back to defaults')
})

test('a config from before 0.1.0 is refused: its tables do not apply', () => {
  for (const schema of [1, 2, 'x']) {
    const { config, errors } = normalizeConfig({ schema, corrections: { leeway: { k: 6 } } })
    assert.ok(errors[0].includes('Reset to defaults'), String(schema))
    assert.strictEqual(config.corrections.leeway.k, DEFAULTS.corrections.leeway.k, 'falls back to defaults')
  }
})

test('each step declares what its result replaces, so the webapp can tell published from working values', () => {
  const { config } = normalizeConfig({})
  const steps = process({ awa: 32, aws: 16.9, stw: 5.6, heel: -23, headingMagnetic: 110, sog: 5.4, cog: 119 }, config).steps
  const produces = Object.fromEntries(steps.map(s => [s.id, s.produces]))
  assert.deepStrictEqual(produces, {
    stw: ['stw'], leeway: ['leeway'], truewind: ['twa', 'tws'], twa: ['twa'], tws: ['tws'], current: ['current']
  })
  // With the defaults (TWS table off) the last enabled producer of each quantity is:
  const last = {}
  steps.forEach((s, i) => { if (s.enabled) (s.produces || []).forEach(q => { last[q] = s.id }) })
  assert.deepStrictEqual(last, { stw: 'stw', leeway: 'leeway', twa: 'twa', tws: 'truewind', current: 'current' })
})
