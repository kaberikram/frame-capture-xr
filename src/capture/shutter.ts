import { Matrix4, Vector3 } from '@iwsdk/core'
import { MAX_CAPTURES, REDUCE_MOTION, type Ctx } from '../app/context.js'
import { metric } from '../debug/metrics.js'
import { applyPhoto, setDevelop } from '../look/relief.js'
import type { CameraRig } from './camera-rig.js'
import { insideQuad, quadMargin } from './clearance.js'
import { cropSize, type Quad } from './crop.js'
import { develop } from './darkroom.js'
import { developModelDepth } from './develop.js'
import { disposeHeld, makeHeld, type Held } from './held.js'
import { projectPixel } from './lens.js'

/** Long side of the cropped photo, in pixels. */
const CROP_LONG = 640
/** Longest the shutter waits for hands to leave the photo before it takes it anyway. */
const HANDS_PATIENCE = 1.2
/** After this long with a hand in the way, say so. */
const HANDS_NUDGE = 0.55
/** How long a frame waits for the camera to start. */
const CAMERA_PATIENCE = 8
/** Share of the frame's size around it where a fingertip still counts as in the photo. */
const HAND_MARGIN = 0.04
/** Seconds a camera frame must be exposed after the hands cleared. Covers frames stamped on arrival. */
const EXPOSE_AFTER = 0.03

/** Something that can list where the hands are, in world space. */
export interface JointSource {
  collectJoints(out: Vector3[]): number
}

interface PendingShot {
  held: Held
  since: number
  /** Page-clock seconds when the hands were first seen clear, or -1. */
  clearAt: number
  blockedFor: number
}

/**
 * Anchors a finished frame where it was drawn and photographs what it covers.
 * In a headset the photo waits until the hands have left the frame, so it
 * never catches the fingers that drew it.
 */
export class Shutter {
  /** The picture is being taken for this frame, now. */
  onExpose: ((held: Held) => void) | null = null
  private token = 0
  private readonly basis = new Matrix4()
  private readonly pending: PendingShot[] = []
  private readonly joints = Array.from({ length: 64 }, () => new Vector3())
  private readonly corners = [new Vector3(), new Vector3(), new Vector3(), new Vector3()]
  private readonly quad: Quad = { bl: { x: 0, y: 0 }, br: { x: 0, y: 0 }, tr: { x: 0, y: 0 }, tl: { x: 0, y: 0 } }
  private readonly px = { x: 0, y: 0 }

  constructor(
    private readonly ctx: Ctx,
    private readonly rig: CameraRig,
    private readonly note: (text: string, seconds?: number) => void,
  ) {}

  /** A hand has stayed in the photo long enough that the person should hear about it. */
  get waitingOnHands(): boolean {
    for (let i = 0; i < this.pending.length; i++) if (this.pending[i].blockedFor > HANDS_NUDGE) return true
    return false
  }

  /** True while a frame is anchored but its photo is not taken yet. */
  isPending(held: Held): boolean {
    for (let i = 0; i < this.pending.length; i++) if (this.pending[i].held === held) return true
    return false
  }

  /** Releasing the pinch (or the mouse) anchors the frame and takes the photo. */
  finishGesture(): void {
    const { gesture, look } = this.ctx
    const rect = gesture.rect
    const wide = rect.halfW * 2 >= look.minSpan && rect.halfH * 2 >= look.minSpan
    const result = gesture.drawing ? gesture.end() : 'cancel'
    if (result === 'commit' && wide) this.commit(false)
    else if (result === 'commit') this.note('Draw a larger frame')
  }

  /** `holdFlat` keeps the photo flat; the desk demo uses it to show the bare photo. */
  commit(holdFlat: boolean): void {
    const { captures, gesture, look, renderer, root } = this.ctx
    if (captures.length >= MAX_CAPTURES) {
      this.note('Sixteen frames is the limit for this session')
      return
    }
    const rect = gesture.rect
    const held = makeHeld(look, rect.halfW, rect.halfH, holdFlat, ++this.token)
    const group = held.group
    gesture.pose(group.position, group.quaternion, this.basis)
    root.add(group)
    captures.push(held)
    group.updateWorldMatrix(true, false)
    if (renderer.xr.isPresenting) {
      this.pending.push({ held, since: performance.now() / 1000, clearAt: -1, blockedFor: 0 })
      return
    }
    this.expose(held)
  }

