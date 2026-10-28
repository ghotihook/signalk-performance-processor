'use strict'

// Defaults for this boat, fitted to the 2025 races and checked against Jan–Mar 2026
// (see the README). Every value can be changed in the webapp; these are what a fresh
// install starts from.

const TWS_BINS = [5, 10, 15, 20, 25, 30]

const DEFAULTS = {
  mode: 'shadow', // 'shadow' publishes …Corrected paths; 'replace' publishes the standard paths
  variation: 12.8, // degrees, east positive; Sydney
  sources: { apparentWind: '', stw: '', heading: '', attitude: '', gps: '' }, // '' = any but this plugin
  corrections: {
    // Knots added to STW: linearity by speed, plus heel correction by |heel|.
    // The 185-cell heel x STW table reduced to two rows (every cell within 0.03 kn).
    stw: {
      enabled: true,
      linearity: { stw: [0.5, 1, 2, 3, 4, 6, 8.5], add: [0.58, 0.61, 0.38, 0.19, 0.09, 0.02, 0.00] },
      heel: { heel: [0, 10, 20, 30, 35], add: [0.00, -0.03, -0.13, -0.29, -0.29] }
    },
    // Leeway (degrees) = K x heel / STW^2, one K for every sail: downwind heel is
    // small, so leeway there is near zero whatever K is.
    leeway: { enabled: true, k: 7.9446 },
    // Degrees added to |TWA| by TWS; negative = TWA was reading too wide.
    // Rows are blended by TWA: upwind in full to angles.upwind, reach at angles.reach,
    // downwind from angles.downwind. The TWS table shares these angles.
    twa: {
      enabled: true,
      tws: TWS_BINS.slice(),
      upwind: [-12.0, -13.4, -5.7, -4.3, -4.3, -4.3],
      reach: [-10.7, -10.7, -10.7, -10.7, -10.7, -10.7],
      downwind: [-4.2, -3.5, -1.6, -1.3, -1.3, -1.3],
      angles: { upwind: 70, reach: 100, downwind: 130 }
    },
    // Percent applied to TWS by TWS, same rows and blending as the TWA table.
    // Off by default: light air fitted to implausible values, so it is zeroed here.
    tws: {
      enabled: false,
      tws: TWS_BINS.slice(),
      upwind: [0, 0, 0, 0, 0, 0],
      reach: [0, 0, 0, 0, 0, 0],
      downwind: [0, 0, -11.1, -14.4, -14.4, -14.4]
    }
  }
}

module.exports = { DEFAULTS }
