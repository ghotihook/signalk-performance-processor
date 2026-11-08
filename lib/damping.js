'use strict'

// Damping, H5000 style: each output follows its input with a time constant in seconds,
// 0 meaning none. Exponential smoothing over the real time between updates, so it
// responds the same whatever the update rate (wind at 2 Hz, STW at 3.6 Hz) and however
// irregular. After a gap longer than both RESET_S and the time constant, the next value is
// taken as it is, rather than blended with something stale; a shorter gap keeps a long
// average (current over 2 minutes) through a dropout of a few seconds.

const RESET_S = 10
const gapResets = (dtMs, tau) => dtMs > Math.max(RESET_S, tau) * 1000

const alpha = (dt, tau) => tau > 0 ? 1 - Math.exp(-dt / tau) : 1

// A quantity on a line: speed, heel.
class Smooth {
  constructor () { this.reset() }
  reset () { this.v = null; this.t = null }
  // x at time t (ms); returns the smoothed value. A repeat of the same time returns the
  // current value unchanged.
  update (x, t, tau) {
    if (x == null || !Number.isFinite(x)) return this.v
    if (this.v === null || !(tau > 0) || gapResets(t - this.t, tau)) {
      this.v = x
    } else if (t > this.t) {
      this.v += alpha((t - this.t) / 1000, tau) * (x - this.v)
    } else {
      return this.v
    }
    this.t = t
    return this.v
  }
}

// A direction in degrees, smoothed on the unit circle so 359 and 1 average to 0, not 180.
class SmoothAngle {
  constructor () { this.reset() }
  reset () { this.x = null; this.y = null; this.t = null }
  update (deg, t, tau) {
    if (deg == null || !Number.isFinite(deg)) return this.value()
    const r = deg * Math.PI / 180
    const sx = Math.sin(r); const sy = Math.cos(r)
    if (this.x === null || !(tau > 0) || gapResets(t - this.t, tau)) {
      this.x = sx; this.y = sy
    } else if (t > this.t) {
      const a = alpha((t - this.t) / 1000, tau)
      this.x += a * (sx - this.x); this.y += a * (sy - this.y)
    } else {
      return this.value()
    }
    this.t = t
    return this.value()
  }
  value () {
    if (this.x === null) return null
    return ((Math.atan2(this.x, this.y) * 180 / Math.PI) % 360 + 360) % 360
  }
}

// A vector given as speed and direction (current: drift and set), smoothed as a vector.
class SmoothVector {
  constructor () { this.reset() }
  reset () { this.e = new Smooth(); this.n = new Smooth() }
  update (speed, deg, t, tau) {
    if (speed == null || deg == null) return null
    const r = deg * Math.PI / 180
    const e = this.e.update(speed * Math.sin(r), t, tau)
    const n = this.n.update(speed * Math.cos(r), t, tau)
    if (e == null || n == null) return null
    return { speed: Math.hypot(e, n), deg: ((Math.atan2(e, n) * 180 / Math.PI) % 360 + 360) % 360 }
  }
}

module.exports = { Smooth, SmoothAngle, SmoothVector }
