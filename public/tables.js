// The calibration tables and their text format, shared by the plugin (require) and the webapp
// (a <script> tag), so a table pasted in the webapp, a table from boatcal or a user's own agent
// and a saved config all read the same way. The lookup every table shares is here too, so
// the webapp's worked examples use exactly the plugin's arithmetic.
//
// Every table is a grid whose axes are saved with it: rows down the side, columns along the
// top, and add[row][column]. Any axes will do, as long as each goes up (AXIS_RANGE says how
// far): a coarse H5000-style table and a fine one are read the same way.
//
//   STW table  { heel: [...], stw: [...], add }   rows heel (deg, + = starboard side down),
//                                                 columns boat speed (kn)
//   TWA table  { twa: [...], tws: [...], add }    rows |TWA| (deg), columns TWS (kn)
//   TWS table  { twa: [...], tws: [...], add }    the same
//
// Text format, one table per paste: a header row of the columns, then one row per table
// row, its label first. Commas, tabs, semicolons or spaces between cells; blank cells
// allowed (fillGaps says what a blank takes); rows in any order.
//
//   heel\stw, 1, 2, 3, ...
//   -30,      0.5, 0.65, 0.29, ...       (+ = starboard side down)
//
//   TWA\TWS, 4, 6, 8, ...
//   30,      -9, -7, -5, ...
;(function (root) {
  'use strict'

  // Each table's axes: the field each is saved in, its label in the text format.
  const KINDS = {
    stw: { rows: 'heel', cols: 'stw', corner: 'heel\\stw' },
    twa: { rows: 'twa', cols: 'tws', corner: 'TWA\\TWS' },
    tws: { rows: 'twa', cols: 'tws', corner: 'TWA\\TWS' }
  }
  // What each axis may hold. Speeds start above 0: a row runs from zero at 0 kn to its
  // first column (fromZero).
  const AXIS_RANGE = {
    heel: { what: 'heel rows', unit: '°', min: -90, max: 90 },
    stw: { what: 'boat speed columns', unit: ' kn', min: 0, max: 60, aboveMin: true },
    twa: { what: 'TWA rows', unit: '°', min: 0, max: 180 },
    tws: { what: 'TWS columns', unit: ' kn', min: 0, max: 120, aboveMin: true }
  }
  const MAX_AXIS = 100 // entries on any one axis
  const REACH_DEG = 90 // the reaching row of the schema 6 TWS table (twsFromRows)

  // ---- lookups ----------------------------------------------------------------------

  // Linear interpolation, holding the end values beyond either end.
  function interp (xs, ys, x) {
    if (x <= xs[0]) return ys[0]
    const n = xs.length - 1
    if (x >= xs[n]) return ys[n]
    let i = 0
    while (xs[i + 1] < x) i++
    return ys[i] + (ys[i + 1] - ys[i]) * (x - xs[i]) / (xs[i + 1] - xs[i])
  }

  // Along a row of a table by speed: as the H5000, interpolated to zero below the first
  // column (so nothing is added at 0 kn), linear between columns, the last column held
  // beyond it.
  const fromZero = (xs, ys, x) => x <= 0 ? 0 : x < xs[0] ? ys[0] * x / xs[0] : interp(xs, ys, x)

  // The rows either side of v and how far between: [i, j, f], f = 0 at row i, 1 at row j.
  // Beyond either end, the end row.
  function bracket (xs, v) {
    if (v <= xs[0]) return [0, 0, 0]
    const n = xs.length - 1
    if (v >= xs[n]) return [n, n, 0]
    let i = 0
    while (xs[i + 1] < v) i++
    return [i, i + 1, (v - xs[i]) / (xs[i + 1] - xs[i])]
  }

  // A table at row value r and speed s, from its filled grid (fillGaps): along each row by
  // speed from zero, then linear between the rows either side of r, the end row held beyond
  // either end.
  function lookup (rows, cols, filled, r, s) {
    const [i, j, f] = bracket(rows, r)
    const a = fromZero(cols, filled[i], s)
    return f === 0 ? a : a * (1 - f) + fromZero(cols, filled[j], s) * f
  }

  // The same, from a table as saved (blanks and all). The plugin caches the filled grid.
  function value (kind, t, r, s) {
    const k = KINDS[kind]
    return lookup(t[k.rows], t[k.cols], fillGaps(t.add), r, s)
  }

  // The rows of a schema 6 table blended by |TWA|: the first row in full up to its angle,
  // the second at its angle, the third in full from its angle, linear between.
  function blendRows (absTwa, upAngle, reachAngle, downAngle, up, reach, down) {
    if (absTwa <= upAngle) return up
    if (absTwa <= reachAngle) return up + (reach - up) * (absTwa - upAngle) / (reachAngle - upAngle)
    if (absTwa <= downAngle) return reach + (down - reach) * (absTwa - reachAngle) / (downAngle - reachAngle)
    return down
  }

  // A blank cell is "not measured": it takes the value to its left, or at the start of a row
  // the first value to its right, not a value between its neighbours. Then fill an all-blank row from the nearest row with data; a table with no values at all is 0.
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
    return table.map(r => r.map(v => v == null ? 0 : v))
  }

  // What is wrong with an axis, or null: numbers, going up, within its range, not too many.
  function checkAxis (name, xs) {
    const a = AXIS_RANGE[name]
    if (!Array.isArray(xs) || xs.length === 0) return `${a.what}: needs at least one`
    if (xs.length > MAX_AXIS) return `${a.what}: at most ${MAX_AXIS}`
    if (!xs.every(v => typeof v === 'number' && Number.isFinite(v))) return `${a.what}: every one must be a number`
    if (xs.some((v, i) => i > 0 && v <= xs[i - 1])) return `${a.what}: must go up, each larger than the one before`
    if (xs[0] < a.min || (a.aboveMin && xs[0] <= a.min) || xs[xs.length - 1] > a.max) return `${a.what}: must be ${a.aboveMin ? 'above' : 'from'} ${a.min} to ${a.max}${a.unit}`
    return null
  }

  // ---- schema 6 tables ---------------------------------------------------------------
  //
  // Schema 6 (0.2.12 to 0.2.17) had three rows in each wind table. Each converts to a grid
  // that looks up the same.

  // TWA: rows at 40, 90 and 165, the end rows held beyond them. As a grid, exactly that.
  function twaFromRows (t) {
    const row = r => Array.isArray(r) ? r.slice() : r
    return { twa: [40, 90, 165], tws: row(t.tws), add: [row(t.upwind), row(t.reach), row(t.downwind)] }
  }

  // TWS: upwind in full up to the up angle, reaching at 90, downwind in full from the down
  // angle, with the angles by TWS. With the same angles in every column, a grid with rows at
  // those angles is exactly that (exact: true). Otherwise the grid's rows are every angle
  // used, each cell the old table's value there: the same in each column, close between.
  // Expects the old table valid (equal lengths, up angle < 90 < down angle).
  function twsFromRows (t) {
    const same = xs => xs.every(v => v === xs[0])
    if (same(t.upAngle) && same(t.downAngle)) {
      return { exact: true, table: { twa: [t.upAngle[0], REACH_DEG, t.downAngle[0]], tws: t.tws.slice(), add: [t.upwind.slice(), t.reach.slice(), t.downwind.slice()] } }
    }
    const [up, reach, down] = fillGaps([t.upwind, t.reach, t.downwind])
    const twa = Array.from(new Set(t.upAngle.concat([REACH_DEG], t.downAngle))).sort((a, b) => a - b)
    const add = twa.map(a => t.tws.map((_, j) => Math.round(blendRows(a, t.upAngle[j], REACH_DEG, t.downAngle[j], up[j], reach[j], down[j]) * 1000) / 1000))
    return { exact: false, table: { twa, tws: t.tws.slice(), add } }
  }

  // ---- text format --------------------------------------------------------------------

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

  function values (r, n, label) {
    const v = r.slice(1, n + 1)
    while (v.length < n) v.push('')
    if (r.slice(n + 1).some(c => c !== '')) throw new Error(`row "${r[0]}" has more than ${n} values`)
    return v.map((c, j) => c === '' ? null : number(c, `row "${label}", column ${j + 1}`))
  }

  // Schema 6 row names, read as the rows they were.
  const TWA_NAMES = { upwind: 40, reach: 90, reaching: 90, downwind: 165 }
  const TWS_NAMES = { upwind: 'upwind', reach: 'reach', reaching: 'reach', downwind: 'downwind', upangle: 'upAngle', upwindangle: 'upAngle', downangle: 'downAngle', downwindangle: 'downAngle' }
  const twsName = label => TWS_NAMES[label.toLowerCase().replace(/[^a-z]/g, '').replace(/correction$/, '')]

  // A schema 6 TWS table as pasted: rows upwind, reach, downwind, up angle, down angle.
  function parseTwsRows (rows, cols) {
    const t = { tws: cols }
    for (const r of rows.slice(1)) {
      const key = twsName(r[0])
      if (!key) throw new Error(`row "${r[0]}": a TWS table is either rows by TWA, or the rows upwind, reach, downwind, up angle and down angle`)
      t[key] = values(r, cols.length, r[0])
    }
    const missing = Object.values(TWS_NAMES).filter((k, i, a) => a.indexOf(k) === i && !t[k])
    if (missing.length) throw new Error(`missing row${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`)
    for (const k of ['upAngle', 'downAngle']) {
      if (t[k].some(v => v == null)) throw new Error(`row ${k}: needs a value in every column`)
    }
    if (!t.upAngle.every(v => v >= 0 && v < REACH_DEG) || !t.downAngle.every(v => v > REACH_DEG && v <= 180)) throw new Error(`each up angle must be below ${REACH_DEG}° and each down angle above it`)
    return twsFromRows(t).table
  }

  // A table pasted as text: any axes, each going up (rows may come in any order).
  function parse (kind, text) {
    const k = KINDS[kind]
    if (!k) throw new Error(`no table "${kind}"`)
    const rows = cells(text)
    const cols = rows[0].slice(1).filter((c, j, a) => !(c === '' && j === a.length - 1)).map((c, j) => number(c, `column ${j + 1} of the header`))
    const colErr = checkAxis(k.cols, cols)
    if (colErr) throw new Error(`the header's ${colErr}`)
    if (kind === 'tws' && rows.slice(1).some(r => twsName(r[0]))) return parseTwsRows(rows, cols)
    const read = rows.slice(1).map(r => {
      const label = r[0].toLowerCase().replace(/[°º]|heel|twa|\s/g, '')
      const at = kind === 'twa' && label in TWA_NAMES ? TWA_NAMES[label] : number(label, `row "${r[0]}"`)
      return [at, values(r, cols.length, r[0])]
    }).sort((a, b) => a[0] - b[0])
    const dup = read.find((x, i) => i > 0 && x[0] === read[i - 1][0])
    if (dup) throw new Error(`two rows at ${dup[0]}`)
    const at = read.map(x => x[0])
    const rowErr = checkAxis(k.rows, at)
    if (rowErr) throw new Error(`the ${rowErr}`)
    return { [k.rows]: at, [k.cols]: cols, add: read.map(x => x[1]) }
  }

  // A table as text in the format above, ready to paste back in.
  function format (kind, t) {
    const k = KINDS[kind]
    if (!k) throw new Error(`no table "${kind}"`)
    const v = x => x == null ? '' : String(x)
    const line = (label, xs) => [label].concat(xs.map(v)).join(',')
    return [line(k.corner, t[k.cols])].concat(t[k.rows].map((r, i) => line(r, t.add[i]))).join('\n')
  }

  const api = {
    KINDS,
    AXIS_RANGE,
    MAX_AXIS,
    REACH_DEG,
    interp,
    fromZero,
    bracket,
    lookup,
    value,
    blendRows,
    fillGaps,
    checkAxis,
    twaFromRows,
    twsFromRows,
    parse,
    parseStw: text => parse('stw', text),
    parseTwa: text => parse('twa', text),
    parseTws: text => parse('tws', text),
    format
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.PPTables = api
})(typeof self !== 'undefined' ? self : this)
