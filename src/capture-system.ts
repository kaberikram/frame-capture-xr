import {
  CameraFacing,
  CameraSource,
  CameraState,
  CameraUtils,
  CanvasTexture,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  RGBAFormat,
  SRGBColorSpace,
  ShaderMaterial,
  UnsignedByteType,
  type Texture,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  createSystem,
  type CameraDeviceInfo,
  type Entity,
} from '@iwsdk/core'
import { brightnessDepth, detrendDepth, settleDepth } from './brightness-depth.js'
import { CameraFeed, rasterFromPixels } from './camera-feed.js'
import { CaptureLook } from './capture-look.js'
import { cropQuad, cropSize, type Quad, type Raster } from './crop.js'
import { estimateDepth, prepareDepthModel } from './depth-model.js'
import { PREVIEW_FORCED, WEBCAM_REQUESTED, launchSession, queryFlag } from './experience.js'
import { makeBorder, writeBorder } from './frame-border.js'
import { RectGesture } from './gesture.js'
import { classifyHit, hitPlane, makeHandle, placeHandle, type FrameHit } from './handle.js'
import { bindPeel, layoutPeel, makePeel, spreadFromPull, springStep, type PeelRig } from './peel.js'
import { axisExtent, curlFromPull, foldForPeel, nearestCorner } from './peel-math.js'
import { HeadsetLens, cameraMount, projectPixel } from './lens.js'
import { applyCurl, applyDepth, applyLook, applyPhoto, bindMesh, reliefGeometry, reliefMaterial, setRelief } from './relief.js'
import { buildStandIn } from './stand-in.js'

type Side = 'left' | 'right'
type Hold = 'off' | 'play' | 'draw' | 'photo' | 'side' | 'rest' | 'peel' | 'open' | 'curl' | 'detached'
type Phase = 'ready' | 'drawing' | 'photo' | 'relief' | 'side' | 'rest' | 'peel' | 'open' | 'curl' | 'detached'
type Touch = 'none' | 'peel' | 'grab' | 'curl' | 'sticker'
type StickerMode = 'idle' | 'curl' | 'sheets' | 'free'
type DepthKind = 'wait' | 'brightness' | 'model'

interface Look {
  relief: number
  pop: number
  edge: number
  band: number
  feather: number
  minSpan: number
  strip: number
  segments: number
  layers: number
  spread: number
  curl: number
  detach: number
  spring: number
}

interface Held {
  group: Group
  photo: Mesh
  mat: ShaderMaterial
  raster: Raster | null
  pop: number
  popping: boolean
  flat: boolean
  age: number
  depth: DepthKind
  token: number
  width: number
  height: number
  peel: PeelRig
  handle: Mesh
  /** 0 closed, 1 pulled out to the max sheet spread. */
  spread: number
  spreadV: number
  /** idle on the frame, curling, fanned into sheets, or a free sticker. */
  mode: StickerMode
  /** 0 stuck, 1 peeled to the far edge. */
  curl: number
  curlV: number
  axisX: number
  axisY: number
  cornerX: number
  cornerY: number
  /** The pinch or the desk demo is driving the gesture, so the spring waits. */
  holding: boolean
}

const SIDES: readonly Side[] = ['left', 'right']
const MAX_CAPTURES = 16
const CROP_LONG = 640
const DRAW_DISTANCE = 0.95
const DEPTH_WAIT = 1.4
const PINCH_ON = 0.02
const PINCH_OFF = 0.032
const WORLD_UP = new Vector3(0, 1, 0)

const REDUCE_MOTION = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

interface CaptureApi {
  phase: Phase
  count: number
  depth: string
  relief: number
  peel: number
}

/**
 * Draw a rectangle in the air, anchor it, photograph what it frames, and ease
 * that photo out into a depth relief. Release takes the photo: a second pinch
 * would be another frame.
 */
