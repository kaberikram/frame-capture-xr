/**
 * Flat surfaces a sticker can land on. Desktop preview uses the stand-in
 * wall and table. On a headset the same shape is filled from detected planes,
 * mesh faces, and hit-test poses.
 */
export interface Surface {
  px: number
  py: number
  pz: number
  /** Unit normal. Desktop walls point into the room. */
  nx: number
  ny: number
  nz: number
  ux: number
  uy: number
  uz: number
  vx: number
  vy: number
  vz: number
  halfU: number
  halfV: number
}

export interface Snap {
  distance: number
  px: number
  py: number
  pz: number
  /** Unit normal pointing toward the sticker, so the photo faces the room. */
  nx: number
  ny: number
  nz: number
}

export interface RayHit {
  t: number
  x: number
  y: number
  z: number
  nx: number
  ny: number
  nz: number
}

export interface Basis {
  xx: number
  xy: number
  xz: number
  yx: number
  yy: number
  yz: number
  zx: number
  zy: number
  zz: number
}

/** Back wall of the stand-in, normal +Z, matching the plaster plane at z = -2.2. */
export const DESK_WALL: Surface = {
  px: 0, py: 1.4, pz: -2.2,
  nx: 0, ny: 0, nz: 1,
  ux: 1, uy: 0, uz: 0,
  vx: 0, vy: 1, vz: 0,
  halfU: 2.6, halfV: 1.4,
}

/** Left wall, yawed so its normal points into the room. */
export const DESK_SIDE: Surface = {
  px: -2.4, py: 1.4, pz: -0.4,
  nx: 1, ny: 0, nz: 0,
  ux: 0, uy: 0, uz: -1,
  vx: 0, vy: 1, vz: 0,
  halfU: 2, halfV: 1.4,
}

/** Table top. The box center is y = 0.48 and the top face is 3 cm above that. */
export const DESK_TABLE: Surface = {
  px: 0.78, py: 0.51, pz: -1.35,
  nx: 0, ny: 1, nz: 0,
  ux: 1, uy: 0, uz: 0,
  vx: 0, vy: 0, vz: 1,
  halfU: 0.36, halfV: 0.21,
}

export const DESK_SURFACES: readonly Surface[] = [DESK_WALL, DESK_SIDE, DESK_TABLE]

/**
 * Closest surface within `maxDist` whose bounds contain the projection.
 * `faceX/Y/Z` is a point the normal must look toward (the camera); a hit on
 * the far side of a wall is ignored.
 */
export function nearestSurface(
  x: number,
  y: number,
  z: number,
  surfaces: readonly Surface[],
  maxDist: number,
  faceX: number,
  faceY: number,
  faceZ: number,
): Snap | null {
  let best: Snap | null = null
  for (let i = 0; i < surfaces.length; i++) {
    const snap = project(surfaces[i], x, y, z, maxDist, faceX, faceY, faceZ)
    if (!snap) continue
    if (!best || snap.distance < best.distance) best = snap
  }
  return best
}

/** First surface a ray meets, with the normal turned toward the ray origin. */
export function raySurface(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  surfaces: readonly Surface[],
): RayHit | null {
  let best: RayHit | null = null
  for (let i = 0; i < surfaces.length; i++) {
    const s = surfaces[i]
    const denom = dx * s.nx + dy * s.ny + dz * s.nz
    if (Math.abs(denom) < 1e-5) continue
    const t = ((s.px - ox) * s.nx + (s.py - oy) * s.ny + (s.pz - oz) * s.nz) / denom
    if (t < 0.05) continue
    if (best && t >= best.t) continue
    const x = ox + dx * t
    const y = oy + dy * t
    const z = oz + dz * t
    const u = (x - s.px) * s.ux + (y - s.py) * s.uy + (z - s.pz) * s.uz
    const v = (x - s.px) * s.vx + (y - s.py) * s.vy + (z - s.pz) * s.vz
    if (Math.abs(u) > s.halfU || Math.abs(v) > s.halfV) continue
    const flip = denom > 0
    best = {
      t, x, y, z,
      nx: flip ? -s.nx : s.nx,
      ny: flip ? -s.ny : s.ny,
      nz: flip ? -s.nz : s.nz,
    }
  }
  return best
}

/**
 * Photo basis. Local +Z is the surface normal. On a wall, local +Y is world
 * up. On a floor or table, local +Y points away from the camera along the surface.
 */
export function stickBasis(nx: number, ny: number, nz: number, camX: number, camY: number, camZ: number): Basis {
  const zx = nx
  const zy = ny
  const zz = nz
  let yx = 0
  let yy = 1
  let yz = 0
  if (Math.abs(ny) > 0.82) {
    yx = -camX
    yy = 0
    yz = -camZ
  }
  const drop = yx * zx + yy * zy + yz * zz
  yx -= zx * drop
  yy -= zy * drop
  yz -= zz * drop
  const len = Math.hypot(yx, yy, yz)
  if (len < 1e-5) {
    yx = 0
    yy = 0
    yz = 1
  } else {
    yx /= len
    yy /= len
    yz /= len
  }
  return {
    xx: yy * zz - yz * zy,
    xy: yz * zx - yx * zz,
    xz: yx * zy - yy * zx,
    yx, yy, yz,
    zx, zy, zz,
  }
}

