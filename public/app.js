(function () {
  'use strict'

  const API = '/plugins/signalk-performance-processor'
  const LIVE_MS = 1000
  const STALE_MS = 5000

  // Display names and help for each correction, in pipeline order. A correction the
  // plugin knows but this list does not still shows, under its id.
  const CORRECTIONS = {
    stw: { name: 'Boat speed (STW)', what: 'Paddlewheel linearity at low speed, plus the loss when heeled. Knots added to STW before anything else uses it.' },
    leeway: { name: 'Leeway', what: 'Sideways slip: leeway = K × heel ÷ STW². Turns the boat’s velocity to leeward for true wind and current.' },
    twa: { name: 'TWA table', what: 'Degrees added to |TWA| by TWS, upwind, reaching and downwind, H5000 style. Negative = TWA was reading too wide. Rows blend by TWA at the angles below.' },
    tws: { name: 'TWS table', what: 'Percent applied to TWS by TWS, upwind, reaching and downwind. Blended at the TWA table’s angles. H5000 default is −10% downwind.' }
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
      if (el.value === '') return // keep the old value until something is typed
      value = Number(el.value)
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
      $('steps').innerHTML = `<tr><td colspan="4" class="muted center">${esc(live ? live.status || 'Waiting for data…' : 'Waiting for data…')}</td></tr>`
    } else {
      const o = r.out
      const u = uncorrected(r.input)
      const side = v => v < 0 ? 'port' : 'stbd'
      $('tiles').innerHTML = [
        tile('TWA', fmt(Math.abs(o.twa)), `° ${side(o.twa)}`, `uncorrected ${fmt(Math.abs(u.twa))}°`),
        tile('TWS', fmt(o.tws), 'kn', `uncorrected ${fmt(u.tws)} kn`),
        tile('TWD', o.twd == null ? '--' : fmt(o.twd, 0), '° T', o.twd == null ? 'no heading' : headingNote(o)),
        tile('STW', fmt(o.stw, 2), 'kn', `paddlewheel ${fmt(r.input.stw, 2)} kn`),
        tile('Leeway', fmt(Math.abs(o.leeway)), `° ${side(o.leeway)}`, r.input.heel == null ? 'no heel' : `heel ${fmt(r.input.heel, 0)}°`),
        tile('Current', o.current ? fmt(o.current.drift, 2) : '--', o.current ? `kn · ${fmt(o.current.set, 0)}°` : 'kn', o.current ? '' : 'no SOG/COG or heading')
      ].join('')
      $('steps').innerHTML = r.steps.map(s => s.enabled
        ? `<tr><th scope="row">${esc(s.name)}</th><td class="mono">${esc(s.input || '')}</td><td>${esc(s.skipped ? 'skipped — ' + s.skipped : s.detail || '')}</td><td class="mono">${esc(s.output || '')}</td></tr>`
        : `<tr class="off"><th scope="row">${esc(s.name)}</th><td></td><td>off</td><td></td></tr>`
      ).join('')
    }

    const inputs = live ? Object.entries(live.inputs) : []
    $('inputs').innerHTML = inputs.length
      ? inputs.sort().map(([path, i]) => `<tr><td>${esc(path)}</td><td>${esc(i.source)}</td><td class="num ${i.ageMs > STALE_MS ? 'warn' : ''}">${fmt(i.ageMs / 1000)} s</td></tr>`).join('')
      : '<tr><td colspan="3" class="muted center">Nothing received yet</td></tr>'
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
      body = grid('Linearity (kn added)', 'STW kn', `corrections.stw.linearity`, 'stw', [['Add', 'add']], c.linearity) +
        grid('Heel correction (kn added)', 'Heel °', `corrections.stw.heel`, 'heel', [['Add', 'add']], c.heel)
    } else if (id === 'leeway') {
      body = `<div class="fields">${field('K', 'corrections.leeway.k', c.k, 0.01)}</div>`
    } else if (id === 'twa' || id === 'tws') {
      const rows = [['Upwind', 'upwind'], ['Reach', 'reach'], ['Downwind', 'downwind']]
      body = grid(id === 'twa' ? 'Degrees added to |TWA|' : 'Percent applied to TWS', 'TWS kn', `corrections.${id}`, 'tws', rows, c)
      if (id === 'twa') {
        const a = c.angles
        body += `<div class="fields">${field('Upwind row to (° TWA)', 'corrections.twa.angles.upwind', a.upwind, 1)}` +
          `${field('Reach row at (° TWA)', 'corrections.twa.angles.reach', a.reach, 1)}` +
          `${field('Downwind row from (° TWA)', 'corrections.twa.angles.downwind', a.downwind, 1)}</div>`
      }
    }
    $('corrEditor').innerHTML =
      `<div class="panel-head"><h2>${esc(meta.name)}</h2><span class="state ${c.enabled ? 'on' : ''}">${c.enabled ? 'Enabled' : 'Disabled'}</span></div>` +
      `<p class="what muted">${esc(meta.what)}</p>${body}` +
      `<div><button type="button" class="ghost" data-defaults="${esc(id)}">Reset to defaults</button></div>`
  }

  // A table whose first row is its axis (editable) and whose other rows are values.
  function grid (title, axisLabel, base, axisKey, rows, obj) {
    const axis = obj[axisKey]
    const cell = (path, v, cls) => `<td><input type="number" step="any" class="${cls || ''}" data-path="${esc(path)}" value="${esc(v)}"></td>`
    return `<div><h2>${esc(title)}</h2><div class="table-wrap"><table class="grid">` +
      `<tr><th scope="row" class="muted">${esc(axisLabel)}</th>${axis.map((v, i) => cell(`${base}.${axisKey}.${i}`, v, 'axis')).join('')}</tr>` +
      rows.map(([label, key]) => `<tr><th scope="row">${esc(label)}</th>${obj[key].map((v, i) => cell(`${base}.${key}.${i}`, v)).join('')}</tr>`).join('') +
      '</table></div></div>'
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
    renderSources()
  }

  function renderSources () {
    const seen = (state.live && state.live.sourcesSeen) || {}
    $('sources').innerHTML = Object.entries(SOURCE_LABELS).map(([key, label]) => {
      const chosen = state.draft.sources[key] || ''
      const opts = Array.from(new Set([...(seen[key] || []), chosen].filter(Boolean)))
      return `<label>${esc(label)}<select data-path="sources.${key}">` +
        `<option value="">Any</option>` +
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
