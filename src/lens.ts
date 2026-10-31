import { Euler, Matrix4, Quaternion, Vector3, type Object3D } from '@iwsdk/core'

const DEG = Math.PI / 180
/** Focal length below is measured at this frame width. Other sizes scale it. */
const REF_W = 1280

export type CameraMount = 'left' | 'right' | 'view'

/**
 * Quest 3 room cameras through getUserMedia. Rectilinear, square pixels; a taller or
 * shorter frame is a centred crop of the same lens.
 *
 * fx = fy = 863 px at 1280 wide. Measured on a Quest 3: 851 drew the far wall 1.4% too
 * large in a lens-overlay check. The left camera sits in front of its own eye, about
 * 6.5 cm ahead of the eyes, tilted 11.8° down. The right camera mirrors yaw, roll and x.
 * Lens x is hardware and does not follow the IPD slider.
 *
 * `?lensf=863&yaw=-0.23&pitch=-11.77&roll=0.14&tau=0.025` trims a headset check without a rebuild.
 */
export interface LensModel {
  focal: number
  pitch: number
  yaw: number
  roll: number
  x: number
  y: number
  z: number
  /** Seconds before the frame stamp that the photo was exposed. */
  tau: number
}

function urlNumber(name: string): number | null {
  if (typeof location === 'undefined') return null
  const raw = new URLSearchParams(location.search).get(name)
  if (raw === null || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

export function lensModel(): LensModel {
  return {
    focal: urlNumber('lensf') ?? 863,
    pitch: urlNumber('pitch') ?? -11.77,
    yaw: urlNumber('yaw') ?? -0.23,
    roll: urlNumber('roll') ?? 0.14,
    x: 0.0325,
    y: 0,
    z: -0.065,
    tau: urlNumber('tau') ?? 0.025,
  }
}

/** Which URL fields overrode the measured lens, for the console line. */
export function lensUrlNote(): string {
  return ['lensf', 'yaw', 'pitch', 'roll', 'tau'].filter((name) => urlNumber(name) !== null).join(',')
}

export function focalPx(frameWidth: number, lens: LensModel): number {
  return lens.focal * (frameWidth / REF_W)
}

/**
 * Which visor camera a device label names. Quest labels end in the camera id
 * ("camera2 50" / "camera2 51", or older "camera 1" / "camera 2"); the lower id is left.
 * A webcam is `view`: its pose is the preview camera, not the visor mount.
 */
export function cameraMount(label: string, facing: 'back' | 'front' | 'unknown', backLabels: readonly string[]): CameraMount {
  const text = label.toLowerCase()
  const back = facing === 'back' || /back|environment|rear/.test(text)
  if (!back) return 'view'
  if (/left/.test(text)) return 'left'
  if (/right/.test(text)) return 'right'
  const id = lastNumber(text)
  if (id === 50 || id === 1) return 'left'
  if (id === 51 || id === 2) return 'right'
  let lowest = Infinity
  for (let i = 0; i < backLabels.length; i++) {
    const n = lastNumber(backLabels[i].toLowerCase())
    if (n < lowest) lowest = n
  }
  return id <= lowest ? 'left' : 'right'
}

function lastNumber(text: string): number {
  const match = /(\d+)\D*$/.exec(text)
  return match ? Number(match[1]) : Infinity
}

/** OpenGL projection from pixel intrinsics. x right, y up, camera looking down -Z. */
export function writeProjection(
  target: Matrix4,
  fx: number,
  fy: number,
  cx: number,
  cy: number,
  width: number,
  height: number,
): void {
  const near = 0.05
  const far = 40
  const x = (2 * fx) / width
  const y = (2 * fy) / height
  const a = 1 - (2 * cx) / width
  const b = (2 * cy) / height - 1
  const c = -(far + near) / (far - near)
  const d = -(2 * far * near) / (far - near)
  target.set(x, 0, a, 0, 0, y, b, 0, 0, 0, c, d, 0, 0, -1, 0)
}

/** Project a world point to image pixels, y down. False when it is behind the camera. */
export function projectPixel(
  clip: Matrix4,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  out: { x: number; y: number },
): boolean {
  const e = clip.elements
  const w = e[3] * x + e[7] * y + e[11] * z + e[15]
  if (w <= 1e-4) return false
  const u = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w) * 0.5 + 0.5
  const v = ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5 + 0.5
  out.x = u * width
  out.y = (1 - v) * height
  return true
}

const POSES = 128
const DISPLAY_SLACK = 0.25

/**
 * Head poses for the visor camera. A frame is posed `tau` seconds before its stamp,
 * which is when Quest’s passthrough image of the room was exposed.
 */
export class HeadsetLens {
  readonly worldToClip = new Matrix4()
  readonly camPos = new Vector3()
  mount: CameraMount = 'left'
  frameW = 0
  frameH = 0

  private readonly lens = lensModel()
  private readonly poses = new Float64Array(POSES * 8)
  private poseHead = -1
  private poseCount = 0
  private readonly pos = new Vector3()
  private readonly quat = new Quaternion()
  private readonly quatB = new Quaternion()
  private readonly scale = new Vector3(1, 1, 1)
  private readonly eyeShift = new Vector3()
  private readonly mountRot = new Matrix4()
  private readonly mountEuler = new Euler(0, 0, 0, 'YXZ')
  private readonly camWorld = new Matrix4()
  private readonly offset = new Matrix4()
  private readonly projection = new Matrix4()
  private mountReady = false
  private logged = false

  /** Call after the input system has moved the head. `shownMs` is the XR frame’s predicted display time. */
  recordHead(head: Object3D, shownMs: number | undefined, now: number): void {
    let at = shownMs !== undefined ? shownMs / 1000 : NaN
    if (!(Math.abs(at - now) <= DISPLAY_SLACK)) at = now
    if (this.poseCount > 0 && at <= this.poses[this.poseHead * 8]) return
    head.matrixWorld.decompose(this.pos, this.quat, this.scale)
    this.poseHead = (this.poseHead + 1) % POSES
    this.poseCount = Math.min(POSES, this.poseCount + 1)
    const o = this.poseHead * 8
    const p = this.poses
    p[o] = at
    p[o + 1] = this.pos.x
    p[o + 2] = this.pos.y
    p[o + 3] = this.pos.z
    p[o + 4] = this.quat.x
    p[o + 5] = this.quat.y
    p[o + 6] = this.quat.z
    p[o + 7] = this.quat.w
  }

  /** Pose at the newest stored head sample, when a frame stamp is missing. */
  projectLatest(width: number, height: number): boolean {
    if (this.poseCount === 0 || width < 2 || height < 2) return false
    const newest = this.poses[this.poseHead * 8]
    return this.projectExposed(newest + this.lens.tau, width, height)
  }

  /**
   * Pose the visor camera at the exposure of the newest frame. `stamp` is the frame clock
   * in seconds (capture time when the browser has one, otherwise arrival).
   */
  projectExposed(stamp: number, width: number, height: number): boolean {
    if (width < 2 || height < 2) return false
    this.frameW = width
    this.frameH = height
    if (!this.poseAt(stamp - this.lens.tau)) return false
    this.writeClip()
    this.logOnce()
    return true
  }

  clear(): void {
    this.poseCount = 0
    this.poseHead = -1
  }

  private writeClip(): void {
    this.refreshMount()
    this.camWorld.compose(this.pos, this.quat, this.scale)
    this.offset.makeTranslation(this.eyeShift.x, this.eyeShift.y, this.eyeShift.z)
    this.camWorld.multiply(this.offset).multiply(this.mountRot)
    const f = focalPx(this.frameW, this.lens)
    writeProjection(this.projection, f, f, this.frameW * 0.5, this.frameH * 0.5, this.frameW, this.frameH)
    this.camPos.setFromMatrixPosition(this.camWorld)
    this.worldToClip.copy(this.camWorld).invert().premultiply(this.projection)
  }

  private refreshMount(): void {
    if (this.mountReady) return
    this.mountReady = true
    const s = this.mount === 'left' ? -1 : 1
    const m = -s
    this.mountEuler.set(this.lens.pitch * DEG, m * this.lens.yaw * DEG, m * this.lens.roll * DEG, 'YXZ')
    this.mountRot.makeRotationFromEuler(this.mountEuler)
    this.eyeShift.set(s * this.lens.x, this.lens.y, this.lens.z)
  }

  private poseAt(time: number): boolean {
    const n = this.poseCount
    if (n === 0) return false
    const p = this.poses
    let newer = this.poseHead
    for (let i = 0; i < n; i++) {
      const idx = (this.poseHead - i + POSES) % POSES
      const o = idx * 8
      if (p[o] <= time) {
        if (i === 0) {
          this.readPose(o)
          return true
        }
        const on = newer * 8
        const span = p[on] - p[o]
        const f = span > 1e-6 ? (time - p[o]) / span : 0
        this.readPose(o)
        this.quatB.set(p[on + 4], p[on + 5], p[on + 6], p[on + 7])
        this.pos.set(
          this.pos.x + (p[on + 1] - this.pos.x) * f,
          this.pos.y + (p[on + 2] - this.pos.y) * f,
          this.pos.z + (p[on + 3] - this.pos.z) * f,
        )
        this.quat.slerp(this.quatB, f)
        return true
      }
      newer = idx
    }
    const oldest = ((this.poseHead - n + 1 + POSES) % POSES) * 8
    if (time < p[oldest] - 0.05) return false
    this.readPose(oldest)
    return true
  }

  private readPose(o: number): void {
    const p = this.poses
    this.pos.set(p[o + 1], p[o + 2], p[o + 3])
    this.quat.set(p[o + 4], p[o + 5], p[o + 6], p[o + 7])
  }

  private logOnce(): void {
    if (this.logged) return
    this.logged = true
    const e = this.eyeShift
    const side = this.mount === 'right' ? 'R' : 'L'
    const url = lensUrlNote()
    console.info(
      `[frame] lens f=${focalPx(this.frameW, this.lens).toFixed(0)} ` +
        `pyr=${this.lens.pitch.toFixed(2)}/${this.lens.yaw.toFixed(2)}/${this.lens.roll.toFixed(2)} ` +
        `cam=${side} ${e.x.toFixed(3)},${e.y.toFixed(3)},${e.z.toFixed(3)} tau=${this.lens.tau.toFixed(3)}` +
        (url ? ` url=${url}` : ''),
    )
  }
}
