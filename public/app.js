(function () {
  'use strict'

  const API = '/plugins/signalk-performance-processor'
  const LIVE_MS = 1000
  const STALE_MS = 5000

  // Fixed behaviour of each correction, written from the numbers the plugin sends (b), so
  // the description always matches the code.
  const LIMITS = {
    stw: b => [
      `Below ${b.stwFadeKn} kn the correction fades to nothing at 0 kn, so a stopped boat is not given speed by the 0 kn column.`,
      'Heel either side uses the same row, as on the H5000. More heel than the last row uses the last row; beyond the last speed column, that column is held.'
    ],
    leeway: b => [
      `Capped at ±${b.maxLeewayDeg}°.`,
      `Fades in with speed: none below ${b.leewayFadeKn[0]} kn, in full from ${b.leewayFadeKn[1]} kn, so it does not snap on as the boat gets going. K × heel ÷ STW² grows without limit as the boat slows.`,
      'Needs heel; without it leeway is 0.'
    ],
    twa: b => [
      `Rows at TWA ${b.twaRows.upwind}°, ${b.twaRows.reach}° and ${b.twaRows.downwind}°, as on the H5000: the ${b.twaRows.upwind}° row applies in full below ${b.twaRows.upwind}°, the ${b.twaRows.downwind}° row beyond ${b.twaRows.downwind}°, linear between rows and between TWS columns.`,
      `Fades out towards head to wind and dead downwind: in full from ${b.twaTaperUpDeg}° to ${180 - b.twaTaperDownDeg}° TWA, none at 0° and 180°. TWA and TWD then pass smoothly through tacks and gybes instead of TWD following the bow. Upwind the boat is inside the fade only while tacking; downwind, sailing deeper than ${180 - b.twaTaperDownDeg}° gets part of the correction.`,
      `To keep that smooth, the ${b.twaRows.upwind}° row must be within ±${b.twaTaperUpDeg}° and the ${b.twaRows.downwind}° row within ±${b.twaTaperDownDeg}°.`,
      'Beyond the first and last TWS columns, the end values are held.'
    ],
    tws: b => [
      `Ramps in with TWA, never a step: none at ${b.twsNoneBelowDeg}° TWA or less, rising in a straight line to the full correction at the down angle, and full from there to 180°, so nothing changes through a gybe.`,
      `Each down angle must be above ${b.twsNoneBelowDeg}°. The closer it is to ${b.twsNoneBelowDeg}°, the shorter and steeper the ramp.`,
      'Between TWS columns the correction and the down angle are interpolated in a straight line; beyond the first and last columns the end values are held.',
      'Never takes TWS below 0.'
    ]
  }

  // Display names and help for each correction, in pipeline order.
  const CORRECTIONS = {
    stw: { name: 'Boat speed (STW)', what: 'Knots added to the paddlewheel by heel (rows, either side) and boat speed (columns): the H5000 boat speed / heel table. Blank cells are filled from the nearest value in their row. Applied before anything else uses STW.' },
    leeway: { name: 'Leeway', what: 'Sideways slip: leeway = K × heel ÷ STW². Published, and used for current. Not used in true wind: the TWA table takes up its effect.' },
    twa: { name: 'TWA table', what: 'Degrees added to |TWA| by TWS, in rows at TWA 40°, 90° and 165°: the H5000 TWA correction table. Negative = TWA was reading too wide.' },
    tws: { name: 'TWS table', what: 'Knots added to TWS downwind, by TWS: the H5000 TWS correction. It ramps in with TWA rather than switching on: none at 90° or less, the full correction from the down angle (165° by default). Blank = no correction. The default is −10% of each column.' }
  }

  // The tables' text format (tables.js): what Paste a table reads and Copy writes.
  const PASTE = {
    stw: { parse: t => PPTables.parseStw(t), hint: 'First row <code>heel\\stw</code> then the boat speeds 0, 5 … 30; then a row for heel 0, 10 and 20, each its label then its values. This is what boatcal <code>plugincal</code> prints.' },
    twa: { parse: t => PPTables.parseTwa(t), hint: 'First row <code>TWA\\TWS</code> then the TWS columns 0, 5 … 30; then a row for TWA 40, 90 and 165, each its label then its values. This is what boatcal <code>plugincal</code> prints.' },
    tws: { parse: t => PPTables.parseTws(t), hint: 'First row <code>TWS</code> then the TWS columns 0, 5 … 30; then a <code>correction</code> row and a <code>down angle</code> row.' }
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
    selected: 'twa',
    live: null,
    liveAt: 0,
    saving: false
  }

  const $ = id => document.getElementById(id)
  const clone = o => JSON.parse(JSON.stringify(o))
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const fmt = (v, d = 1) => v == null || !Number.isFinite(v) ? '--' : v.toFixed(d)
  const dirty = () => JSON.stringify(state.saved) !== JSON.stringify(state.draft)

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
      state.liveAt = Date.now()
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
    if (!el.dataset || !el.dataset.path || !state.draft) return
    let value
    if (el.type === 'checkbox') value = el.checked
    else if (el.type === 'number') {
      // A blank cell in a table that allows it means "not measured"; elsewhere keep the
      // old value until something is typed.
      if (el.value === '') { if (!el.dataset.nullable) return; value = null } else value = Number(el.value)
    } else value = el.value
    setPath(el.dataset.path, value)
    renderSaveBar()
    if (el.dataset.path.startsWith('corrections.tws.') && $('twsExample')) $('twsExample').textContent = twsExample(state.draft.corrections.tws)
    if (el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT') renderAll()
  }

  // ---- rendering -----------------------------------------------------------

  function renderAll () {
    renderHeader()
    renderSaveBar()
    for (const v of ['live', 'calibration', 'settings']) $('view-' + v).hidden = v !== state.view
    document.querySelectorAll('nav a').forEach(a => a.classList.toggle('current', a.dataset.view === state.view))
    if (state.view === 'live') renderLive()
    if (state.view === 'calibration') renderCalibration()
    if (state.view === 'settings') renderSettings()
  }

  function renderHeader () {
    $('cfgError').textContent = state.configError || ''
    $('cfgError').hidden = !state.configError
    const mode = state.saved ? state.saved.mode : null
    const badge = $('mode')
    badge.textContent = mode === 'replace' ? 'Replace' : mode === 'shadow' ? 'Shadow' : '--'
    badge.classList.toggle('replace', mode === 'replace')
    $('status').textContent = state.live ? (state.live.running ? state.live.status : 'Plugin not running') : ''
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
    const on = id => !!(state.saved && state.saved.corrections[id] && state.saved.corrections[id].enabled)
    const step = id => r.steps.find(s => s.id === id) || {}
    const side = v => v < 0 ? 'port' : 'stbd'
    const angle = v => `${fmt(Math.abs(v))}° ${side(v)}`
    const change = (v, d) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d)
    const damping = s => ({ label: 'Damping', value: s ? `${s} s` : 'none', cls: 'damp' })
    const before = trueWind(i, o.stw)
    const held = r.lightAir
    // Inputs: from a sensor, or made by another chain.
    const sensor = (label, value, note) => ({ label, value, note, cls: 'sensor' })
    const from = (label, value, chain) => ({ label, value, note: `from ${chain}`, cls: 'from' })
    const missing = (label, note) => ({ label, value: 'none', note, cls: 'off' })
    // A correction step: off, skipped (and why), or what it did.
    const corr = (id, label, value, note) => {
      const s = step(id)
      if (!s.enabled) return { label, value: 'off', note: 'passes the value through', cls: 'off' }
      if (s.skipped) return { label, value: '--', note: s.skipped, cls: 'off' }
      return { label, value, note }
    }
    const notSent = why => ({ lines: ['not sent'], note: why, cls: 'off' })

    const heel = i.heel == null ? missing('Heel', 'upright row, no leeway') : sensor('Heel', `${fmt(Math.abs(i.heel), 0)}° ${side(i.heel)}`, `damped ${dm.heelS} s`)
    const heading = o.heading == null ? missing('Heading', 'no TWD, current or ground wind') : sensor('Heading', `${fmt(o.heading, 0)}° T`, `${headingNote(o)}, damped ${dm.headingS} s`)
    const stw = from('STW', `${fmt(o.stw, 2)} kn`, 'boat speed')
    const twdNote = 'damped TWD − heading'

    return [
      {
        name: 'Boat speed',
        inputs: [sensor('Paddlewheel', `${fmt(i.stw, 2)} kn`, 'raw'), heel],
        steps: [corr('stw', 'STW table', `${change(o.stw - i.stw, 2)} kn`, i.heel == null ? 'upright row' : `at ${fmt(Math.abs(i.heel), 0)}° heel`), damping(dm.stwS)],
        out: on('stw') && p.stw != null ? { lines: [`STW ${fmt(p.stw, 2)} kn`] } : notSent('STW table off: the paddlewheel is used as it is')
      },
      {
        name: 'Leeway',
        inputs: [heel, stw],
        steps: [corr('leeway', 'K × heel ÷ STW²', angle(o.leeway), `K ${state.saved ? state.saved.corrections.leeway.k : ''}`)],
        out: on('leeway') ? { lines: [`Leeway ${angle(o.leeway)}`], note: 'undamped' } : notSent('leeway off: 0°')
      },
      {
        name: 'True wind',
        inputs: [sensor('Apparent wind', angle(i.awa), `${fmt(i.aws)} kn`), stw],
        steps: [
          { label: 'Apparent − boat', value: `${fmt(Math.abs(before.twa))}° · ${fmt(before.tws)} kn`, note: 'STW along the heading, no leeway' },
          // The tables' own account, including how much of the row applies where they
          // blend in or fade out.
          corr('twa', 'TWA table', `${fmt(Math.abs(o.twa))}°`, step('twa').detail),
          corr('tws', 'TWS table', `${fmt(o.tws)} kn`, step('tws').detail),
          damping(dm.trueWindS)
        ],
        out: { lines: [`TWS ${fmt(p.tws)} kn`], note: o.twd == null ? null : 'TWA goes on to direction' }
      },
      {
        name: 'Direction',
        inputs: [from('TWA', `${fmt(Math.abs(o.twa))}°`, 'true wind'), heading],
        steps: o.twd == null
          ? [{ label: 'No TWD', value: '--', note: 'TWA damped on its own', cls: 'off' }, damping(dm.trueWindS)]
          : [{ label: 'Heading + TWA', value: `${fmt(o.twd, 0)}° T` }, damping(dm.trueWindS), { label: 'TWD − heading', value: 'TWA', note: 'answers the helm at once' }],
        out: held
          ? { lines: ['TWA and TWD held'], note: 'light air', cls: 'off' }
          : { lines: [o.twd == null ? `TWA ${angle(p.twa)}` : `TWD ${fmt(p.twd, 0)}° T`, ...(o.twd == null ? [] : [`TWA ${angle(p.twa)}`])], note: o.twd == null ? null : `TWA = ${twdNote}` }
      },
      {
        name: 'Current',
        inputs: [i.sog == null || i.cog == null ? missing('SOG, COG', 'no current') : sensor('SOG, COG', `${fmt(i.sog, 2)} kn · ${fmt(i.cog, 0)}°`), heading, stw, from('Leeway', angle(o.leeway), 'leeway')],
        steps: o.current
          ? [{ label: 'Ground − water', value: `${fmt(o.current.drift, 2)} kn → ${fmt(o.current.set, 0)}°`, note: 'water: STW along heading + leeway' }, damping(dm.currentS)]
          : [{ label: 'Ground − water', value: '--', note: 'needs heading, SOG and COG', cls: 'off' }],
        out: p.current ? { lines: [`${fmt(p.current.drift, 2)} kn → ${fmt(p.current.set, 0)}°`], note: 'a trend: average it over a beat' } : notSent('no heading or GPS')
      },
      {
        name: 'Ground wind',
        inputs: o.groundWind
          ? [from('TWD', `${fmt(o.twd, 0)}°`, 'direction'), from('TWS', `${fmt(o.tws)} kn`, 'true wind'), from('Current', `${fmt(o.current.drift, 2)} kn`, 'current')]
          : [missing('Current', 'needs heading, SOG and COG')],
        steps: o.groundWind
          ? [{ label: 'True wind + current', value: `${fmt(o.groundWind.direction, 0)}° · ${fmt(o.groundWind.speed)} kn` }, damping(dm.trueWindS)]
          : [],
        out: !p.groundWind ? notSent('no current')
          : held ? { lines: [`${fmt(p.groundWind.speed)} kn`], note: 'direction and angle held: light air' }
            : { lines: [`${fmt(p.groundWind.direction, 0)}° T · ${fmt(p.groundWind.speed)} kn`, `angle ${angle(p.groundWind.angle)}`] }
      }
    ]
  }

  function renderFlow (live) {
    // Every box is the same size, so nothing moves as the values change: a long note is cut
    // to two lines, with the whole of it on hover.
    const chip = c => `<div class="fchip ${c.cls || ''}"${c.note ? ` title="${esc(c.note)}"` : ''}><div class="l">${esc(c.label)}</div>` +
      `<div class="v">${esc(c.value || '')}</div>` + (c.note ? `<div class="n">${esc(c.note)}</div>` : '') + '</div>'
    $('flow').innerHTML = flowChains(live).map(ch =>
      `<div class="chain"><div class="cname">${esc(ch.name)}</div>` +
      `<div class="cin">${ch.inputs.map(chip).join('')}</div>` +
      `<div class="csteps"><span class="arrow">→</span>${ch.steps.map(chip).join('<span class="arrow">→</span>')}<span class="tail"></span></div>` +
      `<div class="cout"><div class="obox ${ch.out.cls || ''}">${ch.out.lines.map(esc).join('<br>')}` +
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
    const old = !r || live.ageMs > STALE_MS
    $('liveAge').textContent = r ? (old ? `last update ${Math.round(live.ageMs / 1000)} s ago` : '') : ''

    if (!r) {
      $('tiles').innerHTML = ''
      $('flow').innerHTML = `<p class="muted center">${esc(live ? live.status || 'Waiting for data…' : 'Waiting for data…')}</p>`
      $('steps').innerHTML = `<tr><td colspan="5" class="muted center">${esc(live ? live.status || 'Waiting for data…' : 'Waiting for data…')}</td></tr>`
    } else {
      const o = r.out
      const p = r.published || o // what is sent: damped
      const u = trueWind(r.input, r.input.stw)
      const side = v => v < 0 ? 'port' : 'stbd'
      $('tiles').innerHTML = [
        tile('TWA', fmt(Math.abs(p.twa)), `° ${side(p.twa)}`, `undamped ${fmt(Math.abs(o.twa))}° · uncorrected ${fmt(Math.abs(u.twa))}°`),
        tile('TWS', fmt(p.tws), 'kn', `undamped ${fmt(o.tws)} · uncorrected ${fmt(u.tws)} kn`),
        tile('TWD', p.twd == null ? '--' : fmt(p.twd, 0), '° T', r.lightAir ? 'light air: not published' : p.twd == null ? 'no heading' : `undamped ${fmt(o.twd, 0)}° · ${headingNote(o)}`),
        tile('STW', fmt(p.stw == null ? o.stw : p.stw, 2), 'kn', `paddlewheel ${fmt(r.input.stw, 2)} kn`),
        tile('Leeway', fmt(Math.abs(o.leeway)), `° ${side(o.leeway)}`, r.input.heel == null ? 'no heel' : `heel ${fmt(r.input.heel, 0)}°`),
        tile('Current', p.current ? fmt(p.current.drift, 2) : '--', p.current ? `kn · ${fmt(p.current.set, 0)}°` : 'kn', p.current ? 'a trend: average it over a beat' : 'no SOG/COG or heading')
      ].join('')
      renderFlow(live)
      // A step's result is published only if no later enabled step replaces it; otherwise
      // it is a working value that only feeds the steps after it.
      const last = {}
      r.steps.forEach((s, i) => { if (s.enabled && !s.skipped) (s.produces || []).forEach(q => { last[q] = i }) })
      const NAMES = { stw: 'STW', leeway: 'Leeway', twa: 'TWA', tws: 'TWS', current: 'Current' }
      $('steps').innerHTML = r.steps.map((s, i) => {
        if (!s.enabled) return `<tr class="off"><th scope="row">${esc(s.name)}</th><td></td><td>off</td><td></td><td></td></tr>`
        const sent = (s.produces || []).filter(q => last[q] === i)
        const working = (s.produces || []).filter(q => last[q] !== i)
        const tag = s.skipped ? '' : [
          sent.length ? `<span class="chip pub">Published: ${sent.map(q => NAMES[q]).join(', ')}</span>` : '',
          working.length ? `<span class="chip work">Working: ${working.map(q => NAMES[q]).join(', ')}</span>` : ''
        ].join(' ')
        return `<tr class="${sent.length ? '' : 'working'}"><th scope="row">${esc(s.name)}</th><td class="mono">${esc(s.input || '')}</td>` +
          `<td>${esc(s.skipped ? 'skipped — ' + s.skipped : s.detail || '')}</td><td class="mono result">${esc(s.output || '')}</td><td>${tag}</td></tr>`
      }).join('')
      renderPublished({ ...o, ...p, stw: p.stw == null ? o.stw : p.stw }, live.outputPaths || {}, r.lightAir)
    }

    const inputs = live ? Object.entries(live.inputs) : []
    $('inputs').innerHTML = inputs.length
      ? inputs.sort().map(([path, i]) => `<tr><td>${esc(path)}</td><td>${esc(i.source)}</td><td class="num ${i.ageMs > STALE_MS ? 'warn' : ''}">${fmt(i.ageMs / 1000)} s</td></tr>`).join('')
      : '<tr><td colspan="3" class="muted center">Nothing received yet</td></tr>'
  }

  // The values the plugin actually sends, one per path, matching what index.js publishes.
  function renderPublished (o, paths, lightAir) {
    const on = id => !!(state.saved && state.saved.corrections[id] && state.saved.corrections[id].enabled)
    const side = v => v < 0 ? 'port' : 'stbd'
    const held = 'not sent: light air'
    const rows = [
      ['TWA', lightAir ? held : `${fmt(Math.abs(o.twa))}° ${side(o.twa)}`, paths.twa],
      ['TWS', `${fmt(o.tws)} kn`, paths.tws]
    ]
    if (o.twd != null) rows.push(['TWD', lightAir ? held : `${fmt(o.twd, 0)}° T`, paths.twd])
    if (on('stw')) rows.push(['STW', `${fmt(o.stw, 2)} kn`, paths.stw])
    if (on('leeway')) rows.push(['Leeway', `${fmt(Math.abs(o.leeway))}° ${side(o.leeway)}`, paths.leeway])
    if (o.current) rows.push(['Current', `${fmt(o.current.drift, 2)} kn → ${fmt(o.current.set, 0)}°`, paths.current])
    if (o.groundWind) {
      rows.push(['Ground wind speed', `${fmt(o.groundWind.speed)} kn`, paths.gws])
      rows.push(['Ground wind direction', lightAir ? held : `${fmt(o.groundWind.direction, 0)}° T`, paths.gwd])
      rows.push(['Ground wind angle', lightAir ? held : `${fmt(Math.abs(o.groundWind.angle))}° ${side(o.groundWind.angle)}`, paths.gwa])
    }
    $('published').innerHTML = rows.map(([label, value, p]) =>
      `<tr><th scope="row">${esc(label)}</th><td class="num">${esc(value)}</td><td class="mono">${esc(p || '')}</td></tr>`).join('')
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
    if (id === 'stw') {
      body = grid2d('Knots added to STW', 'Heel ╲ STW kn', 'corrections.stw', c)
    } else if (id === 'leeway') {
      body = `<div class="fields">${field('K', 'corrections.leeway.k', c.k, 0.01)}</div>`
    } else if (id === 'twa') {
      const rows = [['40° TWA', 'upwind', true], ['90° TWA', 'reach', true], ['165° TWA', 'downwind', true]]
      body = grid('Degrees added to |TWA| (blank = not enough data: nearest measured value used)', 'TWS kn', 'corrections.twa', 'tws', rows, c)
    } else if (id === 'tws') {
      const rows = [['Correction kn', 'correction', true], ['Down angle °', 'downAngle', false]]
      body = grid('Knots added to TWS (blank = none), and the down angle: the TWA it applies in full from', 'TWS kn', 'corrections.tws', 'tws', rows, c) +
        `<p id="twsExample" class="muted sub">${esc(twsExample(c))}</p>`
    }
    if (PASTE[id]) body += pasteBox(id)
    const limits = state.behaviour && LIMITS[id] ? LIMITS[id](state.behaviour) : []
    $('corrEditor').innerHTML =
      `<div class="panel-head"><h2>${esc(meta.name)}</h2><span class="state ${c.enabled ? 'on' : ''}">${c.enabled ? 'Enabled' : 'Disabled'}</span></div>` +
      `<p class="what muted">${esc(meta.what)}</p>${body}` +
      (limits.length ? `<div class="limits"><h3>Built-in limits</h3><ul>${limits.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>` : '') +
      `<div><button type="button" class="ghost" data-defaults="${esc(id)}">Reset to defaults</button></div>`
  }

  // A table whose header row is its fixed axis (the breakpoints, shown as labels) and
  // whose other rows are the editable correction values. rows: [label, key, blanks allowed].
  function grid (title, axisLabel, base, axisKey, rows, obj) {
    const axis = obj[axisKey]
    const cell = (path, v, name, nullable) => `<td><input type="number" step="any"${nullable ? ' data-nullable="1"' : ''} data-path="${esc(path)}" value="${v == null ? '' : esc(v)}" aria-label="${esc(name)}"></td>`
    return `<div><h2>${esc(title)}</h2><div class="table-wrap"><table class="grid">` +
      `<tr><th scope="row" class="muted">${esc(axisLabel)}</th>${axis.map(v => `<th scope="col" class="axis">${esc(v)}</th>`).join('')}</tr>` +
      rows.map(([label, key, nullable]) => `<tr><th scope="row">${esc(label)}</th>${obj[key].map((v, i) => cell(`${base}.${key}.${i}`, v, `${label} at ${axis[i]}`, nullable)).join('')}</tr>`).join('') +
      '</table></div></div>'
  }

  // Paste a whole table as text, or copy it out in the same format (tables.js).
  function pasteBox (id) {
    return `<details class="paste"><summary>Paste a table</summary>` +
      `<p class="muted sub">${PASTE[id].hint} Commas, tabs, semicolons or spaces between cells; blank cells allowed where the table allows them.</p>` +
      `<textarea id="paste-${esc(id)}" rows="6" spellcheck="false" aria-label="${esc(CORRECTIONS[id].name)} to paste"></textarea>` +
      `<div><button type="button" class="ghost" data-paste="${esc(id)}">Replace the table</button> ` +
      `<button type="button" class="ghost" data-copy="${esc(id)}">Copy this table</button> <span id="paste-msg-${esc(id)}" class="warn"></span></div></details>`
  }

  // A worked example of the TWS table's ramp, from the values being edited, so it is plain
  // that the correction blends in with TWA instead of switching on. Uses the column nearest
  // 10 kn that has a correction.
  function twsExample (t) {
    const cols = t.tws.map((v, j) => ({ v, kn: t.correction[j], down: t.downAngle[j] })).filter(c => c.kn)
    if (!cols.length) return 'No correction in any column: TWS is not changed.'
    const c = cols.reduce((a, b) => Math.abs(b.v - 10) < Math.abs(a.v - 10) ? b : a)
    const none = state.behaviour ? state.behaviour.twsNoneBelowDeg : 90
    const kn = v => `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} kn`
    return `For example, at ${c.v} kn TWS: nothing at ${none}° TWA or less, ${kn(c.kn / 2)} at ${fmt((none + c.down) / 2, 0)}°, ` +
      `the full ${kn(c.kn)} from ${c.down}° to 180°, rising in a straight line between.`
  }

  // A two-dimensional table: fixed row and column headings, editable cells, and blank
  // cells allowed (null = not measured). Heel rows are either side, as on the H5000.
  function grid2d (title, corner, base, t) {
    const head = `<tr><th scope="col" class="muted">${esc(corner)}</th>${t.stw.map(v => `<th scope="col" class="axis">${esc(v)}</th>`).join('')}</tr>`
    const rows = t.heel.map((h, i) => `<tr><th scope="row" class="axis">${esc(h)}°</th>` +
      t.add[i].map((v, j) => `<td><input type="number" step="any" data-nullable="1" data-path="${base}.add.${i}.${j}" value="${v == null ? '' : esc(v)}" aria-label="heel ${esc(h)} at ${esc(t.stw[j])} kn"></td>`).join('') + '</tr>')
    return `<div><h2>${esc(title)}</h2><div class="table-wrap"><table class="grid">${head}${rows.join('')}</table></div></div>`
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
    for (const k of ['trueWindS', 'headingS', 'heelS', 'stwS', 'currentS']) {
      const el = $('damp-' + k)
      if (el && document.activeElement !== el && state.draft.damping) el.value = state.draft.damping[k]
    }
    const b = state.behaviour
    $('behaviour').innerHTML = b ? [
      `<b>Light air:</b> below ${b.lightAirOffKn} kn of TWS, wind direction is noise, so TWA, TWD and the ground wind direction and angle are not published (TWS and ground wind speed still are). They come back once TWS reaches ${b.lightAirOnKn} kn; the gap stops them flickering on and off.`,
      `<b>Stale inputs:</b> an input older than ${b.staleS} s is not used. Without STW or apparent wind nothing is published; without heading, no TWD, current or ground wind; without SOG and COG, no current or ground wind; without heel, no heel correction or leeway.`,
      `<b>Rate limit:</b> no path is published more often than ${b.maxPublishHz} Hz. Faster updates are dropped and the status says so; that usually means a feedback loop with another plugin.`,
      '<b>Implausible input</b> (apparent wind over 120 kn, STW over 60 kn, heel beyond ±90°, or negative speeds) is not used, and the status says why.'
    ].map(t => `<li>${t}</li>`).join('') : '<li>Update the plugin to see these.</li>'
    renderSources()
  }

  function renderSources () {
    const seen = (state.live && state.live.sourcesSeen) || {}
    $('sources').innerHTML = Object.entries(SOURCE_LABELS).map(([key, label]) => {
      const chosen = state.draft.sources[key] || ''
      const opts = Array.from(new Set([...(seen[key] || []), chosen].filter(Boolean)))
      return `<label>${esc(label)}<select data-path="sources.${key}">` +
        `<option value="">${key === 'stw' ? 'Auto (sensors only)' : 'Any'}</option>` +
        opts.map(s => `<option value="${esc(s)}" ${s === chosen ? 'selected' : ''}>${esc(s)}${(seen[key] || []).includes(s) ? '' : ' (not seen)'}</option>`).join('') +
        '</select></label>'
    }).join('')
  }

  // Sources arrive with live data; refresh the list unless a dropdown is in use.
  function renderSourcesIfIdle () {
    if (!state.draft || (document.activeElement && document.activeElement.tagName === 'SELECT')) return
    renderSources()
  }

  // ---- wiring ----------------------------------------------------------------

  function route () {
    const v = location.hash.replace('#', '')
    state.view = ['live', 'calibration', 'settings'].includes(v) ? v : 'live'
    renderAll()
  }

  document.addEventListener('change', onEdit)
  document.addEventListener('click', e => {
    const sel = e.target.closest('[data-select]')
    if (sel) { state.selected = sel.dataset.select; renderCalibration() }
    const paste = e.target.closest('[data-paste]')
    if (paste) {
      const id = paste.dataset.paste
      try {
        Object.assign(state.draft.corrections[id], PASTE[id].parse($('paste-' + id).value))
        renderAll()
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
      navigator.clipboard.writeText(text).then(() => done('Copied.'), () => { $('paste-' + id).value = text; done('Copy blocked by the browser: the table is in the box above.') })
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

  route()
  loadConfig()
  pollLive()
  setInterval(pollLive, LIVE_MS)
})()
