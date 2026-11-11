import {
  LinearFilter,
  LinearSRGBColorSpace,
  Matrix4,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
} from '@iwsdk/core'
import type { Clip } from '../capture/camera-rig.js'
import { projectPixel } from '../capture/lens.js'
import type { JointSource } from '../capture/shutter.js'

/** Seconds between the camera frames that are kept. */
const EVERY = 0.35
/** Frames kept: about two seconds, long enough to reach for a wall. */
const KEEP = 6
/** Pixels of clearance a hand joint needs from the piece's patch of image. */
const HAND_CLEAR = 30
/** Long side of the desk's picture of the stand-in room. */
const DESK_LONG = 1024

/** Where a peeled piece gets its picture from. */
export interface PlateSource {
  liveVideo(): HTMLVideoElement | null
  currentClip(): Clip | null
  paintStandIn(target: WebGLRenderTarget, outClip: Matrix4): boolean
}

/**
 * The picture a piece of the room wears: an image of the room, and the lens
 * that took it, so each point of the piece can find itself in the image.
 */
export interface Skin {
  texture: Texture
  clip: Matrix4
  width: number
  height: number
  /** True when the image's first row is its top (a camera frame); false for a render. */
  topDown: boolean
  /** True when the image holds linear light (a render) and not screen-ready bytes (a camera frame). */
  linear: boolean
  /**
   * A copy of just one part of the image, in 0..1 image coordinates, so the
   * piece need not keep a whole camera frame alive. Null when there is nothing
   * to gain.
   */
  crop(u0: number, v0: number, u1: number, v1: number): Promise<Texture | null>
  dispose(): void
}

interface Plate {
  bitmap: ImageBitmap
  texture: Texture
  clip: Matrix4
  width: number
  height: number
  /** Pixel positions of the hand joints when the frame was taken, x then y. */
  joints: Float32Array
  jointCount: number
  pins: number
  retired: boolean
}

/**
 * A short memory of whole camera frames, at full size, with the lens pose of
 * each. When you pinch a wall your hand is in front of it, so the piece takes
 * its picture from the newest frame in which the spot was still clear.
 *
 * On the desk there is no hand in the way: the stand-in room is painted once,
 * when a piece is pinched.
 */
export class RoomPlates {
  private readonly plates: Plate[] = []
  private readonly joints = Array.from({ length: 64 }, () => new Vector3())
  private readonly px = { x: 0, y: 0 }
  private readonly edge = { x: 0, y: 0 }
  private wait = 0
  private busy = false
  private disposed = false

  constructor(
    private readonly source: PlateSource,
    private readonly hands: JointSource,
  ) {}

  get count(): number {
    return this.plates.length
  }

  /** Keep a camera frame every so often while a headset session runs. */
  step(dt: number, presenting: boolean): void {
    if (!presenting) return
    this.wait -= dt
    if (this.wait > 0 || this.busy) return
    const video = this.source.liveVideo()
    const clip = this.source.currentClip()
    if (!video || !clip || typeof createImageBitmap !== 'function') return
    this.wait = EVERY
    this.busy = true
    const pose = clip.clip.clone()
    const width = clip.width
    const height = clip.height
    const count = this.hands.collectJoints(this.joints)
    const joints = new Float32Array(count * 2)
    let kept = 0
    for (let i = 0; i < count; i++) {
      const j = this.joints[i]
      if (!projectPixel(pose, j.x, j.y, j.z, width, height, this.px)) continue
      joints[kept * 2] = this.px.x
      joints[kept * 2 + 1] = this.px.y
      kept++
    }
    createImageBitmap(video)
      .then((bitmap) => {
        this.busy = false
        if (this.disposed) {
          bitmap.close()
          return
        }
        this.plates.push({ bitmap, texture: bitmapTexture(bitmap), clip: pose, width, height, joints, jointCount: kept, pins: 0, retired: false })
        while (this.plates.length > KEEP) this.retire(this.plates.shift() as Plate)
      })
      .catch(() => {
        this.busy = false
      })
  }

  /**
   * A picture for a piece pinched at `center`. `rim` is a few points around the
   * largest size the piece could reach. Null when there is no picture to give;
   * the piece is then a warm film.
   */
  skin(center: Vector3, rim: readonly Vector3[], presenting: boolean): Skin | null {
    if (!presenting) return this.deskSkin()
    let fallback: Plate | null = null
    for (let i = this.plates.length - 1; i >= 0; i--) {
      const plate = this.plates[i]
      const reach = this.footprint(plate, center, rim)
      if (reach < 0) continue
      if (!fallback) fallback = plate
      if (this.handClear(plate, reach)) return this.pin(plate)
    }
    // No frame had the spot clear. The oldest one that saw it has the hand furthest away.
    for (let i = 0; i < this.plates.length; i++) {
      if (this.footprint(this.plates[i], center, rim) >= 0) return this.pin(this.plates[i])
    }
    return fallback ? this.pin(fallback) : null
  }

