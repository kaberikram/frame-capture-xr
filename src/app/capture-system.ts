import { Color, Group, Matrix4, XRMesh, XRPlane, createSystem, type BufferAttribute, type Object3D } from '@iwsdk/core'
import { CameraRig } from '../capture/camera-rig.js'
import { prepareDepthModel } from '../capture/depth-model.js'
import { stepDevelop } from '../capture/develop.js'
import { heldLook, type Held } from '../capture/held.js'
import { Shutter } from '../capture/shutter.js'
import { computePhase, publishApi, publishPhase, type Phase } from '../debug/api.js'
import { DeskCamera } from '../desk/desk-camera.js'
import { DeskShot } from '../desk/shot.js'
import { DeskPointer } from '../input/desk-pointer.js'
import { RectGesture } from '../input/gesture.js'
import { HandInput } from '../input/hands.js'
import { FrameGrab } from '../interaction/frame-grab.js'
import { Grip } from '../interaction/grip.js'
import { Interaction } from '../interaction/router.js'
import { Sheets } from '../interaction/sheets.js'
import { Stickers } from '../interaction/stickers.js'
import { disposeDissolve, stepDissolve, type DissolveRig } from '../look/dissolve.js'
import { makeBorder, writeBorder } from '../look/frame-border.js'
import { applyLook } from '../look/relief.js'
import { Status, statusLine, wireLaunch } from '../ui/status.js'
import { LiveSurfaces } from '../world/live-surfaces.js'
import { SnapPreview } from '../world/snap.js'
import { buildStandIn } from '../world/stand-in.js'
import { DESK_SURFACES } from '../world/surfaces.js'
import { CaptureLook } from './capture-look.js'
import { REDUCE_MOTION, defaultLook, firstEntity, readLook, type Ctx } from './context.js'
import { WEBCAM_REQUESTED, launchSession } from './experience.js'

/**
 * Draw a rectangle in the air, anchor it, photograph what it frames, and ease
 * that photo out into a depth relief. Then peel it off and stick it somewhere.
 * This system only wires the parts together and fixes the order they run in.
 */
