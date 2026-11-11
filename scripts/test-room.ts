import { DIAL_MODES, WARP_MODES } from '../src/capture/time-mode.ts'
import { transformPoint, viewFromDepthPixel } from '../src/room/depth-project.ts'
import { MAX_CHUNKS, RoomField, surfacePoint } from '../src/room/field.ts'
import {
  PIECE_MAX,
  PIECE_MIN,
  PIECE_N,
  POP,
  RIM_LIFT,
  TACK,
  TEAR,
  basisKeeping,
  canLand,
  liftWeight,
  peelFate,
  pieceRadius,
  pullAmount,
  settleHeights,
  tangentBasis,
} from '../src/room/patch.ts'

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
assert(Math.abs(field.depthAlong(0.12, 0.72, 0.9, 0, 0, 1, 0.3) - 0.1) < 0.02, 'the depth along a ray is how far the wall is')
assert(field.depthAlong(0.12, 0.72, 0.9, 0, 0, -1, 0.3) === -1, 'looking away from the wall finds nothing')
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

assert(pullAmount(TACK * 0.9) === 0, 'the first bit of pull is tack and does nothing')
assert(Math.abs(pullAmount(POP) - 1) < 1e-9, 'a full pull is all the way')
assert(pieceRadius(0) === 0 && pieceRadius(TACK) <= PIECE_MIN + 1e-9, 'a pinch starts as a coin')
assert(pieceRadius(0.06) > pieceRadius(0.03) && pieceRadius(0.12) > pieceRadius(0.06), 'more pull is a larger piece')
assert(pieceRadius(0.06) - pieceRadius(0.03) > pieceRadius(0.17) - pieceRadius(0.14), 'the tear runs fast at first, then slows')
assert(Math.abs(pieceRadius(POP) - PIECE_MAX) < 1e-9 && pieceRadius(1) === PIECE_MAX, 'the piece stops growing at full size')
assert(Math.abs(pieceRadius(POP * 1.3, 1.3) - PIECE_MAX) < 1e-9, 'a scaled peel takes more pull for the same piece')
assert(peelFate(TEAR * 0.9) === 'settle', 'a small tug settles back')
assert(peelFate(TEAR * 1.1) === 'tear' && peelFate(POP * 0.99) === 'tear', 'letting go part way tears it free at that size')
assert(peelFate(POP) === 'pop', 'a full pull pops it free')
assert(Math.abs(liftWeight(0, 0.1, 0) - 1) < 1e-9, 'the pinch follows the hand')
assert(Math.abs(liftWeight(0.1, 0.1, 0) - RIM_LIFT) < 1e-9, 'the torn rim lifts a little')
assert(liftWeight(0.05, 0.1, 0) < 1 && liftWeight(0.05, 0.1, 0) > RIM_LIFT, 'between them the piece drapes')
assert(Math.abs(liftWeight(0.1, 0.1, 1) - 1) < 1e-9, 'a free piece moves as one')
const heights = new Float32Array(PIECE_N * PIECE_N).fill(NaN)
heights[12 + 12 * PIECE_N] = 0.02
settleHeights(heights)
assert(heights.every((v) => v === v && v > 0 && v <= 0.02 + 1e-6), 'unread heights fill in from what was read')
const none = new Float32Array(PIECE_N * PIECE_N).fill(NaN)
settleHeights(none)
assert(none.every((v) => v === 0), 'a surface nobody could read is flat')
assert(!canLand(0.02, 0.1, false), 'a piece does not land back on the spot it left')
assert(canLand(0.2, 0.1, false) && canLand(0.02, 0.1, true), 'somewhere else, or after a trip, it can')
const basis = tangentBasis(0, 0, 1)
assert(Math.abs(Math.hypot(basis.tx, basis.ty, basis.tz) - 1) < 1e-6, 'the piece tangent is a unit length')
assert(Math.abs(basis.tx - 1) < 1e-6 && Math.abs(basis.by - 1) < 1e-6, `on a wall, across is right and the other way is up, got ${basis.tx} ${basis.by}`)
const floor = tangentBasis(0, 1, 0)
assert(Math.abs(floor.tx * 0 + floor.ty * 1 + floor.tz * 0) < 1e-6 && Math.abs(Math.hypot(floor.bx, floor.by, floor.bz) - 1) < 1e-6, 'a table top has a basis too')
const kept = basisKeeping(0, 1, 0, 1, 0, 0)
assert(Math.abs(kept.tx - 1) < 1e-6, 'carried from a wall to a table, across stays across')
const lost = basisKeeping(1, 0, 0, 1, 0, 0)
assert(Math.abs(Math.hypot(lost.tx, lost.ty, lost.tz) - 1) < 1e-6, 'a surface facing along the old across still gets a basis')

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
