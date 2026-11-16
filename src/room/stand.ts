/**
 * Fit a thing standing on a level surface (a box, a can, a stack of cases)
 * as a clean solid: a box, a round, or a prism with a star-shaped outline,
 * with straight walls down to the surface and a flat or gently shaped top.
 *
 * It reads the same block of the distance field the lift reads. Looking down
 * each column of voxels gives a height map. The surface the thing stands on is
 * the nearest big level height below the pinch, and the outline is where the
 * height map rises above it. Each side is then moved to where its wall was
 * really seen. A side facing away from the eye was never seen: its edge comes
 * from the height map, pulled in by how far that edge smears. Balls, vases,
 * and patches cut off by the edge of what was seen are left to `liftShell`.
 *
 * The room's space is level (y is up), so the surface is taken as level. This
 * file is plain maths, so it is tested without three.js.
 */

import type { FieldBlock, FieldWindow, Shell } from './object.js'
import { OBJECT_REACH, STAND_AREA, TABLE_AREA, readWindow } from './object.js'

/** Footprint cells, metres. */
const FOOT = 0.01
/** A thing rises at least this far above what it stands on, metres. */
const H_MIN = 0.012
/** Bins of the height count that finds the surface, metres. */
const PLANE_BIN = 0.005
/** Column tops this close to a level are on it, metres. */
const PLANE_BAND = 0.012
/** The biggest footprint fitted, m². A whole side table is not lifted as a box. */
const FOOT_MAX = 0.12
/** At least this share of the outline must have the surface seen just outside it. */
const SEEN_MIN = 0.45
/** Walls that stand this much further in low down than half way up belong to a ball or a vase, metres. */
const TAPER_MAX = 0.018
/**
 * Walls that stand this much further in high up than half way up belong to a
 * vase's shoulder or a bottle's neck, metres. Fused boxes and cans draw in at
 * most 6 mm there; the desk's vase, sunk in its stand, 23 mm.
 */
const NARROW_MAX = 0.012
/** A top whose heights spread less than this is flat, metres. */
const FLAT_MAD = 0.006
/** A box's outline strays from a rectangle by at most this, in voxels (the median). */
const BOX_RES = 0.45
/** A round must fit the outline this much better than a rectangle does. */
const ROUND_RATIO = 0.8
/**
 * Or the walls depth saw, at the three-quarter mark of how far they stray.
 * Measured on fused boxes and cans: boxes never below 0.94, cans never above 0.83.
 */
const WALL_ROUND = 0.88
/** The walls depth saw stray from a box or a round by at most this, in voxels (the median). Fused boxes: up to 0.25. */
const WALL_FIT = 0.3
/**
 * How far past the thing the height map's edge runs on a side facing away
 * from the eye, in voxels. Depth sees that top edge only against what is
 * behind it, and the edge smears into the hidden space. Tuned on fused
 * synthetic views from 34 to 67 degrees down. `?standfar=` can override it.
 */
export const FAR_K = 0.9
/** A round's far rim curves away from the eye and smears about half as far as a box's straight edge. */
const ROUND_PULL = 0.55
/** A wall depth saw crosses zero this far outside the real one, in voxels (fused views: 0.4 to 1.6 mm at 2 cm). */
const WALL_BIAS = 0.05
/** The walls stop this far above the surface, metres, so a copy set down does not flicker into it. */
export const BASE_GAP = 0.002
/** Round on a box's corners, metres. */
const CORNER = 0.005
/** Most room between the top's rings, the walls' rows, and the points along a side, metres. */
const RING = 0.02
/** The edge value of the base ring: a warm contact line on the ghost, and a copy that stays nearly opaque. */
export const BASE_EDGE = 0.88
/** Directions in a prism's outline. */
const RAYS = 64
/** Seconds a shape is held through missed fits while the pinch stays on it. */
const HOLD = 1.0

let farK = FAR_K

/**
 * Set the far-side shrink, in voxels, for tuning on the headset: the `?standfar=`
 * flag as it comes, so a missing flag or anything that is not a number of 0 or
 * more keeps the default.
 */
export function setStandFar(k: number | string | null | undefined): void {
  const value = typeof k === 'string' ? (k.trim() === '' ? NaN : Number(k)) : k ?? NaN
  farK = Number.isFinite(value) && value >= 0 ? value : FAR_K
}

/** The far-side shrink in use, in voxels. */
export function standFar(): number {
  return farK
}

/** A thing standing on a level surface, as a simple solid. */
export interface StandFit {
  shape: 'box' | 'round' | 'prism'
  /** Height of the surface it stands on, metres. */
  plane: number
  /** Height of its top: the middle of the heights well inside it, metres. */
  top: number
  flat: boolean
  /** How much the top's heights spread (median distance from their middle), metres. */
  mad: number
  /** Its middle, metres. */
  cx: number
  cz: number
  /** Turn of its own frame about up, radians: its first side runs along (cos, sin) in x and z. */
  angle: number
  /** Half its size along its own frame: for a box its sides, for a round its radius, for a prism what bounds it. */
  hu: number
  hv: number
  /** Round on a box's corners, metres. */
  corner: number
  /** A round's radius, metres. */
  r: number
  /** Middle to outline in 64 directions, from `angle` turning toward +z, metres. */
  radii: Float32Array
  /** Heights above `plane` on a 1 cm grid, when the top is not flat. */
  heights: Float32Array | null
  /** Where `heights` lies: the corner of its first cell, metres, and its size in cells. */
  gx: number
  gz: number
  gw: number
  gd: number
  /** How far the outline strays from the shape (the median), metres. */
  residual: number
  /** Share of the outline with the surface seen just outside it. */
  seenOut: number
  /** Voxel size of the field it was fitted in. */
  voxel: number
}

/** What a fit found on the way, for the debug panel and the fallback. */
export interface StandProbe {
  /** The surface it stands on, NaN when none was found. */
  plane: number
  /** Why there is no fit, '' when there is one. */
  reason: string
  /** The block the fit read, which `liftShell` can take as its `window`. */
  window?: FieldWindow
}

type Point = { x: number; y: number; z: number }

// Kept between calls and grown when a bigger block needs more: this runs a few times a second.
let topY = new Float32Array(0)
let blocked = new Uint8Array(0)
let mark = new Uint8Array(0)
let queue = new Int32Array(0)
let hist = new Float32Array(0)
let smoothed = new Float32Array(0)
let pick = new Float64Array(0)
let hf = new Float32Array(0)
let maskA = new Uint8Array(0)
let maskB = new Uint8Array(0)
let comp = new Uint8Array(0)
let soft = new Float32Array(0)
let spare = new Float32Array(0)
let link0 = new Int32Array(0)
let link1 = new Int32Array(0)
let walked = new Uint8Array(0)
let order = new Int32Array(0)
const sideT = new Float64Array(512)
const sideD = new Float64Array(512)
const highD = new Float64Array(512)
const offs = new Float64Array(4)
const turns = new Float64Array(4)
const seenTurns = new Float64Array(4)
const ray = new Float64Array(RAYS)
const wallX = new Float64Array(256)
const wallZ = new Float64Array(256)
let loopX = new Float64Array(0)
let loopZ = new Float64Array(0)
const nine = new Float64Array(9)
/** The outline, x and z in turn, and the loop being walked. */
let loop: number[] = []
let walk: number[] = []
const hull: number[] = []

/** Where a 1 cm map lies: the corner of its first cell, metres, and its size in cells. */
interface MapFrame {
  x0: number
  z0: number
  w: number
  d: number
}

/** The footprint grid of the fit under way. */
const grid: MapFrame = { x0: 0, z0: 0, w: 0, d: 0 }
/** Where the top's heights lie, for the shell being built. */
const topGrid: MapFrame = { x0: 0, z0: 0, w: 0, d: 0 }

function growColumns(count: number): void {
  if (topY.length >= count) return
  topY = new Float32Array(count)
  blocked = new Uint8Array(count)
  mark = new Uint8Array(count)
}

function growQueue(count: number): void {
  if (queue.length < count) queue = new Int32Array(count)
}

function growPick(count: number): void {
  if (pick.length < count) pick = new Float64Array(count)
}

function growFoot(count: number): void {
  growQueue(count)
  growPick(count)
  if (hf.length >= count) return
  hf = new Float32Array(count)
  maskA = new Uint8Array(count)
  maskB = new Uint8Array(count)
  comp = new Uint8Array(count)
  soft = new Float32Array(count)
  spare = new Float32Array(count)
  link0 = new Int32Array(count * 2)
  link1 = new Int32Array(count * 2)
  walked = new Uint8Array(count * 2)
}

/** The middle of the first `count` numbers in `pick`, which it sorts. NaN when there are none. */
function middle(count: number): number {
  if (count <= 0) return NaN
  const view = pick.subarray(0, count)
  view.sort()
  return count % 2 ? view[count >> 1] : (view[count / 2 - 1] + view[count / 2]) / 2
}

