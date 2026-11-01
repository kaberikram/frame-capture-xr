import { Vector3, type Object3D } from '@iwsdk/core'
import type { Held, StickerMode } from '../capture/held.js'
import type { Soundscape } from './soundscape.js'

interface Seen {
  mode: StickerMode
  curl: number
  chimed: boolean
}

/**
 * Watches the captures and plays a sound when something happens to one: the
 * relief blooms, a corner peels, the sticker comes free or lands. Watching
 * state keeps sound out of the gesture code. The shutter is told directly,
 * because the moment it fires is not visible in the state.
 */
export class SoundCues {
  private readonly seen = new WeakMap<Held, Seen>()
  private readonly at = new Vector3()
  private readonly head = new Vector3()
  private readonly forward = new Vector3()
  private readonly up = new Vector3()

  constructor(private readonly sound: Soundscape) {}

  /** Put the listener where the head (or the desk camera) is. */
  listen(head: Object3D): void {
    if (!this.sound.enabled) return
    head.updateWorldMatrix(true, false)
    const e = head.matrixWorld.elements
    this.head.set(e[12], e[13], e[14])
    this.forward.set(-e[8], -e[9], -e[10]).normalize()
    this.up.set(e[4], e[5], e[6]).normalize()
    this.sound.listen(this.head, this.forward, this.up)
  }

  /** The shutter fired for this frame. */
  shutter(held: Held): void {
    if (this.sound.enabled) this.sound.shutter(this.center(held))
  }

  step(captures: readonly Held[], dt: number): void {
    if (!this.sound.enabled) return
    for (let i = 0; i < captures.length; i++) {
      const held = captures[i]
      let seen = this.seen.get(held)
      if (!seen) {
        seen = { mode: held.mode, curl: held.curl, chimed: false }
        this.seen.set(held, seen)
      }
      if (!seen.chimed && held.popping && held.reliefTo >= 1 && !held.flat) {
        seen.chimed = true
        this.sound.bloom(this.center(held))
      }
      if (held.mode === 'curl' && held.holding && dt > 0) {
        const speed = Math.max(0, held.curl - seen.curl) / dt
        this.sound.peel(this.corner(held), speed, dt)
      }
      if (held.mode !== seen.mode) {
        if (held.mode === 'free' && seen.mode === 'curl') this.sound.detach(this.corner(held))
        if (held.mode === 'stuck') this.sound.stick(this.center(held))
      }
      seen.mode = held.mode
      seen.curl = held.curl
    }
  }

  private center(held: Held): Vector3 {
    const object = held.frameGone || held.mode === 'free' || held.mode === 'stuck' ? held.photo : held.group
    return object.getWorldPosition(this.at)
  }

  private corner(held: Held): Vector3 {
    const object = held.frameGone || held.mode === 'free' || held.mode === 'stuck' ? held.photo : held.group
    this.at.set(held.cornerX, held.cornerY, 0)
    return object.localToWorld(this.at)
  }
}
