const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const factory = require('../index.js')
const { DEFAULTS } = require('../lib/defaults')

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
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`)
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
  assert.ok(Math.abs(Math.abs(out['environment.wind.angleTrueWaterCorrected']) / RAD - 36.73) < 0.05)
  assert.ok(Math.abs(out['environment.wind.speedTrueCorrected'] * MS_TO_KN - 12.64) < 0.1)
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
  assert.ok(Math.abs(out['navigation.speedThroughWater'] * MS_TO_KN - (6 - 0.2 + 0.2 * 0.05)) < 1e-6)
})

test('ignores its own output, however the source is spelled', () => {
  const h = harness({ mode: 'replace' })
  h.feed(boat)
  for (const src of ['signalk-performance-processor', 'signalk-performance-processor.x']) {
    assert.deepStrictEqual(h.feed(wind, src), [])
  }
})

test('reads only the chosen source when one is set', () => {
  const h = harness({ sources: { stw: 'h2000.II' } })
  h.feed(boat)
  h.feed([{ path: 'navigation.speedThroughWater', value: 1 / MS_TO_KN }], 'signalk-stw-heel-correction')
  const out = paths(h.feed(wind))
  assert.ok(Math.abs(out['environment.wind.speedTrueCorrected'] * MS_TO_KN - 12.64) < 0.1)
})

test('without a chosen STW source, ignores STW from other plugins', () => {
  const h = harness()
  h.feed(boat)
  const out = h.feed([{ path: 'navigation.speedThroughWater', value: 1 / MS_TO_KN }], 'signalk-stw-heel-correction')
  assert.deepStrictEqual(out, [])
  const tw = paths(h.feed(wind))
  assert.ok(Math.abs(tw['environment.wind.speedTrueCorrected'] * MS_TO_KN - 12.64) < 0.1)
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

test('light air: TWA and TWD stop below 1.5 kn of TWS and come back from 2 kn', () => {
  // undamped, so each step in TWS is the TWS the thresholds see
  const h = harness({ mode: 'replace', damping: { heelS: 0, headingS: 0, trueWindS: 0, stwS: 0, currentS: 0 } })
  // Drifting at 0 kn with apparent wind dead ahead: TWS = AWS.
  const still = [{ path: 'navigation.speedThroughWater', value: 0 }, { path: 'navigation.headingTrue', value: 0 },
    { path: 'navigation.attitude', value: { roll: 0 } }]
  const at = kn => paths(h.feed([...still, { path: 'environment.wind.angleApparent', value: 40 * RAD }, { path: 'environment.wind.speedApparent', value: kn / MS_TO_KN }]))
  const sent = o => ['angleTrueWater', 'directionTrue', 'speedTrue'].filter(k => ('environment.wind.' + k) in o)
  assert.deepStrictEqual(sent(at(3)), ['angleTrueWater', 'directionTrue', 'speedTrue'])
  assert.deepStrictEqual(sent(at(1.4)), ['speedTrue'], 'below 1.5 kn: TWS only')
  assert.match(h.statuses[h.statuses.length - 1], /light air/)
  assert.deepStrictEqual(sent(at(1.8)), ['speedTrue'], 'still held between 1.5 and 2')
  assert.deepStrictEqual(sent(at(2.1)), ['angleTrueWater', 'directionTrue', 'speedTrue'], 'back from 2 kn')
  assert.deepStrictEqual(sent(at(1.6)), ['angleTrueWater', 'directionTrue', 'speedTrue'], 'and stays until below 1.5 again')
})

test('stale sensor STW is reported as waiting, not blamed on the sensor', () => {
  const h = harness()
  h.feed([{ path: 'navigation.speedThroughWater', value: 6 / MS_TO_KN }])
  h.feed(wind, 'h2000.II', 4000)
  assert.match(h.statuses[h.statuses.length - 1], /^Waiting for speed through water/)
})

// A steady boat on heading 0, apparent wind at the given angle and speed, every 0.5 s.
function sail (h, seconds, awa, { hdg = 0, aws = 15 } = {}) {
  let out = []
  for (let i = 0; i < seconds * 2; i++) {
    out = h.feed([{ path: 'navigation.speedThroughWater', value: 6 / MS_TO_KN }, { path: 'navigation.headingTrue', value: hdg * RAD },
      { path: 'navigation.attitude', value: { roll: 0 } },
      { path: 'environment.wind.angleApparent', value: awa * RAD }, { path: 'environment.wind.speedApparent', value: aws / MS_TO_KN }], 'h2000.II', 500)
  }
  return paths(out)
}
const plain = { mode: 'replace', corrections: { stw: { enabled: false }, leeway: { enabled: false }, twa: { enabled: false } } }
const deg = v => v / RAD

test('damping: TWD follows a wind shift with the true wind time constant', () => {
  // the undamped answer first: the test clock is shared, so no other plugin may run between
  // the damped one's updates
  const k = harness({ ...plain, damping: { heelS: 0, headingS: 0, trueWindS: 0, stwS: 0, currentS: 0 } })
  const target = deg(sail(k, 2, 50)['environment.wind.directionTrue'])
  const h = harness({ ...plain, damping: { heelS: 0, headingS: 0, trueWindS: 3, stwS: 0, currentS: 0 } })
  const before = deg(sail(h, 20, 40)['environment.wind.directionTrue'])
  const after3 = deg(sail(h, 3, 50)['environment.wind.directionTrue'])
  const share = (after3 - before) / (target - before)
  assert.ok(share > 0.55 && share < 0.72, `about 63% of the shift after one time constant, got ${(share * 100).toFixed(0)}%`)
  const after20 = deg(sail(h, 17, 50)['environment.wind.directionTrue'])
  assert.ok(Math.abs(after20 - target) < 0.05, 'and all of it in the end')
})

test('damping: TWA answers the helm at once, from the steady TWD and the heading now', () => {
  const h = harness({ ...plain, damping: { heelS: 0, headingS: 0, trueWindS: 3, stwS: 0, currentS: 0 } })
  sail(h, 20, 40)
  // bear away 10 deg: TWD is damped, but TWA is that TWD less the new heading, at once
  const b = paths(h.feed([{ path: 'navigation.headingTrue', value: 10 * RAD }, { path: 'environment.wind.angleApparent', value: 50 * RAD }, { path: 'environment.wind.speedApparent', value: 15 / MS_TO_KN }], 'h2000.II', 500))
  const twd = deg(b['environment.wind.directionTrue']); const twa = deg(b['environment.wind.angleTrueWater'])
  close(((twd - 10 - twa) % 360 + 540) % 360 - 180, 0, 1e-9, 'TWA = damped TWD - current heading')
})

test('damping: heading is smoothed before true wind', () => {
  const h = harness({ ...plain, damping: { heelS: 0, headingS: 2, trueWindS: 0, stwS: 0, currentS: 0 } })
  const twd = hdg => deg(sail(h, 1, 40, { hdg })['environment.wind.directionTrue'])
  const before = twd(0)
  // heading jumps 10 deg; TWD follows it with a 2 s time constant
  const soon = twd(10)
  close(soon - before, 10 * (1 - Math.exp(-1 / 2)), 0.01, 'one second in: 39% of the change')
  for (let i = 0; i < 15; i++) twd(10)
  close(twd(10) - before, 10, 0.01, 'all of it after many time constants')
})

test('damping: published STW is smoothed; 0 means none', () => {
  const run = stwS => {
    const h = harness({ mode: 'replace', damping: { heelS: 0, headingS: 0, trueWindS: 0, stwS, currentS: 0 } })
    h.feed([{ path: 'navigation.attitude', value: { roll: 0 } }, { path: 'navigation.speedThroughWater', value: 5 / MS_TO_KN }])
    return paths(h.feed([{ path: 'navigation.speedThroughWater', value: 7 / MS_TO_KN }], 'h2000.II', 500))['navigation.speedThroughWater'] * MS_TO_KN
  }
  assert.ok(run(0) > 6.9, 'undamped')
  const damped = run(1)
  assert.ok(damped > 5.6 && damped < 6.2, `a 2 kn step, half a second into a 1 s time constant: ${damped.toFixed(2)}`)
})

test('config: damping times must be sensible', () => {
  const { normalizeConfig } = require('../lib/processor')
  assert.ok(normalizeConfig({ schema: 3, damping: { trueWindS: -1 } }).errors.some(e => /True wind damping/.test(e)))
  assert.ok(normalizeConfig({ schema: 3, damping: { headingS: -1 } }).errors.some(e => /Heading damping/.test(e)))
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
  const h = harness({ schema: 3, corrections: { twa: { upwind: [1] } } })
  assert.ok(h.errors.some(e => e.includes('TWA table 40° row')))
})

test('GET /calibration returns the boat defaults on a fresh install', async () => {
  const h = harness()
  const r = await h.call('GET', '/calibration')
  assert.strictEqual(r.json.config.corrections.leeway.k, DEFAULTS.corrections.leeway.k)
  assert.strictEqual(r.json.config.mode, 'shadow')
})

test('GET /calibration sends the built-in limits the webapp describes', async () => {
  const h = harness()
  const { json } = await h.call('GET', '/calibration')
  assert.deepStrictEqual(json.behaviour, {
    stwFadeKn: 1, twaRows: { upwind: 40, reach: 90, downwind: 165 }, twsNoneBelowDeg: 90,
    maxLeewayDeg: 15, leewayFadeKn: [1.5, 3], twaTaperUpDeg: 30, twaTaperDownDeg: 10,
    lightAirOffKn: 1.5, lightAirOnKn: 2, staleS: 3, maxPublishHz: 20
  })
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
  assert.strictEqual(h.saved().schema, 3)
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
  // Before the table the TWA is ~45°; after it ~36.7°. Only the latter goes out.
  assert.ok(Math.abs(Math.abs(twa[0].value) / RAD - 36.73) < 0.05)
})
