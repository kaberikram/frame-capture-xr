import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3 } from '@iwsdk/core'

interface Bit {
  mesh: Mesh
  drift: Vector3
}

/** The white frame, broken into a few short segments that drift and fade. */
export interface DissolveRig {
  group: Group
  age: number
  bits: Bit[]
}

/** Eight short pieces of the rectangle, in the frame's local XY. */
export function makeDissolve(halfW: number, halfH: number): DissolveRig {
  const group = new Group()
  group.name = 'frame-dissolve'
  const bits: Bit[] = []
  const spots: readonly (readonly [number, number, boolean])[] = [
    [-halfW * 0.42, halfH, true],
    [halfW * 0.42, halfH, true],
    [-halfW * 0.42, -halfH, true],
    [halfW * 0.42, -halfH, true],
    [halfW, halfH * 0.38, false],
    [halfW, -halfH * 0.38, false],
    [-halfW, halfH * 0.38, false],
    [-halfW, -halfH * 0.38, false],
  ]
  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i]
    const along = spot[2]
    const length = along ? Math.max(0.018, halfW * 0.42) : Math.max(0.018, halfH * 0.4)
    const thick = 0.0016
    const mesh = new Mesh(
      new BoxGeometry(along ? length : thick, along ? thick : length, thick),
      new MeshBasicMaterial({ color: 0xf6f3ec, transparent: true, opacity: 0.9, depthWrite: false }),
    )
    mesh.position.set(spot[0], spot[1], 0.004)
    mesh.renderOrder = 5
    mesh.frustumCulled = false
    const drift = new Vector3(spot[0], spot[1], 0)
    if (drift.lengthSq() > 1e-8) drift.setLength(0.028)
    drift.z += 0.01
    group.add(mesh)
    bits.push({ mesh, drift })
  }
  return { group, bits, age: 0 }
}

/** Advance the fade. True once the bits should be removed. */
export function stepDissolve(rig: DissolveRig, dt: number, duration: number): boolean {
  const dur = duration < 0.05 ? 0.05 : duration
  rig.age += dt
  const t = rig.age >= dur ? 1 : rig.age / dur
  const fade = 1 - t
  for (let i = 0; i < rig.bits.length; i++) {
    const bit = rig.bits[i]
    bit.mesh.position.addScaledVector(bit.drift, dt / dur)
    const mat = bit.mesh.material
    if (mat instanceof MeshBasicMaterial) mat.opacity = 0.9 * fade
  }
  return t >= 1
}

export function disposeDissolve(rig: DissolveRig): void {
  for (let i = 0; i < rig.bits.length; i++) {
    const bit = rig.bits[i]
    bit.mesh.geometry.dispose()
    const mat = bit.mesh.material
    if (mat instanceof MeshBasicMaterial) mat.dispose()
  }
  rig.group.removeFromParent()
}

/** A soft dark patch just behind a sticker that is sitting on a surface. */
export function makeContactShadow(width: number, height: number): Mesh {
  const mesh = new Mesh(
    new PlaneGeometry(width * 1.14, height * 1.14),
    new MeshBasicMaterial({ color: 0x1a1612, transparent: true, opacity: 0.24, depthWrite: false }),
  )
  mesh.name = 'contact-shadow'
  mesh.position.z = -0.008
  mesh.renderOrder = 3
  mesh.frustumCulled = false
  return mesh
}
