import { fitDepth, settleDepth, softenField, type DepthField } from '../src/capture/brightness-depth.ts'

// The brute-force versions these replaced, kept here as the reference.
function erodeRef(src: Uint8Array, width: number, height: number, radius: number): void {
  const copy = new Uint8Array(src)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let lo = 255
      for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) {
        for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) {
          const v = copy[yy * width + xx]
          if (v < lo) lo = v
        }
      }
      src[y * width + x] = lo
    }
  }
}

function blurRef(src: Uint8Array, width: number, height: number, radius: number): void {
  const copy = new Uint8Array(src)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      let n = 0
      for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) {
        for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) {
          sum += copy[yy * width + xx]
          n++
        }
      }
      src[y * width + x] = Math.round(sum / n)
    }
  }
}

function settleRef(field: DepthField): void {
  const radius = Math.max(2, Math.round(Math.min(field.width, field.height) * 0.04))
  erodeRef(field.data, field.width, field.height, radius)
  blurRef(field.data, field.width, field.height, Math.max(2, Math.round(radius * 0.65)))
}

function randomField(width: number, height: number, seed: number): DepthField {
  let s = seed
  const data = new Uint8Array(width * height)
  for (let i = 0; i < data.length; i++) {
    s = (s * 16807) % 2147483647
    // Smooth-ish blobs plus noise, like a depth map.
    const x = i % width
    const y = (i / width) | 0
    data[i] = Math.max(0, Math.min(255, Math.round(128 + 90 * Math.sin(x * 0.07) * Math.cos(y * 0.05) + ((s % 41) - 20))))
  }
  return { width, height, data }
}

function maxDiff(a: Uint8Array, b: Uint8Array): number {
  let worst = 0
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
  return worst
}

for (const [w, h] of [[96, 64], [61, 83], [160, 120]] as const) {
  const a = randomField(w, h, 7 + w)
  const b = { ...a, data: new Uint8Array(a.data) }
  settleDepth(a)
  settleRef(b)
  const d = maxDiff(a.data, b.data)
  if (d > 1) throw new Error(`settle ${w}x${h} differs by ${d}`)
  const c = randomField(w, h, 3 + h)
  const e = { ...c, data: new Uint8Array(c.data) }
  softenField(c, 2)
  blurRef(e.data, w, h, 2)
  if (maxDiff(c.data, e.data) > 1) throw new Error(`soften ${w}x${h} differs`)
}

// The full-size model map that used to be processed on the render thread.
{
  const big = randomField(640, 480, 11)
  const ref = { ...big, data: new Uint8Array(big.data) }
  let t = performance.now()
  settleDepth(big)
  const fast = performance.now() - t
  t = performance.now()
  settleRef(ref)
  const slow = performance.now() - t
  if (maxDiff(big.data, ref.data) > 1) throw new Error('settle 640x480 differs')
  if (fast * 5 > slow) throw new Error(`separable settle should be much faster: ${fast.toFixed(0)} ms vs ${slow.toFixed(0)} ms`)
  console.log(`settle 640x480: ${fast.toFixed(0)} ms separable, ${slow.toFixed(0)} ms brute force`)
}

// fitDepth averages down to the long side and leaves small maps alone.
{
  const field: DepthField = { width: 4, height: 2, data: new Uint8Array([0, 10, 20, 30, 40, 50, 60, 70]) }
  if (fitDepth(field, 256) !== field) throw new Error('a small map should pass through')
  const big = randomField(640, 480, 5)
  const fit = fitDepth(big, 256)
  if (fit.width !== 256 || fit.height !== 192) throw new Error(`fit size ${fit.width}x${fit.height}`)
  let sumA = 0
  let sumB = 0
  for (let i = 0; i < big.data.length; i++) sumA += big.data[i]
  for (let i = 0; i < fit.data.length; i++) sumB += fit.data[i]
  if (Math.abs(sumA / big.data.length - sumB / fit.data.length) > 1) throw new Error('fit should keep the mean')
}

console.log('depth ok')