/** The field at a point, from the eight voxels around it. NaN where fewer than half of them were seen. */
function fieldAt(w: FieldWindow, x: number, y: number, z: number): number {
  const gx = x / w.v - 0.5 - w.x0
  const gy = y / w.v - 0.5 - w.y0
  const gz = z / w.v - 0.5 - w.z0
  const i = Math.floor(gx)
  const j = Math.floor(gy)
  const k = Math.floor(gz)
  const n = w.n
  if (i < 0 || j < 0 || k < 0 || i >= n - 1 || j >= n - 1 || k >= n - 1) return NaN
  const tx = gx - i
  const ty = gy - j
  const tz = gz - k
  const values = w.values
  const at = i + j * n + k * n * n
  let sum = 0
  let weight = 0
  for (let c = 0; c < 8; c++) {
    const a = c & 1
    const b = (c >> 1) & 1
    const d = c >> 2
    const value = values[at + a + b * n + d * n * n]
    const share = (a ? tx : 1 - tx) * (b ? ty : 1 - ty) * (d ? tz : 1 - tz)
    if (value === value && share > 0) {
      sum += value * share
      weight += share
    }
  }
  return weight > 0.5 ? sum / weight : NaN
}


/** A height map value at a point, from the four cells around it. NaN where too few of them are known. */
function mapAt(map: Float32Array, frame: MapFrame, x: number, z: number): number {
  const ga = (x - frame.x0) / FOOT - 0.5
  const gb = (z - frame.z0) / FOOT - 0.5
  const a = Math.floor(ga)
  const b = Math.floor(gb)
  if (a < 0 || b < 0 || a >= frame.w - 1 || b >= frame.d - 1) return NaN
  const ta = ga - a
  const tb = gb - b
  const at = a + b * frame.w
  let sum = 0
  let weight = 0
  let h = map[at]
  let share = (1 - ta) * (1 - tb)
  if (h === h && share > 0) {
    sum += h * share
    weight += share
  }
  h = map[at + 1]
  share = ta * (1 - tb)
  if (h === h && share > 0) {
    sum += h * share
    weight += share
  }
  h = map[at + frame.w]
  share = (1 - ta) * tb
  if (h === h && share > 0) {
    sum += h * share
    weight += share
  }
  h = map[at + frame.w + 1]
  share = ta * tb
  if (h === h && share > 0) {
    sum += h * share
    weight += share
  }
  return weight > 0.25 ? sum / weight : NaN
}

/**
 * Going out from `(px, pz)` along `(dx, dz)`, from `from` to `to` metres at
 * height `y`: where the field first turns from solid to air. That is a wall
 * depth saw. NaN when there is none.
 */
function wallCrossing(w: FieldWindow, px: number, pz: number, dx: number, dz: number, from: number, to: number, y: number): number {
  // A short, finite stretch only: a step added to an endless one never gets anywhere.
  if (!(to - from < 1)) return NaN
  let before = NaN
  let beforeD = 0
  for (let d = from; d <= to + 1e-9; d += 0.004) {
    const f = fieldAt(w, px + dx * d, y, pz + dz * d)
    if (f !== f) {
      before = NaN
      continue
    }
    if (before === before && before <= 0 && f > 0) return beforeD + (-before / (f - before)) * (d - beforeD)
    before = f
    beforeD = d
  }
  return NaN
}

/** Whether the last `mapCrossing` ran into unseen ground rather than down onto seen surface. */
let mapGap = false

/**
 * The same, on the height map: where it first drops below `level`. Where the
 * map runs into unseen ground first, the edge is where the seen part ends.
 * NaN when it does neither.
 */
function mapCrossing(px: number, pz: number, dx: number, dz: number, from: number, to: number, level: number): number {
  let before = NaN
  let beforeD = 0
  mapGap = false
  if (!(to - from < 1)) return NaN
  for (let d = from; d <= to + 1e-9; d += 0.002) {
    const h = mapAt(hf, grid, px + dx * d, pz + dz * d)
    if (h !== h) {
      if (before === before && before >= level) {
        mapGap = true
        return beforeD
      }
      before = NaN
      continue
    }
    if (before === before && before >= level && h < level) return beforeD + ((before - level) / (before - h)) * (d - beforeD)
    before = h
    beforeD = d
  }
  return NaN
}

/**
 * How far in from a point on the outline, along (-dx, -dz), the field turns
 * solid at height `y`: from 3 cm outside to 8 cm in. NaN when it does not.
 */
function insetAt(w: FieldWindow, px: number, pz: number, dx: number, dz: number, y: number): number {
  let before = NaN
  let beforeD = 0
  for (let d = 0.03; d >= -0.08 - 1e-9; d -= 0.005) {
    const f = fieldAt(w, px + dx * d, y, pz + dz * d)
    if (f !== f) {
      before = NaN
      continue
    }
    if (before === before && before > 0 && f <= 0) return -(beforeD + (before / (before - f)) * (d - beforeD))
    before = f
    beforeD = d
  }
  return NaN
}

/** 3x3 erode or grow of a mask on the footprint grid. Outside the grid is empty. */
function morph(src: Uint8Array, dst: Uint8Array, w: number, d: number, grow: boolean): void {
  for (let b = 0; b < d; b++) {
    for (let a = 0; a < w; a++) {
      let any = 0
      let all = 1
      for (let db = -1; db <= 1; db++) {
        const bb = b + db
        for (let da = -1; da <= 1; da++) {
          const aa = a + da
          const value = aa < 0 || bb < 0 || aa >= w || bb >= d ? 0 : src[aa + bb * w]
          any |= value
          all &= value
        }
      }
      dst[a + b * w] = grow ? any : all
    }
  }
}

/** [1 2 1] blur both ways, in place, with `spare` between. The grid's edge repeats itself. */
function blur(f: Float32Array, w: number, d: number): void {
  for (let b = 0; b < d; b++) {
    for (let a = 0; a < w; a++) {
      const c = a + b * w
      spare[c] = (f[a > 0 ? c - 1 : c] + 2 * f[c] + f[a < w - 1 ? c + 1 : c]) / 4
    }
  }
  for (let b = 0; b < d; b++) {
    for (let a = 0; a < w; a++) {
      const c = a + b * w
      f[c] = (spare[b > 0 ? c - w : c] + 2 * spare[c] + spare[b < d - 1 ? c + w : c]) / 4
    }
  }
}

/** Twice the signed area of a loop of x, z pairs. Above 0 when it runs from +x toward +z. */
function loopArea2(p: readonly number[]): number {
  let a = 0
  const m = p.length / 2
  for (let i = 0; i < m; i++) {
    const j = i + 1 === m ? 0 : i + 1
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]
  }
  return a
}

/**
 * The outline of `f` at `level` on the footprint grid (marching squares on
 * cell centres), into `loop`: the loop around the most area. The grid's outer
 * ring must be below `level`, so every loop closes.
 */
function trace(f: Float32Array, w: number, d: number, level: number): void {
  const edges = 2 * w * d
  link0.fill(-1, 0, edges)
  link1.fill(-1, 0, edges)
  walked.fill(0, 0, edges)
  const join = (p: number, q: number) => {
    if (link0[p] < 0) link0[p] = q
    else link1[p] = q
    if (link0[q] < 0) link0[q] = p
    else link1[q] = p
  }
  // A point sits on a grid edge: 2c for the edge from cell c along +x, 2c + 1 for the one along +z.
  for (let b = 0; b < d - 1; b++) {
    for (let a = 0; a < w - 1; a++) {
      const c = a + b * w
      const code = (f[c] > level ? 1 : 0) | (f[c + 1] > level ? 2 : 0) | (f[c + 1 + w] > level ? 4 : 0) | (f[c + w] > level ? 8 : 0)
      if (code === 0 || code === 15) continue
      const e0 = 2 * c
      const e1 = 2 * (c + 1) + 1
      const e2 = 2 * (c + w)
      const e3 = 2 * c + 1
      switch (code) {
        case 1:
        case 14:
          join(e3, e0)
          break
        case 2:
        case 13:
          join(e0, e1)
          break
        case 3:
        case 12:
          join(e3, e1)
          break
        case 4:
        case 11:
          join(e1, e2)
          break
        case 6:
        case 9:
          join(e0, e2)
          break
        case 7:
        case 8:
          join(e3, e2)
          break
        case 5:
        case 10: {
          // Two opposite corners in: the middle of the square says whether they join.
          const joined = (f[c] + f[c + 1] + f[c + 1 + w] + f[c + w]) / 4 > level
          if (joined === (code === 5)) {
            join(e3, e2)
            join(e0, e1)
          } else {
            join(e3, e0)
            join(e1, e2)
          }
          break
        }
      }
    }
  }
  loop.length = 0
  let bestArea = 0
  for (let s = 0; s < edges; s++) {
    if (link0[s] < 0 || walked[s]) continue
    walk.length = 0
    let prev = -1
    let cur = s
    while (cur >= 0 && !walked[cur]) {
      walked[cur] = 1
      const c = cur >> 1
      const a = c % w
      const b = (c - a) / w
      const other = cur & 1 ? c + w : c + 1
      const t = (level - f[c]) / (f[other] - f[c])
      walk.push(grid.x0 + (a + (cur & 1 ? 0 : t) + 0.5) * FOOT, grid.z0 + (b + (cur & 1 ? t : 0) + 0.5) * FOOT)
      const next = link0[cur] !== prev ? link0[cur] : link1[cur]
      prev = cur
      cur = next
    }
    const area = Math.abs(loopArea2(walk))
    if (area > bestArea) {
      bestArea = area
      const keep = loop
      loop = walk
      walk = keep
    }
  }
}

