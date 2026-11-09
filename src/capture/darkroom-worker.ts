/**
 * Develops a capture off the render thread: reads the camera frame, warps the
 * frame's quad into a flat photo, and makes the brightness depth that stands in
 * until the model answers. Its own worker, so it never waits behind inference.
 */
import { brightnessDepth, softenField, type DepthField } from './brightness-depth.js'
import { cropQuad, type Quad, type Raster } from './crop.js'

interface DevelopMsg {
  id: number
  quad?: Quad
  outW?: number
  outH?: number
  bitmap?: ImageBitmap
  raster?: Raster
  /** The raster is already the framed photo. Only the depth is needed. */
  framed?: boolean
}

interface DarkroomScope {
  postMessage(message: object, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<DevelopMsg>) => void) | null
}

const scope = self as unknown as DarkroomScope

scope.onmessage = (event) => {
  const msg = event.data
  try {
    const t0 = performance.now()
    if (msg.framed && msg.raster) {
      const photo = msg.raster
      if (photo.width < 2 || photo.height < 2) {
        scope.postMessage({ id: msg.id, error: 'outside' })
        return
      }
      const depth: DepthField = brightnessDepth(photo)
      softenField(depth, 2)
      const timing = { read: 0, crop: 0, depth: performance.now() - t0, read_px: photo.width * photo.height }
      scope.postMessage({ id: msg.id, photo, depth, timing }, [photo.data.buffer, depth.data.buffer])
      return
    }
    if (!msg.quad || !msg.outW || !msg.outH) throw new Error('nothing to develop')
    const source = msg.raster ? { raster: msg.raster, quad: msg.quad } : msg.bitmap ? readBitmap(msg.bitmap, msg.quad) : null
    if (!source) throw new Error('nothing to develop')
    const t1 = performance.now()
    const photo = cropQuad(source.raster, source.quad, msg.outW, msg.outH)
    const t2 = performance.now()
    if (!photo) {
      scope.postMessage({ id: msg.id, error: 'outside' })
      return
    }
    const depth: DepthField = brightnessDepth(photo)
    softenField(depth, 2)
    const t3 = performance.now()
    const timing = { read: t1 - t0, crop: t2 - t1, depth: t3 - t2, read_px: source.raster.width * source.raster.height }
    scope.postMessage({ id: msg.id, photo, depth, timing }, [photo.data.buffer, depth.data.buffer])
  } catch (err) {
    scope.postMessage({ id: msg.id, error: err instanceof Error ? err.message : 'develop failed' })
  }
}

/** Read only the part of the frame the quad covers, and shift the quad to match. */
function readBitmap(bitmap: ImageBitmap, quad: Quad): { raster: Raster; quad: Quad } {
  const xs = [quad.bl.x, quad.br.x, quad.tr.x, quad.tl.x]
  const ys = [quad.bl.y, quad.br.y, quad.tr.y, quad.tl.y]
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1)
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1)
  const x1 = Math.min(bitmap.width, Math.ceil(Math.max(...xs)) + 2)
  const y1 = Math.min(bitmap.height, Math.ceil(Math.max(...ys)) + 2)
  const width = Math.max(2, x1 - x0)
  const height = Math.max(2, y1 - y0)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas is unavailable in the worker')
  ctx.drawImage(bitmap, x0, y0, width, height, 0, 0, width, height)
  bitmap.close()
  const image = ctx.getImageData(0, 0, width, height)
  const shift = (p: { x: number; y: number }) => ({ x: p.x - x0, y: p.y - y0 })
  return {
    raster: { width, height, data: image.data },
    quad: { bl: shift(quad.bl), br: shift(quad.br), tr: shift(quad.tr), tl: shift(quad.tl) },
  }
}
