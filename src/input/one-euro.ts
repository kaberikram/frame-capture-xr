/**
 * One Euro filter (Casiez, Roussel, Vogel 2012) on a 3D point. At rest it
 * smooths hard, so tracking jitter disappears; as the hand speeds up the
 * cutoff rises, so a fast move is followed with little lag.
 *
 * No imports, so the node test can load it directly.
 */
export interface Point3 {
  x: number
  y: number
  z: number
}

export class OneEuro3 {
  private has = false
  private lastT = 0
  private readonly x: Point3 = { x: 0, y: 0, z: 0 }
  private readonly dx: Point3 = { x: 0, y: 0, z: 0 }
  private readonly minCutoff: number
  private readonly beta: number
  private readonly dCutoff: number

  /**
   * @param minCutoff Hz at rest. Lower is smoother and laggier when still.
   * @param beta How fast the cutoff rises with speed (per m/s).
   * @param dCutoff Hz for the speed estimate itself.
   */
  constructor(minCutoff = 1.2, beta = 6, dCutoff = 1) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.dCutoff = dCutoff
  }

  reset(): void {
    this.has = false
  }

  /** Filter a sample taken at `t` seconds. Writes the smoothed point to `out` and returns it. */
  filter(x: number, y: number, z: number, t: number, out: Point3): Point3 {
    if (!this.has || t <= this.lastT) {
      const first = !this.has
      this.has = true
      this.lastT = t
      if (first) {
        this.x.x = x
        this.x.y = y
        this.x.z = z
        this.dx.x = 0
        this.dx.y = 0
        this.dx.z = 0
      }
      out.x = this.x.x
      out.y = this.x.y
      out.z = this.x.z
      return out
    }
    const dt = Math.min(0.1, t - this.lastT)
    this.lastT = t
    const ad = alpha(this.dCutoff, dt)
    this.dx.x += ad * ((x - this.x.x) / dt - this.dx.x)
    this.dx.y += ad * ((y - this.x.y) / dt - this.dx.y)
    this.dx.z += ad * ((z - this.x.z) / dt - this.dx.z)
    const speed = Math.hypot(this.dx.x, this.dx.y, this.dx.z)
    const a = alpha(this.minCutoff + this.beta * speed, dt)
    this.x.x += a * (x - this.x.x)
    this.x.y += a * (y - this.x.y)
    this.x.z += a * (z - this.x.z)
    out.x = this.x.x
    out.y = this.x.y
    out.z = this.x.z
    return out
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff)
  return 1 / (1 + tau / dt)
}
