const test = require('node:test')
const assert = require('node:assert')
const { dayRows, toRows, missing, RAW_STW } = require('../lib/history')

const KN = 1 / 1.94384
const RAD = Math.PI / 180
const SOURCES = { apparentWind: 'n2k.1', stw: 'n2k.2', heading: 'n2k.3', attitude: 'n2k.4', gps: 'n2k.5', variation: 'n2k.3' }
const T0 = Date.parse('2026-11-07T02:00:00Z')

// A provider holding 10 minutes of sailing at 1 Hz. `series` maps `path|sourceRef` to a value
// per second; it answers 'max' probes per minute and 'first' per second, like the API does.
function fakeApi (series) {
  const asked = []
  return {
    asked,
    async getValues (q) {
      asked.push(q.pathSpecs.map(s => `${s.path}|${s.sourceRef}`))
      const from = q.from.epochMilliseconds; const to = q.to.epochMilliseconds
      const data = []
      for (let t = from; t < to; t += q.resolution * 1000) {
        data.push([new Date(t).toISOString(), ...q.pathSpecs.map(s => {
          const f = series[`${s.path}|${s.sourceRef}`]
          if (!f) return null
          const vals = []
          for (let u = t; u < t + q.resolution * 1000; u += 1000) if (u >= T0 && u < T0 + 600000) vals.push(f((u - T0) / 1000))
          const v = vals.filter(x => x != null)
          return v.length ? (s.aggregate === 'max' ? Math.max(...v) : v[0]) : null
        })])
      }
      return { data }
    }
  }
}

const base = {
  'environment.wind.angleApparent|n2k.1': () => 30 * RAD,
  'environment.wind.speedApparent|n2k.1': () => 15 * KN,
  'navigation.headingMagnetic|n2k.3': () => 100 * RAD,
  'navigation.attitude.roll|n2k.4': () => -15 * RAD,
  'navigation.magneticVariation|n2k.3': () => 12 * RAD
}

test('history: STW from the raw path the plugin publishes, never the corrected value', async () => {
  const api = fakeApi({
    ...base,
    [`${RAW_STW}|spp`]: () => 6 * KN,
    'navigation.speedThroughWater|spp': () => 6.6 * KN, // the plugin's corrected STW, Replace mode
    'navigation.speedThroughWater|undefined': () => 6.6 * KN
  })
  const rows = await dayRows(api, T0 - 3600000, T0 + 3600000, SOURCES, 12.8, 'spp')
  assert.ok(rows.length >= 600)
  const r = rows.find(x => x.t === T0 / 1000 + 300)
  assert.ok(Math.abs(r.stw - 6) < 1e-9, `STW ${r.stw}`)
  assert.ok(Math.abs(r.heel + 15) < 1e-9)
  assert.ok(Math.abs(r.hdg - 112) < 1e-9, 'true heading: magnetic plus variation')
  assert.ok(Math.abs(r.awa - 30) < 1e-9 && Math.abs(r.aws - 15) < 1e-9)
  assert.ok(api.asked.flat().every(p => !p.endsWith('|undefined')), 'every path read from a named source')
})

test('history: without the raw path, STW from the sensor on the standard path', async () => {
  const api = fakeApi({ ...base, 'navigation.speedThroughWater|n2k.2': () => 5 * KN })
  const rows = await dayRows(api, T0 - 3600000, T0 + 3600000, SOURCES, 12.8, 'spp')
  assert.ok(Math.abs(rows.find(x => x.t === T0 / 1000 + 300).stw - 5) < 1e-9)
})

test('history: no sailing, no rows; nothing read at 1 s', async () => {
  const api = fakeApi({ ...base, [`${RAW_STW}|spp`]: () => 0.2 * KN })
  assert.deepStrictEqual(await dayRows(api, T0 - 3600000, T0 + 3600000, SOURCES, 12.8, 'spp'), [])
})

test('history: a value carries forward 3 s (change-only recording), not longer', () => {
  const ts = s => new Date(T0 + s * 1000).toISOString()
  const res = { data: [[ts(0), 3], [ts(1), null], [ts(3), null], [ts(4), null]] }
  const rows = toRows(res, ['stw'], 12.8)
  assert.deepStrictEqual(rows.map(r => r.stw == null), [false, false, false, true])
})

test('history: the inputs learning cannot do without', () => {
  assert.deepStrictEqual(missing({ apparentWind: 'a', stw: 'b' }), ['heading', 'attitude'])
  assert.deepStrictEqual(missing(SOURCES), [])
})

test('history: one device under two names (before and after the server learns its CAN name), each second from the first with a value', async () => {
  const api = fakeApi({
    ...base,
    'environment.wind.angleApparent|n2k.1': t => t < 300 ? null : 30 * RAD, // the CAN name: from 300 s
    'environment.wind.speedApparent|n2k.1': t => t < 300 ? null : 15 * KN,
    'environment.wind.angleApparent|n2k.100': t => t < 300 ? 31 * RAD : null, // the address: until then
    'environment.wind.speedApparent|n2k.100': t => t < 300 ? 14 * KN : null,
    [`${RAW_STW}|spp`]: () => 6 * KN
  })
  const rows = await dayRows(api, T0 - 3600000, T0 + 3600000, { ...SOURCES, apparentWind: ['n2k.1', 'n2k.100'] }, 12.8, 'spp')
  const at = s => rows.find(x => x.t === T0 / 1000 + s)
  assert.ok(Math.abs(at(100).awa - 31) < 1e-9 && Math.abs(at(100).aws - 14) < 1e-9, 'before: the address')
  assert.ok(Math.abs(at(400).awa - 30) < 1e-9 && Math.abs(at(400).aws - 15) < 1e-9, 'after: the CAN name')
  assert.ok(api.asked.flat().includes('environment.wind.angleApparent|n2k.100'))
})
