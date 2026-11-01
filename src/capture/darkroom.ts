import { brightnessDepth, softenField, type DepthField } from './brightness-depth.js'
import { cropQuad, type Quad, type Raster } from './crop.js'

export interface Developed {
  photo: Raster
  /** Brightness depth, already softened, for the frame to show until the model answers. */
  preview: DepthField
}

interface Reply {
  id: number
  error?: string
  photo?: Raster
  depth?: DepthField
  timing?: Record<string, number>
}

let worker: Worker | null = null
let broken = false
let nextId = 0
const waiting = new Map<number, { resolve: (value: Developed | null) => void; reject: (error: Error) => void }>()

/** The worker reads camera frames itself when the browser lets a worker draw an ImageBitmap. */
export const canSnapshot =
  typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined'

function darkroom(): Worker | null {
  if (worker || broken) return worker
  try {
    const thread = new Worker(new URL('./darkroom-worker.ts', import.meta.url), { type: 'module' })
    thread.addEventListener('message', (event: MessageEvent<Reply>) => {
      const reply = event.data
      const job = waiting.get(reply.id)
      if (!job) return
      waiting.delete(reply.id)
      if (reply.timing) console.info(`[frame] darkroom ${Object.entries(reply.timing).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')}`)
      if (reply.photo && reply.depth) job.resolve({ photo: reply.photo, preview: reply.depth })
      else if (reply.error === 'outside') job.resolve(null)
      else job.reject(new Error(reply.error ?? 'develop failed'))
    })
    thread.addEventListener('error', () => {
      broken = true
      worker = null
      thread.terminate()
      for (const job of waiting.values()) job.reject(new Error('darkroom worker failed'))
      waiting.clear()
    })
    worker = thread
  } catch {
    broken = true
  }
  return worker
}

/** Start the worker early so the first capture does not pay for it. */
export function prepareDarkroom(): void {
  darkroom()
}

/**
 * Grab the part of the video's current frame that the quad covers, without
 * reading its pixels on this thread. The quad comes back shifted to match.
 */
export function snapshot(video: HTMLVideoElement, quad: Quad): Promise<{ bitmap: ImageBitmap; quad: Quad }> | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!canSnapshot || vw < 2 || vh < 2) return null
  const xs = [quad.bl.x, quad.br.x, quad.tr.x, quad.tl.x]
  const ys = [quad.bl.y, quad.br.y, quad.tr.y, quad.tl.y]
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1)
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1)
  const x1 = Math.min(vw, Math.ceil(Math.max(...xs)) + 2)
  const y1 = Math.min(vh, Math.ceil(Math.max(...ys)) + 2)
  if (x1 - x0 < 2 || y1 - y0 < 2) return null
  const shift = (p: { x: number; y: number }) => ({ x: p.x - x0, y: p.y - y0 })
  const shifted: Quad = { bl: shift(quad.bl), br: shift(quad.br), tr: shift(quad.tr), tl: shift(quad.tl) }
  return createImageBitmap(video, x0, y0, x1 - x0, y1 - y0).then((bitmap) => ({ bitmap, quad: shifted }))
}

/**
 * Warp the quad into a `outW`×`outH` photo and make its brightness depth.
 * Resolves null when the quad misses the image. Falls back to this thread when
 * the worker cannot run.
 */
export function develop(source: { bitmap: ImageBitmap } | { raster: Raster }, quad: Quad, outW: number, outH: number): Promise<Developed | null> {
  const thread = darkroom()
  if (!thread) return Promise.resolve(developHere(source, quad, outW, outH))
  const id = ++nextId
  return new Promise<Developed | null>((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    if ('bitmap' in source) thread.postMessage({ id, quad, outW, outH, bitmap: source.bitmap }, [source.bitmap])
    else thread.postMessage({ id, quad, outW, outH, raster: source.raster }, [source.raster.data.buffer])
  }).catch((error: unknown) => {
    console.warn('[frame] darkroom', error)
    return 'raster' in source && source.raster.data.byteLength > 0 ? developHere(source, quad, outW, outH) : null
  })
}

function developHere(source: { bitmap: ImageBitmap } | { raster: Raster }, quad: Quad, outW: number, outH: number): Developed | null {
  if (!('raster' in source)) return null
  const photo = cropQuad(source.raster, quad, outW, outH)
  if (!photo) return null
  const preview = brightnessDepth(photo)
  softenField(preview, 2)
  return { photo, preview }
}
