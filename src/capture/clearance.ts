/**
 * Is anything (a hand joint) inside the patch of camera image a frame will
 * photograph? Pixels, y down. No imports, so the node test can load it directly.
 */
export interface QuadPx {
  bl: { x: number; y: number }
  br: { x: number; y: number }
  tr: { x: number; y: number }
  tl: { x: number; y: number }
}

/**
 * True when (x, y) is inside the quad grown outward by `margin` pixels.
 * The quad is convex: a frame seen through a pinhole lens.
 */
export function insideQuad(quad: QuadPx, x: number, y: number, margin: number): boolean {
  const pts = [quad.bl, quad.br, quad.tr, quad.tl]
  // Winding: the sign of the area tells which side of each edge is inside.
  let area = 0
  for (let i = 0; i < 4; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % 4]
    area += a.x * b.y - b.x * a.y
  }
  const sign = area >= 0 ? 1 : -1
  for (let i = 0; i < 4; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % 4]
    const ex = b.x - a.x
    const ey = b.y - a.y
    const len = Math.hypot(ex, ey)
    if (len < 1e-6) continue
    // Signed distance from the edge, positive inside.
    const d = (sign * (ex * (y - a.y) - ey * (x - a.x))) / len
    if (d < -margin) return false
  }
  return true
}

/** Margin in pixels for a quad: a small share of its size, so a fingertip just outside still counts. */
export function quadMargin(quad: QuadPx, share: number): number {
  const w = Math.max(Math.hypot(quad.br.x - quad.bl.x, quad.br.y - quad.bl.y), Math.hypot(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y))
  const h = Math.max(Math.hypot(quad.tl.x - quad.bl.x, quad.tl.y - quad.bl.y), Math.hypot(quad.tr.x - quad.br.x, quad.tr.y - quad.br.y))
  return Math.max(w, h) * share
}
