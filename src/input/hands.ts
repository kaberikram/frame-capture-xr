import { Vector3 } from '@iwsdk/core'
import { WORLD_UP, type Ctx } from '../app/context.js'
import type { Shutter } from '../capture/shutter.js'
import type { Grip } from '../interaction/grip.js'
import { routeHit, type Interaction } from '../interaction/router.js'
import type { Sheets } from '../interaction/sheets.js'

type Side = 'left' | 'right'

const SIDES: readonly Side[] = ['left', 'right']
/** Thumb-to-index distance, in metres, that starts a pinch. */
const PINCH_ON = 0.02
/** Distance that ends it. The gap is hysteresis so a pinch does not flicker. */
const PINCH_OFF = 0.032

/**
 * Pinches from tracked hands (or a system select). The first pinch either
 * grabs something under it or starts a frame; a second pinch joins as the
 * opposite corner, or fans a curl into depth sheets.
 */
export class HandInput {
  private session: XRSession | null = null
  private readonly selectHeld = { left: false, right: false }
  private readonly pinchWas = { left: false, right: false }
  private readonly pinchDist = { left: 0, right: 0 }
  private readonly handA = new Vector3()
  private readonly handB = new Vector3()
  private readonly headPos = new Vector3()
  private readonly aimDir = new Vector3()
  private primary: Side | null = null
  private dual = false
  /** After a frame or a touch ends, wait until every pinch opens before reading new ones. */
  private waitClear = false

  private readonly onSelectStart = (event: Event): void => {
    const side = (event as XRInputSourceEvent).inputSource?.handedness
    if (side === 'left' || side === 'right') this.selectHeld[side] = true
  }

  private readonly onSelectEnd = (event: Event): void => {
    const side = (event as XRInputSourceEvent).inputSource?.handedness
    if (side === 'left' || side === 'right') this.selectHeld[side] = false
  }

  constructor(
    private readonly ctx: Ctx,
    private readonly grip: Grip,
    private readonly interaction: Interaction,
    private readonly sheets: Sheets,
    private readonly shutter: Shutter,
  ) {
    interaction.onRelease = () => this.release()
  }

  /** A new session (or none): forget every pinch in flight. */
  bind(session: XRSession | null): void {
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
  }

  update(): void {
    this.ctx.player.head.getWorldPosition(this.headPos)
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
      if (down && !was) this.began(side)
      else if (down && was) this.moved(side)
      else if (!down && was) this.ended(side)
      this.pinchWas[side] = down
    }
  }

  /** A touch ended: no hand owns the gesture, and both pinches must open before the next. */
  release(): void {
    this.primary = null
    this.dual = false
    this.waitClear = true
  }

  dispose(): void {
    this.bind(null)
  }

  private point(side: Side): Vector3 {
    return side === 'left' ? this.handA : this.handB
  }

  /** The pinch point (midway between thumb and index tips) in world space. */
  private fillPinch(side: Side): boolean {
    const { world, input, player } = this.ctx
    const frame = world.xrFrame
    const space = world.xrReferenceSpace
    if (!frame || !space || !input.xr.isPrimary('hand', side)) return false
    const hand = input.xr.getPrimaryInputSource(side)?.hand
    if (!hand) return false
    const thumb = hand.get('thumb-tip')
    const index = hand.get('index-finger-tip')
    if (!thumb || !index) return false
    const thumbPose = frame.getJointPose?.(thumb, space)
    const indexPose = frame.getJointPose?.(index, space)
    if (!thumbPose || !indexPose) return false
    const tp = thumbPose.transform.position
    const ip = indexPose.transform.position
    const store = this.point(side)
    store.set((tp.x + ip.x) * 0.5, (tp.y + ip.y) * 0.5, (tp.z + ip.z) * 0.5)
    store.applyMatrix4(player.matrixWorld)
    this.pinchDist[side] = Math.hypot(tp.x - ip.x, tp.y - ip.y, tp.z - ip.z)
    return true
  }

  private isPinching(side: Side, tracked: boolean): boolean {
    if (!tracked) return this.selectHeld[side] && this.pinchWas[side]
    if (this.selectHeld[side]) return true
    return this.pinchDist[side] < (this.pinchWas[side] ? PINCH_OFF : PINCH_ON)
  }

  private otherPinching(side: Side): boolean {
    const other: Side = side === 'left' ? 'right' : 'left'
    return this.pinchWas[other] || this.selectHeld[other]
  }

  private began(side: Side): void {
    const at = this.point(side)
    const grip = this.grip
    const gesture = this.ctx.gesture
    if (grip.touch === 'curl' && grip.held && side !== this.primary && grip.held.curl < 0.18) {
      this.sheets.begin(grip.held, at)
      return
    }
    if (grip.touch !== 'none') return
    if (!gesture.drawing) {
      this.ctx.player.head.getWorldPosition(this.headPos)
      this.aimDir.copy(at).sub(this.headPos)
      const hit = this.interaction.aim(this.headPos, this.aimDir)
      const route = routeHit(hit, this.otherPinching(side))
      if (route === 'ignore') return
      this.primary = side
      if (route === 'draw' || !hit) {
        this.dual = false
        gesture.begin(at, this.headPos, WORLD_UP)
        return
      }
      this.interaction.begin(route, hit.held, grip.pickAt)
      return
    }
    if (side !== this.primary && this.primary && !this.dual) {
      this.dual = true
      gesture.adopt(this.point(this.primary), at, this.headPos)
    }
  }

  private moved(side: Side): void {
    const at = this.point(side)
    if (this.grip.touch !== 'none') {
      if (side !== this.primary) return
      this.interaction.move(at)
      return
    }
    const gesture = this.ctx.gesture
    if (!gesture.drawing || !this.primary) return
    if (!this.dual) {
      if (side === this.primary) gesture.move('a', at, this.headPos)
      return
    }
    gesture.move(side === this.primary ? 'a' : 'b', at, this.headPos)
  }

  private ended(side: Side): void {
    if (this.grip.touch !== 'none') {
      if (side !== this.primary) return
      this.interaction.end()
      return
    }
    if (!this.ctx.gesture.drawing) return
    if (side !== this.primary && !this.dual) return
    this.primary = null
    this.dual = false
    this.waitClear = true
    this.shutter.finishGesture()
  }
}
