'use strict'

const { DEFAULTS } = require('./lib/defaults')
const { process, correctInputs, normalizeConfig, CORRECTIONS } = require('./lib/processor')

const MS_TO_KN = 1.94384
const RAD_TO_DEG = 180 / Math.PI
const STALE_MS = 3000 // an input older than this is not used
const STATUS_INTERVAL_MS = 1000
// Bounds for sanity-checking sensor input. Anything outside these is a fault, not a reading.
const MAX_PLAUSIBLE_STW_KN = 60
const MAX_PLAUSIBLE_AWS_KN = 120
const MAX_PLAUSIBLE_HEEL_DEG = 90
// See signalk-stw-heel-correction: below this a correction is float noise, and recording
// it as an output would make the next identical raw sample look like an echo.
const ECHO_MIN_DELTA_MS = 1e-6

// Inputs, grouped the way they are chosen in Settings.
const INPUTS = {
  apparentWind: ['environment.wind.angleApparent', 'environment.wind.speedApparent'],
  stw: ['navigation.speedThroughWater'],
  heading: ['navigation.headingMagnetic', 'navigation.headingTrue'],
  attitude: ['navigation.attitude'],
  gps: ['navigation.speedOverGround', 'navigation.courseOverGroundTrue']
}
const INPUT_OF = Object.fromEntries(Object.entries(INPUTS).flatMap(([k, ps]) => ps.map(p => [p, k])))

// Outputs on their standard paths. Shadow mode appends SHADOW_SUFFIX so nothing
// already on the boat is displaced while the numbers are being checked.
const OUTPUTS = {
  twa: { path: 'environment.wind.angleTrueWater', units: 'rad', description: 'True wind angle, corrected' },
  tws: { path: 'environment.wind.speedTrue', units: 'm/s', description: 'True wind speed, corrected' },
  twd: { path: 'environment.wind.directionTrue', units: 'rad', description: 'True wind direction, corrected' },
  stw: { path: 'navigation.speedThroughWater', units: 'm/s', description: 'Speed through water, corrected' },
  leeway: { path: 'navigation.leewayAngle', units: 'rad', description: 'Leeway angle, + to starboard' },
  current: { path: 'environment.current', description: 'Current: drift (m/s) and setTrue (rad)' }
}
const SHADOW_SUFFIX = 'Corrected'

