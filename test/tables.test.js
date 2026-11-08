const test = require('node:test')
const assert = require('node:assert')
const T = require('../public/tables')
const { normalizeConfig, CONFIG_SCHEMA } = require('../lib/processor')
const { DEFAULTS } = require('../lib/defaults')
const { interp, blendRows, fillGaps } = T
const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `expected ${b} ± ${tol}, got ${a}`)

const twa = { twa: [40, 90, 165], tws: [5, 10, 15, 20, 25, 30], add: [[-9, -7.6, -12.6, -5.8, -5.7, null], [-1, -2.4, -4.4, -5.4, 1.4, 3.9], [0.5, 1.2, -3.5, 1, null, null]] }
const stw = { heel: [-20, -10, 0, 10, 20], stw: [1, 2.5, 5, 7.5, 10, 12.5, 15], add: [[0.16, 0.4, 0.2, 0, -0.1, -0.1, -0.2], [0.12, 0.3, 0.1, 0, 0, 0, 0], [0.12, 0.3, 0.05, 0, 0, 0, null], [0.12, 0.3, 0.1, 0, 0, 0, 0], [0.14, 0.35, 0.15, -0.05, -0.1, -0.1, -0.1]] }
const tws = { twa: [50, 90, 110], tws: [5, 10, 15, 20, 25, 30], add: [[0, 0, 0, 0, 0, 0], [-0.2, -0.4, -0.6, -0.8, null, null], [-0.8, -1.5, -2.3, -3, -3.8, -4.5]] }

test('every table survives format -> paste unchanged, the defaults too', () => {
  assert.deepStrictEqual(T.parseTwa(T.format('twa', twa)), twa)
  assert.deepStrictEqual(T.parseStw(T.format('stw', stw)), stw)
  assert.deepStrictEqual(T.parseTws(T.format('tws', tws)), tws)
  for (const id of ['stw', 'twa', 'tws']) {
    const { enabled, ...t } = DEFAULTS.corrections[id]
    assert.deepStrictEqual(T.parse(id, T.format(id, t)), t, id)
  }
})

test('a pasted table is a valid plugin table', () => {
  const { errors } = normalizeConfig({ schema: CONFIG_SCHEMA, corrections: { twa: T.parseTwa(T.format('twa', twa)), stw: T.parseStw(T.format('stw', stw)), tws: T.parseTws(T.format('tws', tws)) } })
  assert.deepStrictEqual(errors, [])
})

test('any axes paste: fine, coarse or uneven, rows in any order', () => {
  const text = 'TWA\\TWS,4,6,8,11\n180,0,0,0,0\n30,-9,-8,,\n35,-8,-7,-6,-5\n'
  assert.deepStrictEqual(T.parseTwa(text), { twa: [30, 35, 180], tws: [4, 6, 8, 11], add: [[-9, -8, null, null], [-8, -7, -6, -5], [0, 0, 0, 0]] })
  assert.deepStrictEqual(T.parseStw('heel\\stw,3\n0,0.2').heel, [0])
})

test('spreadsheet damage: tabs, padding, quotes, Unicode minus, degree signs', () => {
  const text = '﻿"TWA\\TWS"\t5\t10\t15\t20\t25\t30\n' +
    '165º TWA\t0.5\t1.2\t−3.5\t1\t\t\n' +
    '  40°  \t−9\t−7.6\t-12.6\t-5.8\t-5.7\t\n' +
    '90\t-1\t-2.4\t-4.4\t-5.4\t1.4\t3.9\n'
  assert.deepStrictEqual(T.parseTwa(text), twa)
  const spaced = 'TWA\\TWS 5 10 15 20 25 30\n40 -1 -1 -1 -1 -1 -1\n90 0 0 0 0 0 0\n165 1 1 1 1 1 1'
  assert.deepStrictEqual(T.parseTwa(spaced).add[0], [-1, -1, -1, -1, -1, -1])
})

test('a schema 6 paste still reads: TWA rows by name, the TWS table by its upwind, reach and downwind rows', () => {
  const named = 'TWA\\TWS,5,10\nupwind,-1,-2\nReaching,0,0\ndownwind,1,1'
  assert.deepStrictEqual(T.parseTwa(named), { twa: [40, 90, 165], tws: [5, 10], add: [[-1, -2], [0, 0], [1, 1]] })
  const old = 'TWS,5,10,15,20,25,30\nUpwind correction,0,0,0,0,0,0\nreaching,-0.2,-0.4,-0.6,-0.8,,\ndownwind,-0.8,-1.5,-2.3,-3,-3.8,-4.5\nUpwind angle,50,50,50,50,50,50\nDown angle,110°,110,110,110,110,110'
  assert.deepStrictEqual(T.parseTws(old), tws, 'the grid it looks up the same as')
  assert.throws(() => T.parseTws(old.split('\n').slice(0, 4).join('\n')), /missing rows upAngle, downAngle/)
  assert.throws(() => T.parseTws(old.replace('Upwind angle,50', 'Upwind angle,95')), /up angle must be below 90/)
})