/**
 * A pose whose local Y is the normal and whose local X / Z span the face.
 * `centerU` / `centerV` shift the bounds center off the pose origin, which
 * is how a WebXR plane polygon sits in plane space.
 */
export function surfaceFromMatrix(
  m: ArrayLike<number>,
  halfU: number,
  halfV: number,
  centerU = 0,
  centerV = 0,
): Surface {
  const ux = m[0]
  const uy = m[1]
  const uz = m[2]
  const nx = m[4]
  const ny = m[5]
  const nz = m[6]
  const vx = m[8]
  const vy = m[9]
  const vz = m[10]
  return {
    px: m[12] + ux * centerU + vx * centerV,
    py: m[13] + uy * centerU + vy * centerV,
    pz: m[14] + uz * centerU + vz * centerV,
    nx, ny, nz,
    ux, uy, uz,
    vx, vy, vz,
    halfU, halfV,
  }
}

/** Six faces of a posed box. Used for bounded room-mesh boxes. */
export function appendBoxFaces(
  out: Surface[],
  m: ArrayLike<number>,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): void {
  const midX = (min[0] + max[0]) * 0.5
  const midY = (min[1] + max[1]) * 0.5
  const midZ = (min[2] + max[2]) * 0.5
  const hx = (max[0] - min[0]) * 0.5
  const hy = (max[1] - min[1]) * 0.5
  const hz = (max[2] - min[2]) * 0.5
  const faces: readonly (readonly number[])[] = [
    [max[0], midY, midZ, 1, 0, 0, 0, 0, 1, 0, 1, 0, hz, hy],
    [min[0], midY, midZ, -1, 0, 0, 0, 0, -1, 0, 1, 0, hz, hy],
    [midX, max[1], midZ, 0, 1, 0, 1, 0, 0, 0, 0, 1, hx, hz],
    [midX, min[1], midZ, 0, -1, 0, 1, 0, 0, 0, 0, -1, hx, hz],
    [midX, midY, max[2], 0, 0, 1, 1, 0, 0, 0, 1, 0, hx, hy],
    [midX, midY, min[2], 0, 0, -1, 1, 0, 0, 0, -1, 0, hx, hy],
  ]
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i]
    if (f[12] < 0.02 || f[13] < 0.02) continue
    const p = mulPoint(m, f[0], f[1], f[2])
    const n = mulDir(m, f[3], f[4], f[5])
    const u = mulDir(m, f[6], f[7], f[8])
    const v = mulDir(m, f[9], f[10], f[11])
    out.push({
      px: p[0], py: p[1], pz: p[2],
      nx: n[0], ny: n[1], nz: n[2],
      ux: u[0], uy: u[1], uz: u[2],
      vx: v[0], vy: v[1], vz: v[2],
      halfU: f[12], halfV: f[13],
    })
  }
}

export function readVec3(value: unknown): [number, number, number] | null {
  if (!value) return null
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const v = value as ArrayLike<number>
    if (v.length < 3 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) return null
    return [v[0], v[1], v[2]]
  }
  if (typeof value === 'object' && value !== null && 'x' in value && 'y' in value && 'z' in value) {
    const v = value as { x: number; y: number; z: number }
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return null
    return [v.x, v.y, v.z]
  }
  return null
}

function project(
  s: Surface,
  x: number,
  y: number,
  z: number,
  maxDist: number,
  faceX: number,
  faceY: number,
  faceZ: number,
): Snap | null {
  const dx = x - s.px
  const dy = y - s.py
  const dz = z - s.pz
  let nx = s.nx
  let ny = s.ny
  let nz = s.nz
  let signed = dx * nx + dy * ny + dz * nz
  if (signed < 0) {
    signed = -signed
    nx = -nx
    ny = -ny
    nz = -nz
  }
  if (signed > maxDist) return null
  const px = x - nx * signed
  const py = y - ny * signed
  const pz = z - nz * signed
  const ux = px - s.px
  const uy = py - s.py
  const uz = pz - s.pz
  const u = ux * s.ux + uy * s.uy + uz * s.uz
  const v = ux * s.vx + uy * s.vy + uz * s.vz
  if (Math.abs(u) > s.halfU || Math.abs(v) > s.halfV) return null
  const fx = faceX - px
  const fy = faceY - py
  const fz = faceZ - pz
  if (nx * fx + ny * fy + nz * fz <= 0) return null
  return { distance: signed, px, py, pz, nx, ny, nz }
}

function mulPoint(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ]
}

function mulDir(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
  const ox = m[0] * x + m[4] * y + m[8] * z
  const oy = m[1] * x + m[5] * y + m[9] * z
  const oz = m[2] * x + m[6] * y + m[10] * z
  const len = Math.hypot(ox, oy, oz) || 1
  return [ox / len, oy / len, oz / len]
}
