// The calibration tables' layout (the B&G H5000's) and their text format, shared by the
// plugin (require) and the webapp (a <script> tag), so a table pasted in the webapp, a
// table from the boatcal plugincal tool and a saved config all read the same way.
//
// Text format, one table per paste: a header row of TWS or boat speed columns, then one
// row per table row, its label first. Commas, tabs, semicolons or spaces between cells;
// blank cells allowed where the table allows them.
//
//   TWA\TWS, 0,  5,    10,    15,   20,   25,  30      rows at TWA 40, 90, 165
//   40,      0, -7.6, -12.6, -5.8, -5.7,  0.2,
//   90,      0, ...
//   165,     0, ...
//
//   heel\stw, 0, 5, 10, 15, 20, 25, 30                   rows at heel 0, 10, 20 (either side)
//   TWS,      0, 5, 10, 15, 20, 25, 30                   rows: correction, down angle
;(function (root) {
  'use strict'

  const COLS = [0, 5, 10, 15, 20, 25, 30]
  const AXES = {
    twaTws: COLS, // TWA table columns, TWS kn
    twaRows: { upwind: 40, reach: 90, downwind: 165 }, // TWA table rows, deg TWA
    stwHeel: [0, 10, 20], // STW table rows, deg of heel either side
    stwSpeed: COLS, // STW table columns, boat speed kn
    twsTws: COLS // TWS table columns, TWS kn
  }
  const TWA_ROW_KEYS = ['upwind', 'reach', 'downwind']

  const cleanCell = c => c.trim().replace(/^"(.*)"$/, '$1').replace(/−/g, '-').trim()

  // Rows of cells; the first row is the header. Tolerates spreadsheet damage: quotes, a
  // byte-order mark, Unicode minus signs, degree signs and padding.
  function cells (text) {
    const lines = String(text || '').replace(/^﻿/, '').trim().split(/\r?\n/).filter(l => l.trim())
    if (lines.length < 2) throw new Error('needs a header row and at least one table row')
    const sep = lines[0].includes(',') ? ',' : lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : /\s+/
    return lines.map(l => l.trim().split(sep).map(cleanCell))
  }

  const number = (c, what) => {
    const n = Number(String(c).replace(/[°º]/g, '').replace(/\s*(kn|kt|kts|deg)$/i, ''))
    if (c === '' || !Number.isFinite(n)) throw new Error(`${what} is not a number: "${c}"`)
    return n
  }

  // Header columns as numbers, checked against the expected axis.
  function header (rows, axis, what) {
    const cols = rows[0].slice(1).filter((c, j, a) => !(c === '' && j === a.length - 1)).map((c, j) => number(c, `column ${j + 1} of the header`))
    const same = cols.length === axis.length && cols.every((v, i) => v === axis[i])
    return { cols, same, expected: `${what} ${axis.join(', ')}` }
  }

  function values (r, n, label, blanks) {
    const v = r.slice(1, n + 1)
    while (v.length < n) v.push('')
    if (r.slice(n + 1).some(c => c !== '')) throw new Error(`row "${r[0]}" has more than ${n} values`)
    return v.map((c, j) => {
      if (c === '') { if (blanks) return null; throw new Error(`row "${label}" needs a value in column ${j + 1}`) }
      return number(c, `row "${label}", column ${j + 1}`)
    })
  }

  // TWA table: rows keyed by their TWA (40, 90, 165) or name (upwind, reach, downwind).
  function parseTwa (text) {
    const rows = cells(text)
    const h = header(rows, AXES.twaTws, 'TWS columns')
    if (!h.same) throw new Error(`the header must be ${h.expected}`)
    const out = { tws: AXES.twaTws.slice() }
    for (const r of rows.slice(1)) {
      const k = r[0].toLowerCase().replace(/[°º]|twa|\s/g, '')
      const key = TWA_ROW_KEYS.find(n => k === n || k === String(AXES.twaRows[n]))
      if (!key) throw new Error(`row "${r[0]}": expected 40, 90 or 165 (TWA)`)
      out[key] = values(r, AXES.twaTws.length, r[0], true)
    }
    const missing = TWA_ROW_KEYS.filter(k => !out[k])
    if (missing.length) throw new Error(`missing row${missing.length > 1 ? 's' : ''} ${missing.map(k => AXES.twaRows[k]).join(', ')}`)
    return out
  }

  // TWS table: a correction row (kn) and a down angle row (deg TWA).
  function parseTws (text) {
    const rows = cells(text)
    const h = header(rows, AXES.twsTws, 'TWS columns')
    if (!h.same) throw new Error(`the header must be ${h.expected}`)
    const out = { tws: AXES.twsTws.slice() }
    for (const r of rows.slice(1)) {
      const k = r[0].toLowerCase().replace(/[^a-z]/g, '')
      if (k.startsWith('correction') || k === 'tws') out.correction = values(r, AXES.twsTws.length, r[0], true)
      else if (k.startsWith('down')) out.downAngle = values(r, AXES.twsTws.length, r[0], false)
      else throw new Error(`row "${r[0]}": expected "correction" or "down angle"`)
    }
    if (!out.correction) throw new Error('missing the correction row')
    if (!out.downAngle) out.downAngle = AXES.twsTws.map(() => 165)
    return out
  }

  // STW table: rows heel 0, 10, 20 (either side), columns boat speed 0 to 30.
  function parseStw (text) {
    const rows = cells(text)
    const h = header(rows, AXES.stwSpeed, 'boat speed columns')
    if (!h.same) throw new Error(`the header must be ${h.expected}`)
    const add = {}
    for (const r of rows.slice(1)) {
      const heel = number(r[0].replace(/heel/i, ''), `row "${r[0]}"`)
      if (!AXES.stwHeel.includes(heel)) throw new Error(`row "${r[0]}": expected heel ${AXES.stwHeel.join(', ')}`)
      add[heel] = values(r, AXES.stwSpeed.length, `heel ${heel}`, true)
    }
    const missing = AXES.stwHeel.filter(x => !add[x])
    if (missing.length) throw new Error(`missing heel row${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`)
    return { heel: AXES.stwHeel.slice(), stw: AXES.stwSpeed.slice(), add: AXES.stwHeel.map(x => add[x]) }
  }

  // A blank cell is "not measured": extend the nearest value in its row into it, then fill
  // an all-blank row from the nearest row with data.
  function fillGaps (grid) {
    const table = grid.map(r => r.slice())
    const cols = table[0].length
    for (const row of table) {
      let last = null
      for (let j = 0; j < cols; j++) { if (row[j] != null) last = row[j]; else if (last != null) row[j] = last }
      last = null
      for (let j = cols - 1; j >= 0; j--) { if (row[j] != null) last = row[j]; else if (last != null) row[j] = last }
    }
    for (let i = 0; i < table.length; i++) {
      if (table[i][0] != null) continue
      for (let d = 1; d < table.length; d++) {
        const src = (i - d >= 0 && table[i - d][0] != null) ? table[i - d] : (i + d < table.length && table[i + d][0] != null) ? table[i + d] : null
        if (src) { table[i] = src.slice(); break }
      }
    }
    return table
  }

  // A table as text in the format above, ready to paste back in.
  function format (kind, t) {
    const v = x => x == null ? '' : String(x)
    const line = (label, xs) => [label].concat(xs.map(v)).join(',')
    if (kind === 'twa') return [line('TWA\\TWS', t.tws)].concat(TWA_ROW_KEYS.map(k => line(AXES.twaRows[k], t[k]))).join('\n')
    if (kind === 'stw') return [line('heel\\stw', t.stw)].concat(t.heel.map((h, i) => line(h, t.add[i]))).join('\n')
    if (kind === 'tws') return [line('TWS', t.tws), line('correction', t.correction), line('down angle', t.downAngle)].join('\n')
    throw new Error(`no table "${kind}"`)
  }

  const api = { AXES, TWA_ROW_KEYS, parseTwa, parseTws, parseStw, fillGaps, format }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.PPTables = api
})(typeof self !== 'undefined' ? self : this)
