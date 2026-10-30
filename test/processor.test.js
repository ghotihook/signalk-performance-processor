const test = require('node:test')
const assert = require('node:assert')
const { process, correctInputs, normalizeConfig, _internals } = require('../lib/processor')
const { DEFAULTS } = require('../lib/defaults')
const K = DEFAULTS.corrections.leeway.k

const { interp, fromZero, blendRows, fillGaps, stwGridLookup } = _internals
const T = require('../public/tables')

// Tables for the tests, in the H5000 layout, so the tests do not move when the defaults are
// refitted. The STW table is deliberately not symmetric: port and starboard rows differ.
const STW = { heel: [-20, -10, 0, 10, 20], stw: [2.5, 5, 7.5, 10, 12.5, 15], add: [[0.4, 0.2, 0, -0.1, -0.1, -0.2], [0.3, 0.1, 0, 0, 0, 0], [0.3, 0.05, 0, 0, 0, 0], [0.3, 0.1, 0, 0, 0, 0], [0.35, 0.15, -0.05, -0.1, -0.1, -0.1]] }
const TWA = { tws: [2.5, 5, 7.5, 10, 12.5, 15], upwind: [-9, -7, -5, -2, 3, 6], reach: [-3, -2, -1, 0, 1, 2], downwind: [2, 1, 0, -1, -2, -3] }
const TWS = { tws: [5, 10, 15, 20, 25, 30], upwind: [0, 0, 0, 0, 0, 0], reach: [-0.2, -0.4, -0.6, -0.8, -1, -1.2], downwind: [-0.8, -1.5, -2.3, -3, -3.8, -4.5], upAngle: [50, 50, 50, 50, 50, 50], downAngle: [110, 110, 110, 110, 110, 110] }
function withTables (over = {}) {
  const { config, errors } = normalizeConfig({ corrections: { stw: STW, twa: TWA, tws: { ...TWS, enabled: true }, leeway: { k: 8 }, ...over } })
  assert.deepStrictEqual(errors, [])
  return config
}
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