/** The smallest rectangle around the points of `hull` (x, z pairs, in order round it). */
function boundingRect(out: { cx: number; cz: number; angle: number; hu: number; hv: number }): void {
  const m = hull.length / 2
  let best = Infinity
  for (let i = 0; i < m; i++) {
    const j = i + 1 === m ? 0 : i + 1
    let ex = hull[j * 2] - hull[i * 2]
    let ez = hull[j * 2 + 1] - hull[i * 2 + 1]
    const el = Math.hypot(ex, ez)
    if (el < 1e-6) continue
    ex /= el
    ez /= el
    let u0 = Infinity
    let u1 = -Infinity
    let w0 = Infinity
    let w1 = -Infinity
    for (let k = 0; k < m; k++) {
      const u = hull[k * 2] * ex + hull[k * 2 + 1] * ez
      const w = -hull[k * 2] * ez + hull[k * 2 + 1] * ex
      if (u < u0) u0 = u
      if (u > u1) u1 = u
      if (w < w0) w0 = w
      if (w > w1) w1 = w
    }
    const area = (u1 - u0) * (w1 - w0)
    if (area >= best) continue
    best = area
    const uc = (u0 + u1) / 2
    const wc = (w0 + w1) / 2
    out.cx = uc * ex - wc * ez
    out.cz = uc * ez + wc * ex
    out.angle = Math.atan2(ez, ex)
    out.hu = (u1 - u0) / 2
    out.hv = (w1 - w0) / 2
  }
  // Keep the angle within an eighth of a turn either way: a box looks the same turned a quarter.
  while (out.angle > Math.PI / 4) {
    out.angle -= Math.PI / 2
    const hu = out.hu
    out.hu = out.hv
    out.hv = hu
  }
  while (out.angle <= -Math.PI / 4) {
    out.angle += Math.PI / 2
    const hu = out.hu
    out.hu = out.hv
    out.hv = hu
  }
}

/** The convex hull of `loop`, into `hull`, in order round it. */
function convexHull(): void {
  const m = loop.length / 2
  if (order.length < m) order = new Int32Array(m * 2)
  for (let i = 0; i < m; i++) order[i] = i
  const p = loop
  order.subarray(0, m).sort((a, b) => p[a * 2] - p[b * 2] || p[a * 2 + 1] - p[b * 2 + 1])
  hull.length = 0
  const cross = (o: number, a: number, b: number) => (p[a * 2] - p[o * 2]) * (p[b * 2 + 1] - p[o * 2 + 1]) - (p[a * 2 + 1] - p[o * 2 + 1]) * (p[b * 2] - p[o * 2])
  // Indices first, as a stack: the lower chain, then the upper.
  const stack: number[] = []
  for (let i = 0; i < m; i++) {
    const q = order[i]
    while (stack.length >= 2 && cross(stack[stack.length - 2], stack[stack.length - 1], q) <= 0) stack.pop()
    stack.push(q)
  }
  const lower = stack.length
  for (let i = m - 2; i >= 0; i--) {
    const q = order[i]
    while (stack.length > lower && cross(stack[stack.length - 2], stack[stack.length - 1], q) <= 0) stack.pop()
    stack.push(q)
  }
  stack.pop()
  for (let i = 0; i < stack.length; i++) hull.push(p[stack[i] * 2], p[stack[i] * 2 + 1])
}

/** How far a point is outside a rounded rectangle, metres: negative inside. */
function roundRect(x: number, z: number, cx: number, cz: number, ca: number, sa: number, hu: number, hv: number, corner: number): number {
  const dx = x - cx
  const dz = z - cz
  const qu = Math.abs(dx * ca + dz * sa) - (hu - corner)
  const qv = Math.abs(-dx * sa + dz * ca) - (hv - corner)
  return Math.hypot(Math.max(qu, 0), Math.max(qv, 0)) + Math.min(Math.max(qu, qv), 0) - corner
}

/** Distance from a fit's middle to its outline along the direction at `theta`, radians, in x and z. */
function reachAlong(fit: Pick<StandFit, 'shape' | 'angle' | 'hu' | 'hv' | 'r' | 'radii'>, theta: number): number {
  if (fit.shape === 'round') return fit.r
  const local = theta - fit.angle
  if (fit.shape === 'box') {
    const u = Math.abs(Math.cos(local))
    const w = Math.abs(Math.sin(local))
    return Math.min(u > 1e-9 ? fit.hu / u : Infinity, w > 1e-9 ? fit.hv / w : Infinity)
  }
  let at = (local / (2 * Math.PI)) * RAYS
  at = ((at % RAYS) + RAYS) % RAYS
  const i = Math.floor(at)
  const t = at - i
  return fit.radii[i] * (1 - t) + fit.radii[(i + 1) % RAYS] * t
}

/** How far a point is outside a fit's outline, metres: negative inside. */
function outside(fit: StandFit, x: number, z: number): number {
  if (fit.shape === 'box') return roundRect(x, z, fit.cx, fit.cz, Math.cos(fit.angle), Math.sin(fit.angle), fit.hu, fit.hv, fit.corner)
  const dx = x - fit.cx
  const dz = z - fit.cz
  return Math.hypot(dx, dz) - reachAlong(fit, Math.atan2(dz, dx))
}

/**
 * The thing standing at `seed`, seen from `eye`, as a box, a round or a
 * prism. Null when it is not one: on a big level surface, a wall, a ball, a
 * patch cut off by what was seen. `probe.reason` then says why.
 */
