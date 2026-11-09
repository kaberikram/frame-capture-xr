import { Quaternion, Vector3 } from '@iwsdk/core'
import { WORLD_UP, type Ctx } from '../app/context.js'
import type { JointSource, Shutter } from '../capture/shutter.js'
import type { Grip } from '../interaction/grip.js'
import { routeHit, type Interaction } from '../interaction/router.js'
import type { Sheets } from '../interaction/sheets.js'
import type { TimePlay } from '../interaction/time-play.js'
import { OneEuro3, type Point3 } from './one-euro.js'
import { PinchTrail } from './pinch-trail.js'

export type Side = 'left' | 'right'

/** One hand, in world space, after this frame's joint poses. */
export interface HandSample {
  tracked: boolean
  pinching: boolean
  readonly pinch: Vector3
  readonly index: Vector3
  readonly wrist: Vector3
  readonly palm: Vector3
  readonly fingers: Vector3
  readonly thumb: Vector3
}

const SIDES: readonly Side[] = ['left', 'right']
/** Gap between the thumb and index fingertip surfaces, in metres, that starts a pinch. */
const GAP_ON = 0.004
/** Gap that ends it. The difference is hysteresis so a pinch does not flicker. */
const GAP_OFF = 0.015
/** Thumb and index tip radii together, when the runtime does not report them. */
const TIP_RADII = 0.016
/** How far back a release looks for the moment the fingers were tightest. */
const REWIND = 0.15
/** Points sampled back along the forearm from the wrist, metres. */
const FOREARM = [0.08, 0.16, 0.24] as const

/**
 * Pinches from tracked hands (or a system select). The first pinch either
 * grabs something under it or starts a frame; a second pinch joins as the
 * opposite corner, or fans a curl into depth sheets.
 *
 * Pinch points are smoothed with a One Euro filter, the pinch threshold
 * measures between fingertip surfaces so it suits any hand, and a release uses
 * where the fingers were tightest so opening them does not drag the corner.
 */
