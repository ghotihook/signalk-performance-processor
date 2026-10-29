(function () {
  'use strict'

  const API = '/plugins/signalk-performance-processor'
  const LIVE_MS = 1000
  const STALE_MS = 5000

  // Display names and help for each correction, in pipeline order. A correction the
  // plugin knows but this list does not still shows, under its id.
  // Fixed behaviour of each correction, written from the numbers the plugin sends (b), so
  // the description always matches the code. c is the correction's current settings.
  const LIMITS = {
    stw: (b, c) => [
      `Below ${c.stw[0]} kn (the first speed column) the correction tapers to zero at 0 kn, so a stopped boat is not given speed.`,
      'Beyond the first and last heel rows and the last speed column, the edge values are held.'
    ],
    leeway: b => [
      `Capped at ±${b.maxLeewayDeg}°.`,
      `Fades in with speed: none below ${b.leewayFadeKn[0]} kn, in full from ${b.leewayFadeKn[1]} kn, so it does not snap on as the boat gets going. K × heel ÷ STW² grows without limit as the boat slows.`,
      'Needs heel; without it leeway is 0.'
    ],
    twa: b => [
      `Fades out towards head to wind and dead downwind: in full from ${b.twaTaperUpDeg}° to ${180 - b.twaTaperDownDeg}° TWA, none at 0° and 180°. TWA and TWD then pass smoothly through tacks and gybes instead of TWD following the bow. Upwind the boat is inside the fade only while tacking; downwind, sailing deeper than ${180 - b.twaTaperDownDeg}° gets part of the correction.`,
      `To keep that smooth, upwind values must be within ±${b.twaTaperUpDeg}° and downwind values within ±${b.twaTaperDownDeg}°, and the row angles between ${b.twaTaperUpDeg}° and ${180 - b.twaTaperDownDeg}°.`,
      'Beyond the first and last TWS columns, the end values are held.'
    ],
    tws: () => [
      'Never takes TWS below 0. Beyond the first and last TWS columns, the end values are held.'
    ]
  }

  const CORRECTIONS = {
    stw: { name: 'Boat speed (STW)', what: 'Knots added to the paddlewheel by heel (rows, + = starboard side down) and speed (columns), like the H5000 boat speed / heel table. Blank cells are filled from the nearest value in their row. Applied before anything else uses STW.' },
    leeway: { name: 'Leeway', what: 'Sideways slip: leeway = K × heel ÷ STW². Turns the boat’s velocity to leeward for true wind and current.' },
    twa: { name: 'TWA table', what: 'Degrees added to |TWA| by TWS, upwind, reaching and downwind, H5000 style. Negative = TWA was reading too wide. Rows blend by TWA at the angles below.' },
    tws: { name: 'TWS table', what: 'Knots added to TWS by TWS, upwind, reaching and downwind, H5000 style. Blended at the TWA table’s angles. Blank = no correction. The default downwind row is −10% of each column.' }
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

  // True wind straight from the inputs, with no corrections, for comparison.
  function uncorrected (input) {
    const a = input.awa * Math.PI / 180
    const x = input.aws * Math.cos(a) - input.stw
    const y = input.aws * Math.sin(a)
    return { twa: Math.atan2(y, x) * 180 / Math.PI, tws: Math.hypot(x, y) }
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
      $('steps').innerHTML = `<tr><td colspan="5" class="muted center">${esc(live ? live.status || 'Waiting for data…' : 'Waiting for data…')}</td></tr>`
    } else {
      const o = r.out
      const u = uncorrected(r.input)
      const side = v => v < 0 ? 'port' : 'stbd'
      $('tiles').innerHTML = [
        tile('TWA', fmt(Math.abs(o.twa)), `° ${side(o.twa)}`, `uncorrected ${fmt(Math.abs(u.twa))}°`),
        tile('TWS', fmt(o.tws), 'kn', `uncorrected ${fmt(u.tws)} kn`),
        tile('TWD', o.twd == null ? '--' : fmt(o.twd, 0), '° T', r.lightAir ? 'light air: not published' : o.twd == null ? 'no heading' : headingNote(o)),
        tile('STW', fmt(o.stw, 2), 'kn', `paddlewheel ${fmt(r.input.stw, 2)} kn`),
        tile('Leeway', fmt(Math.abs(o.leeway)), `° ${side(o.leeway)}`, r.input.heel == null ? 'no heel' : `heel ${fmt(r.input.heel, 0)}°`),
        tile('Current', o.current ? fmt(o.current.drift, 2) : '--', o.current ? `kn · ${fmt(o.current.set, 0)}°` : 'kn', o.current ? '' : 'no SOG/COG or heading')
      ].join('')
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
      renderPublished(o, live.outputPaths || {}, r.lightAir)
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
    $('published').innerHTML = rows.map(([label, value, p]) =>
      `<tr><th scope="row">${esc(label)}</th><td class="num">${esc(value)}</td><td class="mono">${esc(p || '')}</td></tr>`).join('')
  }

  // -- Calibration

  function correctionIds () {
    const known = Object.keys(CORRECTIONS)
    const all = Object.keys(state.draft.corrections)
    return known.filter(id => all.includes(id)).concat(all.filter(id => !known.includes(id)))
  }

  function renderCalibration () {
    if (!state.draft) return
    const ids = correctionIds()
    if (!ids.includes(state.selected)) state.selected = ids[0]
    $('corrList').innerHTML = ids.map(id => {
      const c = state.draft.corrections[id]
      const name = (CORRECTIONS[id] || {}).name || id
      return `<li class="${id === state.selected ? 'selected' : ''}">` +
        `<button type="button" data-select="${esc(id)}" aria-pressed="${id === state.selected}">${esc(name)}</button>` +
        `<label><input type="checkbox" data-path="corrections.${esc(id)}.enabled" ${c.enabled ? 'checked' : ''} aria-label="Enable ${esc(name)}"></label></li>`
    }).join('')

    const id = state.selected
    const c = state.draft.corrections[id]
    const meta = CORRECTIONS[id] || { name: id, what: '' }
    let body = ''
    if (id === 'stw') {
      body = grid2d('Knots added to STW', 'Heel ° ╲ STW kn', 'corrections.stw', c) +
        `<details class="paste"><summary>Paste a table</summary>` +
        `<p class="muted sub">Same format as signalk-stw-heel-correction: first row <code>heel\\stw</code> then the speeds; each further row a heel angle then its corrections. Commas, tabs or semicolons; blank cells allowed.</p>` +
        `<textarea id="pasteStw" rows="8" spellcheck="false" aria-label="Heel by STW table to paste"></textarea>` +
        `<div><button type="button" class="ghost" id="pasteStwGo">Replace the table</button> <span id="pasteStwMsg" class="warn"></span></div></details>`
    } else if (id === 'leeway') {
      body = `<div class="fields">${field('K', 'corrections.leeway.k', c.k, 0.01)}</div>`
    } else if (id === 'twa' || id === 'tws') {
      const rows = [['Upwind', 'upwind'], ['Reach', 'reach'], ['Downwind', 'downwind']]
      body = grid(id === 'twa' ? 'Degrees added to |TWA| (blank = not enough data: nearest measured value used)' : 'Knots added to TWS (blank = no correction)', 'TWS kn', `corrections.${id}`, 'tws', rows, c, true)
      if (id === 'twa') {
        const a = c.angles
        body += `<div class="fields">${field('Upwind row to (° TWA)', 'corrections.twa.angles.upwind', a.upwind, 1)}` +
          `${field('Reach row at (° TWA)', 'corrections.twa.angles.reach', a.reach, 1)}` +
          `${field('Downwind row from (° TWA)', 'corrections.twa.angles.downwind', a.downwind, 1)}</div>`
      }
    }
    const limits = state.behaviour && LIMITS[id] ? LIMITS[id](state.behaviour, c) : []
    $('corrEditor').innerHTML =
      `<div class="panel-head"><h2>${esc(meta.name)}</h2><span class="state ${c.enabled ? 'on' : ''}">${c.enabled ? 'Enabled' : 'Disabled'}</span></div>` +
      `<p class="what muted">${esc(meta.what)}</p>${body}` +
      (limits.length ? `<div class="limits"><h3>Built-in limits</h3><ul>${limits.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>` : '') +
      `<div><button type="button" class="ghost" data-defaults="${esc(id)}">Reset to defaults</button></div>`
  }

  // A table whose header row is its fixed axis (the breakpoints, shown as labels) and
  // whose other rows are the editable correction values.
  function grid (title, axisLabel, base, axisKey, rows, obj, nullable) {
    const axis = obj[axisKey]
    const cell = (path, v, name) => `<td><input type="number" step="any"${nullable ? ' data-nullable="1"' : ''} data-path="${esc(path)}" value="${v == null ? '' : esc(v)}" aria-label="${esc(name)}"></td>`
    return `<div><h2>${esc(title)}</h2><div class="table-wrap"><table class="grid">` +
      `<tr><th scope="row" class="muted">${esc(axisLabel)}</th>${axis.map(v => `<th scope="col" class="axis">${esc(v)}</th>`).join('')}</tr>` +
      rows.map(([label, key]) => `<tr><th scope="row">${esc(label)}</th>${obj[key].map((v, i) => cell(`${base}.${key}.${i}`, v, `${label} at ${axis[i]}`)).join('')}</tr>`).join('') +
      '</table></div></div>'
  }

  // A two-dimensional table: fixed row and column headings, editable cells, and blank
  // cells allowed (null = not measured).
  function grid2d (title, corner, base, t) {
    const head = `<tr><th scope="col" class="muted">${esc(corner)}</th>${t.stw.map(v => `<th scope="col" class="axis">${esc(v)}</th>`).join('')}</tr>`
    const rows = t.heel.map((h, i) => `<tr><th scope="row" class="axis">${esc(h)}</th>` +
      t.add[i].map((v, j) => `<td><input type="number" step="any" data-nullable="1" data-path="${base}.add.${i}.${j}" value="${v == null ? '' : esc(v)}" aria-label="heel ${esc(h)} at ${esc(t.stw[j])} kn"></td>`).join('') + '</tr>')
    return `<div><h2>${esc(title)}</h2><div class="table-wrap"><table class="grid">${head}${rows.join('')}</table></div></div>`
  }

  // Read a pasted heel x STW table: header row of speeds, then a heel angle and its
  // corrections per row. Tolerates the usual spreadsheet damage.
  function parseStwTable (text) {
    const clean = c => c.trim().replace(/^"(.*)"$/, '$1').replace(/\u2212/g, '-').replace(/\u00b0/g, '').trim()
    const lines = text.replace(/^\ufeff/, '').trim().split(/\r?\n/).filter(l => l.trim())
    if (lines.length < 2) throw new Error('needs a header row of speeds and at least one heel row')
    const sep = lines[0].includes(',') ? ',' : lines[0].includes('\t') ? '\t' : ';'
    const rows = lines.map(l => l.split(sep).map(clean))
    const num = (c, what) => { const n = Number(c); if (c === '' || !Number.isFinite(n)) throw new Error(`${what} is not a number: "${c}"`); return n }
    let stw = rows[0].slice(1).map((c, j) => num(c, `speed ${j + 1} in the header`))
    let heel = []; let add = []
    rows.slice(1).forEach((r, i) => {
      if (r.length - 1 !== stw.length) throw new Error(`row ${i + 2} has ${r.length - 1} values, the header has ${stw.length} speeds`)
      heel.push(num(r[0], `heel in row ${i + 2}`))
      add.push(r.slice(1).map((c, j) => c === '' ? null : num(c, `value at heel ${r[0]}, ${stw[j]} kn`)))
    })
    if (stw.length > 1 && stw[0] > stw[stw.length - 1]) { stw = stw.reverse(); add = add.map(r => r.reverse()) }
    if (heel.length > 1 && heel[0] > heel[heel.length - 1]) { heel = heel.reverse(); add = add.reverse() }
    return { heel, stw, add }
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
    const b = state.behaviour
    $('behaviour').innerHTML = b ? [
      `<b>Light air:</b> below ${b.lightAirOffKn} kn of TWS, wind direction is noise, so TWA and TWD are not published (TWS still is). They come back once TWS reaches ${b.lightAirOnKn} kn; the gap stops them flickering on and off.`,
      `<b>Stale inputs:</b> an input older than ${b.staleS} s is not used. Without STW or apparent wind nothing is published; without heading, no TWD or current; without heel, no heel correction or leeway.`,
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
    if (e.target.id === 'pasteStwGo') {
      try {
        const t = parseStwTable($('pasteStw').value)
        Object.assign(state.draft.corrections.stw, t)
        renderAll()
      } catch (err) {
        $('pasteStwMsg').textContent = err.message
      }
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