module.exports = function (app) {
  const plugin = {
    id: 'signalk-performance-processor',
    name: 'gh - Performance Processor',
    description: 'H5000-style calibration: corrects STW and leeway, then true wind angle and speed, and publishes true wind and current'
  }

  let config = null
  let unsubscribes = []
  let retryTimer = null
  let running = false

  // Latest value per input path, and every source seen on each input group.
  let latest = {}
  let sourcesSeen = {}
  let lastResult = null
  let lastResultAt = 0
  let lastStatus = ''

  plugin.schema = schemaFor(DEFAULTS)

  function outPath (key) {
    return config.mode === 'shadow' ? OUTPUTS[key].path + SHADOW_SUFFIX : OUTPUTS[key].path
  }

  // Loop guard. The server stamps our deltas with $source = plugin.id; tolerate a
  // suffix, as signalk-stw-heel-correction learned to.
  function isOwnSource (src) {
    if (!src) return false
    const s = String(src)
    return s === plugin.id || s.startsWith(plugin.id + '.')
  }

  // Backstop echo detector for the one path that is both input and output (STW in
  // replace mode): remember published values that differ from their input.
  const recentStw = []
  let loopWarned = false
  function noteStw (ms) {
    recentStw.push(ms)
    if (recentStw.length > 32) recentStw.shift()
  }
  const isStwEcho = ms => recentStw.some(o => Math.abs(o - ms) < 1e-12)

  function fresh (path, now) {
    const l = latest[path]
    return l && now - l.at < STALE_MS ? l.value : undefined
  }

  // Refresh on a change of state, and at most once a second within a state so the
  // live numbers in the status keep moving without flooding the admin UI.
  let statusAt = 0
  let statusKind = null
  function status (kind, text) {
    const now = Date.now()
    if (kind === statusKind && now - statusAt < STATUS_INTERVAL_MS) return
    statusKind = kind
    lastStatus = text
    statusAt = now
    app.setPluginStatus(text)
  }

  function heelDeg (now) {
    const att = fresh('navigation.attitude', now)
    const roll = att && typeof att === 'object' ? att.roll : null
    if (roll == null || !Number.isFinite(roll)) return null
    const h = roll * RAD_TO_DEG
    return Math.abs(h) > MAX_PLAUSIBLE_HEEL_DEG ? null : h
  }

  function publish (values, timestamp) {
    if (!values.length) return
    // No source object: the server stamps $source with plugin.id, which is what the
    // loop guard and the user's Source Priorities entry match on.
    app.handleMessage(plugin.id, { updates: [{ timestamp, values }] })
  }

  // Corrected STW goes out as soon as the paddlewheel reports, at its own rate.
  function onStw (rawMs, timestamp, now) {
    const stw = config.corrections.stw
    if (!stw.enabled) return
    const stwKn = rawMs * MS_TO_KN
    // A sensor fault is not a reading; republishing it under this plugin's source
    // would put the source the user ranked first behind a bad number.
    if (stwKn < 0 || stwKn > MAX_PLAUSIBLE_STW_KN) return
    const { c } = correctInputs({ stw: stwKn, heel: heelDeg(now) }, config)
    const ms = c.stw / MS_TO_KN
    if (config.mode === 'replace' && Math.abs(ms - rawMs) > ECHO_MIN_DELTA_MS) noteStw(ms)
    publish([{ path: outPath('stw'), value: ms }], timestamp)
  }

  // True wind, current and leeway go out on every apparent wind update.
  function onWind (timestamp, now) {
    const awa = fresh('environment.wind.angleApparent', now)
    const aws = fresh('environment.wind.speedApparent', now)
    const stw = fresh('navigation.speedThroughWater', now)
    if (awa == null || aws == null) return status('nowind', 'Waiting for apparent wind')
    if (stw == null) return status('nostw', 'Waiting for speed through water — no true wind without it')

    const awsKn = aws * MS_TO_KN
    const stwKn = stw * MS_TO_KN
    if (awsKn < 0 || awsKn > MAX_PLAUSIBLE_AWS_KN) return status('badaws', `Not publishing — AWS of ${awsKn.toFixed(1)} kn is not plausible`)
    if (stwKn < 0 || stwKn > MAX_PLAUSIBLE_STW_KN) return status('badstw', `Not publishing — STW of ${stwKn.toFixed(1)} kn is not plausible`)

    const deg = v => v == null ? undefined : v * RAD_TO_DEG
    const input = {
      awa: deg(Math.atan2(Math.sin(awa), Math.cos(awa))),
      aws: awsKn,
      stw: stwKn,
      heel: heelDeg(now),
      headingMagnetic: deg(fresh('navigation.headingMagnetic', now)),
      headingTrue: deg(fresh('navigation.headingTrue', now)),
      sog: (v => v == null ? undefined : v * MS_TO_KN)(fresh('navigation.speedOverGround', now)),
      cog: deg(fresh('navigation.courseOverGroundTrue', now))
    }
    const result = process(input, config)
    lastResult = { input, ...result }
    lastResultAt = now

    const o = result.out
    const values = [
      { path: outPath('twa'), value: o.twa / RAD_TO_DEG },
      { path: outPath('tws'), value: o.tws / MS_TO_KN }
    ]
    if (o.twd != null) values.push({ path: outPath('twd'), value: o.twd / RAD_TO_DEG })
    if (config.corrections.leeway.enabled) values.push({ path: outPath('leeway'), value: o.leeway / RAD_TO_DEG })
    if (o.current) values.push({ path: outPath('current'), value: { drift: o.current.drift / MS_TO_KN, setTrue: o.current.set / RAD_TO_DEG } })
    publish(values, timestamp)

    const missing = []
    if (input.heel == null) missing.push('heel')
    if (o.twd == null) missing.push('heading')
    status('running', `${config.mode === 'shadow' ? 'Shadow' : 'Live'} — TWA ${Math.abs(o.twa).toFixed(1)}°, TWS ${o.tws.toFixed(1)} kn, STW ${o.stw.toFixed(2)} kn` +
      (missing.length ? ` · no ${missing.join(' or ')}` : ''))
  }

  function onDelta (delta) {
    const now = Date.now()
    let windChanged = false
    let windTimestamp = null
    for (const update of (delta.updates || [])) {
      if (isOwnSource(update.$source)) continue
      for (const v of (update.values || [])) {
        const group = INPUT_OF[v.path]
        if (!group || v.value == null) continue
        if (v.path !== 'navigation.attitude' && !Number.isFinite(v.value)) continue

        const src = String(update.$source || '')
        ;(sourcesSeen[group] = sourcesSeen[group] || new Set()).add(src)
        const wanted = config.sources[group]
        if (wanted && src !== wanted) continue

        if (v.path === 'navigation.speedThroughWater' && config.mode === 'replace' && isStwEcho(v.value)) {
          if (!loopWarned) {
            loopWarned = true
            app.error(`Loop guard mismatch: received STW this plugin published, but its $source was "${src}" rather than "${plugin.id}". Skipping it — set the STW source in Settings.`)
          }
          continue
        }

        latest[v.path] = { value: v.value, source: src, at: now }
        if (group === 'apparentWind') { windChanged = true; windTimestamp = update.timestamp }
        if (group === 'stw') onStw(v.value, update.timestamp, now)
      }
    }
    if (windChanged) onWind(windTimestamp, now)
  }

  function startWith (cfg) {
    stopEverything()
    config = cfg
    latest = {}
    sourcesSeen = {}
    lastResult = null
    running = true

    if (config.mode === 'shadow') {
      // The shadow paths are not in the Signal K schema; give consumers their units.
      app.handleMessage(plugin.id, {
        updates: [{
          meta: Object.keys(OUTPUTS).map(k => ({
            path: OUTPUTS[k].path + SHADOW_SUFFIX,
            value: { description: OUTPUTS[k].description, ...(OUTPUTS[k].units ? { units: OUTPUTS[k].units } : {}) }
          }))
        }]
      })
    }

    // sourcePolicy 'all': every source at full rate, chosen here rather than by
    // priorities, which this plugin's own output may outrank in replace mode.
    const subscription = {
      context: 'vessels.self',
      sourcePolicy: 'all',
      subscribe: Object.keys(INPUT_OF).map(path => ({ path }))
    }

    function trySubscribe (attempt) {
      retryTimer = null
      if (!running) return
      const sm = app.subscriptionmanager
      if (sm && typeof sm.subscribe === 'function') {
        try {
          sm.subscribe(subscription, unsubscribes, err => app.setPluginError(String(err)), onDelta)
          status('waiting', 'Waiting for apparent wind')
          return
        } catch (e) {
          app.error(`subscribe failed: ${e.message}`)
        }
      }
      if (attempt >= 20) {
        app.setPluginError('Could not subscribe — subscriptionmanager unavailable')
        return
      }
      retryTimer = setTimeout(() => trySubscribe(attempt + 1), 500)
    }

    const on = CORRECTIONS.filter(c => config.corrections[c.id] && config.corrections[c.id].enabled).map(c => c.id)
    app.debug(`started in ${config.mode} mode; corrections on: ${on.join(', ') || 'none'}`)
    status('starting', `Starting — ${config.mode} mode`)
    trySubscribe(0)
  }

  function stopEverything () {
    running = false
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    unsubscribes.forEach(f => f())
    unsubscribes = []
  }

  plugin.start = function (options) {
    const { config: cfg, errors } = normalizeConfig(options || {})
    if (errors.length) {
      app.setPluginError(`Configuration: ${errors.join('; ')}`)
      return
    }
    startWith(cfg)
  }

  plugin.stop = function () {
    stopEverything()
    app.setPluginStatus('Stopped')
  }

  // ---- API for the webapp -------------------------------------------------

  function liveSnapshot () {
    const now = Date.now()
    const inputs = {}
    for (const [path, l] of Object.entries(latest)) inputs[path] = { source: l.source, ageMs: now - l.at }
    return {
      running,
      status: lastStatus,
      mode: config ? config.mode : null,
      ageMs: lastResult ? now - lastResultAt : null,
      result: lastResult,
      inputs,
      sourcesSeen: Object.fromEntries(Object.entries(sourcesSeen).map(([k, s]) => [k, Array.from(s).sort()])),
      outputPaths: config ? Object.fromEntries(Object.keys(OUTPUTS).map(k => [k, outPath(k)])) : {}
    }
  }

  function readBody (req) {
    if (req.body && typeof req.body === 'object') return Promise.resolve(req.body)
    return new Promise((resolve, reject) => {
      let s = ''
      req.on('data', d => { s += d })
      req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}) } catch (e) { reject(e) } })
      req.on('error', reject)
    })
  }

  plugin.registerWithRouter = function (router) {
    router.get('/config', (req, res) => {
      res.set('Cache-Control', 'no-store')
      let stored = {}
      try { stored = app.readPluginOptions().configuration || {} } catch (e) {}
      res.json({ config: config || normalizeConfig(stored).config, defaults: DEFAULTS })
    })

    router.put('/config', async (req, res) => {
      let body
      try { body = await readBody(req) } catch (e) { return res.status(400).json({ errors: ['body is not valid JSON'] }) }
      const { config: cfg, errors } = normalizeConfig(body)
      if (errors.length) return res.status(400).json({ errors })
      app.savePluginOptions(cfg, err => {
        if (err) return res.status(500).json({ errors: [`could not save: ${err.message || err}`] })
        startWith(cfg)
        res.json({ config: cfg })
      })
    })

    router.get('/live', (req, res) => {
      res.set('Cache-Control', 'no-store')
      res.json(liveSnapshot())
    })
  }

  return plugin
}

