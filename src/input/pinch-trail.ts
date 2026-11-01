/**
 * The last moments of one pinch. Opening the fingers drags the pinch point a
 * centimetre or two before the pinch reads as released, so a release looks
 * back to the moment the fingers were tightest and uses that point instead.
 *
 * No imports, so the node test can load it directly.
 */
const SIZE = 32

export interface TrailPoint {
  x: number
  y: number
  z: number
}

export class PinchTrail {
  private readonly t = new Float64Array(SIZE)
  private readonly gap = new Float64Array(SIZE)
  private readonly pos = new Float64Array(SIZE * 3)
  private head = -1
  private count = 0

  clear(): void {
    this.head = -1
    this.count = 0
  }

  /** `gap` is the thumb-to-index distance: smaller is a tighter pinch. */
  push(t: number, x: number, y: number, z: number, gap: number): void {
    this.head = (this.head + 1) % SIZE
    this.count = Math.min(SIZE, this.count + 1)
    this.t[this.head] = t
    this.gap[this.head] = gap
    const o = this.head * 3
    this.pos[o] = x
    this.pos[o + 1] = y
    this.pos[o + 2] = z
  }

  /**
   * Where the pinch was when it was tightest within the last `window` seconds
   * before `now`. False when there is nothing to look back on.
   */
  rewind(now: number, window: number, out: TrailPoint): boolean {
    if (this.count === 0) return false
    let best = -1
    let bestGap = Infinity
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - i + SIZE) % SIZE
      if (now - this.t[idx] > window) break
      // Ties go to the newest sample, so a steady pinch keeps its latest point.
      if (this.gap[idx] < bestGap) {
        bestGap = this.gap[idx]
        best = idx
      }
    }
    if (best < 0) return false
    const o = best * 3
    out.x = this.pos[o]
    out.y = this.pos[o + 1]
    out.z = this.pos[o + 2]
    return true
  }
}
