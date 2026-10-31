import type { Raster } from './crop.js'

export interface DepthField {
  width: number
  height: number
  data: Uint8Array
}

/**
 * Stand-in when Depth Anything has not arrived. Bright pixels read as near,
 * then the 2nd–98th percentile is stretched so a flat scene still has relief.
 */
export function brightnessDepth(raster: Raster, longSide = 160): DepthField {
  const aspect = raster.width / raster.height
  const width = aspect >= 1 ? longSide : Math.max(8, Math.round(longSide * aspect))
  const height = aspect >= 1 ? Math.max(8, Math.round(longSide / aspect)) : longSide
  const gray = new Uint8Array(width * height)
  const hist = new Uint32Array(256)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(raster.height - 1, Math.floor(((y + 0.5) / height) * raster.height))
    for (let x = 0; x < width; x++) {
      const sx = Math.min(raster.width - 1, Math.floor(((x + 0.5) / width) * raster.width))
      const i = (sy * raster.width + sx) * 4
      const luma = raster.data[i] * 0.2126 + raster.data[i + 1] * 0.7152 + raster.data[i + 2] * 0.0722
      const v = luma < 0 ? 0 : luma > 255 ? 255 : luma
      gray[y * width + x] = v
      hist[v]++
    }
  }
  stretch(gray, hist, gray.length)
  // A small bright speck (a window pane) would stand up as a spike. Erode
  // near regions so only shapes wider than the kernel keep their height.
  erode(gray, width, height, Math.max(2, Math.round(Math.min(width, height) * 0.09)))
  blur(gray, width, height, 3)
  return { width, height, data: gray }
}

function erode(src: Uint8Array, width: number, height: number, radius: number): void {
  const copy = new Uint8Array(src)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let lo = 255
      const y0 = Math.max(0, y - radius)
      const y1 = Math.min(height - 1, y + radius)
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(width - 1, x + radius)
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * width
        for (let xx = x0; xx <= x1; xx++) {
          const v = copy[row + xx]
          if (v < lo) lo = v
        }
      }
      src[y * width + x] = lo
    }
  }
}

/**
 * Subtract the best-fit plane and stretch what’s left. A photo of a flat wall
 * comes back tilted; the relief should be the bulge relative to the frame.
 */
export function detrendDepth(field: DepthField): void {
  const { width, height, data } = field
  const count = data.length
  if (count < 16) return
  let mean = 0
  for (let i = 0; i < count; i++) mean += data[i]
  mean /= count
  let sxz = 0
  let syz = 0
  let sxx = 0
  let syy = 0
  const cx0 = (width - 1) / 2
  const cy0 = (height - 1) / 2
  for (let y = 0; y < height; y++) {
    const cy = y - cy0
    const row = y * width
    for (let x = 0; x < width; x++) {
      const cx = x - cx0
      const z = data[row + x] - mean
      sxz += cx * z
      syz += cy * z
      sxx += cx * cx
      syy += cy * cy
    }
  }
  const b = sxx > 0 ? sxz / sxx : 0
  const c = syy > 0 ? syz / syy : 0
  const residual = new Float32Array(count)
  for (let y = 0; y < height; y++) {
    const cy = y - cy0
    const row = y * width
    for (let x = 0; x < width; x++) {
      residual[row + x] = data[row + x] - mean - b * (x - cx0) - c * cy
    }
  }
  const sorted = Float32Array.from(residual).sort()
  const at = (q: number) => sorted[Math.min(count - 1, Math.max(0, Math.round(q * (count - 1))))]
  const lo = at(0.02)
  const hi = at(0.98)
  const span = hi - lo
  if (span < 4) return
  for (let i = 0; i < count; i++) {
    let v = ((residual[i] - lo) / span) * 255
    if (v < 0) v = 0
    else if (v > 255) v = 255
    data[i] = v
  }
}

/** Knock down thin spikes, then blur, so a model cliff does not stand up as a sheet. */
export function settleDepth(field: DepthField): void {
  const radius = Math.max(2, Math.round(Math.min(field.width, field.height) * 0.04))
  erode(field.data, field.width, field.height, radius)
  blur(field.data, field.width, field.height, Math.max(2, Math.round(radius * 0.65)))
}

/** A light blur so a depth map’s grain does not ripple the relief. */
export function softenField(field: DepthField, radius = 2): void {
  blur(field.data, field.width, field.height, radius)
}

function blur(src: Uint8Array, width: number, height: number, radius: number): void {
  const copy = new Uint8Array(src)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      let n = 0
      const y0 = Math.max(0, y - radius)
      const y1 = Math.min(height - 1, y + radius)
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(width - 1, x + radius)
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * width
        for (let xx = x0; xx <= x1; xx++) {
          sum += copy[row + xx]
          n++
        }
      }
      src[y * width + x] = Math.round(sum / n)
    }
  }
}

function stretch(gray: Uint8Array, hist: Uint32Array, count: number): void {
  const cutoff = Math.max(1, Math.round(count * 0.02))
  let lo = 0
  let hi = 255
  let acc = 0
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= cutoff) {
      lo = v
      break
    }
  }
  acc = 0
  for (let v = 255; v >= 0; v--) {
    acc += hist[v]
    if (acc >= cutoff) {
      hi = v
      break
    }
  }
  const spread = hi - lo
  if (spread < 8) return
  const scale = 255 / spread
  for (let i = 0; i < count; i++) {
    let v = (gray[i] - lo) * scale
    if (v < 0) v = 0
    else if (v > 255) v = 255
    gray[i] = v
  }
}
