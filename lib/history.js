'use strict'
// Learning from the Signal K v2 History API (SPECIFICATION.md §11.2). No Signal K here
// beyond the HistoryApi object (app.getHistoryApi()), so it can be tested with a fake one.
//
//   const rows = await dayRows(api, fromMs, toMs, sources, variationFallback, ownId)
//
// Rows are 1 Hz, in degrees and knots, as lib/learn.js takes them. Every path is read from
// the sensor in use (`sources`, input group -> sourceRef), never unfiltered: the plugin
// publishes corrected STW and true heading on the same paths as the raw inputs. STW comes
// from navigation.speedThroughWaterRaw, the paddlewheel's value the plugin republishes
// (`ownId`, §7.5), since in Replace mode the raw value on navigation.speedThroughWater
// loses the source priority and the server drops it before recording; failing that (no
// priority set, or history from before §7.5), from the sensor on the standard path.

const MS_TO_KN = 1.94384
const DEG = 180 / Math.PI
const PROBE_S = 60 // §11.2: find the sailing minutes first, at this resolution
const MIN_STW_KN = 0.5 // a minute is sailing when its highest STW is over this
const PAD_S = 240 // either side of sailing, so the 7-minute buffer has its context
const CHUNK_S = 3600 // one request covers at most this
const AGGREGATE = 'first' // a sample per second, never an average across a wrap
// Providers may record only changes (signalk-questdb), so a second can be empty while the
// input held its value: each input carries forward this long, the plugin's own STALE (§2.3).
const HOLD_S = 3

const PATHS = [
  ['awa', 'environment.wind.angleApparent', 'apparentWind'],
  ['aws', 'environment.wind.speedApparent', 'apparentWind'],
  ['stw', 'navigation.speedThroughWater', 'stw'],
  ['hdgT', 'navigation.headingTrue', 'heading'],
  ['hdgM', 'navigation.headingMagnetic', 'heading'],
  ['att', 'navigation.attitude.roll', 'attitude'], // providers store the attitude object's members as paths
  ['sog', 'navigation.speedOverGround', 'gps'],
  ['cogT', 'navigation.courseOverGroundTrue', 'gps'],
  ['cogM', 'navigation.courseOverGroundMagnetic', 'gps'],
  ['variation', 'navigation.magneticVariation', 'variation']
]
const RAW_STW = 'navigation.speedThroughWaterRaw'
const REQUIRED = ['apparentWind', 'stw', 'heading', 'attitude'] // a good second needs heel (§11.5)

const fin = x => typeof x === 'number' && Number.isFinite(x)
const wrap180 = d => ((d + 180) % 360 + 360) % 360 - 180
const norm360 = d => (d % 360 + 360) % 360

// A Temporal.Instant where the runtime has one; otherwise what providers read from it.
function instant (ms) {
  const T = globalThis.Temporal
  if (T && T.Instant) return T.Instant.fromEpochMilliseconds(ms)
  const iso = new Date(ms).toISOString()
  return { epochMilliseconds: ms, epochNanoseconds: BigInt(ms) * 1000000n, toString: () => iso, toJSON: () => iso }
}

// The names to read an input from: one sensor, or one device under every name the server
// has recorded it by (an NMEA 2000 device is `n2k-tcp.100` until the server learns its CAN
// name, then `n2k-tcp.c079be00ffd20dcb`): the first is the main one.
const refsOf = v => (Array.isArray(v) ? v : [v]).filter(Boolean)

// Only paths whose input has a sensor in use: a path is never read unfiltered. One column per
// name; toRows takes each second from the first name with a value.
function specs (sources, keys, aggregate) {
  return PATHS.filter(([k, , g]) => keys.includes(k) && sources[g]).flatMap(([key, path, group]) =>
    refsOf(sources[group]).map(sourceRef => ({ key, spec: { path, aggregate, parameter: [], sourceRef } })))
}

// Which sources are missing for learning: a required input with no sensor in use.
function missing (sources) {
  return REQUIRED.filter(g => !sources[g])
}