export class HandInput implements JointSource {
  /** Fingers met: the soundscape ticks here. */
  onPinch: ((at: Vector3) => void) | null = null
  /** Stretch, flick, and the palm menu. Set after both exist. */
  play: TimePlay | null = null
  private session: XRSession | null = null
  private now = 0
  private readonly selectHeld = { left: false, right: false }
  private readonly pinchWas = { left: false, right: false }
  private readonly tracked = { left: false, right: false }
  private readonly pinchGap = { left: 1, right: 1 }
  private readonly filters = { left: new OneEuro3(), right: new OneEuro3() }
  private readonly trails = { left: new PinchTrail(), right: new PinchTrail() }
  private readonly handA = new Vector3()
  private readonly handB = new Vector3()
  readonly pose: { left: HandSample; right: HandSample } = {
    left: sampleOf(this.handA),
    right: sampleOf(this.handB),
  }
  private readonly jointQ = new Quaternion()
  private readonly playerQ = new Quaternion()
  private readonly headPos = new Vector3()
  private readonly aimDir = new Vector3()
  private readonly rewound = new Vector3()
  private readonly raw = new Vector3()
  private readonly smooth: Point3 = { x: 0, y: 0, z: 0 }
  private readonly wrist = new Vector3()
  private readonly knuckle = new Vector3()
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
    for (let i = 0; i < SIDES.length; i++) {
      const side = SIDES[i]
      this.selectHeld[side] = false
      this.pinchWas[side] = false
      this.filters[side].reset()
      this.trails[side].clear()
    }
    this.primary = null
    this.dual = false
    this.waitClear = false
  }

  /** `now` is page-clock seconds. */
  update(now: number): void {
    this.now = now
    this.ctx.player.head.getWorldPosition(this.headPos)
    this.tracked.left = this.fillPinch('left')
    this.tracked.right = this.fillPinch('right')
    this.pose.left.pinching = this.isPinching('left')
    this.pose.right.pinching = this.isPinching('right')
    if (this.waitClear) {
      let still = false
      for (let i = 0; i < SIDES.length; i++) if (this.isPinching(SIDES[i])) still = true
      if (!still) this.waitClear = false
      for (let i = 0; i < SIDES.length; i++) this.pinchWas[SIDES[i]] = this.isPinching(SIDES[i])
      return
    }
    for (let i = 0; i < SIDES.length; i++) {
      const side = SIDES[i]
      const down = this.isPinching(side)
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

  /** How close each hand is to pinching, 0 open to 1 pinched, or -1 when it is not tracked. */
  readiness(side: Side): number {
    if (!this.tracked[side]) return -1
    const gap = this.pinchGap[side]
    if (gap <= GAP_ON) return 1
    const t = 1 - (gap - GAP_ON) / 0.05
    return t < 0 ? 0 : t
  }

  /** The smoothed pinch point of a hand, valid while `readiness` is not -1. */
  pinchPoint(side: Side): Vector3 {
    return this.point(side)
  }

  isPinched(side: Side): boolean {
    return this.pinchWas[side]
  }

  /** World positions of every tracked joint, plus points back along each forearm. */
  collectJoints(out: Vector3[]): number {
    const { world, input, player } = this.ctx
    const frame = world.xrFrame
    const space = world.xrReferenceSpace
    if (!frame || !space || !frame.getJointPose) return 0
    let n = 0
    for (let s = 0; s < SIDES.length; s++) {
      const side = SIDES[s]
      if (!input.xr.isPrimary('hand', side)) continue
      const hand = input.xr.getPrimaryInputSource(side)?.hand
      if (!hand) continue
      let haveWrist = false
      let haveKnuckle = false
      for (const joint of hand.values()) {
        if (n >= out.length) return n
        const pose = frame.getJointPose(joint, space)
        if (!pose) continue
        const p = pose.transform.position
        const v = out[n++].set(p.x, p.y, p.z).applyMatrix4(player.matrixWorld)
        if (joint.jointName === 'wrist') {
          this.wrist.copy(v)
          haveWrist = true
        } else if (joint.jointName === 'middle-finger-metacarpal') {
          this.knuckle.copy(v)
          haveKnuckle = true
        }
      }
      if (!haveWrist || !haveKnuckle) continue
      // The forearm continues back from the wrist, away from the knuckles.
      this.knuckle.sub(this.wrist)
      if (this.knuckle.lengthSq() < 1e-6) continue
      this.knuckle.normalize()
      for (let i = 0; i < FOREARM.length && n < out.length; i++) {
        out[n++].copy(this.wrist).addScaledVector(this.knuckle, -FOREARM[i])
      }
    }
    return n
  }

  dispose(): void {
    this.bind(null)
  }

  private point(side: Side): Vector3 {
    return side === 'left' ? this.handA : this.handB
  }

  /** The smoothed pinch point (midway between thumb and index tips) in world space, and the fingertip gap. */
  private fillPinch(side: Side): boolean {
    const { world, input, player } = this.ctx
    const frame = world.xrFrame
    const space = world.xrReferenceSpace
    const hand = frame && space && input.xr.isPrimary('hand', side) ? input.xr.getPrimaryInputSource(side)?.hand : undefined
    const thumb = hand?.get('thumb-tip')
    const index = hand?.get('index-finger-tip')
    const thumbPose = thumb && space ? frame?.getJointPose?.(thumb, space) : undefined
    const indexPose = index && space ? frame?.getJointPose?.(index, space) : undefined
    const pose = this.pose[side]
    if (!thumbPose || !indexPose) {
      pose.tracked = false
      pose.palm.set(0, 0, 0)
      pose.thumb.set(0, 0, 0)
      this.filters[side].reset()
      this.trails[side].clear()
      return false
    }
    const tp = thumbPose.transform.position
    const ip = indexPose.transform.position
    this.raw.set((tp.x + ip.x) * 0.5, (tp.y + ip.y) * 0.5, (tp.z + ip.z) * 0.5).applyMatrix4(player.matrixWorld)
    this.filters[side].filter(this.raw.x, this.raw.y, this.raw.z, this.now, this.smooth)
    const store = this.point(side)
    store.set(this.smooth.x, this.smooth.y, this.smooth.z)
    pose.tracked = true
    pose.index.set(ip.x, ip.y, ip.z).applyMatrix4(player.matrixWorld)
    const wristJoint = hand?.get('wrist')
    const wristPose = wristJoint && space ? frame?.getJointPose?.(wristJoint, space) : undefined
    if (wristPose) {
      const wp = wristPose.transform.position
      const o = wristPose.transform.orientation
      pose.wrist.set(wp.x, wp.y, wp.z).applyMatrix4(player.matrixWorld)
      this.jointQ.set(o.x, o.y, o.z, o.w)
      player.getWorldQuaternion(this.playerQ)
      pose.palm.set(0, -1, 0).applyQuaternion(this.jointQ).applyQuaternion(this.playerQ).normalize()
      pose.fingers.set(0, 0, -1).applyQuaternion(this.jointQ).applyQuaternion(this.playerQ).normalize()
      pose.thumb.set(1, 0, 0).applyQuaternion(this.jointQ).applyQuaternion(this.playerQ).normalize()
    } else {
      pose.palm.set(0, 0, 0)
      pose.thumb.set(0, 0, 0)
      pose.fingers.set(0, 0, -1)
    }
    const radii = (thumbPose.radius ?? 0) + (indexPose.radius ?? 0)
    const gap = Math.hypot(tp.x - ip.x, tp.y - ip.y, tp.z - ip.z) - (radii > 0.004 ? radii : TIP_RADII)
    this.pinchGap[side] = gap
    this.trails[side].push(this.now, store.x, store.y, store.z, gap)
    return true
  }

  private isPinching(side: Side): boolean {
    if (!this.tracked[side]) return this.selectHeld[side] && this.pinchWas[side]
    if (this.selectHeld[side]) return true
    return this.pinchGap[side] < (this.pinchWas[side] ? GAP_OFF : GAP_ON)
  }

  private otherPinching(side: Side): boolean {
    const other: Side = side === 'left' ? 'right' : 'left'
    return this.pinchWas[other] || this.selectHeld[other]
  }

  private began(side: Side): void {
    const at = this.point(side)
    const grip = this.grip
    const gesture = this.ctx.gesture
    this.onPinch?.(at)
    if (grip.touch === 'curl' && grip.held && side !== this.primary && grip.held.curl < 0.18) {
      this.sheets.begin(grip.held, at)
      return
    }
    if (grip.touch !== 'none') return
    if (!gesture.drawing) {
      if (this.play?.claim(side)) {
        this.primary = side
        return
      }
      if (!this.otherPinching(side) && this.play?.onFrameRim(side)) return
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
      this.interaction.begin(route, hit.held, grip.pickAt, at)
      return
    }
    if (side !== this.primary && this.primary && !this.dual) {
      this.dual = true
      gesture.adopt(this.point(this.primary), at, this.headPos)
    }
  }

  private moved(side: Side): void {
    if (this.play?.stretching) return
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
    if (this.grip.touch === 'none' && this.play?.stretching) {
      this.play.release()
      this.primary = null
      this.dual = false
      this.waitClear = true
      return
    }
    // Opening the fingers moved the point; go back to where they were tightest.
    const rewound = this.trails[side].rewind(this.now, REWIND, this.rewound)
    if (this.grip.touch !== 'none') {
      if (side !== this.primary) return
      if (rewound) this.interaction.move(this.rewound)
      this.interaction.end()
      return
    }
    const gesture = this.ctx.gesture
    if (!gesture.drawing) return
    if (side !== this.primary && !this.dual) return
    if (rewound) gesture.move(this.dual && side !== this.primary ? 'b' : 'a', this.rewound, this.headPos)
    this.primary = null
    this.dual = false
    this.waitClear = true
    this.shutter.finishGesture()
  }
}

function sampleOf(pinch: Vector3): HandSample {
  return {
    tracked: false,
    pinching: false,
    pinch,
    index: new Vector3(),
    wrist: new Vector3(),
    palm: new Vector3(),
    fingers: new Vector3(),
    thumb: new Vector3(),
  }
}
