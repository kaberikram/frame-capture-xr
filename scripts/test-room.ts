import { DIAL_MODES, WARP_MODES } from '../src/capture/time-mode.ts'
import { transformPoint, viewFromDepthPixel } from '../src/room/depth-project.ts'
import { MAX_CHUNKS, RoomField, surfacePoint } from '../src/room/field.ts'
import { curlOffset, shouldStick, tangentBasis } from '../src/room/patch.ts'

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error(message)
}

const field = new RoomField()
const samples = []
for (let y = 0; y < 8; y++) {
  for (let x = 0; x < 8; x++) {
    samples.push({ ox: 0, oy: 0.8, oz: 0, px: 0.04 + x * 0.04, py: 0.64 + y * 0.04, pz: 1 })
  }
}
assert(field.integrate(samples) > 0, 'samples land in the volume')
field.integrate(samples)
const meshes = field.extract(8)
assert(field.chunkCount > 0, 'a wall creates chunks')
assert(meshes.some((mesh) => mesh.positions.length > 0), 'the wall extracts a mesh')
const hit = field.raycast(0.12, 0.72, 0.2, 0, 0, 1, 2)
assert(hit !== null && Math.abs(hit.z - 1) < 0.08, `a ray hits the wall near z=1, got ${hit?.z}`)
const beside = hit ? field.raycast(hit.x + 0.03, hit.y, 0.2, 0, 0, 1, 2, 0.05) : null
assert(beside !== null, 'a ray that skims a tile still meets the wall')
const before = field.sdf(0.12, 0.72, 0.97)
assert(before !== null && before > 0.15 && before < 0.6, `three centimetres in front of the wall reads as in front, got ${before}`)
const behind = field.sdf(0.12, 0.72, 1.02)
assert(behind !== null && behind < 0, `just behind the wall reads as behind, got ${behind}`)
assert(field.sdf(0.12, 0.72, 0.4) === null, 'open air nobody looked at closely is unknown')
const at = surfacePoint()
const marched = field.surfaceAlong(0.12, 0.72, 0.2, 0, 0, 1, 2, at)
assert(marched !== null && Math.abs(marched.z - 1) < 0.02, `a march finds the wall at z=1, got ${marched?.z}`)
assert(marched !== null && marched.nz < -0.9, `the wall faces back toward the camera, got nz ${marched?.nz}`)
assert(field.surfaceAlong(0.12, 0.72, 0.2, 0, 0, 1, 0.5, surfacePoint()) === null, 'a short march stops before the wall')
assert(field.surfaceAlong(0.12, 0.72, 0.2, 0, 1, 0, 2, surfacePoint()) === null, 'a march along the wall never meets it')
const touched = field.near(0.14, 0.74, 0.96, 0.08, surfacePoint())
assert(touched !== null && Math.abs(touched.z - 1) < 0.02 && touched.nz < -0.9, `a point near the wall snaps onto it, got ${touched?.z}`)
assert(field.near(0.14, 0.74, 0.5, 0.08, surfacePoint()) === null, 'a point in open air is near nothing')
const key = field.listChunks()[0]
assert(key, 'a chunk key exists')
const snap = key ? field.snapshot(key) : null
assert(snap !== null && snap.tsdf.length > 0 && snap.voxel === 0.04, 'a snapshot copies one chunk')
if (snap) snap.tsdf[0] = 7
const again = key ? field.snapshot(key) : null
assert(again !== null && again.tsdf[0] !== 7, 'editing a snapshot does not change the live field')
if (hit) {
  field.carve(hit.x, hit.y, hit.z, 0.12)
  field.extract(8)
  assert(field.closest(hit.x, hit.y, hit.z, 0.05) === null, 'carving lifts the surface out of the peel')
  assert(field.near(hit.x, hit.y, hit.z - 0.02, 0.08, surfacePoint()) === null, 'a carved place cannot be pinched')
  assert(field.surfaceAlong(hit.x, hit.y, 0.2, 0, 0, 1, 2, surfacePoint()) === null, 'a march passes through a carved place')
  field.integrate(samples)
  assert(field.near(hit.x, hit.y, hit.z - 0.02, 0.08, surfacePoint()) === null, 'new depth does not heal a carved place')
  field.heal(hit.x, hit.y, hit.z, 0.14)
  field.integrate(samples)
  field.integrate(samples)
  assert(field.near(hit.x, hit.y, hit.z - 0.02, 0.08, surfacePoint()) !== null, 'a healed place fills in again')
}

const flat = curlOffset(0, 0, 0)
assert(Math.abs(flat.z) < 1e-6, 'a flat sheet has no lift')
const curled = curlOffset(1, 0, 1)
assert(curled.z > 0.04, `a full curl lifts the far edge, got ${curled.z}`)
assert(!shouldStick({ x: 0, y: 0, z: 0 }, { x: 0.02, y: 0, z: 0 }, 0.09), 'releasing on the same spot does not stick')
assert(shouldStick({ x: 0, y: 0, z: 0 }, { x: 0.2, y: 0, z: 0 }, 0.09), 'a different nearby surface can take the sheet')
const basis = tangentBasis(0, 1, 0)
assert(Math.abs(Math.hypot(basis.tx, basis.ty, basis.tz) - 1) < 1e-6, 'the sheet tangent is a unit length')

const inverse = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, -1, 1]
const view = viewFromDepthPixel(inverse, 0, 0, 1)
assert(view !== null && Math.abs(view.z + 1) < 1e-6, `a depth pixel sits in front of the camera, got ${view?.z}`)
const world = view ? transformPoint([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1], view) : null
assert(world !== null && Math.abs(world.x - 2) < 1e-6, 'the view pose carries the point into the room')

const wide = new RoomField()
const crowded = []
for (let i = 0; i < MAX_CHUNKS + 40; i++) {
  const x = (i % 40) * 0.36
  const y = Math.floor(i / 40) * 0.36
  crowded.push({ ox: x, oy: y, oz: 0, px: x, py: y, pz: 0.5 })
}
wide.integrate(crowded)
assert(wide.chunkCount === MAX_CHUNKS, `one fuse stays within the chunk cap, got ${wide.chunkCount}`)
assert(wide.takeRetired().length === 0, 'chunks written this fuse are not thrown out')
const later = []
for (let i = 0; i < 6; i++) later.push({ ox: i * 0.4, oy: -3, oz: 0, px: i * 0.4, py: -3, pz: 0.5 })
wide.integrate(later)
const gone = wide.takeRetired()
assert(gone.length > 0 && wide.chunkCount <= MAX_CHUNKS, 'looking elsewhere retires old chunks')
wide.extract(1)

assert(DIAL_MODES.length === WARP_MODES.length && !DIAL_MODES.includes('peel' as never), 'the palm stack is only time effects; the peel has its own page')

console.log('room ok')
