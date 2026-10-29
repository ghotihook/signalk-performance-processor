const test = require('node:test')
const assert = require('node:assert')
const T = require('../public/tables')
const { normalizeConfig } = require('../lib/processor')

const twa = { tws: [0, 5, 10, 15, 20, 25, 30], upwind: [0, -7.6, -12.6, -5.8, -5.7, 0.2, null], reach: [0, -2.4, -4.4, -5.4, 1.4, 3.9, 1], downwind: [0, 1.2, -3.5, 1, null, null, null] }
const stw = { heel: [0, 10, 20], stw: [0, 5, 10, 15, 20, 25, 30], add: [[0, 0.05, 0, 0, 0, 0, 0], [0, 0.01, -0.03, -0.03, -0.03, -0.03, -0.03], [0, -0.08, -0.13, -0.13, -0.13, -0.13, -0.13]] }
const tws = { tws: [0, 5, 10, 15, 20, 25, 30], correction: [0, -0.5, -1, -1.5, -2, -2.5, -3], downAngle: [165, 165, 165, 165, 165, 165, 165] }

test('every table survives format -> paste unchanged', () => {
  assert.deepStrictEqual(T.parseTwa(T.format('twa', twa)), twa)
  assert.deepStrictEqual(T.parseStw(T.format('stw', stw)), stw)
  assert.deepStrictEqual(T.parseTws(T.format('tws', tws)), tws)
})

test('a pasted table is a valid plugin table', () => {
  const { errors } = normalizeConfig({ schema: 3, corrections: { twa: T.parseTwa(T.format('twa', twa)), stw: T.parseStw(T.format('stw', stw)), tws: T.parseTws(T.format('tws', tws)) } })
  assert.deepStrictEqual(errors, [])
})

test('spreadsheet damage: tabs, padding, quotes, Unicode minus, degree signs, rows in any order', () => {
  const text = '﻿"TWA\\TWS"\t0\t5\t10\t15\t20\t25\t30\n' +
    '165º TWA\t0\t1.2\t−3.5\t1\t\t\t\n' +
    '  40°  \t0\t−7.6\t-12.6\t-5.8\t-5.7\t0.2\t\n' +
    'reach\t0\t-2.4\t-4.4\t-5.4\t1.4\t3.9\t1\n'
  assert.deepStrictEqual(T.parseTwa(text), twa)
  const spaced = 'TWA\\TWS 0 5 10 15 20 25 30\n40 0 -1 -1 -1 -1 -1 -1\n90 0 0 0 0 0 0 0\n165 0 1 1 1 1 1 1'
  assert.deepStrictEqual(T.parseTwa(spaced).upwind, [0, -1, -1, -1, -1, -1, -1])
})

test('the wrong layout is refused with the reason', () => {
  assert.throws(() => T.parseTwa('TWA\\TWS,5,10,15,20,25,30\n40,1,1,1,1,1,1'), /header must be TWS columns 0, 5, 10/)
  assert.throws(() => T.parseTwa('TWA\\TWS,0,5,10,15,20,25,30\n40,0,1,1,1,1,1,1\n90,0,1,1,1,1,1,1'), /missing row 165/)
  assert.throws(() => T.parseTwa('TWA\\TWS,0,5,10,15,20,25,30\n45,0,1,1,1,1,1,1'), /expected 40, 90 or 165/)
  assert.throws(() => T.parseTwa('TWA\\TWS,0,5,10,15,20,25,30\n40,0,x,1,1,1,1,1'), /not a number: "x"/)
  assert.throws(() => T.parseTws('TWS,0,5,10,15,20,25,30\nupwind,0,1,1,1,1,1,1'), /expected "correction" or "down angle"/)
  assert.throws(() => T.parseStw('heel\\stw,0,5'), /needs a header row and at least one table row/)
})

test('TWS: the down angle row defaults to 165 when left out', () => {
  assert.deepStrictEqual(T.parseTws('TWS,0,5,10,15,20,25,30\ncorrection,0,-0.5,-1,-1.5,-2,-2.5,-3').downAngle, [165, 165, 165, 165, 165, 165, 165])
})

test('an old signed heel x STW grid (signalk-stw-heel-correction CSV) is resampled, port and starboard averaged', () => {
  const old = 'heel\\stw,2,6\n-20,-0.2,-0.1\n0,0.1,0\n20,0,-0.3'
  const r = T.parseStw(old)
  assert.strictEqual(r.resampled, true)
  assert.deepStrictEqual(r.heel, [0, 10, 20])
  assert.strictEqual(r.add[2][2], -0.2, '(-0.1 + -0.3) / 2 at 20 deg, held beyond 6 kn')
  assert.strictEqual(r.add[0][0], 0, 'tapers to 0 at 0 kn')
})