test('a table that cannot be read is refused with the reason', () => {
  assert.throws(() => T.parseTwa('TWA\\TWS,5,10,10\n40,1,1,1'), /header's TWS columns: must go up/)
  assert.throws(() => T.parseTwa('TWA\\TWS,0,10\n40,1,1'), /header's TWS columns: must be above 0/)
  assert.throws(() => T.parseTwa('TWA\\TWS,5,10\n40,1,1\n40,2,2'), /two rows at 40/)
  assert.throws(() => T.parseTwa('TWA\\TWS,5,10\n200,1,1'), /TWA rows: must be from 0 to 180/)
  assert.throws(() => T.parseTwa('TWA\\TWS,5,10\nbeam,1,1'), /row "beam" is not a number/)
  assert.throws(() => T.parseTwa('TWA\\TWS,5,10\n40,x,1'), /not a number: "x"/)
  assert.throws(() => T.parseTwa('TWA\\TWS,5,10\n40,1,1,1'), /more than 2 values/)
  assert.throws(() => T.parseStw('heel\\stw,1,2\n95,0,0'), /heel rows: must be from -90 to 90/)
  assert.throws(() => T.parseTws('TWA\\TWS,5\ncorrection,1'), /row "correction" is not a number/)
  assert.throws(() => T.parseStw('heel\\stw,2.5'), /needs a header row and at least one table row/)
})

test('along a row: from zero at 0 kn to the first column, linear between, the last held', () => {
  const xs = [2.5, 5, 7.5]
  const ys = [0.4, 0.2, -0.1]
  assert.strictEqual(T.fromZero(xs, ys, 0), 0)
  assert.strictEqual(T.fromZero(xs, ys, -1), 0)
  assert.ok(Math.abs(T.fromZero(xs, ys, 1.25) - 0.2) < 1e-12)
  assert.ok(Math.abs(T.fromZero(xs, ys, 6.25) - 0.05) < 1e-12)
  assert.strictEqual(T.fromZero(xs, ys, 30), -0.1)
})

test('lookup: rows linear between, the end rows held, each row from zero, no steps', () => {
  const t = { twa: [50, 90, 110], tws: [5, 10, 15], add: [[0.5, 1, 1], [0, 0, 0], [-1, -2, -2]] }
  const c = (a, s) => T.value('tws', t, a, s)
  assert.strictEqual(c(30, 10), 1)
  assert.strictEqual(c(50, 10), 1)
  assert.strictEqual(c(70, 10), 0.5)
  assert.strictEqual(c(90, 10), 0)
  assert.strictEqual(c(100, 10), -1)
  assert.strictEqual(c(180, 10), -2)
  assert.strictEqual(c(180, 0), 0, 'nothing at 0 kn')
  assert.strictEqual(c(180, 2.5), -0.5, 'from zero below the first column')
  let prev = c(0, 12)
  for (let a = 0.5; a <= 180; a += 0.5) { const v = c(a, 12); assert.ok(Math.abs(v - prev) < 0.06, `steps at ${a}`); prev = v }
})

test('interp holds the end values and is linear between', () => {
  assert.strictEqual(interp([5, 10], [1, 3], 0), 1)
  assert.strictEqual(interp([5, 10], [1, 3], 20), 3)
  assert.strictEqual(interp([5, 10], [1, 3], 7.5), 2)
  assert.strictEqual(interp([5], [1], 7.5), 1, 'one point')
})

test('rows blend by TWA (schema 6): the first in full to its angle, the second at its angle, the third in full from its angle', () => {
  assert.strictEqual(blendRows(30, 40, 90, 165, -10, 0, 4), -10)
  assert.strictEqual(blendRows(65, 40, 90, 165, -10, 0, 4), -5)
  assert.strictEqual(blendRows(90, 40, 90, 165, -10, 0, 4), 0)
  close(blendRows(127.5, 40, 90, 165, -10, 0, 4), 2, 1e-9)
  assert.strictEqual(blendRows(170, 40, 90, 165, -10, 0, 4), 4)
})

test('fillGaps extends rows, then fills an empty row from its neighbour', () => {
  assert.deepStrictEqual(fillGaps([[null, 1, null], [null, null, null], [2, null, 3]]), [[1, 1, 1], [1, 1, 1], [2, 2, 3]])
})