  /** Headset: take each waiting photo once the camera runs and the hands are out of the frame. */
  step(now: number, hands: JointSource): void {
    if (this.pending.length === 0) return
    const feed = this.rig.feed
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const shot = this.pending[i]
      const waited = now - shot.since
      if (feed.width < 2) {
        if (waited <= CAMERA_PATIENCE && !this.rig.unavailable) continue
        const why = this.rig.problem ?? 'The camera did not start'
        console.info(`[frame] capture gave up waiting for the camera (${this.rig.state}): ${why}`)
        this.note(why, 6)
        this.pending.splice(i, 1)
        this.discard(shot.held)
        continue
      }
      const blocked = this.handsInFrame(shot.held, hands)
      const late = waited > HANDS_PATIENCE
      if (blocked && !late) {
        shot.clearAt = -1
        shot.blockedFor = waited
        continue
      }
      shot.blockedFor = 0
      if (shot.clearAt < 0) shot.clearAt = now
      // Use a camera frame exposed after the hands left, not one already in flight.
      const stamp = feed.stamp
      const exposed = stamp === null ? now - 0.07 : stamp - this.rig.lens.tau
      if (!late && exposed < shot.clearAt + EXPOSE_AFTER) continue
      if (blocked) console.info('[frame] capture taken with a hand still in the frame')
      metric('shutter waited', waited * 1000, ' ms')
      this.pending.splice(i, 1)
      this.expose(shot.held)
    }
  }

  /** The session ended: frames still waiting for their photo are dropped. */
  cancelPending(): void {
    for (let i = 0; i < this.pending.length; i++) this.discard(this.pending[i].held)
    this.pending.length = 0
  }

  /**
   * Take the picture now and develop it off the render thread: the darkroom
   * worker crops the frame's quad and makes brightness depth, then the photo
   * appears and the model is asked for real depth.
   */
  private expose(held: Held): void {
    const { captures, renderer } = this.ctx
    const quad = this.rig.projectGroup(held.group, held.width * 0.5, held.height * 0.5)
    const picture = quad ? this.rig.takePicture(quad) : null
    if (!quad || !picture) {
      this.missed(held)
      return
    }
    this.onExpose?.(held)
    const size = cropSize(held.width / held.height, CROP_LONG)
    const started = performance.now()
    let pictured = started
    void picture
      .then(({ source, quad: framed }) => {
        pictured = performance.now()
        return develop(source, framed, size.width, size.height)
      })
      .then((developed) => {
        if (!captures.includes(held)) return
        if (!developed) {
          this.missed(held)
          return
        }
        held.raster = developed.photo
        held.preview = developed.preview
        held.age = 0
        held.developT = 0
        applyPhoto(held.mat, developed.photo)
        // The photo develops out of a warm haze; a flat demo photo and reduced motion skip it.
        setDevelop(held.mat, held.flat || REDUCE_MOTION ? 1 : 0, 0, 0)
        held.photo.visible = true
        renderer.initTexture(held.mat.uniforms.uPhoto.value)
        const done = performance.now()
        metric('picture', pictured - started, ' ms')
        metric('darkroom', done - pictured, ' ms')
        console.info(
          `[frame] capture ${held.width.toFixed(2)}x${held.height.toFixed(2)}m ` +
            `picture ${Math.round(pictured - started)} ms, darkroom ${Math.round(done - pictured)} ms`,
        )
        if (held.flat) return
        developModelDepth(held, developed.photo)
      })
      .catch((error: unknown) => {
        console.warn('[frame] capture', error)
        if (captures.includes(held)) this.missed(held)
      })
  }

  /** The frame was not in the camera's view: say so and take the empty frame away. */
  private missed(held: Held): void {
    this.note('The frame is outside the camera')
    console.info('[frame] capture missed the camera')
    this.discard(held)
  }

  /** Is any hand joint (or the forearm behind it) inside the patch of camera image this frame covers? */
  private handsInFrame(held: Held, hands: JointSource): boolean {
    const count = hands.collectJoints(this.joints)
    if (count === 0) return false
    const clip = this.rig.currentClip()
    if (!clip) return false
    const hw = held.width * 0.5
    const hh = held.height * 0.5
    const local: readonly (readonly [number, number])[] = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ]
    const names = ['bl', 'br', 'tr', 'tl'] as const
    for (let i = 0; i < 4; i++) {
      const c = this.corners[i].set(local[i][0], local[i][1], 0)
      held.group.localToWorld(c)
      if (!projectPixel(clip.clip, c.x, c.y, c.z, clip.width, clip.height, this.px)) return false
      this.quad[names[i]].x = this.px.x
      this.quad[names[i]].y = this.px.y
    }
    const margin = quadMargin(this.quad, HAND_MARGIN)
    for (let i = 0; i < count; i++) {
      const j = this.joints[i]
      if (!projectPixel(clip.clip, j.x, j.y, j.z, clip.width, clip.height, this.px)) continue
      if (insideQuad(this.quad, this.px.x, this.px.y, margin)) return true
    }
    return false
  }

  private discard(held: Held): void {
    const captures = this.ctx.captures
    const at = captures.indexOf(held)
    if (at >= 0) captures.splice(at, 1)
    disposeHeld(held)
  }
}
