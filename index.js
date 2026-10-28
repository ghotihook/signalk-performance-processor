'use strict'

const fs = require('fs')
const path = require('path')
const { DEFAULTS } = require('./lib/defaults')
const { process, correctInputs, normalizeConfig, CORRECTIONS, CONFIG_SCHEMA } = require('./lib/processor')

const MS_TO_KN = 1.94384
const RAD_TO_DEG = 180 / Math.PI
const STALE_MS = 3000 // an input older than this is not used
// Variation changes over days, not seconds; a GPS that drops it briefly should not
// push heading onto the fallback value.
const VARIATION_MAX_AGE_MS = 10 * 60 * 1000
const CONFIG_FILE = 'config.json'
const STATUS_INTERVAL_MS = 1000
// Bounds for sanity-checking sensor input. Anything outside these is a fault, not a reading.
const MAX_PLAUSIBLE_STW_KN = 60
const MAX_PLAUSIBLE_AWS_KN = 120
const MAX_PLAUSIBLE_HEEL_DEG = 90
// See signalk-stw-heel-correction: below this a correction is float noise, and recording
// it as an output would make the next identical raw sample look like an echo.
const ECHO_MIN_DELTA_MS = 1e-6
// Circuit breaker: no path is published more often than this (20 Hz). A feedback loop
// through another plugin delivers its next update within the same millisecond, so the
// chain ends at the first repeat rather than running away, and the server stays
// responsive. Nothing latches; the status says while it is happening.
const MIN_PUBLISH_INTERVAL_MS = 50
const RATE_NOTE_MS = 10000 // how long a dropped update keeps the status flagged

