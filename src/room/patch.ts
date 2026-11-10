/**
 * The little sheet that lifts off a surface. Distances are metres.
 * `u` and `v` run from -1 to 1 across the sheet. `curl` is 0 flat, 1 rolled.
 */

export const PATCH_SPAN = 0.16
export const PATCH_N = 5
/** A pinch this close to the mesh, metres, is on the surface. */
export const TOUCH_GAP = 0.1
/** Pull this far off the surface and the sheet comes free. */
export const FREE_PULL = 0.07
/** Release within this of a different surface and it sticks. */
export const STICK_GAP = 0.09

export interface Vec3 {
  x: number
  y: number
  z: number
}

export function tangentBasis(nx: number, ny: number, nz: number): { tx: number; ty: number; tz: number; bx: number; by: number; bz: number } {
  const ax = Math.abs(ny) < 0.9 ? 0 : 1
  const ay = Math.abs(ny) < 0.9 ? 1 : 0
  const tx = ay * nz - 0 * ny
  const ty = 0 * nx - ax * nz
  const tz = ax * ny - ay * nx
  const tl = Math.hypot(tx, ty, tz) || 1
  const bx = ny * (tz / tl) - nz * (ty / tl)
  const by = nz * (tx / tl) - nx * (tz / tl)
  const bz = nx * (ty / tl) - ny * (tx / tl)
  return { tx: tx / tl, ty: ty / tl, tz: tz / tl, bx, by, bz }
}

/** A point of the sheet before it curls, in world space. */
export function flatPoint(
  hit: Vec3,
  basis: ReturnType<typeof tangentBasis>,
  i: number,
  j: number,
): Vec3 {
  const u = (i / (PATCH_N - 1)) * 2 - 1
  const v = (j / (PATCH_N - 1)) * 2 - 1
  const s = PATCH_SPAN * 0.5
  return {
    x: hit.x + basis.tx * u * s + basis.bx * v * s,
    y: hit.y + basis.ty * u * s + basis.by * v * s,
    z: hit.z + basis.tz * u * s + basis.bz * v * s,
  }
}

/**
 * Curl the sheet around its left edge. Returns an offset in the sheet's
 * own axes: x along the tangent, y along the bitangent, z along the normal.
 */
export function curlOffset(u: number, v: number, curl: number): Vec3 {
  const amount = curl < 0 ? 0 : curl > 1 ? 1 : curl
  const across = (u + 1) * 0.5
  const angle = amount * Math.PI * 0.85 * across
  const radius = PATCH_SPAN * 0.5
  const flatX = across * PATCH_SPAN
  return {
    x: Math.cos(angle) * flatX - radius,
    y: v * radius,
    z: Math.sin(angle) * flatX,
  }
}

/** True when a release is close to a surface and not still on the spot it left. */
export function shouldStick(source: Vec3, target: Vec3, gap: number): boolean {
  const dx = target.x - source.x
  const dy = target.y - source.y
  const dz = target.z - source.z
  const d = Math.hypot(dx, dy, dz)
  return d > 0.05 && d <= gap + PATCH_SPAN
}
