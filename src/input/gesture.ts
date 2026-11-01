import { Matrix4, Quaternion, Vector3 } from '@iwsdk/core'

export type HandId = 'a' | 'b'

export interface LiveRect {
  active: boolean
  valid: boolean
  center: Vector3
  right: Vector3
  up: Vector3
  normal: Vector3
  halfW: number
  halfH: number
}

const MIN_SHOW = 0.03

/**
 * A rectangle on a plane locked at the first pinch, facing the head and level
 * with the world. Each corner is the ray from the head through that hand, so
 * the corner stays under the finger. Two hands, or one hand dragged, both work.
 * The plane is not a wall.
 */
export class RectGesture {
  readonly rect: LiveRect = {
    active: false,
    valid: false,
    center: new Vector3(),
    right: new Vector3(),
    up: new Vector3(),
    normal: new Vector3(),
    halfW: 0,
    halfH: 0,
  }

  private locked = false
  private two = false
  private readonly planePoint = new Vector3()
  private readonly cornerA = new Vector3()
  private readonly cornerB = new Vector3()
  private readonly hit = new Vector3()
  private readonly tmp = new Vector3()
  private readonly ray = new Vector3()

  get drawing(): boolean {
    return this.locked
  }

  begin(point: Vector3, head: Vector3, worldUp: Vector3): void {
    this.planePoint.copy(point)
    this.face(head, worldUp)
    this.cornerA.copy(point)
    this.cornerB.copy(point)
    this.locked = true
    this.two = false
    this.publish()
  }

  /** Both corners at once. The desk demo uses this to grow a frame around one point. */
  span(first: Vector3, second: Vector3, head: Vector3): void {
    if (!this.locked) return
    this.place(first, head, this.cornerA)
    this.place(second, head, this.cornerB)
    this.publish()
  }

  /** Second pinch joins. Both corners are where the hands are now. */
  adopt(first: Vector3, second: Vector3, head: Vector3): void {
    if (!this.locked) return
    this.two = true
    this.place(first, head, this.cornerA)
    this.place(second, head, this.cornerB)
    this.publish()
  }

  move(hand: HandId, point: Vector3, head: Vector3): void {
    if (!this.locked) return
    if (!this.two) {
      if (hand === 'b') return
      this.place(point, head, this.cornerB)
    } else {
      this.place(point, head, hand === 'a' ? this.cornerA : this.cornerB)
    }
    this.publish()
  }

  end(): 'commit' | 'cancel' {
    const ok = this.rect.valid
    this.locked = false
    this.two = false
    this.rect.active = false
    return ok ? 'commit' : 'cancel'
  }

  cancel(): void {
    this.locked = false
    this.two = false
    this.rect.active = false
    this.rect.valid = false
  }

  /** Where a view ray meets the locked plane. */
  hitRay(origin: Vector3, dir: Vector3, out: Vector3): boolean {
    if (!this.locked) return false
    const denom = dir.dot(this.rect.normal)
    if (Math.abs(denom) < 1e-5) return false
    const t = this.tmp.copy(this.planePoint).sub(origin).dot(this.rect.normal) / denom
    if (t < 0.05) return false
    out.copy(origin).addScaledVector(dir, t)
    return true
  }

  pose(outPos: Vector3, outQuat: Quaternion, basis: Matrix4): void {
    outPos.copy(this.rect.center)
    basis.makeBasis(this.rect.right, this.rect.up, this.rect.normal)
    outQuat.setFromRotationMatrix(basis)
  }

  private place(point: Vector3, head: Vector3, out: Vector3): void {
    this.ray.copy(point).sub(head)
    const denom = this.ray.dot(this.rect.normal)
    if (Math.abs(denom) < 1e-5) {
      out.copy(point)
      return
    }
    const t = this.tmp.copy(this.planePoint).sub(head).dot(this.rect.normal) / denom
    if (t < 0.05) {
      out.copy(point)
      return
    }
    out.copy(head).addScaledVector(this.ray, t)
  }

  private face(head: Vector3, worldUp: Vector3): void {
    this.rect.normal.copy(head).sub(this.planePoint)
    if (this.rect.normal.lengthSq() < 1e-6) this.rect.normal.set(0, 0, 1)
    this.rect.normal.normalize()
    this.rect.right.crossVectors(worldUp, this.rect.normal)
    if (this.rect.right.lengthSq() < 0.04) this.rect.right.set(1, 0, 0)
    this.rect.right.normalize()
    this.rect.up.crossVectors(this.rect.normal, this.rect.right).normalize()
  }

  private publish(): void {
    const du = this.tmp.copy(this.cornerB).sub(this.cornerA).dot(this.rect.right)
    const dv = this.hit.copy(this.cornerB).sub(this.cornerA).dot(this.rect.up)
    this.rect.center.copy(this.cornerA)
    this.rect.center.addScaledVector(this.rect.right, du * 0.5)
    this.rect.center.addScaledVector(this.rect.up, dv * 0.5)
    this.rect.halfW = Math.abs(du) * 0.5
    this.rect.halfH = Math.abs(dv) * 0.5
    this.rect.active = true
    this.rect.valid = this.rect.halfW >= MIN_SHOW && this.rect.halfH >= MIN_SHOW
  }
}
