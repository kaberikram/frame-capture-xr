import { Euler, Matrix4, Quaternion, Vector3 } from '@iwsdk/core'
import { LIFT_CURL, REDUCE_MOTION, STICK_GAP, type Ctx } from '../app/context.js'
import { canPeel, dropFrame, setMode, type Held } from '../capture/held.js'
import { makeContactRing, makeContactShadow } from '../look/contact.js'
import { motesEffect } from '../look/effects.js'
import { makeMotes } from '../look/motes.js'
import { PALETTE } from '../look/palette.js'
import { applyCurl, setReliefFloor, setShine } from '../look/relief.js'
import { clamp, easeOut } from '../util/math.js'
import { stickBasis, type Snap } from '../world/surfaces.js'
import type { Grip } from './grip.js'
import { hitPlane } from './handle.js'
import { axisExtent, curlFromPull, foldForPeel, nearestCorner, springStep, type CornerGrab } from './peel-math.js'

/**
 * The sticker story: curl a corner off the frame, come free, float in the
 * hand, stick to a surface, and peel off again.
 */
export class Stickers {
  private readonly xAxis = new Vector3()
  private readonly yAxis = new Vector3()
  private readonly zAxis = new Vector3()
  private readonly basis = new Matrix4()
  private readonly quat = new Quaternion()
  private readonly pos = new Vector3()
  private readonly framePos = new Vector3()
  private readonly prev = new Vector3()
  private readonly vel = new Vector3()
  private readonly axis = new Vector3()
  private readonly euler = new Euler()
  private readonly tiltQ = new Quaternion()

  constructor(
    private readonly ctx: Ctx,
    private readonly grip: Grip,
    /** Hide the landing outline once something has landed. */
    private readonly clearSnap: () => void,
  ) {}

  armCorner(held: Held, corner: CornerGrab | null = nearestCorner(held.width * 0.5, held.height * 0.5, held.width * 0.5, held.height * 0.5)): void {
    if (!corner) return
    setMode(held, 'curl')
    held.cornerX = corner.x
    held.cornerY = corner.y
    held.axisX = corner.axisX
    held.axisY = corner.axisY
  }

  beginCurl(held: Held, at: Vector3): void {
    if (!canPeel(held)) return
    const grip = this.grip
    const local = grip.local.copy(at)
    held.group.worldToLocal(local)
    const corner = nearestCorner(local.x, local.y, held.width * 0.5, held.height * 0.5)
    this.armCorner(held, corner)
    if (held.mode !== 'curl') return
    grip.touch = 'curl'
    grip.held = held
    held.holding = true
    held.curlV = 0
    grip.grabPinch.copy(at)
    grip.frameAxes(held)
    this.aimInward(held)
  }

  moveCurl(at: Vector3): void {
    const grip = this.grip
    const held = grip.held
    if (!held || held.mode === 'free') {
      this.moveSticker(at)
      return
    }
    const peeled = curlFromPull(this.pullAmount(at))
    held.curl = held.frameGone && peeled < LIFT_CURL ? LIFT_CURL : peeled
    held.curlV = 0
    if (held.curl >= this.ctx.look.detach) {
      if (held.frameGone) this.releaseFromWall(held, at)
      else this.detach(held, at)
      grip.touch = 'sticker'
      grip.catchDepth = true
    }
  }

  /** Desk: follow the pointer ray on the frame plane, or on a view plane once the frame is gone. */
  trackCurl(held: Held, origin: Vector3, dir: Vector3): void {
    const grip = this.grip
    if (held.mode === 'free') {
      if (grip.dragOnView(origin, dir, grip.pickAt)) this.moveSticker(grip.pickAt)
      return
    }
    const plane = held.frameGone ? held.photo : held.group
    if (!hitPlane(plane, origin, dir, grip.pickAt) && !grip.dragOnView(origin, dir, grip.pickAt)) return
    this.moveCurl(grip.pickAt)
  }

  beginSticker(held: Held, at: Vector3): void {
    const grip = this.grip
    grip.touch = 'sticker'
    grip.held = held
    held.holding = true
    held.bobT = 0
    grip.grabPinch.copy(at)
    grip.grabPos.copy(held.photo.position)
    this.ctx.camera.getWorldPosition(grip.headPos)
    grip.grabDist = Math.max(0.2, at.distanceTo(grip.headPos))
    grip.catchDepth = false
  }

