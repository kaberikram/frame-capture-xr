/** Metres of pull toward the head that opens the stack all the way. */
export const PULL_FULL = 0.16

const HANDLE_W = 0.062
const HANDLE_H = 0.012

export type FrameHit = 'handle' | 'photo' | 'miss'

/** Local point on the frame plane. The handle wins over the photo along the bottom edge. */
export function classifyHit(x: number, y: number, halfW: number, halfH: number, strip: number): FrameHit {
  const hx = HANDLE_W * 0.62
  const hy = HANDLE_H * 1.6
  const handleY = -halfH - strip - HANDLE_H * 0.35
  if (Math.abs(x) <= hx && Math.abs(y - handleY) <= hy) return 'handle'
  if (Math.abs(x) <= halfW && Math.abs(y) <= halfH) return 'photo'
  return 'miss'
}

/**
 * Pull toward the head, clamped and eased, as a 0..1 spread.
 * Negative pull (pushing back into the frame) stays closed.
 */
export function spreadFromPull(pull: number): number {
  const t = pull <= 0 ? 0 : pull >= PULL_FULL ? 1 : pull / PULL_FULL
  return smooth(t)
}

/**
 * Soft spring back to a closed stack. Slightly underdamped so it settles
 * instead of stopping dead.
 */
export function springStep(spread: number, velocity: number, stiffness: number, dt: number): { spread: number; velocity: number } {
  const k = stiffness < 1 ? 1 : stiffness
  const damp = 1.65 * Math.sqrt(k)
  const v = velocity + (-k * spread - damp * velocity) * dt
  const s = spread + v * dt
  if (s <= 0) return { spread: 0, velocity: 0 }
  if (s < 0.0008 && Math.abs(v) < 0.0008) return { spread: 0, velocity: 0 }
  return { spread: s, velocity: v }
}

function smooth(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}