// Inputs, grouped the way they are chosen in Settings.
const INPUTS = {
  apparentWind: ['environment.wind.angleApparent', 'environment.wind.speedApparent'],
  stw: ['navigation.speedThroughWater'],
  heading: ['navigation.headingMagnetic', 'navigation.headingTrue'],
  attitude: ['navigation.attitude'],
  gps: ['navigation.speedOverGround', 'navigation.courseOverGroundTrue'],
  variation: ['navigation.magneticVariation']
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
    description: 'Steady true wind through tacks and gybes: H5000-style calibration of boat speed, leeway and TWA/TWS, configured in the Performance Processor webapp'
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

  // Everything is configured in the webapp and kept in this plugin's data directory,
  // not in the plugin options: the admin form would otherwise show the tables, and
  // saving it could overwrite the webapp's values.
  plugin.schema = {
    type: 'object',
    description: 'Calibration tables and settings are edited in Webapps → Performance Processor.',
    properties: {}
  }

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

  // A plugin publishes with no source object, so the server gives its update only a
  // $source. Data from a connection (NMEA 0183, NMEA 2000) always carries one.
  const fromSensor = update => update.source != null && typeof update.source === 'object'

  // Backstop echo detector for the one path that is both input and output (STW in
  // replace mode): remember published values that differ from their input.
  const recentStw = []
  let loopWarned = false

  // Rate limit (see MIN_PUBLISH_INTERVAL_MS): when each path was last published, and
  // when updates were dropped recently, for the status.
  let publishedAt = {}
  let dropsAt = []
  let dropFrom = ''
  function recentDrops (now) {
    while (dropsAt.length && now - dropsAt[0] > RATE_NOTE_MS) dropsAt.shift()
    return dropsAt.length
  }
  function noteDrop (now, from) {
    const first = !recentDrops(now)
    dropsAt.push(now)
    dropFrom = from
    if (!first) return
    app.error(`Rate limited: "${from}" is driving updates faster than ${1000 / MIN_PUBLISH_INTERVAL_MS} Hz. Is another plugin correcting this plugin's output?`)
    lastStatus = statusText + rateNote(now) // flag it now, not at the next refresh
    app.setPluginStatus(lastStatus)
  }
  function rateNote (now) {
    const n = recentDrops(now)
    return n ? ` · Rate limited: ${n} update${n === 1 ? '' : 's'} over ${1000 / MIN_PUBLISH_INTERVAL_MS} Hz not published in the last ${RATE_NOTE_MS / 1000} s, ` +
      `driven by "${dropFrom}". Usually a feedback loop with another STW plugin: check the STW source in Settings` : ''
  }
  function noteStw (ms) {
    recentStw.push(ms)
    if (recentStw.length > 32) recentStw.shift()
  }
  const isStwEcho = ms => recentStw.some(o => Math.abs(o - ms) < 1e-12)

  function fresh (p, now, maxAge = STALE_MS) {
    const l = latest[p]
    return l && now - l.at < maxAge ? l.value : undefined
  }

  // Refresh on a change of state, and at most once a second within a state so the
  // live numbers in the status keep moving without flooding the admin UI.
  let statusAt = 0
  let statusKind = null
  let statusText = ''
  function status (kind, text) {
    const now = Date.now()
    if (kind === statusKind && now - statusAt < STATUS_INTERVAL_MS) return
    statusKind = kind
    statusText = text
    text += rateNote(now)
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

  function publish (values, timestamp, from) {
    const now = Date.now()
    const kept = values.filter(v => {
      if (now - (publishedAt[v.path] ?? -Infinity) < MIN_PUBLISH_INTERVAL_MS) return false
      publishedAt[v.path] = now
      return true
    })
    if (kept.length < values.length) noteDrop(now, from)
    values = kept
    if (!values.length) return
    // No source object: the server stamps $source with plugin.id, which is what the
    // loop guard and the user's Source Priorities entry match on.
    app.handleMessage(plugin.id, { updates: [{ timestamp, values }] })
  }

  // Corrected STW goes out as soon as the paddlewheel reports, at its own rate.
  function onStw (rawMs, timestamp, now, from) {
    const stw = config.corrections.stw
    if (!stw.enabled) return
    const stwKn = rawMs * MS_TO_KN
    // A sensor fault is not a reading; republishing it under this plugin's source
    // would put the source the user ranked first behind a bad number.
    if (stwKn < 0 || stwKn > MAX_PLAUSIBLE_STW_KN) return
    const { c } = correctInputs({ stw: stwKn, heel: heelDeg(now) }, config)
    const ms = c.stw / MS_TO_KN
    if (config.mode === 'replace' && Math.abs(ms - rawMs) > ECHO_MIN_DELTA_MS) noteStw(ms)
    publish([{ path: outPath('stw'), value: ms }], timestamp, from)
  }

  // True wind, current and leeway go out on every apparent wind update.
  function onWind (timestamp, now, from) {
    const awa = fresh('environment.wind.angleApparent', now)
    const aws = fresh('environment.wind.speedApparent', now)
    const stw = fresh('navigation.speedThroughWater', now)
    if (awa == null || aws == null) return status('nowind', 'Waiting for apparent wind')
    if (stw == null) {
      const others = !config.sources.stw && sourcesSeen.stw ? Array.from(sourcesSeen.stw) : []
      return status('nostw', others.length
        ? `No speed through water from a sensor, only from ${others.join(', ')}. Choose the STW source in Settings`
        : 'Waiting for speed through water — no true wind without it')
    }

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
      variation: deg(fresh('navigation.magneticVariation', now, VARIATION_MAX_AGE_MS)),
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
    publish(values, timestamp, from)

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
    let windFrom = ''
    for (const update of (delta.updates || [])) {
      if (isOwnSource(update.$source)) continue
      for (const v of (update.values || [])) {
        const group = INPUT_OF[v.path]
        if (!group || v.value == null) continue
        if (v.path !== 'navigation.attitude' && !Number.isFinite(v.value)) continue

        const src = String(update.$source || '')
        const sensor = fromSensor(update)
        ;(sourcesSeen[group] = sourcesSeen[group] || new Set()).add(src)
        const wanted = config.sources[group]
        if (wanted && src !== wanted) continue
        // Without a chosen source, STW is read from sensors only. Another plugin's STW
        // is already corrected, and this plugin publishes STW too: taking each other's
        // output, two correctors feed each other without end.
        if (!wanted && group === 'stw' && !sensor) continue

        if (v.path === 'navigation.speedThroughWater' && config.mode === 'replace' && isStwEcho(v.value)) {
          if (!loopWarned) {
            loopWarned = true
            app.error(`Loop guard mismatch: received STW this plugin published, but its $source was "${src}" rather than "${plugin.id}". Skipping it — set the STW source in Settings.`)
          }
          continue
        }

        latest[v.path] = { value: v.value, source: src, at: now }
        if (group === 'apparentWind') { windChanged = true; windTimestamp = update.timestamp; windFrom = src }
        if (group === 'stw') onStw(v.value, update.timestamp, now, src)
      }
    }
    if (windChanged) onWind(windTimestamp, now, windFrom)
  }

  function startWith (cfg) {
    stopEverything()
    config = cfg
    publishedAt = {}
    dropsAt = []
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

  // ---- stored configuration ---------------------------------------------------

  function configFile () {
    return path.join(app.getDataDirPath(), CONFIG_FILE)
  }

  // The webapp's saved configuration. Before the file exists, take a configuration left
  // in the plugin options by 0.0.1, which stored it there; otherwise start from defaults.
  function loadStored (options) {
    try {
      return JSON.parse(fs.readFileSync(configFile(), 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') app.error(`could not read ${configFile()}: ${e.message}`)
    }
    return options && options.corrections ? options : {}
  }

  // Write to a temporary file and rename, so a crash mid-write never leaves half a file.
  // Never overwrite a file from a newer release: this version would drop what it
  // does not understand.
  function saveStored (cfg) {
    const file = configFile()
    let onDisk = null
    try { onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).schema } catch (e) {}
    if (Number.isInteger(onDisk) && onDisk > CONFIG_SCHEMA) {
      throw new Error(`the saved configuration is schema ${onDisk}, from a newer version of this plugin; update the plugin rather than overwrite it`)
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file + '.tmp', JSON.stringify(cfg, null, 2))
    fs.renameSync(file + '.tmp', file)
  }

  plugin.start = function (options) {
    const { config: cfg, errors } = normalizeConfig(loadStored(options))
    if (errors.length) {
      app.setPluginError(`Configuration: ${errors.join('; ')} — fix it in the webapp`)
      config = normalizeConfig({}).config // so the webapp can still load and repair it
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
    // Not /config: the server registers GET and POST /config on every plugin's router
    // for its own options, ahead of the plugin's routes, so ours would never be reached.
    router.get('/calibration', (req, res) => {
      res.set('Cache-Control', 'no-store')
      res.json({ config: config || normalizeConfig(loadStored()).config, defaults: DEFAULTS })
    })

    router.put('/calibration', async (req, res) => {
      let body
      try { body = await readBody(req) } catch (e) { return res.status(400).json({ errors: ['body is not valid JSON'] }) }
      const { config: cfg, errors } = normalizeConfig(body)
      if (errors.length) return res.status(400).json({ errors })
      try {
        saveStored(cfg)
      } catch (e) {
        return res.status(500).json({ errors: [`could not save: ${e.message}`] })
      }
      startWith(cfg)
      res.json({ config: cfg })
    })

    router.get('/live', (req, res) => {
      res.set('Cache-Control', 'no-store')
      res.json(liveSnapshot())
    })
  }

  return plugin
}

// Exposed for the test suite only; not part of the Signal K plugin API.
module.exports._internals = { OUTPUTS, INPUTS, SHADOW_SUFFIX, CONFIG_FILE }
