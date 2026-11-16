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

/**
 * Is the neighbouring reading `n` well behind the reading `d`? Then `d` is on
 * the near side of a depth jump: the edge of a thing seen against what is
 * behind it. The gap grows with distance, as depth gets rougher further away.
 * A missing neighbour (0 or NaN) never counts.
 */
export function farther(d: number, n: number): boolean {
  return n > 0 && n - d > 0.04 + 0.06 * d
}

/**
 * Is the reading at `col`, `row` in a grid of readings on the near side of a
 * depth jump? Either a neighbour is well behind it, or the jump is one reading
 * further out: the next reading is on this side and the one past it is well
 * behind both. The field spreads a reading about as far as the next one, so
 * either would spread past the edge into the space the thing hides. On a slope
 * the readings step evenly, so this holds only where each step is a jump.
 */
export function onEdge(m: ArrayLike<number>, cols: number, rows: number, col: number, row: number): boolean {
  const k = col + row * cols
  const d = m[k]
  if (!(d > 0)) return false
  return (
    (col > 0 && jumpPast(d, m[k - 1], col > 1 ? m[k - 2] : 0)) ||
    (col < cols - 1 && jumpPast(d, m[k + 1], col < cols - 2 ? m[k + 2] : 0)) ||
    (row > 0 && jumpPast(d, m[k - cols], row > 1 ? m[k - 2 * cols] : 0)) ||
    (row < rows - 1 && jumpPast(d, m[k + cols], row < rows - 2 ? m[k + 2 * cols] : 0))
  )
}

/** One way along the grid from `d`: `n` is the next reading and `n2` the one past it, 0 off the grid. */
function jumpPast(d: number, n: number, n2: number): boolean {
  return farther(d, n) || (n > 0 && farther(d, n2) && farther(n, n2))
}

/**
 * Is the reading `d` the blur across a step, part way between a near side and
 * a far side? `a` and `b` are its neighbours either side, `a2` and `b2` the
 * next ones out. A step drops the in-between reading: each side is level with
 * the reading beyond it. A slope keeps stepping, so it stays. All four
 * neighbours must be there to tell.
 */
export function mixedPixel(d: number, a: number, b: number, a2: number, b2: number): boolean {
  if (!(a > 0) || !(b > 0) || !(a2 > 0) || !(b2 > 0)) return false
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  const jump = hi - lo
  if (jump <= 0.03 + 0.02 * d) return false
  const f = (d - lo) / jump
  if (!(f >= 0.15 && f <= 0.85)) return false
  return Math.abs(a - a2) < 0.35 * jump && Math.abs(b - b2) < 0.35 * jump
}

/** Part of a view, in the same 0..1 places `getDepthInMeters` takes: left, top, width, height. */
export interface ViewRect {
  u: number
  v: number
  w: number
  h: number
}

/**
 * The part of a view that shows `width` by `height` metres around a point in
 * the room, so depth can be read closely there. `viewMatrix` is the view's
 * pose (column-major, view to room). Null when the point is behind the view,
 * too close, or off to the side.
 */
export function focusRect(
  viewMatrix: ArrayLike<number>,
  projection: ArrayLike<number>,
  point: { x: number; y: number; z: number },
  width: number,
  height: number,
): ViewRect | null {
  const dx = point.x - viewMatrix[12]
  const dy = point.y - viewMatrix[13]
  const dz = point.z - viewMatrix[14]
  const x = viewMatrix[0] * dx + viewMatrix[1] * dy + viewMatrix[2] * dz
  const y = viewMatrix[4] * dx + viewMatrix[5] * dy + viewMatrix[6] * dz
  const depth = -(viewMatrix[8] * dx + viewMatrix[9] * dy + viewMatrix[10] * dz)
  if (!(depth > 0.3)) return null
  const fx = projection[0]
  const fy = projection[5]
  const uc = ((fx * x) / depth - projection[8] + 1) / 2
  const vc = (1 - ((fy * y) / depth - projection[9])) / 2
  if (uc < 0 || uc > 1 || vc < 0 || vc > 1) return null
  const w = Math.min(1, (fx * width) / depth / 2)
  const h = Math.min(1, (fy * height) / depth / 2)
  return {
    u: Math.min(1 - w, Math.max(0, uc - w / 2)),
    v: Math.min(1 - h, Math.max(0, vc - h / 2)),
    w,
    h,
  }
}