// JSON schema for the admin "Plugin Config" form, built from the defaults so the form
// is a working fallback editor and a fresh install starts from this boat's values.
function schemaFor (defaults) {
  const titles = {
    mode: 'Output: shadow publishes …Corrected paths alongside the instruments; replace publishes the standard paths (rank this plugin first in Source Priorities)',
    variation: 'Magnetic variation (degrees, east positive)',
    sources: 'Input sources ($source to read; blank = any source except this plugin)',
    corrections: 'Corrections (easier to edit in the Performance Processor webapp)'
  }
  function node (value, title) {
    if (Array.isArray(value)) return { type: 'array', title, items: { type: 'number' }, default: value }
    if (value && typeof value === 'object') {
      return {
        type: 'object',
        title,
        properties: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, node(v, k)]))
      }
    }
    if (typeof value === 'boolean') return { type: 'boolean', title, default: value }
    if (typeof value === 'number') return { type: 'number', title, default: value }
    return { type: 'string', title, default: value }
  }
  const schema = node(defaults)
  for (const [k, t] of Object.entries(titles)) schema.properties[k].title = t
  schema.properties.mode.enum = ['shadow', 'replace']
  return schema
}

// Exposed for the test suite only; not part of the Signal K plugin API.
module.exports._internals = { schemaFor, OUTPUTS, INPUTS, SHADOW_SUFFIX }
