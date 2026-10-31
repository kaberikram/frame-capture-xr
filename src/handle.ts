import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from '@iwsdk/core'
import { classifyHit as classifyPoint, type FrameHit } from './peel-math.js'

const HANDLE_W = 0.062
const HANDLE_H = 0.012
const HANDLE_D = 0.008

export type { FrameHit }

/** A small bar under the bottom edge. Local +Z points at the viewer. */
export function makeHandle(): Mesh {
  const mesh = new Mesh(
    new BoxGeometry(HANDLE_W, HANDLE_H, HANDLE_D),
    new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }),
  )
  mesh.name = 'handle'
  mesh.frustumCulled = false
  mesh.renderOrder = 6
  return mesh
}

export function placeHandle(mesh: Mesh, halfH: number, strip: number): void {
  mesh.position.set(0, -halfH - strip - HANDLE_H * 0.35, 0.006)
}

/** Local point on the frame plane. The handle wins over the photo along the bottom edge. */
export function classifyHit(local: Vector3, halfW: number, halfH: number, strip: number): FrameHit {
  return classifyPoint(local.x, local.y, halfW, halfH, strip)
}

/** Where a ray meets the capture's plane. Local +Z is the plane normal. */
export function hitPlane(group: Group, origin: Vector3, dir: Vector3, out: Vector3): boolean {
  group.updateWorldMatrix(true, false)
  const e = group.matrixWorld.elements
  const nx = e[8]
  const ny = e[9]
  const nz = e[10]
  const denom = dir.x * nx + dir.y * ny + dir.z * nz
  if (Math.abs(denom) < 1e-5) return false
  const px = e[12]
  const py = e[13]
  const pz = e[14]
  const t = ((px - origin.x) * nx + (py - origin.y) * ny + (pz - origin.z) * nz) / denom
  if (t < 0.02 || t > 12) return false
  out.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t)
  return true
}
