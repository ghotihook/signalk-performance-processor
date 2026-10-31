'use strict'

// Defaults for this boat, in the H5000's 2018 table layout with a 1 kn boat speed column: the
// STW table, leeway K, and the TWA and TWS tables, fitted by boatcal plugincal (1.3.3) on
// every labelled race leg from January 2025 to March 2026 (the STW table and K adding the
// sailing under 2.5 kn from those days, where the paddlewheel stalls), each day held out in
// turn to check them. 2026-01-16 is left out: its paddlewheel read 130% off.
//   python -m plugincal --since 2025-01-01 --until 2026-03-31 --labelled --exclude 2026-01-16
// That is the boat before its September 2026 rig tune and October H2000 reset: refit with
// plugincal for the boat as it is now. Every value can be changed in the webapp; these are
// what a fresh install starts from.

const SPEEDS = [1, 2.5, 5, 7.5, 10, 12.5, 15] // boat speed table columns, kn
const TWS_COLS = [5, 10, 15, 20, 25, 30] // TWA and TWS table columns, kn

const DEFAULTS = {
  mode: 'shadow', // 'shadow' publishes …Corrected paths; 'replace' publishes the standard paths
  // Degrees, east positive. Used only when nothing on the boat publishes
  // navigation.headingTrue or navigation.magneticVariation. Sydney.
  variation: 12.8,
  sources: { apparentWind: '', stw: '', heading: '', attitude: '', gps: '', variation: '' }, // '' = any but this plugin
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
    // Boat speed / heel: knots added to STW, by heel (rows -20 to 20, + = starboard side
    // down) and boat speed (columns), from the GPS; from zero at 0 kn below the first
    // column. Blank = too little data: filled from the nearest value in its row. Relative to
    // the H2000's boat speed setting at the time (4.24): refit after changing it.
    stw: {
      enabled: true,
      heel: [-20, -10, 0, 10, 20],
      stw: SPEEDS.slice(),
      add: [
        [null, null, -0.27, 0.04, null, null, null],
        [0.68, 0.36, 0.05, 0.09, null, null, null],
        [0.62, 0.29, -0.01, 0.02, null, null, null],
        [0.58, 0.2, 0.02, -0.03, null, null, null],
        [null, null, -0.1, -0.31, null, null, null]
      ]
    },
    // Leeway (degrees) = K x heel / STW^2, one K for every sail: downwind heel is
    // small, so leeway there is near zero whatever K is. Published, and used for
    // current; not used in true wind (the TWA table takes up its effect).
    leeway: { enabled: true, k: 8.321 },
    // Degrees added to |TWA| by TWS (columns 5 to 30 kn); negative = TWA was reading too wide.
    // Rows at TWA 40, 90 and 165, linear between; each row from zero at 0 kn below 5 kn. Blank =
    // too little data, filled from the nearest value in its row.
    twa: {
      enabled: true,
      tws: TWS_COLS.slice(),
      upwind: [-10.4, -10.6, -4.4, -3.9, -4, null],
      reach: [-12.7, -12.7, -12.1, -11.4, null, null],
      downwind: [0, -0.2, -0.5, -0.4, null, null]
    },
    // Knots added to TWS by TWS: the upwind correction up to the up angle, reaching at 90,
    // downwind from the down angle, linear between; from zero at 0 kn. Masthead units read
    // high downwind (the sails speed the air up over the rig), so this mostly takes off.
    tws: {
      enabled: true,
      tws: TWS_COLS.slice(),
      upwind: [0, 0, 0, 0, 0, 0],
      reach: [0, 0.33, -2.84, null, null, null],
      downwind: [0, -1.91, -2.06, null, null, null],
      upAngle: [50, 50, 50, 50, 50, 50],
      downAngle: [150, 150, 150, 150, 150, 150]
    }
  }
}

module.exports = { DEFAULTS }
