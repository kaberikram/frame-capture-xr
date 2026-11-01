import type { Texture, Vector2, Vector3 } from '@iwsdk/core'
import { REDUCE_MOTION, type Ctx } from '../app/context.js'
import { canPeel, setMode, type Held } from '../capture/held.js'
import { applyCurl } from '../look/relief.js'
import type { Grip } from './grip.js'
import { bindPeel, layoutPeel, spreadFromPull, springStep } from './peel.js'

/** The two-hand pull that fans a relief into depth sheets, and the spring that closes them. */
export class Sheets {
  constructor(
    private readonly ctx: Ctx,
    private readonly grip: Grip,
  ) {}

  begin(held: Held, at: Vector3): void {
    if (held.frameGone || held.mode === 'stuck') return
    if (!canPeel(held) && held.mode !== 'curl') return
    if (held.mode === 'free') return
    const grip = this.grip
    setMode(held, 'sheets')
    held.curl = 0
    held.curlV = 0
    held.holding = true
    held.spreadV = 0
    grip.touch = 'peel'
    grip.held = held
    grip.grabPinch.copy(at)
    grip.frameAxes(held)
    applyCurl(held.mat, null)
  }

  /** Hands: pull toward the head along the frame normal. */
  move(at: Vector3): void {
    const grip = this.grip
    const held = grip.held
    if (!held) return
    const pull = grip.local.copy(at).sub(grip.grabPinch).dot(grip.forward)
    held.spread = spreadFromPull(pull)
    held.spreadV = 0
  }

  step(held: Held, dt: number): void {
    if (held.mode !== 'sheets' || held.holding || (held.spread <= 0 && Math.abs(held.spreadV) <= 0.0001)) return
    const next = REDUCE_MOTION ? { spread: 0, velocity: 0 } : springStep(held.spread, held.spreadV, this.ctx.look.spring, dt)
    held.spread = next.spread
    held.spreadV = next.velocity
    if (held.spread === 0) setMode(held, 'idle')
  }

  /** Park the sheets under the relief, or fan them out. True while the frame is in sheet mode. */
  layout(held: Held): boolean {
    const look = this.ctx.look
    const mat = held.mat
    const sheets = held.mode === 'sheets' && !held.flat && !held.frameGone
    if (held.frameGone) return sheets
    const photo = mat.uniforms.uPhoto.value as Texture | null
    const depth = mat.uniforms.uDepth.value as Texture | null
    const texel = mat.uniforms.uTexel.value as Vector2
    bindPeel(held.peel, photo, depth, texel, look.feather, held.depth === 'wait' ? 0 : 1)
    layoutPeel(held.peel, {
      layers: look.layers,
      spread: sheets ? held.spread : 0,
      maxSpread: look.spread,
      relief: mat.uniforms.uRelief.value as number,
      depthAmt: Math.max(held.width, held.height) * look.relief,
      feather: look.feather,
    })
    return sheets
  }
}