export class CaptureSystem extends createSystem({
  settings: { required: [CaptureLook] },
  planes: { required: [XRPlane] },
  meshes: { required: [XRMesh] },
}) {
  private readonly look = defaultLook()
  private readonly captures: Held[] = []
  private readonly dissolves: DissolveRig[] = []
  private readonly gesture = new RectGesture()
  private readonly deskColor = new Color('#141820')
  private readonly deskCamera = new DeskCamera()
  private readonly status = new Status()
  private readonly basis = new Matrix4()
  private ctx!: Ctx
  private rig!: CameraRig
  private shutter!: Shutter
  private grip!: Grip
  private stickers!: Stickers
  private sheets!: Sheets
  private interaction!: Interaction
  private hands!: HandInput
  private pointer!: DeskPointer
  private shot!: DeskShot
  private surfaces!: LiveSurfaces
  private snap!: SnapPreview
  private standIn!: Group
  private dragGroup!: Group
  private dragPositions!: BufferAttribute
  private session: XRSession | null = null
  private phase: Phase = 'ready'

  init(): void {
    const root = new Group()
    root.name = 'frame-capture'
    this.world.createTransformEntity(root)
    const ctx: Ctx = {
      world: this.world,
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      player: this.player,
      input: this.input,
      root,
      look: this.look,
      captures: this.captures,
      dissolves: this.dissolves,
      gesture: this.gesture,
    }
    this.ctx = ctx

    this.standIn = buildStandIn()
    root.add(this.standIn)

    const border = makeBorder(this.look.strip)
    this.dragPositions = border.positions
    this.dragGroup = new Group()
    this.dragGroup.name = 'draw-frame'
    this.dragGroup.add(border.mesh)
    this.dragGroup.visible = false
    root.add(this.dragGroup)

    this.grip = new Grip(ctx)
    this.snap = new SnapPreview(ctx, this.grip)
    root.add(this.snap.group)
    this.player.head.add(this.status.hud)

    this.rig = new CameraRig(ctx, this.deskColor, () => this.overlays())
    this.shutter = new Shutter(ctx, this.rig, (text) => this.status.flash(text))
    this.stickers = new Stickers(ctx, this.grip, () => this.snap.clear())
    this.sheets = new Sheets(ctx, this.grip)
    const frameGrab = new FrameGrab(this.grip)
    this.interaction = new Interaction(ctx, this.grip, this.stickers, this.sheets, frameGrab, this.snap)
    this.hands = new HandInput(ctx, this.grip, this.interaction, this.sheets, this.shutter)
    this.shot = new DeskShot(ctx, this.deskCamera, this.stickers, this.grip, this.shutter)
    this.pointer = new DeskPointer(ctx, this.grip, this.interaction, this.stickers, frameGrab, this.deskCamera, this.shutter, () => this.shot.blocksDraw)
    this.pointer.attach(document.getElementById('scene-container'))
    this.surfaces = new LiveSurfaces(ctx)
    // Passthrough shows your real hands; IWSDK's hand models would sit on top of them.
    const handVisuals = this.input.xr.visualAdapters.hand
    handVisuals.left.toggleVisual(false)
    handVisuals.right.toggleVisual(false)

    wireLaunch(() => {
      void this.rig.arm()
      launchSession(() => {
        this.world.launchXR()
      }, true)
    })
    publishApi()
    if (WEBCAM_REQUESTED) this.rig.openWebcam()
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
      this.rig.lens.recordHead(this.player.head, this.world.xrFrame?.predictedDisplayTime, now)
      this.rig.watchQuest()
      this.hands.update(now)
      this.shutter.step(now, this.hands)
      this.rig.rearm(now)
      this.surfaces.arm(this.session)
    } else {
      this.scene.background = this.deskColor
      this.standIn.visible = true
      this.rig.watchWebcam()
      this.deskCamera.apply(this.camera)
      this.shot.update(dt)
    }
    this.syncDrag()
    this.surfaces.collect(this.queries.planes.entities, this.queries.meshes.entities)
    this.snap.update(this.drivenSticker(), presenting ? this.surfaces.list : DESK_SURFACES)
    this.interaction.contact()
    this.animate(dt)
    this.status.hud.visible = presenting
    if (presenting) this.status.paintHud()
    this.publishPhase()
    const last = this.captures[this.captures.length - 1]
    this.status.note(
      statusLine({
        touch: this.grip.touch,
        previewing: this.snap.previewing,
        last,
        drawing: this.gesture.drawing,
        phase: this.phase,
        presenting,
        count: this.captures.length,
        waitingOnHands: this.shutter.waitingOnHands,
      }),
    )
  }

  private readLook(): void {
    const entity = firstEntity(this.queries.settings.entities)
    if (!entity) return
    readLook(entity, this.look)
    for (let i = 0; i < this.captures.length; i++) {
      const held = this.captures[i]
      applyLook(held.mat, heldLook(this.look, held.width, held.height))
    }
  }

  private syncSession(): void {
    const session = this.renderer.xr.getSession() ?? null
    if (session === this.session) return
    this.session = session
    this.hands.bind(session)
    this.gesture.cancel()
    this.rig.lens.clear()
    this.surfaces.clear()
    if (!session) {
      this.shutter.cancelPending()
      this.rig.stop()
      return
    }
    const features = (session as XRSession & { enabledFeatures?: readonly string[] }).enabledFeatures
    console.info(`[frame] session ${features ? features.join(' ') : 'features unlisted'}`)
    this.surfaces.arm(session)
  }

  /** The frame being drawn follows the live rectangle. */
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
      stepDevelop(held, dt, this.look)
      this.stickers.step(held, dt)
      this.sheets.step(held, dt)
      const fanned = this.sheets.layout(held)
      this.stickers.layout(held)
      held.photo.visible = held.raster !== null && !(fanned && held.spread >= 0.035)
    }
    const meltFor = REDUCE_MOTION ? 0.05 : this.look.dissolve
    for (let i = this.dissolves.length - 1; i >= 0; i--) {
      const rig = this.dissolves[i]
      if (!stepDissolve(rig, dt, meltFor)) continue
      disposeDissolve(rig)
      this.dissolves.splice(i, 1)
    }
  }

  /** The free sticker a hand or the desk demo is carrying, which may land on a surface. */
  private drivenSticker(): Held | null {
    const held = this.grip.held
    if (this.grip.touch === 'sticker' && held && held.mode === 'free') return held
    return this.shot.carried(this.captures[this.captures.length - 1])
  }

  /** Everything the app draws, hidden while the desk camera photographs the stand-in room. */
  private overlays(): Object3D[] {
    const list: Object3D[] = []
    for (let i = 0; i < this.captures.length; i++) list.push(this.captures[i].group)
    list.push(this.dragGroup, this.snap.group)
    for (let i = 0; i < this.dissolves.length; i++) list.push(this.dissolves[i].group)
    return list
  }

  private publishPhase(): void {
    const last = this.captures[this.captures.length - 1]
    this.phase = computePhase({
      drawing: this.gesture.drawing,
      hold: this.shot.hold,
      drawU: this.shot.drawU,
      last,
      dissolving: this.dissolves.length > 0,
      previewing: this.snap.previewing,
      yaw: this.deskCamera.yaw,
    })
    publishPhase(this.phase, this.captures.length, last)
  }

  private dispose(): void {
    this.surfaces.clear()
    this.hands.dispose()
    this.pointer.detach()
    this.rig.dispose()
  }
}
