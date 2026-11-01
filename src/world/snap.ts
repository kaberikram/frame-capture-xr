import { Group, Matrix4, Quaternion, Vector3, type BufferAttribute } from '@iwsdk/core'
import type { Ctx } from '../app/context.js'
import type { Held } from '../capture/held.js'
import type { Grip } from '../interaction/grip.js'
import { makeBorder, writeBorder } from '../look/frame-border.js'
import { nearestSurface, stickBasis, type Snap, type Surface } from './surfaces.js'

/** The faint outline that shows where a held sticker will land. */
export class SnapPreview {
  readonly group = new Group()
  /** The surface a release would stick to, or null. */
  snap: Snap | null = null
  previewing = false
  private readonly positions: BufferAttribute
  private readonly local = new Vector3()
  private readonly head = new Vector3()
  private readonly xAxis = new Vector3()
  private readonly yAxis = new Vector3()
  private readonly zAxis = new Vector3()
  private readonly basis = new Matrix4()
  private readonly quat = new Quaternion()
  private readonly pos = new Vector3()

  constructor(
    private readonly ctx: Ctx,
    private readonly grip: Grip,
  ) {
    const ghost = makeBorder(0.004)
    const ghostMat = ghost.mesh.material
    if (!Array.isArray(ghostMat)) {
      ghostMat.opacity = 0.28
      ghostMat.transparent = true
      ghostMat.depthWrite = false
    }
    ghost.mesh.renderOrder = 7
    this.positions = ghost.positions
    this.group.name = 'snap-preview'
    this.group.add(ghost.mesh)
    this.group.visible = false
  }

  /** `held` is the sticker being carried, by a hand or the desk demo. */
  update(held: Held | null, surfaces: readonly Surface[]): void {
    this.clear()
    if (!held) return
    held.photo.updateWorldMatrix(true, false)
    held.photo.getWorldPosition(this.local)
    this.ctx.camera.getWorldPosition(this.head)
    const head = this.head
    const snap = nearestSurface(this.local.x, this.local.y, this.local.z, surfaces, this.ctx.look.snap, head.x, head.y, head.z)
    if (!snap) return
    this.snap = snap
    this.previewing = true
    this.group.visible = true
    writeBorder(this.positions, held.width * 0.5, held.height * 0.5, 0.004)
    const basis = stickBasis(snap.nx, snap.ny, snap.nz, head.x - snap.px, head.y - snap.py, head.z - snap.pz)
    this.xAxis.set(basis.xx, basis.xy, basis.xz)
    this.yAxis.set(basis.yx, basis.yy, basis.yz)
    this.zAxis.set(basis.zx, basis.zy, basis.zz)
    this.basis.makeBasis(this.xAxis, this.yAxis, this.zAxis)
    this.quat.setFromRotationMatrix(this.basis)
    this.pos.set(snap.px + snap.nx * 0.004, snap.py + snap.ny * 0.004, snap.pz + snap.nz * 0.004)
    this.grip.adoptWorld(this.group, this.pos, this.quat)
  }

  clear(): void {
    this.group.visible = false
    this.previewing = false
    this.snap = null
  }
}