// Sailing spans of [fromMs, toMs): minutes whose highest STW is over MIN_STW_KN, padded,
// joined, cut into CHUNK_S pieces.
// Where this span's raw STW is: the plugin's raw path, else the sensor's own on the standard
// path. Returns the probe response too, with the path spec to read it with.
async function stwSource (api, fromMs, toMs, sources, ownId) {
  const candidates = []
  if (ownId) candidates.push({ path: RAW_STW, sourceRef: ownId })
  for (const ref of refsOf(sources.stw)) candidates.push({ path: 'navigation.speedThroughWater', sourceRef: ref })
  for (const c of candidates) {
    const res = await api.getValues({ from: instant(fromMs), to: instant(toMs), resolution: PROBE_S, pathSpecs: [{ ...c, aggregate: 'max', parameter: [] }] })
    if ((res.data || []).some(([, v]) => fin(v))) return { c, res }
  }
  return null
}

async function sailingSpans (api, fromMs, toMs, sources, ownId) {
  const found = await stwSource(api, fromMs, toMs, sources, ownId)
  if (!found) return { spans: [], stw: null }
  const res = found.res
  const spans = []
  for (const [ts, v] of res.data || []) {
    if (!fin(v) || v * MS_TO_KN <= MIN_STW_KN) continue
    const t = Date.parse(ts)
    const a = Math.max(fromMs, t - PAD_S * 1000); const b = Math.min(toMs, t + (PROBE_S + PAD_S) * 1000)
    const last = spans[spans.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else spans.push([a, b])
  }
  const out = []
  for (const [a, b] of spans) for (let t = a; t < b; t += CHUNK_S * 1000) out.push([t, Math.min(b, t + CHUNK_S * 1000)])
  return { spans: out, stw: found.c }
}

// A History API response as 1 Hz rows for lib/learn.js.
function toRows (res, keys, variationFallback) {
  const rows = []
  const held = {} // key -> [value, t]
  for (const [ts, ...vals] of res.data || []) {
    const t = Math.floor(Date.parse(ts) / 1000)
    const v = {}
    const got = {}
    keys.forEach((k, i) => { if (vals[i] != null && !(k in got)) got[k] = vals[i] }) // first name with a value
    for (const k of new Set(keys)) {
      if (k in got) held[k] = [got[k], t]
      v[k] = held[k] && t - held[k][1] <= HOLD_S ? held[k][0] : null
    }
    const variation = fin(v.variation) ? v.variation * DEG : variationFallback
    const roll = v.att && typeof v.att === 'object' ? v.att.roll : (fin(v.att) ? v.att : null)
    const heel = fin(roll) && Math.abs(roll * DEG) <= 90 ? roll * DEG : null
    const hdg = fin(v.hdgT) ? norm360(v.hdgT * DEG) : fin(v.hdgM) && fin(variation) ? norm360(v.hdgM * DEG + variation) : null
    const cog = fin(v.cogT) ? norm360(v.cogT * DEG) : fin(v.cogM) && fin(variation) ? norm360(v.cogM * DEG + variation) : null
    rows.push({
      t,
      awa: fin(v.awa) ? wrap180(v.awa * DEG) : null,
      aws: fin(v.aws) && v.aws >= 0 ? v.aws * MS_TO_KN : null,
      stw: fin(v.stw) && v.stw >= 0 ? v.stw * MS_TO_KN : null,
      heel,
      hdg,
      sog: fin(v.sog) ? v.sog * MS_TO_KN : null,
      cog,
      variation: fin(variation) ? variation : null
    })
  }
  return rows.sort((a, b) => a.t - b.t)
}

// One local day's (or any span's) sailing as 1 Hz rows, read a chunk at a time.
async function dayRows (api, fromMs, toMs, sources, variationFallback, ownId) {
  const keys = PATHS.map(([k]) => k)
  const rows = []
  const { spans, stw } = await sailingSpans(api, fromMs, toMs, sources, ownId)
  for (const [a, b] of spans) {
    const ps = specs(sources, keys, AGGREGATE).map(p => p.key === 'stw' ? { key: 'stw', spec: { ...p.spec, ...stw } } : p)
      .filter((p, i, all) => all.findIndex(q => JSON.stringify(q) === JSON.stringify(p)) === i) // STW: one column
    const res = await api.getValues({ from: instant(a), to: instant(b), resolution: 1, pathSpecs: ps.map(p => p.spec) })
    rows.push(...toRows(res, ps.map(p => p.key), variationFallback))
  }
  return rows
}

module.exports = { refsOf, dayRows, sailingSpans, stwSource, toRows, missing, instant, PATHS, RAW_STW, _internals: { PROBE_S, PAD_S, CHUNK_S, AGGREGATE, MIN_STW_KN, HOLD_S } }
