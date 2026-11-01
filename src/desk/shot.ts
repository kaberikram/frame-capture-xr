import { Quaternion, Vector3 } from '@iwsdk/core'
import { DRAW_DISTANCE, WORLD_UP, type Ctx } from '../app/context.js'
import { queryFlag } from '../app/experience.js'
import { setMode, type Held } from '../capture/held.js'
import type { Shutter } from '../capture/shutter.js'
import type { Grip } from '../interaction/grip.js'
import type { Stickers } from '../interaction/stickers.js'
import { approach, smoothStep } from '../util/math.js'
import { DESK_SURFACES, DESK_WALL, nearestSurface } from '../world/surfaces.js'
import type { DeskCamera } from './desk-camera.js'

/**
 * `?shot=1` plays the whole story on the desk. `?at=<stage>` plays up to one
 * stage and holds it, for screenshots.
 */
export type Hold = 'off' | 'play' | 'draw' | 'photo' | 'side' | 'rest' | 'peel' | 'open' | 'curl' | 'detached' | 'stuck'
type StickStage = 'idle' | 'melt' | 'travel' | 'linger' | 'done'

export function readHold(): Hold {
  const at = queryFlag('at')
  if (at === 'draw' || at === 'photo' || at === 'side' || at === 'rest' || at === 'peel' || at === 'open' || at === 'curl' || at === 'detached' || at === 'stuck') return at
  if (queryFlag('shot') !== null) return 'play'
  return 'off'
}

export class DeskShot {
  readonly hold = readHold()
  /** 0..1 along the scripted drag. */
  drawU = 0
  private started = false
  private peel = 0
  private openFor = 0
  private letGo = false
  private stage: StickStage = 'idle'
  private clock = 0
  private readonly start = new Vector3()
  private readonly end = new Vector3()
  private readonly point = new Vector3()
  private readonly center = new Vector3()
  private readonly forward = new Vector3()
  private readonly head = new Vector3()
  private readonly from = new Vector3()
  private readonly to = new Vector3()
  private readonly pos = new Vector3()
  private readonly quat = new Quaternion()

  constructor(
    private readonly ctx: Ctx,
    private readonly view: DeskCamera,
    private readonly stickers: Stickers,
    private readonly grip: Grip,
    private readonly shutter: Shutter,
  ) {}

  /** The script owns the frame, so the mouse does not draw. */
  get blocksDraw(): boolean {
    return this.hold !== 'off'
  }

  /** The sticker the script is carrying to the wall, if any. */
  carried(last: Held | undefined): Held | null {
    if (!last || last.mode !== 'free') return null
    if (this.hold !== 'play' && this.hold !== 'stuck') return null
    if (this.stage !== 'travel' && this.stage !== 'linger') return null
    return last
  }

  update(dt: number): void {
    const { camera, captures, gesture, look, renderer } = this.ctx
    if (this.hold === 'off' || renderer.xr.isPresenting) return
    camera.getWorldPosition(this.head)
    if (!this.started) {
      this.started = true
      this.forward.set(0, 0, -1).applyQuaternion(camera.quaternion)
      this.center.copy(this.head).addScaledVector(this.forward, DRAW_DISTANCE)
      gesture.begin(this.center, this.head, WORLD_UP)
      this.start.copy(this.center)
      this.start.addScaledVector(gesture.rect.right, -0.16)
      this.start.addScaledVector(gesture.rect.up, -0.11)
      this.end.copy(this.center)
      this.end.addScaledVector(gesture.rect.right, 0.16)
      this.end.addScaledVector(gesture.rect.up, 0.11)
    }
    const cap = this.hold === 'draw' ? 0.72 : 1
    if (gesture.drawing && this.drawU < cap) this.drawU = Math.min(cap, this.drawU + dt * 0.4)
    if (gesture.drawing) {
      this.point.copy(this.start).lerp(this.end, this.drawU)
      gesture.span(this.start, this.point, this.head)
    }
    if (this.hold !== 'draw' && this.drawU >= 1 && gesture.drawing) {
      const wide = gesture.rect.halfW * 2 >= look.minSpan && gesture.rect.halfH * 2 >= look.minSpan
      gesture.end()
      if (wide) this.shutter.commit(this.hold === 'photo')
    }
    const last = captures[captures.length - 1]
    const popped = !!last && !last.flat && (last.pop > 0.92 || last.depth === 'model' || this.view.yaw > 0.02)
    if (this.hold === 'side' && popped) {
      this.view.yaw = approach(this.view.yaw, 0.78, dt * 0.7)
      this.view.pitch = approach(this.view.pitch, -0.14, dt * 0.45)
    }
    if (this.hold === 'play' || this.hold === 'rest' || this.hold === 'curl' || this.hold === 'detached' || this.hold === 'stuck') {
      this.playCurl(dt, last, popped)
    }
    if (this.hold === 'peel' || this.hold === 'open') {
      this.playPeel(dt, last, popped)
    }
  }

