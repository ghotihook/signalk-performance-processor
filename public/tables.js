// The calibration tables' layout (the B&G H5000's) and their text format, shared by the
// plugin (require) and the webapp (a <script> tag), so a table pasted in the webapp, a
// table from the boatcal plugincal tool and a saved config all read the same way. The
// lookups every table shares (zero at 0 kn, blending the TWA rows) are here too, so the
// webapp's worked examples use exactly the plugin's arithmetic.
//
// Text format, one table per paste: a header row of TWS or boat speed columns, then one
// row per table row, its label first. Commas, tabs, semicolons or spaces between cells;
// blank cells allowed where the table allows them (a blank takes the nearest value in its
// row).
//
//   heel\stw, 1, 2.5, 5, 7.5, 10, 12.5, 15          rows at heel -20, -10, 0, 10, 20
//   -20,      0.5, 0.65, 0.29, 0.35, 0.21, 0.06, -0.08 (+ = starboard side down)
//
//   TWA\TWS, 5, 10, 15, 20, 25, 30                  rows at TWA 40, 90, 165
//   40,      -9, -7, -5, -2, 3, 6
//
//   TWS, 5, 10, 15, 20, 25, 30                       rows: upwind, reach, downwind (kn),
//   upwind, 0, 0, 0, 0, 0, 0                          up angle, down angle (deg TWA)
;(function (root) {
  'use strict'

  const AXES = {
    stwHeel: [-20, -10, 0, 10, 20], // STW table rows, deg of heel, + = starboard side down
    stwSpeed: [1, 2.5, 5, 7.5, 10, 12.5, 15], // STW table columns, boat speed kn (the H5000's, and 1 kn where a paddlewheel stalls)
    twaTws: [5, 10, 15, 20, 25, 30], // TWA table columns, TWS kn
    twaRows: { upwind: 40, reach: 90, downwind: 165 }, // TWA table rows, deg TWA
    twsTws: [5, 10, 15, 20, 25, 30] // TWS table columns, TWS kn
  }
  const TWA_ROW_KEYS = ['upwind', 'reach', 'downwind']
  const TWS_ROWS = [ // key, label in the text format, blanks allowed
    ['upwind', 'upwind', true], ['reach', 'reach', true], ['downwind', 'downwind', true],
    ['upAngle', 'up angle', false], ['downAngle', 'down angle', false]
  ]
  const REACH_DEG = 90 // the TWS table's reaching correction applies in full at this TWA

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

  // The rows of a table blended by |TWA|: the first row in full up to its angle, the
  // second at its angle, the third in full from its angle, linear between.
  function blendRows (absTwa, upAngle, reachAngle, downAngle, up, reach, down) {
    if (absTwa <= upAngle) return up
    if (absTwa <= reachAngle) return up + (reach - up) * (absTwa - upAngle) / (reachAngle - upAngle)
    if (absTwa <= downAngle) return reach + (down - reach) * (absTwa - reachAngle) / (downAngle - reachAngle)
    return down
  }

  // A blank cell is "not measured": extend the nearest value in its row into it, then fill
  // an all-blank row from the nearest row with data; a table with no values at all is 0.
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

  // TWS table: knots added at this |TWA| and TWS. Upwind correction in full up to the up
  // angle, reaching in full at 90, downwind in full from the down angle, linear between, so
  // it never steps; each row by TWS from zero at 0 kn. The plugin requires up angle < 90 <
  // down angle (normalizeConfig); the clamps here only keep a bad table from dividing by 0.
  function twsCorrection (t, absTwa, tws) {
    const [up, reach, down] = fillGaps([t.upwind, t.reach, t.downwind]).map(r => fromZero(t.tws, r, tws))
    const upA = Math.min(REACH_DEG - 1, interp(t.tws, t.upAngle, tws))
    const downA = Math.max(REACH_DEG + 1, interp(t.tws, t.downAngle, tws))
    return blendRows(absTwa, upA, REACH_DEG, downA, up, reach, down)
  }

  // ---- text format --------------------------------------------------------------------

  const cleanCell = c => c.trim().replace(/^"(.*)"$/, '$1').replace(/−/g, '-').trim()

  // Rows of cells; the first row is the header. Tolerates spreadsheet damage: quotes, a
  // byte-order mark, Unicode minus signs, degree signs and padding.
  function cells (text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(l => l.trim())
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
    if (!(cols.length === axis.length && cols.every((v, i) => v === axis[i]))) throw new Error(`the header must be ${what} ${axis.join(', ')}`)
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

  // STW table: rows heel -20, -10, 0, 10, 20 (+ = starboard side down), columns boat speed.
  function parseStw (text) {
    const rows = cells(text)
    header(rows, AXES.stwSpeed, 'boat speed columns')
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

  // TWA table: rows keyed by their TWA (40, 90, 165) or name (upwind, reach, downwind).
  function parseTwa (text) {
    const rows = cells(text)
    header(rows, AXES.twaTws, 'TWS columns')
    const out = { tws: AXES.twaTws.slice() }
    for (const r of rows.slice(1)) {
      const k = r[0].toLowerCase().replace(/[°º]|twa|\s/g, '').replace(/^reaching$/, 'reach')
      const key = TWA_ROW_KEYS.find(n => k === n || k === String(AXES.twaRows[n]))
      if (!key) throw new Error(`row "${r[0]}": expected 40, 90 or 165 (TWA)`)
      out[key] = values(r, AXES.twaTws.length, r[0], true)
    }
    const missing = TWA_ROW_KEYS.filter(k => !out[k])
    if (missing.length) throw new Error(`missing row${missing.length > 1 ? 's' : ''} ${missing.map(k => AXES.twaRows[k]).join(', ')}`)
    return out
  }

  // TWS table: upwind, reach and downwind corrections (kn) and the up and down angles.
  function parseTws (text) {
    const rows = cells(text)
    header(rows, AXES.twsTws, 'TWS columns')
    const out = { tws: AXES.twsTws.slice() }
    const names = { upwind: 'upwind', reach: 'reach', reaching: 'reach', downwind: 'downwind', upangle: 'upAngle', upwindangle: 'upAngle', downangle: 'downAngle', downwindangle: 'downAngle' }
    for (const r of rows.slice(1)) {
      const key = names[r[0].toLowerCase().replace(/[^a-z]/g, '').replace(/correction$/, '')]
      const row = TWS_ROWS.find(([k]) => k === key)
      if (!row) throw new Error(`row "${r[0]}": expected ${TWS_ROWS.map(x => `"${x[1]}"`).join(', ')}`)
      out[key] = values(r, AXES.twsTws.length, r[0], row[2])
    }
    const missing = TWS_ROWS.filter(([key]) => !out[key])
    if (missing.length) throw new Error(`missing row${missing.length > 1 ? 's' : ''} ${missing.map(x => `"${x[1]}"`).join(', ')}`)
    return out
  }

  // A table as text in the format above, ready to paste back in.
  function format (kind, t) {
    const v = x => x == null ? '' : String(x)
    const line = (label, xs) => [label].concat(xs.map(v)).join(',')
    if (kind === 'stw') return [line('heel\\stw', t.stw)].concat(t.heel.map((h, i) => line(h, t.add[i]))).join('\n')
    if (kind === 'twa') return [line('TWA\\TWS', t.tws)].concat(TWA_ROW_KEYS.map(k => line(AXES.twaRows[k], t[k]))).join('\n')
    if (kind === 'tws') return [line('TWS', t.tws)].concat(TWS_ROWS.map(([key, label]) => line(label, t[key]))).join('\n')
    throw new Error(`no table "${kind}"`)
  }

  const api = { AXES, TWA_ROW_KEYS, TWS_ROWS, REACH_DEG, interp, fromZero, blendRows, fillGaps, twsCorrection, parseStw, parseTwa, parseTws, format }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.PPTables = api
})(typeof self !== 'undefined' ? self : this)
