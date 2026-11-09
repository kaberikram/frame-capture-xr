import type { Vector3 } from '@iwsdk/core'
import type { Ctx } from '../app/context.js'
import { canPeel, type Held } from '../capture/held.js'
import type { TimeControls } from '../capture/time-mode.js'
import type { SnapPreview } from '../world/snap.js'
import type { FrameGrab } from './frame-grab.js'
import type { Grip } from './grip.js'
import { classifyHit, hitPlane, type FrameHit } from './handle.js'
import { CORNER_REACH } from './peel-math.js'
import type { Sheets } from './sheets.js'
import type { Stickers } from './stickers.js'

export interface Aim {
  held: Held
  kind: FrameHit | 'sticker'
}

/** What a new pinch or click does. */
export type Route = 'unstick' | 'ignore' | 'sticker' | 'grab' | 'sheets' | 'curl' | 'time' | 'draw'

/**
 * One decision for hands and mouse alike. `twoHanded` is a second pinch on the
 * desk's shift key: either way, a pull on the photo fans the depth sheets.
 */
export function routeHit(hit: Aim | null, twoHanded: boolean): Route {
  if (!hit) return 'draw'
  if (hit.kind === 'gem') return hit.held.mode === 'idle' && !hit.held.frameGone ? 'time' : 'ignore'
  if (hit.kind === 'corner' && hit.held.mode === 'stuck') return 'unstick'
  if (hit.kind === 'sticker' && hit.held.mode === 'stuck') return 'ignore'
  if (hit.kind === 'sticker') return 'sticker'
  if (hit.kind === 'handle') return 'grab'
  if ((hit.kind === 'photo' || hit.kind === 'corner') && twoHanded) return 'sheets'
  if (hit.kind === 'corner') return 'curl'
  if (hit.kind === 'photo') return 'ignore'
  return 'draw'
}

/** Finds what a ray points at and starts, moves, and ends a touch on it. */
export class Interaction {
  /** Called whenever a touch ends, so the hands can wait for both pinches to open. */
  onRelease: () => void = () => {}

  constructor(
    private readonly ctx: Ctx,
    private readonly grip: Grip,
    private readonly stickers: Stickers,
    private readonly sheets: Sheets,
    private readonly frameGrab: FrameGrab,
    private readonly snap: SnapPreview,
    private readonly time: TimeControls,
  ) {}

  get touching(): boolean {
    return this.grip.touch !== 'none'
  }

  /** `dir` is a direction, not a point. Hands pass pinch − head; the desk passes the camera ray. The hit lands in `grip.pickAt`. */
  aim(origin: Vector3, dir: Vector3): Aim | null {
    const grip = this.grip
    grip.aimDir.copy(dir)
    if (grip.aimDir.lengthSq() < 1e-8) return null
    grip.aimDir.normalize()
    const sticker = this.aimAtSticker(origin, grip.aimDir)
    if (sticker) return sticker
    const { captures, look } = this.ctx
    let best: Held | null = null
    let kind: FrameHit = 'miss'
    let bestT = 8
    for (let i = 0; i < captures.length; i++) {
      const held = captures[i]
      if (!hitPlane(held.group, origin, grip.aimDir, grip.planeHit)) continue
      const t = grip.planeHit.distanceTo(origin)
      if (t >= bestT) continue
      held.group.worldToLocal(grip.local.copy(grip.planeHit))
      const hit = classifyHit(grip.local, held.width * 0.5, held.height * 0.5, look.strip)
      if (hit === 'miss') continue
      if (held.frameGone) continue
      if (held.mode === 'free' && hit !== 'handle') continue
      if ((hit === 'photo' || hit === 'corner') && !canPeel(held)) continue
      best = held
      kind = hit
      bestT = t
      grip.pickAt.copy(grip.planeHit)
    }
    return best ? { held: best, kind } : null
  }

  /**
   * Start the touch a route names. 'draw' and 'ignore' are the caller's to handle.
   * `at` is the hit on the frame; `from` is where the pinch really is, which a peel is measured from.
   */
  begin(route: Route, held: Held, at: Vector3, from: Vector3 = at): void {
    switch (route) {
      case 'unstick':
        this.stickers.beginUnstick(held, at, from)
        return
      case 'sticker':
        this.stickers.beginSticker(held, at)
        return
      case 'grab':
        this.frameGrab.begin(held, at)
        return
      case 'sheets':
        this.sheets.begin(held, at)
        return
      case 'curl':
        this.stickers.beginCurl(held, at, from)
        return
      case 'time':
        this.grip.touch = 'time'
        this.grip.held = held
        held.group.worldToLocal(this.grip.local.copy(at))
        this.time.beginSlide(this.grip.local.x)
        return
      case 'ignore':
      case 'draw':
        return
      default: {
        const never: never = route
        return never
      }
    }
  }

  /** Hands: the pinch that owns the touch moved. */
  move(at: Vector3): void {
    switch (this.grip.touch) {
      case 'grab':
        this.frameGrab.move(at)
        return
      case 'sticker':
        this.stickers.moveSticker(at)
        return
      case 'curl':
        this.stickers.moveCurl(at)
        return
      case 'time': {
        const held = this.grip.held
        if (!held) return
        held.group.worldToLocal(this.grip.local.copy(at))
        this.time.slide(this.grip.local.x)
        return
      }
      case 'peel':
      case 'none':
        this.sheets.move(at)
        return
      default: {
        const never: never = this.grip.touch
        return never
      }
    }
  }

  /** Let go. A free sticker over a surface lands on it. */
  end(): void {
    const grip = this.grip
    const held = grip.held
    const snap = this.snap.snap
    if (grip.touch === 'time') this.time.finishSlide()
    if (grip.touch === 'sticker' && held && held.mode === 'free' && snap) this.stickers.stick(held, snap)
    if (held && held.mode !== 'stuck') held.holding = false
    grip.touch = 'none'
    grip.held = null
    this.onRelease()
  }

  /** A held sticker that touches the surface sticks without waiting for the release. */
  contact(): void {
    const grip = this.grip
    const held = grip.held
    const snap = this.snap.snap
    if (grip.touch !== 'sticker' || !held || held.mode !== 'free' || !snap) return
    const contact = Math.min(0.012, this.ctx.look.snap * 0.3)
    if (snap.distance > contact) return
    this.stickers.stick(held, snap)
    grip.touch = 'none'
    grip.held = null
    this.onRelease()
  }

  private aimAtSticker(origin: Vector3, dir: Vector3): { held: Held; kind: 'sticker' | 'corner' } | null {
    const grip = this.grip
    const captures = this.ctx.captures
    let best: Held | null = null
    let kind: 'sticker' | 'corner' = 'sticker'
    let bestT = 8
    for (let i = 0; i < captures.length; i++) {
      const held = captures[i]
      if (held.mode !== 'free' && held.mode !== 'stuck') continue
      if (!hitPlane(held.photo, origin, dir, grip.planeHit)) continue
      const t = grip.planeHit.distanceTo(origin)
      if (t >= bestT) continue
      held.photo.worldToLocal(grip.local.copy(grip.planeHit))
      if (Math.abs(grip.local.x) > held.width * 0.55 || Math.abs(grip.local.y) > held.height * 0.55) continue
      const dx = grip.local.x - held.cornerX
      const dy = grip.local.y - held.cornerY
      const onCorner = held.mode === 'stuck' && dx * dx + dy * dy <= CORNER_REACH * CORNER_REACH
      best = held
      kind = onCorner ? 'corner' : 'sticker'
      bestT = t
      grip.pickAt.copy(grip.planeHit)
    }
    return best ? { held: best, kind } : null
  }
}
