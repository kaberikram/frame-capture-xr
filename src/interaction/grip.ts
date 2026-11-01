import { Matrix4, Quaternion, Vector3, type Object3D } from '@iwsdk/core'
import { DRAW_DISTANCE, type Ctx } from '../app/context.js'
import type { Held } from '../capture/held.js'

export type Touch = 'none' | 'peel' | 'grab' | 'curl' | 'sticker'

/**
 * What the hand (or mouse) is holding and the frame it pulls against. One
 * instance is shared by every interaction, so a pull keeps the axes it started with.
 */
export class Grip {
  touch: Touch = 'none'
  held: Held | null = null
  grabDist = DRAW_DISTANCE
  /** The next desk move re-bases depth so a finished peel does not fling the sticker. */
  catchDepth = false
  /** Desk only: the pointer's screen y when a vertical drag started. */
  pointerY = 0
  readonly pickAt = new Vector3()
  readonly planeHit = new Vector3()
  readonly local = new Vector3()
  readonly aimDir = new Vector3()
  /** Frame normal (or camera forward on the desk fallback): the direction a pull is measured along. */
  readonly forward = new Vector3()
  readonly inward = new Vector3()
  readonly grabPinch = new Vector3()
  readonly grabPos = new Vector3()
  readonly grabQuat = new Quaternion()
  readonly grabRight = new Vector3()
  readonly grabUp = new Vector3()
  readonly headPos = new Vector3()
  private readonly parentQ = new Quaternion()
  private readonly worldMat = new Matrix4()
  private readonly localMat = new Matrix4()
  private readonly ones = new Vector3(1, 1, 1)

  constructor(private readonly ctx: Ctx) {}

  /** Right, up, and normal of whatever the held photo hangs from. */
  frameAxes(held: Held): void {
    const object = held.frameGone ? held.photo : held.group
    object.updateWorldMatrix(true, false)
    const e = object.matrixWorld.elements
    this.grabRight.set(e[0], e[1], e[2])
    this.grabUp.set(e[4], e[5], e[6])
    this.forward.set(e[8], e[9], e[10])
  }

  /** A world-space offset in the root's frame. */
  parentDelta(worldDelta: Vector3, out: Vector3): void {
    this.ctx.root.getWorldQuaternion(this.parentQ).invert()
    out.copy(worldDelta).applyQuaternion(this.parentQ)
  }

  /** Place a child of the root at a world pose. */
  adoptWorld(object: { position: Vector3; quaternion: Quaternion }, worldPos: Vector3, worldQuat: Quaternion): void {
    const root = this.ctx.root
    this.worldMat.compose(worldPos, worldQuat, this.ones)
    root.updateWorldMatrix(true, false)
    this.localMat.copy(root.matrixWorld).invert().multiply(this.worldMat)
    object.position.setFromMatrixPosition(this.localMat)
    object.quaternion.setFromRotationMatrix(this.localMat)
  }

  /** Move an object under the root without changing where it is in the world. */
  reparentToRoot(object: Object3D): void {
    const root = this.ctx.root
    object.updateWorldMatrix(true, false)
    this.worldMat.copy(object.matrixWorld)
    root.updateWorldMatrix(true, false)
    this.localMat.copy(root.matrixWorld).invert().multiply(this.worldMat)
    object.removeFromParent()
    root.add(object)
    object.position.setFromMatrixPosition(this.localMat)
    object.quaternion.setFromRotationMatrix(this.localMat)
    object.scale.setFromMatrixScale(this.localMat)
  }

  /** Slide a desk ray on a plane facing the camera, through the grab point. */
  dragOnView(origin: Vector3, dir: Vector3, out: Vector3): boolean {
    this.ctx.camera.getWorldDirection(this.forward)
    const denom = dir.dot(this.forward)
    if (Math.abs(denom) < 1e-5) return false
    const t = this.local.copy(this.grabPinch).sub(origin).dot(this.forward) / denom
    if (t < 0.02) return false
    out.copy(origin).addScaledVector(dir, t)
    return true
  }
}
