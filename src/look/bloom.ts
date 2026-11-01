/**
 * How a relief comes out of its frame: a damped spring that overshoots by
 * about 4% and settles by `duration`, so the photo breathes out instead of
 * stopping dead. No imports, so the node test can load it directly.
 */
const ZETA = 0.72

/** 0 at t <= 0, rising past 1 and settling back. `duration` is the settle time in seconds. */
export function bloom(t: number, duration: number): number {
  if (t <= 0) return 0
  const d = duration < 0.05 ? 0.05 : duration
  const omega = 4 / (ZETA * d)
  const root = Math.sqrt(1 - ZETA * ZETA)
  const wd = omega * root
  return 1 - Math.exp(-ZETA * omega * t) * (Math.cos(wd * t) + (ZETA / root) * Math.sin(wd * t))
}

/** 0..1 progress through a bloom, without the overshoot. Logic gates use this. */
export function bloomProgress(t: number, duration: number): number {
  if (t <= 0) return 0
  const d = duration < 0.05 ? 0.05 : duration
  const x = t / d
  if (x >= 1) return 1
  return 1 - (1 - x) ** 3
}
