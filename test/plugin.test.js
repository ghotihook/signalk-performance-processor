const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const factory = require('../index.js')

const MS_TO_KN = 1.94384
const RAD = Math.PI / 180

// A fake Signal K app: collects what the plugin publishes, says and saves.
// options: what the server would pass to start(); stored: a config.json already on disk.
function harness (stored = null, options = {}) {
  const published = []; const meta = []; const statuses = []; const errors = []
  let onDelta = null
  const routes = {}
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spp-'))
  if (stored) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(stored))
  const app = {
    getDataDirPath: () => dir,
    debug () {},
    error: m => errors.push(m),
    setPluginError: m => errors.push(m),
    setPluginStatus: m => statuses.push(m),
    handleMessage (id, delta) {
      const u = delta.updates[0]
      if (u.meta) meta.push(...u.meta.map(x => x.path))
      else published.push({ id, values: u.values })
    },
    subscriptionmanager: {
      subscribe: (s, unsub, onErr, cb) => { onDelta = cb; unsub.push(() => { onDelta = null }) }
    }
  }
  const plugin = factory(app)
  plugin.registerWithRouter({
    get: (p, fn) => { routes['GET ' + p] = fn },
    put: (p, fn) => { routes['PUT ' + p] = fn }
  })
  plugin.start(options)

  function feed (values, source = 'h2000.II') {
    if (!onDelta) return []
    const before = published.length
    onDelta({ updates: [{ $source: source, timestamp: '2026-01-01T00:00:00.000Z', values }] })
    return published.slice(before)
  }
  async function call (method, path, body) {
    let status = 200; let json
    const res = { set () {}, status (s) { status = s; return res }, json (b) { json = b } }
    await routes[`${method} ${path}`]({ body }, res)
    return { status, json }
  }
  const saved = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) } catch (e) { return null } }
  return { plugin, app, dir, published, meta, statuses, errors, feed, call, saved }
}

const boat = [
  { path: 'navigation.speedThroughWater', value: 5.6 / MS_TO_KN },
  { path: 'navigation.attitude', value: { roll: -23 * RAD, pitch: 0, yaw: 0 } },
  { path: 'navigation.headingMagnetic', value: 110 * RAD },
  { path: 'navigation.speedOverGround', value: 5.4 / MS_TO_KN },
  { path: 'navigation.courseOverGroundTrue', value: 119 * RAD }
]
const wind = [
  { path: 'environment.wind.angleApparent', value: 32 * RAD },
  { path: 'environment.wind.speedApparent', value: 16.9 / MS_TO_KN }
]
const paths = out => Object.fromEntries(out.flatMap(o => o.values).map(v => [v.path, v.value]))

test('subscribes to every input with sourcePolicy all', () => {
  let sub = null
  const app = { debug () {}, error () {}, setPluginError () {}, setPluginStatus () {}, handleMessage () {}, getDataDirPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'spp-')),
    subscriptionmanager: { subscribe: (s, u) => { sub = s; u.push(() => {}) } } }
  factory(app).start({})
  assert.strictEqual(sub.sourcePolicy, 'all')
  const want = ['environment.wind.angleApparent', 'environment.wind.speedApparent', 'navigation.speedThroughWater',
    'navigation.headingMagnetic', 'navigation.headingTrue', 'navigation.attitude',
    'navigation.speedOverGround', 'navigation.courseOverGroundTrue', 'navigation.magneticVariation']
  assert.deepStrictEqual(sub.subscribe.map(s => s.path).sort(), want.sort())
})

