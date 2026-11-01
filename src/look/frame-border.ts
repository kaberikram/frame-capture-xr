import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial } from '@iwsdk/core'

const STRIP = 0.008
/** Sits a few millimetres in front of the photo so the rim wins the edge. */
const LIFT = 0.004

/** A thin white rectangle in the frame’s local XY plane. */
export function makeBorder(strip = STRIP): { mesh: Mesh; positions: BufferAttribute } {
  const geometry = new BufferGeometry()
  const positions = new BufferAttribute(new Float32Array(16 * 3), 3)
  geometry.setAttribute('position', positions)
  const index: number[] = []
  for (let s = 0; s < 4; s++) {
    const b = s * 4
    index.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  geometry.setIndex(index)
  const material = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.94,
    depthTest: true,
    depthWrite: false,
  })
  const mesh = new Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 4
  mesh.userData.strip = strip
  return { mesh, positions }
}

/** Four strips around a rectangle of half-size hw, hh. Local +Z is toward the viewer. */
export function writeBorder(positions: BufferAttribute, hw: number, hh: number, strip: number): void {
  const w = hw + strip
  const h = hh + strip
  const c = CORNERS
  c[0] = -w
  c[1] = -h
  c[2] = -hw
  c[3] = -h
  c[4] = -hw
  c[5] = h
  c[6] = -w
  c[7] = h
  c[8] = hw
  c[9] = -h
  c[10] = w
  c[11] = -h
  c[12] = w
  c[13] = h
  c[14] = hw
  c[15] = h
  c[16] = -hw
  c[17] = -h
  c[18] = hw
  c[19] = -h
  c[20] = hw
  c[21] = -hh
  c[22] = -hw
  c[23] = -hh
  c[24] = -hw
  c[25] = hh
  c[26] = hw
  c[27] = hh
  c[28] = hw
  c[29] = h
  c[30] = -hw
  c[31] = h
  const a = positions.array as Float32Array
  for (let i = 0; i < 16; i++) {
    a[i * 3] = c[i * 2]
    a[i * 3 + 1] = c[i * 2 + 1]
    a[i * 3 + 2] = LIFT
  }
  positions.needsUpdate = true
}

const CORNERS = new Float32Array(32)
