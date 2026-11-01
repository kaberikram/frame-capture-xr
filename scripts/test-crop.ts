import { cropQuad, type Raster } from '../src/capture/crop.ts'

function raster(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): Raster {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = fill(x, y)
      const i = (y * width + x) * 4
      data[i] = px[0]
      data[i + 1] = px[1]
      data[i + 2] = px[2]
      data[i + 3] = px[3]
    }
  }
  return { width, height, data }
}

function pixel(src: Raster, x: number, y: number): [number, number, number] {
  const i = (y * src.width + x) * 4
  return [src.data[i], src.data[i + 1], src.data[i + 2]]
}

function assertClose(got: number, want: number, label: string): void {
  if (Math.abs(got - want) > 2) throw new Error(`${label}: got ${got}, want ${want}`)
}

const src = raster(120, 80, (x, y) => [x * 2, y * 3, 40, 255])
const cropped = cropQuad(
  src,
  { bl: { x: 10, y: 50 }, br: { x: 70, y: 50 }, tr: { x: 70, y: 20 }, tl: { x: 10, y: 20 } },
  61,
  31,
)
if (!cropped) throw new Error('axis-aligned crop failed')
const mid = pixel(cropped, 30, 15)
assertClose(mid[0], 40 * 2, 'center red')
assertClose(mid[1], 35 * 3, 'center green')
const topLeft = pixel(cropped, 0, 0)
assertClose(topLeft[0], 10 * 2, 'top-left red')
assertClose(topLeft[1], 20 * 3, 'top-left green')
const bottomRight = pixel(cropped, 60, 30)
assertClose(bottomRight[0], 70 * 2, 'bottom-right red')
assertClose(bottomRight[1], 50 * 3, 'bottom-right green')

const perspective = cropQuad(
  src,
  { bl: { x: 8, y: 70 }, br: { x: 100, y: 64 }, tr: { x: 90, y: 12 }, tl: { x: 20, y: 8 } },
  48,
  48,
)
if (!perspective) throw new Error('perspective crop failed')
const sample = pixel(perspective, 24, 24)
if (sample[2] !== 40) throw new Error('perspective sample missed the source')

const collapsed = cropQuad(src, { bl: { x: 0, y: 0 }, br: { x: 1, y: 0 }, tr: { x: 1, y: 0 }, tl: { x: 0, y: 0 } }, 32, 32)
if (collapsed) throw new Error('collapsed quad should fail')

console.info('crop ok')