  moveSticker(at: Vector3): void {
    const grip = this.grip
    const held = grip.held
    if (!held) return
    grip.local.copy(at).sub(grip.grabPinch)
    grip.parentDelta(grip.local, grip.aimDir)
    this.startFollow(held)
    held.follow.copy(grip.grabPos).add(grip.aimDir)
  }

  /** Desk: put the held sticker's center at a world point. */
  placeStickerCenter(worldPoint: Vector3): void {
    const grip = this.grip
    const held = grip.held
    if (!held) return
    held.photo.getWorldPosition(grip.local)
    grip.parentDelta(grip.planeHit.copy(worldPoint).sub(grip.local), grip.aimDir)
    this.startFollow(held)
    held.follow.copy(held.photo.position).add(grip.aimDir)
  }

  /** Lift the curled photo off the frame and leave it in the hand. */
  detach(held: Held, at: Vector3): void {
    if (held.mode === 'free') return
    const grip = this.grip
    const photo = held.photo
    grip.reparentToRoot(photo)
    photo.renderOrder = 8
    held.following = false
    setMode(held, 'free')
    held.curl = 1
    held.holding = true
    grip.frameAxes(held)
    const parked = grip.planeHit.copy(at).addScaledVector(grip.forward, 0.09)
    photo.updateWorldMatrix(true, false)
    grip.local.set(0, 0, 0).applyMatrix4(photo.matrixWorld)
    grip.parentDelta(grip.pickAt.copy(parked).sub(grip.local), grip.aimDir)
    photo.position.add(grip.aimDir)
    grip.grabPinch.copy(parked)
    grip.grabPos.copy(photo.position)
    this.ctx.camera.getWorldPosition(grip.headPos)
    grip.grabDist = Math.max(0.2, parked.distanceTo(grip.headPos))
    this.beginDissolve(held)
  }

  /** The desk demo lets the sticker go in front of the frame. */
  floatOff(held: Held): void {
    const grip = this.grip
    grip.frameAxes(held)
    grip.inward.copy(grip.grabRight).multiplyScalar(-held.axisX).addScaledVector(grip.grabUp, -held.axisY)
    held.group.updateWorldMatrix(true, false)
    grip.pickAt.set(0, 0, 0).applyMatrix4(held.group.matrixWorld)
    grip.pickAt.addScaledVector(grip.forward, 0.22)
    grip.pickAt.addScaledVector(grip.inward, 0.05)
    this.detach(held, grip.pickAt)
  }

  /** Pinch the lifted corner and peel a stuck sticker back into the hand. */
  beginUnstick(held: Held, at: Vector3): void {
    if (held.mode !== 'stuck') return
    const grip = this.grip
    setMode(held, 'curl')
    held.holding = true
    held.curlV = 0
    grip.touch = 'curl'
    grip.held = held
    grip.grabPinch.copy(at)
    grip.frameAxes(held)
    this.aimInward(held)
  }

  /** The sticker leaves the wall and stays in the pinch. The frame is already gone. */
  releaseFromWall(held: Held, at: Vector3): void {
    const grip = this.grip
    held.following = false
    setMode(held, 'free')
    held.curl = 1
    held.holding = true
    held.photo.scale.set(1, 1, 1)
    held.squishT = 1
    if (held.shadow) held.shadow.visible = false
    grip.frameAxes(held)
    const parked = grip.planeHit.copy(at).addScaledVector(grip.forward, 0.06)
    held.photo.getWorldPosition(grip.local)
    grip.parentDelta(grip.pickAt.copy(parked).sub(grip.local), grip.aimDir)
    held.photo.position.add(grip.aimDir)
    grip.grabPinch.copy(parked)
    grip.grabPos.copy(held.photo.position)
    this.ctx.camera.getWorldPosition(grip.headPos)
    grip.grabDist = Math.max(0.2, parked.distanceTo(grip.headPos))
  }

