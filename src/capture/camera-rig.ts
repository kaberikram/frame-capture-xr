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
import { HeadsetLens, cameraMount, projectPixel } from './lens.js'

export interface Clip {
  clip: Matrix4
  width: number
  height: number
}

/**
 * Where a photo comes from: the Quest visor camera in a session, a webcam on the
 * desk with `?cam=1`, or a render of the stand-in room otherwise. Also projects
 * frame corners into that image.
 */
export class CameraRig {
  readonly lens = new HeadsetLens()
  readonly feed = new CameraFeed()
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

  arm(): Promise<boolean> {
    this.cameraWanted = true
    if (this.cameraEntity) return Promise.resolve(true)
    if (this.arming) return this.arming
    this.arming = CameraUtils.getDevices()
      .then((devices) => {
        this.arming = null
        return this.attach(devices)
      })
      .catch((error: unknown) => {
        this.arming = null
        console.warn('[frame] camera arm failed', error)
        return false
      })
    return this.arming
  }

  /** Try again a few times, backing off, when the camera did not come up. */
  rearm(now: number): void {
    if (!this.cameraWanted || this.cameraEntity || this.arming || this.rearmTries >= 3 || now < this.rearmAt) return
    this.rearmTries += 1
    this.rearmAt = now + 2 ** (this.rearmTries - 1)
    void this.arm()
  }

  watchQuest(): void {
    const entity = this.cameraEntity
    if (!entity) return
    const state = String(entity.getValue(CameraSource, 'state'))
    if (state !== CameraState.Active) return
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

  grabRaster(): Raster | null {
    if (this.ctx.renderer.xr.isPresenting || this.useWebcam) return this.feed.grab()
    return this.grabRoom()
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
      return false
    }
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
    renderer.setClearColor(this.deskColor, 1)
    renderer.setRenderTarget(this.target)
    renderer.clear()
    renderer.render(scene, camera)
    renderer.readRenderTargetPixels(this.target, 0, 0, width, height, this.pixelBuf)
    renderer.setRenderTarget(prev)
    renderer.setClearColor(this.prevClear, prevAlpha)
    renderer.xr.enabled = prevXr
    for (let i = 0; i < hidden.length; i++) hidden[i].visible = shown[i]
    return rasterFromPixels(this.pixelBuf, width, height)
  }
}
