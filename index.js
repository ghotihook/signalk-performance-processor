'use strict'

const fs = require('fs')
const path = require('path')
const { DEFAULTS } = require('./lib/defaults')
const { Smooth, SmoothAngle, SmoothVector } = require('./lib/damping')
const { process, correctInputs, normalizeConfig, salvage, CORRECTIONS, CONFIG_SCHEMA, MAX_LEEWAY_DEG, LEEWAY_FADE_KN, TWA_TAPER_UP_DEG, TWA_TAPER_DOWN_DEG, TWA_SLOPE_MAX } = require('./lib/processor')
const { Learner } = require('./lib/learn')
const history = require('./lib/history')

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
const MAX_PLAUSIBLE_SOG_KN = 60
const MAX_PLAUSIBLE_HEEL_DEG = 90
// Values that cannot be right are not used (the input counts as missing). An angle beyond
// a full turn is degrees on a radian path; variation beyond half a turn likewise.
const TURN = 2 * Math.PI
const PLAUSIBLE = {
  'environment.wind.angleApparent': v => Math.abs(v) <= TURN,
  'navigation.headingMagnetic': v => Math.abs(v) <= TURN,
  'navigation.headingTrue': v => Math.abs(v) <= TURN,
  'navigation.courseOverGroundTrue': v => Math.abs(v) <= TURN,
  'navigation.courseOverGroundMagnetic': v => Math.abs(v) <= TURN,
  'navigation.magneticVariation': v => Math.abs(v) <= Math.PI,
  'navigation.speedOverGround': v => v >= 0 && v * MS_TO_KN <= MAX_PLAUSIBLE_SOG_KN
}
// Circuit breaker against a feedback loop: an update driven by another plugin's output (read
// only when chosen in Settings) goes out at most this often per path. A loop through another
// plugin delivers its next update within the same millisecond, so the chain ends at the first
// repeat rather than running away. Sensors are never limited: a burst from a gateway is data.
const MIN_PUBLISH_INTERVAL_MS = 20
const RATE_NOTE_MS = 10000 // how long a dropped update keeps the status flagged
const RATE_FLAG_MIN = 5 // drops in RATE_NOTE_MS that flag a loop
// Below a breath of wind its direction is noise, and a TWD that swings with every puff is
// worse than none. TWD stops below LIGHT_AIR_OFF_KN of TWS and resumes from LIGHT_AIR_ON_KN;
// the gap keeps it from flickering on and off around one value. Ground wind direction and
// angle likewise, on ground wind speed. TWA always goes out: it is what the crew sails by.
const LIGHT_AIR_OFF_KN = 1.5
const LIGHT_AIR_ON_KN = 2
// Without a chosen source, each input is read from one sensor: for the first LOCK_WINDOW_MS
// the first seen, then the one that sent most often in that time (the primary sensor, not
// a device repeating the value now and then), kept for as long as it keeps sending.
const LOCK_WINDOW_MS = 2000
const RATE_WINDOW_MS = 10000 // each source's update rate, shown in Settings, over this long
const SWITCH_NOTE_MS = 60000 // how long the status names a sensor Auto has moved to
const wrap180 = d => ((d + 180) % 360 + 360) % 360 - 180
const norm360 = d => (d % 360 + 360) % 360
const INPUT_LABELS = { apparentWind: 'apparent wind', stw: 'STW', heading: 'heading', attitude: 'heel', gps: 'SOG/COG', variation: 'variation' }

