/**
 * Turn one depth reading into a view-space point.
 *
 * WebXR's `getDepthInMeters(u, v)` takes a place in the view from 0 to 1, with
 * the origin at the top left, and answers with the distance from the camera
 * plane. `projection` is that view's column-major projection matrix, which
 * says which way a place in the view looks.
 */
export function viewFromDepth(projection: ArrayLike<number>, u: number, v: number, depth: number): { x: number; y: number; z: number } | null {
  if (!Number.isFinite(depth) || depth <= 0.05 || depth > 4) return null
  const fx = projection[0]
  const fy = projection[5]
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || Math.abs(fx) < 1e-6 || Math.abs(fy) < 1e-6) return null
  const ndcX = u * 2 - 1
  const ndcY = 1 - v * 2
  return {
    x: (depth * (ndcX + projection[8])) / fx,
    y: (depth * (ndcY + projection[9])) / fy,
    z: -depth,
  }
}

/** Column-major matrix times a point. Used to move a view-space point into the room. */
export function transformPoint(matrix: ArrayLike<number>, p: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return {
    x: matrix[0] * p.x + matrix[4] * p.y + matrix[8] * p.z + matrix[12],
    y: matrix[1] * p.x + matrix[5] * p.y + matrix[9] * p.z + matrix[13],
    z: matrix[2] * p.x + matrix[6] * p.y + matrix[10] * p.z + matrix[14],
  }
}
