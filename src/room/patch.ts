/**
 * The piece of the room that comes away in your fingers. Distances are metres.
 * This file is plain maths so it can be tested without three.js.
 */

/** Grid points along one side of a piece. */
export const PIECE_N = 25
/** Half the width of the grid. A little wider than the largest piece, so its torn edge has room. */
export const PIECE_SPAN = 0.2
/** Radius of the coin that shows the moment you pinch. */
export const PIECE_MIN = 0.03
/** Radius at a full pull. */
export const PIECE_MAX = 0.16
/** The first bit of pull does nothing, like the tack of glue. */
export const TACK = 0.012
/** Let go with less pull than this and the piece settles back into the wall. */
export const TEAR = 0.03
/** Pull this far and the piece pops free in your hand. */
export const POP = 0.18
/** How much of the pull the torn rim follows while the middle is in your fingers. */
export const RIM_LIFT = 0.3
/** A pinch this close to the surface is on it. */
export const TOUCH_GAP = 0.1
/** A carried piece this close to a surface can be laid on it. */
export const STICK_GAP = 0.09
/** How far a surface's bumps are followed either side of the pinch plane. */
export const RELIEF_REACH = 0.07

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Basis {
  tx: number
  ty: number
  tz: number
  bx: number
  by: number
  bz: number
}

/** Two unit directions across a surface that faces `n`. On a wall the second one points up. */
export function tangentBasis(nx: number, ny: number, nz: number): Basis {
  // Up is the reference, unless the surface itself faces up or down.
  const flat = Math.abs(ny) > 0.9
  const rx = flat ? 0 : 0
  const ry = flat ? 0 : 1
  const rz = flat ? -1 : 0
  // tangent = reference × normal, bitangent = normal × tangent.
  let tx = ry * nz - rz * ny
  let ty = rz * nx - rx * nz
  let tz = rx * ny - ry * nx
  const tl = Math.hypot(tx, ty, tz) || 1
  tx /= tl
  ty /= tl
  tz /= tl
  return {
    tx,
    ty,
    tz,
    bx: ny * tz - nz * ty,
    by: nz * tx - nx * tz,
    bz: nx * ty - ny * tx,
  }
}

/**
 * The same, but keeping `keep` as the across direction where it can, so a
 * piece carried from one wall to another does not spin on the way.
 */
export function basisKeeping(nx: number, ny: number, nz: number, kx: number, ky: number, kz: number): Basis {
  const along = kx * nx + ky * ny + kz * nz
  let tx = kx - nx * along
  let ty = ky - ny * along
  let tz = kz - nz * along
  const tl = Math.hypot(tx, ty, tz)
  if (tl < 0.2) return tangentBasis(nx, ny, nz)
  tx /= tl
  ty /= tl
  tz /= tl
  return {
    tx,
    ty,
    tz,
    bx: ny * tz - nz * ty,
    by: nz * tx - nx * tz,
    bz: nx * ty - ny * tx,
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

function smooth(x: number): number {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

/** 0 until the tack gives, then up to 1 at the pop. */
export function pullAmount(pull: number, scale = 1): number {
  return clamp01((pull - TACK * scale) / ((POP - TACK) * scale))
}

/**
 * How big the piece is for this much pull. A coin appears as soon as you
 * pinch, holds through the tack, then grows quickly at first and more slowly
 * as it nears full size, the way a tear runs.
 */
export function pieceRadius(pull: number, scale = 1): number {
  if (pull <= TACK * scale) return PIECE_MIN * smooth(pull / (TACK * scale * 0.6))
  const k = pullAmount(pull, scale)
  const eased = 1 - (1 - k) * (1 - k)
  return PIECE_MIN + (PIECE_MAX - PIECE_MIN) * eased
}

export type Fate = 'settle' | 'tear' | 'pop'

/** What letting go (or pulling on) does at this much pull. */
export function peelFate(pull: number, scale = 1): Fate {
  if (pull < TEAR * scale) return 'settle'
  if (pull < POP * scale) return 'tear'
  return 'pop'
}

/**
 * How much of the pull a point of the piece follows: all of it at the pinch,
 * `RIM_LIFT` of it at the torn rim. `free` (0 to 1) carries the whole piece
 * along once it has come away. The piece shader does the same sum.
 */
export function liftWeight(dist: number, radius: number, free: number): number {
  const k = radius > 1e-5 ? clamp01(dist / radius) : 1
  const bump = 1 - k * k * (3 - 2 * k)
  const held = RIM_LIFT + (1 - RIM_LIFT) * bump
  return held + (1 - held) * clamp01(free)
}

/** Local x or y of grid line `i`, from -PIECE_SPAN to PIECE_SPAN. */
export function gridAt(i: number): number {
  return (i / (PIECE_N - 1)) * 2 * PIECE_SPAN - PIECE_SPAN
}

/**
 * Fill the heights nobody could read (NaN) from their neighbours, then soften
 * the lot once, so depth noise does not crease the piece. Heights are metres
 * off the pinch plane, row by row.
 */
export function settleHeights(h: Float32Array, n = PIECE_N): void {
  let known = 0
  for (let i = 0; i < h.length; i++) if (h[i] === h[i]) known++
  if (known === 0) {
    h.fill(0)
    return
  }
  const next = new Float32Array(h.length)
  for (let pass = 0; pass < n && known < h.length; pass++) {
    next.set(h)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = i + j * n
        if (h[k] === h[k]) continue
        let sum = 0
        let count = 0
        if (i > 0 && h[k - 1] === h[k - 1]) { sum += h[k - 1]; count++ }
        if (i < n - 1 && h[k + 1] === h[k + 1]) { sum += h[k + 1]; count++ }
        if (j > 0 && h[k - n] === h[k - n]) { sum += h[k - n]; count++ }
        if (j < n - 1 && h[k + n] === h[k + n]) { sum += h[k + n]; count++ }
        if (count === 0) continue
        next[k] = sum / count
        known++
      }
    }
    h.set(next)
  }
  next.set(h)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let sum = 0
      let weight = 0
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const x = i + di
          const y = j + dj
          if (x < 0 || y < 0 || x >= n || y >= n) continue
          const w = di === 0 && dj === 0 ? 4 : di === 0 || dj === 0 ? 2 : 1
          sum += next[x + y * n] * w
          weight += w
        }
      }
      h[i + j * n] = sum / weight
    }
  }
}

/**
 * Can a carried piece be laid down here? Not back on the spot it was just
 * torn from, unless it has been somewhere else since.
 */
export function canLand(fromSource: number, radius: number, travelled: boolean): boolean {
  return travelled || fromSource > radius * 0.75
}