  /** Flatten onto a surface: face its normal, sit just off it, squish, and cast a contact shadow. */
  stick(held: Held, snap: Snap): void {
    if (held.mode === 'stuck') return
    const grip = this.grip
    this.ctx.camera.getWorldPosition(grip.headPos)
    const head = grip.headPos
    const basis = stickBasis(snap.nx, snap.ny, snap.nz, head.x - snap.px, head.y - snap.py, head.z - snap.pz)
    this.xAxis.set(basis.xx, basis.xy, basis.xz)
    this.yAxis.set(basis.yx, basis.yy, basis.yz)
    this.zAxis.set(basis.zx, basis.zy, basis.zz)
    this.basis.makeBasis(this.xAxis, this.yAxis, this.zAxis)
    this.quat.setFromRotationMatrix(this.basis)
    this.pos.set(snap.px + snap.nx * STICK_GAP, snap.py + snap.ny * STICK_GAP, snap.pz + snap.nz * STICK_GAP)
    held.following = false
    grip.adoptWorld(held.photo, this.pos, this.quat)
    setMode(held, 'stuck')
    held.curl = LIFT_CURL
    held.holding = false
    held.curlV = 0
    held.squishT = REDUCE_MOTION ? 1 : 0
    held.photo.scale.setScalar(REDUCE_MOTION ? 1 : this.ctx.look.squish)
    if (!held.shadow) {
      held.shadow = makeContactShadow(held.width, held.height, PALETTE)
      held.photo.add(held.shadow)
    }
    held.shadow.visible = true
    if (!REDUCE_MOTION) {
      // A ring of warm light spreads where it lands.
      const ring = makeContactRing(held.width, held.height, PALETTE)
      held.photo.add(ring.group)
      this.ctx.effects.push(ring)
    }
    this.clearSnap()
  }

  /** Curl spring back to the frame (or to the lifted corner on a wall), and the contact squish. */
  step(held: Held, dt: number): void {
    this.live(held, dt)
    const spring = this.ctx.look.spring
    if (held.mode === 'curl' && !held.holding && held.frameGone) {
      const target = LIFT_CURL
      const next = REDUCE_MOTION ? { spread: 0, velocity: 0 } : springStep(held.curl - target, held.curlV, spring, dt)
      held.curl = target + next.spread
      held.curlV = next.velocity
      if (next.spread === 0) {
        held.curl = target
        setMode(held, 'stuck')
      }
    } else if (held.mode === 'curl' && !held.holding && (held.curl > 0 || Math.abs(held.curlV) > 0.0001)) {
      const next = REDUCE_MOTION ? { spread: 0, velocity: 0 } : springStep(held.curl, held.curlV, spring, dt)
      held.curl = next.spread
      held.curlV = next.velocity
      if (held.curl === 0) setMode(held, 'idle')
    }
    if (held.mode === 'stuck' && held.squishT < 1) {
      held.squishT = REDUCE_MOTION ? 1 : Math.min(1, held.squishT + dt / 0.28)
      const squish = this.ctx.look.squish
      held.photo.scale.setScalar(squish + (1 - squish) * easeOut(held.squishT))
    }
  }

  /** Bend the relief to match the mode: a page curl, a soft free curve, or a lifted corner on a wall. */
  layout(held: Held): void {
    const look = this.ctx.look
    setReliefFloor(held.mat, held.mode === 'stuck' ? -0.004 : -10)
    setShine(held.mat, held.mode === 'curl' ? 0.2 + 0.6 * held.curl : held.mode === 'free' ? 0.55 : held.mode === 'stuck' ? 0.4 : 0.08)
    if (held.mode !== 'curl' && held.mode !== 'free' && held.mode !== 'stuck') {
      applyCurl(held.mat, null)
      return
    }
    const extent = axisExtent(held.width * 0.5, held.height * 0.5, held.axisX, held.axisY)
    if (held.mode === 'free') {
      applyCurl(held.mat, { axisX: held.axisX, axisY: held.axisY, fold: -extent, radius: Math.max(1.15, look.curl * 16), shadow: 0 })
      return
    }
    if (held.mode === 'stuck') {
      applyCurl(held.mat, {
        axisX: held.axisX,
        axisY: held.axisY,
        fold: foldForPeel(LIFT_CURL, extent),
        radius: Math.max(0.05, look.curl),
        shadow: 0.35,
        clear: 0.012,
      })
      return
    }
    if (held.curl <= 0.001) {
      applyCurl(held.mat, null)
      return
    }
    applyCurl(held.mat, {
      axisX: held.axisX,
      axisY: held.axisY,
      fold: foldForPeel(held.curl, extent),
      radius: Math.max(0.02, look.curl),
      shadow: held.frameGone ? 0.35 : 1,
      clear: held.frameGone ? 0.012 : 0.028,
    })
  }