export function fitStanding(field: FieldBlock, seed: Point, eye: Point, probe?: StandProbe): StandFit | null {
  if (probe) {
    probe.plane = NaN
    probe.reason = ''
  }
  const fail = (reason: string): null => {
    if (probe) probe.reason = reason
    return null
  }
  const win = readWindow(field, seed, OBJECT_REACH)
  if (probe) probe.window = win
  const { values, x0, y0, z0, n, v } = win
  const nn = n * n
  growColumns(nn)
  growQueue(nn)
  growPick(nn)

  // 1. Look down each column of voxels for the first surface: a height map.
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      const col = i + k * n
      topY[col] = NaN
      blocked[col] = 0
      let prev = NaN
      let gap = 0
      for (let j = n - 1; j >= 0; j--) {
        const c = values[i + j * n + k * nn]
        if (c !== c) {
          // One unseen voxel between air and a surface is bridged. More, and the air above is forgotten.
          if (prev === prev && ++gap > 1) {
            prev = NaN
            gap = 0
          }
          continue
        }
        if (c <= 0) {
          // Solid with no air seen above it. At the top of the block that is the inside of something tall.
          if (prev !== prev) {
            if (j >= n - 3) blocked[col] = 1
          } else topY[col] = (y0 + (gap ? j + 1 : j + -c / (prev - c)) + 0.5) * v
          break
        }
        prev = c
        gap = 0
      }
    }
  }

  // 2. The surface it stands on: the nearest level below the pinch with room to stand on.
  const yBase = y0 * v
  const bins = Math.ceil((n * v) / PLANE_BIN) + 2
  if (hist.length < bins) {
    hist = new Float32Array(bins)
    smoothed = new Float32Array(bins)
  }
  hist.fill(0, 0, bins)
  for (let col = 0; col < nn; col++) {
    const y = topY[col]
    if (y !== y) continue
    const b = Math.floor((y - yBase) / PLANE_BIN)
    if (b >= 0 && b < bins) hist[b]++
  }
  smoothed[0] = 0
  smoothed[bins - 1] = 0
  for (let b = 1; b < bins - 1; b++) smoothed[b] = hist[b - 1] + 2 * hist[b] + hist[b + 1]
  const span = Math.round(PLANE_BAND / PLANE_BIN)
  // Area of the column tops within about PLANE_BAND of a bin.
  const areaAt = (b: number): number => {
    let count = 0
    for (let d = Math.max(0, b - span); d <= Math.min(bins - 1, b + span); d++) count += hist[d]
    return count * v * v
  }
  const si = Math.floor(seed.x / v) - x0
  const sk = Math.floor(seed.z / v) - z0
  const onLevel = Math.abs(topY[si + sk * n] - seed.y) <= PLANE_BAND
  const seedLevel = areaAt(Math.floor((seed.y - yBase) / PLANE_BIN))
  // The same rule as the lift's: a pinch on a big level surface is on the table itself.
  if (onLevel && seedLevel >= TABLE_AREA) return fail('on-table')
  // Not the biggest level in view: a low side table can have more floor or lower shelf in view than top.
  let found = -1
  for (let b = Math.min(bins - 2, Math.floor((seed.y - H_MIN - yBase) / PLANE_BIN)); b >= 1; b--) {
    const s = smoothed[b]
    if (s === 0 || s < smoothed[b - 1] || s < smoothed[b + 1]) continue
    const area = areaAt(b)
    if (area < STAND_AREA || (onLevel && area < seedLevel)) continue
    found = b
    break
  }
  if (found < 0) return fail('no-plane')
  const level = yBase + (found + 0.5) * PLANE_BIN
  let count = 0
  for (let col = 0; col < nn; col++) if (Math.abs(topY[col] - level) <= PLANE_BAND) pick[count++] = topY[col]
  const h0 = middle(count)
  if (probe) probe.plane = h0
  if (seed.y - h0 < H_MIN) return fail('on-plane')

  // 3. The columns that rise above it, joined to the pinch. This bounds the rest of the work.
  const rises = (col: number): boolean => topY[col] - h0 > H_MIN && !blocked[col]
  let start = -1
  let startD = Infinity
  for (let dk = -2; dk <= 2; dk++) {
    for (let di = -2; di <= 2; di++) {
      const i = si + di
      const k = sk + dk
      if (i < 0 || k < 0 || i >= n || k >= n || !rises(i + k * n)) continue
      const d = ((x0 + i + 0.5) * v - seed.x) ** 2 + ((z0 + k + 0.5) * v - seed.z) ** 2
      if (d < startD) {
        startD = d
        start = i + k * n
      }
    }
  }
  if (start < 0) return fail('nothing')
  mark.fill(0, 0, nn)
  let head = 0
  let tail = 0
  queue[tail++] = start
  mark[start] = 1
  let i0 = n
  let i1 = -1
  let k0 = n
  let k1 = -1
  while (head < tail) {
    const col = queue[head++]
    const i = col % n
    const k = (col - i) / n
    // It runs on out of the block: a wall, a sofa, a desk.
    if (i === 0 || k === 0 || i === n - 1 || k === n - 1) return fail('border')
    if (i < i0) i0 = i
    if (i > i1) i1 = i
    if (k < k0) k0 = k
    if (k > k1) k1 = k
    if (!mark[col - 1] && rises(col - 1)) {
      mark[col - 1] = 1
      queue[tail++] = col - 1
    }
    if (!mark[col + 1] && rises(col + 1)) {
      mark[col + 1] = 1
      queue[tail++] = col + 1
    }
    if (!mark[col - n] && rises(col - n)) {
      mark[col - n] = 1
      queue[tail++] = col - n
    }
    if (!mark[col + n] && rises(col + n)) {
      mark[col + n] = 1
      queue[tail++] = col + n
    }
  }
  if ((i1 - i0 + 1) * (k1 - k0 + 1) * v * v > 4 * FOOT_MAX) return fail('big')

  // 4. Its footprint at 1 cm, over those columns and two voxels round them.
  const per = v / FOOT
  grid.x0 = (x0 + i0 - 2) * v
  grid.z0 = (z0 + k0 - 2) * v
  grid.w = Math.round((i1 - i0 + 5) * per)
  grid.d = Math.round((k1 - k0 + 5) * per)
  const fw = grid.w
  const fd = grid.d
  const cells = fw * fd
  growFoot(cells)
  for (let b = 0; b < fd; b++) {
    const gk = (grid.z0 + (b + 0.5) * FOOT) / v - 0.5 - z0
    const k = Math.floor(gk)
    const tk = gk - k
    for (let a = 0; a < fw; a++) {
      const at = a + b * fw
      hf[at] = NaN
      const gi = (grid.x0 + (a + 0.5) * FOOT) / v - 0.5 - x0
      const i = Math.floor(gi)
      const ti = gi - i
      if (i < 0 || k < 0 || i >= n - 1 || k >= n - 1) continue
      // Between the four column heights around it, over those that are known.
      const c = i + k * n
      let sum = 0
      let weight = 0
      let y = topY[c]
      let share = (1 - ti) * (1 - tk)
      if (y === y && share > 0) {
        sum += (y - h0) * share
        weight += share
      }
      y = topY[c + 1]
      share = ti * (1 - tk)
      if (y === y && share > 0) {
        sum += (y - h0) * share
        weight += share
      }
      y = topY[c + n]
      share = (1 - ti) * tk
      if (y === y && share > 0) {
        sum += (y - h0) * share
        weight += share
      }
      y = topY[c + n + 1]
      share = ti * tk
      if (y === y && share > 0) {
        sum += (y - h0) * share
        weight += share
      }
      if (weight >= 0.2) hf[at] = sum / weight
    }
  }
  // What rises, with specks opened away and cracks closed.
  for (let at = 0; at < cells; at++) maskA[at] = hf[at] > H_MIN ? 1 : 0
  morph(maskA, maskB, fw, fd, false)
  morph(maskB, maskA, fw, fd, true)
  morph(maskA, maskB, fw, fd, true)
  morph(maskB, maskA, fw, fd, false)
  const sa = Math.floor((seed.x - grid.x0) / FOOT)
  const sb = Math.floor((seed.z - grid.z0) / FOOT)
  start = -1
  startD = Infinity
  for (let b = Math.max(0, sb - 3); b <= Math.min(fd - 1, sb + 3); b++) {
    for (let a = Math.max(0, sa - 3); a <= Math.min(fw - 1, sa + 3); a++) {
      if (!maskA[a + b * fw]) continue
      const d = (a - sa) ** 2 + (b - sb) ** 2
      if (d < startD) {
        startD = d
        start = a + b * fw
      }
    }
  }
  if (start < 0) return fail('nothing')
  comp.fill(0, 0, cells)
  head = 0
  tail = 0
  queue[tail++] = start
  comp[start] = 1
  while (head < tail) {
    const at = queue[head++]
    const a = at % fw
    const b = (at - a) / fw
    if (a === 0 || b === 0 || a === fw - 1 || b === fd - 1) return fail('border')
    if (maskA[at - 1] && !comp[at - 1]) {
      comp[at - 1] = 1
      queue[tail++] = at - 1
    }
    if (maskA[at + 1] && !comp[at + 1]) {
      comp[at + 1] = 1
      queue[tail++] = at + 1
    }
    if (maskA[at - fw] && !comp[at - fw]) {
      comp[at - fw] = 1
      queue[tail++] = at - fw
    }
    if (maskA[at + fw] && !comp[at + fw]) {
      comp[at + fw] = 1
      queue[tail++] = at + fw
    }
  }
  // Fill its holes: what cannot be reached from the grid's edge without crossing it.
  maskB.fill(0, 0, cells)
  head = 0
  tail = 0
  const reachOut = (at: number) => {
    if (comp[at] || maskB[at]) return
    maskB[at] = 1
    queue[tail++] = at
  }
  for (let a = 0; a < fw; a++) {
    reachOut(a)
    reachOut(a + (fd - 1) * fw)
  }
  for (let b = 0; b < fd; b++) {
    reachOut(b * fw)
    reachOut(b * fw + fw - 1)
  }
  while (head < tail) {
    const at = queue[head++]
    const a = at % fw
    const b = (at - a) / fw
    if (a > 0) reachOut(at - 1)
    if (a < fw - 1) reachOut(at + 1)
    if (b > 0) reachOut(at - fw)
    if (b < fd - 1) reachOut(at + fw)
  }
  let footCells = 0
  count = 0
  for (let at = 0; at < cells; at++) {
    if (maskB[at]) continue
    comp[at] = 1
    footCells++
    if (hf[at] === hf[at]) pick[count++] = hf[at]
  }
  if (footCells * FOOT * FOOT > FOOT_MAX) return fail('big')
  if (count === 0) return fail('nothing')
  pick.subarray(0, count).sort()
  const hTop = pick[Math.floor(count * 0.9)]
  const half = Math.max(H_MIN, hTop * 0.5)

  // 5. The outline: where the height map crosses half the thing's height, smoothed a little.
  morph(comp, maskB, fw, fd, true)
  morph(maskB, maskA, fw, fd, true)
  for (let at = 0; at < cells; at++) {
    const h = hf[at]
    soft[at] = !maskA[at] ? 0 : h === h ? Math.min(1, Math.max(0, (h - half) / half + 0.5)) : comp[at] ? 1 : 0
  }
  blur(soft, fw, fd)
  for (let a = 0; a < fw; a++) {
    soft[a] = 0
    soft[a + (fd - 1) * fw] = 0
  }
  for (let b = 0; b < fd; b++) {
    soft[b * fw] = 0
    soft[b * fw + fw - 1] = 0
  }
  trace(soft, fw, fd, 0.5)
  const m = loop.length / 2
  if (m < 8) return fail('nothing')
  growPick(m)
  if (loopX.length < m) {
    loopX = new Float64Array(m * 2)
    loopZ = new Float64Array(m * 2)
  }
  const area2 = loopArea2(loop)
  if (area2 < 0) {
    // Run it from +x toward +z, so outward is to the right of the way it goes.
    for (let i = 0, j = m - 1; i < j; i++, j--) {
      const x = loop[i * 2]
      const z = loop[i * 2 + 1]
      loop[i * 2] = loop[j * 2]
      loop[i * 2 + 1] = loop[j * 2 + 1]
      loop[j * 2] = x
      loop[j * 2 + 1] = z
    }
  }
  const loopArea = Math.abs(area2) / 2
  if (!(loopArea > FOOT * FOOT)) return fail('nothing')
  // Its middle by area.
  let mx = 0
  let mz = 0
  for (let i = 0; i < m; i++) {
    const j = i + 1 === m ? 0 : i + 1
    const cr = loop[i * 2] * loop[j * 2 + 1] - loop[j * 2] * loop[i * 2 + 1]
    mx += (loop[i * 2] + loop[j * 2]) * cr
    mz += (loop[i * 2 + 1] + loop[j * 2 + 1]) * cr
  }
  mx /= 6 * loopArea
  mz /= 6 * loopArea

  // 6. A rectangle and a circle through the outline, and how well each fits.
  convexHull()
  const rect = { cx: 0, cz: 0, angle: 0, hu: 0, hv: 0 }
  boundingRect(rect)
  for (let i = 0; i < m; i++) {
    loopX[i] = loop[i * 2]
    loopZ[i] = loop[i * 2 + 1]
  }
  const circle = circleThrough(loopX, loopZ, m)
  const ccx = circle.x
  const ccz = circle.z
  const cr0 = circle.r
  const corner0 = Math.min(CORNER, 0.25 * Math.min(rect.hu, rect.hv))
  const ca0 = Math.cos(rect.angle)
  const sa0 = Math.sin(rect.angle)
  for (let i = 0; i < m; i++) pick[i] = Math.abs(roundRect(loop[i * 2], loop[i * 2 + 1], rect.cx, rect.cz, ca0, sa0, rect.hu, rect.hv, corner0))
  const resRect = middle(m)
  for (let i = 0; i < m; i++) pick[i] = Math.abs(Math.hypot(loop[i * 2] - ccx, loop[i * 2 + 1] - ccz) - cr0)
  const resCirc = middle(m)

  // A far side's outline runs past the thing: its top's edge was only seen against what is
  // behind, and smears into the hidden space. Where the height map drops onto seen surface
  // the smear is about FAR_K voxels. Where it ends in unseen ground it is less, and grows
  // the more steeply the eye looks down on it.
  const topH = h0 + hTop
  const sinUp = (eye.y - topH) / (Math.hypot(eye.x - mx, eye.y - topH, eye.z - mz) || 1)
  const farBias = farK * v
  const gapBias = farBias * Math.min(1, Math.max(0, 2 * (sinUp - 0.5)))
  // A side faces away when its outward direction points away from the eye, seen from the middle.
  // Depth never saw that wall: what the field holds there leaked past the top's far edge. Seen
  // from straight above, no side is the far one.
  const away = (nx: number, nz: number, px: number, pz: number): boolean => {
    const dx = eye.x - px
    const dz = eye.z - pz
    const across = Math.hypot(dx, dz)
    return across > 0.05 && nx * dx + nz * dz < -0.2 * across
  }
  const midY = h0 + hTop * 0.5
  // Where the thing's edge is along a line out from (px, pz): its wall where depth saw it, else
  // the height map's edge, pulled in on a far side. NaN when neither is found.
  let sawWall = false
  const edgeAlong = (px: number, pz: number, nx: number, nz: number, from: number, to: number, farSide: boolean, pull = 1): number => {
    if (!farSide) {
      const d = wallCrossing(win, px, pz, nx, nz, from, to, midY)
      sawWall = d === d
      if (sawWall) return d - WALL_BIAS * v
    }
    sawWall = false
    const d = mapCrossing(px, pz, nx, nz, from, to, half)
    return d === d && farSide ? d - pull * (mapGap ? gapBias : farBias) : d
  }
  // The seen wall points, to tell the shapes apart by.
  let walls = 0

  // 7. A box: each side moved to the middle of its edge crossings, turned by their slant.
  let bx = rect.cx
  let bz = rect.cz
  let bAngle = rect.angle
  let bu = rect.hu
  let bv = rect.hv
  for (let pass = 0; pass < 2; pass++) {
    const ca = Math.cos(bAngle)
    const sa = Math.sin(bAngle)
    let turned = 0
    let seenTurned = 0
    for (let s = 0; s < 4; s++) {
      // +u, -u, +w, -w: the outward direction, the way along the side, how far out it is, and half its length.
      const nx = s === 0 ? ca : s === 1 ? -ca : s === 2 ? -sa : sa
      const nz = s === 0 ? sa : s === 1 ? -sa : s === 2 ? ca : -ca
      const tx = s < 2 ? -sa : ca
      const tz = s < 2 ? ca : sa
      const off = s < 2 ? bu : bv
      const len = s < 2 ? bv : bu
      const farSide = away(nx, nz, bx, bz)
      const inset = Math.min(0.02, len * 0.5)
      let got = 0
      let seenGot = 0
      for (let t = -len + inset; t <= len - inset + 1e-9 && got < sideT.length; t += 0.01) {
        const px = bx + tx * t
        const pz = bz + tz * t
        const d = edgeAlong(px, pz, nx, nz, off - 0.035, off + 0.035, farSide)
        if (d !== d) continue
        if (sawWall) seenGot++
        if (sawWall && pass === 1 && walls < wallX.length) {
          wallX[walls] = px + nx * d
          wallZ[walls] = pz + nz * d
          walls++
        }
        sideT[got] = t
        sideD[got] = d
        got++
      }
      offs[s] = off
      if (got >= 3) {
        for (let i = 0; i < got; i++) pick[i] = sideD[i]
        offs[s] = middle(got)
      }
      // The side's own slant (Theil-Sen: the middle of the slopes between its crossings) turns the box.
      if (got >= 5) {
        let slopes = 0
        for (let a = 0; a < got; a++) {
          for (let b = a + 1; b < got; b++) {
            if (sideT[b] - sideT[a] > 0.025 && slopes < pick.length) pick[slopes++] = (sideD[b] - sideD[a]) / (sideT[b] - sideT[a])
          }
        }
        if (slopes > 0) {
          // Which way a slope turns the side: + when its run is the outward direction turned toward +z.
          const sign = tx * -nz + tz * nx
          const turn = -sign * Math.atan(middle(slopes))
          // A wall depth saw runs truer than the height map's edge: those sides go first.
          if (seenGot >= 5 && seenGot >= 0.6 * got) {
            seenTurns[seenTurned++] = turn
          }
          turns[turned++] = turn
        }
      }
    }
    const du = (offs[0] - offs[1]) / 2
    const dv = (offs[2] - offs[3]) / 2
    bx += ca * du - sa * dv
    bz += sa * du + ca * dv
    bu = Math.max(0.005, (offs[0] + offs[1]) / 2)
    bv = Math.max(0.005, (offs[2] + offs[3]) / 2)
    if (seenTurned >= 1) {
      for (let i = 0; i < seenTurned; i++) pick[i] = seenTurns[i]
      bAngle += Math.max(-0.2, Math.min(0.2, middle(seenTurned)))
    } else if (turned >= 2) {
      for (let i = 0; i < turned; i++) pick[i] = turns[i]
      bAngle += Math.max(-0.2, Math.min(0.2, middle(turned)))
    }
  }
  while (bAngle > Math.PI / 4) {
    bAngle -= Math.PI / 2
    const t = bu
    bu = bv
    bv = t
  }
  while (bAngle <= -Math.PI / 4) {
    bAngle += Math.PI / 2
    const t = bu
    bu = bv
    bv = t
  }

  // 8. A round: out from its middle in 32 directions. The middle moves too, as a far side that ran on drew it away.
  let rx = ccx
  let rz = ccz
  let r = cr0
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < 32; k++) {
      const theta = (k / 32) * 2 * Math.PI
      const dx = Math.cos(theta)
      const dz = Math.sin(theta)
      const farSide = away(dx, dz, rx, rz)
      let d = edgeAlong(rx, rz, dx, dz, r - 0.035, r + 0.035, farSide, ROUND_PULL)
      if (d !== d) d = r - (farSide ? ROUND_PULL * farBias : 0)
      else if (sawWall && pass === 1 && walls < wallX.length) {
        wallX[walls] = rx + dx * d
        wallZ[walls] = rz + dz * d
        walls++
      }
      ray[k] = d
      pick[k] = d
    }
    const next = middle(32)
    let shiftX = 0
    let shiftZ = 0
    for (let k = 0; k < 32; k++) {
      const theta = (k / 32) * 2 * Math.PI
      shiftX += ((ray[k] - next) * Math.cos(theta)) / 16
      shiftZ += ((ray[k] - next) * Math.sin(theta)) / 16
    }
    const most = Math.min(1, 0.02 / (Math.hypot(shiftX, shiftZ) || 1))
    rx += shiftX * most
    rz += shiftZ * most
    r = Math.max(0.005, next)
  }

  // 9. Which shape: by how far the walls depth saw stray from each, or by the outline when it saw too few.
  let shape: StandFit['shape'] | null = null
  let residual = resRect
  const bCorner = Math.min(CORNER, 0.25 * Math.min(bu, bv))
  if (walls >= 8) {
    const ca = Math.cos(bAngle)
    const sa = Math.sin(bAngle)
    // The middle of how far they stray, and the three-quarter mark: a box's corners and a
    // round's sides stray from the other shape by more than depth's noise, but not everywhere.
    for (let i = 0; i < walls; i++) pick[i] = Math.abs(roundRect(wallX[i], wallZ[i], bx, bz, ca, sa, bu, bv, bCorner))
    const boxRes = middle(walls)
    const boxWide = pick[Math.floor(walls * 0.75)]
    // The round through the seen walls alone: its far side is a guess, and would only blur this.
    const seenRound = circleThrough(wallX, wallZ, walls)
    for (let i = 0; i < walls; i++) pick[i] = Math.abs(Math.hypot(wallX[i] - seenRound.x, wallZ[i] - seenRound.z) - seenRound.r)
    const roundRes = middle(walls)
    const roundWide = pick[Math.floor(walls * 0.75)]
    if (roundWide < WALL_ROUND * boxWide && roundRes < WALL_FIT * v) {
      shape = 'round'
      residual = roundRes
    } else if (boxRes < WALL_FIT * v && loopArea / (4 * bu * bv) > 0.8) {
      shape = 'box'
      residual = boxRes
    }
  } else if (resCirc < ROUND_RATIO * resRect && resCirc < BOX_RES * v) {
    shape = 'round'
    residual = resCirc
  } else if (resRect < BOX_RES * v && loopArea / (4 * rect.hu * rect.hv) > 0.8) shape = 'box'
  if (!shape && starShaped(mx, mz)) shape = 'prism'

  let cx = bx
  let cz = bz
  let angle = bAngle
  let hu = bu
  let hv = bv
  const radii = new Float32Array(RAYS)
  if (shape === 'round') {
    cx = rx
    cz = rz
    angle = 0
    hu = r
    hv = r
  } else if (shape === 'prism') {
    // A prism: out from the middle in 64 directions, from the box's turn, to where the outline is, then where the wall is.
    cx = mx
    cz = mz
    for (let k = 0; k < RAYS; k++) {
      const theta = angle + (k / RAYS) * 2 * Math.PI
      const dx = Math.cos(theta)
      const dz = Math.sin(theta)
      const out = outlineAlong(cx, cz, dx, dz)
      const farSide = away(dx, dz, cx, cz)
      const d = edgeAlong(cx, cz, dx, dz, out - 0.035, out + 0.035, farSide)
      ray[k] = Math.max(0.005, d === d ? d : out - (farSide ? farBias : 0))
    }
    // A circular [1 4 6 4 1] / 16 blur.
    let strays = 0
    for (let k = 0; k < RAYS; k++) {
      const at = (o: number) => ray[(k + o + RAYS) % RAYS]
      radii[k] = (at(-2) + 4 * at(-1) + 6 * at(0) + 4 * at(1) + at(2)) / 16
      pick[strays++] = Math.abs(radii[k] - ray[k])
    }
    residual = middle(strays)
    hu = 0
    hv = 0
    for (let k = 0; k < RAYS; k++) {
      const local = (k / RAYS) * 2 * Math.PI
      hu = Math.max(hu, Math.abs(radii[k] * Math.cos(local)))
      hv = Math.max(hv, Math.abs(radii[k] * Math.sin(local)))
    }
  }
  const corner = shape === 'box' ? bCorner : 0
  if (!Number.isFinite(cx + cz + angle + hu + hv + r)) return fail('shape')
  const model = { shape: shape ?? 'box', angle, hu, hv, r, radii }

  // 10. The outline must be bounded by surface that was seen, not by the edge of the fine window.
  let seen = 0
  let tried = 0
  for (let i = 0; i < m; i += 2) {
    const px = loop[i * 2]
    const pz = loop[i * 2 + 1]
    const dx = px - mx
    const dz = pz - mz
    const dl = Math.hypot(dx, dz) || 1
    const h = mapAt(hf, grid, px + (dx / dl) * 0.03, pz + (dz / dl) * 0.03)
    tried++
    if (h === h && Math.abs(h) < H_MIN) seen++
  }
  const seenOut = seen / Math.max(1, tried)
  if (seenOut < SEEN_MIN) return fail('seen')
  // Straight walls stand as far out low down as half way up. A ball or a vase draws in toward
  // its foot, or hides it under its widest part. Nor do they draw in high up, as a vase that
  // stands sunk in its holder does, or a bottle. Only the walls facing the eye were seen.
  const lowY = h0 + 0.2 * hTop
  const highY = h0 + 0.8 * hTop
  let both = 0
  let highs = 0
  let midOnly = 0
  for (let i = 0; i < m && both < sideD.length; i += 3) {
    const theta = Math.atan2(loop[i * 2 + 1] - cz, loop[i * 2] - cx)
    const dx = Math.cos(theta)
    const dz = Math.sin(theta)
    if (away(dx, dz, cx, cz)) continue
    const edge = reachAlong(model, theta)
    const mid = insetAt(win, cx + dx * edge, cz + dz * edge, dx, dz, midY)
    if (mid !== mid) continue
    const high = insetAt(win, cx + dx * edge, cz + dz * edge, dx, dz, highY)
    if (high === high && highs < highD.length) highD[highs++] = high - mid
    const low = insetAt(win, cx + dx * edge, cz + dz * edge, dx, dz, lowY)
    if (low !== low) midOnly++
    else sideD[both++] = low - mid
  }
  for (let i = 0; i < both; i++) pick[i] = sideD[i]
  const taper = both >= 4 ? middle(both) : 0
  for (let i = 0; i < highs; i++) pick[i] = highD[i]
  const narrows = highs >= 4 ? middle(highs) : 0
  if (taper > TAPER_MAX || narrows > NARROW_MAX || (midOnly >= 4 && midOnly > both)) return fail('taper')
  if (!shape) return fail('shape')

  // 11. The top: flat when the heights well inside agree, else a smoothed height map.
  const fit: StandFit = {
    shape,
    plane: h0,
    top: h0 + hTop,
    flat: true,
    mad: 0,
    cx,
    cz,
    angle,
    hu,
    hv,
    corner,
    r,
    radii,
    heights: null,
    gx: grid.x0,
    gz: grid.z0,
    gw: fw,
    gd: fd,
    residual,
    seenOut,
    voxel: v,
  }
  if (shape !== 'prism') for (let k = 0; k < RAYS; k++) radii[k] = reachAlong(fit, angle + (k / RAYS) * 2 * Math.PI)
  count = 0
  for (let b = 0; b < fd; b++) {
    for (let a = 0; a < fw; a++) {
      const at = a + b * fw
      const h = hf[at]
      if (!comp[at] || h !== h) continue
      if (outside(fit, grid.x0 + (a + 0.5) * FOOT, grid.z0 + (b + 0.5) * FOOT) < -0.02) pick[count++] = h
    }
  }
  if (count < 3) {
    // Too small to have an inside: all of its top.
    count = 0
    for (let at = 0; at < cells; at++) if (comp[at] && hf[at] >= half) pick[count++] = hf[at]
  }
  const med = middle(count)
  for (let i = 0; i < count; i++) pick[i] = Math.abs(pick[i] - med)
  const mad = middle(count)
  fit.top = h0 + med
  fit.mad = mad
  fit.flat = mad < FLAT_MAD
  if (!fit.flat) fit.heights = smoothTop(fw, fd)
  return fit
}

