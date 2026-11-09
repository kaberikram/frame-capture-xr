import {
  Color,
  Group,
  LinearFilter,
  LinearSRGBColorSpace,
  SRGBColorSpace,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  Vector4,
  VideoTexture,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from '@iwsdk/core'
import { PALETTE } from '../look/palette.js'
import { rasterFromPixels } from './camera-feed.js'
import { cropSize, type Raster } from './crop.js'
import { TIME_CELL, TIME_COLS, TIME_SLOTS } from './time-mode.js'

const ATLAS = TIME_COLS * TIME_CELL

export interface TimeSource {
  /** Headset or webcam image, or null when the desk should paint the stand-in. */
  liveVideo(): HTMLVideoElement | null
  /** Page-clock seconds of the newest video frame, when the element reports one. */
  frameStamp(): number | null
  /** Copy the current camera's world-to-clip matrix. False when it cannot be posed. */
  copyClip(out: Matrix4): boolean
  /** Paint the stand-in room into `target` and write the view clip. */
  paintStandIn(target: WebGLRenderTarget, outClip: Matrix4): boolean
  readonly problem: string | null
}

/**
 * A ring of recent camera frames on the GPU, plus the clip matrix that posed
 * each one. The glass reprojects a world point through those matrices, so the
 * room stays put and only what moved is late. One 1280² atlas, no CPU reads
 * except the single readback when a photo is taken.
 */
export class TimeHistory {
  readonly clips: Matrix4[] = Array.from({ length: TIME_SLOTS }, () => new Matrix4())
  readonly atlas: WebGLRenderTarget
  head = 0
  count = 0
  /** Seconds between the frames most recently stored. */
  gap = 1 / 30
  private lastTime = -1
  private readonly renderer: WebGLRenderer
  private readonly blitScene = new Scene()
  private readonly blitCam = new OrthographicCamera(-1, 1, 1, -1, 0.01, 4)
  private readonly blitMat: ShaderMaterial
  private readonly haze = new Color(PALETTE.haze[0], PALETTE.haze[1], PALETTE.haze[2])
  private readonly savedClear = new Color()
  private readonly savedView = new Vector4()
  private readonly savedScissor = new Vector4()
  private readonly roomClip = new Matrix4()
  private readonly look = new Vector3()
  private videoTex: VideoTexture | null = null
  private videoEl: HTMLVideoElement | null = null
  private room: WebGLRenderTarget | null = null
  private shotTarget: WebGLRenderTarget | null = null
  private shotPixels = new Uint8Array(0)
  private readonly shotScene = new Scene()
  private readonly shotRoot = new Group()
  private readonly shotCam = new OrthographicCamera(-0.2, 0.2, 0.2, -0.2, 0.02, 2)

  constructor(renderer: WebGLRenderer, glass: ShaderMaterial) {
    this.renderer = renderer
    this.atlas = new WebGLRenderTarget(ATLAS, ATLAS, {
      format: RGBAFormat,
      type: UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    })
    this.atlas.texture.colorSpace = LinearSRGBColorSpace
    this.atlas.texture.minFilter = LinearFilter
    this.atlas.texture.magFilter = LinearFilter
    this.atlas.texture.generateMipmaps = false
    this.blitMat = new ShaderMaterial({
      uniforms: { uImage: { value: null as Texture | null } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uImage;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(uImage, vUv);
        }`,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    const quad = new Mesh(new PlaneGeometry(2, 2), this.blitMat)
    quad.frustumCulled = false
    this.blitScene.add(quad)
    this.blitCam.position.z = 1
    // The root's matrix is the frame's world matrix. Auto-update would replace it.
    this.shotRoot.matrixAutoUpdate = false
    this.shotRoot.frustumCulled = false
    const shotMesh = new Mesh(new PlaneGeometry(1, 1), glass)
    shotMesh.frustumCulled = false
    this.shotRoot.add(shotMesh)
    this.shotScene.add(this.shotRoot)
  }

  /** Copy one video frame into the next cell. `clip` is posed at that exposure. */
  pushVideo(video: HTMLVideoElement, clip: Matrix4, now: number): void {
    this.pushImage(this.videoTexture(video), clip, now)
  }

  /** Paint the stand-in and store that view. False when the camera has no aspect yet. */
  pushRoom(source: TimeSource, aspect: number, now: number): boolean {
    const size = fitSize(aspect, 480)
    if (!size) return false
    if (!this.room || this.room.width !== size.width || this.room.height !== size.height) {
      this.room?.dispose()
      this.room = new WebGLRenderTarget(size.width, size.height, {
        format: RGBAFormat,
        type: UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false,
      })
      this.room.texture.colorSpace = LinearSRGBColorSpace
      this.room.texture.minFilter = LinearFilter
      this.room.texture.magFilter = LinearFilter
      this.room.texture.generateMipmaps = false
    }
    // Encode the lit room to sRGB, then sample those bytes raw so the glass
    // writes them unchanged, the same path the headset camera uses.
    this.room.texture.colorSpace = SRGBColorSpace
    if (!source.paintStandIn(this.room, this.roomClip)) return false
    this.room.texture.colorSpace = LinearSRGBColorSpace
    this.pushImage(this.room.texture, this.roomClip, now)
    return true
  }

  /**
   * The glass as a still, the size of a photo. One GPU readback. Null when the
   * ring is empty. The caller falls back to the live camera.
   */
  snapshot(world: Matrix4, width: number, height: number): Raster | null {
    if (this.count < 1 || width < 0.04 || height < 0.04) return null
    const size = cropSize(width / height, 640)
    if (!this.shotTarget || this.shotTarget.width !== size.width || this.shotTarget.height !== size.height) {
      this.shotTarget?.dispose()
      this.shotTarget = new WebGLRenderTarget(size.width, size.height, {
        format: RGBAFormat,
        type: UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
      })
      this.shotTarget.texture.colorSpace = LinearSRGBColorSpace
      this.shotPixels = new Uint8Array(size.width * size.height * 4)
    }
    const target = this.shotTarget
    this.poseShot(world, width, height)
    this.withTarget(target, () => {
      this.renderer.setClearColor(this.haze, 1)
      this.renderer.clear()
      this.renderer.render(this.shotScene, this.shotCam)
    })
    this.renderer.readRenderTargetPixels(target, 0, 0, size.width, size.height, this.shotPixels)
    return rasterFromPixels(this.shotPixels, size.width, size.height)
  }

  dispose(): void {
    this.atlas.dispose()
    this.room?.dispose()
    this.shotTarget?.dispose()
    this.videoTex?.dispose()
    this.blitMat.dispose()
    const quad = this.blitScene.children[0] as Mesh | undefined
    quad?.geometry.dispose()
    const shot = this.shotRoot.children[0] as Mesh | undefined
    shot?.geometry.dispose()
  }

  private pushImage(texture: Texture, clip: Matrix4, now: number): void {
    const slot = this.count === 0 ? 0 : (this.head + 1) % TIME_SLOTS
    this.blit(texture, slot)
    this.clips[slot].copy(clip)
    if (this.lastTime > 0) {
      const d = now - this.lastTime
      if (d > 0.008 && d < 0.5) this.gap = this.gap * 0.75 + d * 0.25
    }
    this.lastTime = now
    this.head = slot
    if (this.count < TIME_SLOTS) this.count += 1
  }

  private videoTexture(video: HTMLVideoElement): Texture {
    if (this.videoEl !== video || !this.videoTex) {
      this.videoTex?.dispose()
      const tex = new VideoTexture(video)
      tex.colorSpace = LinearSRGBColorSpace
      tex.minFilter = LinearFilter
      tex.magFilter = LinearFilter
      tex.generateMipmaps = false
      tex.flipY = true
      this.videoTex = tex
      this.videoEl = video
    }
    this.videoTex.needsUpdate = true
    return this.videoTex
  }

  private blit(texture: Texture, slot: number): void {
    this.blitMat.uniforms.uImage.value = texture
    const x = (slot % TIME_COLS) * TIME_CELL
    const y = Math.floor(slot / TIME_COLS) * TIME_CELL
    this.withTarget(this.atlas, () => {
      const renderer = this.renderer
      renderer.setScissorTest(true)
      renderer.setViewport(x, y, TIME_CELL, TIME_CELL)
      renderer.setScissor(x, y, TIME_CELL, TIME_CELL)
      renderer.setClearColor(this.haze, 1)
      renderer.render(this.blitScene, this.blitCam)
    })
  }

  /** Run `draw` against `target`, then put the renderer back. Scissor included. */
  private withTarget(target: WebGLRenderTarget, draw: () => void): void {
    const renderer = this.renderer
    const prev = renderer.getRenderTarget()
    const xr = renderer.xr.enabled
    const alpha = renderer.getClearAlpha()
    renderer.getClearColor(this.savedClear)
    renderer.getViewport(this.savedView)
    renderer.getScissor(this.savedScissor)
    const test = renderer.getScissorTest()
    renderer.xr.enabled = false
    renderer.setRenderTarget(target)
    try {
      draw()
    } finally {
      renderer.setRenderTarget(prev)
      renderer.setViewport(this.savedView)
      renderer.setScissor(this.savedScissor)
      renderer.setScissorTest(test)
      renderer.setClearColor(this.savedClear, alpha)
      renderer.xr.enabled = xr
    }
  }

  private poseShot(world: Matrix4, width: number, height: number): void {
    const root = this.shotRoot
    root.matrix.copy(world)
    root.matrixWorldNeedsUpdate = true
    const mesh = root.children[0] as Mesh
    mesh.scale.set(width, height, 1)
    const e = world.elements
    this.shotCam.position.set(e[12] + e[8] * 0.45, e[13] + e[9] * 0.45, e[14] + e[10] * 0.45)
    this.shotCam.up.set(e[4], e[5], e[6])
    this.look.set(e[12], e[13], e[14])
    this.shotCam.lookAt(this.look)
    this.shotCam.left = -width * 0.5
    this.shotCam.right = width * 0.5
    this.shotCam.top = height * 0.5
    this.shotCam.bottom = -height * 0.5
    this.shotCam.near = 0.02
    this.shotCam.far = 2
    this.shotCam.updateProjectionMatrix()
  }
}

function fitSize(aspect: number, longSide: number): { width: number; height: number } | null {
  if (!(aspect > 0.05)) return null
  let width = longSide
  let height = Math.max(2, Math.round(width / aspect))
  if (height > longSide) {
    height = longSide
    width = Math.max(2, Math.round(height * aspect))
  }
  return { width, height }
}
