/** How fast a hand must cross the glass, metres per second, to count as a flick. */
export const FLICK_SPEED = 1.05
/** A hand this far from the plane, metres, is passing by, not flicking through. */
export const FLICK_NEAR = 0.12

/** Visual stretch of the time pattern, relative to the span the hands started at. */
export const STRETCH_MIN = 0.55
export const STRETCH_MAX = 1.8

/** Inside the photo, a point this close to the edge is the rim, not the picture. */
export const RIM_BAND = 0.05
/** A pinch this far outside the photo still counts as holding the rim. */
export const RIM_OUT = 0.035
/** Corners belong to the peel, so a stretch never starts there. */
export const CORNER_KEEP = 0.07
/** A hand must be this close to the glass, metres, to hold or flick it. */
export const PLANE_NEAR = 0.08

/** Dot with the direction to the viewer that shows the menu, and the lower dot that hides it. */
export const PALM_SHOW = 0.78
export const PALM_HIDE = 0.42

/** Hands this far apart, metres, are holding the frame rather than pinching one spot. */
export const HOLD_SPAN = 0.12

/** 1 when the hands have not moved. Further apart grows it, closer shrinks it, both clamped. */
export function stretchScale(baseSpan: number, span: number): number {
  if (baseSpan < 0.04) return 1
  const t = span / baseSpan
  if (t < STRETCH_MIN) return STRETCH_MIN
  if (t > STRETCH_MAX) return STRETCH_MAX
  return t
}

/** Move `current` toward `target`. `tau` is seconds; a tiny tau snaps. */
export function easeToward(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0.0001) return target
  const k = 1 - Math.exp(-Math.max(0, dt) / tau)
  return current + (target - current) * k
}

/**
 * A local point on the rim of a frame: near the edge, clear of the corners
 * and of the handle under the bottom edge. The picture's middle is not a rim.
 */
export function onRim(x: number, y: number, halfW: number, halfH: number): boolean {
  if (Math.abs(x) > halfW + RIM_OUT || Math.abs(y) > halfH + RIM_OUT) return false
  const corners: readonly (readonly [number, number])[] = [
    [halfW, halfH],
    [-halfW, halfH],
    [-halfW, -halfH],
    [halfW, -halfH],
  ]
  for (let i = 0; i < corners.length; i++) {
    const dx = x - corners[i][0]
    const dy = y - corners[i][1]
    if (dx * dx + dy * dy < CORNER_KEEP * CORNER_KEEP) return false
  }
  if (Math.abs(x) < 0.05 && y < -halfH) return false
  const edge = Math.min(halfW - Math.abs(x), halfH - Math.abs(y))
  return edge < RIM_BAND
}

export function insideRect(x: number, y: number, halfW: number, halfH: number): boolean {
  return Math.abs(x) <= halfW && Math.abs(y) <= halfH
}

/**
 * True when a hand crossed the glass this frame, quickly, and was already
 * close. A hitch, a teleport, or a slow drift does not count.
 */
export function flickCross(prevZ: number, z: number, dt: number): boolean {
  if (dt <= 0.001 || dt > 0.08) return false
  if (Math.abs(prevZ) > FLICK_NEAR || Math.abs(z) > FLICK_NEAR) return false
  if (prevZ * z >= 0) return false
  return Math.abs(z - prevZ) / dt >= FLICK_SPEED
}

/** Hysteresis so the menu does not flicker as the palm turns. */
export function palmShown(dotUp: number, shown: boolean): boolean {
  if (shown) return dotUp > PALM_HIDE
  return dotUp > PALM_SHOW
}

/** Tile size, metres. A short stack of these sits on the thumb side of the palm. */
export const TILE_W = 0.048
export const TILE_H = 0.02
export const TILE_GAP = 0.0035
/** A fingertip within this of a tile, metres, grows the tether. Closer than the tile slab touches it. */
export const TETHER_REACH = 0.07

/** Local centre of a tile. Index 0 is the top of the stack, toward the fingers. */
export function tileCenter(index: number, count: number): { x: number; y: number } {
  const step = TILE_H + TILE_GAP
  const span = Math.max(1, count) * step - TILE_GAP
  return { x: 0, y: span * 0.5 - TILE_H * 0.5 - index * step }
}

export interface TilePick {
  index: number
  /** 0 at the edge of reach, 1 on the tile. */
  near: number
  touch: boolean
}

const TILE_NONE: TilePick = { index: -1, near: 0, touch: false }

/**
 * Which tile a fingertip is near, in the menu's local metres.
 * `z` is the distance off the tile plane. Outside the reach, nothing is chosen.
 */
export function tilePick(x: number, y: number, z: number, count: number): TilePick {
  if (count < 1 || Math.abs(z) > 0.04) return TILE_NONE
  let best = -1
  let bestD = TETHER_REACH
  for (let i = 0; i < count; i++) {
    const c = tileCenter(i, count)
    const dx = Math.abs(x - c.x) - TILE_W * 0.5
    const dy = Math.abs(y - c.y) - TILE_H * 0.5
    const d = Math.hypot(dx > 0 ? dx : 0, dy > 0 ? dy : 0, z)
    if (d < bestD) {
      best = i
      bestD = d
    }
  }
  if (best < 0) return TILE_NONE
  const c = tileCenter(best, count)
  const touch =
    Math.abs(z) <= 0.014 &&
    Math.abs(x - c.x) <= TILE_W * 0.5 + 0.003 &&
    Math.abs(y - c.y) <= TILE_H * 0.5 + 0.003
  const near = 1 - bestD / TETHER_REACH
  return { index: best, near: near < 0 ? 0 : near, touch }
}