/** Distance from (cx, cz) along (dx, dz) to where it leaves the outline. */
function outlineAlong(cx: number, cz: number, dx: number, dz: number): number {
  const m = loop.length / 2
  let best = 0
  for (let i = 0; i < m; i++) {
    const j = i + 1 === m ? 0 : i + 1
    const ax = loop[i * 2] - cx
    const az = loop[i * 2 + 1] - cz
    const ex = loop[j * 2] - loop[i * 2]
    const ez = loop[j * 2 + 1] - loop[i * 2 + 1]
    // a + s e = t d, solved for s in [0, 1) and t > 0.
    const den = ex * dz - ez * dx
    if (Math.abs(den) < 1e-12) continue
    const s = (az * dx - ax * dz) / den
    if (s < 0 || s >= 1) continue
    const t = (ax * ez - az * ex) / -den
    if (t > best) best = t
  }
  return best
}

/**
 * The circle nearest the first `count` points of `xs`, `zs` (least squares on
 * x² + z² = A x + B z + C, about their middle).
 */
function circleThrough(xs: Float64Array, zs: Float64Array, count: number): { x: number; z: number; r: number } {
  let mx = 0
  let mz = 0
  for (let i = 0; i < count; i++) {
    mx += xs[i]
    mz += zs[i]
  }
  mx /= count || 1
  mz /= count || 1
  let sx = 0
  let sz = 0
  let sxx = 0
  let szz = 0
  let sxz = 0
  let sxr = 0
  let szr = 0
  let sr = 0
  for (let i = 0; i < count; i++) {
    const x = xs[i] - mx
    const z = zs[i] - mz
    const r2 = x * x + z * z
    sx += x
    sz += z
    sxx += x * x
    szz += z * z
    sxz += x * z
    sxr += x * r2
    szr += z * r2
    sr += r2
  }
  const M = [
    [sxx, sxz, sx, sxr],
    [sxz, szz, sz, szr],
    [sx, sz, count, sr],
  ]
  for (let c = 0; c < 3; c++) {
    const pivot = M[c][c] || 1e-12
    for (let r = 0; r < 3; r++) {
      if (r === c) continue
      const f = M[r][c] / pivot
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]
    }
  }
  const A = M[0][3] / (M[0][0] || 1e-12)
  const B = M[1][3] / (M[1][1] || 1e-12)
  const C = M[2][3] / (M[2][2] || 1e-12)
  return { x: mx + A / 2, z: mz + B / 2, r: Math.sqrt(Math.max(0, C + (A * A + B * B) / 4)) }
}

