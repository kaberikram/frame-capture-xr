import {
  CameraFacing,
  CameraSource,
  CameraState,
  CameraUtils,
  Color,
  Group,
  Matrix4,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
  type CameraDeviceInfo,
  type Entity,
  type Object3D,
} from '@iwsdk/core'
import type { Ctx } from '../app/context.js'
import { WEBCAM_REQUESTED } from '../app/experience.js'
import { CameraFeed, rasterFromPixels } from './camera-feed.js'
import type { Quad, Raster } from './crop.js'
import { snapshot } from './darkroom.js'
import { HeadsetLens, cameraMount, projectPixel } from './lens.js'

export interface Clip {
  clip: Matrix4
  width: number
  height: number
}

/** Seconds to wait on the camera permission before letting a retry ask again. */
const ARM_PATIENCE = 12

/** Has this page already been allowed the camera? False when it has not, or when the browser cannot say. */
export async function cameraAllowed(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'camera' as PermissionName })
    return status.state === 'granted'
  } catch {
    return false
  }
}

/** What to tell the person when the camera request failed, by the browser's error name. */
export function cameraProblem(error: unknown): string {
  const name = error instanceof Error || error instanceof DOMException ? error.name : ''
  if (!navigator.mediaDevices) return 'The camera needs the https address'
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The camera is blocked. Allow headset cameras for this site, then reload'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No headset camera found. Photos need a Quest 3 or 3S with current software'
  if (name === 'NotReadableError' || name === 'AbortError') return 'The camera is busy. Close other tabs or apps using it'
  return 'The camera did not start'
}

/**
 * Where a photo comes from: the Quest visor camera in a session, a webcam on the
 * desk with `?cam=1`, or a render of the stand-in room otherwise. Also projects
 * frame corners into that image.
 */
export class CameraRig {
  readonly lens = new HeadsetLens()
  readonly feed = new CameraFeed()
  /** Why the camera is not running, in words for the person, or null. */
  problem: string | null = null
  private cameraEntity: Entity | null = null
  private webcam: HTMLVideoElement | null = null
  private webcamStream: MediaStream | null = null
  private arming: Promise<boolean> | null = null
  private cameraWanted = false
  private rearmTries = 0
  private rearmAt = 0
  private target: WebGLRenderTarget | null = null
  private pixelBuf = new Uint8Array(0)
  private readonly viewClip = new Matrix4()
  private readonly prevClear = new Color()
  private readonly corner = [new Vector3(), new Vector3(), new Vector3(), new Vector3()]
  private readonly px = { x: 0, y: 0 }

  /** `overlays` lists everything the app drew, hidden while the stand-in room is photographed. */
  constructor(
    private readonly ctx: Ctx,
    private readonly deskColor: Color,
    private readonly overlays: () => readonly Object3D[],
  ) {}

