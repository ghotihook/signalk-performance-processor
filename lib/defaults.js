'use strict'

// Defaults for this boat, fitted to the 2025 races and checked against Jan–Mar 2026
// (see the README). Every value can be changed in the webapp; these are what a fresh
// install starts from.

const TWS_BINS = [5, 10, 15, 20, 25, 30]

const DEFAULTS = {
  mode: 'shadow', // 'shadow' publishes …Corrected paths; 'replace' publishes the standard paths
  // Degrees, east positive. Used only when nothing on the boat publishes
  // navigation.headingTrue or navigation.magneticVariation. Sydney.
  variation: 12.8,
  sources: { apparentWind: '', stw: '', heading: '', attitude: '', gps: '', variation: '' }, // '' = any but this plugin
  corrections: {
    stw: {
      enabled: true,
      // Knots added to STW, by signed heel (rows, + = starboard side down) and STW (columns).
      // The owner's measured heel x STW table; blank cells are filled from the nearest value.
      heel: [-35, -30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30, 35],
      stw: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5],
      add: [
        [null, null, null, null, null, null, null, null, null, null, null, -0.276, -0.283, -0.287, -0.291, -0.293, -0.294],
        [null, null, null, null, null, null, null, null, null, null, -0.266, -0.276, -0.283, -0.287, -0.291, -0.293, -0.294],
        [null, null, null, null, null, null, null, null, -0.139, -0.16, -0.175, -0.185, -0.192, -0.197, -0.2, -0.202, -0.203],
        [null, null, null, null, null, null, 0.009, -0.035, -0.065, -0.086, -0.101, -0.111, -0.118, -0.122, -0.126, -0.128, -0.129],
        [0.536, 0.555, 0.442, 0.315, 0.208, 0.125, 0.065, 0.022, -0.008, -0.029, -0.043, -0.053, -0.06, -0.065, -0.068, -0.07, -0.071],
        [0.552, 0.582, 0.474, 0.351, 0.246, 0.165, 0.105, 0.063, 0.033, 0.012, -0.002, -0.012, -0.019, -0.023, -0.026, -0.029, -0.03],
        [0.562, 0.597, 0.493, 0.372, 0.268, 0.188, 0.129, 0.087, 0.057, 0.037, 0.022, 0.013, 0.006, 0.001, -0.002, -0.004, -0.005],
        [0.565, 0.602, 0.5, 0.379, 0.276, 0.196, 0.137, 0.095, 0.065, 0.045, 0.031, 0.021, 0.014, 0.01, 0.007, 0.004, 0.003],
        [0.562, 0.597, 0.494, 0.372, 0.269, 0.188, 0.129, 0.087, 0.057, 0.037, 0.023, 0.013, 0.006, 0.002, -0.001, -0.004, -0.005],
        [0.552, 0.582, 0.475, 0.352, 0.246, 0.165, 0.106, 0.063, 0.034, 0.013, -0.001, -0.011, -0.018, -0.023, -0.026, -0.028, -0.029],
        [0.536, 0.557, 0.444, 0.317, 0.21, 0.127, 0.067, 0.024, -0.006, -0.027, -0.042, -0.051, -0.058, -0.063, -0.066, -0.068, -0.069],
        [null, null, null, null, null, null, 0.012, -0.031, -0.062, -0.083, -0.098, -0.108, -0.114, -0.119, -0.122, -0.124, -0.126],
        [null, null, null, null, null, null, null, null, -0.133, -0.155, -0.17, -0.18, -0.187, -0.191, -0.194, -0.197, -0.198],
        [null, null, null, null, null, null, null, null, null, null, -0.258, -0.268, -0.275, -0.28, -0.283, -0.285, -0.286],
        [null, null, null, null, null, null, null, null, null, null, null, -0.268, -0.275, -0.28, -0.283, -0.285, -0.286]
      ]
    },
    // Leeway (degrees) = K x heel / STW^2, one K for every sail: downwind heel is
    // small, so leeway there is near zero whatever K is.
    leeway: { enabled: true, k: 7.9446 },
    // Degrees added to |TWA| by TWS; negative = TWA was reading too wide. From the
    // owner's boatcal fit; blank = too little data, filled from the nearest measured
    // cells in the row. Rows are blended by TWA: upwind in full to angles.upwind, reach
    // at angles.reach, downwind from angles.downwind. The TWS table shares these angles.
    twa: {
      enabled: true,
      tws: TWS_BINS.slice(),
      upwind: [-7.6, -12.6, -5.8, -5.7, 0.2, null],
      reach: [-2.4, -4.4, -5.4, 1.4, 3.9, 1.0],
      downwind: [1.2, -3.5, 1.0, null, null, null],
      angles: { upwind: 70, reach: 100, downwind: 130 }
    },
    // Knots added to TWS by TWS, same rows and blending as the TWA table (H5000 units).
    // Downwind: -10% of each column. Blank = no correction. Off until switched on.
    tws: {
      enabled: false,
      tws: TWS_BINS.slice(),
      upwind: [null, null, null, null, null, null],
      reach: [null, null, null, null, null, null],
      downwind: [-0.5, -1, -1.5, -2, -2.5, -3]
    }
  }
}

module.exports = { DEFAULTS }