test('shadow mode publishes …Corrected paths with units', () => {
  const h = harness()
  h.feed(boat)
  const out = paths(h.feed(wind))
  assert.ok(Math.abs(Math.abs(out['environment.wind.angleTrueWaterCorrected']) / RAD - 38.0) < 0.3)
  assert.ok(Math.abs(out['environment.wind.speedTrueCorrected'] * MS_TO_KN - 13.0) < 0.1)
  assert.ok('environment.wind.directionTrueCorrected' in out)
  assert.ok('navigation.leewayAngleCorrected' in out)
  assert.ok(out['environment.currentCorrected'].drift >= 0)
  assert.ok(!('environment.wind.speedTrue' in out), 'standard paths untouched in shadow mode')
  assert.ok(h.meta.includes('environment.wind.speedTrueCorrected'))
})

test('replace mode publishes the standard paths', () => {
  const h = harness({ mode: 'replace' })
  h.feed(boat)
  const out = paths(h.feed(wind))
  assert.ok('environment.wind.angleTrueWater' in out)
  assert.ok('environment.wind.speedTrue' in out)
  assert.strictEqual(h.meta.length, 0)
})

test('corrected STW goes out when the paddlewheel reports', () => {
  const h = harness({ mode: 'replace' })
  const out = paths(h.feed([{ path: 'navigation.attitude', value: { roll: -20 * RAD } }, { path: 'navigation.speedThroughWater', value: 6 / MS_TO_KN }]))
  assert.ok(Math.abs(out['navigation.speedThroughWater'] * MS_TO_KN - (6 + 0.02 - 0.13)) < 1e-6)
})

test('ignores its own output, however the source is spelled', () => {
  const h = harness({ mode: 'replace' })
  h.feed(boat)
  for (const src of ['signalk-performance-processor', 'signalk-performance-processor.x']) {
    assert.deepStrictEqual(h.feed(wind, src), [])
  }
})

test('catches its own STW returning under a foreign source, and says so once', () => {
  const h = harness({ mode: 'replace' })
  h.feed([{ path: 'navigation.attitude', value: { roll: -20 * RAD } }])
  const out = paths(h.feed([{ path: 'navigation.speedThroughWater', value: 6 / MS_TO_KN }]))
  const echo = out['navigation.speedThroughWater']
  h.feed([{ path: 'navigation.speedThroughWater', value: echo }], 'mystery')
  h.feed([{ path: 'navigation.speedThroughWater', value: echo }], 'mystery')
  assert.strictEqual(h.errors.filter(e => e.includes('Loop guard')).length, 1)
})

test('reads only the chosen source when one is set', () => {
  const h = harness({ sources: { stw: 'h2000.II' } })
  h.feed(boat)
  h.feed([{ path: 'navigation.speedThroughWater', value: 1 / MS_TO_KN }], 'signalk-stw-heel-correction')
  const out = paths(h.feed(wind))
  assert.ok(Math.abs(out['environment.wind.speedTrueCorrected'] * MS_TO_KN - 13.0) < 0.1)
})

test('no true wind without STW, and the status says why', () => {
  const h = harness()
  assert.deepStrictEqual(h.feed(wind), [])
  assert.match(h.statuses[h.statuses.length - 1], /speed through water/)
})

test('rejects implausible input rather than publishing it', () => {
  const h = harness()
  assert.deepStrictEqual(h.feed([{ path: 'navigation.speedThroughWater', value: 99 / MS_TO_KN }]), [], 'no corrected STW from a faulty sensor')
  assert.deepStrictEqual(h.feed(wind).filter(o => o.values.some(v => v.path.startsWith('environment.wind'))), [])
  assert.match(h.statuses[h.statuses.length - 1], /not plausible/)
})

test('reports a bad stored config instead of starting', () => {
  const h = harness({ corrections: { twa: { upwind: [1] } } })
  assert.ok(h.errors.some(e => e.includes('TWA table upwind row')))
})

test('GET /config returns the boat defaults on a fresh install', async () => {
  const h = harness()
  const r = await h.call('GET', '/config')
  assert.strictEqual(r.json.config.corrections.leeway.k, 7.9446)
  assert.strictEqual(r.json.config.mode, 'shadow')
})

