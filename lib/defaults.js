'use strict'

// Defaults for this boat, fitted to the 2025 races and checked against Jan–Mar 2026
// (see the README). Every value can be changed in the webapp; these are what a fresh
// install starts from.

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
    // boat speed (columns). The owner's measured heel x STW table resampled onto this
    // layout, port and starboard averaged. Blank cells are filled from the nearest value.
    stw: {
      enabled: true,
      heel: [0, 10, 20],
      stw: COLS.slice(),
      add: [
        [0, 0.05, 0, 0, 0, 0, 0],
        [0, 0.01, -0.03, -0.03, -0.03, -0.03, -0.03],
        [0, -0.08, -0.13, -0.13, -0.13, -0.13, -0.13]
      ]
    },
    // Leeway (degrees) = K x heel / STW^2, one K for every sail: downwind heel is
    // small, so leeway there is near zero whatever K is.
    leeway: { enabled: true, k: 7.9446 },
    // Degrees added to |TWA| by TWS; negative = TWA was reading too wide. Rows at TWA 40,
    // 90 and 165, linear between. From the owner's boatcal fit (made for rows at 70, 100
    // and 130: refit with boatcal plugincal); blank = too little data, filled from the
    // nearest measured cells in the row. The 0 kn column fades the correction out in no wind.
    twa: {
      enabled: true,
      tws: COLS.slice(),
      upwind: [0, -7.6, -12.6, -5.8, -5.7, 0.2, null],
      reach: [0, -2.4, -4.4, -5.4, 1.4, 3.9, 1.0],
      downwind: [0, 1.2, -3.5, 1.0, null, null, null]
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
