'use strict'

// Defaults for this boat: the STW and TWA tables fitted by boatcal plugincal (1.2.0) on
// every labelled race leg from January 2025 to March 2026 (158 tacks, 27 gybes), each day
// held out in turn to check them. That is the boat before its September 2026 rig tune
// and October H2000 reset: refit with plugincal for the boat as it is now. Every value
// can be changed in the webapp; these are what a fresh install starts from.

// The H5000's table layout: TWS (and boat speed) columns 0 to 30 kn.
const COLS = [0, 5, 10, 15, 20, 25, 30]

const DEFAULTS = {
  mode: 'shadow', // 'shadow' publishes …Corrected paths; 'replace' publishes the standard paths
  // Degrees, east positive. Used only when nothing on the boat publishes
  // navigation.headingTrue or navigation.magneticVariation. Sydney.
  variation: 12.8,
  sources: { apparentWind: '', stw: '', heading: '', attitude: '', gps: '', variation: '' }, // '' = any but this plugin
  corrections: {
    // Boat speed / heel: knots added to STW, by heel either side (rows 0, 10, 20 deg) and
    // boat speed (columns), from the GPS. Blank = too little data (no sailing above about
    // 9 kn, little heel when slow): filled from the nearest value in its row. Relative to
    // the H2000's boat speed setting at the time (4.24): refit after changing it.
    stw: {
      enabled: true,
      heel: [0, 10, 20],
      stw: COLS.slice(),
      add: [
        [0.6, 0, 0.07, null, null, null, null],
        [0.57, 0.03, 0.12, null, null, null, null],
        [null, -0.2, -0.15, null, null, null, null]
      ]
    },
    // Leeway (degrees) = K x heel / STW^2, one K for every sail: downwind heel is
    // small, so leeway there is near zero whatever K is.
    leeway: { enabled: true, k: 7.9446 },
    // Degrees added to |TWA| by TWS; negative = TWA was reading too wide. Rows at TWA 40,
    // 90 and 165, linear between; blank = too little data, filled from the nearest measured
    // cells in the row. The 0 kn column fades the correction out in no wind. The 90 row is
    // the least certain: few reaching manoeuvres, so tacks at 45-55 deg and the tie to the
    // 40 row set most of it.
    twa: {
      enabled: true,
      tws: COLS.slice(),
      upwind: [0, -9.1, -13.3, -7, -5, -0.6, null],
      reach: [0, -9.8, -15.4, -8.5, -3.8, null, null],
      downwind: [0, 2.8, 0.7, -4.5, -0.2, null, null]
    },
    // Knots added to TWS by TWS (H5000 units: -10% of each column), downwind only: none
    // below 90 deg TWA, in full from the down angle. Blank = no correction. Off until
    // switched on.
    tws: {
      enabled: false,
      tws: COLS.slice(),
      correction: [0, -0.5, -1, -1.5, -2, -2.5, -3],
      downAngle: [165, 165, 165, 165, 165, 165, 165]
    }
  }
}

module.exports = { DEFAULTS }