export class CaptureSystem extends createSystem({
  settings: { required: [CaptureLook] },
}) {
  private readonly lens = new HeadsetLens()
  private readonly feed = new CameraFeed()
  private readonly gesture = new RectGesture()
  private readonly captures: Held[] = []
  private readonly look: Look = {
    relief: 0.42, pop: 0.85, edge: 0.18, band: 0.1, feather: 0.018, minSpan: 0.12, strip: 0.008, segments: 72,
    layers: 24, spread: 0.2, curl: 0.075, detach: 0.7, spring: 36,
  }

  private root!: Group
  private standIn!: Group
  private dragGroup!: Group
  private dragPositions!: ReturnType<typeof makeBorder>['positions']
  private hud!: Mesh
  private hudCtx!: CanvasRenderingContext2D
  private readonly hudCanvas = document.createElement('canvas')
  private hudText = ''

  private cameraEntity: Entity | null = null
  private session: XRSession | null = null
  private webcam: HTMLVideoElement | null = null
  private webcamStream: MediaStream | null = null
  private arming: Promise<boolean> | null = null
  private cameraWanted = false
  private rearmTries = 0
  private rearmAt = 0

  private readonly selectHeld = { left: false, right: false }
  private readonly pinchWas = { left: false, right: false }
  private primary: Side | null = null
  private dual = false
  private waitClear = false
  private pointerDrawing = false
  private readonly pointer = new Vector2()
  private touch: Touch = 'none'
  private touchHeld: Held | null = null
  private pointerY = 0
  private readonly inward = new Vector3()
  private readonly parentQ = new Quaternion()
  private readonly worldMat = new Matrix4()
  private readonly localMat = new Matrix4()
  private readonly grabQuat = new Quaternion()
  private readonly grabPos = new Vector3()
  private readonly grabPinch = new Vector3()
  private readonly grabRight = new Vector3()
  private readonly grabUp = new Vector3()
  private readonly qYaw = new Quaternion()
  private readonly qPitch = new Quaternion()
  private readonly axisX = new Vector3(1, 0, 0)
  private readonly axisY = new Vector3(0, 1, 0)

  private readonly headPos = new Vector3()
  private readonly handA = new Vector3()
  private readonly handB = new Vector3()
  private readonly raycaster = new Raycaster()
  private readonly viewClip = new Matrix4()
  private readonly basis = new Matrix4()
  private readonly corner = [new Vector3(), new Vector3(), new Vector3(), new Vector3()]
  private readonly pinchDist = { left: 0, right: 0 }
  private readonly prevClear = new Color()
  private readonly px = { x: 0, y: 0 }
  private readonly deskColor = new Color('#141820')
  private readonly focus = new Vector3(0, 1.4, -0.7)
  private readonly home = new Vector3()
  private radius = 1
  private baseYaw = 0
  private basePitch = 0
  private yaw = 0
  private pitch = 0
  private orbitReady = false
  private orbiting = false
  private orbitLastX = 0
  private orbitLastY = 0

  private target: WebGLRenderTarget | null = null
  private pixelBuf = new Uint8Array(0)
  private token = 0
  private phase: Phase = 'ready'
  private status = ''
  private readonly hold = readHold()
  private shotU = 0
  private shotStarted = false
  private shotPeel = 0
  private shotHold = 0
  private shotLetGo = false
  private readonly shotStart = new Vector3()
  private readonly shotEnd = new Vector3()
  private readonly shotPoint = new Vector3()
  private readonly shotCenter = new Vector3()
  private readonly forward = new Vector3()
  private readonly pickAt = new Vector3()
  private readonly planeHit = new Vector3()
  private readonly local = new Vector3()
  private readonly aimDir = new Vector3()

  private readonly onSelectStart = (event: Event): void => {
    const side = (event as XRInputSourceEvent).inputSource?.handedness
    if (side === 'left' || side === 'right') this.selectHeld[side] = true
  }

  private readonly onSelectEnd = (event: Event): void => {
    const side = (event as XRInputSourceEvent).inputSource?.handedness
    if (side === 'left' || side === 'right') this.selectHeld[side] = false
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.renderer.xr.isPresenting) return
    if (event.button === 2 || event.altKey) {
      this.orbiting = true
      this.orbitLastX = event.clientX
      this.orbitLastY = event.clientY
      return
    }
    if (event.button !== 0 || this.shotBlocksDraw) return
    const el = event.currentTarget
    if (!(el instanceof HTMLElement)) return
    el.setPointerCapture(event.pointerId)
    this.aimPointer(event)
    const hit = this.aimAtFrames(this.raycaster.ray.origin, this.raycaster.ray.direction)
    if (hit?.kind === 'sticker') {
      this.beginSticker(hit.held, this.pickAt)
      return
    }
    if (hit?.kind === 'handle') {
      this.beginGrab(hit.held, this.pickAt)
      return
    }
    if ((hit?.kind === 'corner' || hit?.kind === 'photo') && event.shiftKey) {
      this.beginSheets(hit.held, this.pickAt)
      this.pointerY = event.clientY
      return
    }
    if (hit?.kind === 'corner') {
      this.beginCurl(hit.held, this.pickAt)
      return
    }
    if (hit?.kind === 'photo') return
    this.pointerDrawing = true
    this.placePointer(event, true)
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.orbiting) {
      this.yaw -= (event.clientX - this.orbitLastX) * 0.005
      this.pitch -= (event.clientY - this.orbitLastY) * 0.004
      this.pitch = clamp(this.pitch, -0.7, 0.55)
      this.orbitLastX = event.clientX
      this.orbitLastY = event.clientY
      return
    }
    if (this.touch === 'grab' && this.touchHeld) {
      this.aimPointer(event)
      if (this.dragOnView(this.pickAt)) this.moveGrab(this.pickAt)
      return
    }
    if (this.touch === 'sticker' && this.touchHeld) {
      this.aimPointer(event)
      if (this.dragOnView(this.pickAt)) this.moveSticker(this.pickAt)
      return
    }
    if (this.touch === 'curl' && this.touchHeld) {
      this.aimPointer(event)
      this.trackCurl(this.touchHeld, this.raycaster.ray.origin, this.raycaster.ray.direction)
      return
    }
    if (this.touch === 'peel' && this.touchHeld) {
      const pull = (event.clientY - this.pointerY) * (0.16 / 120)
      this.touchHeld.spread = spreadFromPull(pull)
      this.touchHeld.spreadV = 0
      return
    }
    if (!this.pointerDrawing) return
    this.placePointer(event, false)
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.orbiting && (event.button === 2 || event.altKey || event.button === 0)) {
      this.orbiting = false
      return
    }
    if (this.touch !== 'none' && event.button === 0) {
      this.endTouch()
      return
    }
    if (!this.pointerDrawing || event.button !== 0) return
    this.pointerDrawing = false
    this.finishGesture()
  }

  init(): void {
    this.root = new Group()
    this.root.name = 'frame-capture'
    this.world.createTransformEntity(this.root)
    this.standIn = buildStandIn()
    this.root.add(this.standIn)

    const border = makeBorder(this.look.strip)
    this.dragPositions = border.positions
    this.dragGroup = new Group()
    this.dragGroup.name = 'draw-frame'
    this.dragGroup.add(border.mesh)
    this.dragGroup.visible = false
    this.root.add(this.dragGroup)

    this.hudCanvas.width = 512
    this.hudCanvas.height = 128
    const ctx = this.hudCanvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas is unavailable')
    this.hudCtx = ctx
    this.hud = hudMesh(this.hudCanvas)
    this.hud.visible = false
    this.player.head.add(this.hud)

    const view = document.getElementById('scene-container')
    view?.addEventListener('pointerdown', this.onPointerDown)
    view?.addEventListener('pointermove', this.onPointerMove)
    view?.addEventListener('pointerup', this.onPointerUp)
    view?.addEventListener('pointercancel', this.onPointerUp)
    view?.addEventListener('contextmenu', (event) => event.preventDefault())

    this.wireLaunch()
    this.publishApi()
    if (WEBCAM_REQUESTED) this.openWebcam()
    void prepareDepthModel().catch((error: unknown) => {
      console.warn('[frame] depth model', error)
    })

    this.cleanupFuncs.push(() => this.dispose())
  }

  update(delta: number): void {
    const dt = Math.min(0.1, delta)
    const now = performance.now() / 1000
    this.readLook()
    this.syncSession()
    const presenting = this.renderer.xr.isPresenting
    if (presenting) {
      this.scene.background = null
      this.standIn.visible = false
      this.player.head.updateWorldMatrix(true, false)
      this.player.updateWorldMatrix(true, false)
      this.lens.recordHead(this.player.head, this.world.xrFrame?.predictedDisplayTime, now)
      this.watchQuestCamera()
      this.updateHands()
      this.rearmCamera(now)
    } else {
      this.scene.background = this.deskColor
      this.standIn.visible = true
      if (this.webcam) this.feed.watch(this.webcam, this.webcamStream?.getVideoTracks()[0] ?? null)
      this.applyDeskCamera()
      this.updateShot(dt)
    }
    this.syncDrag()
    this.animate(dt)
    this.hud.visible = presenting
    if (presenting) this.paintHud()
    this.publishPhase()
    this.note(this.statusLine())
  }

  private get shotBlocksDraw(): boolean {
    return this.hold !== 'off'
  }

  private readLook(): void {
    const entity = firstEntity(this.queries.settings.entities)
    if (!entity) return
    const n = (field: keyof Look) => entity.getValue(CaptureLook, field) as number
    this.look.relief = n('relief')
    this.look.pop = n('pop')
    this.look.edge = n('edge')
    this.look.band = n('band')
    this.look.feather = n('feather')
    this.look.minSpan = n('minSpan')
    this.look.strip = n('strip')
    this.look.segments = n('segments')
    const layers = n('layers')
    const spread = n('spread')
    const curl = n('curl')
    const detach = n('detach')
    const spring = n('spring')
    if (Number.isFinite(layers)) this.look.layers = layers
    if (Number.isFinite(spread)) this.look.spread = spread
    if (Number.isFinite(curl)) this.look.curl = curl
    if (Number.isFinite(detach)) this.look.detach = detach
    if (Number.isFinite(spring)) this.look.spring = spring
    for (let i = 0; i < this.captures.length; i++) {
      const held = this.captures[i]
      applyLook(held.mat, {
        depthAmt: Math.max(held.width, held.height) * this.look.relief,
        edge: this.look.edge,
        band: this.look.band,
        feather: this.look.feather,
        width: held.width,
        height: held.height,
      })
    }
  }

  private syncSession(): void {
    const session = this.renderer.xr.getSession() ?? null
    if (session === this.session) return
    this.session?.removeEventListener('selectstart', this.onSelectStart)
    this.session?.removeEventListener('selectend', this.onSelectEnd)
    session?.addEventListener('selectstart', this.onSelectStart)
    session?.addEventListener('selectend', this.onSelectEnd)
    this.session = session
    this.selectHeld.left = false
    this.selectHeld.right = false
    this.pinchWas.left = false
    this.pinchWas.right = false
    this.primary = null
    this.dual = false
    this.waitClear = false
    this.gesture.cancel()
    this.lens.clear()
    if (!session) this.stopCamera()
    else {
      const features = (session as XRSession & { enabledFeatures?: readonly string[] }).enabledFeatures
      console.info(`[frame] session ${features ? features.join(' ') : 'features unlisted'}`)
    }
  }

  private updateHands(): void {
    this.player.head.getWorldPosition(this.headPos)
    const tracked = { left: this.fillPinch('left'), right: this.fillPinch('right') }
    if (this.waitClear) {
      const still = SIDES.some((side) => this.isPinching(side, tracked[side]))
      if (!still) this.waitClear = false
      for (let i = 0; i < SIDES.length; i++) this.pinchWas[SIDES[i]] = this.isPinching(SIDES[i], tracked[SIDES[i]])
      return
    }
    for (let i = 0; i < SIDES.length; i++) {
      const side = SIDES[i]
      const down = this.isPinching(side, tracked[side])
      const was = this.pinchWas[side]
      if (down && !was) this.pinchBegan(side)
      else if (down && was) this.pinchMoved(side)
      else if (!down && was) this.pinchEnded(side)
      this.pinchWas[side] = down
    }
  }

  private fillPinch(side: Side): boolean {
    const frame = this.world.xrFrame
    const space = this.world.xrReferenceSpace
    if (!frame || !space || !this.input.xr.isPrimary('hand', side)) return false
    const hand = this.input.xr.getPrimaryInputSource(side)?.hand
    if (!hand) return false
    const thumb = hand.get('thumb-tip')
    const index = hand.get('index-finger-tip')
    if (!thumb || !index) return false
    const thumbPose = frame.getJointPose?.(thumb, space)
    const indexPose = frame.getJointPose?.(index, space)
    if (!thumbPose || !indexPose) return false
    const tp = thumbPose.transform.position
    const ip = indexPose.transform.position
    const store = side === 'left' ? this.handA : this.handB
    store.set((tp.x + ip.x) * 0.5, (tp.y + ip.y) * 0.5, (tp.z + ip.z) * 0.5)
    store.applyMatrix4(this.player.matrixWorld)
    this.pinchDist[side] = Math.hypot(tp.x - ip.x, tp.y - ip.y, tp.z - ip.z)
    return true
  }

  private isPinching(side: Side, tracked: boolean): boolean {
    if (!tracked) return this.selectHeld[side] && this.pinchWas[side]
    if (this.selectHeld[side]) return true
    return this.pinchDist[side] < (this.pinchWas[side] ? PINCH_OFF : PINCH_ON)
  }

  private pinchBegan(side: Side): void {
    const at = side === 'left' ? this.handA : this.handB
    if (this.touch === 'curl' && this.touchHeld && side !== this.primary && this.touchHeld.curl < 0.18) {
      this.beginSheets(this.touchHeld, at)
      return
    }
    if (this.touch !== 'none') return
    if (!this.gesture.drawing) {
      this.player.head.getWorldPosition(this.headPos)
      this.aimDir.copy(at).sub(this.headPos)
      const hit = this.aimAtFrames(this.headPos, this.aimDir)
      if (hit?.kind === 'sticker') {
        this.primary = side
        this.beginSticker(hit.held, this.pickAt)
        return
      }
      if (hit?.kind === 'handle') {
        this.primary = side
        this.beginGrab(hit.held, this.pickAt)
        return
      }
      const other = this.otherPinching(side)
      if (hit && (hit.kind === 'photo' || hit.kind === 'corner') && other) {
        this.primary = side
        this.beginSheets(hit.held, this.pickAt)
        return
      }
      if (hit?.kind === 'corner') {
        this.primary = side
        this.beginCurl(hit.held, this.pickAt)
        return
      }
      if (hit?.kind === 'photo') return
      this.primary = side
      this.dual = false
      this.gesture.begin(at, this.headPos, WORLD_UP)
      return
    }
    if (side !== this.primary && this.primary && !this.dual) {
      const first = this.primary === 'left' ? this.handA : this.handB
      this.dual = true
      this.gesture.adopt(first, at, this.headPos)
    }
  }

  private pinchMoved(side: Side): void {
    const at = side === 'left' ? this.handA : this.handB
    if (this.touch !== 'none') {
      if (side !== this.primary) return
      if (this.touch === 'grab') this.moveGrab(at)
      else if (this.touch === 'sticker') this.moveSticker(at)
      else if (this.touch === 'curl') this.moveCurl(at)
      else this.movePeel(at)
      return
    }
    if (!this.gesture.drawing || !this.primary) return
    if (!this.dual) {
      if (side === this.primary) this.gesture.move('a', at, this.headPos)
      return
    }
    this.gesture.move(side === this.primary ? 'a' : 'b', at, this.headPos)
  }

  private pinchEnded(side: Side): void {
    if (this.touch !== 'none') {
      if (side !== this.primary) return
      this.endTouch()
      return
    }
    if (!this.gesture.drawing) return
    if (side !== this.primary && !this.dual) return
    this.primary = null
    this.dual = false
    this.waitClear = true
    this.finishGesture()
  }

  private placePointer(event: PointerEvent, start: boolean): void {
    const el = document.getElementById('scene-container')
    if (!el) return
    const rect = el.getBoundingClientRect()
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    this.camera.getWorldPosition(this.headPos)
    const ray = this.raycaster.ray
    if (start || !this.gesture.drawing) {
      this.handA.copy(ray.origin).addScaledVector(ray.direction, DRAW_DISTANCE)
      this.gesture.begin(this.handA, this.headPos, WORLD_UP)
      return
    }
    if (!this.gesture.hitRay(ray.origin, ray.direction, this.handA)) return
    this.gesture.move('a', this.handA, this.headPos)
  }

  /** Releasing the pinch (or the mouse) anchors the frame and takes the photo. */
  private finishGesture(): void {
    const rect = this.gesture.rect
    const wide = rect.halfW * 2 >= this.look.minSpan && rect.halfH * 2 >= this.look.minSpan
    const result = this.gesture.drawing ? this.gesture.end() : 'cancel'
    if (result === 'commit' && wide) this.commit(false)
    else if (result === 'commit') this.note('Draw a larger frame')
  }

  private commit(holdFlat: boolean): void {
    if (this.captures.length >= MAX_CAPTURES) {
      this.note('Sixteen frames is the limit for this session')
      return
    }
    const rect = this.gesture.rect
    const hw = rect.halfW
    const hh = rect.halfH
    const group = new Group()
    group.name = 'capture'
    this.gesture.pose(group.position, group.quaternion, this.basis)
    const border = makeBorder(this.look.strip)
    writeBorder(border.positions, hw, hh, this.look.strip)
    group.add(border.mesh)
    const width = hw * 2
    const height = hh * 2
    const mat = reliefMaterial()
    applyLook(mat, {
      depthAmt: Math.max(width, height) * this.look.relief,
      edge: this.look.edge,
      band: this.look.band,
      feather: this.look.feather,
      width,
      height,
    })
    const photo = new Mesh(reliefGeometry(width, height, this.look.segments), mat)
    bindMesh(photo)
    photo.visible = false
    group.add(photo)
    const peel = makePeel(width, height)
    group.add(peel.root)
    const handle = makeHandle()
    placeHandle(handle, hh, this.look.strip)
    group.add(handle)
    this.root.add(group)
    const held: Held = {
      group, photo, mat, raster: null, pop: 0, popping: false, flat: holdFlat, age: 0, depth: 'wait', token: ++this.token,
      width, height, peel, handle, spread: 0, spreadV: 0, holding: false,
      mode: 'idle', curl: 0, curlV: 0, axisX: 1, axisY: 0, cornerX: width * 0.5, cornerY: height * 0.5,
    }
    this.captures.push(held)
    group.updateWorldMatrix(true, false)
    if (this.renderer.xr.isPresenting && this.feed.width < 2) {
      this.note('Waiting for the camera')
      console.info('[frame] capture waiting for the camera')
      return
    }
    const quad = this.projectGroup(group, hw, hh)
    const raster = this.grabRaster()
    if (!quad || !raster) {
      this.note('The frame is outside the camera')
      console.info('[frame] capture missed the camera')
      return
    }
    const size = cropSize(width / height, CROP_LONG)
    const cropped = cropQuad(raster, quad, size.width, size.height)
    if (!cropped) {
      this.note('The frame is outside the camera')
      return
    }
    held.raster = cropped
    applyPhoto(mat, cropped)
    photo.visible = true
    this.renderer.initTexture(mat.uniforms.uPhoto.value)
    console.info(`[frame] capture ${width.toFixed(2)}x${height.toFixed(2)}m`)
    if (holdFlat) return
    const token = held.token
    void estimateDepth(cropped)
      .then((field) => {
        if (held.token !== token || held.flat) return
        detrendDepth(field)
        settleDepth(field)
        applyDepth(held.mat, field)
        held.depth = 'model'
        if (held.popping && !REDUCE_MOTION) held.pop = Math.min(held.pop, 0.4)
        held.popping = true
        console.info('[frame] depth model')
      })
      .catch((error: unknown) => {
        console.warn('[frame] depth', error)
      })
  }

  private projectGroup(group: Group, hw: number, hh: number): Quad | null {
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

  private currentClip(): { clip: Matrix4; width: number; height: number } | null {
    if (this.renderer.xr.isPresenting) {
      const w = this.feed.width
      const h = this.feed.height
      if (w < 2 || h < 2) return null
      const stamp = this.feed.stamp
      const posed = stamp !== null && this.lens.projectExposed(stamp, w, h)
      if (!posed && !this.lens.projectLatest(w, h)) return null
      return { clip: this.lens.worldToClip, width: w, height: h }
    }
    if (this.useWebcam) {
      this.camera.updateMatrixWorld()
      this.viewClip.copy(this.camera.projectionMatrix).multiply(this.camera.matrixWorldInverse)
      return { clip: this.viewClip, width: this.feed.width, height: this.feed.height }
    }
    const size = this.roomTargetSize()
    if (!size) return null
    this.camera.updateMatrixWorld()
    this.viewClip.copy(this.camera.projectionMatrix).multiply(this.camera.matrixWorldInverse)
    return { clip: this.viewClip, width: size.width, height: size.height }
  }

  private get useWebcam(): boolean {
    return WEBCAM_REQUESTED && this.feed.width > 2 && !!this.webcam
  }

  private grabRaster(): Raster | null {
    if (this.renderer.xr.isPresenting || this.useWebcam) return this.feed.grab()
    return this.grabRoom()
  }

  private roomTargetSize(): { width: number; height: number } | null {
    const aspect = this.camera.aspect > 0.05 ? this.camera.aspect : 16 / 9
    let width = 1280
    let height = Math.max(2, Math.round(width / aspect))
    if (height > 1280) {
      height = 1280
      width = Math.max(2, Math.round(height * aspect))
    }
    return { width, height }
  }

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
    const shown: boolean[] = []
    for (let i = 0; i < this.captures.length; i++) {
      shown.push(this.captures[i].group.visible)
      this.captures[i].group.visible = false
    }
    const dragWas = this.dragGroup.visible
    this.dragGroup.visible = false
    const renderer = this.renderer
    const prev = renderer.getRenderTarget()
    const prevXr = renderer.xr.enabled
    const prevAlpha = renderer.getClearAlpha()
    renderer.getClearColor(this.prevClear)
    renderer.xr.enabled = false
    renderer.setClearColor(this.deskColor, 1)
    renderer.setRenderTarget(this.target)
    renderer.clear()
    renderer.render(this.scene, this.camera)
    renderer.readRenderTargetPixels(this.target, 0, 0, width, height, this.pixelBuf)
    renderer.setRenderTarget(prev)
    renderer.setClearColor(this.prevClear, prevAlpha)
    renderer.xr.enabled = prevXr
    this.dragGroup.visible = dragWas
    for (let i = 0; i < this.captures.length; i++) this.captures[i].group.visible = shown[i]
    return rasterFromPixels(this.pixelBuf, width, height)
  }

  private syncDrag(): void {
    const live = this.gesture.rect
    if (!this.gesture.drawing || !live.active) {
      this.dragGroup.visible = false
      return
    }
    this.dragGroup.visible = true
    this.gesture.pose(this.dragGroup.position, this.dragGroup.quaternion, this.basis)
    writeBorder(this.dragPositions, live.halfW, live.halfH, this.look.strip)
  }

  private animate(dt: number): void {
    for (let i = 0; i < this.captures.length; i++) {
      const held = this.captures[i]
      if (held.flat) continue
      held.age += dt
      if (!held.popping && held.depth === 'wait' && held.age >= DEPTH_WAIT && held.raster) {
        applyDepth(held.mat, brightnessDepth(held.raster))
        held.depth = 'brightness'
        held.popping = true
        console.info('[frame] depth brightness')
      }
      if (held.popping) {
        const dur = Math.max(0.05, this.look.pop)
        held.pop = REDUCE_MOTION ? 1 : Math.min(1, held.pop + dt / dur)
        setRelief(held.mat, easeOut(held.pop))
      }
      if (held.mode === 'curl' && !held.holding && (held.curl > 0 || Math.abs(held.curlV) > 0.0001)) {
        const next = REDUCE_MOTION
          ? { spread: 0, velocity: 0 }
          : springStep(held.curl, held.curlV, this.look.spring, dt)
        held.curl = next.spread
        held.curlV = next.velocity
        if (held.curl === 0) held.mode = 'idle'
      }
      if (held.mode === 'sheets' && !held.holding && (held.spread > 0 || Math.abs(held.spreadV) > 0.0001)) {
        const next = REDUCE_MOTION
          ? { spread: 0, velocity: 0 }
          : springStep(held.spread, held.spreadV, this.look.spring, dt)
        held.spread = next.spread
        held.spreadV = next.velocity
        if (held.spread === 0) held.mode = 'idle'
      }
      this.layoutHeld(held)
    }
  }

  private updateShot(dt: number): void {
    if (this.hold === 'off' || this.renderer.xr.isPresenting) return
    this.camera.getWorldPosition(this.headPos)
    if (!this.shotStarted) {
      this.shotStarted = true
      this.forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion)
      this.shotCenter.copy(this.headPos).addScaledVector(this.forward, DRAW_DISTANCE)
      this.gesture.begin(this.shotCenter, this.headPos, WORLD_UP)
      this.shotStart.copy(this.shotCenter)
      this.shotStart.addScaledVector(this.gesture.rect.right, -0.16)
      this.shotStart.addScaledVector(this.gesture.rect.up, -0.11)
      this.shotEnd.copy(this.shotCenter)
      this.shotEnd.addScaledVector(this.gesture.rect.right, 0.16)
      this.shotEnd.addScaledVector(this.gesture.rect.up, 0.11)
    }
    const cap = this.hold === 'draw' ? 0.72 : 1
    if (this.gesture.drawing && this.shotU < cap) this.shotU = Math.min(cap, this.shotU + dt * 0.4)
    if (this.gesture.drawing) {
      this.shotPoint.copy(this.shotStart).lerp(this.shotEnd, this.shotU)
      this.gesture.span(this.shotStart, this.shotPoint, this.headPos)
    }
    if (this.hold !== 'draw' && this.shotU >= 1 && this.gesture.drawing) {
      const wide = this.gesture.rect.halfW * 2 >= this.look.minSpan && this.gesture.rect.halfH * 2 >= this.look.minSpan
      this.gesture.end()
      if (wide) this.commit(this.hold === 'photo')
    }
    const last = this.captures[this.captures.length - 1]
    const popped = !!last && !last.flat && (last.pop > 0.92 || last.depth === 'model' || this.yaw > 0.02)
    if (this.hold === 'side' && popped) {
      this.yaw = approach(this.yaw, 0.78, dt * 0.7)
      this.pitch = approach(this.pitch, -0.14, dt * 0.45)
    }
    if (this.hold === 'play' || this.hold === 'rest' || this.hold === 'curl' || this.hold === 'detached') {
      this.playCurl(dt, last, popped)
    }
    if (this.hold === 'peel' || this.hold === 'open') {
      this.playPeel(dt, last, popped)
    }
  }

  private applyDeskCamera(): void {
    if (!this.orbitReady) {
      this.camera.updateMatrixWorld()
      this.home.copy(this.camera.position).sub(this.focus)
      this.radius = Math.max(0.4, this.home.length())
      this.baseYaw = Math.atan2(this.home.x, this.home.z)
      this.basePitch = Math.asin(clamp(this.home.y / this.radius, -1, 1))
      this.orbitReady = true
    }
    const yaw = this.baseYaw + this.yaw
    const pitch = clamp(this.basePitch + this.pitch, -0.8, 0.6)
    const r = this.radius
    const cp = Math.cos(pitch)
    this.camera.position.set(
      this.focus.x + r * Math.sin(yaw) * cp,
      this.focus.y + r * Math.sin(pitch),
      this.focus.z + r * Math.cos(yaw) * cp,
    )
    this.camera.lookAt(this.focus)
    this.camera.updateMatrixWorld()
  }

  private publishPhase(): void {
    const last = this.captures[this.captures.length - 1]
    const relief = last ? (last.mat.uniforms.uRelief.value as number) : 0
    const spread = last?.spread ?? 0
    const curl = last?.curl ?? 0
    let phase: Phase = 'ready'
    if (this.gesture.drawing && (this.hold !== 'draw' || this.shotU > 0.5)) phase = 'drawing'
    else if (last?.mode === 'free') phase = 'detached'
    else if (last?.mode === 'curl' && curl > 0.06) phase = 'curl'
    else if (spread > 0.85) phase = 'open'
    else if (spread > 0.22) phase = 'peel'
    else if (this.hold === 'side' && this.yaw > 0.55 && relief > 0.8) phase = 'side'
    else if (this.resting(relief, spread, curl)) phase = 'rest'
    else if (this.yaw > 0.55 && relief > 0.8) phase = 'side'
    else if (last && relief > 0.04) phase = 'relief'
    else if (last) phase = 'photo'
    this.phase = phase
    const api = (window as unknown as { __capture?: CaptureApi }).__capture
    if (!api) return
    api.phase = phase
    api.count = this.captures.length
    api.depth = last?.depth ?? 'none'
    api.relief = relief
    api.peel = last?.mode === 'free' ? 1 : last?.mode === 'curl' ? curl : spread
  }

  private resting(relief: number, spread: number, curl: number): boolean {
    if (relief <= 0.88 || this.yaw <= 0.32 || spread >= 0.05 || curl >= 0.05) return false
    switch (this.hold) {
      case 'rest':
      case 'play':
      case 'curl':
      case 'detached':
      case 'peel':
      case 'open':
        return true
      case 'off':
      case 'draw':
      case 'photo':
      case 'side':
        return false
      default: {
        const never: never = this.hold
        return never
      }
    }
  }

  private publishApi(): void {
    const api: CaptureApi = { phase: 'ready', count: 0, depth: 'none', relief: 0, peel: 0 }
    ;(window as unknown as { __capture: CaptureApi }).__capture = api
  }

  private statusLine(): string {
    const last = this.captures[this.captures.length - 1]
    if (this.touch === 'curl') return 'Pull the corner. Past the mark the sticker comes free'
    if (this.touch === 'sticker') return 'The sticker follows your hand'
    if (this.touch === 'peel') return 'Both hands pull the depth apart'
    if (this.touch === 'grab') return 'The handle moves and tilts the frame'
    if (this.gesture.drawing) return 'Release to take the photo'
    if (last?.depth === 'wait' && !last.flat) return 'Reading depth'
    if (last?.depth === 'model') return `${this.captures.length} captured · depth model`
    if (last?.depth === 'brightness') return `${this.captures.length} captured · brightness depth`
    if (last?.flat) return 'Photo held flat'
    if (this.phase === 'photo') return 'Photo in the frame'
    return this.renderer.xr.isPresenting
      ? 'Pinch a frame. Pinch a corner and pull to peel the photo off.'
      : 'Drag to draw. Drag a corner to peel the photo off. Shift-drag fans the depth. Right-drag looks around.'
  }

  private note(text: string): void {
    if (text === this.status) return
    this.status = text
    const el = document.getElementById('status')
    if (el) el.textContent = text
  }

  private paintHud(): void {
    const line = this.status
    if (line === this.hudText) return
    this.hudText = line
    const ctx = this.hudCtx
    ctx.clearRect(0, 0, 512, 128)
    ctx.fillStyle = 'rgba(12, 14, 18, 0.72)'
    roundRect(ctx, 8, 28, 496, 72, 16)
    ctx.fill()
    ctx.fillStyle = '#f4f1ea'
    ctx.font = '500 28px sans-serif'
    ctx.fillText(line, 28, 74)
    const map = (this.hud.material as { map?: { needsUpdate: boolean } }).map
    if (map) map.needsUpdate = true
  }

  private wireLaunch(): void {
    const enter = document.getElementById('enter') as HTMLButtonElement | null
    const hint = document.getElementById('hint')
    const card = document.getElementById('launch')
    if (queryFlag('ui') === '0' && card) card.hidden = true
    if (PREVIEW_FORCED && hint) hint.textContent = 'Preview is on. Drag in the view. Right-drag orbits.'
    const xr = navigator.xr
    if (!enter) return
    enter.disabled = true
    enter.addEventListener('click', () => {
      void this.armCamera()
      launchSession(() => {
        this.world.launchXR()
      }, true)
    })
    if (!xr) {
      if (hint && !PREVIEW_FORCED) hint.textContent = 'Open this page in the Meta Quest browser for passthrough.'
      return
    }
    void xr.isSessionSupported('immersive-ar').then((ok) => {
      enter.disabled = !ok
      if (!ok && hint && !PREVIEW_FORCED) hint.textContent = 'Open this page in the Meta Quest browser for passthrough.'
    })
  }

  private openWebcam(): void {
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

  private armCamera(): Promise<boolean> {
    this.cameraWanted = true
    if (this.cameraEntity) return Promise.resolve(true)
    if (this.arming) return this.arming
    this.arming = CameraUtils.getDevices()
      .then((devices) => {
        this.arming = null
        return this.attachCamera(devices)
      })
      .catch((error: unknown) => {
        this.arming = null
        console.warn('[frame] camera arm failed', error)
        return false
      })
    return this.arming
  }

  private attachCamera(devices: CameraDeviceInfo[]): boolean {
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
    const entity = this.world.createTransformEntity(anchor)
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

  private rearmCamera(now: number): void {
    if (!this.cameraWanted || this.cameraEntity || this.arming || this.rearmTries >= 3 || now < this.rearmAt) return
    this.rearmTries += 1
    this.rearmAt = now + 2 ** (this.rearmTries - 1)
    void this.armCamera()
  }

  private watchQuestCamera(): void {
    const entity = this.cameraEntity
    if (!entity) return
    const state = String(entity.getValue(CameraSource, 'state'))
    if (state !== CameraState.Active) return
    const video = entity.getValue(CameraSource, 'videoElement') as HTMLVideoElement | null
    const stream = entity.getValue(CameraSource, 'stream') as MediaStream | null
    this.feed.watch(video, stream?.getVideoTracks()[0] ?? null)
  }

  private stopCamera(): void {
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

  private playCurl(dt: number, last: Held | undefined, popped: boolean): void {
    if (!popped || !last || last.depth === 'wait' || last.flat) return
    if (last.mode === 'free') return
    const relief = last.mat.uniforms.uRelief.value as number
    if (relief < 0.9) return
    this.yaw = approach(this.yaw, 0.52, dt * 0.65)
    this.pitch = approach(this.pitch, -0.1, dt * 0.4)
    if (this.hold === 'rest' || this.yaw < 0.36) return
    if (last.mode !== 'curl') this.armCorner(last)
    const goal = this.hold === 'curl' ? 0.42 : this.look.detach + 0.02
    last.curl = approach(last.curl, goal, dt * 0.22)
    last.curlV = 0
    last.holding = true
    if (this.hold !== 'curl' && last.curl >= this.look.detach) this.floatOff(last)
  }

  private playPeel(dt: number, last: Held | undefined, popped: boolean): void {
    if (!popped || !last || last.depth === 'wait') return
    const relief = last.mat.uniforms.uRelief.value as number
    if (relief < 0.9) return
    this.yaw = approach(this.yaw, 0.52, dt * 0.65)
    this.pitch = approach(this.pitch, -0.1, dt * 0.4)
    if (this.hold === 'rest' || this.yaw < 0.36) return
    if (this.shotLetGo) {
      last.holding = false
      return
    }
    const goal = this.hold === 'peel' ? 0.48 : 1
    this.shotPeel = approach(this.shotPeel, goal, dt * 0.42)
    last.mode = 'sheets'
    last.curl = 0
    last.spread = smoothStep(this.shotPeel)
    last.spreadV = 0
    last.holding = true
    if (this.hold === 'play' && this.shotPeel > 0.98) {
      this.shotHold += dt
      if (this.shotHold > 1.15) this.shotLetGo = true
    }
  }

  private layoutHeld(held: Held): void {
    const photo = held.mat.uniforms.uPhoto.value as Texture | null
    const depth = held.mat.uniforms.uDepth.value as Texture | null
    const texel = held.mat.uniforms.uTexel.value as Vector2
    const hasDepth = held.depth === 'wait' ? 0 : 1
    bindPeel(held.peel, photo, depth, texel, this.look.feather, hasDepth)
    const relief = held.mat.uniforms.uRelief.value as number
    const sheets = held.mode === 'sheets' && !held.flat
    layoutPeel(held.peel, {
      layers: this.look.layers,
      spread: sheets ? held.spread : 0,
      maxSpread: this.look.spread,
      relief,
      depthAmt: Math.max(held.width, held.height) * this.look.relief,
      feather: this.look.feather,
    })
    this.layoutCurl(held)
    held.photo.visible = held.raster !== null && !(sheets && held.spread >= 0.035)
  }

  private layoutCurl(held: Held): void {
    if (held.mode !== 'curl' && held.mode !== 'free') {
      applyCurl(held.mat, null)
      return
    }
    const extent = axisExtent(held.width * 0.5, held.height * 0.5, held.axisX, held.axisY)
    if (held.mode === 'free') {
      applyCurl(held.mat, {
        axisX: held.axisX,
        axisY: held.axisY,
        fold: -extent,
        radius: Math.max(1.15, this.look.curl * 16),
        shadow: 0,
      })
      return
    }
    if (held.curl <= 0.001) {
      applyCurl(held.mat, null)
      return
    }
    applyCurl(held.mat, {
      axisX: held.axisX,
      axisY: held.axisY,
      fold: foldForPeel(held.curl, extent),
      radius: Math.max(0.02, this.look.curl),
      shadow: 1,
    })
  }

  private aimPointer(event: PointerEvent): void {
    const el = document.getElementById('scene-container')
    if (!el) return
    const rect = el.getBoundingClientRect()
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    this.camera.getWorldPosition(this.headPos)
  }

  /** Slide the pointer on a plane facing the camera, through the grab point. */
  private dragOnView(out: Vector3): boolean {
    this.camera.getWorldDirection(this.forward)
    const origin = this.raycaster.ray.origin
    const dir = this.raycaster.ray.direction
    const denom = dir.dot(this.forward)
    if (Math.abs(denom) < 1e-5) return false
    const t = this.local.copy(this.grabPinch).sub(origin).dot(this.forward) / denom
    if (t < 0.02) return false
    out.copy(origin).addScaledVector(dir, t)
    return true
  }

  /** `dir` is a direction, not a point. Hands pass pinch − head; the desk passes the camera ray. */
  private aimAtFrames(origin: Vector3, dir: Vector3): { held: Held; kind: FrameHit | 'sticker' } | null {
    this.aimDir.copy(dir)
    if (this.aimDir.lengthSq() < 1e-8) return null
    this.aimDir.normalize()
    const sticker = this.aimAtSticker(origin, this.aimDir)
    if (sticker) return sticker
    let best: Held | null = null
    let kind: FrameHit = 'miss'
    let bestT = 8
    for (let i = 0; i < this.captures.length; i++) {
      const held = this.captures[i]
      if (!hitPlane(held.group, origin, this.aimDir, this.planeHit)) continue
      const t = this.planeHit.distanceTo(origin)
      if (t >= bestT) continue
      held.group.worldToLocal(this.local.copy(this.planeHit))
      const hit = classifyHit(this.local, held.width * 0.5, held.height * 0.5, this.look.strip)
      if (hit === 'miss') continue
      if (held.mode === 'free' && hit !== 'handle') continue
      if ((hit === 'photo' || hit === 'corner') && !this.canPeel(held)) continue
      best = held
      kind = hit
      bestT = t
      this.pickAt.copy(this.planeHit)
    }
    return best ? { held: best, kind } : null
  }

  private canPeel(held: Held): boolean {
    if (held.flat || held.depth === 'wait' || held.mode === 'free') return false
    return (held.mat.uniforms.uRelief.value as number) > 0.55
  }

  private canCurl(held: Held): boolean {
    return this.canPeel(held)
  }

  private otherPinching(side: Side): boolean {
    const other: Side = side === 'left' ? 'right' : 'left'
    return this.pinchWas[other] || this.selectHeld[other]
  }

  private aimAtSticker(origin: Vector3, dir: Vector3): { held: Held; kind: 'sticker' } | null {
    let best: Held | null = null
    let bestT = 8
    for (let i = 0; i < this.captures.length; i++) {
      const held = this.captures[i]
      if (held.mode !== 'free') continue
      if (!hitPlane(held.photo, origin, dir, this.planeHit)) continue
      const t = this.planeHit.distanceTo(origin)
      if (t >= bestT) continue
      held.photo.worldToLocal(this.local.copy(this.planeHit))
      if (Math.abs(this.local.x) > held.width * 0.55 || Math.abs(this.local.y) > held.height * 0.55) continue
      best = held
      bestT = t
      this.pickAt.copy(this.planeHit)
    }
    return best ? { held: best, kind: 'sticker' } : null
  }

  private armCorner(held: Held, corner = nearestCorner(held.width * 0.5, held.height * 0.5, held.width * 0.5, held.height * 0.5)): void {
    if (!corner) return
    held.mode = 'curl'
    held.cornerX = corner.x
    held.cornerY = corner.y
    held.axisX = corner.axisX
    held.axisY = corner.axisY
  }

  private beginCurl(held: Held, at: Vector3): void {
    if (!this.canCurl(held)) return
    const local = this.local.copy(at)
    held.group.worldToLocal(local)
    const corner = nearestCorner(local.x, local.y, held.width * 0.5, held.height * 0.5)
    this.armCorner(held, corner)
    if (held.mode !== 'curl') return
    this.touch = 'curl'
    this.touchHeld = held
    held.holding = true
    held.curlV = 0
    this.grabPinch.copy(at)
    this.frameAxes(held)
    this.inward.copy(this.grabRight).multiplyScalar(-held.axisX).addScaledVector(this.grabUp, -held.axisY)
    if (this.inward.lengthSq() > 1e-6) this.inward.normalize()
  }

  private moveCurl(at: Vector3): void {
    const held = this.touchHeld
    if (!held || held.mode === 'free') {
      this.moveSticker(at)
      return
    }
    const pull = this.pullAmount(at)
    held.curl = curlFromPull(pull)
    held.curlV = 0
    if (held.curl >= this.look.detach) {
      this.detach(held, at)
      this.touch = 'sticker'
    }
  }

  private trackCurl(held: Held, origin: Vector3, dir: Vector3): void {
    if (held.mode === 'free') {
      if (this.dragOnView(this.pickAt)) this.moveSticker(this.pickAt)
      return
    }
    if (!hitPlane(held.group, origin, dir, this.pickAt) && !this.dragOnView(this.pickAt)) return
    this.moveCurl(this.pickAt)
  }

  private pullAmount(at: Vector3): number {
    this.local.copy(at).sub(this.grabPinch)
    const toward = Math.max(0, this.local.dot(this.forward))
    const inward = Math.max(0, this.local.dot(this.inward))
    return toward + inward
  }

  private beginSheets(held: Held, at: Vector3): void {
    if (!this.canCurl(held) && held.mode !== 'curl') return
    if (held.mode === 'free') return
    held.mode = 'sheets'
    held.curl = 0
    held.curlV = 0
    held.holding = true
    held.spreadV = 0
    this.touch = 'peel'
    this.touchHeld = held
    this.grabPinch.copy(at)
    this.frameAxes(held)
    applyCurl(held.mat, null)
  }

  private beginSticker(held: Held, at: Vector3): void {
    this.touch = 'sticker'
    this.touchHeld = held
    held.holding = true
    this.grabPinch.copy(at)
    this.grabPos.copy(held.photo.position)
  }

  private moveSticker(at: Vector3): void {
    const held = this.touchHeld
    if (!held) return
    this.local.copy(at).sub(this.grabPinch)
    this.parentDelta(this.local, this.aimDir)
    held.photo.position.copy(this.grabPos).add(this.aimDir)
  }

  /** Lift the curled photo off the frame and leave it in the hand. */
  private detach(held: Held, at: Vector3): void {
    if (held.mode === 'free') return
    const photo = held.photo
    photo.updateWorldMatrix(true, false)
    this.worldMat.copy(photo.matrixWorld)
    this.root.updateWorldMatrix(true, false)
    this.localMat.copy(this.root.matrixWorld).invert().multiply(this.worldMat)
    held.group.remove(photo)
    this.root.add(photo)
    photo.position.setFromMatrixPosition(this.localMat)
    photo.quaternion.setFromRotationMatrix(this.localMat)
    photo.scale.setFromMatrixScale(this.localMat)
    photo.renderOrder = 8
    held.mode = 'free'
    held.curl = 1
    held.holding = true
    this.frameAxes(held)
    const parked = this.planeHit.copy(at).addScaledVector(this.forward, 0.09)
    photo.updateWorldMatrix(true, false)
    this.local.set(0, 0, 0).applyMatrix4(photo.matrixWorld)
    this.parentDelta(this.pickAt.copy(parked).sub(this.local), this.aimDir)
    photo.position.add(this.aimDir)
    this.grabPinch.copy(parked)
    this.grabPos.copy(photo.position)
  }

  /** The desk demo lets the sticker go in front of the frame. */
  private floatOff(held: Held): void {
    this.frameAxes(held)
    this.inward.copy(this.grabRight).multiplyScalar(-held.axisX).addScaledVector(this.grabUp, -held.axisY)
    held.group.updateWorldMatrix(true, false)
    this.pickAt.set(0, 0, 0).applyMatrix4(held.group.matrixWorld)
    this.pickAt.addScaledVector(this.forward, 0.22)
    this.pickAt.addScaledVector(this.inward, 0.05)
    this.detach(held, this.pickAt)
  }

  private parentDelta(worldDelta: Vector3, out: Vector3): void {
    this.root.getWorldQuaternion(this.parentQ).invert()
    out.copy(worldDelta).applyQuaternion(this.parentQ)
  }

  private movePeel(at: Vector3): void {
    const held = this.touchHeld
    if (!held) return
    const pull = this.local.copy(at).sub(this.grabPinch).dot(this.forward)
    held.spread = spreadFromPull(pull)
    held.spreadV = 0
  }

  private beginGrab(held: Held, at: Vector3): void {
    this.touch = 'grab'
    this.touchHeld = held
    this.grabQuat.copy(held.group.quaternion)
    this.grabPos.copy(held.group.position)
    this.grabPinch.copy(at)
    this.frameAxes(held)
  }

  private moveGrab(at: Vector3): void {
    const held = this.touchHeld
    if (!held) return
    this.local.copy(at).sub(this.grabPinch)
    const yaw = clamp(this.local.dot(this.grabRight) * 2.4, -0.7, 0.7)
    const pitch = clamp(this.local.dot(this.grabUp) * 2.4, -0.5, 0.5)
    this.qYaw.setFromAxisAngle(this.axisY, yaw)
    this.qPitch.setFromAxisAngle(this.axisX, pitch)
    held.group.quaternion.copy(this.grabQuat).multiply(this.qYaw).multiply(this.qPitch)
    held.group.position.copy(this.grabPos).add(at).sub(this.grabPinch)
    held.group.updateWorldMatrix(true, false)
    this.local.set(held.handle.position.x, held.handle.position.y, held.handle.position.z)
    this.local.applyMatrix4(held.group.matrixWorld)
    held.group.position.add(at).sub(this.local)
  }

  private frameAxes(held: Held): void {
    held.group.updateWorldMatrix(true, false)
    const e = held.group.matrixWorld.elements
    this.grabRight.set(e[0], e[1], e[2])
    this.grabUp.set(e[4], e[5], e[6])
    this.forward.set(e[8], e[9], e[10])
  }

  private endTouch(): void {
    if (this.touchHeld) this.touchHeld.holding = false
    this.touch = 'none'
    this.touchHeld = null
    this.primary = null
    this.dual = false
    this.waitClear = true
  }

  private dispose(): void {
    this.session?.removeEventListener('selectstart', this.onSelectStart)
    this.session?.removeEventListener('selectend', this.onSelectEnd)
    this.stopCamera()
    this.webcamStream?.getTracks().forEach((track) => track.stop())
    this.target?.dispose()
    this.feed.dispose()
  }
}

function firstEntity(entities: Iterable<Entity>): Entity | null {
  for (const entity of entities) return entity
  return null
}

function readHold(): Hold {
  const at = queryFlag('at')
  if (at === 'draw' || at === 'photo' || at === 'side' || at === 'rest' || at === 'peel' || at === 'open' || at === 'curl' || at === 'detached') return at
  if (queryFlag('shot') !== null) return 'play'
  return 'off'
}

function smoothStep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

function easeOut(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return 1 - (1 - x) ** 3
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function approach(from: number, to: number, step: number): number {
  if (Math.abs(to - from) <= step) return to
  return from + Math.sign(to - from) * step
}

function hudMesh(canvas: HTMLCanvasElement): Mesh {
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  const mat = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  const mesh = new Mesh(new PlaneGeometry(0.42, 0.105), mat)
  mesh.position.set(-0.18, 0.16, -0.75)
  mesh.renderOrder = 10
  return mesh
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
