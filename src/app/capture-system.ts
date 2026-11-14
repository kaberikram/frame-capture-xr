import { Color, Group, Matrix4, Vector3, XRMesh, XRPlane, createSystem, type Object3D } from '@iwsdk/core'
import { CameraRig, cameraAllowed } from '../capture/camera-rig.js'
import { prepareDarkroom } from '../capture/darkroom.js'
import { onDepthProgress, prepareDepthModel } from '../capture/depth-model.js'
import { stepDevelop } from '../capture/develop.js'
import { heldLook, layoutBorder, type Held } from '../capture/held.js'
import { Shutter } from '../capture/shutter.js'
import { bindWarpApi, computePhase, publishApi, publishPhase, publishRoom, type Phase } from '../debug/api.js'
import { DEBUG } from '../debug/metrics.js'
import { DebugOverlay } from '../debug/overlay.js'
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
import { TimePlay } from '../interaction/time-play.js'
import { RoomPlates } from '../room/plates.js'
import { bindRoomSpace, RoomScan } from '../room/room-scan.js'
import type { Effect } from '../look/effects.js'
import { makeGlowLine, setGlowLine, type GlowLine } from '../look/glow-line.js'
import { PALETTE, voice } from '../look/palette.js'
import { PinchLights } from '../look/pinch-light.js'
import { applyLook } from '../look/relief.js'
import { TimeWarp } from '../look/time-glass.js'
import { SoundCues } from '../sound/cues.js'
import { Soundscape } from '../sound/soundscape.js'
import { Captions, type Hint } from '../ui/captions.js'
import { Status, launchNote, statusLine, wireLaunch } from '../ui/status.js'
import { LiveSurfaces } from '../world/live-surfaces.js'
import { SnapPreview } from '../world/snap.js'
import { buildStandIn } from '../world/stand-in.js'
import { DESK_SURFACES } from '../world/surfaces.js'
import { CaptureLook } from './capture-look.js'
import { defaultLook, firstEntity, readLook, type Ctx } from './context.js'
import { CLEAN, HAND_MODELS, PEEL, WEBCAM_REQUESTED, launchSession } from './experience.js'

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
  private readonly effects: Effect[] = []
  private readonly gesture = new RectGesture()
  private readonly deskColor = new Color('#141820')
  private readonly deskCamera = new DeskCamera()
  private readonly status = new Status()
  private readonly captions = new Captions()
  private readonly pinchLights = new PinchLights(PALETTE)
  private readonly sound = new Soundscape()
  private readonly cues = new SoundCues(this.sound)
  private readonly basis = new Matrix4()
  private ctx!: Ctx
  private rig!: CameraRig
  private warp!: TimeWarp
  private shutter!: Shutter
  private grip!: Grip
  private stickers!: Stickers
  private sheets!: Sheets
  private interaction!: Interaction
  private hands!: HandInput
  private timePlay!: TimePlay
  private room!: RoomScan
  private plates!: RoomPlates
  private readonly reach = new Vector3()
  private readonly headAt = new Vector3()
  private readonly gaze = new Vector3()
  /** A piece has been carried at least once, so the hint for it can retire. */
  private pointer!: DeskPointer
  private shot!: DeskShot
  private surfaces!: LiveSurfaces
  private snap!: SnapPreview
  private standIn!: Group
  private dragGroup!: Group
  private dragLine!: GlowLine
  /** What the hint clock last saw, so a hint retires the moment its action happens. */
  private sawDrawing = false
  private sawCurl = false
  private sawStuck = 0
  /** When the time hint started showing, so it can retire and the peel hint can follow. */
  private timeHintAt = -1
  private session: XRSession | null = null
  private phase: Phase = 'ready'
  private debug: DebugOverlay | null = null
  /** The camera was asked for from the launch card once; a second Enter goes in whatever the answer. */
  private cameraAsked = false
  private entering = false
  private lastFrameMs = 0

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
      effects: this.effects,
      gesture: this.gesture,
    }
    this.ctx = ctx

    this.standIn = buildStandIn()
    root.add(this.standIn)

    this.dragLine = makeGlowLine(PALETTE, 5)
    this.dragGroup = new Group()
    this.dragGroup.name = 'draw-frame'
    this.dragGroup.add(this.dragLine.mesh)
    this.dragGroup.visible = false
    root.add(this.dragGroup)
    root.add(this.pinchLights.group)
    root.add(this.captions.mesh)

    this.grip = new Grip(ctx)
    this.snap = new SnapPreview(ctx, this.grip)
    root.add(this.snap.group)

    this.rig = new CameraRig(ctx, this.deskColor, () => this.overlays())
    this.warp = new TimeWarp(this.renderer, this.dragGroup, this.rig)
    this.shutter = new Shutter(ctx, this.rig, (text, seconds) => this.status.flash(text, seconds), this.warp)
    this.stickers = new Stickers(ctx, this.grip, () => this.snap.clear())
    this.sheets = new Sheets(ctx, this.grip)
    const frameGrab = new FrameGrab(this.grip)
    this.interaction = new Interaction(ctx, this.grip, this.stickers, this.sheets, frameGrab, this.snap)
    this.hands = new HandInput(ctx, this.grip, this.interaction, this.sheets, this.shutter)
    this.timePlay = new TimePlay(ctx, this.hands, this.grip, this.warp, root, this.renderer)
    this.plates = new RoomPlates(this.rig, this.hands)
    this.room = new RoomScan(root, this.renderer, this.plates)
    // Two pages, one app. The peel page hands every pinch to the room; frame capture never sees it.
    if (PEEL) {
      this.hands.room = this.room
      this.room.setActive(true)
      this.room.pixelScale = () => this.pixelScale()
      this.room.onLift = (at, speed, dt) => this.sound.peel(at, speed, dt)
      this.room.onFree = (at) => {
        this.sound.detach(at)
        this.sound.glow(at)
      }
      this.room.onLand = (at) => this.sound.stick(at)
    } else this.hands.play = this.timePlay
    this.shot = new DeskShot(ctx, this.deskCamera, this.stickers, this.grip, this.shutter)
    this.pointer = new DeskPointer(ctx, this.grip, this.interaction, this.stickers, frameGrab, this.deskCamera, this.shutter, () => this.shot.blocksDraw)
    if (PEEL) this.pointer.room = this.room
    this.pointer.attach(document.getElementById('scene-container'))
    this.surfaces = new LiveSurfaces(ctx)
    // Passthrough shows your real hands; IWSDK's hand models would sit on top of them.
    // This stops the models animating; `hideHandModels` keeps them out of view.
    if (!HAND_MODELS) {
      const handVisuals = this.input.xr.visualAdapters.hand
      handVisuals.left.toggleVisual(false)
      handVisuals.right.toggleVisual(false)
    }

    this.hands.onPinch = (at) => this.sound.pinch(at)
    this.warp.onNote = (line) => {
      this.captions.retire('time')
      if (!CLEAN) this.status.flash(line, 2.6)
    }
    this.shutter.onExpose = (held) => this.cues.shutter(held)
    // Browsers start audio only from a gesture: the Enter button, or the first click on the desk.
    const view = document.getElementById('scene-container')
    view?.addEventListener('pointerdown', () => this.sound.resume())
    wireLaunch(() => {
      this.sound.resume()
      void this.enter()
    })
    this.cleanupFuncs.push(() => this.dispose())
    publishApi()
    bindWarpApi(() => this.warp.cycle())
    if (DEBUG) {
      this.debug = new DebugOverlay()
      this.debug.mount(this.player.head)
    }
    prepareDarkroom()
    if (WEBCAM_REQUESTED) this.rig.openWebcam()
    // The peel page has no photos to give depth to, so it never downloads the model.
    if (PEEL) return
    onDepthProgress((state, percent) => {
      if (CLEAN) return
      const el = document.getElementById('depth')
      if (!el) return
      el.textContent = voice(
        state === 'ready' ? 'Depth is ready' : state === 'failed' ? 'Depth will come from brightness' : `Preparing depth · ${percent}%`,
      )
    })
    void prepareDepthModel().catch((error: unknown) => {
      console.warn('[frame] depth model', error)
    })
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
      if (!HAND_MODELS) this.hideHandModels()
      this.player.head.updateWorldMatrix(true, false)
      this.player.updateWorldMatrix(true, false)
      this.rig.lens.recordHead(this.player.head, this.world.xrFrame?.predictedDisplayTime, now)
      this.rig.watchQuest()
      // Hands and the shutter read this frame's poses. The time window's blit
      // borrows the renderer afterwards, so it cannot move those poses.
      this.hands.update(now)
      if (!PEEL) {
        this.timePlay.step(dt)
        this.shutter.step(now, this.hands)
        this.warp.update(dt, now, true, this.camera.aspect)
      }
      this.rig.rearm(now)
      this.surfaces.arm(this.session)
    } else {
      this.scene.background = this.deskColor
      this.standIn.visible = true
      this.rig.watchWebcam()
      this.deskCamera.apply(this.camera)
      if (!PEEL) {
        this.timePlay.step(dt)
        this.warp.update(dt, now, false, this.camera.aspect)
        this.shot.update(dt)
      }
    }
    if (PEEL) {
      if (presenting) this.reachForRoom()
      this.plates.step(dt, presenting)
      const depthFrame = this.world.xrFrame as Parameters<RoomScan['step']>[2]
      this.room.step(dt, presenting, presenting ? depthFrame : null, this.camera, this.standIn)
    }
    this.syncDrag(now)
    // Surfaces only matter while a sticker is being carried toward one.
    const driven = this.drivenSticker()
    if (driven) this.surfaces.collect(this.queries.planes.entities, this.queries.meshes.entities)
    this.snap.update(driven, presenting ? this.surfaces.list : DESK_SURFACES, dt)
    this.interaction.contact()
    this.animate(dt, now)
    this.warp.sync(this.gesture.drawing, this.gesture.rect, this.captures)
    this.updatePinchLights(presenting, dt)
    this.cues.listen(presenting ? this.player.head : this.camera)
    this.cues.step(this.captures, dt)
    this.publishPhase()
    const last = this.captures[this.captures.length - 1]
    const problem = presenting ? this.rig.problem : null
    if (CLEAN) {
      const roomNote = PEEL ? this.room.depthNote : null
      this.captions.update(problem ?? roomNote, this.player.head, presenting, dt)
      this.status.note(problem ?? roomNote ?? '')
    } else {
      this.captions.update(PEEL ? this.peelCaption(problem) : this.captionLine(last), this.player.head, presenting, dt)
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
          warp: this.warp.mode,
          camera: problem,
          room: PEEL,
          roomNote: this.room.depthNote,
          piece: this.room.holding ? this.room.state : this.room.anyFloating ? 'free' : 'none',
          overSurface: this.room.overSurface,
        }),
      )
    }
    if (this.debug) this.paintDebug(presenting, last)
  }

  /**
   * Ask for the headset cameras while still on the page, where Quest Browser can
   * show its prompt, then enter passthrough. Asked from inside the session, the
   * prompt can be lost and the camera never starts.
   */
  private async enter(): Promise<void> {
    if (this.entering) return
    this.entering = true
    const button = document.getElementById('enter') as HTMLButtonElement | null
    try {
      if (this.cameraAsked || (await cameraAllowed())) {
        void this.rig.arm()
      } else {
        this.cameraAsked = true
        if (!CLEAN) launchNote(voice('Allow the headset cameras when asked. The frame uses them to take its photo.'))
        if (button) button.disabled = true
        const ok = await this.rig.arm()
        if (button) button.disabled = false
        if (!ok) {
          const problem = this.rig.problem ?? 'The camera did not start'
          launchNote(voice(CLEAN ? problem : `${problem}. Press Enter passthrough to go in without photos.`))
          return
        }
        launchNote('')
        // Entering needs a recent tap. A prompt answered slowly uses it up, so ask for one more.
        if (navigator.userActivation && !navigator.userActivation.isActive) {
          if (!CLEAN) launchNote(voice('Camera allowed. Press Enter passthrough.'))
          return
        }
      }
      launchSession(() => {
        this.world.launchXR()
      }, true, PEEL)
    } finally {
      this.entering = false
    }
  }

  /** IWSDK shows each tracked hand model again every frame (after `toggleVisual`), so hide it after input runs. */
  private hideHandModels(): void {
    const hands = this.input.xr.visualAdapters.hand
    const left = hands.left.visual
    const right = hands.right.visual
    if (left) left.model.visible = false
    if (right) right.model.visible = false
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
    bindRoomSpace(session ? this.renderer.xr.getReferenceSpace() : null)
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

  /** The frame being drawn: a line of light with a faint warm wash inside, following the live rectangle. */
  private syncDrag(now: number): void {
    const live = this.gesture.rect
    if (!this.gesture.drawing || !live.active) {
      this.dragGroup.visible = false
      return
    }
    this.dragGroup.visible = true
    this.gesture.pose(this.dragGroup.position, this.dragGroup.quaternion, this.basis)
    setGlowLine(this.dragLine, { halfW: live.halfW, halfH: live.halfH, core: this.look.strip * 0.75, glow: 1, tint: 0.035, opacity: 1, time: now })
  }

  /** In a headset a light gathers at each pinch; on the desk one rides the dragged corner. */
  private updatePinchLights(presenting: boolean, dt: number): void {
    const lights = this.pinchLights
    if (presenting) {
      const sides = ['left', 'right'] as const
      for (let i = 0; i < 2; i++) {
        const r = this.hands.readiness(sides[i])
        lights.set(i, r >= 0 ? this.hands.pinchPoint(sides[i]) : null, r, this.hands.isPinched(sides[i]), dt)
      }
      return
    }
    const drawing = this.gesture.drawing
    lights.set(0, drawing ? this.gesture.dragCorner : null, drawing ? 1 : -1, drawing, dt)
    lights.set(1, null, -1, false, dt)
  }

  /**
   * What the caption says: a one-off note, the hands nudge, or the hint for
   * this moment. A hint retires the moment its action happens.
   */
  private captionLine(last: Held | undefined): string | null {
    const flash = this.status.flashing
    if (flash) return flash
    if (this.shutter.waitingOnHands) return 'Let your hands fall away'
    const touch = this.grip.touch
    const drawing = this.gesture.drawing
    if (drawing || touch !== 'none') this.captions.active()
    if (drawing && !this.sawDrawing) this.captions.retire('draw')
    if (touch === 'curl' && !this.sawCurl) this.captions.retire('peel')
    let stuck = 0
    for (let i = 0; i < this.captures.length; i++) if (this.captures[i].mode === 'stuck') stuck++
    if (stuck > this.sawStuck) this.captions.retire('wall')
    this.sawDrawing = drawing
    this.sawCurl = touch === 'curl'
    this.sawStuck = stuck
    const settled = last && !last.frameGone && last.mode === 'idle' && last.pop >= 1 && last.depth !== 'wait'
    let hint: Hint | null = null
    if (drawing || touch === 'curl' || touch === 'grab' || touch === 'peel') hint = null
    else if (touch === 'sticker' || last?.mode === 'free') hint = 'wall'
    else if (settled && this.captions.hint('time')) hint = 'time'
    else if (settled) hint = 'peel'
    else if (!last || last.frameGone) hint = 'draw'
    if (hint === 'time') {
      const now = performance.now() / 1000
      if (this.timeHintAt < 0) this.timeHintAt = now
      if (now - this.timeHintAt > 8) {
        this.captions.retire('time')
        hint = 'peel'
      }
    } else this.timeHintAt = -1
    return this.captions.hint(hint)
  }

  /**
   * Tell the room where the head and hands are. Each open hand gathers light on
   * the surface its index finger is reaching for. An open hand raised in view
   * means what you are looking at can be lifted from where you stand.
   */
  private reachForRoom(): void {
    const head = this.player.head
    head.getWorldPosition(this.headAt)
    // The head looks down its own -z.
    this.gaze.set(0, 0, -1).transformDirection(head.matrixWorld)
    const sides = ['left', 'right'] as const
    let ready = false
    for (let i = 0; i < 2; i++) {
      const pose = this.hands.pose[sides[i]]
      if (!pose.tracked || pose.pinching) {
        this.room.hover(i as 0 | 1, null, null)
        continue
      }
      this.reach.copy(pose.index).sub(this.headAt)
      this.room.hover(i as 0 | 1, pose.index, this.reach)
      const away = this.reach.length()
      if (away > 0.2 && this.reach.dot(this.gaze) / away > 0.5) ready = true
    }
    const left = this.hands.pose.left
    const right = this.hands.pose.right
    this.room.setHands(left.tracked ? left.palm : null, right.tracked ? right.palm : null)
    this.room.look(this.headAt, this.gaze, ready)
  }

  /**
   * The peel page says nothing unless something is wrong. What can be lifted
   * shows itself in light.
   */
  private peelCaption(problem: string | null): string | null {
    return this.status.flashing ?? problem ?? this.room.depthNote
  }

  /** Pixels per metre at one metre, so dust keeps its size at any distance. */
  private pixelScale(): number {
    if (this.renderer.xr.isPresenting) return 760
    return this.renderer.domElement.height / (2 * Math.tan((this.camera.fov * Math.PI) / 360))
  }

  private animate(dt: number, now: number): void {
    for (let i = 0; i < this.captures.length; i++) {
      const held = this.captures[i]
      layoutBorder(held, this.look.strip, now, this.shutter.isPending(held))
      if (held.flat) continue
      stepDevelop(held, dt, this.look)
      this.stickers.step(held, dt)
      this.sheets.step(held, dt)
      const fanned = this.sheets.layout(held)
      this.stickers.layout(held)
      held.photo.visible = held.raster !== null && !(fanned && held.spread >= 0.035) && !this.warp.covers(held)
    }
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i]
      if (!effect.step(dt)) continue
      effect.dispose()
      this.effects.splice(i, 1)
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
    list.push(this.dragGroup, this.snap.group, this.pinchLights.group, this.captions.mesh, this.room.group)
    for (let i = 0; i < this.effects.length; i++) list.push(this.effects[i].group)
    return list
  }

  private publishPhase(): void {
    const last = this.captures[this.captures.length - 1]
    this.phase = computePhase({
      drawing: this.gesture.drawing,
      hold: this.shot.hold,
      drawU: this.shot.drawU,
      last,
      dissolving: this.effects.some((e) => e.kind === 'dissolve'),
      previewing: this.snap.previewing,
      yaw: this.deskCamera.yaw,
    })
    publishPhase(this.phase, this.captures.length, last, { mode: this.warp.mode })
    publishRoom({
      active: PEEL,
      chunks: this.room.chunkCount,
      pieces: this.room.pieceCount,
      piece: this.room.state,
      radius: this.room.pieceRadius,
      lights: this.room.lightCount,
      pool: this.room.poolLevel,
      kind: this.room.kind,
      attention: this.room.attention,
      outline: this.room.outline,
    })
  }

  private paintDebug(presenting: boolean, last: Held | undefined): void {
    const debug = this.debug
    if (!debug) return
    const nowMs = performance.now()
    const frameMs = this.lastFrameMs ? nowMs - this.lastFrameMs : 0
    this.lastFrameMs = nowMs
    const feed = this.rig.feed
    const stamp = feed.stamp
    const hand = (side: 'left' | 'right') => {
      const r = this.hands.readiness(side)
      return r < 0 ? '-' : this.hands.isPinched(side) ? 'pinch' : r.toFixed(2)
    }
    debug.frame(
      nowMs,
      frameMs,
      [
        `camera ${this.rig.state} ${feed.width}x${feed.height}${stamp === null ? '' : `  frame age ${Math.round(nowMs - stamp * 1000)} ms`}`,
        `hands L ${hand('left')}  R ${hand('right')}`,
        `frames ${this.captures.length}  phase ${this.phase}  depth ${last?.depth ?? '-'}`,
        this.warp.debugLine(),
      ],
      presenting,
    )
  }

  private dispose(): void {
    this.debug?.dispose()
    this.captions.dispose()
    this.pinchLights.dispose()
    this.sound.dispose()
    this.surfaces.clear()
    this.hands.dispose()
    this.timePlay.dispose()
    this.room.dispose()
    this.plates.dispose()
    this.pointer.detach()
    this.rig.dispose()
    this.warp.dispose()
  }
}
