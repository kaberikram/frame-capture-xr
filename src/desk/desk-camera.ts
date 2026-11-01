import { Vector3, type PerspectiveCamera } from '@iwsdk/core'
import { clamp } from '../util/math.js'

/** The desk preview's view: an orbit around a point in the stand-in room. Right-drag turns it. */
export class DeskCamera {
  /** Offsets from the starting pose, in radians. The scripted demo eases these too. */
  yaw = 0
  pitch = 0
  orbiting = false
  private orbitLastX = 0
  private orbitLastY = 0
  private readonly focus = new Vector3(0, 1.4, -0.7)
  private readonly home = new Vector3()
  private radius = 1
  private baseYaw = 0
  private basePitch = 0
  private ready = false

  startOrbit(x: number, y: number): void {
    this.orbiting = true
    this.orbitLastX = x
    this.orbitLastY = y
  }

  orbitTo(x: number, y: number): void {
    this.yaw -= (x - this.orbitLastX) * 0.005
    this.pitch -= (y - this.orbitLastY) * 0.004
    this.pitch = clamp(this.pitch, -0.7, 0.55)
    this.orbitLastX = x
    this.orbitLastY = y
  }

  apply(camera: PerspectiveCamera): void {
    if (!this.ready) {
      camera.updateMatrixWorld()
      this.home.copy(camera.position).sub(this.focus)
      this.radius = Math.max(0.4, this.home.length())
      this.baseYaw = Math.atan2(this.home.x, this.home.z)
      this.basePitch = Math.asin(clamp(this.home.y / this.radius, -1, 1))
      this.ready = true
    }
    const yaw = this.baseYaw + this.yaw
    const pitch = clamp(this.basePitch + this.pitch, -0.8, 0.6)
    const r = this.radius
    const cp = Math.cos(pitch)
    camera.position.set(
      this.focus.x + r * Math.sin(yaw) * cp,
      this.focus.y + r * Math.sin(pitch),
      this.focus.z + r * Math.cos(yaw) * cp,
    )
    camera.lookAt(this.focus)
    camera.updateMatrixWorld()
  }
}