  private turnToSide(dt: number): void {
    this.view.yaw = approach(this.view.yaw, 0.52, dt * 0.65)
    this.view.pitch = approach(this.view.pitch, -0.1, dt * 0.4)
  }

  private playCurl(dt: number, last: Held | undefined, popped: boolean): void {
    if (!popped || !last || last.depth === 'wait' || last.flat) return
    if (last.mode === 'free' || last.mode === 'stuck') {
      if (this.hold === 'play' || this.hold === 'stuck') this.playStick(dt, last)
      return
    }
    const relief = last.mat.uniforms.uRelief.value as number
    if (relief < 0.9) return
    this.turnToSide(dt)
    if (this.hold === 'rest' || this.view.yaw < 0.36) return
    if (last.mode !== 'curl') this.stickers.armCorner(last)
    const goal = this.hold === 'curl' ? 0.42 : this.ctx.look.detach + 0.02
    last.curl = approach(last.curl, goal, dt * 0.22)
    last.curlV = 0
    last.holding = true
    if (this.hold !== 'curl' && last.curl >= this.ctx.look.detach) this.stickers.floatOff(last)
  }

  private playPeel(dt: number, last: Held | undefined, popped: boolean): void {
    if (!popped || !last || last.depth === 'wait') return
    const relief = last.mat.uniforms.uRelief.value as number
    if (relief < 0.9) return
    this.turnToSide(dt)
    if (this.hold === 'rest' || this.view.yaw < 0.36) return
    if (this.letGo) {
      last.holding = false
      return
    }
    const goal = this.hold === 'peel' ? 0.48 : 1
    this.peel = approach(this.peel, goal, dt * 0.42)
    setMode(last, 'sheets')
    last.curl = 0
    last.spread = smoothStep(this.peel)
    last.spreadV = 0
    last.holding = true
    if (this.hold === 'play' && this.peel > 0.98) {
      this.openFor += dt
      if (this.openFor > 1.15) this.letGo = true
    }
  }

  /** Let the frame melt, carry the sticker to the back wall, pause, and stick it. */
  private playStick(dt: number, held: Held): void {
    if (held.mode === 'stuck' || this.stage === 'done') return
    if (this.stage === 'idle') {
      this.stage = 'melt'
      this.clock = 0
    }
    if (this.stage === 'melt') {
      this.clock += dt
      if (this.clock < Math.max(0.45, this.ctx.look.dissolve)) return
      this.stage = 'travel'
      this.clock = 0
      held.photo.getWorldPosition(this.from)
      this.to.set(DESK_WALL.px - 0.92, 1.48, DESK_WALL.pz + DESK_WALL.nz * 0.03)
      return
    }
    if (this.stage === 'travel') {
      this.clock = Math.min(1, this.clock + dt / 1.7)
      this.pos.lerpVectors(this.from, this.to, smoothStep(this.clock))
      held.photo.getWorldQuaternion(this.quat)
      this.grip.adoptWorld(held.photo, this.pos, this.quat)
      if (this.clock >= 1) {
        this.stage = 'linger'
        this.clock = 0
      }
      return
    }
    if (this.stage === 'linger') {
      this.clock += dt
      if (this.clock < 0.85) return
      held.photo.getWorldPosition(this.pos)
      this.ctx.camera.getWorldPosition(this.head)
      const snap = nearestSurface(this.pos.x, this.pos.y, this.pos.z, DESK_SURFACES, this.ctx.look.snap, this.head.x, this.head.y, this.head.z)
      if (snap) this.stickers.stick(held, snap)
      this.stage = 'done'
    }
  }
}