  /**
   * Ask for the camera and pick the visor camera. A permission prompt that is
   * answered late still starts the camera, but after `ARM_PATIENCE` this stops
   * waiting so a retry can ask again.
   */
  arm(): Promise<boolean> {
    this.cameraWanted = true
    if (this.cameraEntity) return Promise.resolve(true)
    if (this.arming) return this.arming
    const asked = CameraUtils.getDevices().then(
      (devices) => this.attach(devices),
      (error: unknown) => {
        this.problem = cameraProblem(error)
        console.warn(`[frame] camera arm failed: ${this.problem}`, error)
        return false
      },
    )
    const patience = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        if (!this.cameraEntity && !this.problem) this.problem = 'The camera did not answer. Reload and allow headset cameras'
        resolve(false)
      }, ARM_PATIENCE * 1000)
    })
    const arming = Promise.race([asked, patience]).then((ok) => {
      if (this.arming === arming) this.arming = null
      return ok
    })
    this.arming = arming
    return arming
  }

  /** Try again a few times, backing off, when the camera did not come up. */
  rearm(now: number): void {
    if (!this.cameraWanted || this.cameraEntity || this.arming || this.rearmTries >= 3 || now < this.rearmAt) return
    this.rearmTries += 1
    this.rearmAt = now + 2 ** (this.rearmTries - 1)
    void this.arm()
  }

  /** The camera failed and every retry is spent, so waiting longer will not help. */
  get unavailable(): boolean {
    return this.cameraWanted && !this.cameraEntity && !this.arming && this.rearmTries >= 3
  }

  /** One word for the debug panel: asking, starting, active, error, or off. */
  get state(): string {
    if (this.cameraEntity) return String(this.cameraEntity.getValue(CameraSource, 'state'))
    return this.arming ? 'asking' : 'off'
  }

  watchQuest(): void {
    const entity = this.cameraEntity
    if (!entity) return
    const state = String(entity.getValue(CameraSource, 'state'))
    // IWSDK logs the error and tries again on its own; remember that it failed.
    if (state === CameraState.Error && !this.problem) this.problem = 'The camera would not open. Close other tabs or apps using it'
    if (state !== CameraState.Active) return
    this.problem = null
    const video = entity.getValue(CameraSource, 'videoElement') as HTMLVideoElement | null
    const stream = entity.getValue(CameraSource, 'stream') as MediaStream | null
    this.feed.watch(video, stream?.getVideoTracks()[0] ?? null)
  }

  watchWebcam(): void {
    if (this.webcam) this.feed.watch(this.webcam, this.webcamStream?.getVideoTracks()[0] ?? null)
  }

  stop(): void {
    const entity = this.cameraEntity
    if (!entity) return
    const stream = entity.getValue(CameraSource, 'stream') as MediaStream | null
    stream?.getTracks().forEach((track) => track.stop())
    const video = entity.getValue(CameraSource, 'videoElement') as HTMLVideoElement | null
    if (video) {
      video.pause()
      video.srcObject = null
    }
    entity.dispose({ disposeResources: false })
    this.cameraEntity = null
    this.feed.dispose()
  }

  openWebcam(): void {
    if (!navigator.mediaDevices?.getUserMedia || this.webcam) return
    void navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((stream) => {
        const video = document.createElement('video')
        video.playsInline = true
        video.muted = true
        video.srcObject = stream
        void video.play()
        this.webcam = video
        this.webcamStream = stream
        console.info('[frame] webcam on')
      })
      .catch((error: unknown) => {
        console.warn('[frame] webcam unavailable', error)
      })
  }

  /** Image pixels of a frame's four corners, bl, br, tr, tl. Null when one falls behind the camera. */
  projectGroup(group: Group, hw: number, hh: number): Quad | null {
    const local: readonly [number, number][] = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ]
    for (let i = 0; i < 4; i++) {
      this.corner[i].set(local[i][0], local[i][1], 0)
      group.localToWorld(this.corner[i])
    }
    const raster = this.currentClip()
    if (!raster) return null
    const names = ['bl', 'br', 'tr', 'tl'] as const
    const quad: Quad = { bl: { x: 0, y: 0 }, br: { x: 0, y: 0 }, tr: { x: 0, y: 0 }, tl: { x: 0, y: 0 } }
    for (let i = 0; i < 4; i++) {
      const p = this.corner[i]
      if (!projectPixel(raster.clip, p.x, p.y, p.z, raster.width, raster.height, this.px)) return null
      quad[names[i]].x = this.px.x
      quad[names[i]].y = this.px.y
    }
    return quad
  }

  currentClip(): Clip | null {
    const { renderer, camera } = this.ctx
    if (renderer.xr.isPresenting) {
      const w = this.feed.width
      const h = this.feed.height
      if (w < 2 || h < 2) return null
      const stamp = this.feed.stamp
      const posed = stamp !== null && this.lens.projectExposed(stamp, w, h)
      if (!posed && !this.lens.projectLatest(w, h)) return null
      return { clip: this.lens.worldToClip, width: w, height: h }
    }
    if (this.useWebcam) {
      camera.updateMatrixWorld()
      this.viewClip.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse)
      return { clip: this.viewClip, width: this.feed.width, height: this.feed.height }
    }
    const size = this.roomTargetSize()
    if (!size) return null
    camera.updateMatrixWorld()
    this.viewClip.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse)
    return { clip: this.viewClip, width: size.width, height: size.height }
  }

  /**
   * The camera image under a quad, taken now. A live camera hands back an
   * ImageBitmap of just that region, which the darkroom worker reads, so its
   * pixels never touch this thread. The desk's stand-in room is a render read
   * back as pixels.
   */
  takePicture(quad: Quad): Promise<{ source: { bitmap: ImageBitmap } | { raster: Raster }; quad: Quad }> | null {
    if (this.ctx.renderer.xr.isPresenting || this.useWebcam) {
      const video = this.feed.video
      const shot = video ? snapshot(video, quad) : null
      if (shot) return shot.then(({ bitmap, quad: shifted }) => ({ source: { bitmap }, quad: shifted }))
      const raster = this.feed.grab()
      return raster ? Promise.resolve({ source: { raster }, quad }) : null
    }
    const raster = this.grabRoom()
    return raster ? Promise.resolve({ source: { raster }, quad }) : null
  }

  /** Headset or webcam image, or null when the desk should paint the stand-in. */
  liveVideo(): HTMLVideoElement | null {
    if (!(this.ctx.renderer.xr.isPresenting || this.useWebcam)) return null
    const video = this.feed.video
    if (!video || video.readyState < 2 || video.videoWidth < 2) return null
    return video
  }

  frameStamp(): number | null {
    return this.feed.stamp
  }

  /** Copy the clip the current photo would use. False when the camera cannot be posed. */
  copyClip(out: Matrix4): boolean {
    const clip = this.currentClip()
    if (!clip) return false
    out.copy(clip.clip)
    return true
  }

  /** Paint the stand-in room into `target` from the view camera, and write that clip. */
  paintStandIn(target: WebGLRenderTarget, outClip: Matrix4): boolean {
    const { camera } = this.ctx
    if (!(camera.aspect > 0.05)) return false
    camera.updateMatrixWorld()
    this.paintRoom(target)
    outClip.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse)
    return true
  }

  dispose(): void {
    this.stop()
    this.webcamStream?.getTracks().forEach((track) => track.stop())
    this.target?.dispose()
    this.feed.dispose()
  }

  private get useWebcam(): boolean {
    return WEBCAM_REQUESTED && this.feed.width > 2 && !!this.webcam
  }

  private attach(devices: CameraDeviceInfo[]): boolean {
    if (this.cameraEntity) return true
    const backs = devices.filter((d) => d.facing === CameraFacing.Back)
    const labels = backs.map((d) => d.label)
    const back = backs.find((d) => cameraMount(d.label, 'back', labels) === 'left') ?? backs[0] ?? null
    const chosen = back ?? devices[0]
    if (!chosen) {
      console.warn('[frame] camera: no video inputs')
      this.problem = cameraProblem(new DOMException('no video inputs', 'NotFoundError'))
      return false
    }
    this.problem = null
    this.lens.mount = cameraMount(chosen.label, back ? 'back' : 'unknown', labels)
    if (this.lens.mount === 'view') this.lens.mount = 'left'
    console.info(`[frame] camera pick "${chosen.label}" side=${this.lens.mount}`)
    const anchor = new Group()
    anchor.name = 'passthrough-camera'
    anchor.visible = false
    const entity = this.ctx.world.createTransformEntity(anchor)
    entity.addComponent(CameraSource)
    entity.setValue(CameraSource, 'deviceId', chosen.deviceId)
    entity.setValue(CameraSource, 'facing', back ? CameraFacing.Back : CameraFacing.Unknown)
    entity.setValue(CameraSource, 'width', 1280)
    entity.setValue(CameraSource, 'height', 1280)
    entity.setValue(CameraSource, 'frameRate', 30)
    this.cameraEntity = entity
    this.rearmTries = 0
    return true
  }

  private roomTargetSize(): { width: number; height: number } | null {
    const camera = this.ctx.camera
    const aspect = camera.aspect > 0.05 ? camera.aspect : 16 / 9
    let width = 1280
    let height = Math.max(2, Math.round(width / aspect))
    if (height > 1280) {
      height = 1280
      width = Math.max(2, Math.round(height * aspect))
    }
    return { width, height }
  }

  /** Photograph the stand-in room without anything the app drew on top of it. */
  private grabRoom(): Raster | null {
    const size = this.roomTargetSize()
    if (!size) return null
    const { width, height } = size
    if (!this.target || this.target.width !== width || this.target.height !== height) {
      this.target?.dispose()
      this.target = new WebGLRenderTarget(width, height, {
        format: RGBAFormat,
        type: UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false,
        colorSpace: SRGBColorSpace,
      })
      this.target.texture.colorSpace = SRGBColorSpace
      this.pixelBuf = new Uint8Array(width * height * 4)
    }
    this.paintRoom(this.target)
    this.ctx.renderer.readRenderTargetPixels(this.target, 0, 0, width, height, this.pixelBuf)
    return rasterFromPixels(this.pixelBuf, width, height)
  }

  /** Render the stand-in with the app's own meshes hidden, then restore the renderer. */
  private paintRoom(target: WebGLRenderTarget): void {
    const hidden = this.overlays()
    const shown: boolean[] = []
    for (let i = 0; i < hidden.length; i++) {
      shown.push(hidden[i].visible)
      hidden[i].visible = false
    }
    const { renderer, scene, camera } = this.ctx
    const prev = renderer.getRenderTarget()
    const prevXr = renderer.xr.enabled
    const prevAlpha = renderer.getClearAlpha()
    renderer.getClearColor(this.prevClear)
    renderer.xr.enabled = false
    try {
      renderer.setClearColor(this.deskColor, 1)
      renderer.setRenderTarget(target)
      renderer.clear()
      renderer.render(scene, camera)
    } finally {
      renderer.setRenderTarget(prev)
      renderer.setClearColor(this.prevClear, prevAlpha)
      renderer.xr.enabled = prevXr
      for (let i = 0; i < hidden.length; i++) hidden[i].visible = shown[i]
    }
  }
}