// Inputs, grouped the way they are chosen in Settings.
const INPUTS = {
  apparentWind: ['environment.wind.angleApparent', 'environment.wind.speedApparent'],
  stw: ['navigation.speedThroughWater'],
  heading: ['navigation.headingMagnetic', 'navigation.headingTrue'],
  attitude: ['navigation.attitude'],
  gps: ['navigation.speedOverGround', 'navigation.courseOverGroundTrue', 'navigation.courseOverGroundMagnetic'],
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
  hdt: { path: 'navigation.headingTrue', units: 'rad', description: 'True heading: magnetic heading plus variation' },
  // The paddlewheel's own value, not an output: in Replace mode corrected STW wins
  // navigation.speedThroughWater by source priority, and the server drops the loser before
  // history providers see it, so this is how raw STW reaches history for learning (§7.5,
  // §11.2). The same path in both modes.
  stwRaw: { path: 'navigation.speedThroughWaterRaw', units: 'm/s', description: 'Speed through water as the sensor sent it, before the STW table: recorded for learning', custom: true, fixed: true }
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
  let windTimer = null
  let running = false
  let started = false // between the server's start() and stop(): whether the plugin is enabled
  let startError = '' // why the plugin is not running, for the webapp

  // Latest value per input path, from the source in use.
  let latest = {}
  // Every source seen on each input, one record each: whether it is a sensor or another
  // plugin, and when its messages arrived (its rate). Without a source chosen in Settings,
  // each input is read from sensors only (never another plugin's output) and from one
  // sensor (LOCK_WINDOW_MS), so two sensors that disagree are never mixed.
  let sources = {} // `${group}|${src}` -> { group, src, sensor, at, ts, times }
  let locked = {} // group -> the sensor in use when none is chosen
  let lockFrom = {} // group -> when its first sensor was seen, until the choice is made
  let switches = [] // { at, text }: recent moves to another sensor, for the status
  // Apparent wind's angle and speed come in one sensor message (N2K 130306, NMEA 0183 MWV)
  // but reach a plugin as separate deltas, one per path. True wind waits for both halves of
  // a message (the same timestamp), so it never pairs a new angle with the last message's
  // speed. A source whose halves never share a timestamp is worked out on each value.
  let windTs = {} // path -> timestamp of its latest value
  let windWaiting = new Set() // paths that arrived without their other half
  let lightAir = false
  let lightAirGround = false
  // Damping (config.damping): heel on the way in, the published values on the way out.
  // Heading is never damped: it must lag as raw apparent wind does.
  const damp = {
    heel: new Smooth(),
    twd: new SmoothAngle(),
    tws: new Smooth(),
    twa: new SmoothAngle(), // only when there is no heading, so no TWD to derive it from
    twaOut: new SmoothAngle(), // published TWA, TWD − heading (twaS)
    gwaOut: new SmoothAngle(), // published ground wind angle, GWD − heading (twaS)
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
    return config.mode === 'shadow' && !OUTPUTS[key].fixed ? OUTPUTS[key].path + SHADOW_SUFFIX : OUTPUTS[key].path
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
  let sentAt = {} // OUTPUTS key -> when it was last sent, for the Live page
  let sentTimes = {} // OUTPUTS key -> when it was sent over the last RATE_WINDOW_MS, for its rate
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
    lastStatus = statusText + notes(now) // flag it now, not at the next refresh
    app.setPluginStatus(lastStatus)
  }
  function rateNote (now) {
    const n = recentDrops(now)
    return n >= RATE_FLAG_MIN ? ` · Rate limited: ${n} update${n === 1 ? '' : 's'} over ${1000 / MIN_PUBLISH_INTERVAL_MS} Hz not published in the last ${RATE_NOTE_MS / 1000} s, ` +
      `driven by "${dropFrom}". Usually a feedback loop with another STW plugin: check the STW source in Settings` : ''
  }

  function switchNote (now) {
    switches = switches.filter(s => now - s.at < SWITCH_NOTE_MS)
    return switches.map(s => ` · ${s.text}`).join('')
  }
  const notes = now => switchNote(now) + rateNote(now)

  // A clock that never goes back. A time fix (NTP, GPS) that sets the system clock back would
  // otherwise freeze the damping, keep old values fresh, and stop every output.
  let clockLast = -Infinity
  let clockShift = 0
  function nowMs () {
    const t = Date.now() + clockShift
    if (t < clockLast) { clockShift += clockLast - t; return clockLast }
    clockLast = t
    return t
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
    const now = nowMs()
    if (kind === statusKind && now - statusAt < STATUS_INTERVAL_MS) return
    statusKind = kind
    statusText = notice ? `${notice} · ${text}` : text
    lastStatus = statusText + notes(now)
    statusAt = now
    app.setPluginStatus(lastStatus)
  }

  // A source's record. One message counts once even when it arrives as several deltas
  // (apparent wind's angle and speed share a timestamp).
  function noteSource (group, src, sensor, ts, now) {
    const key = `${group}|${src}`
    const s = sources[key] = sources[key] || { group, src, sensor, times: [] }
    s.at = now
    s.sensor = sensor // as of its latest message: a name can start out without a source object
    if (ts == null || ts !== s.ts) { s.ts = ts; s.times.push(now) }
    while (s.times.length && now - s.times[0] > RATE_WINDOW_MS) s.times.shift()
  }
  const sourcesOf = group => Object.values(sources).filter(s => s.group === group)
  const inUse = group => config.sources[group] || locked[group]
  // Rate over the last RATE_WINDOW_MS, from the times of each message (a source) or each
  // value sent (an output): one that stopped falls to 0.
  function rateHz (times, now) {
    const t = times.filter(at => now - at <= RATE_WINDOW_MS)
    return t.length > 1 ? Math.round((t.length - 1) / ((t[t.length - 1] - t[0]) / 1000) * 10) / 10 : 0
  }
  const maxAgeOf = group => group === 'variation' ? VARIATION_MAX_AGE_MS : STALE_MS

  // With no source chosen: the first sensor seen, then, LOCK_WINDOW_MS later, the one that
  // sent most often since, kept while it sends. When it goes quiet another sensor takes
  // over at once: on NMEA 2000 the server renames a device (n2k-tcp.100 to its CAN name) on
  // learning its CAN name, so a sensor can "go quiet" with its data still arriving.
  function chooseSensor (group, src, now) {
    if (!locked[group]) { locked[group] = src; lockFrom[group] = now; return }
    const held = locked[group]
    const quiet = now - sources[`${group}|${held}`].at >= maxAgeOf(group)
    if (!quiet && (lockFrom[group] == null || now - lockFrom[group] < LOCK_WINDOW_MS)) return
    const best = sourcesOf(group).filter(s => s.sensor && now - s.at < maxAgeOf(group)).reduce((a, b) => b.times.length > a.times.length ? b : a)
    if (best.src !== held) {
      app.debug(`${INPUT_LABELS[group]}: using ${best.src}, the sensor sending it most often`)
      // Start heel's damping afresh, so the first sensor's reading does not linger in it.
      if (group === 'attitude') damp.heel.reset()
    }
    if (quiet) {
      const text = `${INPUT_LABELS[group]} from ${best.src}: ${held} stopped sending`
      app.error(text)
      switches.push({ at: now, text })
    }
    locked[group] = best.src
    lockFrom[group] = null
  }

  // What else sends an input that is missing here: another sensor (a chosen source has gone
  // quiet, or it has not yet been replaced), or failing that another plugin, which is used
  // only when chosen.
  function alternatives (group, now) {
    const others = sourcesOf(group).filter(s => s.src !== inUse(group) && now - s.at < STALE_MS)
    const sensors = others.filter(s => s.sensor).map(s => s.src)
    if (sensors.length) return ` (${sensors.join(', ')} sends it: choose it in Settings)`
    const plugins = others.map(s => s.src)
    return plugins.length ? ` (only from ${plugins.join(', ')}, another plugin: choose it in Settings to use it)` : ''
  }

  // Apparent wind drives everything, so when it stops nothing else would update the
  // status: checked on every other input and once a second.
  function checkWind (now) {
    const a = latest['environment.wind.angleApparent']
    const b = latest['environment.wind.speedApparent']
    if (fresh('environment.wind.angleApparent', now) != null && fresh('environment.wind.speedApparent', now) != null) return
    const last = Math.max(a ? a.at : -Infinity, b ? b.at : -Infinity)
    status('nowind', (last > -Infinity ? `No apparent wind for ${Math.round((now - last) / 1000)} s: nothing published` : 'Waiting for apparent wind') + alternatives('apparentWind', now))
  }

  // Heel in degrees from an attitude value, or null when it has none or is implausible.
  function rollDeg (att) {
    const roll = att && typeof att === 'object' ? att.roll : null
    if (roll == null || !Number.isFinite(roll)) return null
    const h = roll * RAD_TO_DEG
    return Math.abs(h) > MAX_PLAUSIBLE_HEEL_DEG ? null : h
  }

  // Damped heel, when the attitude in use is fresh and plausible. The damping takes every
  // attitude message (onDelta), at the sensor's own rate, not only those that happen to come
  // before an STW or wind update.
  function heelDeg (now) {
    return rollDeg(fresh('navigation.attitude', now)) == null ? null : damp.heel.v
  }

  // Heading in degrees, when it is fresh.
  function headingDeg (path, now) {
    const v = fresh(path, now)
    return v == null ? undefined : norm360(v * RAD_TO_DEG)
  }

  // values: [{ key (an OUTPUTS key), value }]. Nothing that is not a finite number goes out.
  const finite = v => typeof v.value === 'number' ? Number.isFinite(v.value) : Object.values(v.value).every(Number.isFinite)
  const isSensor = src => Object.values(sources).some(s => s.src === src && s.sensor)
  function publish (values, timestamp, from) {
    const now = nowMs()
    const limited = !isSensor(from) // driven by another plugin's output: a loop is possible
    const kept = values.filter(finite).filter(v => {
      if (limited && now - (publishedAt[v.key] ?? -Infinity) < MIN_PUBLISH_INTERVAL_MS) return false
      publishedAt[v.key] = now
      sentAt[v.key] = now
      const st = sentTimes[v.key] = sentTimes[v.key] || []
      st.push(now)
      while (now - st[0] > RATE_WINDOW_MS) st.shift()
      return true
    })
    if (kept.length < values.filter(finite).length) noteDrop(now, from)
    values = kept.map(v => ({ path: outPath(v.key), value: v.value }))
    if (!values.length) return
    // No source object: the server stamps $source with plugin.id, which is what the
    // loop guard and the user's Source Priorities entry match on.
    app.handleMessage(plugin.id, { updates: [{ timestamp, values }] })
  }

  // Corrected STW goes out as soon as the paddlewheel reports, at its own rate.
  function onStw (rawMs, timestamp, now, from) {
    const stwKn = rawMs * MS_TO_KN
    // A sensor fault is not a reading; republishing it under this plugin's source
    // would put the source the user ranked first behind a bad number.
    if (stwKn < 0 || stwKn > MAX_PLAUSIBLE_STW_KN) return
    // The raw value goes out with the corrected one, in one delta (§7.5).
    const values = [{ key: 'stwRaw', value: rawMs }]
    if (config.corrections.stw.enabled) {
      const { c } = correctInputs({ stw: stwKn, heel: heelDeg(now) }, config)
      values.push({ key: 'stw', value: damp.stw.update(c.stw, now, config.damping.stwS) / MS_TO_KN })
    }
    publish(values, timestamp, from)
  }

  // Variation in degrees: from Signal K (the GPS) when fresh, else the configured fallback.
  function variationDeg (now) {
    const vr = fresh('navigation.magneticVariation', now, VARIATION_MAX_AGE_MS)
    return vr != null ? vr * RAD_TO_DEG : config.variation
  }

  // COG true in degrees. Many GPSs send COG magnetic only (PGN 129026 referenced to
  // magnetic); that is turned true with the same variation as the heading.
  function cogTrue (now) {
    const t = fresh('navigation.courseOverGroundTrue', now)
    if (t != null) return t * RAD_TO_DEG
    const m = fresh('navigation.courseOverGroundMagnetic', now)
    return m == null ? undefined : norm360(m * RAD_TO_DEG + variationDeg(now))
  }

  // True heading in degrees, as true wind uses it: from a true-heading sensor, else the
  // compass plus variation.
  function trueHeading (now) {
    const t = headingDeg('navigation.headingTrue', now)
    if (t != null) return t
    const m = headingDeg('navigation.headingMagnetic', now)
    return m == null ? undefined : norm360(m + variationDeg(now))
  }

  // With each heading update, at the compass's own rate (10 Hz where apparent wind comes at
  // 2 Hz):
  // - true heading, as heading + variation; not when the heading sensor sends true heading
  //   itself, so a better source (a GPS compass) is never displaced;
  // - TWA and ground wind angle: the damped TWD and ground wind direction from the last
  //   apparent wind, less the heading now, damped for reading (twaS). TWD is steady, so they
  //   change as the heading does, and go out with it, not with apparent wind. TWD keeps the
  //   undamped heading, so a yaw still cancels in it.
  // In a delta with apparent wind as well, onWind has already run, so this uses its TWD.
  function onHeading (timestamp, now, from) {
    const hdg = trueHeading(now)
    if (hdg == null) return
    const values = []
    if (fresh('navigation.headingTrue', now) == null) values.push({ key: 'hdt', value: hdg / RAD_TO_DEG })
    const p = lastResult && lastResult.published
    if (p && p.twd != null && now - lastResultAt < STALE_MS) {
      const twaS = config.damping.twaS
      p.twa = wrap180(damp.twaOut.update(wrap180(p.twd - hdg), now, twaS))
      values.push({ key: 'twa', value: p.twa / RAD_TO_DEG })
      if (p.groundWind && !lightAirGround) {
        p.groundWind.angle = wrap180(damp.gwaOut.update(wrap180(p.groundWind.direction - hdg), now, twaS))
        values.push({ key: 'gwa', value: p.groundWind.angle / RAD_TO_DEG })
      }
    }
    if (values.length) publish(values, timestamp, from)
  }

  // TWS, TWD, current and leeway go out on every apparent wind update; TWA only when there
  // is no heading (with one, onHeading sends it).
  function onWind (timestamp, now, from) {
    const awa = fresh('environment.wind.angleApparent', now)
    const aws = fresh('environment.wind.speedApparent', now)
    const stw = fresh('navigation.speedThroughWater', now)
    if (awa == null || aws == null) return checkWind(now)
    if (stw == null) return status('nostw', 'Waiting for speed through water — no true wind without it' + alternatives('stw', now))

    const awsKn = aws * MS_TO_KN
    const stwKn = stw * MS_TO_KN
    if (awsKn < 0 || awsKn > MAX_PLAUSIBLE_AWS_KN) return status('badaws', `Not publishing — AWS of ${awsKn.toFixed(1)} kn is not plausible`)
    if (stwKn < 0 || stwKn > MAX_PLAUSIBLE_STW_KN) return status('badstw', `Not publishing — STW of ${stwKn.toFixed(1)} kn is not plausible`)

    const scaled = (v, k) => v == null ? undefined : v * k
    const input = {
      awa: wrap180(awa * RAD_TO_DEG),
      aws: awsKn,
      stw: stwKn,
      heel: heelDeg(now),
      headingMagnetic: headingDeg('navigation.headingMagnetic', now),
      headingTrue: headingDeg('navigation.headingTrue', now),
      variation: scaled(fresh('navigation.magneticVariation', now, VARIATION_MAX_AGE_MS), RAD_TO_DEG),
      sog: scaled(fresh('navigation.speedOverGround', now), MS_TO_KN),
      cog: cogTrue(now),
      cogFrom: fresh('navigation.courseOverGroundTrue', now) != null ? 'true' : 'magnetic' // for the Live page
    }
    const result = process(input, config)
    if (!Number.isFinite(result.out.twa) || !Number.isFinite(result.out.tws)) return status('badwind', 'Not publishing — true wind could not be worked out from these inputs')
    lastResult = { input, ...result }
    lastResultAt = now

    // Damped for publishing. With a heading, TWA and ground wind angle are onHeading's: here,
    // for the status and the Live page, the ones last sent (or TWD − heading before any).
    const o = result.out
    const dm = config.damping
    const tws = damp.tws.update(o.tws, now, dm.trueWindS)
    const twd = o.twd == null ? null : damp.twd.update(o.twd, now, dm.trueWindS)
    const twa = wrap180(twd == null ? damp.twa.update(o.twa, now, dm.trueWindS) : damp.twaOut.value() ?? twd - o.heading)
    const cur = o.current ? damp.current.update(o.current.drift, o.current.set, now, dm.currentS) : null
    let gw = null
    if (o.groundWind) {
      const gwd = damp.gwd.update(o.groundWind.direction, now, dm.trueWindS)
      gw = { direction: gwd, speed: damp.gws.update(o.groundWind.speed, now, dm.trueWindS), angle: wrap180(damp.gwaOut.value() ?? gwd - o.heading) }
    }
    lastResult.published = { twa, tws, twd, stw: config.corrections.stw.enabled ? damp.stw.v : null, current: cur && { drift: cur.speed, set: cur.deg }, groundWind: gw }

    lightAir = tws < (lightAir ? LIGHT_AIR_ON_KN : LIGHT_AIR_OFF_KN)
    lightAirGround = !!gw && gw.speed < (lightAirGround ? LIGHT_AIR_ON_KN : LIGHT_AIR_OFF_KN)
    lastResult.lightAir = lightAir
    lastResult.lightAirGround = lightAirGround
    const values = [{ key: 'tws', value: tws / MS_TO_KN }]
    if (twd == null) values.push({ key: 'twa', value: twa / RAD_TO_DEG }) // no heading to send it
    if (gw) values.push({ key: 'gws', value: gw.speed / MS_TO_KN })
    if (twd != null && !lightAir) values.push({ key: 'twd', value: twd / RAD_TO_DEG })
    if (gw && !lightAirGround) values.push({ key: 'gwd', value: gw.direction / RAD_TO_DEG })
    if (config.corrections.leeway.enabled) values.push({ key: 'leeway', value: o.leeway / RAD_TO_DEG })
    if (cur) values.push({ key: 'current', value: { drift: cur.speed / MS_TO_KN, setTrue: cur.deg / RAD_TO_DEG } })
    publish(values, timestamp, from)

    const missing = []
    if (input.heel == null) missing.push('heel' + alternatives('attitude', now))
    if (o.twd == null) missing.push('heading' + alternatives('heading', now))
    else if (!o.current) missing.push('SOG/COG, so no current or ground wind' + alternatives('gps', now))
    const lacking = missing.length ? ` · no ${missing.join(' or ')}` : ''
    const mode = config.mode === 'shadow' ? 'Shadow' : 'Live'
    if (lightAir) {
      status('lightair', `${mode} — light air, TWS ${tws.toFixed(1)} kn: TWD not published until TWS reaches ${LIGHT_AIR_ON_KN} kn` + lacking)
      return
    }
    status('running', `${mode} — TWA ${Math.abs(twa).toFixed(1)}°, TWS ${tws.toFixed(1)} kn, STW ${o.stw.toFixed(2)} kn` + lacking)
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
    const now = nowMs()
    let wind = null // the apparent wind message completed in this delta, worked out after the loop
    let heading = null // likewise the heading update
    for (const update of (delta.updates || [])) {
      if (isOwnSource(update.$source)) continue
      for (const v of (update.values || [])) {
        const group = INPUT_OF[v.path]
        if (!group || v.value == null) continue
        if (v.path !== 'navigation.attitude' && !Number.isFinite(v.value)) continue

        const src = String(update.$source || '')
        const sensor = fromSensor(update)
        noteSource(group, src, sensor, update.timestamp, now)
        // The chosen source; or, with none chosen, the sensor sending it most often
        // (chooseSensor). Another plugin's output is never used unless chosen: it is a copy,
        // later and slower than the sensor (derived-data's true heading), or already
        // corrected (another STW plugin, which would feed this one, and this one it, without end).
        const wanted = config.sources[group]
        if (!wanted && sensor) chooseSensor(group, src, now)
        if (src !== inUse(group)) continue
        if (PLAUSIBLE[v.path] && !PLAUSIBLE[v.path](v.value)) continue

        latest[v.path] = { value: v.value, source: src, at: now }
        if (v.path === 'navigation.attitude') { const h = rollDeg(v.value); if (h != null) damp.heel.update(h, now, config.damping.heelS) }
        if (group === 'heading') heading = { timestamp: update.timestamp, from: src }
        if (group === 'apparentWind' && windPairComplete(v.path, update.timestamp)) wind = { timestamp: update.timestamp, from: src }
        if (group === 'stw') onStw(v.value, update.timestamp, now, src)
      }
    }
    // Wind first, so a heading in the same delta sends TWA from this wind's TWD.
    if (wind) onWind(wind.timestamp, now, wind.from)
    else checkWind(now)
    if (heading) onHeading(heading.timestamp, now, heading.from)
  }

  function startWith (cfg) {
    stopEverything()
    config = cfg
    publishedAt = {}
    sentAt = {}
    sentTimes = {}
    dropsAt = []
    latest = {}
    sources = {}
    locked = {}
    lockFrom = {}
    switches = []
    windTs = {}
    windWaiting = new Set()
    lightAir = false
    lightAirGround = false
    resetDamping()
    lastResult = null
    statusKind = null // so the next status shows at once (and a cleared notice goes with it)
    startError = ''
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
          windTimer = setInterval(() => checkWind(nowMs()), STATUS_INTERVAL_MS)
          if (windTimer.unref) windTimer.unref()
          return
        } catch (e) {
          app.error(`subscribe failed: ${e.message}`)
        }
      }
      if (attempt >= 20) {
        startError = 'Could not subscribe — subscriptionmanager unavailable'
        app.setPluginError(startError)
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
    if (windTimer) { clearInterval(windTimer); windTimer = null }
    unsubscribes.forEach(f => f())
    unsubscribes = []
  }

  // ---- stored configuration ---------------------------------------------------

  function configFile () {
    return path.join(app.getDataDirPath(), CONFIG_FILE)
  }

  // The webapp's saved configuration: { raw }, {} before the first save. A file that cannot
  // be read also gives { error }: it is never taken for a fresh install, or another boat's
  // tables would run with nothing to say so.
  function loadStored () {
    try {
      const raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'))
      return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { raw } : { raw: {}, error: 'it is not a JSON object' }
    } catch (e) {
      return e.code === 'ENOENT' ? { raw: {} } : { raw: {}, error: e.message }
    }
  }

  // A saved configuration as the webapp should show it: as it is, or, if it fails its
  // checks, its parts that pass with the rest from the defaults (salvage), so a Save fixes
  // the boat's own values instead of replacing them.
  function usable (raw) {
    const n = normalizeConfig(raw)
    if (!n.errors.length) return n.config
    const s = salvage(raw)
    return s ? s.config : n.config
  }

  // The configuration in use, or with the plugin never started, the saved one.
  const current = () => config || usable(loadStored().raw)

  // What is wrong with the saved file, for the webapp: null when it is fine (or absent).
  function storedProblem () {
    const { raw, error } = loadStored()
    if (error) return { errors: [`${CONFIG_FILE} could not be read (${error})`], reset: ['everything'] }
    const { errors } = normalizeConfig(raw)
    if (!errors.length) return null
    const s = salvage(raw)
    return { errors, reset: s ? s.reset : ['everything'] }
  }

  // Write to a temporary file and rename, so a crash mid-write never leaves half a file.
  // Never overwrite a file from a newer release: this version would drop what it
  // does not understand. A file that cannot be read, or fails its checks, is kept beside it
  // as .bad: what the webapp showed of it may not be all of it.
  function saveStored (cfg) {
    const file = configFile()
    const { raw, error } = loadStored()
    const onDisk = raw.schema
    if (Number.isInteger(onDisk) && onDisk > CONFIG_SCHEMA) {
      throw new Error(`the saved configuration is schema ${onDisk}, from a newer version of this plugin; update the plugin rather than overwrite it`)
    }
    if (error || (Object.keys(raw).length && normalizeConfig(raw).errors.length)) fs.copyFileSync(file, file + '.bad')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file + '.tmp', JSON.stringify(cfg, null, 2))
    fs.renameSync(file + '.tmp', file)
  }

  plugin.start = function () {
    started = true
    const { raw, error } = loadStored()
    if (error) {
      startError = `Configuration: could not read ${CONFIG_FILE} (${error}). Not running: Save in the webapp to start from the values shown, or restore your backup`
      app.setPluginError(startError)
      config = normalizeConfig({}).config // so the webapp can still load and repair it
      return
    }
    const { config: cfg, errors, notices } = normalizeConfig(raw)
    notice = notices.join('; ')
    if (notice) app.error(notice)
    if (errors.length) {
      startError = `Configuration: ${errors.join('; ')} — fix it in the webapp`
      app.setPluginError(startError)
      config = usable(raw) // not run: what the webapp shows, to repair it
      return
    }
    startWith(cfg)
  }

  plugin.stop = function () {
    started = false
    stopEverything()
    app.setPluginStatus('Stopped')
  }

  // ---- API for the webapp -------------------------------------------------

  function liveSnapshot () {
    const now = nowMs()
    const inputs = {}
    for (const [path, l] of Object.entries(latest)) inputs[path] = { source: l.source, ageMs: now - l.at }
    return {
      running,
      status: lastStatus,
      error: startError,
      mode: config ? config.mode : null,
      ageMs: lastResult ? now - lastResultAt : null,
      result: lastResult,
      inputs,
      inUse: Object.fromEntries(Object.keys(INPUTS).map(g => [g, config ? inUse(g) : undefined]).filter(([, v]) => v)),
      // Every source of each input, for Settings: its rate, and whether it is another plugin.
      sources: Object.fromEntries(Object.keys(INPUTS).map(g => [g, sourcesOf(g).sort((a, b) => a.src < b.src ? -1 : 1)
        .map(s => ({ source: s.src, hz: rateHz(s.times, now), plugin: !s.sensor }))]).filter(([, l]) => l.length)),
      // What has gone out in the last few seconds, so the Live page lists exactly that.
      sent: Object.keys(sentAt).filter(k => now - sentAt[k] < STALE_MS),
      // Each output's rate over the last RATE_WINDOW_MS, for the Live page's pipeline.
      sentHz: Object.fromEntries(Object.entries(sentTimes).map(([k, t]) => [k, rateHz(t, now)])),
      outputPaths: config ? Object.fromEntries(Object.keys(OUTPUTS).map(k => [k, outPath(k)])) : {}
    }
  }

  // Learning (§11): read sailing from the History API a local day at a time, through
  // lib/learn.js, into day files of records. Nothing is fitted or applied here.
  let learn = { running: false, since: null, until: null, day: null, days: {}, error: '' }
  const learnDir = () => path.join(app.getDataDirPath(), 'learn')
  const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  const dayStart = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getTime() }

  async function runLearn (since, until, sources) {
    let api
    try { api = typeof app.getHistoryApi === 'function' ? await app.getHistoryApi() : null } catch (e) { api = null }
    if (!api) throw new Error('No history provider: install one (such as signalk-parquet or signalk-to-influxdb2) and record some sailing')
    const lack = history.missing(sources)
    if (lack.length) throw new Error(`No sensor in use for ${lack.map(g => INPUT_LABELS[g]).join(', ')}: wait for its data, or choose it in Settings`)
    fs.mkdirSync(learnDir(), { recursive: true })
    const fallback = config ? config.variation : DEFAULTS.variation
    for (let t = dayStart(since); t <= dayStart(until); t = dayStart(localDay(t + 36 * 3600 * 1000))) {
      const day = localDay(t)
      learn.day = day
      const rows = await history.dayRows(api, t, dayStart(localDay(t + 36 * 3600 * 1000)), sources, fallback, plugin.id)
      const recs = []
      const l = new Learner(r => recs.push(r))
      for (const r of rows) l.add(r)
      l.flush()
      const file = path.join(learnDir(), `${day}.jsonl`)
      if (recs.length) fs.writeFileSync(file, recs.map(r => JSON.stringify(r)).join('\n') + '\n')
      else if (fs.existsSync(file)) fs.unlinkSync(file)
      const count = k => recs.filter(r => r.type === 'mnv' && r.kind === k).length
      learn.days[day] = {
        seconds: rows.length,
        tacks: count('mnvTack'), gybes: count('mnvGybe'), roundings: count('mnvComeDown') + count('mnvComeUp'),
        legsUp: recs.filter(r => r.type === 'leg' && r.kind === 'up').length,
        legsOff: recs.filter(r => r.type === 'leg' && r.kind === 'off').length
      }
    }
  }

  function startLearn (body) {
    const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
    const since = body.since; const until = body.until || localDay(Date.now())
    if (!isDay(since) || !isDay(until) || since > until) return 'since and until must be local dates (YYYY-MM-DD), since first'
    if (learn.running) return 'a scan is already running'
    // The sensors in use now, unless the request names them: never another plugin's output.
    const sources = Object.fromEntries(Object.keys(INPUTS).map(g => [g, (body.sources || {})[g] || (config ? inUse(g) : undefined)]).filter(([, v]) => v))
    learn = { running: true, since, until, day: null, days: {}, error: '', sources }
    runLearn(since, until, sources)
      .catch(e => { learn.error = e.message })
      .finally(() => { learn.running = false; learn.day = null })
    return null
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
      res.json({ config: current(), defaults: DEFAULTS, behaviour: BEHAVIOUR, problem: storedProblem() })
    })

    router.put('/calibration', async (req, res) => {
      let body
      try { body = await readBody(req) } catch (e) { return res.status(400).json({ errors: ['body is not valid JSON'] }) }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ errors: ['body must be a JSON object'] })
      // With its schema, a whole configuration; without, changes to the one in use.
      const { config: cfg, errors } = normalizeConfig(body, body.schema === undefined ? current() : undefined)
      if (errors.length) return res.status(400).json({ errors })
      try {
        saveStored(cfg)
      } catch (e) {
        return res.status(500).json({ errors: [`could not save: ${e.message}`] })
      }
      notice = '' // saved in this release's layout
      // Disabled in the server: saved for when it is enabled, and nothing published until then.
      if (started) startWith(cfg)
      else { config = cfg; startError = '' }
      res.json({ config: cfg })
    })

    router.put('/learn/scan', async (req, res) => {
      let body
      try { body = await readBody(req) } catch (e) { return res.status(400).json({ errors: ['body is not valid JSON'] }) }
      const err = startLearn(body || {})
      if (err) return res.status(err.startsWith('a scan') ? 409 : 400).json({ errors: [err] })
      res.status(202).json(learn)
    })

    router.get('/learn/status', (req, res) => {
      res.set('Cache-Control', 'no-store')
      res.json(learn)
    })

    router.get('/live', (req, res) => {
      res.set('Cache-Control', 'no-store')
      res.json(liveSnapshot())
    })
  }

  return plugin
}

// Fixed behaviour the webapp describes, sent from here so its text always matches the code.
// (Each table's axes it reads from the table itself.)
const BEHAVIOUR = {
  maxLeewayDeg: MAX_LEEWAY_DEG,
  leewayFadeKn: LEEWAY_FADE_KN,
  twaTaperUpDeg: TWA_TAPER_UP_DEG,
  twaTaperDownDeg: TWA_TAPER_DOWN_DEG,
  twaSlopeMax: TWA_SLOPE_MAX,
  lightAirOffKn: LIGHT_AIR_OFF_KN,
  lightAirOnKn: LIGHT_AIR_ON_KN,
  staleS: STALE_MS / 1000,
  maxPublishHz: 1000 / MIN_PUBLISH_INTERVAL_MS
}
