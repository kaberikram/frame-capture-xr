import { Vector3, type Object3D, type WebGLRenderer } from '@iwsdk/core'
import type { Ctx } from '../app/context.js'
import { REDUCE_MOTION } from '../app/context.js'
import type { Held } from '../capture/held.js'
import { WARP_MODES } from '../capture/time-mode.js'
import type { HandInput, Side } from '../input/hands.js'
import { TimeDial } from '../look/time-dial.js'
import type { TimeWarp } from '../look/time-glass.js'
import type { Grip } from './grip.js'
import {
  HOLD_SPAN,
  PLANE_NEAR,
  easeToward,
  flickCross,
  insideRect,
  onRim,
  palmShown,
  stretchScale,
} from './time-gestures.js'

/** How far the stack floats off the skin, and where it sits on the thumb side. */
const PALM_LIFT = 0.02
const THUMB_OUT = 0.052
const ALONG_FINGERS = 0.048
const FLICK_QUIET = 0.4
const FLICK_WAIT = 0.72
const STRETCH_TAU = 0.14

/**
 * Stretch, flick, and the palm menu. Stretch only changes how the glass looks.
 * A flick cycles the mode. The menu is the other way to choose one.
 */
export class TimePlay {
  stretching = false
  private baseSpan = 0
  private stretch = 1
  private quiet = 0
  private cooldown = 0
  private latched = false
  private shownSide: Side | null = null
  private readonly dial: TimeDial
  private readonly localA = new Vector3()
  private readonly localB = new Vector3()
  private readonly anchor = new Vector3()
  private readonly head = new Vector3()
  private readonly toward = new Vector3()
  private readonly target = new Vector3()
  private readonly prevZ = new Map<string, number>()

  constructor(
    private readonly ctx: Ctx,
    private readonly hands: HandInput,
    private readonly grip: Grip,
    private readonly warp: TimeWarp,
    parent: Object3D,
    renderer: WebGLRenderer,
  ) {
    this.dial = new TimeDial(parent, renderer)
  }

  /**
   * Both hands are pinching opposite rims of one idle frame.
   * The caller should skip the draw and the sheet fan.
   */
  claim(side: Side): boolean {
    if (this.stretching || this.ctx.gesture.drawing || this.grip.touch !== 'none') return false
    const mine = this.hands.pose[side]
    const other = this.hands.pose[side === 'left' ? 'right' : 'left']
    if (!mine.tracked || !other.tracked || !mine.pinching || !other.pinching) return false
    if (mine.pinch.distanceTo(other.pinch) < HOLD_SPAN) return false
    if (!this.rimFrame(mine.pinch, other.pinch)) return false
    this.stretching = true
    this.baseSpan = mine.pinch.distanceTo(other.pinch)
    this.latched = false
    this.dial.clearPoint()
    return true
  }

  /** This pinch is on a frame's rim, so it should wait for the other hand instead of drawing. */
  onFrameRim(side: Side): boolean {
    const pose = this.hands.pose[side]
    if (!pose.tracked) return false
    const frames = this.ctx.captures
    for (let i = frames.length - 1; i >= 0; i--) {
      const held = frames[i]
      if (held.frameGone || held.mode !== 'idle') continue
      if (!this.project(held, pose.pinch, this.localA)) continue
      if (onRim(this.localA.x, this.localA.y, held.width * 0.5, held.height * 0.5)) return true
    }
    return false
  }

  release(): void {
    this.stretching = false
  }

  step(dt: number): void {
    this.easeStretch(dt)
    this.flick(dt)
    this.palm()
    this.dial.step(dt)
  }

  dispose(): void {
    this.dial.dispose()
  }

  private easeStretch(dt: number): void {
    let goal = 1
    if (this.stretching) {
      const left = this.hands.pose.left
      const right = this.hands.pose.right
      if (left.tracked && right.tracked && left.pinching && right.pinching) {
        goal = stretchScale(this.baseSpan, left.pinch.distanceTo(right.pinch))
      } else this.stretching = false
    }
    this.stretch = easeToward(this.stretch, goal, dt, REDUCE_MOTION ? 0.001 : STRETCH_TAU)
    this.warp.stretch = this.stretch
  }

