/** Metres of pull toward the head that opens the depth sheets all the way. */
export const PULL_FULL = 0.16

/** Pull, in metres, that the adhesive takes up before the corner lifts at all. */
export const PEEL_TACK = 0.015

/** Pull, in metres, that brings the peel to the mark: the curl reaches `detach` here. */
export const PEEL_MARK = 0.16

/** Pull, in metres, where the last of the adhesive lets go and the sticker pops free. */
export const PEEL_POP = 0.19

/** How much further the curl creeps while the last bit holds, between the mark and the pop. */
const PEEL_STRETCH = 0.06

/** Disc around each photo corner that starts a sticker peel. */
export const CORNER_REACH = 0.06

const HANDLE_W = 0.062
const HANDLE_H = 0.012

/** How far the mode mark sits above the top edge, clear of a corner peel on a small frame. */
const GEM_LIFT = 0.056
/** Pinch radius around the mode mark, in metres. */
const GEM_REACH = 0.028

export type FrameHit = 'handle' | 'corner' | 'photo' | 'gem' | 'miss'

/** Local point of the mode mark above a frame. */
export function gemPoint(halfH: number, strip: number): { x: number; y: number } {
  return { x: 0, y: halfH + strip + GEM_LIFT }
}

export interface CornerGrab {
  /** 0 top-right, then counter-clockwise. */
  id: 0 | 1 | 2 | 3
  x: number
  y: number
  /** Unit axis from the frame center toward this corner, in local XY. */
  axisX: number
  axisY: number
}

/** Local point on the frame plane. The handle wins over the photo along the bottom edge. */
export function classifyHit(x: number, y: number, halfW: number, halfH: number, strip: number): FrameHit {
  const hx = HANDLE_W * 0.62
  const hy = HANDLE_H * 1.6
  const handleY = -halfH - strip - HANDLE_H * 0.35
  if (Math.abs(x) <= hx && Math.abs(y - handleY) <= hy) return 'handle'
  const gem = gemPoint(halfH, strip)
  const gdx = x - gem.x
  const gdy = y - gem.y
  if (gdx * gdx + gdy * gdy <= GEM_REACH * GEM_REACH) return 'gem'
  if (nearestCorner(x, y, halfW, halfH)) return 'corner'
  if (Math.abs(x) <= halfW && Math.abs(y) <= halfH) return 'photo'
  return 'miss'
}

const CORNER_IDS = [0, 1, 2, 3] as const

/** The corner under a local point, or null when none is within {@link CORNER_REACH}. */
export function nearestCorner(x: number, y: number, halfW: number, halfH: number): CornerGrab | null {
  const corners: readonly (readonly [number, number])[] = [
    [halfW, halfH],
    [-halfW, halfH],
    [-halfW, -halfH],
    [halfW, -halfH],
  ]
  let best = -1
  let bestD = CORNER_REACH * CORNER_REACH
  for (let i = 0; i < corners.length; i++) {
    const dx = x - corners[i][0]
    const dy = y - corners[i][1]
    const d = dx * dx + dy * dy
    if (d <= bestD) {
      best = i
      bestD = d
    }
  }
  const id = CORNER_IDS[best]
  if (id === undefined) return null
  const cx = corners[best][0]
  const cy = corners[best][1]
  const len = Math.hypot(cx, cy) || 1
  return { id, x: cx, y: cy, axisX: cx / len, axisY: cy / len }
}

/** Half-diagonal of the photo along a unit peel axis. */
export function axisExtent(halfW: number, halfH: number, axisX: number, axisY: number): number {
  return halfW * Math.abs(axisX) + halfH * Math.abs(axisY)
}

/**
 * Fold coordinate along the peel axis. 0 leaves the photo flat (fold at the
 * corner). 1 has carried the fold to the far edge.
 */
export function foldForPeel(peel: number, extent: number): number {
  const t = peel < 0 ? 0 : peel > 1 ? 1 : peel
  return extent - t * (2 * extent)
}

/**
 * Pull away from the corner, in metres, as a sticker peel. Like a real sticker:
 * the first {@link PEEL_TACK} does nothing, then the peel follows the hand,
 * slow to start and firming up as it reaches `detach` at {@link PEEL_MARK}.
 * Past the mark the last bit holds and stretches a little until
 * {@link PEEL_POP}, where {@link peelsFree} lets it go.
 */
export function curlFromPull(pull: number, detach: number): number {
  if (pull <= PEEL_TACK) return 0
  if (pull < PEEL_MARK) return detach * smooth((pull - PEEL_TACK) / (PEEL_MARK - PEEL_TACK))
  const hold = pull >= PEEL_POP ? 1 : (pull - PEEL_MARK) / (PEEL_POP - PEEL_MARK)
  return Math.min(1, detach + PEEL_STRETCH * hold)
}

/** The pull has gone past the last of the adhesive: the sticker comes free. */
export function peelsFree(pull: number): boolean {
  return pull >= PEEL_POP
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
