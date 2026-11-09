(function () {
  'use strict'

  const API = '/plugins/signalk-performance-processor'
  const LIVE_MS = 1000
  const last = xs => xs[xs.length - 1]
  // A table's heel rows mirror each other: Edit symmetrically can work.
  const mirrored = xs => xs.every((v, i) => v === -xs[xs.length - 1 - i])

  // Fixed behaviour of each correction, written from the numbers the plugin sends (b) and
  // the table being edited (t), so the description always matches the code.
  const LIMITS = {
    stw: (b, t) => [
      `Below the first column (${t.stw[0]} kn) the correction runs in a straight line to nothing at 0 kn, so a stopped boat is never given speed. A column at 1 kn catches a paddlewheel's stall, which a straight line from 2.5 kn (the H5000's first column) misses. Beyond the last column (${last(t.stw)} kn) that column is held.`,
      `Rows are heel each side (− = port side down, + = starboard side down), linear between rows; more heel than the last row (${t.heel[0]}° or ${last(t.heel)}°) uses the last row.` + (mirrored(t.heel) ? ' Edit symmetrically copies each value to the same heel on the other side.' : ''),
      'Most paddlewheels read low when slow, so positive values at low speed are normal.'
    ],
    leeway: b => [
      `Capped at ±${b.maxLeewayDeg}°.`,
      `Fades in with speed: none below ${b.leewayFadeKn[0]} kn, in full from ${b.leewayFadeKn[1]} kn, so it does not snap on as the boat gets going. K × heel ÷ STW² grows without limit as the boat slows.`,
      'Needs heel; without it leeway is 0.'
    ],
    twa: (b, t) => [
      `Linear between rows and between TWS columns, never a step. Below the first row (${t.twa[0]}°) that row applies; beyond the last (${last(t.twa)}°), the last.`,
      `Fades out towards head to wind and dead downwind: in full from ${b.twaTaperUpDeg}° to ${180 - b.twaTaperDownDeg}° TWA, none at 0° and 180°. TWA and TWD then pass smoothly through tacks and gybes instead of TWD following the bow. Upwind the boat is inside the fade only while tacking; downwind, sailing deeper than ${180 - b.twaTaperDownDeg}° gets part of the correction.`,
      `To keep that smooth, corrected TWA must move the same way as TWA and no more than ${b.twaSlopeMax} times as fast: within ±${b.twaTaperUpDeg}° near head to wind, ±${b.twaTaperDownDeg}° near dead downwind, and from one row to the next a change smaller than the rows are apart. Save says where a table breaks this.`,
      `Below the first TWS column (${t.tws[0]} kn) the correction runs in a straight line to nothing at 0 kn; beyond the last (${last(t.tws)} kn) that column is held.`
    ],
    tws: (b, t) => [
      `Linear between rows and between TWS columns, never a step. Below the first row (${t.twa[0]}°) that row applies; beyond the last (${last(t.twa)}°), the last.`,
      `Below the first TWS column (${t.tws[0]} kn) the correction runs in a straight line to nothing at 0 kn; beyond the last (${last(t.tws)} kn) that column is held.`,
      'Looked up at the TWA after the TWA table. Never takes TWS below 0.'
    ]
  }

  // Display names and help for each correction, in pipeline order.
  const CORRECTIONS = {
    stw: { name: 'Boat speed (STW)', what: 'Knots added to the paddlewheel by heel (rows, port − and starboard +) and boat speed (columns): the H5000 boat speed / heel table, as fine as your data allows. A blank cell takes the value to its left in its row (at the start of a row, the first value to its right). Applied before anything else uses STW.' },
    leeway: { name: 'Leeway', what: 'Sideways slip: leeway = K × heel ÷ STW². Published, and used for current. Not used in true wind: the TWA table takes up its effect.' },
    twa: { name: 'TWA table', what: 'Degrees added to |TWA|, by TWA (rows) and TWS (columns). Negative = TWA was reading too wide. A blank cell takes the value to its left in its row (at the start of a row, the first value to its right).' },
    tws: { name: 'TWS table', what: 'Knots added to TWS, by TWA (rows) and TWS (columns). Masthead units read high downwind (the sails speed the air up over the top of the rig), so the downwind rows are usually negative. A blank cell takes the value to its left in its row (at the start of a row, the first value to its right).' }
  }

  // The tables' text format (tables.js): what Paste a table reads and Copy writes.
  // Any rows and columns, each going up: a pasted table brings its own.
  const PASTE = {
    stw: { hint: 'First row <code>heel\\stw</code> then the boat speed columns (kn); then a row per heel (° , − = port side down), each its heel then its values. An H5000 table has no 1 kn column: give it 0.4 × the 2.5 kn value to keep the table as it was.' },
    twa: { hint: 'First row <code>TWA\\TWS</code> then the TWS columns (kn); then a row per TWA (°), each its TWA then its values. An H5000 table\'s rows <code>upwind</code>, <code>reach</code> and <code>downwind</code> read as 40°, 90° and 165°.' },
    tws: { hint: 'First row <code>TWA\\TWS</code> then the TWS columns (kn); then a row per TWA (°), each its TWA then its values. An H5000-style table (rows <code>upwind</code>, <code>reach</code>, <code>downwind</code>, <code>up angle</code>, <code>down angle</code>, as boatcal printed it before schema 7) is read as the grid that works the same.' }
  }

  const SOURCE_LABELS = {
    apparentWind: 'Apparent wind',
    stw: 'Speed through water',
    heading: 'Heading',
    attitude: 'Heel (attitude)',
    gps: 'SOG and COG',
    variation: 'Magnetic variation'
  }

  const state = {
    view: 'live',
    saved: null, // config as stored by the plugin
    draft: null, // config being edited
    defaults: null,
    behaviour: null, // the plugin's fixed limits (GET /calibration), for the help text
    configError: null,
    problem: null, // what is wrong with the saved file, if anything (GET /calibration)
    selected: 'twa',
    symmetric: false, // STW table: edit the same heel on both sides at once
    live: null,
    saving: false,
    analysis: { status: null, summary: null, recent: null, range: '0', error: '', loadedAt: 0 }
  }

  const VIEWS = ['live', 'calibration', 'settings', 'analysis']
  const ANALYSIS_MS = 30000
  const RECENT_S = 2 * 3600 // the latest findings shown
  const BLOCK_S = 10 * 60 // 5 s records summed into blocks of this
  const $ = id => document.getElementById(id)
  const clone = o => JSON.parse(JSON.stringify(o))
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const fmt = (v, d = 1) => v == null || !Number.isFinite(v) ? '--' : v.toFixed(d)
  const dirty = () => JSON.stringify(state.saved) !== JSON.stringify(state.draft)
  const side = v => v < 0 ? 'port' : 'stbd'
  const on = id => !!(state.saved && state.saved.corrections[id] && state.saved.corrections[id].enabled) // a saved correction is enabled

  // ---- data ----------------------------------------------------------------

  async function getJson (path) {
    const res = await fetch(API + path, { credentials: 'include', cache: 'no-store' })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.json()
  }

  async function loadConfig () {
    try {
      const body = await getJson('/calibration')
      if (!body || !body.config || !body.config.corrections) throw new Error('the plugin returned no calibration')
      state.saved = body.config
      state.draft = clone(body.config)
      state.defaults = body.defaults
      state.behaviour = body.behaviour || null
      state.problem = body.problem || null
      state.configError = null
    } catch (e) {
      // Kept until a load succeeds: the live poll must not clear it.
      state.configError = `Could not load the calibration (${e.message}). Is Performance Processor enabled and up to date?`
      setTimeout(loadConfig, 5000)
    }
    renderAll()
  }

  async function pollLive () {
    try {
      state.live = await getJson('/live')
      $('conn').hidden = true
    } catch (e) {
      $('conn').textContent = `Lost contact with the plugin (${e.message})`
      $('conn').hidden = false
    }
    renderHeader()
    if (state.view === 'live') renderLive()
    if (state.view === 'settings') renderSourcesIfIdle()
  }

  async function save () {
    state.saving = true
    renderSaveBar()
    try {
      const res = await fetch(API + '/calibration', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.draft)
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const why = body.errors ? body.errors.join('; ') : `${res.status} ${res.statusText}`
        throw new Error(res.status === 401 || res.status === 403 ? 'not authorised — log in to Signal K with write access' : why)
      }
      state.saved = body.config
      state.draft = clone(body.config)
      state.problem = null // saved in this release's layout, and checked
      $('saveErrors').textContent = ''
    } catch (e) {
      $('saveErrors').textContent = e.message
    }
    state.saving = false
    renderAll()
  }

  // ---- editing ---------------------------------------------------------------

  // data-path="corrections.twa.upwind.2" → state.draft.corrections.twa.upwind[2]
  function setPath (path, value) {
    const keys = path.split('.')
    let o = state.draft
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]]
    o[keys[keys.length - 1]] = value
  }

  function onEdit (e) {
    const el = e.target
    if (el.id === 'stwSymmetric') { state.symmetric = el.checked; return }
    if (!el.dataset || !el.dataset.path || !state.draft) return
    let value
    if (el.type === 'checkbox') value = el.checked
    else if (el.type === 'number') {
      // A blank cell in a table that allows it means "not measured"; elsewhere the old value
      // stays, and comes back into the box so what is shown is what will be saved.
      if (el.value === '' && !el.dataset.nullable) { el.value = el.dataset.path.split('.').reduce((o, k) => o[k], state.draft); return }
      value = el.value === '' ? null : Number(el.value)
    } else value = el.value
    setPath(el.dataset.path, value)
    // Edit symmetrically: the same value at the same heel on the other side.
    const m = el.dataset.path.match(/^corrections\.stw\.add\.(\d+)\.(\d+)$/)
    if (m && state.symmetric) {
      const mirror = state.draft.corrections.stw.add.length - 1 - Number(m[1])
      setPath(`corrections.stw.add.${mirror}.${m[2]}`, value)
      const other = document.querySelector(`[data-path="corrections.stw.add.${mirror}.${m[2]}"]`)
      if (other) other.value = value == null ? '' : value
    }
    renderSaveBar()
    if (el.dataset.path.startsWith('corrections.tws.') && $('twsExample')) $('twsExample').textContent = twsExample(state.draft.corrections.tws)
    if (el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT') renderAll()
  }

  // ---- rendering -----------------------------------------------------------

  function renderAll () {
    renderHeader()
    renderSaveBar()
    for (const v of VIEWS) $('view-' + v).hidden = v !== state.view
    document.querySelectorAll('nav a').forEach(a => a.classList.toggle('current', a.dataset.view === state.view))
    if (state.view === 'live') renderLive()
    if (state.view === 'calibration') renderCalibration()
    if (state.view === 'settings') renderSettings()
    if (state.view === 'analysis') renderAnalysis()
  }

  function renderHeader () {
    $('cfgError').textContent = state.configError || ''
    $('cfgError').hidden = !state.configError
    // A saved file that fails its checks: the plugin is stopped, and what is shown is the
    // file's good parts with the rest from the defaults. Say which, so a Save is a choice.
    const pr = state.problem
    $('problem').textContent = pr
      ? `Your saved configuration has errors, so the plugin is not running: ${pr.errors.join('; ')}. ` +
        (pr.reset.includes('everything') ? 'Shown here: the defaults. ' : `Shown here: your own values, except ${pr.reset.join(', ')}, reset to the defaults. `) +
        'Fix them and Save: the file as it was is then kept as config.json.bad.'
      : ''
    $('problem').hidden = !pr
    const mode = state.saved ? state.saved.mode : null
    const badge = $('mode')
    badge.textContent = mode === 'replace' ? 'Replace' : mode === 'shadow' ? 'Shadow' : '--'
    badge.classList.toggle('replace', mode === 'replace')
    $('status').textContent = state.live ? (state.live.running ? state.live.status : `Plugin not running${state.live.error ? ': ' + state.live.error : ''}`) : ''
  }

  function renderSaveBar () {
    $('saveBar').hidden = !(state.draft && (dirty() || $('saveErrors').textContent))
    $('save').disabled = state.saving || !dirty()
    $('revert').disabled = state.saving
  }

  // -- Live

  // True wind from apparent wind and a boat speed, with no tables: on the paddlewheel's
  // STW it is the uncorrected true wind; on the corrected STW, true wind before the tables.
  function trueWind (input, stw) {
    const a = input.awa * Math.PI / 180
    const x = input.aws * Math.cos(a) - stw
    const y = input.aws * Math.sin(a)
    return { twa: Math.atan2(y, x) * 180 / Math.PI, tws: Math.hypot(x, y) }
  }

  // The pipeline, one chain per value sent to Signal K, read left to right: what it uses,
  // each step with its value now, the damping, and on the far right what is sent. Every
  // input is one the code uses (lib/processor.js, and the damping in index.js); a value
  // made by another chain is marked with that chain's name instead of a crossing line.
  function flowChains (live) {
    const r = live.result
    const o = r.out
    const p = r.published || o
    const i = r.input
    const dm = (state.saved && state.saved.damping) || {}
    const step = id => r.steps.find(s => s.id === id) || {}
    const angle = v => `${fmt(Math.abs(v))}° ${side(v)}`
    const change = (v, d) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d)
    const damping = s => ({ label: 'Damping', value: s ? `${s} s` : 'none', cls: 'damp' })
    const before = trueWind(i, o.stw)
    const held = r.lightAir
    const heldGround = r.lightAirGround
    // Rate of the sensor in use for an input group, as Settings lists it.
    const hzOf = group => {
      const s = ((live.sources || {})[group] || []).find(x => x.source === (live.inUse || {})[group])
      return s ? s.hz : null
    }
    // Inputs: from a sensor, or made by another chain; group: whose rate the box shows (for a
    // value from another chain, the input that chain is worked out on).
    const sensor = (label, value, note, group) => ({ label, value, note, cls: 'sensor', hz: group && hzOf(group) })
    const from = (label, value, chain, group) => ({ label, value, note: `from ${chain}`, cls: 'from', hz: group && hzOf(group) })
    const missing = (label, note) => ({ label, value: 'none', note, cls: 'off' })
    // A correction step: off, skipped (and why), or what it did.
    const corr = (id, label, value, note) => {
      const s = step(id)
      if (!s.enabled) return { label, value: 'off', note: 'passes the value through', cls: 'off' }
      if (s.skipped) return { label, value: '--', note: s.skipped, cls: 'off' }
      return { label, value, note }
    }
    const notSent = why => ({ lines: ['not sent'], note: why, cls: 'off' })

    const heel = i.heel == null ? missing('Heel', 'upright row, no leeway') : sensor('Heel', `${fmt(Math.abs(i.heel), 0)}° ${side(i.heel)}`, `damped ${dm.heelS} s`, 'attitude')
    const heading = o.heading == null ? missing('Heading', 'no TWD, current or ground wind') : from('Heading', `${fmt(o.heading, 0)}° T`, 'heading', 'heading')
    const fromCompass = i.headingTrue == null && i.headingMagnetic != null
    const stw = from('STW', `${fmt(o.stw, 2)} kn`, 'boat speed', 'stw')

    return [
      {
        // True heading: the compass plus variation, sent with each compass update unless the
        // heading sensor sends true heading itself.
        name: 'Heading',
        inputs: i.headingTrue != null ? [sensor('True heading', `${fmt(i.headingTrue, 0)}° T`, 'from the heading sensor', 'heading')]
          : i.headingMagnetic != null ? [sensor('Compass', `${fmt(i.headingMagnetic, 0)}° M`, 'magnetic', 'heading'), o.headingFrom === 'magnetic + fallback variation' ? sensor('Variation', `${fmt(Math.abs(o.variation), 1)}° ${o.variation < 0 ? 'W' : 'E'}`, 'fallback, from Settings') : sensor('Variation', `${fmt(Math.abs(o.variation), 1)}° ${o.variation < 0 ? 'W' : 'E'}`, 'from Signal K', 'variation')]
            : [missing('Compass', 'no TWD, current or ground wind')],
        steps: [fromCompass ? { label: 'Add variation', value: `${fmt(o.heading, 0)}° T` } : { label: 'Add variation', value: '--', note: i.headingTrue != null ? 'not needed' : 'no heading', cls: 'off' }, damping(0)],
        out: fromCompass ? { lines: [`Heading ${fmt(o.heading, 0)}° T`] } : notSent(i.headingTrue != null ? 'the sensor sends true heading' : 'no heading')
      },
      {
        name: 'Boat speed',
        inputs: [sensor('Paddlewheel', `${fmt(i.stw, 2)} kn`, 'raw', 'stw'), heel],
        steps: [corr('stw', 'STW table', `${change(o.stw - i.stw, 2)} kn`, i.heel == null ? 'upright row' : `at ${fmt(Math.abs(i.heel), 0)}° heel ${side(i.heel)}`), damping(dm.stwS)],
        out: on('stw') && p.stw != null ? { lines: [`STW ${fmt(p.stw, 2)} kn`] } : notSent('STW table off: the paddlewheel is used as it is')
      },
      {
        name: 'Leeway',
        inputs: [heel, stw],
        steps: [corr('leeway', 'K × heel ÷ STW²', angle(o.leeway), `K ${state.saved ? state.saved.corrections.leeway.k : ''}`)],
        out: on('leeway') ? { lines: [`Leeway ${angle(o.leeway)}`] } : notSent('leeway off: 0°')
      },
      {
        // TWA, TWS and TWD are one calculation: true wind from apparent wind and boat speed,
        // the tables, then heading for TWD. The published TWA is the damped TWD less the
        // heading, so it answers the helm at once while the wind is steady.
        name: 'True wind',
        inputs: [sensor('AWA, AWS', angle(i.awa), `${fmt(i.aws)} kn`, 'apparentWind'), stw, heading],
        steps: [
          { label: 'Apparent − boat', value: `${fmt(Math.abs(before.twa))}° · ${fmt(before.tws)} kn`, note: 'STW along the heading, no leeway' },
          // The tables' own account, including how much of the row applies where they
          // blend in or fade out.
          corr('twa', 'TWA table', `${fmt(Math.abs(o.twa))}°`, step('twa').detail),
          corr('tws', 'TWS table', `${fmt(o.tws)} kn`, step('tws').detail),
          o.twd == null
            ? { label: 'Heading + TWA', value: '--', note: 'no heading: no TWD', cls: 'off' }
            : { label: 'Heading + TWA', value: `TWD ${fmt(o.twd, 0)}° T`, note: `sent TWA = TWD − heading${dm.twaS ? `, damped ${dm.twaS} s` : ''}` },
          damping(dm.trueWindS)
        ],
        out: held
          ? { lines: [`TWA ${angle(p.twa)}`, `TWS ${fmt(p.tws)} kn`], note: 'TWD not sent: light air' }
          : o.twd == null
            ? { lines: [`TWA ${angle(p.twa)}`, `TWS ${fmt(p.tws)} kn`], note: 'TWD not sent: no heading' }
            : { lines: [`TWD ${fmt(p.twd, 0)}° T`, `TWA ${angle(p.twa)}`, `TWS ${fmt(p.tws)} kn`] }
      },
      {
        name: 'Current',
        inputs: [i.sog == null || i.cog == null ? missing('SOG, COG', 'no current') : sensor('SOG, COG', `${fmt(i.sog, 2)} kn · ${fmt(i.cog, 0)}° T`, i.cogFrom === 'magnetic' ? 'COG magnetic + variation' : 'COG true', 'gps'), heading, stw, from('Leeway', angle(o.leeway), 'leeway', 'apparentWind')],
        steps: o.current
          ? [{ label: 'Ground − water', value: `${fmt(o.current.drift, 2)} kn → ${fmt(o.current.set, 0)}°`, note: 'water: STW along heading + leeway' }, damping(dm.currentS)]
          : [{ label: 'Ground − water', value: '--', note: 'needs heading, SOG and COG', cls: 'off' }],
        out: p.current ? { lines: [`Current ${fmt(p.current.drift, 2)} kn → ${fmt(p.current.set, 0)}°`] } : notSent('no heading or GPS')
      },
      {
        name: 'Ground wind',
        inputs: o.groundWind
          ? [from('TWD', `${fmt(o.twd, 0)}°`, 'true wind', 'apparentWind'), from('TWS', `${fmt(o.tws)} kn`, 'true wind', 'apparentWind'), from('Current', `${fmt(o.current.drift, 2)} kn`, 'current', 'apparentWind')]
          : [missing('Current', 'needs heading, SOG and COG')],
        steps: o.groundWind
          ? [{ label: 'True wind + current', value: `${fmt(o.groundWind.direction, 0)}° · ${fmt(o.groundWind.speed)} kn` }, damping(dm.trueWindS)]
          : [],
        out: !p.groundWind ? notSent('no current')
          : heldGround ? { lines: [`GWS ${fmt(p.groundWind.speed)} kn`], note: 'GWD and GWA not sent: light air' }
            : { lines: [`GWD ${fmt(p.groundWind.direction, 0)}° T`, `GWA ${angle(p.groundWind.angle)}`, `GWS ${fmt(p.groundWind.speed)} kn`] }
      }
    ]
  }

  // A rate in Hz, as short as it can be (the boxes are narrow): 0.5, 4, 10, or nothing when
  // unknown. Whole numbers from 2 Hz: a 10 Hz sensor measures 9.9 now and then.
  const hzText = hz => hz == null ? '' : `${hz >= 2 ? Math.round(hz) : hz.toFixed(1)} Hz`
  // Each line sent names its output by its first word.
  const OUT_KEYS = { Heading: 'hdt', STW: 'stw', Leeway: 'leeway', TWD: 'twd', TWA: 'twa', TWS: 'tws', Current: 'current', GWD: 'gwd', GWA: 'gwa', GWS: 'gws' }

  function renderFlow (live) {
    // Every step box is the same size, so nothing moves as the values change: a long note is
    // cut to two lines, with the whole of it on hover. A box's rate sits at the right of its
    // label, so a changing rate moves nothing either.
    const hzSpan = hz => hz == null ? '' : `<span class="hz">${esc(hzText(hz))}</span>`
    const sentHz = live.sentHz || {}
    const outLine = t => { const k = OUT_KEYS[t.split(' ')[0]]; return `<div class="oline"><span>${esc(t)}</span>${hzSpan(k ? sentHz[k] : null)}</div>` }
    const chip = c => `<div class="fchip ${c.cls || ''}"${c.note ? ` title="${esc(c.note)}"` : ''}><div class="l"><span>${esc(c.label)}</span>${hzSpan(c.hz)}</div>` +
      `<div class="v">${esc(c.value || '')}</div>` + (c.note ? `<div class="n">${esc(c.note)}</div>` : '') + '</div>'
    $('flow').innerHTML = flowChains(live).map(ch =>
      `<div class="chain"><div class="cname">${esc(ch.name)}</div>` +
      `<div class="cin">${ch.inputs.map(chip).join('')}</div>` +
      `<div class="csteps"><span class="arrow">→</span>${ch.steps.map(chip).join('<span class="arrow">→</span>')}<span class="tail"></span></div>` +
      `<div class="cout"><div class="obox ${ch.out.cls || ''}">${ch.out.lines.map(outLine).join('')}` +
      (ch.out.note ? `<div class="n">${esc(ch.out.note)}</div>` : '') + '</div></div></div>').join('')
  }

  // Where true heading came from, so a fallback variation is visible at a glance.
  function headingNote (o) {
    if (o.headingFrom === 'true heading') return 'from true heading'
    const v = o.variation == null ? '' : ` ${Math.abs(o.variation).toFixed(1)}° ${o.variation < 0 ? 'W' : 'E'}`
    return o.headingFrom === 'magnetic + fallback variation' ? `fallback variation${v}` : `variation${v} from GPS`
  }

  function tile (label, value, unit, raw) {
    return `<div class="tile"><div class="label">${esc(label)}</div>` +
      `<div class="value">${esc(value)}<span class="unit">${esc(unit)}</span></div>` +
      `<div class="raw">${esc(raw || '')}</div></div>`
  }

  function renderLive () {
    const live = state.live
    const r = live && live.result
    const staleMs = (state.behaviour ? state.behaviour.staleS : 3) * 1000
    const old = !r || live.ageMs > staleMs
    $('liveAge').textContent = r ? (old ? `last update ${Math.round(live.ageMs / 1000)} s ago: nothing is being published` : '') : ''
    // Old numbers are greyed out, so a stopped sensor never passes for a steady wind.
    for (const id of ['tiles', 'flow', 'published']) $(id).classList.toggle('stale', !!r && old)

    if (!r) {
      $('tiles').innerHTML = ''
      $('flow').innerHTML = `<p class="muted center">${esc(live ? live.status || 'Waiting for data…' : 'Waiting for data…')}</p>`
    } else {
      const o = r.out
      const p = r.published || o // what is sent: damped
      const u = trueWind(r.input, r.input.stw)
      $('tiles').innerHTML = [
        tile('TWA', fmt(Math.abs(p.twa)), `° ${side(p.twa)}`, `undamped ${fmt(Math.abs(o.twa))}° · uncorrected ${fmt(Math.abs(u.twa))}°`),
        tile('TWS', fmt(p.tws), 'kn', `undamped ${fmt(o.tws)} · uncorrected ${fmt(u.tws)} kn`),
        tile('TWD', p.twd == null ? '--' : fmt(p.twd, 0), '° T', r.lightAir ? 'light air: not published' : p.twd == null ? 'no heading' : `undamped ${fmt(o.twd, 0)}° · ${headingNote(o)}`),
        tile('STW', fmt(p.stw == null ? o.stw : p.stw, 2), 'kn', `paddlewheel ${fmt(r.input.stw, 2)} kn`),
        tile('Leeway', fmt(Math.abs(o.leeway)), `° ${side(o.leeway)}`, r.input.heel == null ? 'no heel' : `heel ${fmt(r.input.heel, 0)}°`),
        tile('Current', p.current ? fmt(p.current.drift, 2) : '--', p.current ? `kn · ${fmt(p.current.set, 0)}°` : 'kn', p.current ? `averaged over ${state.saved ? state.saved.damping.currentS : '--'} s` : 'no SOG/COG or heading')
      ].join('')
      renderFlow(live)
      renderPublished({ ...o, ...p, stw: p.stw == null ? o.stw : p.stw }, live.outputPaths || {}, live.sent || [])
    }

    const inputs = live ? Object.entries(live.inputs) : []
    $('inputs').innerHTML = inputs.length
      ? inputs.sort().map(([path, i]) => `<tr><td>${esc(path)}</td><td>${esc(i.source)}</td><td class="num ${i.ageMs > staleMs ? 'warn' : ''}">${fmt(i.ageMs / 1000)} s</td></tr>`).join('')
      : '<tr><td colspan="3" class="muted center">Nothing received yet</td></tr>'
  }

  // What the plugin has sent in the last few seconds (it reports which outputs), each with
  // its value now: the webapp holds no rules of its own about what is published.
  function renderPublished (o, paths, sent) {
    const gw = o.groundWind || {}
    const rows = [
      ['twa', 'TWA', () => `${fmt(Math.abs(o.twa))}° ${side(o.twa)}`],
      ['tws', 'TWS', () => `${fmt(o.tws)} kn`],
      ['twd', 'TWD', () => `${fmt(o.twd, 0)}° T`],
      ['hdt', 'Heading', () => `${fmt(o.heading, 0)}° T`],
      ['stw', 'STW', () => `${fmt(o.stw, 2)} kn`],
      ['leeway', 'Leeway', () => `${fmt(Math.abs(o.leeway))}° ${side(o.leeway)}`],
      ['current', 'Current', () => o.current ? `${fmt(o.current.drift, 2)} kn → ${fmt(o.current.set, 0)}°` : '--'],
      ['gws', 'Ground wind speed', () => `${fmt(gw.speed)} kn`],
      ['gwd', 'Ground wind direction', () => `${fmt(gw.direction, 0)}° T`],
      ['gwa', 'Ground wind angle', () => `${fmt(Math.abs(gw.angle))}° ${side(gw.angle)}`]
    ].filter(([key]) => sent.includes(key))
    $('published').innerHTML = rows.map(([key, label, value]) =>
      `<tr><th scope="row">${esc(label)}</th><td class="num">${esc(value())}</td><td class="mono">${esc(paths[key] || '')}</td></tr>`).join('') ||
      '<tr><td colspan="3" class="muted center">Nothing sent in the last few seconds</td></tr>'
  }

  // -- Calibration

  function renderCalibration () {
    if (!state.draft) return
    const ids = Object.keys(CORRECTIONS)
    $('corrList').innerHTML = ids.map(id => {
      const c = state.draft.corrections[id]
      const name = CORRECTIONS[id].name
      return `<li class="${id === state.selected ? 'selected' : ''}">` +
        `<button type="button" data-select="${esc(id)}" aria-pressed="${id === state.selected}">${esc(name)}</button>` +
        `<label><input type="checkbox" data-path="corrections.${esc(id)}.enabled" ${c.enabled ? 'checked' : ''} aria-label="Enable ${esc(name)}"></label></li>`
    }).join('')

    const id = state.selected
    const c = state.draft.corrections[id]
    const meta = CORRECTIONS[id]
    let body = ''
    const heelLabel = h => h > 0 ? `${h}° stbd` : h < 0 ? `${-h}° port` : '0°'
    if (id === 'stw') {
      body = grid2d('Knots added to STW', 'Heel ╲ STW kn', 'stw', c, heelLabel) +
        (mirrored(c.heel) ? `<label class="check"><input type="checkbox" id="stwSymmetric" ${state.symmetric ? 'checked' : ''}> Edit symmetrically</label>` : '')
    } else if (id === 'leeway') {
      body = `<div class="fields">${field('K', 'corrections.leeway.k', c.k, 0.01)}</div>`
    } else if (id === 'twa') {
      body = grid2d('Degrees added to |TWA| (blank = not enough data: the value to its left is used)', 'TWA ╲ TWS kn', 'twa', c, a => `${a}°`)
    } else if (id === 'tws') {
      body = grid2d('Knots added to TWS (blank = not enough data: the value to its left is used)', 'TWA ╲ TWS kn', 'tws', c, a => `${a}°`) +
        `<p id="twsExample" class="muted sub">${esc(twsExample(c))}</p>`
    }
    if (PASTE[id]) body += pasteBox(id)
    const limits = state.behaviour && LIMITS[id] ? LIMITS[id](state.behaviour, c) : []
    $('corrEditor').innerHTML =
      `<div class="panel-head"><h2>${esc(meta.name)}</h2><span class="state ${c.enabled ? 'on' : ''}">${c.enabled ? 'Enabled' : 'Disabled'}</span></div>` +
      `<p class="what muted">${esc(meta.what)}</p>${body}` +
      (limits.length ? `<div class="limits"><h3>Built-in limits</h3><ul>${limits.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>` : '') +
      `<div><button type="button" class="ghost" data-defaults="${esc(id)}">Reset to defaults</button></div>`
  }

  // Paste a whole table as text, or copy it out in the same format (tables.js).
  function pasteBox (id) {
    return '<details class="paste"><summary>Paste a table</summary>' +
      `<p class="muted sub">Pasting is how to change the rows and columns: any number of each, as fine as the data allows, each going up. ${PASTE[id].hint} Commas, tabs, semicolons or spaces between cells; blank cells allowed; rows in any order.</p>` +
      `<textarea id="paste-${esc(id)}" rows="6" spellcheck="false" aria-label="${esc(CORRECTIONS[id].name)} to paste"></textarea>` +
      `<div><button type="button" class="ghost" data-paste="${esc(id)}">Replace the table</button> ` +
      `<button type="button" class="ghost" data-copy="${esc(id)}">Copy this table</button> <span id="paste-msg-${esc(id)}" class="warn"></span></div></details>`
  }

  // A worked example of the TWS table's ramp at 10 kn of TWS, from the values being edited,
  // so it is plain that the correction blends in with TWA instead of switching on.
  function twsExample (t) {
    try {
      const kn = v => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(2)} kn`
      const at = [45, 70, 90, 120, 150, 180].map(a => `${kn(PPTables.value('tws', t, a, 10))} at ${a}°`)
      return `At 10 kn TWS, for example: ${at.join(', ')}.`
    } catch (e) {
      return ''
    }
  }

  // A table: its row and column headings (its axes, set by pasting), editable cells, and
  // blank cells allowed (null = not measured). The corner says which way round it is.
  function grid2d (title, corner, id, t, rowLabel) {
    const k = PPTables.KINDS[id]
    const cols = t[k.cols]
    const rows = t[k.rows]
    const head = `<tr><th scope="col" class="muted">${esc(corner)}</th>${cols.map(v => `<th scope="col" class="axis">${esc(v)}</th>`).join('')}</tr>`
    const body = rows.map((r, i) => `<tr><th scope="row" class="axis">${esc(rowLabel(r))}</th>` +
      t.add[i].map((v, j) => `<td><input type="number" step="any" data-nullable="1" data-path="corrections.${id}.add.${i}.${j}" value="${v == null ? '' : esc(v)}" aria-label="${esc(rowLabel(r))} at ${esc(cols[j])} kn"></td>`).join('') + '</tr>')
    return `<div><h2>${esc(title)}</h2><p class="muted sub">${rows.length} rows × ${cols.length} columns</p><div class="table-wrap"><table class="grid${cols.length > 8 ? ' dense' : ''}">${head}${body.join('')}</table></div></div>`
  }

  function field (label, path, value, step) {
    return `<label class="field">${esc(label)}<input type="number" step="${step}" data-path="${esc(path)}" value="${esc(value)}"></label>`
  }

  // -- Settings

  const MODES = [
    ['shadow', 'Shadow', 'Publish to separate …Corrected paths. Your instruments and displays carry on as before.'],
    ['replace', 'Replace', 'Publish on the standard paths. Rank this plugin first in Server → Source Priorities, and zero the instrument’s own corrections so nothing is corrected twice.']
  ]

  function renderSettings () {
    if (!state.draft) return
    $('modes').innerHTML = '<legend class="sr-only">Publish mode</legend>' + MODES.map(([id, name, desc]) =>
      `<label class="mode ${state.draft.mode === id ? 'checked' : ''}"><input type="radio" name="mode" value="${id}" data-path="mode" ${state.draft.mode === id ? 'checked' : ''}>` +
      `<div><b>${esc(name)}</b><span>${esc(desc)}</span></div></label>`).join('')
    const v = $('variation')
    if (document.activeElement !== v) v.value = state.draft.variation
    for (const k of ['trueWindS', 'twaS', 'heelS', 'stwS', 'currentS']) {
      const el = $('damp-' + k)
      if (el && document.activeElement !== el && state.draft.damping) el.value = state.draft.damping[k]
    }
    // A new default reaches a fresh install only: a saved file keeps its own values.
    const dd = state.defaults && state.defaults.damping
    $('dampingDefaults').textContent = dd ? `Defaults: true wind ${dd.trueWindS} s, TWA ${dd.twaS} s, heel ${dd.heelS} s, STW ${dd.stwS} s, current ${dd.currentS} s` : ''
    const b = state.behaviour
    $('behaviour').innerHTML = b ? [
      `<b>Light air:</b> below ${b.lightAirOffKn} kn, wind direction is noise: TWD is not published below that TWS, nor ground wind direction and angle below that ground wind speed. They come back from ${b.lightAirOnKn} kn; the gap stops them flickering. TWA, TWS and ground wind speed always go out: TWA is what you sail by.`,
      `<b>Stale inputs:</b> an input older than ${b.staleS} s is not used. Without STW or apparent wind nothing is published (the status says so, and this page greys out the last values, which Signal K keeps), unless Auto can move to another sensor; without heading, no TWD, current or ground wind; without SOG and COG, no current or ground wind; without heel, no heel correction or leeway.`,
      `<b>Loop guard:</b> another plugin's output (read only when chosen as a source) can drive no path faster than ${b.maxPublishHz} Hz. Faster updates are dropped and the status says so: it usually means a feedback loop. Sensors are never limited.`,
      '<b>Implausible input</b> is not used: apparent wind over 120 kn, STW or SOG over 60 kn, negative speeds, heel beyond ±90°, an angle beyond a full turn or variation beyond ±180° (degrees sent as radians). The status says why for wind and STW; the others count as missing.'
    ].map(t => `<li>${t}</li>`).join('') : '<li>Update the plugin to see these.</li>'
    renderSources()
  }

  function renderSources () {
    const live = state.live || {}
    // Each source with its measured rate, and whether it is another plugin's output (used
    // only if chosen): the rate is what Auto chooses by.
    const seen = key => (live.sources && live.sources[key]) || []
    const describe = (key, src) => {
      const s = seen(key).find(x => x.source === src)
      return s ? [src, hzText(s.hz), s.plugin ? 'another plugin' : null].filter(Boolean).join(' · ') : src
    }
    $('sources').innerHTML = Object.entries(SOURCE_LABELS).map(([key, label]) => {
      const chosen = state.draft.sources[key] || ''
      const opts = Array.from(new Set([...seen(key).map(x => x.source), chosen].filter(Boolean)))
      const auto = live.inUse && live.inUse[key] && !chosen ? `: ${describe(key, live.inUse[key])}` : ''
      return `<label>${esc(label)}<select data-path="sources.${key}">` +
        `<option value="">Auto (highest-rate sensor)${esc(auto)}</option>` +
        opts.map(s => `<option value="${esc(s)}" ${s === chosen ? 'selected' : ''}>${esc(describe(key, s))}${seen(key).some(x => x.source === s) ? '' : ' (not seen)'}</option>`).join('') +
        '</select></label>'
    }).join('')
  }

  // Sources arrive with live data; refresh the list unless a dropdown is in use.
  function renderSourcesIfIdle () {
    if (!state.draft || (document.activeElement && document.activeElement.tagName === 'SELECT')) return
    renderSources()
  }

  // ---- analysis (beta) ---------------------------------------------------------

  const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return localDay(d) }
  const clock = t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago` }

  async function loadAnalysis () {
    const a = state.analysis
    const since = a.range === 'all' ? '' : `?since=${daysAgo(Number(a.range))}`
    try {
      const [status, summary, recent] = await Promise.all([
        getJson('/analysis/status'),
        getJson('/analysis/summary' + since),
        getJson(`/analysis/findings?since=${daysAgo(1)}&after=${Math.floor(Date.now() / 1000) - RECENT_S}`)
      ])
      Object.assign(a, { status, summary, recent, error: '', loadedAt: Date.now() })
    } catch (e) {
      a.error = /404/.test(e.message) ? 'This version of the plugin has no analysis: update to the beta.' : `Could not load the analysis (${e.message})`
    }
    if (state.view === 'analysis') renderAnalysis()
  }

  async function analysisAction (method, path, body) {
    const a = state.analysis
    a.busy = true
    renderAnalysis()
    try {
      const res = await fetch(API + path, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      const b = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'not authorised — log in to Signal K' : (b.errors || [res.statusText]).join('; '))
      a.error = ''
    } catch (e) {
      a.error = e.message
    }
    a.busy = false
    await loadAnalysis()
  }

  function renderAnalysis () {
    const a = state.analysis
    const st = a.status
    $('anToggle').textContent = st && !st.enabled ? 'Resume' : 'Pause'
    $('anRun').disabled = $('anToggle').disabled = $('anClear').disabled = !!a.busy || !st
    $('anRange').value = a.range
    const lines = []
    if (a.error) lines.push(`<p class="warn">${esc(a.error)}</p>`)
    if (st) {
      lines.push(`<p>${st.enabled ? `Runs every ${st.everyMin} minutes` : '<span class="warn">Paused</span>'}${a.busy || st.running ? ' · <b>running now…</b>' : ''}</p>`)
      if (st.lastRunAt) {
        lines.push(`<p>Last run ${esc(ago(st.lastRunAt))} (${esc(clock(st.lastRunAt / 1000))}): read ${st.lastRows} s of sailing, ${st.lastFound} new findings.` +
          (st.readTo ? ` Read up to ${esc(clock(st.readTo / 1000))}; tacks and gybes show about 4 minutes after, a leg when it ends.` : '') + '</p>')
      } else lines.push('<p class="muted">Not run yet: the first run is a minute after the plugin starts.</p>')
      if (st.sources) {
        lines.push('<p class="muted">Reading from history: ' + Object.entries(st.sources).map(([g, src]) => `${esc(SOURCE_LABELS[g] || g)} <code>${esc(src)}</code>`).join(' · ') +
          '. The source chosen in Settings, else the sensor that has sent most since the plugin started.</p>')
      }
      if (st.lastError) lines.push(`<p class="warn">${esc(st.lastError)}</p>`)
    }
    $('anStatus').innerHTML = lines.join('') || '<p class="muted">Loading…</p>'
    renderAnalysisCounts(a.summary)
    renderAnalysisFits(a.summary)
    renderAnalysisRecent(a.recent)
  }

  const CLS_LABEL = { sailUp: 'Upwind', sailReach: 'Reaching', sailDown: 'Downwind', other: 'Other (70°–80°, turning, or an input missing)' }
  const CLS_SHORT = { sailUp: 'up', sailReach: 'reach', sailDown: 'down', other: 'other' }
  const MNV_LABEL = { tack: 'Tack', gybe: 'Gybe', comeUp: 'Rounding up', comeDown: 'Bearing away' }
  const mins = s => Math.round(s / 60)

  function renderAnalysisCounts (s) {
    if (!s) { $('anCounts').innerHTML = '<tr><td colspan="3" class="muted center">Loading…</td></tr>'; $('anEvents').textContent = ''; return }
    const sec = s.counts.seconds
    const keys = ['sailUp', 'sailReach', 'sailDown', 'other'].filter(k => sec[k]).concat(Object.keys(sec).filter(k => !CLS_LABEL[k]))
    $('anCounts').innerHTML = keys.length
      ? keys.map(k => `<tr><td>${esc(CLS_LABEL[k] || k)}</td><td class="num">${mins(sec[k].all)}</td><td class="num"><b>${mins(sec[k].compliant)}</b></td></tr>`).join('')
      : '<tr><td colspan="3" class="muted center">Nothing yet</td></tr>'
    const m = s.counts.manoeuvres; const l = s.counts.legs
    const list = Object.entries(MNV_LABEL).map(([k, name]) => `${m[k] || 0} ${name.toLowerCase()}${(m[k] || 0) === 1 || k.startsWith('come') ? '' : 's'}`)
    $('anEvents').innerHTML = `Over ${s.days} day${s.days === 1 ? '' : 's'}: ${esc(list.join(', '))}; ${l.up || 0} upwind and ${l.off || 0} off-wind legs.`
  }

  // How much a cell rests on, in its table's unit.
  const support = (unit, w) => unit === 'seconds' ? `${mins(w)} min` : unit === 'samples' ? `${mins(w * 5)} min` : `${w}`

  // A fitted table as a grid: only the rows and columns with data, each cell its median,
  // how much it rests on, and the table in use there.
  function fitGrid (kind, g, corner, rowsKey, colsKey, d) {
    const R = g[rowsKey]; const C = g[colsKey]
    const ri = R.map((_, i) => i).filter(i => g.cells[i].some(Boolean))
    const cs = C.map((_, j) => j).filter(j => ri.some(i => g.cells[i][j]))
    if (!ri.length) return '<p class="muted sub">No findings for this table yet.</p>'
    const c0 = Math.min(...cs); const c1 = Math.max(...cs)
    const cols = C.map((_, j) => j).filter(j => j >= c0 && j <= c1)
    const head = `<tr><th>${esc(corner)}</th>${cols.map(j => `<th class="num">${C[j]}</th>`).join('')}</tr>`
    const body = ri.map(i => `<tr><th class="num">${R[i]}</th>${cols.map(j => {
      const c = g.cells[i][j]
      if (!c) return '<td></td>'
      const used = g.proposed[i][j] != null
      const tip = `${support(g.unit, c.weight)} (needs ${support(g.unit, c.need)}); middle half ${fmt(c.p25, d)} to ${fmt(c.p75, d)}; table now ${c.table == null ? 'blank' : fmt(c.table, d)}`
      return `<td class="acell${used ? '' : ' thin'}" title="${esc(tip)}"><b>${fmt(c.median, d)}</b><span>${esc(support(g.unit, c.weight))} · now ${c.table == null ? '–' : fmt(c.table, d)}</span></td>`
    }).join('')}</tr>`)
    const any = g.proposed.some(r => r.some(v => v != null))
    const text = any ? PPTables.format(kind, { [rowsKey]: R, [colsKey]: C, add: g.proposed }) : ''
    return `<div class="table-wrap"><table class="agrid">${head}${body.join('')}</table></div>` +
      (any ? `<details class="paste"><summary>Proposed table, to paste into Calibration</summary><p class="muted sub">Cells with too little support are blank. Compare with boatcal on the same days before using it.</p><textarea readonly rows="6">${esc(text)}</textarea></details>` : '<p class="muted sub">Not enough yet to propose a table: faded cells need more support (hover for how much).</p>')
  }

  function renderAnalysisFits (s) {
    if (!s) { $('anFits').innerHTML = ''; return }
    const k = s.leeway
    const panel = (title, note, inner) => `<div class="panel"><h2>${esc(title)}</h2><p class="muted sub">${esc(note)}</p>${inner}</div>`
    $('anFits').innerHTML =
      '<p class="muted sub intro">Fitted from raw data in the pipeline\'s order, as boatcal does: the boat speed table and K from the GPS, then the TWA table from tacks and gybes using that boat speed table, then the TWS table from legs using both. Each cell: the median of what the data says (bold), how much it rests on, and your table now. Faded cells have too little to propose. Hover for the spread.</p>' +
      panel('1. Boat speed (STW) table', s.stw.note, fitGrid('stw', s.stw, 'heel\\stw', 'heel', 'stw', 2)) +
      panel('2. Leeway K', s.leeway.note, k.n ? `<p><b>K ${fmt(k.median, 2)}</b> from ${mins(k.n * 5)} min of upwind over ${k.days} day${k.days === 1 ? '' : 's'} (middle half ${fmt(k.p25, 2)} to ${fmt(k.p75, 2)}); now ${fmt(k.now, 2)}.${k.proposed == null ? ` Not proposed until ${k.minDays} days.` : ''}</p>` : '<p class="muted sub">No upwind sailing with a current yet.</p>') +
      panel('3. TWA table', s.twa.note, fitGrid('twa', s.twa, 'TWA\\TWS', 'twa', 'tws', 1)) +
      panel('4. TWS table', s.tws.note, fitGrid('tws', s.tws, 'TWA\\TWS', 'twa', 'tws', 2))
  }

  // Manoeuvres and legs as they are; the 5 s records summed into BLOCK_S blocks.
  function renderAnalysisRecent (fs) {
    if (!fs) { $('anRecent').innerHTML = '<tr><td colspan="7" class="muted center">Loading…</td></tr>'; return }
    const rows = []
    const blocks = new Map()
    for (const f of fs.filter(x => x.v === 3)) {
      if (f.type === 's5') {
        const b = Math.floor(f.t / BLOCK_S) * BLOCK_S
        if (!blocks.has(b)) blocks.set(b, [])
        blocks.get(b).push(f)
      } else rows.push(f)
    }
    const med = xs => { const v = xs.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null }
    const twOf = f => { const a = f.awa * Math.PI / 180; const x = f.aws * Math.cos(a) - f.stw; const y = f.aws * Math.sin(a); return [Math.atan2(y, x) * 180 / Math.PI, Math.hypot(x, y)] }
    for (const [b, list] of blocks) rows.push({ type: 'block', t: b, list })
    rows.sort((a, b) => b.t - a.t)
    if (!rows.length) { $('anRecent').innerHTML = '<tr><td colspan="7" class="muted center">Nothing in the last 2 hours</td></tr>'; return }
    const n = (v, d = 1) => typeof v === 'string' ? esc(v) : fmt(v, d)
    $('anRecent').innerHTML = rows.map(f => {
      if (f.type === 'block') {
        const ok = f.list.filter(x => x.compliant && x.awa != null)
        const by = {}
        for (const x of f.list) by[x.cls] = (by[x.cls] || 0) + x.n
        const mix = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([c, s]) => `${CLS_SHORT[c] || c} ${mins(s)}`).join(', ')
        const tw = ok.map(twOf)
        const total = f.list.reduce((a, x) => a + x.n, 0)
        const usable = ok.reduce((a, x) => a + x.good, 0)
        return `<tr class="${usable ? '' : 'off'}"><td>${esc(clock(f.t))}–${esc(clock(f.t + BLOCK_S))}</td><td>Sailing: ${esc(mix)} min</td>` +
          `<td class="num">${n(med(tw.map(x => Math.abs(x[0]))), 0)}</td><td class="num">${n(med(tw.map(x => x[1])))}</td><td class="num">${n(med(ok.map(x => x.stw)), 2)}</td><td class="num">${n(med(ok.map(x => Math.abs(x.heel))), 0)}</td>` +
          `<td class="muted sub">${mins(usable)} of ${mins(total)} min usable${ok.some(x => x.gN != null) ? '' : '; no GPS'}</td></tr>`
      }
      if (f.type === 'mnv') {
        const twa = f.before && f.after ? `${fmt(f.before.twa, 0)} → ${fmt(f.after.twa, 0)}` : null
        const note = `TWD step ${fmt(f.step, 1)}°` + (f.twaAdd != null ? ` (raw TWA ${f.twaAdd > 0 ? '+' : ''}${fmt(f.twaAdd, 1)}°)` : '')
        return `<tr><td>${esc(clock(f.t))}</td><td>${esc(MNV_LABEL[f.kind] || f.kind)}</td><td class="num">${n(twa, 0)}</td><td class="num">${n(f.before && f.before.tws)}</td><td class="num">${n(f.before && f.before.stw, 2)}</td><td class="num">${n(f.before && Math.abs(f.before.heel), 0)}</td><td class="muted sub">${esc(note)}</td></tr>`
      }
      return `<tr><td>${esc(clock(f.t))}</td><td>Leg: ${f.kind === 'up' ? 'upwind' : 'off the wind'}, ${Math.round((f.t1 - f.t) / 60)} min</td><td></td><td></td><td></td><td></td><td class="muted sub">ended ${esc(clock(f.t1))}</td></tr>`
    }).join('')
  }

  // ---- wiring ----------------------------------------------------------------

  function route () {
    const v = location.hash.replace('#', '')
    state.view = VIEWS.includes(v) ? v : 'live'
    renderAll()
    if (state.view === 'analysis') loadAnalysis()
  }

  document.addEventListener('change', onEdit)
  document.addEventListener('click', e => {
    const sel = e.target.closest('[data-select]')
    if (sel) { state.selected = sel.dataset.select; renderCalibration() }
    const paste = e.target.closest('[data-paste]')
    if (paste) {
      const id = paste.dataset.paste
      try {
        Object.assign(state.draft.corrections[id], PPTables.parse(id, $('paste-' + id).value))
        renderAll()
        $('paste-' + id).closest('details').open = true // rendered closed, with this message inside
        $('paste-msg-' + id).textContent = 'Pasted: Save to keep it.'
      } catch (err) {
        $('paste-msg-' + id).textContent = err.message
      }
    }
    const copy = e.target.closest('[data-copy]')
    if (copy) {
      const id = copy.dataset.copy
      const text = PPTables.format(id, state.draft.corrections[id])
      const done = m => { $('paste-msg-' + id).textContent = m }
      // Browsers offer navigator.clipboard over https only, and Signal K is usually plain http.
      const inBox = () => {
        const box = $('paste-' + id)
        box.value = text
        box.select()
        done(document.execCommand('copy') ? 'Copied.' : 'Copy blocked by the browser: the table is selected in the box above.')
      }
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => done('Copied.'), inBox)
      else inBox()
    }
    const reset = e.target.closest('[data-reset]')
    if (reset && state.defaults && state.draft) {
      state.draft[reset.dataset.reset] = clone(state.defaults[reset.dataset.reset])
      renderAll()
    }
    const def = e.target.closest('[data-defaults]')
    if (def && state.defaults) {
      const id = def.dataset.defaults
      state.draft.corrections[id] = clone(state.defaults.corrections[id])
      renderAll()
    }
  })
  $('save').addEventListener('click', save)
  $('revert').addEventListener('click', () => {
    state.draft = clone(state.saved)
    $('saveErrors').textContent = ''
    renderAll()
  })
  window.addEventListener('hashchange', route)
  window.addEventListener('beforeunload', e => { if (state.draft && dirty()) { e.preventDefault(); e.returnValue = '' } })

  $('anRange').addEventListener('change', e => { state.analysis.range = e.target.value; loadAnalysis() })
  $('anRun').addEventListener('click', () => analysisAction('PUT', '/analysis/run'))
  $('anClear').addEventListener('click', () => {
    if (window.confirm('Delete every finding so far? The analysis carries on from where it has read up to; what it found before is gone.')) analysisAction('PUT', '/analysis/clear')
  })
  $('anToggle').addEventListener('click', () => {
    const st = state.analysis.status
    if (st) analysisAction('PUT', '/analysis', { enabled: !st.enabled })
  })

  route()
  loadConfig()
  pollLive()
  setInterval(pollLive, LIVE_MS)
  setInterval(() => { if (state.view === 'analysis') loadAnalysis() }, ANALYSIS_MS)
})()