  private flick(dt: number): void {
    const busy = this.stretching || this.ctx.gesture.drawing || this.grip.touch !== 'none' || this.dial.pressing
    const pinching = this.hands.pose.left.pinching || this.hands.pose.right.pinching
    if (busy || pinching) this.quiet = FLICK_QUIET
    this.quiet = Math.max(0, this.quiet - dt)
    this.cooldown = Math.max(0, this.cooldown - dt)
    const frames = this.ctx.captures
    const sides: Side[] = ['left', 'right']
    let fired = false
    for (let s = 0; s < sides.length; s++) {
      const side = sides[s]
      const pose = this.hands.pose[side]
      for (let i = 0; i < frames.length; i++) {
        const held = frames[i]
        const key = `${side}:${held.token}`
        if (!pose.tracked || held.frameGone || held.mode !== 'idle') {
          this.prevZ.delete(key)
          continue
        }
        this.localA.copy(pose.index)
        held.group.worldToLocal(this.localA)
        const z = this.localA.z
        const prev = this.prevZ.get(key)
        this.prevZ.set(key, z)
        if (fired || this.quiet > 0 || this.cooldown > 0 || pose.pinching || prev === undefined) continue
        if (!flickCross(prev, z, dt)) continue
        if (!insideRect(this.localA.x, this.localA.y, held.width * 0.5, held.height * 0.5)) continue
        this.warp.cycle()
        this.cooldown = FLICK_WAIT
        fired = true
      }
    }
  }

  private palm(): void {
    if (this.stretching || this.ctx.gesture.drawing || this.grip.touch !== 'none') {
      this.shownSide = null
      this.dial.setHand(null, this.toward, this.toward)
      this.dial.clearPoint()
      return
    }
    const side = this.choosePalm()
    this.shownSide = side
    if (!side) {
      this.dial.setHand(null, this.toward, this.toward)
      this.dial.clearPoint()
      this.latched = false
      return
    }
    const pose = this.hands.pose[side]
    this.anchor
      .copy(pose.wrist)
      .addScaledVector(pose.palm, PALM_LIFT)
      .addScaledVector(pose.thumb, THUMB_OUT)
      .addScaledVector(pose.fingers, ALONG_FINGERS)
    this.dial.setHand(this.anchor, pose.palm, pose.fingers)
    const other = this.hands.pose[side === 'left' ? 'right' : 'left']
    if (!other.tracked || other.pinching || this.dial.pressing) {
      this.dial.clearPoint()
      return
    }
    const hit = this.dial.point(other.index)
    if (hit.touch && !this.latched) {
      this.latched = true
      const mode = WARP_MODES[hit.index]
      if (!mode) return
      const to = this.framePoint(this.target)
      this.dial.press(hit.index, to, () => this.warp.setMode(mode))
      return
    }
    if (hit.index < 0) this.latched = false
  }

  private choosePalm(): Side | null {
    this.ctx.player.head.getWorldPosition(this.head)
    const order: Side[] = this.shownSide
      ? [this.shownSide, this.shownSide === 'left' ? 'right' : 'left']
      : ['right', 'left']
    for (let i = 0; i < order.length; i++) {
      const side = order[i]
      const pose = this.hands.pose[side]
      if (!pose.tracked || pose.pinching || pose.palm.lengthSq() < 0.5) continue
      this.toward.copy(this.head).sub(pose.wrist)
      if (this.toward.lengthSq() < 1e-4) continue
      this.toward.normalize()
      if (palmShown(pose.palm.dot(this.toward), this.shownSide === side)) return side
    }
    return null
  }

  private framePoint(out: Vector3): Vector3 | null {
    const frames = this.ctx.captures
    for (let i = frames.length - 1; i >= 0; i--) {
      const held = frames[i]
      if (held.frameGone || held.mode !== 'idle') continue
      held.group.getWorldPosition(out)
      return out
    }
    return null
  }

  private rimFrame(a: Vector3, b: Vector3): Held | null {
    const frames = this.ctx.captures
    for (let i = frames.length - 1; i >= 0; i--) {
      const held = frames[i]
      if (held.frameGone || held.mode !== 'idle') continue
      if (!this.project(held, a, this.localA) || !this.project(held, b, this.localB)) continue
      const hw = held.width * 0.5
      const hh = held.height * 0.5
      if (!onRim(this.localA.x, this.localA.y, hw, hh) || !onRim(this.localB.x, this.localB.y, hw, hh)) continue
      return held
    }
    return null
  }

  private project(held: Held, world: Vector3, out: Vector3): boolean {
    out.copy(world)
    held.group.worldToLocal(out)
    return Math.abs(out.z) < PLANE_NEAR
  }
}