/** Whether every direction out from (cx, cz) meets the outline once. */
function starShaped(cx: number, cz: number): boolean {
  const m = loop.length / 2
  let back = 0
  for (let i = 0; i < m; i++) {
    const j = i + 1 === m ? 0 : i + 1
    const ax = loop[i * 2] - cx
    const az = loop[i * 2 + 1] - cz
    const bx = loop[j * 2] - cx
    const bz = loop[j * 2 + 1] - cz
    if (Math.hypot(ax, az) < 0.005) return false
    const turn = Math.atan2(ax * bz - az * bx, ax * bx + az * bz)
    if (turn < 0) back -= turn
  }
  return back < 0.05
}

/** The height map with its specks taken out (3x3 middle) and then softened (3x3 [1 2 1]), for a top that is not flat. */
function smoothTop(w: number, d: number): Float32Array {
  for (let b = 0; b < d; b++) {
    for (let a = 0; a < w; a++) {
      let got = 0
      for (let db = -1; db <= 1; db++) {
        for (let da = -1; da <= 1; da++) {
          const aa = a + da
          const bb = b + db
          if (aa < 0 || bb < 0 || aa >= w || bb >= d) continue
          const h = hf[aa + bb * w]
          if (h === h) nine[got++] = h
        }
      }
      if (got === 0) {
        soft[a + b * w] = NaN
        continue
      }
      const view = nine.subarray(0, got)
      view.sort()
      soft[a + b * w] = got % 2 ? view[got >> 1] : (view[got / 2 - 1] + view[got / 2]) / 2
    }
  }
  const out = new Float32Array(w * d)
  for (let b = 0; b < d; b++) {
    for (let a = 0; a < w; a++) {
      let sum = 0
      let weight = 0
      for (let db = -1; db <= 1; db++) {
        for (let da = -1; da <= 1; da++) {
          const aa = a + da
          const bb = b + db
          if (aa < 0 || bb < 0 || aa >= w || bb >= d) continue
          const h = soft[aa + bb * w]
          if (h !== h) continue
          const share = (da === 0 ? 2 : 1) * (db === 0 ? 2 : 1)
          sum += h * share
          weight += share
        }
      }
      out[a + b * w] = weight > 0 ? sum / weight : NaN
    }
  }
  return out
}