  dispose(): void {
    this.disposed = true
    for (let i = 0; i < this.plates.length; i++) this.retire(this.plates[i])
    this.plates.length = 0
  }

  /** Pixel radius of the piece in this frame, with its centre left in `px`. -1 when the frame did not see it. */
  private footprint(plate: Plate, center: Vector3, rim: readonly Vector3[]): number {
    if (!projectPixel(plate.clip, center.x, center.y, center.z, plate.width, plate.height, this.px)) return -1
    const cx = this.px.x
    const cy = this.px.y
    if (cx < 0 || cy < 0 || cx > plate.width || cy > plate.height) return -1
    let reach = 8
    for (let i = 0; i < rim.length; i++) {
      const p = rim[i]
      if (!projectPixel(plate.clip, p.x, p.y, p.z, plate.width, plate.height, this.edge)) return -1
      reach = Math.max(reach, Math.hypot(this.edge.x - cx, this.edge.y - cy))
    }
    return reach
  }

  /** Call straight after `footprint`, which leaves the centre in `px`. */
  private handClear(plate: Plate, reach: number): boolean {
    const clear = reach + HAND_CLEAR
    for (let i = 0; i < plate.jointCount; i++) {
      if (Math.hypot(plate.joints[i * 2] - this.px.x, plate.joints[i * 2 + 1] - this.px.y) < clear) return false
    }
    return true
  }

  private pin(plate: Plate): Skin {
    plate.pins += 1
    let held = true
    return {
      texture: plate.texture,
      clip: plate.clip,
      width: plate.width,
      height: plate.height,
      topDown: true,
      linear: false,
      crop: (u0, v0, u1, v1) => {
        const x = Math.max(0, Math.floor(u0 * plate.width))
        const y = Math.max(0, Math.floor(v0 * plate.height))
        const w = Math.min(plate.width - x, Math.ceil((u1 - u0) * plate.width))
        const h = Math.min(plate.height - y, Math.ceil((v1 - v0) * plate.height))
        if (!held || w < 2 || h < 2) return Promise.resolve(null)
        return createImageBitmap(plate.bitmap, x, y, w, h).then(
          (bitmap) => {
            const texture = bitmapTexture(bitmap)
            texture.addEventListener('dispose', () => bitmap.close())
            return texture
          },
          () => null,
        )
      },
      dispose: () => {
        if (!held) return
        held = false
        plate.pins -= 1
        if (plate.retired && plate.pins <= 0) this.close(plate)
      },
    }
  }

  private retire(plate: Plate): void {
    plate.retired = true
    if (plate.pins <= 0) this.close(plate)
  }

  private close(plate: Plate): void {
    plate.texture.dispose()
    plate.bitmap.close()
  }

  /** Paint the stand-in room as the view camera sees it now. The piece owns the picture. */
  private deskSkin(): Skin | null {
    const target = new WebGLRenderTarget(DESK_LONG, DESK_LONG, {
      format: RGBAFormat,
      type: UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    })
    target.texture.minFilter = LinearFilter
    target.texture.magFilter = LinearFilter
    target.texture.generateMipmaps = false
    // The lit room is encoded to sRGB as it is painted, then those bytes are
    // sampled raw, the same path a headset camera frame takes.
    target.texture.colorSpace = SRGBColorSpace
    const clip = new Matrix4()
    if (!this.source.paintStandIn(target, clip)) {
      target.dispose()
      return null
    }
    target.texture.colorSpace = LinearSRGBColorSpace
    return {
      texture: target.texture,
      clip,
      width: DESK_LONG,
      height: DESK_LONG,
      topDown: false,
      linear: true,
      crop: () => Promise.resolve(null),
      dispose: () => target.dispose(),
    }
  }
}

/** A camera frame as a texture. Its bytes are already sRGB and are drawn as they are. */
function bitmapTexture(bitmap: ImageBitmap): Texture {
  const texture = new Texture(bitmap as unknown as HTMLImageElement)
  texture.flipY = false
  texture.colorSpace = LinearSRGBColorSpace
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}
