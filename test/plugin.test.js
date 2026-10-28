const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const factory = require('../index.js')

const MS_TO_KN = 1.94384
const RAD = Math.PI / 180

// A clock the tests move. Each sample arrives 100 ms after the last, as from a 10 Hz
// sensor, unless a test says otherwise; the publish rate limit depends on it.
let clock = Date.parse('2026-01-01T00:00:00Z')
Date.now = () => clock

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

  // Sensors arrive with a source object, as from a data connection; a source named
  // like a plugin arrives without one, as a plugin's output does.
  function feed (values, source = 'h2000.II', afterMs = 100) {
    if (!onDelta) return []
    clock += afterMs
    const before = published.length
    const update = { $source: source, timestamp: '2026-01-01T00:00:00.000Z', values }
    if (!source.startsWith('signalk-')) update.source = { label: source.split('.')[0], type: 'NMEA0183', talker: 'II' }
    onDelta({ updates: [update] })
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
  assert.ok(Math.abs(Math.abs(out['environment.wind.angleTrueWaterCorrected']) / RAD - 38.5) < 0.05)
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
  assert.ok(Math.abs(out['navigation.speedThroughWater'] * MS_TO_KN - (6 - 0.111)) < 1e-6)
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

test('without a chosen STW source, ignores STW from other plugins', () => {
  const h = harness()
  h.feed(boat)
  const out = h.feed([{ path: 'navigation.speedThroughWater', value: 1 / MS_TO_KN }], 'signalk-stw-heel-correction')
  assert.deepStrictEqual(out, [])
  const tw = paths(h.feed(wind))
  assert.ok(Math.abs(tw['environment.wind.speedTrueCorrected'] * MS_TO_KN - 13.0) < 0.1)
})

test('reads STW from a plugin when it is chosen in Settings', () => {
  const h = harness({ mode: 'replace', sources: { stw: 'signalk-stw-heel-correction' } })
  h.feed([{ path: 'navigation.attitude', value: { roll: -20 * RAD } }])
  const out = paths(h.feed([{ path: 'navigation.speedThroughWater', value: 6 / MS_TO_KN }], 'signalk-stw-heel-correction'))
  assert.ok('navigation.speedThroughWater' in out)
})

test('says so when STW comes only from another plugin', () => {
  const h = harness()
  h.feed([{ path: 'navigation.speedThroughWater', value: 6 / MS_TO_KN }], 'signalk-stw-heel-correction')
  h.feed(wind)
  assert.match(h.statuses[h.statuses.length - 1], /only from signalk-stw-heel-correction/)
})

// Two STW correctors on one server, each handing its output to the other the way the
// server delivers it: synchronously, to every subscriber of the path.
function twoCorrectors (sources) {
  const subs = []; let stwDeliveries = 0; let depth = 0; const errors = []; const statuses = []
  const deliver = (id, delta) => {
    const u = { $source: id, timestamp: '2026-01-01T00:00:00.000Z', ...delta.updates[0] }
    if (u.values && u.values.some(v => v.path === 'navigation.speedThroughWater')) stwDeliveries++
    if (++depth > 500) throw new Error('unbounded loop')
    try { for (const cb of subs) cb({ updates: [u] }) } finally { depth-- }
  }
  const app = { getDataDirPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'spp-')), debug () {},
    error: m => errors.push(m), setPluginError: m => errors.push(m), setPluginStatus: m => statuses.push(m),
    handleMessage: (id, delta) => { if (delta.updates[0].values) deliver(id, delta) },
    subscriptionmanager: { subscribe: (s, unsub, onErr, cb) => { subs.push(cb); unsub.push(() => {}) } } }
  const dir = app.getDataDirPath()
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'replace', sources }))
  app.getDataDirPath = () => dir
  factory(app).start({})
  // The other corrector: corrects any STW not its own, as signalk-stw-heel-correction 0.2 did.
  subs.push(d => {
    const u = d.updates[0]
    if (u.$source === 'other-corrector') return
    for (const v of u.values || []) {
      if (v.path === 'navigation.speedThroughWater') deliver('other-corrector', { updates: [{ values: [{ path: v.path, value: v.value + 0.01 }] }] })
    }
  })
  const sensor = (path, value) => {
    clock += 300
    for (const cb of subs.slice()) cb({ updates: [{ $source: 'h2000.II', source: { label: 'h2000', type: 'NMEA0183' }, timestamp: 't', values: [{ path, value }] }] })
  }
  sensor('navigation.attitude', { roll: -20 * RAD })
  return { sensor, errors, statuses, deliveries: () => stwDeliveries }
}

test('two STW correctors do not feed each other by default', () => {
  const t = twoCorrectors({})
  t.sensor('navigation.speedThroughWater', 6 / MS_TO_KN)
  // ours corrects the sensor; the other corrects the sensor and ours; nothing comes back
  assert.ok(t.deliveries() <= 3, `${t.deliveries()} STW updates from one sample`)
  assert.deepStrictEqual(t.errors, [])
})

