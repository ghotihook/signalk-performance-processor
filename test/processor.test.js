const test = require('node:test')
const assert = require('node:assert')
const { process, correctInputs, normalizeConfig, _internals } = require('../lib/processor')
const { DEFAULTS } = require('../lib/defaults')

const { interp, blendRows } = _internals
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

test('rows blend by TWA at the configured angles', () => {
  const a = { upwind: 70, reach: 100, downwind: 130 }
  assert.strictEqual(blendRows(40, a, -10, 0, 4), -10)
  assert.strictEqual(blendRows(85, a, -10, 0, 4), -5)
  assert.strictEqual(blendRows(100, a, -10, 0, 4), 0)
  assert.strictEqual(blendRows(115, a, -10, 0, 4), 2)
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
  close(p.twa, -s.twa, 1e-9)
  close(p.tws, s.tws, 1e-9)
  close(p.leeway, -s.leeway, 1e-9)
})

test('STW: linearity plus heel row, tapering to zero below the first bin', () => {
  const { config } = normalizeConfig({})
  close(correctInputs({ stw: 6, heel: 0 }, config).c.stw, 6.02, 1e-9)
  close(correctInputs({ stw: 6, heel: -20 }, config).c.stw, 6 + 0.02 - 0.13, 1e-9)
  close(correctInputs({ stw: 0.25, heel: 0 }, config).c.stw, 0.25 + 0.29, 1e-9)
  close(correctInputs({ stw: 0, heel: 0 }, config).c.stw, 0, 1e-9)
})

test('leeway is K x heel / STW^2, to leeward, and needs heel', () => {
  const { config } = normalizeConfig({})
  config.corrections.stw.enabled = false
  const c = correctInputs({ stw: 6, heel: -20 }, config).c
  close(c.leeway, 7.9446 * -20 / 36, 1e-9)
  assert.ok(c.leeway < 0, 'starboard tack heels to port and slides to port')
  const none = correctInputs({ stw: 6, heel: null }, config)
  assert.strictEqual(none.c.leeway, 0)
  assert.strictEqual(none.steps.find(s => s.id === 'leeway').skipped, 'no heel data')
})

test('TWA table narrows TWA by the table value', () => {
  const config = allOff()
  config.corrections.twa.enabled = true
  const plain = process({ awa: 30, aws: 16, stw: 6 }, allOff()).out
  const r = process({ awa: 30, aws: 16, stw: 6 }, config).out
  const expected = interp(DEFAULTS.corrections.twa.tws, DEFAULTS.corrections.twa.upwind, plain.tws)
  close(Math.abs(r.twa), Math.abs(plain.twa) + expected, 1e-9)
  close(r.tws, plain.tws, 1e-9, 'TWS untouched by the TWA table')
})

test('TWS table scales TWS by percent, downwind only with the defaults', () => {
  const config = allOff()
  config.corrections.tws.enabled = true
  const up = process({ awa: 30, aws: 22, stw: 6 }, config).out
  const upPlain = process({ awa: 30, aws: 22, stw: 6 }, allOff()).out
  close(up.tws, upPlain.tws, 1e-9)
  const dn = process({ awa: 150, aws: 12, stw: 8 }, config).out
  const dnPlain = process({ awa: 150, aws: 12, stw: 8 }, allOff()).out
  close(dn.tws, dnPlain.tws * (1 + interp([5, 10, 15, 20, 25, 30], [0, 0, -11.1, -14.4, -14.4, -14.4], dnPlain.tws) / 100), 1e-9)
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
  close(r.stw, 5.456, 0.001)
  close(r.leeway, -7.9446 * 23 / (5.456 * 5.456), 0.001)
  close(Math.abs(r.twa), 38.0, 0.3)
  close(r.tws, 13.0, 0.1)
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
  bad({ corrections: { twa: { tws: [5, 10, 10, 20, 25, 30] } } }, 'must increase')
  bad({ corrections: { twa: { upwind: [1, 2] } } }, 'needs 6 values')
  bad({ corrections: { twa: { angles: { upwind: 120, reach: 100, downwind: 130 } } } }, 'angles')
  bad({ corrections: { stw: { linearity: { stw: [0, 1], add: [0, 0] } } } }, 'above 0')
  bad({ corrections: { leeway: { k: 'x' } } }, 'Leeway K')
})
