/**
 * Turn one depth pixel into a view-space point.
 * `inverse` is the column-major inverse of `normDepthBufferFromNormView`.
 * `u` and `v` are 0..1 across the depth image. `depth` is metres.
 *
 * Quest Browser exposes this on a CPU depth frame when the session was
 * granted `depth-sensing`. The view pose then carries the point into the room.
 */
export function viewFromDepthPixel(inverse: ArrayLike<number>, u: number, v: number, depth: number): { x: number; y: number; z: number } | null {
  if (!Number.isFinite(depth) || depth <= 0.05 || depth > 4) return null
  const x = inverse[0] * u + inverse[4] * v + inverse[12]
  const y = inverse[1] * u + inverse[5] * v + inverse[13]
  const z = inverse[2] * u + inverse[6] * v + inverse[14]
  const w = inverse[3] * u + inverse[7] * v + inverse[15]
  if (!Number.isFinite(w) || Math.abs(w) < 1e-6) return null
  const vx = x / w
  const vy = y / w
  const vz = z / w
  if (Math.abs(vz) < 1e-4) return null
  const scale = -depth / vz
  return { x: vx * scale, y: vy * scale, z: vz * scale }
}

/** Column-major matrix times a point. Used to move a view-space point into the room. */
export function transformPoint(matrix: ArrayLike<number>, p: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return {
    x: matrix[0] * p.x + matrix[4] * p.y + matrix[8] * p.z + matrix[12],
    y: matrix[1] * p.x + matrix[5] * p.y + matrix[9] * p.z + matrix[13],
    z: matrix[2] * p.x + matrix[6] * p.y + matrix[10] * p.z + matrix[14],
  }
}