  /** A pull counts toward the head and toward the photo's center. */
  private pullAmount(at: Vector3): number {
    const grip = this.grip
    grip.local.copy(at).sub(grip.grabPinch)
    const toward = Math.max(0, grip.local.dot(grip.forward))
    const inward = Math.max(0, grip.local.dot(grip.inward))
    return toward + inward
  }

  private aimInward(held: Held): void {
    const grip = this.grip
    grip.inward.copy(grip.grabRight).multiplyScalar(-held.axisX).addScaledVector(grip.grabUp, -held.axisY)
    if (grip.inward.lengthSq() > 1e-6) grip.inward.normalize()
  }

  /** From here the photo trails its target on a short lag, like paper in the hand. */
  private startFollow(held: Held): void {
    if (held.following) return
    held.following = true
    held.follow.copy(held.photo.position)
    held.baseQuat.copy(held.photo.quaternion)
    held.tilt.set(0, 0)
  }

  /**
   * A carried sticker follows the hand a beat behind and tilts with its
   * motion. Let go in open air, it bobs gently where it was left.
   */
  private live(held: Held, dt: number): void {
    if (held.mode !== 'free' || !held.following || dt <= 0) return
    const photo = held.photo
    this.prev.copy(photo.position)
    if (!held.holding) held.bobT += dt
    const settle = Math.min(1, held.bobT / 0.6)
    const bob = REDUCE_MOTION || held.holding ? 0 : 0.004 * Math.sin(2 * Math.PI * 0.25 * held.bobT) * settle
    this.pos.copy(held.follow)
    this.pos.y += bob
    photo.position.lerp(this.pos, REDUCE_MOTION ? 1 : 1 - Math.exp(-dt / 0.06))
    if (REDUCE_MOTION) {
      photo.quaternion.copy(held.baseQuat)
      return
    }
    this.vel.copy(photo.position).sub(this.prev).divideScalar(dt)
    const right = this.axis.set(1, 0, 0).applyQuaternion(held.baseQuat)
    const yaw = clamp(-this.vel.dot(right) * 0.35, -0.12, 0.12)
    const up = right.set(0, 1, 0).applyQuaternion(held.baseQuat)
    const sway = held.holding ? 0 : 0.02 * Math.sin(held.bobT * 1.3) * settle
    const pitch = clamp(this.vel.dot(up) * 0.35, -0.12, 0.12) + sway
    const k = 1 - Math.exp(-dt / 0.12)
    held.tilt.x += (pitch - held.tilt.x) * k
    held.tilt.y += (yaw - held.tilt.y) * k
    this.tiltQ.setFromEuler(this.euler.set(held.tilt.x, held.tilt.y, 0))
    photo.quaternion.copy(held.baseQuat).multiply(this.tiltQ)
  }

  /** Pixels per metre at one metre, so motes keep their size at any distance. */
  private pixelScale(): number {
    const { camera, renderer } = this.ctx
    if (renderer.xr.isPresenting) return 760
    return renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360))
  }

  private beginDissolve(held: Held): void {
    if (held.frameGone) return
    held.group.updateWorldMatrix(true, false)
    if (!REDUCE_MOTION) {
      // The empty frame lets go as warm dust drifting up.
      const rig = makeMotes(held.width * 0.5, held.height * 0.5, PALETTE, this.pixelScale())
      this.ctx.root.add(rig.group)
      this.framePos.setFromMatrixPosition(held.group.matrixWorld)
      this.quat.setFromRotationMatrix(held.group.matrixWorld)
      this.grip.adoptWorld(rig.group, this.framePos, this.quat)
      this.ctx.effects.push(motesEffect(rig))
    }
    dropFrame(held)
  }
}