test('rows blend by TWA: the first in full to its angle, the second at its angle, the third in full from its angle', () => {
  assert.strictEqual(blendRows(30, 40, 90, 165, -10, 0, 4), -10)
  assert.strictEqual(blendRows(65, 40, 90, 165, -10, 0, 4), -5)
  assert.strictEqual(blendRows(90, 40, 90, 165, -10, 0, 4), 0)
  close(blendRows(127.5, 40, 90, 165, -10, 0, 4), 2, 1e-9)
  assert.strictEqual(blendRows(170, 40, 90, 165, -10, 0, 4), 4)
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

test('port and starboard are mirror images when the STW table is', () => {
  const sym = { ...STW, add: [STW.add[0], STW.add[1], STW.add[2], STW.add[1], STW.add[0]] }
  const config = withTables({ stw: sym })
  const s = process({ awa: 32, aws: 16.9, stw: 5.6, heel: -23 }, config).out
  const p = process({ awa: -32, aws: 16.9, stw: 5.6, heel: 23 }, config).out
  close(p.twa, -s.twa, 1e-9)
  close(p.tws, s.tws, 1e-9)
  close(p.leeway, -s.leeway, 1e-9)
  close(p.stw, s.stw, 1e-9)
})

test('STW: H5000 layout, signed heel x boat speed, exact at its cells, bilinear between', () => {
  const t = STW
  const config = { corrections: { stw: { enabled: true, ...t } } }
  close(stwGridLookup(t, 0, 5), 0.05, 1e-9, 'cell heel 0, 5 kn')
  close(stwGridLookup(t, -20, 10), -0.1, 1e-9, 'port: heel -20 row')
  close(stwGridLookup(t, 20, 10), -0.1, 1e-9, 'starboard: heel 20 row')
  close(stwGridLookup(t, -20, 15), -0.2, 1e-9, 'the sides differ')
  close(stwGridLookup(t, 20, 15), -0.1, 1e-9)
  close(stwGridLookup(t, 15, 6.25), ((0.1 + 0) / 2 + (0.15 - 0.05) / 2) / 2, 1e-9, 'bilinear between')
  close(stwGridLookup(t, 30, 10), -0.1, 1e-9, 'more heel than the last row holds the last row')
  close(stwGridLookup(t, -30, 40), -0.2, 1e-9, 'holds the last column')
  close(correctInputs({ stw: 6, heel: -20 }, config).c.stw, 6 + 0.2 + (0 - 0.2) * 1 / 2.5, 1e-9)
})

test('STW: from zero at 0 kn to the 2.5 kn column, so a stopped boat is not given speed', () => {
  close(stwGridLookup(STW, 0, 0), 0, 1e-9)
  close(stwGridLookup(STW, 0, 1.25), 0.15, 1e-9)
  close(stwGridLookup(STW, 0, 2.5), 0.3, 1e-9)
})

test('STW: blank cells take the nearest value in their row', () => {
  const t = { ...STW, add: STW.add.map(r => r.slice()) }
  t.add[2] = [0, 0.1, 0.2, null, null, null]
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
  config.corrections.twa = { enabled: true, ...TWA }
  const plain = process({ awa: 30, aws: 16, stw: 6 }, allOff()).out
  const r = process({ awa: 30, aws: 16, stw: 6 }, config).out
  // Below 40 the upwind row applies alone; beyond, it blends towards the 90 row.
  const up = fromZero(TWA.tws, TWA.upwind, plain.tws)
  const reach = fromZero(TWA.tws, TWA.reach, plain.tws)
  const a = Math.abs(plain.twa)
  const expected = a <= 40 ? up : up + (reach - up) * (a - 40) / 50
  close(Math.abs(r.twa), a + expected, 1e-9)
  close(r.tws, plain.tws, 1e-9, 'TWS untouched by the TWA table')
})

// Stopped boat, so TWA = AWA and TWS = AWS: the TWA correction alone, at any angle.
function twaOnly (twa, tws) {
  const config = allOff()
  config.corrections.twa = { enabled: true, ...TWA }
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
  const bad = (twa, msg) => assert.ok(normalizeConfig({ corrections: { twa } }).errors.some(e => msg.test(e)), msg)
  bad({ upwind: [-30, -12, -5, -5, 0, null] }, /40° row: values must be within/)
  bad({ downwind: [1, -10, 1, null, null, null] }, /165° row: values must be within/)
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

test('TWS table: upwind row to the up angle, reach at 90, downwind from the down angle', () => {
  const config = allOff()
  config.corrections.tws = { enabled: true, ...TWS }
  const at = awa => [process({ awa, aws: 12, stw: 0 }, config).out.tws, process({ awa, aws: 12, stw: 0 }, allOff()).out.tws]
  const reach = fromZero(TWS.tws, TWS.reach, 12)
  const down = fromZero(TWS.tws, TWS.downwind, 12)
  let [c, p] = at(40); close(c, p, 1e-9, 'upwind row (0) up to the up angle')
  ;[c, p] = at(90); close(c, p + reach, 1e-9, 'reach row at 90')
  ;[c, p] = at(70); close(c, p + reach / 2, 1e-9, 'half way from the up angle to 90')
  ;[c, p] = at(100); close(c, p + (reach + down) / 2, 1e-9, 'half way from 90 to the down angle')
  ;[c, p] = at(170); close(c, p + down, 1e-9, 'downwind row beyond the down angle')
  const none = [null, null, null, null, null, null]
  const half = { ...config, corrections: { ...config.corrections, tws: { ...config.corrections.tws, downwind: none } } }
  close(process({ awa: 170, aws: 12, stw: 0 }, half).out.tws, 12 + reach, 1e-9, 'a blank row takes the nearest row')
  const blank = { ...config, corrections: { ...config.corrections, tws: { ...config.corrections.tws, upwind: none, reach: none, downwind: none } } }
  close(process({ awa: 170, aws: 12, stw: 0 }, blank).out.tws, 12, 1e-9, 'a blank table = no correction')
})

test('config: TWS up angles must be below 90 deg and down angles above', () => {
  const errs = tws => normalizeConfig({ corrections: { tws } }).errors
  assert.ok(errs({ downAngle: [110, 110, 80, 110, 110, 110] }).some(e => /down angle row/.test(e)))
  assert.ok(errs({ upAngle: [50, 165, 50, 50, 50, 50] }).some(e => /up angle row: each must be below 90/.test(e)), 'an H5000 up angle of 165 would step at 90')
  assert.ok(errs({ upAngle: [50, null, 50, 50, 50, 50] }).some(e => /up angle/.test(e)), 'angles cannot be blank')
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
  close(r.groundWind.speed, r.tws, 1e-9, 'no current: ground wind is true wind')
  close(r.groundWind.direction, r.twd, 1e-9)
})

test('ground wind is true wind plus current', () => {
  // 10 kn from the north over the water, and 1 kn of current setting east: the air over
  // the ground moves south at 10 and east at 1, so it comes from 354.3° at 10.05 kn.
  // Boat on 090 at 5 kn through the water: true wind 90° to port; ground moves at 6 kn.
  const config = allOff()
  const aws = Math.hypot(10, 5)
  const awa = -Math.atan2(10, 5) * 180 / Math.PI
  const r = process({ awa, aws, stw: 5, headingTrue: 90, sog: 6, cog: 90 }, config).out
  close(r.twd, 0, 1e-9)
  close(r.current.drift, 1, 1e-9)
  close(r.groundWind.speed, Math.hypot(10, 1), 1e-9)
  close(r.groundWind.direction, 360 - Math.atan2(1, 10) * 180 / Math.PI, 1e-9)
  close(r.groundWind.angle, r.groundWind.direction - 360 - 90, 1e-9, 'angle from the bow')
})

test('a worked example, every correction on', () => {
  const r = process({ awa: 32, aws: 16.9, stw: 5.6, heel: -23, headingMagnetic: 110, sog: 5.4, cog: 119 }, withTables()).out
  // STW: heel -23 holds the -20 row; 5.6 kn is between the 5 (0.2) and 7.5 (0) columns.
  const stw = 5.6 + 0.2 - 0.2 * 0.6 / 2.5
  close(r.stw, stw, 1e-9)
  close(r.leeway, -8 * 23 / (stw * stw), 1e-9)
  // True wind from AWA/AWS and corrected STW (leeway stays out), then the tables.
  const x = 16.9 * Math.cos(32 * Math.PI / 180) - stw
  const y = 16.9 * Math.sin(32 * Math.PI / 180)
  const tws0 = Math.hypot(x, y)
  const twa0 = Math.atan2(y, x) * 180 / Math.PI
  const up = fromZero(TWA.tws, TWA.upwind, tws0)
  const reach = fromZero(TWA.tws, TWA.reach, tws0)
  const twa = twa0 + (twa0 <= 40 ? up : up + (reach - up) * (twa0 - 40) / 50)
  close(r.twa, twa, 1e-9)
  close(r.tws, tws0 + T.twsCorrection(TWS, twa, tws0), 1e-9, 'TWS table at the corrected TWA: upwind row, 0')
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
  bad({ corrections: { twa: { tws: [5, 10, 15, 20, 25, 30] } } }, 'H5000 layout')
  bad({ corrections: { twa: { upwind: [1, 2] } } }, 'needs 6 values')
  bad({ corrections: { stw: { heel: [0, 10, 20] } } }, 'H5000 layout')
  bad({ corrections: { stw: { add: [[0, 0, 0, 0, 0, 0]] } } }, 'one row per heel')
  bad({ corrections: { stw: { add: STW.add.map(r => r.map(() => null)) } } }, 'no values')
  bad({ corrections: { twa: { upwind: [0, 'x', 0, 0, 0, 0] } } }, 'number or blank')
  bad({ corrections: { tws: { reach: [0, 0, 0] } } }, 'needs 6 values')
  bad({ corrections: { leeway: { k: 'x' } } }, 'Leeway K')
})

test('config carries its schema version, now 4', () => {
  const { CONFIG_SCHEMA } = require('../lib/processor')
  assert.strictEqual(CONFIG_SCHEMA, 4)
  assert.strictEqual(normalizeConfig({}).config.schema, 4)
  assert.strictEqual(normalizeConfig({ schema: 4, variation: 11 }).config.variation, 11)
})

test('a config from a newer release is refused, not guessed at', () => {
  const { config, errors } = normalizeConfig({ schema: 5, corrections: { leeway: { k: 6 } } })
  assert.ok(errors[0].includes('newer version'))
  assert.strictEqual(config.corrections.leeway.k, DEFAULTS.corrections.leeway.k, 'falls back to defaults')
})

test('a schema 3 config (0.1.0 to 0.2.5) moves forward: settings and K kept, tables reset, Shadow mode', () => {
  const old = { schema: 3, mode: 'replace', variation: 11.5, damping: { heelS: 1, headingS: 0.5, trueWindS: 4, stwS: 2, currentS: 20 },
    sources: { apparentWind: 'can0.105', stw: 'can0.35', heading: '', attitude: '', gps: '', variation: '' },
    corrections: { stw: { enabled: true, heel: [0, 10, 20], stw: [0, 5, 10, 15, 20, 25, 30], add: [[0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]] },
      leeway: { enabled: false, k: 6.2 }, twa: { enabled: false, tws: [0, 5, 10, 15, 20, 25, 30], upwind: [0, 1, 1, 1, 1, 1, 1], reach: [0, 0, 0, 0, 0, 0, 0], downwind: [0, 0, 0, 0, 0, 0, 0] },
      tws: { enabled: true, tws: [0, 5, 10, 15, 20, 25, 30], correction: [0, -1, -1, -1, -1, -1, -1], downAngle: [165, 165, 165, 165, 165, 165, 165] } } }
  const { config, errors, notices } = normalizeConfig(old)
  assert.deepStrictEqual(errors, [])
  assert.match(notices[0], /settings and leeway K kept.*tables reset.*Shadow mode/)
  assert.strictEqual(config.schema, 4)
  assert.strictEqual(config.mode, 'shadow', 'never Replace with tables from another boat')
  assert.strictEqual(config.variation, 11.5)
  assert.deepStrictEqual(config.damping, old.damping)
  assert.deepStrictEqual(config.sources, old.sources)
  assert.deepStrictEqual(config.corrections.leeway, { enabled: false, k: 6.2 })
  for (const t of ['stw', 'twa', 'tws']) assert.deepStrictEqual(config.corrections[t], DEFAULTS.corrections[t], t)
  assert.deepStrictEqual(normalizeConfig({ schema: 3 }).errors, [], 'a bare schema 3 file moves forward too')
  assert.deepStrictEqual(normalizeConfig({}).notices, [], 'no notice for a current file')
})

test('a config from before 0.1.0 is refused: its tables do not apply', () => {
  for (const schema of [1, 2, 'x']) {
    const { config, errors } = normalizeConfig({ schema, corrections: { leeway: { k: 6 } } })
    assert.ok(errors[0].includes('earlier release') && errors[0].includes('Reset to defaults'), String(schema))
    assert.strictEqual(config.corrections.leeway.k, DEFAULTS.corrections.leeway.k, 'falls back to defaults')
  }
})

test('each step declares what its result replaces, so the webapp can tell published from working values', () => {
  const { config } = normalizeConfig({})
  const steps = process({ awa: 32, aws: 16.9, stw: 5.6, heel: -23, headingMagnetic: 110, sog: 5.4, cog: 119 }, config).steps
  const produces = Object.fromEntries(steps.map(s => [s.id, s.produces]))
  assert.deepStrictEqual(produces, {
    stw: ['stw'], leeway: ['leeway'], truewind: ['twa', 'tws'], twa: ['twa'], tws: ['tws'], current: ['current'], groundwind: ['groundWind']
  })
  // With the defaults (every table on) the last enabled producer of each quantity is:
  const last = {}
  steps.forEach((s, i) => { if (s.enabled) (s.produces || []).forEach(q => { last[q] = s.id }) })
  assert.deepStrictEqual(last, { stw: 'stw', leeway: 'leeway', twa: 'twa', tws: 'tws', current: 'current', groundWind: 'groundwind' })
})
