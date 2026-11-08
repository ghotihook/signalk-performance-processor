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
    const update = { $source: source, timestamp: new Date(clock).toISOString(), values }
    if (!source.startsWith('signalk-')) update.source = { label: source.split('.')[0], type: 'NMEA0183', talker: 'II' }
    onDelta({ updates: [update] })
    return published.slice(before)
  }
  async function call (method, path, body, query) {
    let status = 200; let json
    const res = { set () {}, status (s) { status = s; return res }, json (b) { json = b } }
    await routes[`${method} ${path}`]({ body, query }, res)
    return { status, json }
  }
  const saved = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) } catch (e) { return null } }
  const deliver = d => { clock += 100; if (onDelta) onDelta(d) }
  return { plugin, app, dir, published, meta, statuses, errors, feed, call, saved, deliver }
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
// Apparent wind with the compass in the same delta: TWA goes out with the heading (§6.3).
const windHdg = [...wind, { path: 'navigation.headingMagnetic', value: 110 * RAD }]
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`)
const paths = out => Object.fromEntries(out.flatMap(o => o.values).map(v => [v.path, v.value]))

// Tables with something in them, so a test can tell corrected from uncorrected whatever
// the defaults hold; and what the processor makes of the boat and wind above with them.
const TABLES = {
  stw: { heel: [-20, -10, 0, 10, 20], stw: [1, 2.5, 5, 7.5, 10, 12.5, 15], add: [[0.16, 0.4, 0.2, 0, -0.1, -0.1, -0.2], [0.12, 0.3, 0.1, 0, 0, 0, 0], [0.12, 0.3, 0.05, 0, 0, 0, 0], [0.12, 0.3, 0.1, 0, 0, 0, 0], [0.14, 0.35, 0.15, -0.05, -0.1, -0.1, -0.1]] }, // 1 kn column at 0.4 x the 2.5 kn one: the straight line from zero
  twa: { twa: [40, 90, 165], tws: [5, 10, 15, 20, 25, 30], add: [[-9, -7, -5, -2, -4, -6], [-3, -2, -1, 0, 1, 2], [2, 1, 0, -1, -2, -3]] }
}
function model (stored = {}) {
  const { process, normalizeConfig } = require('../lib/processor')
  return process({ awa: 32, aws: 16.9, stw: 5.6, heel: -23, headingMagnetic: 110, sog: 5.4, cog: 119 }, normalizeConfig(stored).config).out
}

test('subscribes to every input with sourcePolicy all', () => {
  let sub = null
  const app = { debug () {}, error () {}, setPluginError () {}, setPluginStatus () {}, handleMessage () {}, getDataDirPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'spp-')),
    subscriptionmanager: { subscribe: (s, u) => { sub = s; u.push(() => {}) } } }
  factory(app).start({})
  assert.strictEqual(sub.sourcePolicy, 'all')
  const want = ['environment.wind.angleApparent', 'environment.wind.speedApparent', 'navigation.speedThroughWater',
    'navigation.headingMagnetic', 'navigation.headingTrue', 'navigation.attitude',
    'navigation.speedOverGround', 'navigation.courseOverGroundTrue', 'navigation.courseOverGroundMagnetic', 'navigation.magneticVariation']
  assert.deepStrictEqual(sub.subscribe.map(s => s.path).sort(), want.sort())
})

test('shadow mode publishes …Corrected paths with units', () => {
  const h = harness({ corrections: TABLES })
  h.feed(boat)
  const out = paths(h.feed(windHdg))
  const m = model({ corrections: TABLES })
  close(out['environment.wind.angleTrueWaterCorrected'] / RAD, m.twa, 1e-6)
  close(out['environment.wind.speedTrueCorrected'] * MS_TO_KN, m.tws, 1e-4)
  assert.ok('environment.wind.directionTrueCorrected' in out)
  assert.ok('navigation.leewayAngleCorrected' in out)
  assert.ok(out['environment.currentCorrected'].drift >= 0)
  for (const p of ['speedOverGround', 'angleTrueGround', 'directionGround']) assert.ok(`environment.wind.${p}Corrected` in out, `ground wind ${p}`)
  assert.ok(!('environment.wind.speedTrue' in out), 'standard paths untouched in shadow mode')
  assert.ok(h.meta.includes('environment.wind.speedTrueCorrected'))
})

test('replace mode publishes the standard paths', () => {
  const h = harness({ mode: 'replace' })
  h.feed(boat)
  const out = paths(h.feed(windHdg))
  assert.ok('environment.wind.angleTrueWater' in out)
  assert.ok('environment.wind.speedTrue' in out)
  assert.ok('environment.wind.speedOverGround' in out)
  assert.deepStrictEqual(h.meta, ['environment.wind.directionGround', 'navigation.speedThroughWaterRaw'], 'meta only for the paths the schema lacks')
})

test('corrected STW goes out when the paddlewheel reports', () => {
  const h = harness({ mode: 'replace', corrections: TABLES })
  const out = paths(h.feed([{ path: 'navigation.attitude', value: { roll: -20 * RAD } }, { path: 'navigation.speedThroughWater', value: 6 / MS_TO_KN }]))
  // Heel -20 (port side down): the -20 row, 6 kn between its 5 (0.2) and 7.5 (0) columns.
  close(out['navigation.speedThroughWater'] * MS_TO_KN, 6 + 0.2 - 0.2 * 1 / 2.5, 1e-6)
})

test('ignores its own output, however the source is spelled', () => {
  const h = harness({ mode: 'replace' })
  h.feed(boat)
  for (const src of ['signalk-performance-processor', 'signalk-performance-processor.x']) {
    assert.deepStrictEqual(h.feed(wind, src), [])
  }
})

test('without a chosen STW source, ignores STW from other plugins', () => {
  const h = harness()
  h.feed(boat)
  const out = h.feed([{ path: 'navigation.speedThroughWater', value: 1 / MS_TO_KN }], 'signalk-stw-heel-correction')
  assert.deepStrictEqual(out, [])
  const tw = paths(h.feed(wind))
  close(tw['environment.wind.speedTrueCorrected'] * MS_TO_KN, model().tws, 1e-4)
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

test('a burst from another plugin is thinned to 50 Hz, not stopped, and the flag clears', () => {
  const h = harness({ mode: 'replace', sources: { stw: 'signalk-other' } })
  h.feed([{ path: 'navigation.attitude', value: { roll: -20 * RAD } }])
  let published = 0
  for (let i = 0; i < 300; i++) published += h.feed([{ path: 'navigation.speedThroughWater', value: (5 + i * 0.001) / MS_TO_KN }], 'signalk-other', 1).length
  assert.ok(published >= 15 && published <= 16, `${published} of 300 published over 0.3 s`)
  // back to a normal rate: every sample goes out again
  for (let i = 0; i < 5; i++) assert.strictEqual(h.feed([{ path: 'navigation.speedThroughWater', value: 6 / MS_TO_KN }], 'signalk-other').length, 1)
  h.feed(boat); h.feed(wind)
  assert.match(h.statuses[h.statuses.length - 1], /Rate limited/)
  h.feed(wind, 'h2000.II', 11000)
  assert.doesNotMatch(h.statuses[h.statuses.length - 1], /Rate limited/)
})

test('a sensor is never rate limited: a gateway burst all goes out, and is not called a loop', () => {
  const h = harness({ mode: 'replace' })
  h.feed(boat); h.feed(windHdg)
  let hdt = 0
  for (let i = 0; i < 20; i++) {
    h.feed(boat, 'h2000.II', 250)
    for (let k = 0; k < 3; k++) hdt += 'navigation.headingTrue' in paths(h.feed([{ path: 'navigation.headingMagnetic', value: (110 + k) * RAD }], 'h2000.II', 0)) ? 1 : 0
  }
  assert.strictEqual(hdt, 60, 'every compass message in each burst')
  h.feed(windHdg)
  assert.doesNotMatch(h.statuses[h.statuses.length - 1], /Rate limited/)
  assert.deepStrictEqual(h.errors.filter(e => /Rate limited/.test(e)), [])
})

test('light air: TWD stops below 1.5 kn of TWS and comes back from 2 kn; TWA never stops', async () => {
  // undamped, so each step in TWS is the TWS the thresholds see
  const h = harness({ mode: 'replace', damping: { heelS: 0, trueWindS: 0, stwS: 0, currentS: 0 } })
  // Drifting at 0 kn with apparent wind dead ahead: TWS = AWS.
  const still = [{ path: 'navigation.speedThroughWater', value: 0 }, { path: 'navigation.headingTrue', value: 0 },
    { path: 'navigation.attitude', value: { roll: 0 } }]
  const at = kn => paths(h.feed([...still, { path: 'environment.wind.angleApparent', value: 40 * RAD }, { path: 'environment.wind.speedApparent', value: kn / MS_TO_KN }]))
  const sent = o => ['angleTrueWater', 'directionTrue', 'speedTrue'].filter(k => ('environment.wind.' + k) in o)
  assert.deepStrictEqual(sent(at(3)), ['angleTrueWater', 'directionTrue', 'speedTrue'])
  assert.deepStrictEqual(sent(at(1.4)), ['angleTrueWater', 'speedTrue'], 'below 1.5 kn: TWA and TWS, no TWD')
  assert.match(h.statuses[h.statuses.length - 1], /light air/)
  assert.deepStrictEqual(sent(at(1.8)), ['angleTrueWater', 'speedTrue'], 'TWD still held between 1.5 and 2')
  assert.deepStrictEqual(sent(at(0.3)), ['angleTrueWater', 'speedTrue'], 'TWA in a breath of wind too')
  h.feed([...still, { path: 'environment.wind.angleApparent', value: 40 * RAD }, { path: 'environment.wind.speedApparent', value: 0.3 / MS_TO_KN }], 'h2000.II', 3500)
  const live = await h.call('GET', '/live')
  assert.ok(live.json.sent.includes('twa') && !live.json.sent.includes('twd'), 'the Live page lists what is sent: TWD drops out once held for 3 s')
  assert.deepStrictEqual(sent(at(2.1)), ['angleTrueWater', 'directionTrue', 'speedTrue'], 'back from 2 kn')
  assert.deepStrictEqual(sent(at(1.6)), ['angleTrueWater', 'directionTrue', 'speedTrue'], 'and stays until below 1.5 again')
})

test('stale sensor STW is reported as waiting, not blamed on another plugin', () => {
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
  const k = harness({ ...plain, damping: { heelS: 0, trueWindS: 0, stwS: 0, currentS: 0 } })
  const target = deg(sail(k, 2, 50)['environment.wind.directionTrue'])
  const h = harness({ ...plain, damping: { heelS: 0, trueWindS: 3, stwS: 0, currentS: 0 } })
  const before = deg(sail(h, 20, 40)['environment.wind.directionTrue'])
  const after3 = deg(sail(h, 3, 50)['environment.wind.directionTrue'])
  const share = (after3 - before) / (target - before)
  assert.ok(share > 0.55 && share < 0.72, `about 63% of the shift after one time constant, got ${(share * 100).toFixed(0)}%`)
  const after20 = deg(sail(h, 17, 50)['environment.wind.directionTrue'])
  assert.ok(Math.abs(after20 - target) < 0.05, 'and all of it in the end')
})

test('damping: TWA answers the helm at once, from the steady TWD and the heading now', () => {
  const h = harness({ ...plain, damping: { heelS: 0, trueWindS: 3, twaS: 0, stwS: 0, currentS: 0 } })
  sail(h, 20, 40)
  // bear away 10 deg: TWD is damped, but TWA is that TWD less the new heading, at once
  const b = paths(h.feed([{ path: 'navigation.headingTrue', value: 10 * RAD }, { path: 'environment.wind.angleApparent', value: 50 * RAD }, { path: 'environment.wind.speedApparent', value: 15 / MS_TO_KN }], 'h2000.II', 500))
  const twd = deg(b['environment.wind.directionTrue']); const twa = deg(b['environment.wind.angleTrueWater'])
  close(((twd - 10 - twa) % 360 + 540) % 360 - 180, 0, 1e-9, 'TWA = damped TWD - current heading')
})

test('damping: heading is never damped, even with heading damping saved from an earlier release', () => {
  const h = harness({ ...plain, damping: { heelS: 0, headingS: 2, trueWindS: 0, stwS: 0, currentS: 0 } })
  const twd = hdg => deg(sail(h, 1, 40, { hdg })['environment.wind.directionTrue'])
  const before = twd(0)
  // heading jumps 10 deg (the wind steady relative to the boat): TWD takes all of it at once
  close(twd(10) - before, 10, 1e-9, 'heading taken as it is')
})

test('damping: heel takes every attitude message, not only those before an STW or wind update', async () => {
  // Roll swinging ±10° at 10 Hz, with wind always arriving just after a +10° sample. Damping
  // only the samples that came before a wind update would see +10° every time.
  const h = harness({ damping: { heelS: 2, trueWindS: 0, stwS: 0, currentS: 0 } })
  const rest = boat.filter(v => v.path !== 'navigation.attitude')
  for (let t = 0; t < 60; t++) {
    h.feed([{ path: 'navigation.attitude', value: { roll: (t % 2 ? 10 : -10) * RAD } }], 'h2000.II', 100)
    if (t % 2) h.feed(rest.concat(wind), 'h2000.II', 0)
  }
  const { json } = await h.call('GET', '/live')
  assert.ok(Math.abs(json.result.input.heel) < 1.5, `heel ${json.result.input.heel.toFixed(2)}°: the average of the swing, near 0`)
})

test('damping: published STW is smoothed; 0 means none', () => {
  const run = stwS => {
    const h = harness({ mode: 'replace', damping: { heelS: 0, trueWindS: 0, stwS, currentS: 0 } })
    h.feed([{ path: 'navigation.attitude', value: { roll: 0 } }, { path: 'navigation.speedThroughWater', value: 5 / MS_TO_KN }])
    return paths(h.feed([{ path: 'navigation.speedThroughWater', value: 7 / MS_TO_KN }], 'h2000.II', 500))['navigation.speedThroughWater'] * MS_TO_KN
  }
  assert.ok(run(0) > 6.9, 'undamped')
  const damped = run(1)
  assert.ok(damped > 5.6 && damped < 6.2, `a 2 kn step, half a second into a 1 s time constant: ${damped.toFixed(2)}`)
})

test('config: damping times must be sensible', () => {
  const { normalizeConfig } = require('../lib/processor')
  assert.ok(normalizeConfig({ damping: { trueWindS: -1 } }).errors.some(e => /True wind damping/.test(e)))
})

test('config: heading damping is not a setting: a saved value is dropped, with a notice if it damped', () => {
  const { normalizeConfig } = require('../lib/processor')
  const damped = normalizeConfig({ damping: { headingS: 2 } })
  assert.deepStrictEqual(damped.errors, [])
  assert.ok(!('headingS' in damped.config.damping))
  assert.ok(damped.notices.some(n => /Heading damping \(2 s\) is no longer a setting/.test(n)))
  const zero = normalizeConfig({ damping: { headingS: 0 } })
  assert.ok(!('headingS' in zero.config.damping))
  assert.deepStrictEqual(zero.notices, [], 'nothing to say when it was already 0')
  assert.deepStrictEqual(normalizeConfig({ damping: { headingS: -1 } }).errors, [], 'any saved value is dropped, not checked')
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
  assert.match(h.statuses[h.statuses.length - 1], /STW of 99.0 kn is not plausible/)
  const a = harness()
  a.feed(boat)
  assert.deepStrictEqual(a.feed([{ path: 'environment.wind.angleApparent', value: 0.5 }, { path: 'environment.wind.speedApparent', value: 150 / MS_TO_KN }]), [])
  assert.match(a.statuses[a.statuses.length - 1], /AWS of 150.0 kn is not plausible/)
  const k = harness()
  k.feed(boat.map(v => v.path === 'navigation.attitude' ? { ...v, value: { roll: 120 * RAD } } : v))
  k.feed(wind)
  assert.match(k.statuses[k.statuses.length - 1], /no heel/, 'heel beyond 90° is a fault: treated as missing')
})

test('reports a bad stored config instead of starting', () => {
  const h = harness({ schema: 7, corrections: { twa: { twa: [40], tws: [5], add: [[1, 2]] } } })
  assert.ok(h.errors.some(e => e.includes('TWA table 40° TWA row')))
})

test('a saved file that fails its checks: the webapp gets its good parts and what was reset, and Save keeps the old file', async () => {
  const stored = { schema: 7, mode: 'replace', variation: 4.4, damping: { trueWindS: 5 }, corrections: { leeway: { enabled: true, k: 6.66 }, twa: { enabled: true, twa: [40, 90], tws: [5, 10], add: [[50, 50], [0, 0]] } } }
  const h = harness(stored)
  assert.ok(h.errors.some(e => /TWA table/.test(e)), 'not started, and says why')
  const { json } = await h.call('GET', '/calibration')
  assert.strictEqual(json.config.corrections.leeway.k, 6.66, 'own K kept')
  assert.strictEqual(json.config.variation, 4.4)
  assert.strictEqual(json.config.mode, 'replace')
  assert.strictEqual(json.config.damping.trueWindS, 5)
  assert.deepStrictEqual(json.config.corrections.twa, DEFAULTS.corrections.twa, 'the bad table from the defaults')
  assert.deepStrictEqual(json.problem.reset, ['TWA table'])
  assert.ok(json.problem.errors.some(e => /TWA table/.test(e)))
  assert.strictEqual((await h.call('GET', '/live')).json.running, false, 'never run on the salvaged values')
  const r = await h.call('PUT', '/calibration', { damping: { stwS: 2 } }) // a change to something else
  assert.strictEqual(r.status, 200)
  assert.strictEqual(h.saved().corrections.leeway.k, 6.66, 'K survives the save')
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(h.dir, 'config.json.bad'), 'utf8')), stored, 'the old file kept')
  assert.strictEqual((await h.call('GET', '/calibration')).json.problem, null)
  assert.strictEqual((await h.call('GET', '/live')).json.running, true)
})

test('a good file is not backed up on Save', async () => {
  const h = harness({ schema: 7, variation: 3 })
  await h.call('PUT', '/calibration', { variation: 4 })
  assert.ok(!fs.existsSync(path.join(h.dir, 'config.json.bad')))
  assert.strictEqual((await h.call('GET', '/calibration')).json.problem, null)
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
    maxLeewayDeg: 15, leewayFadeKn: [1.5, 3], twaTaperUpDeg: 30, twaTaperDownDeg: 10, twaSlopeMax: 2,
    lightAirOffKn: 1.5, lightAirOnKn: 2, staleS: 3, maxPublishHz: 50
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
  h.feed(windHdg)
  const r = await h.call('GET', '/live')
  assert.ok(r.json.running)
  assert.ok(r.json.result.steps.some(s => s.id === 'twa'))
  assert.deepStrictEqual(r.json.sources.apparentWind.map(s => s.source), ['h2000.II'])
  assert.deepStrictEqual(r.json.sent.sort(), ['current', 'gwa', 'gwd', 'gws', 'hdt', 'leeway', 'stw', 'stwRaw', 'twa', 'twd', 'tws'], 'what has gone out, for the Live page to list')
  assert.strictEqual(r.json.outputPaths.tws, 'environment.wind.speedTrueCorrected')
})

test('GET /live reports each output\'s rate: TWA at the compass\'s, TWS and TWD at the wind\'s', async () => {
  const h = harness()
  h.feed(boat)
  for (let t = 0; t < 50; t++) {
    h.feed([{ path: 'navigation.headingMagnetic', value: (110 + t % 3) * RAD }], 'h2000.II', 100) // 10 Hz
    if (t % 5 === 4) h.feed(wind, 'h2000.II', 0) // 2 Hz, with the compass
  }
  const { json } = await h.call('GET', '/live')
  close(json.sentHz.twa, 10, 0.3, 'TWA')
  close(json.sentHz.hdt, 10, 0.3, 'heading')
  close(json.sentHz.tws, 2, 0.1, 'TWS')
  close(json.sentHz.twd, 2, 0.1, 'TWD')
  close(json.sources.heading.find(x => x.source === 'h2000.II').hz, 10, 0.3, 'the compass, as Settings shows it')
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

test('a 0.2.5 config keeps running after the upgrade, in Shadow mode, saying so until saved', async () => {
  const h = harness({ schema: 3, mode: 'replace', sources: { stw: 'h2000.II' }, corrections: { leeway: { k: 6.2 } } })
  assert.deepStrictEqual(h.errors.filter(e => !/Upgraded/.test(e)), [], 'not refused')
  h.feed(boat)
  const out = paths(h.feed(wind))
  assert.ok('environment.wind.speedTrueCorrected' in out && !('environment.wind.speedTrue' in out), 'Shadow paths only')
  assert.match(h.statuses[h.statuses.length - 1], /^Upgraded from an earlier release.*Save · /)
  const r = await h.call('GET', '/calibration')
  assert.strictEqual(r.json.config.corrections.leeway.k, 6.2)
  assert.strictEqual(r.json.config.sources.stw, 'h2000.II')
  assert.strictEqual(h.saved().schema, 3, 'the file is left as it was until Save')
  await h.call('PUT', '/calibration', r.json.config)
  assert.strictEqual(h.saved().schema, 7)
  h.feed(boat)
  assert.doesNotMatch(h.statuses[h.statuses.length - 1], /Upgraded/, 'the notice goes once saved')
})

test('the saved file records its schema version', async () => {
  const h = harness()
  await h.call('PUT', '/calibration', { corrections: { leeway: { k: 6.5 } } })
  assert.strictEqual(h.saved().schema, 7)
})

test('a broken config file is reported, and the webapp can still load and fix it', async () => {
  const h = harness({ corrections: { twa: { twa: [40], tws: [5], add: [[1, 2]] } } })
  assert.ok(h.errors.some(e => e.includes('fix it in the webapp')))
  const r = await h.call('GET', '/calibration')
  assert.strictEqual(r.status, 200)
  const live = (await h.call('GET', '/live')).json
  assert.ok(!live.running && /TWA table 40° TWA row.*fix it in the webapp/.test(live.error), 'the webapp can say why it is not running')
})

test('variation: true heading first, then GPS variation, then the fallback', () => {
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
  const h = harness({ corrections: TABLES })
  h.feed(boat)
  const values = h.feed(windHdg).flatMap(o => o.values)
  const twa = values.filter(v => v.path.startsWith('environment.wind.angleTrueWater'))
  assert.strictEqual(twa.length, 1, 'exactly one TWA value')
  assert.strictEqual(twa[0].path, 'environment.wind.angleTrueWaterCorrected')
  // Only the TWA after the table goes out, not the one before it.
  const m = model({ corrections: TABLES })
  const before = model({ corrections: { ...TABLES, twa: { enabled: false } } })
  assert.ok(Math.abs(m.twa - before.twa) > 1, 'the table moves this TWA')
  close(twa[0].value / RAD, m.twa, 1e-6)
})

// ---- input sources and true heading (0.2.8) ----

test('heading from another plugin is ignored by default: derived-data true heading lags the compass', () => {
  const h = harness()
  h.feed([{ path: 'navigation.headingTrue', value: 200 * RAD }], 'signalk-derived-data')
  h.feed(boat)
  const out = paths(h.feed(wind))
  const m = model()
  close(deg(out['environment.wind.directionTrueCorrected']), m.twd, 1e-6, 'TWD from the compass, magnetic + variation, not 200°')
})

test('true heading goes out with each compass update: magnetic heading + variation', () => {
  const h = harness()
  const out = paths(h.feed([{ path: 'navigation.headingMagnetic', value: 110 * RAD }]))
  close(deg(out['navigation.headingTrueCorrected']), 122.8, 1e-9, 'fallback variation 12.8')
  const gps = paths(h.feed([{ path: 'navigation.magneticVariation', value: 10 * RAD }, { path: 'navigation.headingMagnetic', value: 355 * RAD }]))
  close(deg(gps['navigation.headingTrueCorrected']), 5, 1e-9, 'variation from Signal K, wrapped past 360')
  const r = harness({ mode: 'replace' })
  assert.ok('navigation.headingTrue' in paths(r.feed([{ path: 'navigation.headingMagnetic', value: 110 * RAD }])), 'standard path in Replace mode')
})

test('COG magnetic is used when there is no COG true, turned true with the variation', () => {
  const run = cog => {
    const h = harness()
    h.feed(boat.filter(v => v.path !== 'navigation.courseOverGroundTrue').concat(cog))
    return paths(h.feed(wind))['environment.currentCorrected']
  }
  const want = paths((() => { const h = harness(); h.feed(boat); return h.feed(wind) })())['environment.currentCorrected']
  assert.strictEqual(run([]), undefined, 'no COG, no current')
  const mag = run([{ path: 'navigation.courseOverGroundMagnetic', value: (119 - 12.8) * RAD }])
  close(mag.drift, want.drift, 1e-9, 'drift')
  close(mag.setTrue, want.setTrue, 1e-9, 'set')
  const both = run([{ path: 'navigation.courseOverGroundTrue', value: 119 * RAD }, { path: 'navigation.courseOverGroundMagnetic', value: 200 * RAD }])
  close(both.setTrue, want.setTrue, 1e-9, 'COG true first when the GPS sends both')
})

test('no true heading is sent when the heading sensor sends true heading itself', () => {
  const h = harness()
  h.feed([{ path: 'navigation.headingTrue', value: 120 * RAD }], 'gpscompass.II')
  assert.ok(!('navigation.headingTrueCorrected' in paths(h.feed([{ path: 'navigation.headingMagnetic', value: 110 * RAD }], 'gpscompass.II'))))
})

test('two heel sensors: the one sending most often is used, the other never mixed in', () => {
  const h = harness({ mode: 'replace' })
  // The compass sends roll once a second, 4.6° off; the IMU ten times a second. The compass
  // happens to arrive first.
  const compass = { path: 'navigation.attitude', value: { roll: 4.43 * RAD } }
  const imu = { path: 'navigation.attitude', value: { roll: -0.15 * RAD } }
  h.feed([compass], 'compass.II', 100)
  for (let t = 0; t < 40; t++) {
    h.feed([imu], 'imu.II', 100)
    if (t % 10 === 9) h.feed([compass], 'compass.II', 0)
  }
  h.feed(boat.filter(v => v.path !== 'navigation.attitude'))
  h.feed([imu], 'imu.II', 100)
  h.feed(wind)
  return h.call('GET', '/live').then(({ json }) => {
    assert.strictEqual(json.inUse.attitude, 'imu.II')
    assert.strictEqual(json.inputs['navigation.attitude'].source, 'imu.II')
    close(json.result.input.heel, -0.15, 0.05, 'the IMU heel, with no compass steps in it')
    assert.doesNotMatch(h.statuses[h.statuses.length - 1], /compass/, 'the other sensor is not reported: Settings lists it')
  })
})

test('a chosen source overrides the automatic choice', async () => {
  const h = harness({ sources: { attitude: 'compass.II' } })
  for (let t = 0; t < 30; t++) h.feed([{ path: 'navigation.attitude', value: { roll: -0.15 * RAD } }], 'imu.II', 100)
  h.feed([{ path: 'navigation.attitude', value: { roll: 4.43 * RAD } }], 'compass.II', 100)
  h.feed(boat.filter(v => v.path !== 'navigation.attitude'))
  h.feed(wind)
  const { json } = await h.call('GET', '/live')
  assert.strictEqual(json.inUse.attitude, 'compass.II')
  close(json.result.input.heel, 4.43, 0.01)
})

test('when a chosen sensor goes quiet, the input is missing and the status names the other', () => {
  const h = harness({ sources: { attitude: 'imu.II' } })
  for (let t = 0; t < 30; t++) h.feed([{ path: 'navigation.attitude', value: { roll: -0.15 * RAD } }], 'imu.II', 100)
  h.feed([{ path: 'navigation.attitude', value: { roll: 4.43 * RAD } }], 'compass.II', 4000) // the IMU is now 4 s old
  h.feed(boat.filter(v => v.path !== 'navigation.attitude'))
  h.feed(wind)
  assert.match(h.statuses[h.statuses.length - 1], /no heel \(compass\.II sends it: choose it in Settings\)/)
})

test('apparent wind arriving as two deltas, as the server delivers it: one true wind per message, with both halves', () => {
  const h = harness()
  h.feed(boat)
  const at = ts => ({ $source: 'h2000.II', source: { label: 'h2000', type: 'NMEA2000' }, timestamp: ts })
  // The server hands a plugin one delta per path; both carry the sensor message's timestamp.
  const send = (path, value, ts) => {
    const before = h.published.length
    h.deliver({ updates: [{ ...at(ts), values: [{ path, value }] }] })
    return h.published.slice(before)
  }
  assert.deepStrictEqual(send('environment.wind.angleApparent', 32 * RAD, 't1'), [], 'waits for the speed')
  const out = paths(send('environment.wind.speedApparent', 16.9 / MS_TO_KN, 't1'))
  close(out['environment.wind.speedTrueCorrected'] * MS_TO_KN, model().tws, 1e-4, 'the new AWS, not the last one')
  // The next message: the angle alone does not go out with the old speed.
  assert.deepStrictEqual(send('environment.wind.angleApparent', 40 * RAD, 't2'), [])
  assert.ok(paths(send('environment.wind.speedApparent', 16.9 / MS_TO_KN, 't2'))['environment.wind.speedTrueCorrected'] != null)
  assert.doesNotMatch(h.statuses[h.statuses.length - 1], /Rate limited/)
})

test('a wind source whose angle and speed never share a timestamp is still worked out', () => {
  const h = harness()
  h.feed(boat)
  const send = (path, value, ts) => { const n = h.published.length; h.deliver({ updates: [{ $source: 'h2000.II', source: { label: 'h2000' }, timestamp: ts, values: [{ path, value }] }] }); return h.published.slice(n) }
  send('environment.wind.angleApparent', 32 * RAD, 'a1')
  send('environment.wind.speedApparent', 16.9 / MS_TO_KN, 'b1')
  assert.ok(send('environment.wind.angleApparent', 32 * RAD, 'a2').length, 'on its second value')
})

test('an occasional update inside 20 ms (sensor timing) is dropped without flagging a loop', () => {
  const h = harness()
  h.feed(boat)
  h.feed([{ path: 'navigation.headingMagnetic', value: 110 * RAD }], 'h2000.II', 100)
  h.feed([{ path: 'navigation.headingMagnetic', value: 110.1 * RAD }], 'h2000.II', 8) // CAN jitter
  h.feed(wind)
  assert.doesNotMatch(h.statuses[h.statuses.length - 1], /Rate limited/)
  assert.deepStrictEqual(h.errors.filter(e => /Rate limited/.test(e)), [])
})

test('a 50 Hz heading sensor: true heading and TWA go out with every update, and nothing looks like a loop', () => {
  const h = harness()
  h.feed(boat)
  h.feed(windHdg)
  let hdt = 0; let twa = 0
  for (let t = 0; t < 100; t++) {
    const out = paths(h.feed([{ path: 'navigation.headingMagnetic', value: (110 + t % 3) * RAD }], 'h2000.II', 20))
    hdt += 'navigation.headingTrueCorrected' in out ? 1 : 0
    twa += 'environment.wind.angleTrueWaterCorrected' in out ? 1 : 0
    if (t % 20 === 19) h.feed(wind, 'h2000.II', 0) // fresh wind every 0.4 s
  }
  assert.strictEqual(hdt, 100)
  assert.strictEqual(twa, 100)
  assert.deepStrictEqual(h.errors.filter(e => /Rate limited/.test(e)), [])
  assert.doesNotMatch(h.statuses[h.statuses.length - 1], /Rate limited/)
})

test('Settings can show each source of an input with its message rate; one message in two deltas counts once', async () => {
  const h = harness()
  const att = (src, ts) => ({ updates: [{ $source: src, source: { label: src }, timestamp: ts, values: [{ path: 'navigation.attitude', value: { roll: 0 } }] }] })
  for (let t = 0; t < 30; t++) {
    h.deliver(att('imu.II', `i${t}`))
    if (t % 10 === 9) { clock -= 100; h.deliver(att('compass.II', `c${t}`)) }
  }
  for (let t = 0; t < 10; t++) {
    const ts = `w${t}`
    h.deliver({ updates: [{ $source: 'h2000.II', source: { label: 'h2000' }, timestamp: ts, values: [{ path: 'environment.wind.angleApparent', value: 0.5 }] }] })
    h.deliver({ updates: [{ $source: 'h2000.II', source: { label: 'h2000' }, timestamp: ts, values: [{ path: 'environment.wind.speedApparent', value: 5 }] }] })
  }
  h.feed([{ path: 'navigation.headingTrue', value: 1 }], 'signalk-derived-data')
  const { json } = await h.call('GET', '/live')
  const hz = (input, src) => json.sources[input].find(s => s.source === src).hz
  close(hz('attitude', 'imu.II'), 10, 0.5)
  close(hz('attitude', 'compass.II'), 1, 0.2)
  close(hz('apparentWind', 'h2000.II'), 5, 0.3, 'messages every 200 ms (two deltas 100 ms apart each), not values')
  assert.deepStrictEqual(json.sources.heading, [{ source: 'signalk-derived-data', hz: 0, plugin: true }])
})

// ---- missing inputs, said in the status (0.2.10) ----

test('when apparent wind stops, the status says so rather than showing the last true wind', () => {
  const h = harness()
  h.feed(boat)
  h.feed(wind)
  assert.match(h.statuses[h.statuses.length - 1], /^Shadow — TWA/)
  h.feed(boat, 'h2000.II', 12000) // the other inputs carry on; the wind has not come for 12 s
  assert.match(h.statuses[h.statuses.length - 1], /^No apparent wind for 12 s: nothing published/)
})

test('a stale heading means no TWD or current, and the status says so', () => {
  const h = harness()
  h.feed(boat)
  h.feed(boat.filter(v => v.path !== 'navigation.headingMagnetic'), 'h2000.II', 3500)
  const out = paths(h.feed(wind))
  assert.ok(!('environment.wind.directionTrueCorrected' in out) && !('environment.currentCorrected' in out))
  assert.ok('environment.wind.speedTrueCorrected' in out, 'TWS still goes out')
  assert.match(h.statuses[h.statuses.length - 1], /no heading/)
})

test('without SOG/COG the status says there is no current or ground wind, and names a plugin that sends it', () => {
  const h = harness()
  h.feed(boat.filter(v => !/OverGround/.test(v.path)))
  h.feed([{ path: 'navigation.courseOverGroundTrue', value: 1 }], 'signalk-derived-data')
  h.feed(wind)
  assert.match(h.statuses[h.statuses.length - 1], /no SOG\/COG, so no current or ground wind \(only from signalk-derived-data, another plugin: choose it in Settings to use it\)/)
})

test('Auto chooses once: a sensor that starts after the first 2 s does not take over', async () => {
  const h = harness()
  for (let t = 0; t < 25; t++) h.feed([{ path: 'navigation.attitude', value: { roll: 4.43 * RAD } }], 'compass.II', 1000) // 1 Hz, for 25 s
  for (let t = 0; t < 50; t++) { // 10 Hz from now on, with the compass still sending
    h.feed([{ path: 'navigation.attitude', value: { roll: -0.15 * RAD } }], 'imu.II', 100)
    if (t % 10 === 9) h.feed([{ path: 'navigation.attitude', value: { roll: 4.43 * RAD } }], 'compass.II', 0)
  }
  const { json } = await h.call('GET', '/live')
  assert.strictEqual(json.inUse.attitude, 'compass.II', 'kept while it sends; choose the IMU in Settings')
})

// ---- Auto follows a sensor that stops or is renamed (0.2.15) ----

const SPEED = 'navigation.speedThroughWater'

test('a device renamed by the server when it learns the CAN name is followed, without a restart', async () => {
  const h = harness({ mode: 'replace' })
  for (let t = 0; t < 30; t++) { h.feed(wind, 'n2k.100', 250); h.feed([{ path: SPEED, value: 3 }], 'n2k.100', 250) }
  let out = []
  for (let t = 0; t < 12; t++) { out = out.concat(h.feed(wind, 'n2k.c079', 250)); out = out.concat(h.feed([{ path: SPEED, value: 3 }], 'n2k.c079', 250)) }
  const { json } = await h.call('GET', '/live')
  assert.strictEqual(json.inUse.apparentWind, 'n2k.c079')
  assert.strictEqual(json.inUse.stw, 'n2k.c079')
  assert.ok('environment.wind.speedTrue' in paths(out), 'true wind goes out again')
  assert.ok(SPEED in paths(out), 'STW goes out again')
  assert.ok(h.errors.some(e => /STW from n2k\.c079: n2k\.100 stopped sending/.test(e)), 'the server log records it')
  assert.match(json.status, /apparent wind from n2k\.c079: n2k\.100 stopped sending/)
})

test('the move to another sensor is reported for a minute', async () => {
  const h = harness({ mode: 'replace' })
  for (let t = 0; t < 30; t++) h.feed([{ path: SPEED, value: 3 }], 'a.II', 100)
  for (let t = 0; t < 35; t++) h.feed([{ path: SPEED, value: 3 }], 'b.II', 100)
  h.feed(boat); h.feed(wind, 'b.II')
  assert.match((await h.call('GET', '/live')).json.status, /STW from b\.II/)
  for (let t = 0; t < 65; t++) { h.feed(boat, 'b.II', 500); h.feed(wind, 'b.II', 500) }
  assert.doesNotMatch((await h.call('GET', '/live')).json.status, /stopped sending/)
})

test('the replacement sensor is the busiest one still sending, and stays when the first returns', async () => {
  const h = harness({ mode: 'replace' })
  const heel = v => [{ path: 'navigation.attitude', value: { roll: v * RAD } }]
  for (let t = 0; t < 40; t++) { // imu 10 Hz, compass 1 Hz, gyro stops after a moment
    h.feed(heel(1), 'imu.II', 100)
    if (t % 10 === 0) h.feed(heel(5), 'compass.II', 0)
    if (t < 5) h.feed(heel(9), 'gyro.II', 0)
  }
  assert.strictEqual((await h.call('GET', '/live')).json.inUse.attitude, 'imu.II')
  for (let t = 0; t < 40; t++) {
    h.feed(heel(2), 'imu2.II', 100)
    if (t % 10 === 0) h.feed(heel(5), 'compass.II', 0)
  }
  assert.strictEqual((await h.call('GET', '/live')).json.inUse.attitude, 'imu2.II', 'not the 1 Hz compass; not a source gone quiet')
  for (let t = 0; t < 20; t++) { h.feed(heel(1), 'imu.II', 100); h.feed(heel(2), 'imu2.II', 0) }
  assert.strictEqual((await h.call('GET', '/live')).json.inUse.attitude, 'imu2.II', 'no switching back and forth')
})

test('a quiet sensor is kept while nothing else sends, and takes up again', async () => {
  const h = harness({ mode: 'replace' })
  for (let t = 0; t < 30; t++) h.feed([{ path: SPEED, value: 3 }], 'a.II', 100)
  h.feed([{ path: SPEED, value: 3 }], 'a.II', 60000)
  const { json } = await h.call('GET', '/live')
  assert.strictEqual(json.inUse.stw, 'a.II')
  assert.ok(!h.errors.some(e => /stopped sending/.test(e)))
})

test('another plugin never takes over from a quiet sensor', async () => {
  const h = harness({ mode: 'replace' })
  for (let t = 0; t < 30; t++) h.feed([{ path: SPEED, value: 3 }], 'a.II', 100)
  h.feed([{ path: SPEED, value: 3 }], 'signalk-other', 5000)
  assert.strictEqual((await h.call('GET', '/live')).json.inUse.stw, 'a.II')
})

test('a chosen source is never replaced', async () => {
  const h = harness({ mode: 'replace', sources: { stw: 'a.II' } })
  for (let t = 0; t < 30; t++) h.feed([{ path: SPEED, value: 3 }], 'a.II', 100)
  for (let t = 0; t < 50; t++) h.feed([{ path: SPEED, value: 3 }], 'b.II', 100)
  assert.strictEqual((await h.call('GET', '/live')).json.inUse.stw, 'a.II')
})

test('variation has its own limit: a sender 5 s apart is not quiet', async () => {
  const h = harness({ mode: 'replace' })
  const vr = { path: 'navigation.magneticVariation', value: 0.2 }
  h.feed([vr], 'gps.II', 100)
  for (let t = 0; t < 10; t++) { h.feed([vr], 'gps.II', 5000); h.feed([vr], 'other.II', 2500) }
  assert.strictEqual((await h.call('GET', '/live')).json.inUse.variation, 'gps.II')
})

test('a sensor that has stopped shows 0 Hz', async () => {
  const h = harness({ mode: 'replace' })
  for (let t = 0; t < 30; t++) h.feed([{ path: SPEED, value: 3 }], 'a.II', 100)
  const before = (await h.call('GET', '/live')).json.sources.stw[0].hz
  assert.ok(before > 5, String(before))
  h.feed([{ path: 'navigation.headingMagnetic', value: 1 }], 'c.II', 20000)
  assert.strictEqual((await h.call('GET', '/live')).json.sources.stw[0].hz, 0)
})

test('a config with a section that is not an object is refused, not saved', async () => {
  const h = harness()
  for (const body of [{ corrections: { twa: null } }, { sources: null }, { damping: 5 }, { sources: { stw: 3 } }, { variation: 400 }]) {
    const r = await h.call('PUT', '/calibration', body)
    assert.strictEqual(r.status, 400, JSON.stringify(body))
  }
  assert.strictEqual(h.saved(), null)
  const b = harness({ sources: null })
  assert.ok(b.errors.some(e => /sources: must be an object/.test(e)), 'a bad file is reported at start')
})

test('damping: published TWA follows a yaw with the TWA time constant, and TWD does not move', () => {
  // The same run with and without TWA damping, one after the other (the clock is shared).
  const run = twaS => {
    const h = harness({ ...plain, damping: { heelS: 0, trueWindS: 0, twaS, stwS: 0, currentS: 0 } })
    const first = paths(h.feed([{ path: 'navigation.headingTrue', value: 0 }, { path: 'navigation.speedThroughWater', value: 6 / MS_TO_KN },
      { path: 'environment.wind.angleApparent', value: 40 * RAD }, { path: 'environment.wind.speedApparent', value: 15 / MS_TO_KN }], 'h2000.II', 100))
    // the bow swings 10° to starboard; compass at 10 Hz, no new wind for 1 s
    const twa = []
    for (let i = 0; i < 10; i++) twa.push(deg(paths(h.feed([{ path: 'navigation.headingTrue', value: 10 * RAD }], 'h2000.II', 100))['environment.wind.angleTrueWater']))
    const after = paths(h.feed([{ path: 'navigation.headingTrue', value: 10 * RAD }, { path: 'environment.wind.angleApparent', value: 30 * RAD }, { path: 'environment.wind.speedApparent', value: 15 / MS_TO_KN }], 'h2000.II', 100))
    return { twa0: deg(first['environment.wind.angleTrueWater']), twa, twd: deg(after['environment.wind.directionTrue']) }
  }
  const raw = run(0)
  const damped = run(1)
  assert.ok(raw.twa.every(v => Math.abs(v - (raw.twa0 - 10)) < 1e-9), 'undamped: all of the yaw at once')
  // on the unit circle, so close to but not exactly the straight-line figures
  close(damped.twa[0] - damped.twa0, -10 * (1 - Math.exp(-0.1)), 0.02, '0.1 s in: 9.5% of the yaw')
  close(damped.twa[9] - damped.twa0, -10 * (1 - Math.exp(-1)), 0.02, '1 s in: 63%')
  close(damped.twd, raw.twd, 1e-9, 'TWD is the same either way: it keeps the undamped heading')
})

// ---- TWA at the compass's rate (0.2.10) ----

test('TWA and ground wind angle go out with each compass update: the damped TWD less the heading now', () => {
  const h = harness({ damping: { twaS: 0 } })
  h.feed(boat)
  const w = paths(h.feed(wind))
  const twd = deg(w['environment.wind.directionTrueCorrected'])
  const gwd = deg(w['environment.wind.directionGroundCorrected'])
  // The bow swings 20° before the next apparent wind: TWA follows each compass update.
  for (const mag of [115, 120, 125, 130]) {
    const out = paths(h.feed([{ path: 'navigation.headingMagnetic', value: mag * RAD }]))
    const hdg = mag + 12.8
    close(deg(out['environment.wind.angleTrueWaterCorrected']), ((twd - hdg) % 360 + 540) % 360 - 180, 1e-9, `TWA at ${mag}° M`)
    close(deg(out['environment.wind.angleTrueGroundCorrected']), ((gwd - hdg) % 360 + 540) % 360 - 180, 1e-9, 'ground wind angle')
    assert.ok(!('environment.wind.directionTrueCorrected' in out) && !('environment.wind.speedTrueCorrected' in out), 'TWD and TWS only with apparent wind')
  }
})

test('without a heading, TWA goes out with apparent wind', () => {
  const h = harness({ damping: { heelS: 0, trueWindS: 0, stwS: 0, currentS: 0 } })
  h.feed(boat.filter(v => v.path !== 'navigation.headingMagnetic'))
  const out = paths(h.feed(wind))
  assert.ok('environment.wind.angleTrueWaterCorrected' in out)
  assert.ok(!('environment.wind.directionTrueCorrected' in out), 'and no TWD')
})

test('TWA goes out with the heading in light air too, but not once apparent wind has stopped', () => {
  const twaFrom = out => 'environment.wind.angleTrueWaterCorrected' in paths(out)
  const calm = harness({ damping: { heelS: 0, trueWindS: 0, stwS: 0, currentS: 0 } })
  calm.feed([{ path: 'navigation.speedThroughWater', value: 0 }, { path: 'navigation.headingMagnetic', value: 1 }])
  calm.feed([{ path: 'environment.wind.angleApparent', value: 0.7 }, { path: 'environment.wind.speedApparent', value: 1 / MS_TO_KN }])
  assert.ok(twaFrom(calm.feed([{ path: 'navigation.headingMagnetic', value: 1.1 }])), 'light air')
  const h = harness()
  h.feed(boat)
  h.feed(wind)
  assert.ok(twaFrom(h.feed([{ path: 'navigation.headingMagnetic', value: 2 }])))
  assert.ok(!twaFrom(h.feed([{ path: 'navigation.headingMagnetic', value: 2 }], 'h2000.II', 3500)), 'apparent wind 3.6 s old')
})

test('2 Hz wind with a 10 Hz compass: TWA goes out with every compass update and never with the wind, and nothing looks like a loop', () => {
  const h = harness()
  h.feed(boat)
  let windTwa = 0; let compassTwa = 0
  for (let t = 0; t < 40; t++) {
    compassTwa += 'environment.wind.angleTrueWaterCorrected' in paths(h.feed(boat.map(v => v.path === 'navigation.headingMagnetic' ? { ...v, value: (110 + t % 3) * RAD } : v), 'h2000.II', 100)) ? 1 : 0
    if (t % 5 === 4) windTwa += 'environment.wind.angleTrueWaterCorrected' in paths(h.feed(wind, 'h2000.II', 10)) ? 1 : 0 // 10 ms after the compass
  }
  assert.strictEqual(windTwa, 0, 'not with apparent wind: TWA changes only with the heading')
  assert.strictEqual(compassTwa, 35, 'with every compass update after the first wind (t = 4)')
  assert.doesNotMatch(h.statuses[h.statuses.length - 1], /Rate limited/)
  assert.deepStrictEqual(h.errors, [])
})

// ---- 0.2.16 ----

test('a save while disabled in the server is kept, and starts nothing', async () => {
  const h = harness()
  h.plugin.stop()
  const r = await h.call('PUT', '/calibration', { mode: 'replace' })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(h.saved().mode, 'replace')
  assert.strictEqual((await h.call('GET', '/live')).json.running, false)
  assert.strictEqual((await h.call('GET', '/calibration')).json.config.mode, 'replace')
  assert.deepStrictEqual(h.feed(boat.concat(wind)), [], 'not subscribed')
  h.plugin.start()
  assert.strictEqual((await h.call('GET', '/live')).json.running, true, 'runs once enabled')
})

test('a save still repairs a plugin that failed to start', async () => {
  const h = harness({ sources: null })
  assert.strictEqual((await h.call('GET', '/live')).json.running, false)
  const r = await h.call('PUT', '/calibration', { sources: {} })
  assert.strictEqual(r.status, 200)
  const live = (await h.call('GET', '/live')).json
  assert.strictEqual(live.running, true)
  assert.strictEqual(live.error, '')
})

for (const [name, text] of [['truncated', '{"schema":6,"mode":"replace",'], ['not an object', '[]']]) {
  test(`an unreadable config file (${name}) stops the plugin, says why, and is kept on Save`, async () => {
    const h = harness()
    const file = path.join(h.dir, 'config.json')
    h.plugin.stop()
    fs.writeFileSync(file, text)
    h.plugin.start()
    const live = (await h.call('GET', '/live')).json
    assert.strictEqual(live.running, false)
    assert.match(live.error, /could not read config\.json/)
    assert.ok(h.errors.some(e => /could not read config\.json/.test(e)))
    const r = await h.call('PUT', '/calibration', (await h.call('GET', '/calibration')).json.config)
    assert.strictEqual(r.status, 200)
    assert.strictEqual(fs.readFileSync(file + '.bad', 'utf8'), text)
    assert.strictEqual((await h.call('GET', '/live')).json.running, true)
  })
}

test('a PUT without schema changes the configuration in use; with it, replaces it', async () => {
  const h = harness()
  await h.call('PUT', '/calibration', { variation: 3, corrections: { leeway: { k: 6.5 } } })
  await h.call('PUT', '/calibration', {})
  await h.call('PUT', '/calibration', { mode: 'replace' })
  assert.strictEqual(h.saved().variation, 3)
  assert.strictEqual(h.saved().corrections.leeway.k, 6.5)
  assert.strictEqual(h.saved().mode, 'replace')
  await h.call('PUT', '/calibration', { schema: 6, variation: 4 })
  assert.strictEqual(h.saved().variation, 4)
  assert.strictEqual(h.saved().corrections.leeway.k, DEFAULTS.corrections.leeway.k)
})

test('a PUT that is not a JSON object is refused', async () => {
  const h = harness()
  for (const body of [[], null]) assert.strictEqual((await h.call('PUT', '/calibration', body)).status, 400)
  assert.strictEqual(h.saved(), null)
})

test('a source first seen without a source object can still be chosen by Auto', () => {
  const h = harness()
  const d = source => ({ updates: [{ $source: 'x.1', ...(source ? { source: { label: 'x' } } : {}), timestamp: new Date(clock).toISOString(), values: [{ path: 'navigation.speedThroughWater', value: 3 }] }] })
  h.deliver(d(false))
  h.deliver(d(true))
  clock += 2500
  assert.doesNotThrow(() => h.deliver(d(true)))
})

test('no value anywhere in a config makes validation throw', () => {
  const { normalizeConfig } = require('../lib/processor')
  const walk = (o, at, out) => {
    for (const k of Object.keys(o)) {
      out.push(at.concat(k))
      if (o[k] !== null && typeof o[k] === 'object') walk(o[k], at.concat(k), out)
    }
    return out
  }
  const paths = walk(DEFAULTS, [], [])
  for (const schema of [6, 5, 4, 3]) {
    for (const p of paths) {
      for (const bad of [null, 5, 'x', true, [], {}, [null], [[]]]) {
        const c = JSON.parse(JSON.stringify({ schema, ...DEFAULTS }))
        let o = c
        for (const k of p.slice(0, -1)) o = o[k]
        o[p[p.length - 1]] = bad
        assert.doesNotThrow(() => normalizeConfig(c), `schema ${schema} ${p.join('.')} = ${JSON.stringify(bad)}`)
      }
    }
    const c = { schema, corrections: { foo: null } }
    assert.doesNotThrow(() => normalizeConfig(c))
  }
  assert.ok(normalizeConfig({ corrections: { foo: null } }).errors.some(e => /foo/.test(e)))
  assert.ok(normalizeConfig({ corrections: { twa: { upwind: 5 } } }).errors.length > 0)
})

test('raw STW goes out on its own path, unchanged, in both modes and with the STW table off', () => {
  for (const mode of ['replace', 'shadow']) {
    for (const enabled of [true, false]) {
      const h = harness({ mode, corrections: { ...TABLES, stw: { ...TABLES.stw, enabled } } })
      h.feed([{ path: 'navigation.attitude', value: { roll: -20 * RAD } }])
      const out = paths(h.feed([{ path: 'navigation.speedThroughWater', value: 5 / MS_TO_KN }]))
      assert.ok(Math.abs(out['navigation.speedThroughWaterRaw'] - 5 / MS_TO_KN) < 1e-12, `${mode}, table ${enabled ? 'on' : 'off'}`)
    }
  }
})

// ---- robustness: it never publishes bad data ----

test('the clock set back an hour (a time fix): everything keeps going, and nothing is called a loop', () => {
  const h = harness({ mode: 'replace', damping: { trueWindS: 3 } })
  for (let i = 0; i < 30; i++) h.feed([...boat, ...windHdg])
  clock -= 3600 * 1000
  let out = []
  for (let i = 0; i < 150; i++) out = paths(h.feed([...boat, ...windHdg.map(v => v.path === 'environment.wind.angleApparent' ? { ...v, value: 60 * RAD } : v)]))
  assert.ok('environment.wind.directionTrue' in out && 'environment.wind.angleTrueWater' in out, 'still publishing')
  const twd = deg(out['environment.wind.directionTrue'])
  const settled = deg(paths(harness({ mode: 'replace', damping: { trueWindS: 0 } }).feed([...boat, ...windHdg.map(v => v.path === 'environment.wind.angleApparent' ? { ...v, value: 60 * RAD } : v)]))['environment.wind.directionTrue'])
  assert.ok(Math.abs(twd - settled) < 1, `damping kept running: TWD ${twd} reaching ${settled}`)
  assert.doesNotMatch(h.statuses[h.statuses.length - 1], /Rate limited/)
})

test('the clock set back: a sensor that then stops is stale after 3 s, not fresh for an hour', () => {
  const h = harness({ mode: 'replace' })
  for (let i = 0; i < 10; i++) h.feed([...boat, ...windHdg])
  clock -= 3600 * 1000
  let out = []
  for (let i = 0; i < 40; i++) out = paths(h.feed([...boat.filter(v => !/heading/.test(v.path)), ...wind]))
  assert.ok(!('environment.wind.directionTrue' in out), 'no TWD 4 s after the compass stopped')
})

test('implausible values are not used: SOG 1000 kn, angles in degrees on radian paths, variation beyond ±180°', () => {
  const h = harness({ mode: 'replace', damping: { currentS: 0, trueWindS: 0, twaS: 0 } })
  const good = paths(h.feed([...boat, ...windHdg]))
  const sog = paths(h.feed([...boat.map(v => v.path === 'navigation.speedOverGround' ? { ...v, value: 1000 / MS_TO_KN } : v), ...windHdg], 'h2000.II', 100))
  assert.ok(sog['environment.current'].drift * MS_TO_KN < 1, 'the last good SOG, not 1000 kn')
  const stale = paths(h.feed([...boat.map(v => v.path === 'navigation.speedOverGround' ? { ...v, value: 1000 / MS_TO_KN } : v), ...windHdg], 'h2000.II', 3100))
  assert.ok(!('environment.current' in stale) && !('environment.wind.speedOverGround' in stale), 'and none once that is stale')
  const hdg = paths(h.feed([...boat.map(v => v.path === 'navigation.headingMagnetic' ? { ...v, value: 110 } : v), ...wind], 'h2000.II', 3100))
  assert.ok(!('environment.wind.directionTrue' in hdg) && !('navigation.headingTrue' in hdg), 'heading 110 on a radian path: no heading')
  const awa = h.feed([...boat, ...windHdg.map(v => v.path === 'environment.wind.angleApparent' ? { ...v, value: 35 } : v)], 'h2000.II', 3100)
  assert.ok(!awa.some(o => o.values.some(v => /wind\.(speedTrue|directionTrue)/.test(v.path))), 'AWA 35 on a radian path: no true wind')
  const vr = paths(h.feed([...boat, ...windHdg, { path: 'navigation.magneticVariation', value: 12.8 }], 'h2000.II', 3100))
  close(deg(vr['navigation.headingTrue']), 110 + DEFAULTS.variation, 1e-6, 'variation 12.8 rad ignored: the fallback')
  close(deg(good['navigation.headingTrue']), 110 + DEFAULTS.variation, 1e-6)
})

test('ground wind direction and angle wait for ground wind speed, as TWD waits for TWS', () => {
  const h = harness({ mode: 'replace', damping: { heelS: 0, trueWindS: 0, twaS: 0, stwS: 0, currentS: 0 } })
  // 6 kn through the water dead downwind in 6 kn of true wind, held still over the ground by a
  // 6 kn current against: the air over the ground is still
  const run = [{ path: 'navigation.speedThroughWater', value: 6 / MS_TO_KN }, { path: 'navigation.headingTrue', value: 0 }, { path: 'navigation.attitude', value: { roll: 0 } },
    { path: 'navigation.speedOverGround', value: 0 }, { path: 'navigation.courseOverGroundTrue', value: 0 }]
  const out = paths(h.feed([...run, { path: 'environment.wind.angleApparent', value: 0 }, { path: 'environment.wind.speedApparent', value: 0.01 / MS_TO_KN }]))
  assert.ok('environment.wind.speedOverGround' in out, 'ground wind speed goes out')
  assert.ok(!('environment.wind.directionGround' in out) && !('environment.wind.angleTrueGround' in out), 'its direction and angle do not')
  assert.ok('environment.wind.directionTrue' in out, 'TWD (6 kn) does')
})

test('a 12 s wind dropout keeps the 120 s current average', () => {
  const h = harness({ mode: 'replace' })
  let cur
  for (let i = 0; i < 1200; i++) cur = paths(h.feed([...boat, ...windHdg]))['environment.current']
  h.feed(boat.filter(v => !/Ground|courseOver/.test(v.path)), 'h2000.II', 12000)
  const after = paths(h.feed([...boat.map(v => v.path === 'navigation.speedOverGround' ? { ...v, value: 9 / MS_TO_KN } : v), ...windHdg]))['environment.current']
  assert.ok(Math.abs(after.drift - cur.drift) * MS_TO_KN < 0.5, `one odd sample after the gap moves it ${((after.drift - cur.drift) * MS_TO_KN).toFixed(2)} kn`)
})

test('nothing that is not a finite number is ever published, and nothing throws', () => {
  const proc = require('../lib/processor')
  const real = proc.process
  const index = require.resolve('../index.js')
  const run = (spoil) => {
    delete require.cache[index]
    proc.process = (input, cfg) => { const r = real(input, cfg); spoil(r.out); return r }
    try {
      const fresh = require('../index.js')
      let cb = null; const published = []; const statuses = []
      const app = { getDataDirPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'spp-')), debug () {}, error () {}, setPluginError () {}, setPluginStatus: m => statuses.push(m),
        handleMessage (id, d) { if (d.updates[0].values) published.push(...d.updates[0].values) }, subscriptionmanager: { subscribe: (s, u, e, f) => { cb = f } } }
      fresh(app).start({ })
      for (let i = 0; i < 3; i++) { clock += 100; cb({ updates: [{ $source: 'h2000.II', source: { label: 'h2000' }, timestamp: 'x' + i, values: [...boat, ...windHdg] }] }) }
      const bad = published.filter(v => typeof v.value === 'number' ? !Number.isFinite(v.value) : Object.values(v.value).some(x => !Number.isFinite(x)))
      return { bad, sent: published.map(v => v.path), status: statuses[statuses.length - 1] }
    } finally {
      proc.process = real
      delete require.cache[index]
    }
  }
  const a = run(o => { o.twd = Infinity; o.current = { drift: NaN, set: 3 } })
  assert.deepStrictEqual(a.bad, [])
  assert.ok(!a.sent.some(p => /directionTrue|environment\.current/.test(p)), 'no TWD, no current')
  assert.ok(a.sent.some(p => /speedTrue/.test(p)), 'the rest still goes out')
  const b = run(o => { o.tws = NaN })
  assert.deepStrictEqual(b.bad, [])
  assert.ok(!b.sent.some(p => /wind\.(speedTrue|directionTrue)/.test(p)))
  assert.match(b.status, /true wind could not be worked out/)
})

test('published STW ramped up from 0, heeled and damped: never negative', () => {
  const h = harness({ mode: 'replace', corrections: { stw: { heel: [-20, 0, 20], stw: [1, 5], add: [[-5, -5], [-0.5, 0], [-5, -5]] } } })
  for (let i = 0; i <= 150; i++) {
    const stw = paths(h.feed([{ path: 'navigation.speedThroughWater', value: (i / 10) / MS_TO_KN }, { path: 'navigation.attitude', value: { roll: (i % 2 ? -25 : -15) * RAD } }]))['navigation.speedThroughWater']
    assert.ok(stw >= 0, `STW ${i / 10} kn: published ${stw}`)
  }
})

// A history provider holding 40 minutes of beating, a tack every 5 minutes, ending 3 minutes
// ago; every path answers whatever source is asked for.
function beatingHistory (endMs) {
  const start = endMs - 40 * 60000
  const at = ms => {
    if (ms < start || ms >= endMs) return null
    const i = Math.floor((ms - start) / 1000)
    const twa = Math.floor(i / 300) % 2 ? -40 : 40
    const x = 12 * Math.cos(twa * RAD) + 6; const y = 12 * Math.sin(twa * RAD)
    return {
      'environment.wind.angleApparent': Math.atan2(y, x),
      'environment.wind.speedApparent': Math.hypot(x, y) / MS_TO_KN,
      'navigation.speedThroughWaterRaw': 6 / MS_TO_KN,
      'navigation.speedThroughWater': 6 / MS_TO_KN,
      'navigation.headingMagnetic': ((188 - twa) % 360 + 360) % 360 * RAD,
      'navigation.magneticVariation': 12 * RAD,
      'navigation.attitude.roll': -Math.sign(twa) * 15 * RAD
    }
  }
  return {
    async getValues (q) {
      const from = q.from.epochMilliseconds; const to = q.to.epochMilliseconds
      const data = []
      for (let t = from; t < to; t += q.resolution * 1000) {
        data.push([new Date(t).toISOString(), ...q.pathSpecs.map(s => {
          const v = []
          for (let u = t; u < t + q.resolution * 1000; u += 1000) { const r = at(u); if (r && r[s.path] != null) v.push(r[s.path]) }
          return v.length ? (s.aggregate === 'max' ? Math.max(...v) : v[0]) : null
        })])
      }
      return { data }
    }
  }
}

test('analysis: every few minutes, findings from history, written once each, and summarised', async () => {
  const h = harness()
  h.app.getHistoryApi = async () => beatingHistory(clock - 3 * 60000)
  for (let i = 0; i < 30; i++) h.feed([...wind, ...boat]) // so each input has a sensor in use
  let r = await h.call('PUT', '/analysis/run')
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.json.lastError, '')
  assert.ok(r.json.lastRows > 2000, `rows ${r.json.lastRows}`)
  assert.ok(r.json.lastFound > 10)
  const day = new Date(clock).toISOString().slice(0, 10)
  const first = (await h.call('GET', '/analysis/findings', undefined, {})).json
  assert.ok(first.filter(f => f.type === 'mnv' && f.kind === 'tack').length >= 6)
  assert.ok(first.filter(f => f.type === 'win').every(f => f.cls === 'up' || !f.stable))

  // Later, nothing new: what was still open closes, nothing is written twice.
  clock += 10 * 60000
  r = await h.call('PUT', '/analysis/run')
  assert.strictEqual(r.json.lastError, '')
  const all = (await h.call('GET', '/analysis/findings', undefined, {})).json
  const keys = all.map(f => `${f.type} ${f.t}`)
  assert.strictEqual(new Set(keys).size, keys.length, 'no finding twice')
  assert.ok(all.length >= first.length)

  // A restart resumes from the saved state, again without repeats.
  h.plugin.stop(); h.plugin.start({})
  for (let i = 0; i < 30; i++) h.feed([...wind, ...boat])
  r = await h.call('PUT', '/analysis/run')
  const again = (await h.call('GET', '/analysis/findings', undefined, {})).json
  assert.strictEqual(again.length, all.length)

  const tacks = (await h.call('GET', '/analysis/findings', undefined, { type: 'mnv', kind: 'tack' })).json
  assert.ok(tacks.length >= 6 && tacks.every(f => f.kind === 'tack'))
  const s = (await h.call('GET', '/analysis/summary', undefined, { since: day })).json
  assert.ok(s.counts['mnv tack compliant stable'] >= 6, JSON.stringify(s.counts))
  assert.strictEqual((await h.call('GET', '/analysis/summary', undefined, { since: 'yesterday' })).status, 400)

  r = await h.call('PUT', '/analysis', { enabled: false })
  assert.strictEqual(r.json.enabled, false)
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(h.dir, 'analysis', 'state.json'), 'utf8')).enabled, false)
})
