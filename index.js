'use strict'

const fs = require('fs')
const path = require('path')
const { DEFAULTS } = require('./lib/defaults')
const { Smooth, SmoothAngle, SmoothVector } = require('./lib/damping')
const { process, correctInputs, normalizeConfig, CORRECTIONS, CONFIG_SCHEMA, AXES, MAX_LEEWAY_DEG, LEEWAY_FADE_KN, TWA_TAPER_UP_DEG, TWA_TAPER_DOWN_DEG } = require('./lib/processor')

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
// Circuit breaker: no path is published more often than this (20 Hz). A feedback loop
// through another plugin delivers its next update within the same millisecond, so the
// chain ends at the first repeat rather than running away, and the server stays
// responsive. Nothing latches; the status says while it is happening.
const MIN_PUBLISH_INTERVAL_MS = 50
const RATE_NOTE_MS = 10000 // how long a dropped update keeps the status flagged
// A sensor's own timing now and then puts two updates within MIN_PUBLISH_INTERVAL_MS (CAN
// jitter on a 10 Hz compass); a loop drops updates without end. Flag from this many in
// RATE_NOTE_MS.
const RATE_FLAG_MIN = 5
// Below a breath of wind its direction is noise, and a TWD that swings with every puff is
// worse than none. TWA and TWD stop below LIGHT_AIR_OFF_KN of TWS and resume from
// LIGHT_AIR_ON_KN; the gap keeps them from flickering on and off around one value.
const LIGHT_AIR_OFF_KN = 1.5
const LIGHT_AIR_ON_KN = 2
// Another sensor sending an input this plugin does not use is compared with the one it
// does use: their difference, smoothed over DISAGREE_TAU_S, is flagged past these limits
// (two sensors that disagree should be looked at; mixing them would step the value).
const DISAGREE_TAU_S = 10
// Without a chosen source, each input is read from one sensor: for the first LOCK_WINDOW_MS
// the first seen, then the one that sent most often in that time (the primary sensor, not
// a device repeating the value now and then), kept until restart.
const LOCK_WINDOW_MS = 2000
const RATE_WINDOW_MS = 10000 // each source's update rate, shown in Settings, over this long
const wrap180 = d => ((d + 180) % 360 + 360) % 360 - 180
const COMPARE = {
  'environment.wind.angleApparent': { limit: 5, unit: '°', diff: (a, b) => wrap180((a - b) * RAD_TO_DEG) },
  'environment.wind.speedApparent': { limit: 1, unit: ' kn', diff: (a, b) => (a - b) * MS_TO_KN },
  'navigation.speedThroughWater': { limit: 0.3, unit: ' kn', diff: (a, b) => (a - b) * MS_TO_KN },
  'navigation.headingMagnetic': { limit: 3, unit: '°', diff: (a, b) => wrap180((a - b) * RAD_TO_DEG) },
  'navigation.headingTrue': { limit: 3, unit: '°', diff: (a, b) => wrap180((a - b) * RAD_TO_DEG) },
  'navigation.attitude': { limit: 2, unit: '° of heel', diff: (a, b) => (a && b && Number.isFinite(a.roll) && Number.isFinite(b.roll)) ? (a.roll - b.roll) * RAD_TO_DEG : null },
  'navigation.speedOverGround': { limit: 0.3, unit: ' kn', diff: (a, b) => (a - b) * MS_TO_KN },
  'navigation.magneticVariation': { limit: 1, unit: '°', diff: (a, b) => wrap180((a - b) * RAD_TO_DEG) }
}
const INPUT_LABELS = { apparentWind: 'apparent wind', stw: 'STW', heading: 'heading', attitude: 'heel', gps: 'SOG/COG', variation: 'variation' }

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
  current: { path: 'environment.current', description: 'Current: drift (m/s) and setTrue (rad)' },
  gws: { path: 'environment.wind.speedOverGround', units: 'm/s', description: 'Ground wind speed: true wind plus current' },
  gwa: { path: 'environment.wind.angleTrueGround', units: 'rad', description: 'Ground wind angle from the bow, + to starboard' },
  // The Signal K schema has no ground wind direction (directionTrue is the water wind's).
  gwd: { path: 'environment.wind.directionGround', units: 'rad', description: 'Ground wind direction, true: where the wind over the ground comes from', custom: true },
  hdt: { path: 'navigation.headingTrue', units: 'rad', description: 'True heading: magnetic heading plus variation' }
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

  // Latest value per input path, from the source in use.
  let latest = {}
  // Every source seen on each input, one record each: whether it is a sensor or another
  // plugin, when its messages arrived (its rate), and how it compares with the source in
  // use. Without a source chosen in Settings, each input is read from sensors only (never
  // another plugin's output) and from one sensor (LOCK_WINDOW_MS), so two sensors that
  // disagree are never mixed.
  let sources = {} // `${group}|${src}` -> { group, src, sensor, at, ts, times, smooth, diff, path, used }
  let locked = {} // group -> the sensor in use when none is chosen
  let lockFrom = {} // group -> when its first sensor was seen, until the choice is made
  // Apparent wind's angle and speed come in one sensor message (N2K 130306, NMEA 0183 MWV)
  // but reach a plugin as separate deltas, one per path. True wind waits for both halves of
  // a message (the same timestamp), so it never pairs a new angle with the last message's
  // speed. A source whose halves never share a timestamp is worked out on each value.
  let windTs = {} // path -> timestamp of its latest value
  let windWaiting = new Set() // paths that arrived without their other half
  let lightAir = false
  // Damping (config.damping): heel and heading on the way in, the published values on
  // the way out.
  const damp = {
    heel: new Smooth(),
    headingTrue: new SmoothAngle(),
    headingMagnetic: new SmoothAngle(),
    twd: new SmoothAngle(),
    tws: new Smooth(),
    twa: new SmoothAngle(), // only when there is no heading, so no TWD to derive it from
    stw: new Smooth(),
    current: new SmoothVector(),
    gwd: new SmoothAngle(),
    gws: new Smooth()
  }
  const resetDamping = () => Object.values(damp).forEach(d => d.reset())
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
    dropsAt.push(now)
    dropFrom = from
    if (recentDrops(now) !== RATE_FLAG_MIN) return
    app.error(`Rate limited: "${from}" is driving updates faster than ${1000 / MIN_PUBLISH_INTERVAL_MS} Hz. Is another plugin correcting this plugin's output?`)
    lastStatus = statusText + rateNote(now) // flag it now, not at the next refresh
    app.setPluginStatus(lastStatus)
  }
  function rateNote (now) {
    const n = recentDrops(now)
    return n >= RATE_FLAG_MIN ? ` · Rate limited: ${n} update${n === 1 ? '' : 's'} over ${1000 / MIN_PUBLISH_INTERVAL_MS} Hz not published in the last ${RATE_NOTE_MS / 1000} s, ` +
      `driven by "${dropFrom}". Usually a feedback loop with another STW plugin: check the STW source in Settings` : ''
  }

  function fresh (p, now, maxAge = STALE_MS) {
    const l = latest[p]
    return l && now - l.at < maxAge ? l.value : undefined
  }

  // Refresh on a change of state, and at most once a second within a state so the
  // live numbers in the status keep moving without flooding the admin UI.
  let statusAt = 0
  let statusKind = null
  let statusText = ''
  let notice = '' // shown ahead of every status until the config is saved (an upgraded file)
  function status (kind, text) {
    const now = Date.now()
    if (kind === statusKind && now - statusAt < STATUS_INTERVAL_MS) return
    statusKind = kind
    statusText = (notice ? `${notice} · ${text}` : text) + disagreeNote(now)
    text = statusText
    text += rateNote(now)
    lastStatus = text
    statusAt = now
    app.setPluginStatus(text)
  }

  // A source's record. One message counts once even when it arrives as several deltas
  // (apparent wind's angle and speed share a timestamp).
  function noteSource (group, src, sensor, ts, now) {
    const key = `${group}|${src}`
    const s = sources[key] = sources[key] || { group, src, sensor, times: [], smooth: new Smooth(), diff: null }
    s.at = now
    if (ts == null || ts !== s.ts) { s.ts = ts; s.times.push(now) }
    while (s.times.length && now - s.times[0] > RATE_WINDOW_MS) s.times.shift()
    return s
  }
  const sourcesOf = group => Object.values(sources).filter(s => s.group === group)
  const inUse = group => config.sources[group] || locked[group]
  const rateHz = s => s.times.length > 1 ? Math.round((s.times.length - 1) / ((s.times[s.times.length - 1] - s.times[0]) / 1000) * 10) / 10 : 0

  // With no source chosen: the first sensor seen, then, LOCK_WINDOW_MS later, the one that
  // sent most often since, kept until restart.
  function chooseSensor (group, src, now) {
    if (!locked[group]) { locked[group] = src; lockFrom[group] = now; return }
    if (lockFrom[group] == null || now - lockFrom[group] < LOCK_WINDOW_MS) return
    const best = sourcesOf(group).filter(s => s.sensor).reduce((a, b) => b.times.length > a.times.length ? b : a)
    if (best.src !== locked[group]) app.debug(`${INPUT_LABELS[group]}: using ${best.src}, the sensor sending it most often`)
    locked[group] = best.src
    lockFrom[group] = null
  }

  // A sensor not in use, compared with the value in use for the same path.
  function compareOther (s, path, value, now) {
    const mine = latest[path]
    const c = COMPARE[path]
    if (!s.sensor || !c || !mine || now - mine.at > STALE_MS) return
    const d = c.diff(value, mine.value)
    if (d == null || !Number.isFinite(d)) return
    s.diff = s.smooth.update(d, now, DISAGREE_TAU_S)
    s.path = path
    s.used = mine.source
  }
  // Sensors not in use whose readings differ from the one in use by more than its limit.
  function disagreements (now) {
    return Object.values(sources).filter(s => s.diff != null && s.src !== inUse(s.group) && now - s.at < STALE_MS && Math.abs(s.diff) > COMPARE[s.path].limit)
      .map(s => ({ input: s.group, path: s.path, used: s.used, other: s.src, diff: s.diff, unit: COMPARE[s.path].unit }))
  }
  function disagreeNote (now) {
    return disagreements(now).map(w => ` · ${INPUT_LABELS[w.input]}: ${w.other} reads ${w.diff > 0 ? '+' : ''}${w.diff.toFixed(1)}${w.unit} from ${w.used} (not used; choose the right one in Settings)`).join('')
  }
  // Sensors sending an input that is missing here: the one in use has gone quiet, or
  // another was chosen.
  function alternatives (group, now) {
    const alt = sourcesOf(group).filter(s => s.sensor && s.src !== inUse(group) && now - s.at < STALE_MS).map(s => s.src)
    return alt.length ? ` (${alt.join(', ')} sends it: choose it in Settings)` : ''
  }

  function heelDeg (now) {
    const att = fresh('navigation.attitude', now)
    const roll = att && typeof att === 'object' ? att.roll : null
    if (roll == null || !Number.isFinite(roll)) return null
    const h = roll * RAD_TO_DEG
    if (Math.abs(h) > MAX_PLAUSIBLE_HEEL_DEG) return null
    return damp.heel.update(h, latest['navigation.attitude'].at, config.damping.heelS)
  }

  // Damped heading in degrees, when it is fresh at all.
  function dampedHeading (path, now) {
    if (fresh(path, now) == null) return undefined
    const v = damp[path.split('.')[1]].value()
    return v == null ? undefined : v
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
    const ms = damp.stw.update(c.stw, now, config.damping.stwS) / MS_TO_KN
    publish([{ path: outPath('stw'), value: ms }], timestamp, from)
  }

  // True heading goes out with each magnetic heading, as heading + variation: the heading
  // true wind uses, at the compass's own rate. Not when the heading sensor sends true
  // heading itself, so a better source (a GPS compass) is never displaced.
  function onHeading (timestamp, now, from) {
    if (fresh('navigation.headingTrue', now) != null) return
    const mag = dampedHeading('navigation.headingMagnetic', now)
    if (mag == null) return
    const vr = fresh('navigation.magneticVariation', now, VARIATION_MAX_AGE_MS)
    const hdt = mag + (vr != null ? vr * RAD_TO_DEG : config.variation)
    publish([{ path: outPath('hdt'), value: ((hdt % 360) + 360) % 360 / RAD_TO_DEG }], timestamp, from)
  }

  // True wind, current and leeway go out on every apparent wind update.
  function onWind (timestamp, now, from) {
    const awa = fresh('environment.wind.angleApparent', now)
    const aws = fresh('environment.wind.speedApparent', now)
    const stw = fresh('navigation.speedThroughWater', now)
    if (awa == null || aws == null) return status('nowind', 'Waiting for apparent wind' + alternatives('apparentWind', now))
    if (stw == null) {
      const plugins = config.sources.stw ? [] : sourcesOf('stw').filter(s => !s.sensor).map(s => s.src)
      const alt = alternatives('stw', now)
      return status('nostw', !alt && plugins.length
        ? `No speed through water from a sensor, only from ${plugins.join(', ')}. Choose the STW source in Settings`
        : 'Waiting for speed through water — no true wind without it' + alt)
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
      headingMagnetic: dampedHeading('navigation.headingMagnetic', now),
      headingTrue: dampedHeading('navigation.headingTrue', now),
      variation: deg(fresh('navigation.magneticVariation', now, VARIATION_MAX_AGE_MS)),
      sog: (v => v == null ? undefined : v * MS_TO_KN)(fresh('navigation.speedOverGround', now)),
      cog: deg(fresh('navigation.courseOverGroundTrue', now))
    }
    const result = process(input, config)
    lastResult = { input, ...result }
    lastResultAt = now

    // Damped for publishing. TWD and TWS are smoothed; TWA follows from the smoothed TWD
    // and the heading now, so it answers the helm at once while the wind itself is steady.
    const o = result.out
    const dm = config.damping
    const tws = damp.tws.update(o.tws, now, dm.trueWindS)
    let twd = null; let twa
    if (o.twd != null) {
      twd = damp.twd.update(o.twd, now, dm.trueWindS)
      twa = ((twd - o.heading) % 360 + 540) % 360 - 180
    } else {
      twa = ((damp.twa.update(o.twa, now, dm.trueWindS) + 180) % 360) - 180
    }
    const cur = o.current ? damp.current.update(o.current.drift, o.current.set, now, dm.currentS) : null
    // Ground wind is damped as true wind is, its angle following from the heading now.
    let gw = null
    if (o.groundWind) {
      const gwd = damp.gwd.update(o.groundWind.direction, now, dm.trueWindS)
      gw = { direction: gwd, speed: damp.gws.update(o.groundWind.speed, now, dm.trueWindS), angle: ((gwd - o.heading) % 360 + 540) % 360 - 180 }
    }
    lastResult.published = { twa, tws, twd, stw: config.corrections.stw.enabled ? damp.stw.v : null, current: cur && { drift: cur.speed, set: cur.deg }, groundWind: gw }

    lightAir = tws < (lightAir ? LIGHT_AIR_ON_KN : LIGHT_AIR_OFF_KN)
    lastResult.lightAir = lightAir
    const values = [{ path: outPath('tws'), value: tws / MS_TO_KN }]
    if (gw) values.push({ path: outPath('gws'), value: gw.speed / MS_TO_KN })
    if (!lightAir) {
      values.push({ path: outPath('twa'), value: twa / RAD_TO_DEG })
      if (twd != null) values.push({ path: outPath('twd'), value: twd / RAD_TO_DEG })
      if (gw) {
        values.push({ path: outPath('gwd'), value: gw.direction / RAD_TO_DEG })
        values.push({ path: outPath('gwa'), value: gw.angle / RAD_TO_DEG })
      }
    }
    if (config.corrections.leeway.enabled) values.push({ path: outPath('leeway'), value: o.leeway / RAD_TO_DEG })
    if (cur) values.push({ path: outPath('current'), value: { drift: cur.speed / MS_TO_KN, setTrue: cur.deg / RAD_TO_DEG } })
    publish(values, timestamp, from)

    const missing = []
    if (input.heel == null) missing.push('heel' + alternatives('attitude', now))
    if (o.twd == null) missing.push('heading' + alternatives('heading', now))
    const mode = config.mode === 'shadow' ? 'Shadow' : 'Live'
    if (lightAir) {
      status('lightair', `${mode} — light air, TWS ${tws.toFixed(1)} kn: wind direction not published until TWS reaches ${LIGHT_AIR_ON_KN} kn`)
      return
    }
    status('running', `${mode} — TWA ${Math.abs(twa).toFixed(1)}°, TWS ${tws.toFixed(1)} kn, STW ${o.stw.toFixed(2)} kn` +
      (missing.length ? ` · no ${missing.join(' or ')}` : ''))
  }

  function windPairComplete (p, ts) {
    const other = p === 'environment.wind.angleApparent' ? 'environment.wind.speedApparent' : 'environment.wind.angleApparent'
    windTs[p] = ts
    if (ts != null && windTs[other] === ts) { windWaiting.clear(); return true }
    if (ts == null || windWaiting.has(p)) return true // no timestamps, or the halves never pair
    windWaiting.add(p)
    return false
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
        const record = noteSource(group, src, sensor, update.timestamp, now)
        // The chosen source; or, with none chosen, the sensor sending it most often
        // (chooseSensor). Another plugin's output is never used unless chosen: it is a copy, later and slower than the sensor
        // (derived-data's true heading), or already corrected (another STW plugin, which
        // would feed this one, and this one it, without end).
        const wanted = config.sources[group]
        if (!wanted && sensor) chooseSensor(group, src, now)
        if (src !== inUse(group)) { compareOther(record, v.path, v.value, now); continue }

        latest[v.path] = { value: v.value, source: src, at: now }
        if (v.path === 'navigation.headingTrue' || v.path === 'navigation.headingMagnetic') damp[v.path.split('.')[1]].update(v.value * RAD_TO_DEG, now, config.damping.headingS)
        if (v.path === 'navigation.headingMagnetic') onHeading(update.timestamp, now, src)
        if (group === 'apparentWind' && windPairComplete(v.path, update.timestamp)) { windChanged = true; windTimestamp = update.timestamp; windFrom = src }
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
    sources = {}
    locked = {}
    lockFrom = {}
    windTs = {}
    windWaiting = new Set()
    lightAir = false
    resetDamping()
    lastResult = null
    statusKind = null // so the next status shows at once (and a cleared notice goes with it)
    running = true

    // Paths not in the Signal K schema (every shadow path, and ground wind direction in
    // replace mode too) get their units, so consumers can display them.
    const custom = Object.keys(OUTPUTS).filter(k => config.mode === 'shadow' || OUTPUTS[k].custom)
    if (custom.length) {
      app.handleMessage(plugin.id, {
        updates: [{
          meta: custom.map(k => ({
            path: outPath(k),
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

  // The webapp's saved configuration, or {} (the defaults) before the first save.
  function loadStored () {
    try {
      return JSON.parse(fs.readFileSync(configFile(), 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') app.error(`could not read ${configFile()}: ${e.message}`)
    }
    return {}
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

  plugin.start = function () {
    const { config: cfg, errors, notices } = normalizeConfig(loadStored())
    notice = notices.join('; ')
    if (notice) app.error(notice)
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
      inUse: Object.fromEntries(Object.keys(INPUTS).map(g => [g, config ? inUse(g) : undefined]).filter(([, v]) => v)),
      disagreements: disagreements(now),
      // Every source of each input, for Settings: its rate, and whether it is another plugin.
      sources: Object.fromEntries(Object.keys(INPUTS).map(g => [g, sourcesOf(g).sort((a, b) => a.src < b.src ? -1 : 1)
        .map(s => ({ source: s.src, hz: rateHz(s), plugin: !s.sensor }))]).filter(([, l]) => l.length)),
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
      res.json({ config: config || normalizeConfig(loadStored()).config, defaults: DEFAULTS, behaviour: BEHAVIOUR })
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
      notice = '' // saved in this release's layout
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

// Fixed behaviour the webapp describes, sent from here so its text always matches the code.
const BEHAVIOUR = {
  axes: AXES,
  twaRows: AXES.twaRows,
  reachDeg: require('./public/tables').REACH_DEG,
  maxLeewayDeg: MAX_LEEWAY_DEG,
  leewayFadeKn: LEEWAY_FADE_KN,
  twaTaperUpDeg: TWA_TAPER_UP_DEG,
  twaTaperDownDeg: TWA_TAPER_DOWN_DEG,
  lightAirOffKn: LIGHT_AIR_OFF_KN,
  lightAirOnKn: LIGHT_AIR_ON_KN,
  staleS: STALE_MS / 1000,
  maxPublishHz: 1000 / MIN_PUBLISH_INTERVAL_MS
}

// Exposed for the test suite only; not part of the Signal K plugin API.
module.exports._internals = { OUTPUTS, INPUTS, SHADOW_SUFFIX, CONFIG_FILE, BEHAVIOUR }