test('PUT /config validates, saves and restarts', async () => {
  const h = harness()
  const bad = await h.call('PUT', '/config', { mode: 'nope' })
  assert.strictEqual(bad.status, 400)
  assert.strictEqual(h.saved(), null)

  const ok = await h.call('PUT', '/config', { mode: 'replace', corrections: { leeway: { k: '9' } } })
  assert.strictEqual(ok.status, 200)
  assert.strictEqual(h.saved().corrections.leeway.k, 9)
  h.feed(boat)
  assert.ok('environment.wind.speedTrue' in paths(h.feed(wind)), 'restarted in replace mode')
})

test('GET /live reports the last result, inputs and sources seen', async () => {
  const h = harness()
  h.feed(boat)
  h.feed(wind)
  const r = await h.call('GET', '/live')
  assert.ok(r.json.running)
  assert.ok(r.json.result.steps.some(s => s.id === 'twa'))
  assert.deepStrictEqual(r.json.sourcesSeen.apparentWind, ['h2000.II'])
  assert.strictEqual(r.json.outputPaths.tws, 'environment.wind.speedTrueCorrected')
})

test('the admin form holds nothing: tables are configured in the webapp', () => {
  const s = factory({}).schema
  assert.deepStrictEqual(s.properties, {})
  assert.match(s.description, /Webapps/)
})

test('saved config survives a restart, and the plugin options are ignored', async () => {
  const h = harness()
  await h.call('PUT', '/config', { corrections: { leeway: { k: 6.5 } } })
  h.plugin.stop()
  h.plugin.start({ corrections: { leeway: { k: 1 } } })
  const r = await h.call('GET', '/config')
  assert.strictEqual(r.json.config.corrections.leeway.k, 6.5)
})

test('the saved file records its schema version', async () => {
  const h = harness()
  await h.call('PUT', '/config', { corrections: { leeway: { k: 6.5 } } })
  assert.strictEqual(h.saved().schema, 1)
})

test('a config left in the plugin options by 0.0.1 is picked up until the webapp saves', async () => {
  const h = harness(null, { corrections: { leeway: { k: 5 } } })
  const r = await h.call('GET', '/config')
  assert.strictEqual(r.json.config.corrections.leeway.k, 5)
})

test('a broken config file is reported, and the webapp can still load and fix it', async () => {
  const h = harness({ corrections: { twa: { upwind: [1] } } })
  assert.ok(h.errors.some(e => e.includes('fix it in the webapp')))
  const r = await h.call('GET', '/config')
  assert.strictEqual(r.status, 200)
})

test('variation: true heading first, then GPS variation, then the fallback', async () => {
  const RAD = Math.PI / 180
  const twd = (extra) => {
    const h = harness()
    h.feed(boat.concat(extra))
    return paths(h.feed(wind))['environment.wind.directionTrueCorrected'] / RAD
  }
  const fallback = twd([])
  const gps = twd([{ path: 'navigation.magneticVariation', value: 10 * RAD }])
  const trueHdg = twd([{ path: 'navigation.magneticVariation', value: 10 * RAD }, { path: 'navigation.headingTrue', value: 200 * RAD }])
  assert.ok(Math.abs(((fallback - gps + 540) % 360) - 180 - 2.8) < 1e-6, 'GPS variation 10° vs fallback 12.8°')
  assert.ok(Math.abs(trueHdg - gps) > 50, 'true heading wins')
})

test('stop unsubscribes', () => {
  const h = harness()
  h.plugin.stop()
  assert.deepStrictEqual(h.feed(boat.concat(wind)), [])
})

test('never overwrites a config saved by a newer release', async () => {
  const h = harness({ schema: 99, corrections: {} })
  assert.ok(h.errors.some(e => e.includes('newer version')))
  const r = await h.call('PUT', '/config', {})
  assert.strictEqual(r.status, 500)
  assert.match(r.json.errors[0], /newer version/)
  assert.strictEqual(h.saved().schema, 99, 'file left untouched')
})
