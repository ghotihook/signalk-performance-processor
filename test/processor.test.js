const test = require('node:test')
const assert = require('node:assert')
const { process, correctInputs, normalizeConfig, _internals } = require('../lib/processor')
const { DEFAULTS } = require('../lib/defaults')

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
  // The measured heel x STW table is symmetric to within 0.008 kn, so very nearly mirrored.
  close(p.twa, -s.twa, 0.05)
  close(p.tws, s.tws, 0.01)
  close(p.leeway, -s.leeway, 0.01)
})

test('STW: the heel x STW grid, exact at its cells, bilinear between, blanks filled', () => {
  const { config } = normalizeConfig({})
  const t = config.corrections.stw
  close(stwGridLookup(t, 0, 6), 0.021, 1e-9, 'cell heel 0, 6 kn')
  close(stwGridLookup(t, -20, 6), -0.111, 1e-9, 'cell heel -20, 6 kn')
  close(stwGridLookup(t, -20, 6.25), (-0.111 + -0.118) / 2, 1e-9, 'between columns')
  close(stwGridLookup(t, -35, 3), -0.276, 1e-9, 'blank cell takes the nearest value in its row')
  close(stwGridLookup(t, 0, 0.25), 0.565 / 2, 1e-9, 'tapers to 0 below the first column')
  close(stwGridLookup(t, 0, 20), 0.003, 1e-9, 'holds the last column')
  close(correctInputs({ stw: 6, heel: -20 }, config).c.stw, 5.889, 1e-9)
})

test('STW: signed heel, so a one-sided paddlewheel can be represented', () => {
  const t = { heel: [-10, 0, 10], stw: [5], add: [[-0.2], [0], [0.1]] }
  close(stwGridLookup(t, -10, 5), -0.2, 1e-9)
  close(stwGridLookup(t, 10, 5), 0.1, 1e-9)
})

test('fillGaps extends rows, then fills an empty row from its neighbour', () => {
  assert.deepStrictEqual(fillGaps([[null, 1, null], [null, null, null], [2, null, 3]]), [[1, 1, 1], [1, 1, 1], [2, 2, 3]])
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
  const expected = interpRow(DEFAULTS.corrections.twa.tws, DEFAULTS.corrections.twa.upwind, plain.tws)
  close(Math.abs(r.twa), Math.abs(plain.twa) + expected, 1e-9)
  close(r.tws, plain.tws, 1e-9, 'TWS untouched by the TWA table')
})

test('TWS table adds knots, downwind only with the defaults (blank = no correction)', () => {
  const config = allOff()
  config.corrections.tws.enabled = true
  const up = process({ awa: 30, aws: 22, stw: 6 }, config).out
  const upPlain = process({ awa: 30, aws: 22, stw: 6 }, allOff()).out
  close(up.tws, upPlain.tws, 1e-9)
  const dn = process({ awa: 150, aws: 12, stw: 8 }, config).out
  const dnPlain = process({ awa: 150, aws: 12, stw: 8 }, allOff()).out
  close(dn.tws, dnPlain.tws + interp([5, 10, 15, 20, 25, 30], [-0.5, -1, -1.5, -2, -2.5, -3], dnPlain.tws), 1e-9)
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
  close(r.stw, 5.4526, 0.001)
  close(r.leeway, -7.9446 * 23 / (5.4526 * 5.4526), 0.001)
  close(Math.abs(r.twa), 38.5, 0.05)
  close(r.tws, 13.05, 0.05)
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
  bad({ schema: 2, corrections: { stw: { heel: [0], stw: [0, 1], add: [[0, 0]] } } }, 'above 0')
  bad({ schema: 2, corrections: { stw: { heel: [0, 10], stw: [1, 2], add: [[0, 0]] } } }, 'one row per heel')
  bad({ schema: 2, corrections: { stw: { heel: [0], stw: [1, 2], add: [[null, null]] } } }, 'no values')
  bad({ corrections: { twa: { upwind: [0, 'x', 0, 0, 0, 0] } } }, 'number or blank')
  bad({ corrections: { leeway: { k: 'x' } } }, 'Leeway K')
})

test('config carries its schema version, now 2', () => {
  const { CONFIG_SCHEMA } = require('../lib/processor')
  assert.strictEqual(CONFIG_SCHEMA, 2)
  assert.strictEqual(normalizeConfig({}).config.schema, 2)
  assert.strictEqual(normalizeConfig({ schema: 2, variation: 11 }).config.variation, 11)
})

test('schema 1 -> 2: two STW rows become their grid, and TWS percent becomes knots', () => {
  const old = {
    schema: 1,
    corrections: {
      stw: { enabled: true, linearity: { stw: [0.5, 6, 8.5], add: [0.58, 0.02, 0] }, heel: { heel: [0, 20], add: [0, -0.13] } },
      tws: { enabled: true, tws: [5, 10, 15, 20, 25, 30], upwind: [0, 0, 0, 0, 0, 0], reach: [0, 0, 0, 0, 0, 0], downwind: [0, 0, -10, -10, -10, -10] }
    }
  }
  const { config, errors } = normalizeConfig(old)
  assert.deepStrictEqual(errors, [])
  assert.strictEqual(config.schema, 2)
  assert.deepStrictEqual(config.corrections.stw.heel, [-20, 0, 20])
  close(stwGridLookup(config.corrections.stw, -20, 6), 0.02 - 0.13, 1e-9)
  assert.deepStrictEqual(config.corrections.tws.downwind, [0, 0, -1.5, -2, -2.5, -3])
})

test('a config with no schema field (0.0.1) is read as schema 1 and upgraded', () => {
  const { config, errors } = normalizeConfig({ corrections: { leeway: { k: 6 } } })
  assert.deepStrictEqual(errors, [])
  assert.strictEqual(config.schema, 2)
  assert.strictEqual(config.corrections.leeway.k, 6)
})

test('a config from a newer release is refused, not guessed at', () => {
  const { config, errors } = normalizeConfig({ schema: 3, corrections: { leeway: { k: 6 } } })
  assert.ok(errors[0].includes('newer version'))
  assert.strictEqual(config.corrections.leeway.k, DEFAULTS.corrections.leeway.k, 'falls back to defaults')
  assert.ok(normalizeConfig({ schema: 'x' }).errors[0].includes('not a schema version'))
})

test('migrations run in order, one step at a time', () => {
  const { migrate } = _internals
  const steps = {
    1: c => ({ ...c, renamed: c.old, old: undefined }),
    2: c => ({ ...c, renamed: c.renamed * 10 })
  }
  const r = migrate({ schema: 1, old: 4 }, steps, 3)
  assert.strictEqual(r.config.schema, 3)
  assert.strictEqual(r.config.renamed, 40)
  assert.ok(migrate({ schema: 1 }, {}, 2).error.includes('no upgrade from 1 to 2'))
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