test('a loop through another plugin is cut at the first repeat, flagged, and never locks up', () => {
  const t = twoCorrectors({ stw: 'other-corrector' })
  for (let k = 0; k < 5; k++) {
    const before = t.deliveries()
    assert.doesNotThrow(() => t.sensor('navigation.speedThroughWater', 6 / MS_TO_KN))
    // sensor -> other -> ours -> other -> ours dropped: the chain ends
    assert.ok(t.deliveries() - before <= 4, `${t.deliveries() - before} STW updates from one sample`)
  }
  t.sensor('environment.wind.angleApparent', 32 * RAD)
  t.sensor('environment.wind.speedApparent', 16.9 / MS_TO_KN)
  assert.match(t.statuses[t.statuses.length - 1], /Rate limited: \d+ updates .* "other-corrector"/)
  assert.strictEqual(t.errors.filter(e => /Rate limited/.test(e)).length, 1, 'logged once per episode')
})

test('a burst is thinned to 20 Hz, not stopped, and the flag clears', () => {
  const h = harness({ mode: 'replace' })
  h.feed([{ path: 'navigation.attitude', value: { roll: -20 * RAD } }])
  let published = 0
  for (let i = 0; i < 300; i++) published += h.feed([{ path: 'navigation.speedThroughWater', value: (5 + i * 0.001) / MS_TO_KN }], 'h2000.II', 1).length
  assert.ok(published >= 6 && published <= 7, `${published} of 300 published over 0.3 s`)
  // back to a normal rate: every sample goes out again
  for (let i = 0; i < 5; i++) assert.strictEqual(h.feed([{ path: 'navigation.speedThroughWater', value: 6 / MS_TO_KN }]).length, 1)
  h.feed(boat); h.feed(wind)
  assert.match(h.statuses[h.statuses.length - 1], /Rate limited/)
  h.feed(wind, 'h2000.II', 11000)
  assert.doesNotMatch(h.statuses[h.statuses.length - 1], /Rate limited/)
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

test('GET /calibration returns the boat defaults on a fresh install', async () => {
  const h = harness()
  const r = await h.call('GET', '/calibration')
  assert.strictEqual(r.json.config.corrections.leeway.k, 7.9446)
  assert.strictEqual(r.json.config.mode, 'shadow')
})

test('PUT /calibration validates, saves and restarts', async () => {
  const h = harness()
  const bad = await h.call('PUT', '/calibration', { mode: 'nope' })
  assert.strictEqual(bad.status, 400)
  assert.strictEqual(h.saved(), null)

  const ok = await h.call('PUT', '/calibration', { mode: 'replace', corrections: { leeway: { k: '9' } } })
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
  await h.call('PUT', '/calibration', { corrections: { leeway: { k: 6.5 } } })
  h.plugin.stop()
  h.plugin.start({ corrections: { leeway: { k: 1 } } })
  const r = await h.call('GET', '/calibration')
  assert.strictEqual(r.json.config.corrections.leeway.k, 6.5)
})

test('the saved file records its schema version', async () => {
  const h = harness()
  await h.call('PUT', '/calibration', { corrections: { leeway: { k: 6.5 } } })
  assert.strictEqual(h.saved().schema, 2)
})

test('a config left in the plugin options by 0.0.1 is picked up until the webapp saves', async () => {
  const h = harness(null, { corrections: { leeway: { k: 5 } } })
  const r = await h.call('GET', '/calibration')
  assert.strictEqual(r.json.config.corrections.leeway.k, 5)
})

test('a broken config file is reported, and the webapp can still load and fix it', async () => {
  const h = harness({ corrections: { twa: { upwind: [1] } } })
  assert.ok(h.errors.some(e => e.includes('fix it in the webapp')))
  const r = await h.call('GET', '/calibration')
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
  const r = await h.call('PUT', '/calibration', {})
  assert.strictEqual(r.status, 500)
  assert.match(r.json.errors[0], /newer version/)
  assert.strictEqual(h.saved().schema, 99, 'file left untouched')
})

test('registers no route the Signal K server already owns on a plugin router', () => {
  // The server adds GET / and GET/POST /config to every plugin's router before calling
  // registerWithRouter, so a plugin route on those paths is silently never reached.
  const seen = []
  factory({}).registerWithRouter({ get: p => seen.push('GET ' + p), put: p => seen.push('PUT ' + p), post: p => seen.push('POST ' + p) })
  for (const r of seen) assert.ok(!/^(GET|POST) \/(config)?$/.test(r), `${r} is shadowed by the server`)
  assert.ok(seen.includes('GET /calibration') && seen.includes('PUT /calibration'))
})

test('publishes one TWA per update: the corrected one, never the working value', () => {
  const h = harness()
  h.feed(boat)
  const values = h.feed(wind).flatMap(o => o.values)
  const twa = values.filter(v => v.path.startsWith('environment.wind.angleTrue'))
  assert.strictEqual(twa.length, 1, 'exactly one TWA value')
  assert.strictEqual(twa[0].path, 'environment.wind.angleTrueWaterCorrected')
  // Before the table the TWA is ~47°; after it ~38.5°. Only the latter goes out.
  assert.ok(Math.abs(Math.abs(twa[0].value) / RAD - 38.5) < 0.05)
})
