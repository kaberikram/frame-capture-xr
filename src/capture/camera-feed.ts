import type { Raster } from './crop.js'

interface FrameClock {
  stamp: number
  known: boolean
}

/**
 * The live camera element. On Quest this is the visor camera IWSDK opened.
 * On the desk it is a webcam when `?cam=1` granted one. Frames are stamped so
 * the visor pose can be rewound to the exposure.
 */
export class CameraFeed {
  video: HTMLVideoElement | null = null
  private track: MediaStreamTrack | null = null
  private rvfc = -1
  private readonly clock: FrameClock = { stamp: 0, known: false }
  private logged = false

  get width(): number {
    return this.video?.videoWidth ?? 0
  }

  get height(): number {
    return this.video?.videoHeight ?? 0
  }

  /** Page-clock seconds of the newest frame, or null when the element has not reported one. */
  get stamp(): number | null {
    return this.clock.known ? this.clock.stamp : null
  }

  watch(video: HTMLVideoElement | null, track: MediaStreamTrack | null): boolean {
    if (video !== this.video) {
      if (this.video && this.rvfc >= 0) this.video.cancelVideoFrameCallback?.(this.rvfc)
      this.video = video
      this.rvfc = -1
      this.clock.known = false
      this.logged = false
      if (video && typeof video.requestVideoFrameCallback === 'function') {
        this.rvfc = video.requestVideoFrameCallback(this.onFrame)
      }
    }
    if (track && track !== this.track) {
      this.track = track
      const settings = track.getSettings()
      console.info(`[frame] camera "${track.label}" ${settings.width ?? '?'}x${settings.height ?? '?'}`)
    }
    return !!video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0
  }

  grab(): Raster | null {
    const video = this.video
    if (!video || video.videoWidth < 2 || video.videoHeight < 2) return null
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    return { width: canvas.width, height: canvas.height, data: image.data }
  }

  dispose(): void {
    if (this.video && this.rvfc >= 0) this.video.cancelVideoFrameCallback?.(this.rvfc)
    this.video = null
    this.rvfc = -1
  }

  private readonly onFrame = (callbackNow: number, meta: VideoFrameCallbackMetadata): void => {
    const video = this.video
    if (!video) return
    const arrival = callbackNow / 1000
    let stamp = arrival
    if (meta.captureTime !== undefined) stamp = meta.captureTime / 1000
    else if (meta.expectedDisplayTime > 0) stamp = meta.expectedDisplayTime / 1000
    if (stamp > arrival + 0.01 || stamp < arrival - 0.5) stamp = arrival
    this.clock.stamp = stamp
    this.clock.known = true
    if (!this.logged) {
      this.logged = true
      const clock = meta.captureTime !== undefined ? 'capture' : meta.expectedDisplayTime > 0 ? 'expected' : 'arrival'
      console.info(`[frame] camera frames rVFC ${video.videoWidth}x${video.videoHeight} clock=${clock}`)
    }
    this.rvfc = video.requestVideoFrameCallback(this.onFrame)
  }
}

export function rasterFromPixels(flipped: Uint8Array, width: number, height: number): Raster {
  const data = new Uint8ClampedArray(width * height * 4)
  const row = width * 4
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * row
    data.set(flipped.subarray(src, src + row), y * row)
  }
  return { width, height, data }
}