/** A non-flat top's height above the plane at a point, metres. The fit's top where the map does not reach. */
function topAt(fit: StandFit, x: number, z: number): number {
  const fallback = fit.top - fit.plane
  if (!fit.heights) return fallback
  topGrid.x0 = fit.gx
  topGrid.z0 = fit.gz
  topGrid.w = fit.gw
  topGrid.d = fit.gd
  const h = mapAt(fit.heights, topGrid, x, z)
  return h === h ? Math.max(H_MIN, h) : fallback
}

/**
 * The fit as a shell, ready for the ghost and the lift: a top cap of nested
 * rings, and walls straight down to just above the surface. The walls have
 * their own rim vertices so the edge between top and walls stays crisp.
 * `eye` marks the walls the camera never saw.
 */
export function buildStanding(fit: StandFit, eye: Point): Shell {
  // 1. The outline, running from +x toward +z, with each point's outward direction.
  const ox: number[] = []
  const oz: number[] = []
  const onx: number[] = []
  const onz: number[] = []
  const ca = Math.cos(fit.angle)
  const sa = Math.sin(fit.angle)
  const put = (u: number, w: number, nu: number, nw: number) => {
    ox.push(fit.cx + u * ca - w * sa)
    oz.push(fit.cz + u * sa + w * ca)
    onx.push(nu * ca - nw * sa)
    onz.push(nu * sa + nw * ca)
  }
  if (fit.shape === 'box') {
    const c = fit.corner
    const a = fit.hu - c
    const b = fit.hv - c
    // Each side, then the round corner after it: +u, +w, -u, -w.
    for (let side = 0; side < 4; side++) {
      const phi = (side * Math.PI) / 2
      const nu = Math.cos(phi)
      const nw = Math.sin(phi)
      // Corners at (±a, ±b): this side runs from the corner behind it to the corner ahead.
      const fromU = side === 0 ? a : side === 1 ? a : side === 2 ? -a : -a
      const fromW = side === 0 ? -b : side === 1 ? b : side === 2 ? b : -b
      const toU = side === 0 ? a : side === 1 ? -a : side === 2 ? -a : a
      const toW = side === 0 ? b : side === 1 ? b : side === 2 ? -b : -b
      const length = Math.hypot(toU - fromU, toW - fromW)
      const pieces = Math.max(1, Math.ceil(length / RING - 1e-9))
      for (let p = 0; p < pieces; p++) {
        const t = p / pieces
        put(fromU + (toU - fromU) * t + nu * c, fromW + (toW - fromW) * t + nw * c, nu, nw)
      }
      for (let p = 0; p < 3; p++) {
        const turn = phi + ((p / 3) * Math.PI) / 2
        put(toU + Math.cos(turn) * c, toW + Math.sin(turn) * c, Math.cos(turn), Math.sin(turn))
      }
    }
  } else if (fit.shape === 'round') {
    const count = Math.max(24, Math.min(72, Math.round((2 * Math.PI * fit.r) / 0.015)))
    for (let k = 0; k < count; k++) {
      const theta = (k / count) * 2 * Math.PI
      put(Math.cos(theta) * fit.r, Math.sin(theta) * fit.r, Math.cos(theta), Math.sin(theta))
    }
  } else {
    for (let k = 0; k < RAYS; k++) {
      const theta = (k / RAYS) * 2 * Math.PI
      put(Math.cos(theta) * fit.radii[k], Math.sin(theta) * fit.radii[k], 0, 0)
    }
    // Outward: square to the run between the points either side.
    for (let k = 0; k < RAYS; k++) {
      const a = (k + RAYS - 1) % RAYS
      const b = (k + 1) % RAYS
      const ex = ox[b] - ox[a]
      const ez = oz[b] - oz[a]
      const el = Math.hypot(ex, ez) || 1
      onx[k] = ez / el
      onz[k] = -ex / el
    }
  }
  const m = ox.length
  let inradius = Infinity
  for (let i = 0; i < m; i++) inradius = Math.min(inradius, Math.hypot(ox[i] - fit.cx, oz[i] - fit.cz))
  if (!(inradius < Infinity)) inradius = 0.01
  const base = fit.plane + BASE_GAP
  // The height of the top above each outline point, taken a little in from the rim, where it is not half way down.
  const rimTop = new Float32Array(m)
  const pull = Math.min(0.015, inradius * 0.5)
  for (let i = 0; i < m; i++) {
    if (fit.flat || !fit.heights) {
      rimTop[i] = fit.top
      continue
    }
    const dx = ox[i] - fit.cx
    const dz = oz[i] - fit.cz
    const dl = Math.hypot(dx, dz) || 1
    rimTop[i] = fit.plane + topAt(fit, ox[i] - (dx / dl) * pull, oz[i] - (dz / dl) * pull)
  }

  // 2. Top cap: nested rings in toward a middle vertex.
  const rings = Math.max(1, Math.min(6, Math.ceil(inradius / RING)))
  let highest = base
  for (let i = 0; i < m; i++) highest = Math.max(highest, rimTop[i])
  const rows = Math.max(1, Math.ceil((highest - base) / RING - 1e-9))
  const capCount = rings * m + 1
  const count = capCount + (rows + 1) * m
  const positions = new Float32Array(count * 3)
  const edge = new Float32Array(count)
  const unseen = new Uint8Array(count)
  const indices = new Uint32Array((rings - 1) * m * 6 + m * 3 + rows * m * 6)
  let tri = 0
  for (let ring = 0; ring < rings; ring++) {
    const s = 1 - ring / rings
    for (let i = 0; i < m; i++) {
      const x = fit.cx + (ox[i] - fit.cx) * s
      const z = fit.cz + (oz[i] - fit.cz) * s
      let y = rimTop[i]
      if (ring > 0 && !fit.flat && fit.heights) y = fit.plane + topAt(fit, x, z)
      const at = ring * m + i
      positions[at * 3] = x
      positions[at * 3 + 1] = y
      positions[at * 3 + 2] = z
    }
  }
  const mid = capCount - 1
  positions[mid * 3] = fit.cx
  positions[mid * 3 + 1] = !fit.flat && fit.heights ? fit.plane + topAt(fit, fit.cx, fit.cz) : fit.top
  positions[mid * 3 + 2] = fit.cz
  for (let ring = 0; ring + 1 < rings; ring++) {
    for (let i = 0; i < m; i++) {
      const j = i + 1 === m ? 0 : i + 1
      const o0 = ring * m + i
      const o1 = ring * m + j
      const q0 = (ring + 1) * m + i
      const q1 = (ring + 1) * m + j
      indices[tri++] = q0
      indices[tri++] = o1
      indices[tri++] = o0
      indices[tri++] = q0
      indices[tri++] = q1
      indices[tri++] = o1
    }
  }
  const inner = (rings - 1) * m
  for (let i = 0; i < m; i++) {
    const j = i + 1 === m ? 0 : i + 1
    indices[tri++] = mid
    indices[tri++] = inner + j
    indices[tri++] = inner + i
  }
  // The camera saw the top from above.
  for (let at = 0; at < capCount; at++) unseen[at] = eye.y - positions[at * 3 + 1] < 0 ? 1 : 0

  // 3. Walls: rows from each outline point's top straight down to the base.
  for (let row = 0; row <= rows; row++) {
    for (let i = 0; i < m; i++) {
      const at = capCount + row * m + i
      const y = rimTop[i] + (base - rimTop[i]) * (row / rows)
      positions[at * 3] = ox[i]
      positions[at * 3 + 1] = y
      positions[at * 3 + 2] = oz[i]
      // 4. The base ring is the contact line.
      edge[at] = row === rows ? BASE_EDGE : 0
      // 5. A wall facing away from the eye was never seen.
      unseen[at] = onx[i] * (eye.x - ox[i]) + onz[i] * (eye.z - oz[i]) < 0 ? 1 : 0
    }
  }
  for (let row = 0; row < rows; row++) {
    for (let i = 0; i < m; i++) {
      const j = i + 1 === m ? 0 : i + 1
      const t0 = capCount + row * m + i
      const t1 = capCount + row * m + j
      const b0 = t0 + m
      const b1 = t1 + m
      indices[tri++] = t0
      indices[tri++] = t1
      indices[tri++] = b1
      indices[tri++] = t0
      indices[tri++] = b1
      indices[tri++] = b0
    }
  }

  // 6. Where it is and how big.
  let maxTop = base
  for (let i = 0; i < m; i++) maxTop = Math.max(maxTop, rimTop[i])
  for (let at = 0; at < capCount; at++) maxTop = Math.max(maxTop, positions[at * 3 + 1])
  const cy = (base + maxTop) / 2
  let radius = 0
  for (let at = 0; at < count; at++) {
    radius = Math.max(radius, Math.hypot(positions[at * 3] - fit.cx, positions[at * 3 + 1] - cy, positions[at * 3 + 2] - fit.cz))
  }
  return {
    kind: 'object',
    runsOn: false,
    positions,
    indices,
    edge,
    cx: fit.cx,
    cy,
    cz: fit.cz,
    radius,
    bottom: base,
    relief: maxTop - base,
    stand: fit,
    unseen,
  }
}

