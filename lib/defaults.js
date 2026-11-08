'use strict'

// Defaults for this boat: boatcal's fine-grid fit of 2026-11-08 (its plugin_config.json
// --out, written without --base, so every setting other than the tables and K is the
// plugin's own default). Fitted in this layout directly, not read off a coarser one.
// Not yet scored held out against the H5000 layout (boatcal SPECIFICATION.md section 11).
// The dates fitted were not recorded with the run.
// Every value can be changed in the webapp; these are what a fresh install starts from.

const range = (from, to, step) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step)
const HEEL = range(-30, 30, 5) // STW table rows, deg, + = starboard side down
const SPEEDS = range(1, 15, 1) // STW table columns, boat speed kn
const TWA = range(30, 180, 10) // TWA and TWS table rows, deg |TWA|
const TWS = range(4, 30, 2) // TWA and TWS table columns, TWS kn

const DEFAULTS = {
  mode: 'shadow', // 'shadow' publishes …Corrected paths; 'replace' publishes the standard paths
  // Degrees, east positive. Used only when nothing on the boat publishes
  // navigation.headingTrue or navigation.magneticVariation. Sydney.
  variation: 12.8,
  sources: { apparentWind: '', stw: '', heading: '', attitude: '', gps: '', variation: '' }, // '' = Auto
  // Damping, in seconds (0 = none), as on the H5000. True wind is damped after it is worked
  // out, as TWD and TWS, where the wind is steady: that removes the one-second spikes (355 to
  // 12 an hour over 5 deg on race logs) without lagging a yaw, which cancels inside heading +
  // TWA. Heading is not damped: it must keep the same lag as apparent wind, which the README
  // asks for raw, or each yaw swings TWD. Damp heading only to match apparent wind that
  // arrives damped.
  damping: {
    heelS: 2, // heel, before the STW table and leeway: takes most of the roll out
    headingS: 0, // heading, before true wind: as apparent wind's lag (raw: 0)
    trueWindS: 3, // TWD and TWS; TWA follows from TWD and the heading
    stwS: 1, // published STW
    currentS: 10 // current, as a vector
  },
  corrections: {
    // Boat speed / heel: knots added to STW, by heel (rows, + = starboard side down) and boat
    // speed (columns), from the GPS; from zero at 0 kn below the first column. Blank = too
    // little data: takes the value to its left. Relative to the H2000's boat speed setting at
    // the time (4.24): refit after changing it.
    stw: {
      enabled: true,
      heel: HEEL.slice(),
      stw: SPEEDS.slice(),
      add: [
        [null, null, null, null, -0.02, -0.34, -0.68, null, null, null, null, null, null, null, null],
        [null, null, null, null, -0.06, -0.24, -0.01, null, null, null, null, null, null, null, null],
        [null, null, null, 0.36, -0.12, -0.1, 0.27, 0, null, null, null, null, null, null, null],
        [null, null, 0.53, 0.11, -0.1, -0.03, 0.13, 0.12, null, null, null, null, null, null, null],
        [null, 0.48, 0.25, 0.06, 0.01, 0.09, -0.02, 0.16, null, null, null, null, null, null, null],
        [0.65, 0.41, 0.24, 0.13, 0.11, -0.11, 0, 0.11, null, null, null, null, null, null, null],
        [0.73, 0.39, 0.22, 0.06, -0.04, -0.08, -0.02, -0.06, null, null, null, null, null, null, null],
        [0.53, 0.36, 0.23, 0.18, 0.03, 0.02, -0.03, -0.15, null, null, null, null, null, null, null],
        [null, 0.37, 0.25, 0.08, 0.1, 0.06, -0.02, -0.1, null, null, null, null, null, null, null],
        [null, null, null, 0.11, 0.03, -0.11, -0.03, -0.23, null, null, null, null, null, null, null],
        [null, null, null, null, -0.09, -0.23, -0.13, -0.31, null, null, null, null, null, null, null],
        [null, null, null, null, -0.08, -0.2, -0.18, -0.29, null, null, null, null, null, null, null],
        [null, null, null, null, null, -0.15, -0.21, null, null, null, null, null, null, null, null]
      ]
    },
    // Leeway (degrees) = K x heel / STW^2, one K for every sail: downwind heel is
    // small, so leeway there is near zero whatever K is. Published, and used for
    // current; not used in true wind (the TWA table takes up its effect).
    leeway: { enabled: true, k: 8.426 },
    // Degrees added to |TWA|, by |TWA| (rows) and TWS (columns); negative = TWA was reading
    // too wide. Linear between rows, the end rows held beyond them; each row from zero at
    // 0 kn below the first column. Blank = too little data: takes the value to its left.
    twa: {
      enabled: true,
      twa: TWA.slice(),
      tws: TWS.slice(),
      add: [
        [null, -4.1, -4.1, -4, -3.8, -3.7, -3.6, -3.5, -3.6, -3.7, -3.8, -3.9, null, null],
        [-5.2, -5.1, -5.1, -5, -4.8, -4.5, -4.3, -4.2, -4.3, -4.5, -4.7, -4.8, null, null],
        [-9.5, -9.5, -9.5, -9.5, -9.2, -8.6, -8.2, -7.9, -7.7, -7.6, -7.5, -7.4, null, null],
        [-13.2, -13.4, -13.5, -13.5, -12.2, -10.7, -10.3, -10, -9.7, -9.5, null, -9.3, -9.2, null],
        [-12.1, -12.1, -12, -11.8, -11.4, -11.1, -10.8, -10.5, -10.3, null, null, null, null, null],
        [-10.3, -10.3, -10.2, -10.1, -10, -9.9, -9.8, -9.8, -9.7, null, null, null, null, null],
        [null, -8.9, -8.9, -8.9, -8.9, -8.8, -8.8, -8.8, -8.8, null, null, null, null, null],
        [null, -7.8, -7.8, -7.8, -7.8, -7.8, -7.8, -7.8, -7.8, -7.8, null, null, null, null],
        [null, -6.7, -6.7, -6.7, -6.7, -6.7, -6.7, -6.7, -6.7, -6.7, -6.7, null, null, null],
        [null, -5.6, -5.6, -5.6, -5.7, -5.7, -5.7, -5.7, -5.7, -5.7, -5.7, -5.7, null, null],
        [-4.6, -4.5, -4.5, -4.6, -4.6, -4.7, -4.8, -4.8, -4.8, -4.8, -4.8, -4.8, -4.8, -4.8],
        [null, -4, -4, -4.1, -4.1, -4.2, -4.2, -4.2, -4.2, -4.2, -4.2, -4.2, null, -4.2],
        [null, -3.7, -3.7, -3.8, -3.8, -3.8, -3.8, -3.7, -3.7, -3.7, -3.7, null, null, null],
        [null, -3.3, -3.3, -3.3, -3.3, -3.3, -3.3, -3.3, -3.3, -3.3, null, null, null, null],
        [null, null, -3.2, -3.1, -3.1, -3.1, -3.1, -3.1, -3.1, -3.1, -3.1, null, null, null],
        [null, null, null, null, -3.1, -3.1, -3.1, -3.1, -3.1, null, null, null, null, null]
      ]
    },
    // Knots added to TWS, by |TWA| (rows) and TWS (columns), laid out as the TWA table.
    // Masthead units read high downwind (the sails speed the air up over the rig), so this
    // mostly takes off.
    tws: {
      enabled: true,
      twa: TWA.slice(),
      tws: TWS.slice(),
      add: [
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, -0.08, -0.09, null, null, null, null, null, null, null],
        [0, -0.14, -0.17, -0.18, -0.19, -0.18, -0.21, -0.29, -0.31, null, null, null, null, null],
        [0, -0.2, -0.27, -0.32, -0.4, -0.47, -0.53, -0.61, -0.59, -0.51, null, null, null, null],
        [0, -0.27, -0.34, -0.43, -0.55, -0.59, -0.66, -0.72, -0.7, -0.62, null, null, null, null],
        [0, -0.35, -0.41, -0.55, -0.71, -0.72, -0.78, -0.83, -0.8, -0.71, null, -0.58, null, null],
        [0, -0.42, -0.48, -0.65, -0.83, -0.83, -0.87, -0.9, -0.87, -0.78, null, -0.65, null, null],
        [0, -0.45, -0.52, -0.73, -0.89, -0.9, -0.92, -0.93, -0.9, -0.81, -0.75, -0.69, null, null],
        [0, -0.49, -0.56, -0.73, -0.87, -0.89, -0.9, -0.92, -0.88, null, null, null, null, null],
        [0, -0.52, -0.58, -0.7, -0.78, -0.82, -0.84, -0.86, -0.84, null, null, null, null, null],
        [0, 0, -0.59, -0.65, -0.71, -0.76, -0.77, -0.8, -0.8, null, null, null, null, null],
        [0, 0, -0.6, -0.64, null, -0.75, -0.74, -0.77, null, null, null, null, null, null]
      ]
    }
  }
}

module.exports = { DEFAULTS }
