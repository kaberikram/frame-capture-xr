import { Quaternion, Vector3 } from '@iwsdk/core'
import type { Held } from '../capture/held.js'
import { clamp } from '../util/math.js'
import type { Grip } from './grip.js'

const X_AXIS = new Vector3(1, 0, 0)
const Y_AXIS = new Vector3(0, 1, 0)

/** The handle under a frame: drag to move it, and side to side or up and down to tilt it. */
export class FrameGrab {
  private readonly qYaw = new Quaternion()
  private readonly qPitch = new Quaternion()

  constructor(private readonly grip: Grip) {}

  begin(held: Held, at: Vector3): void {
    const grip = this.grip
    grip.touch = 'grab'
    grip.held = held
    grip.grabQuat.copy(held.group.quaternion)
    grip.grabPos.copy(held.group.position)
    grip.grabPinch.copy(at)
    grip.frameAxes(held)
  }

  move(at: Vector3): void {
    const grip = this.grip
    const held = grip.held
    if (!held) return
    const local = grip.local.copy(at).sub(grip.grabPinch)
    const yaw = clamp(local.dot(grip.grabRight) * 2.4, -0.7, 0.7)
    const pitch = clamp(local.dot(grip.grabUp) * 2.4, -0.5, 0.5)
    this.qYaw.setFromAxisAngle(Y_AXIS, yaw)
    this.qPitch.setFromAxisAngle(X_AXIS, pitch)
    const group = held.group
    group.quaternion.copy(grip.grabQuat).multiply(this.qYaw).multiply(this.qPitch)
    group.position.copy(grip.grabPos).add(at).sub(grip.grabPinch)
    group.updateWorldMatrix(true, false)
    // Keep the handle under the pinch after the tilt.
    local.copy(held.handle.position).applyMatrix4(group.matrixWorld)
    group.position.add(at).sub(local)
  }
}
