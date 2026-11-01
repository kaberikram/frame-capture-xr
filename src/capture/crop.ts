/** RGBA, row-major, y down. */
export interface Raster {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface Px {
  x: number
  y: number
}

/** Frame corners in image pixels, y down. */
export interface Quad {
  bl: Px
  br: Px
  tr: Px
  tl: Px
}

const SRC_UV: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]

/**
 * Warp the camera quad that the frame covers into a rectangle of `outW`×`outH`.
 * Frame UV (0,0) is the bottom-left corner. The mapping is the homography of a
 * pinhole view of a planar frame, so the crop matches the photo the lens took.
 * Null when the corners collapse or the solve fails.
 */
export function cropQuad(src: Raster, quad: Quad, outW: number, outH: number): Raster | null {
  if (outW < 2 || outH < 2 || src.width < 2 || src.height < 2) return null
  if (quadArea(quad) < 4) return null
  const pts: [number, number][] = [
    [quad.bl.x / src.width, quad.bl.y / src.height],
    [quad.br.x / src.width, quad.br.y / src.height],
    [quad.tr.x / src.width, quad.tr.y / src.height],
    [quad.tl.x / src.width, quad.tl.y / src.height],
  ]
  const h = solveHomography(pts)
  if (!h) return null
  const out = new Uint8ClampedArray(outW * outH * 4)
  const sw = src.width
  const sh = src.height
  const sd = src.data
  for (let y = 0; y < outH; y++) {
    const v = outH === 1 ? 1 : 1 - y / (outH - 1)
    for (let x = 0; x < outW; x++) {
      const u = outW === 1 ? 0 : x / (outW - 1)
      const den = h[6] * u + h[7] * v + 1
      if (Math.abs(den) < 1e-8) continue
      const sx = ((h[0] * u + h[1] * v + h[2]) / den) * sw
      const sy = ((h[3] * u + h[4] * v + h[5]) / den) * sh
      sample(sd, sw, sh, sx, sy, out, (y * outW + x) * 4)
    }
  }
  return { width: outW, height: outH, data: out }
}

/** Long side `longSide`, aspect width/height of the frame in metres. */
export function cropSize(aspect: number, longSide: number): { width: number; height: number } {
  const a = Math.max(0.05, aspect)
  if (a >= 1) return { width: longSide, height: Math.max(2, Math.round(longSide / a)) }
  return { width: Math.max(2, Math.round(longSide * a)), height: longSide }
}

function quadArea(quad: Quad): number {
  return Math.abs(tri(quad.bl, quad.br, quad.tr)) + Math.abs(tri(quad.bl, quad.tr, quad.tl))
}

function tri(a: Px, b: Px, c: Px): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

/** Maps frame UV to normalized image coords. Eight coefficients, h8 = 1. */
function solveHomography(dst: [number, number][]): Float64Array | null {
  const A = new Float64Array(64)
  const b = new Float64Array(8)
  for (let i = 0; i < 4; i++) {
    const u = SRC_UV[i][0]
    const v = SRC_UV[i][1]
    const x = dst[i][0]
    const y = dst[i][1]
    const r0 = i * 2
    const r1 = r0 + 1
    A[r0 * 8] = u
    A[r0 * 8 + 1] = v
    A[r0 * 8 + 2] = 1
    A[r0 * 8 + 6] = -x * u
    A[r0 * 8 + 7] = -x * v
    b[r0] = x
    A[r1 * 8 + 3] = u
    A[r1 * 8 + 4] = v
    A[r1 * 8 + 5] = 1
    A[r1 * 8 + 6] = -y * u
    A[r1 * 8 + 7] = -y * v
    b[r1] = y
  }
  return solve8(A, b)
}

function solve8(A: Float64Array, b: Float64Array): Float64Array | null {
  const m = new Float64Array(8 * 9)
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) m[r * 9 + c] = A[r * 8 + c]
    m[r * 9 + 8] = b[r]
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col
    let best = Math.abs(m[col * 9 + col])
    for (let r = col + 1; r < 8; r++) {
      const v = Math.abs(m[r * 9 + col])
      if (v > best) {
        best = v
        pivot = r
      }
    }
    if (best < 1e-12) return null
    if (pivot !== col) {
      for (let c = col; c < 9; c++) {
        const tmp = m[col * 9 + c]
        m[col * 9 + c] = m[pivot * 9 + c]
        m[pivot * 9 + c] = tmp
      }
    }
    const div = m[col * 9 + col]
    for (let c = col; c < 9; c++) m[col * 9 + c] /= div
    for (let r = 0; r < 8; r++) {
      if (r === col) continue
      const f = m[r * 9 + col]
      if (f === 0) continue
      for (let c = col; c < 9; c++) m[r * 9 + c] -= f * m[col * 9 + c]
    }
  }
  const h = new Float64Array(8)
  for (let r = 0; r < 8; r++) h[r] = m[r * 9 + 8]
  return h
}

function sample(src: Uint8ClampedArray, w: number, h: number, x: number, y: number, dst: Uint8ClampedArray, o: number): void {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = x - x0
  const ty = y - y0
  const x1 = x0 + 1
  const y1 = y0 + 1
  const i00 = at(src, w, h, x0, y0)
  const i10 = at(src, w, h, x1, y0)
  const i01 = at(src, w, h, x0, y1)
  const i11 = at(src, w, h, x1, y1)
  const w00 = (1 - tx) * (1 - ty)
  const w10 = tx * (1 - ty)
  const w01 = (1 - tx) * ty
  const w11 = tx * ty
  dst[o] = i00[0] * w00 + i10[0] * w10 + i01[0] * w01 + i11[0] * w11
  dst[o + 1] = i00[1] * w00 + i10[1] * w10 + i01[1] * w01 + i11[1] * w11
  dst[o + 2] = i00[2] * w00 + i10[2] * w10 + i01[2] * w01 + i11[2] * w11
  dst[o + 3] = 255
}

function at(src: Uint8ClampedArray, w: number, h: number, x: number, y: number): readonly [number, number, number] {
  const cx = x < 0 ? 0 : x >= w ? w - 1 : x
  const cy = y < 0 ? 0 : y >= h ? h - 1 : y
  const i = (cy * w + cx) * 4
  return [src[i], src[i + 1], src[i + 2]]
}