/** Half sizes along the fit's own frame, smaller first, for telling whether two fits are the same thing. */
function sizes(fit: StandFit, out: Float64Array): void {
  const a = fit.shape === 'round' ? fit.r : fit.hu
  const b = fit.shape === 'round' ? fit.r : fit.hv
  out[0] = Math.min(a, b)
  out[1] = Math.max(a, b)
}

const sizeA = new Float64Array(2)
const sizeB = new Float64Array(2)

/** Whether two fits are the same thing seen again: same surface, near the same place, near the same size. */
function sameThing(a: StandFit, b: StandFit): boolean {
  if (Math.abs(a.plane - b.plane) >= 0.015) return false
  sizes(a, sizeA)
  sizes(b, sizeB)
  if (Math.hypot(a.cx - b.cx, a.cz - b.cz) >= Math.max(0.025, 0.35 * sizeA[0])) return false
  return Math.abs(sizeB[0] - sizeA[0]) <= 0.25 * sizeA[0] && Math.abs(sizeB[1] - sizeA[1]) <= 0.25 * sizeA[1]
}

/**
 * Holds a fitted shape steady from one fit to the next. A value moves only
 * past a small dead band, and then eases toward the new fit; a different
 * shape, or a jump, must be seen twice. When nothing moved it hands back the
 * very same Shell, so the ghost is not rebuilt.
 */
export class StandTrack {
  /** Seconds the shape has been held through missed fits, for the debug panel. */
  held = 0
  /** The latest fit, held or not, for the debug panel. */
  last: StandFit | null = null
  private cur: StandFit | null = null
  private shell: Shell | null = null
  private seenAt = 0
  private pending: StandFit | null = null
  private pendingCount = 0
  private shapeVote: StandFit['shape'] | null = null
  private shapeVotes = 0
  private flatVotes = 0

  /** Forget the shape, as when the room or the view changes. */
  reset(): void {
    this.held = 0
    this.last = null
    this.cur = null
    this.shell = null
    this.pending = null
    this.pendingCount = 0
    this.shapeVote = null
    this.shapeVotes = 0
    this.flatVotes = 0
  }

  /** The shape to show for this fit (null when there was none) at `seed`, `now` seconds. */
  update(fit: StandFit | null, seed: { x: number; z: number }, now: number, eye: Point): Shell | null {
    const cur = this.cur
    if (fit) this.last = fit
    if (!fit) {
      // A hand in the way, or one bad look: keep the shape a moment while the pinch stays on it.
      if (cur && this.shell && outside(cur, seed.x, seed.z) <= 0.03 && now - this.seenAt < HOLD) {
        this.held = now - this.seenAt
        return this.shell
      }
      this.reset()
      return null
    }
    this.held = 0
    if (!cur || outside(cur, seed.x, seed.z) > 0.03) return this.accept(fit, now, eye)
    if (sameThing(cur, fit)) {
      this.seenAt = now
      this.pending = null
      this.pendingCount = 0
      const next = this.blend(cur, fit)
      if (next !== cur) {
        this.cur = next
        this.shell = buildStanding(next, eye)
      }
      return this.shell
    }
    // Something else where the shape was: it must be seen twice, or the shape gone stale, before it takes over.
    if (now - this.seenAt >= HOLD) return this.accept(fit, now, eye)
    if (this.pending && sameThing(this.pending, fit)) {
      if (++this.pendingCount >= 2) return this.accept(fit, now, eye)
    } else {
      this.pending = fit
      this.pendingCount = 1
    }
    return this.shell
  }

  private accept(fit: StandFit, now: number, eye: Point): Shell {
    this.cur = fit
    this.seenAt = now
    this.pending = null
    this.pendingCount = 0
    this.shapeVote = null
    this.shapeVotes = 0
    this.flatVotes = 0
    this.shell = buildStanding(fit, eye)
    return this.shell
  }

  /** `cur` moved toward `fit` past the dead bands, as a new fit, or `cur` itself when nothing moved. */
  private blend(cur: StandFit, fit: StandFit): StandFit {
    // A different shape must be asked for twice running.
    if (fit.shape !== cur.shape) {
      if (this.shapeVote === fit.shape) this.shapeVotes++
      else {
        this.shapeVote = fit.shape
        this.shapeVotes = 1
      }
      if (this.shapeVotes < 2) return cur
      this.shapeVote = null
      this.shapeVotes = 0
      this.flatVotes = 0
      return fit
    }
    this.shapeVote = null
    this.shapeVotes = 0
    let moved = false
    const ease = (from: number, to: number, band: number): number => {
      const d = to - from
      if (Math.abs(d) <= band) return from
      moved = true
      return from + d * (Math.abs(d) > 4 * band ? 0.6 : 0.35)
    }
    // Flat or not must also be asked for twice, and a flat top needs a clearly rough one to leave it.
    let flat = cur.flat
    const wantFlat = cur.flat ? fit.mad <= 1.5 * FLAT_MAD : fit.flat
    if (wantFlat !== cur.flat) {
      if (++this.flatVotes >= 2) {
        flat = wantFlat
        this.flatVotes = 0
        moved = true
      }
    } else this.flatVotes = 0
    let cx = cur.cx
    let cz = cur.cz
    const shift = Math.hypot(fit.cx - cur.cx, fit.cz - cur.cz)
    if (shift > 0.004) {
      const share = shift > 0.016 ? 0.6 : 0.35
      cx += (fit.cx - cur.cx) * share
      cz += (fit.cz - cur.cz) * share
      moved = true
    }
    const plane = ease(cur.plane, fit.plane, 0.003)
    const top = ease(cur.top, fit.top, 0.003)
    let angle = cur.angle
    let hu = cur.hu
    let hv = cur.hv
    let r = cur.r
    let radii = cur.radii
    if (cur.shape === 'box') {
      // A box turned a quarter is the same box with its sides swapped.
      let turn = fit.angle - cur.angle
      const quarters = Math.round(turn / (Math.PI / 2))
      turn -= quarters * (Math.PI / 2)
      const odd = Math.abs(quarters) % 2 === 1
      angle = ease(cur.angle, cur.angle + turn, (3 * Math.PI) / 180)
      hu = ease(cur.hu, odd ? fit.hv : fit.hu, 0.004)
      hv = ease(cur.hv, odd ? fit.hu : fit.hv, 0.004)
    } else if (cur.shape === 'round') {
      r = ease(cur.r, fit.r, 0.004)
      hu = r
      hv = r
    } else {
      // The new outline, read in the old one's directions.
      let changed = false
      const next = new Float32Array(RAYS)
      for (let k = 0; k < RAYS; k++) {
        const want = reachAlong(fit, cur.angle + (k / RAYS) * 2 * Math.PI)
        const d = want - cur.radii[k]
        if (Math.abs(d) <= 0.004) next[k] = cur.radii[k]
        else {
          next[k] = cur.radii[k] + d * (Math.abs(d) > 0.016 ? 0.6 : 0.35)
          changed = true
        }
      }
      if (changed) {
        radii = next
        moved = true
        hu = 0
        hv = 0
        for (let k = 0; k < RAYS; k++) {
          const local = (k / RAYS) * 2 * Math.PI
          hu = Math.max(hu, Math.abs(radii[k] * Math.cos(local)))
          hv = Math.max(hv, Math.abs(radii[k] * Math.sin(local)))
        }
      }
    }
    if (!moved) return cur
    const out: StandFit = {
      ...cur,
      plane,
      top,
      flat,
      mad: fit.mad,
      cx,
      cz,
      angle,
      hu,
      hv,
      r,
      corner: cur.shape === 'box' ? Math.min(CORNER, 0.25 * Math.min(hu, hv)) : 0,
      radii,
      heights: flat ? null : fit.heights ?? cur.heights,
      gx: fit.heights ? fit.gx : cur.gx,
      gz: fit.heights ? fit.gz : cur.gz,
      gw: fit.heights ? fit.gw : cur.gw,
      gd: fit.heights ? fit.gd : cur.gd,
      residual: fit.residual,
      seenOut: fit.seenOut,
    }
    if (out.shape !== 'prism') {
      out.radii = new Float32Array(RAYS)
      for (let k = 0; k < RAYS; k++) out.radii[k] = reachAlong(out, out.angle + (k / RAYS) * 2 * Math.PI)
    }
    return out
  }
}
