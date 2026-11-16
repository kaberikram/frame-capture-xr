import { DIAL_MODES, WARP_MODES } from '../src/capture/time-mode.ts'
import { DROP, EDGE, KEEP, between, farther, mixedPixel, onEdge, sortReadings, transformPoint, viewFromDepth } from '../src/room/depth-project.ts'
import { MAX_CHUNKS, RoomField, surfacePoint, type DepthSample } from '../src/room/field.ts'
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

// A symmetric view 90 degrees wide and tall: the edge of the view is as far to the side as it is deep.
const projection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0]
const view = viewFromDepth(projection, 0.5, 0.5, 1)
assert(view !== null && Math.abs(view.z + 1) < 1e-6 && Math.abs(view.x) < 1e-6 && Math.abs(view.y) < 1e-6, `the middle of the view is straight ahead, got ${view?.x} ${view?.y} ${view?.z}`)
const corner = viewFromDepth(projection, 1, 0, 2)
assert(corner !== null && Math.abs(corner.x - 2) < 1e-6 && Math.abs(corner.y - 2) < 1e-6 && Math.abs(corner.z + 2) < 1e-6, 'the top right of the view is up and to the right, and depth is distance from the camera plane')
assert(viewFromDepth(projection, 0.5, 0.5, 0) === null && viewFromDepth(projection, 0.5, 0.5, 9) === null, 'a reading of nothing, or of too far, is dropped')
const world = view ? transformPoint([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1], view) : null
assert(world !== null && Math.abs(world.x - 2) < 1e-6 && Math.abs(world.z + 1) < 1e-6, 'the view pose carries the point into the room')

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

// The live mesh: smooth chunks that join without gaps and face the open side.
{
  const live = new RoomField(0.02, 300, 2)
  const rays = []
  // 676 readings, under the cap on one fuse.
  for (let y = 0; y < 26; y++) for (let x = 0; x < 26; x++) rays.push({ ox: 0, oy: 1, oz: 0, px: -0.375 + x * 0.03, py: 0.625 + y * 0.03, pz: -1.003 })
  for (let pass = 0; pass < 3; pass++) live.integrate(rays)
  const meshes = live.netStale(1000, { x: 0, y: 1, z: -1 }, 5)
  let tris = 0
  let area = 0
  let facing = 0
  for (const mesh of meshes) {
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t] * 3
      const b = mesh.indices[t + 1] * 3
      const c = mesh.indices[t + 2] * 3
      const p = mesh.positions
      const nz = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a])
      area += Math.abs(nz) / 2
      if (nz > 0) facing++
      tris++
      assert(Math.abs(p[a + 2] + 1.003) < 0.02, `the live mesh lies on the wall, got z ${p[a + 2]}`)
    }
  }
  assert(meshes.length > 4 && tris > 500, `a wall across several chunks is meshed (${meshes.length} chunks, ${tris} triangles)`)
  // All but the few that curl round the edge of what was seen.
  assert(facing > tris * 0.99, `the live mesh faces the eye, ${facing} of ${tris}`)
  // A 0.75 m square was seen; the mesh should cover nearly all of it, so the chunks join without gaps.
  assert(area > 0.75 * 0.75 * 0.93 && area < 0.85 * 0.85, `the chunks join into one sheet, area ${area.toFixed(3)}`)
  assert(live.netStale(1000, { x: 0, y: 1, z: -1 }, 5).length === 0, 'an unchanged field has nothing to re-mesh')
  // The same readings again change nothing: the field is an average, so it does not creep.
  live.integrate(rays.slice(0, 5))
  assert(live.netStale(1000, { x: 0, y: 1, z: -1 }, 5).length === 0, 'reading the same wall again has nothing to re-mesh')
  // Something set against one corner of the wall does change it.
  live.integrate(rays.slice(0, 5).map((r) => ({ ...r, pz: r.pz + 0.05 })))
  const again = live.netStale(1000, { x: 0, y: 1, z: -1 }, 5).length
  assert(again > 0 && again < meshes.length, `only the chunks that changed are meshed again (${again})`)
}
console.log('live mesh ok')

// A seeded random source, so the noisy tests below give the same numbers every run.
let randSeed = 1
function reseed(s: number): void {
  randSeed = s
}
function rand(): number {
  randSeed = (randSeed * 16807) % 2147483647
  return randSeed / 2147483647
}
function gauss(): number {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand())
}

// The field is a true average of what was read: a level table seen many times settles where it is,
// not on a voxel's middle with every voxel driven to ±1.
{
  reseed(4321)
  const table = new RoomField(0.02, 300, 2)
  const eye = { x: 0, y: 0.45, z: 0.4 }
  const readings = []
  for (let i = 0; i < 300; i++) readings.push({ ox: eye.x, oy: eye.y, oz: eye.z, px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0 })
  for (let pass = 0; pass < 400; pass++) {
    for (const r of readings) {
      r.px = (rand() - 0.5) * 0.3
      r.pz = (rand() - 0.5) * 0.3
      r.py = 0.013 + gauss() * 0.004
    }
    table.integrateRange(readings, 0, readings.length, true, 0.0005)
  }
  // The middle 10 by 10 columns, rows 0 and 1 up: voxel centres at y 0.01 and 0.03. The field keeps
  // only the last couple of dozen readings, so one column is noisy; their average is not.
  const n = 10
  const g = table.grid(-5, 0, -5, n, 2, n)
  let below = 0
  let above = 0
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      const a = g[i + k * 2 * n]
      const b = g[i + n + k * 2 * n]
      below += a / (n * n)
      above += b / (n * n)
      const crossing = 0.01 + (0.02 * a) / (a - b)
      assert(Math.abs(crossing - 0.013) < 0.005, `every column finds the table near where it is, got ${crossing.toFixed(4)}`)
    }
  }
  assert(below >= -0.2 && below <= 0, `just under the table reads a little behind it, got ${below}`)
  assert(above >= 0.4 && above <= 0.75, `just over the table reads in front of it, got ${above}`)
  const crossing = 0.01 + (0.02 * below) / (below - above)
  assert(Math.abs(crossing - 0.013) < 0.002, `the table is found where it is, at ${crossing.toFixed(4)} not 0.013`)
}
console.log('field average ok')

// Reading a grid of depth: the blur across a step, and the edges of things.
{
  assert(mixedPixel(0.65, 0.6, 0.7, 0.6, 0.7), 'a reading half way across a 10 cm step is blur')
  assert(mixedPixel(0.655, 0.602, 0.698, 0.597, 0.703), 'so is one with a little noise either side')
  assert(!mixedPixel(0.6, 0.6, 0.7, 0.6, 0.7) && !mixedPixel(0.7, 0.6, 0.7, 0.6, 0.7), 'the readings on either side of the step are not')
  // A slope seen with readings about 2 cm apart: each reading is a step further than the last.
  for (const degrees of [45, 75]) {
    const s = 0.021 * Math.tan((degrees * Math.PI) / 180)
    assert(!mixedPixel(0.6, 0.6 - s, 0.6 + s, 0.6 - 2 * s, 0.6 + 2 * s), `a reading on a ${degrees} degree slope is kept`)
  }
  for (let miss = 0; miss < 4; miss++) {
    const n = [0.6, 0.7, 0.6, 0.7]
    n[miss] = miss % 2 === 0 ? 0 : NaN
    assert(!mixedPixel(0.65, n[0], n[1], n[2], n[3]), 'without all four neighbours a reading is not called blur')
  }
  assert(!farther(0.6, 0) && !farther(0.6, NaN), 'a missing neighbour is never behind')
  assert(farther(0.6, 0.7), 'a neighbour 10 cm behind at 0.6 m is past an edge')
  // The gap is the one the readings' facing uses: under it, the two are one surface.
  assert(!farther(0.6, 0.65), 'a neighbour 5 cm behind at 0.6 m is the same surface')
  assert(!farther(0.6, 0.5), 'a neighbour in front is not behind')
  // A row of readings: the top of a box, then the table well behind it.
  const row = [0.6, 0.6, 0.6, 0.6, 0.74, 0.74, 0.74, 0.74]
  const edges = row.map((_, col) => onEdge(row, row.length, 1, col, 0))
  assert(edges.join() === 'false,false,true,true,false,false,false,false', `the last two readings before the jump are its edge, got ${edges.join()}`)
  const slope = row.map((_, col) => 0.5 + 0.05 * col)
  assert(slope.every((_, col) => !onEdge(slope, slope.length, 1, col, 0)), 'a slope that steps evenly has no edge')
  const dropout = [0.6, 0.6, 0, 0.6, 0.6, 0.6]
  assert(dropout.every((_, col) => !onEdge(dropout, dropout.length, 1, col, 0)), 'a reading that is missing does not make an edge')
  const column = [0.6, 0.6, 0.6, 0.74, 0.74]
  assert(onEdge(column, 1, column.length, 0, 2) && onEdge(column, 1, column.length, 0, 1) && !onEdge(column, 1, column.length, 0, 0), 'edges are found up and down the grid too')
  // A 12 cm step with its blurred reading half way across: each half is too small to be a jump, but the
  // blur is dropped, and the reading before it is still the step's near side.
  for (const mid of [0.62, 0.64, 0.66, 0.68, 0.7]) {
    const step = [0.6, 0.6, 0.6, mid, 0.72, 0.72, 0.72]
    const sorted = new Uint8Array(step.length)
    sortReadings(step, step.length, 1, sorted)
    assert(sorted[3] === DROP, `the blur at ${mid} across the step is dropped`)
    assert(sorted[2] === EDGE, `the reading before the blur at ${mid} is the step's near side, got ${sorted.join('')}`)
    assert(sorted[0] === KEEP && sorted[4] === KEEP && sorted[5] === KEEP && sorted[6] === KEEP, `the far side and the readings well clear are kept as they are, got ${sorted.join('')}`)
  }
  // A slope sorted the same way has neither blur nor edges.
  const slope2 = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]
  const sortedSlope = new Uint8Array(slope2.length)
  sortReadings(slope2, slope2.length, 1, sortedSlope)
  assert(sortedSlope.every((s) => s === KEEP), `a slope is kept whole, got ${sortedSlope.join('')}`)
}
console.log('depth edges ok')

// A box on a table, read the way a headset's close look reads it, fused with and without the
// edge marks and the blur filter. The far side was never seen; without the marks its top edge
// readings spread into the space behind it and the box comes out too big there.
{
  const TABLE = 0.75
  const BOX = { cx: -0.03, cz: -0.08, hx: 0.07, hz: 0.07, h: 0.08, yaw: (26 * Math.PI) / 180 }
  const cos = Math.cos(BOX.yaw)
  const sin = Math.sin(BOX.yaw)
  const eye = { x: 0.05, y: 1.32, z: 0.5 }
  const cast = (dx: number, dy: number, dz: number): number => {
    let t = Infinity
    if (dy < 0) {
      const tp = (TABLE - eye.y) / dy
      const x = eye.x + dx * tp
      const z = eye.z + dz * tp
      if (Math.abs(x) < 0.6 && z > -0.55 && z < 0.35) t = tp
    }
    // The box in its own frame.
    const o = [(eye.x - BOX.cx) * cos + (eye.z - BOX.cz) * sin, eye.y - TABLE - BOX.h / 2, -(eye.x - BOX.cx) * sin + (eye.z - BOX.cz) * cos]
    const d = [dx * cos + dz * sin, dy, -dx * sin + dz * cos]
    const half = [BOX.hx, BOX.h / 2, BOX.hz]
    let near = -Infinity
    let far = Infinity
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-9) {
        if (Math.abs(o[a]) > half[a]) return t
        continue
      }
      const t1 = (-half[a] - o[a]) / d[a]
      const t2 = (half[a] - o[a]) / d[a]
      near = Math.max(near, Math.min(t1, t2))
      far = Math.min(far, Math.max(t1, t2))
    }
    return near <= far && near > 0 && near < t ? near : t
  }
  const COLS = 40
  const ROWS = 30
  const aim = { x: BOX.cx - eye.x, y: TABLE + BOX.h - eye.y, z: BOX.cz - eye.z }
  const dist = Math.hypot(aim.x, aim.y, aim.z)
  const f = { x: aim.x / dist, y: aim.y / dist, z: aim.z / dist }
  const rl = Math.hypot(f.x, f.z)
  const r = { x: -f.z / rl, z: f.x / rl }
  const u = { x: -r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y }
  const m = new Float32Array(COLS * ROWS)
  const at = new Float32Array(COLS * ROWS * 3)
  const sorted = new Uint8Array(COLS * ROWS)
  // 40 by 30 readings over 0.84 by 0.6 m around the box, as fuseGrid turns them into samples.
  const look = (clean: boolean) => {
    const jx = rand()
    const jy = rand()
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const ax = ((col + jx) / COLS - 0.5) * 0.84
        const ay = ((row + jy) / ROWS - 0.5) * 0.6
        let dx = f.x * dist + r.x * ax + u.x * ay
        let dy = f.y * dist + u.y * ay
        let dz = f.z * dist + r.z * ax + u.z * ay
        const l = Math.hypot(dx, dy, dz)
        dx /= l
        dy /= l
        dz /= l
        const k = col + row * COLS
        let t = cast(dx, dy, dz)
        if (!Number.isFinite(t)) {
          m[k] = 0
          continue
        }
        // Near an edge a reading may land part way across it; every reading is a little off, and a few a lot.
        const beside = cast(dx + r.x * 0.012, dy, dz + r.z * 0.012)
        if (Number.isFinite(beside) && Math.abs(beside - t) > 0.03 && rand() < 0.5) t += (beside - t) * rand()
        t += gauss() * (0.006 + 0.006 * t)
        if (rand() < 0.02) t *= 0.85 + rand() * 0.3
        m[k] = t
        at[k * 3] = eye.x + dx * t
        at[k * 3 + 1] = eye.y + dy * t
        at[k * 3 + 2] = eye.z + dz * t
      }
    }
    const samples = []
    // Clean is the headset's own sorting; plain drops only the blur across a big step, and marks no edges.
    if (clean) sortReadings(m, COLS, ROWS, sorted)
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const k = col + row * COLS
        const d = m[k]
        if (!(d > 0)) continue
        if (clean && sorted[k] === DROP) continue
        if (!clean && col > 0 && col < COLS - 1 && between(d, m[k - 1], m[k + 1])) continue
        if (!clean && row > 0 && row < ROWS - 1 && between(d, m[k - COLS], m[k + COLS])) continue
        const x = at[k * 3]
        const y = at[k * 3 + 1]
        const z = at[k * 3 + 2]
        const sample: DepthSample = { ox: eye.x, oy: eye.y, oz: eye.z, px: x, py: y, pz: z }
        if (clean && sorted[k] === EDGE) sample.edge = true
        const side = col + 1 < COLS ? k + 1 : k - 1
        const up = row + 1 < ROWS ? k + COLS : k - COLS
        const gap = 0.04 + 0.06 * d
        if (m[side] > 0 && m[up] > 0 && Math.abs(m[side] - d) < gap && Math.abs(m[up] - d) < gap) {
          const ax = at[side * 3] - x
          const ay = at[side * 3 + 1] - y
          const az = at[side * 3 + 2] - z
          const bx = at[up * 3] - x
          const by = at[up * 3 + 1] - y
          const bz = at[up * 3 + 2] - z
          const nx = ay * bz - az * by
          const ny = az * bx - ax * bz
          const nz = ax * by - ay * bx
          const nl = Math.hypot(nx, ny, nz)
          if (nl > 1e-9) {
            sample.nx = nx / nl
            sample.ny = ny / nl
            sample.nz = nz / nl
          }
        }
        samples.push(sample)
      }
    }
    return samples
  }
  // How high the first solid going down a column stands over the table; 0 where there is none.
  const heightAt = (field: RoomField, x: number, z: number): number => {
    let prev: number | null = null
    for (let y = TABLE + 0.16; y > TABLE + 0.004; y -= 0.002) {
      const s = field.sdf(x, y, z)
      if (s !== null && s <= 0) return y - TABLE + (prev !== null && prev > 0 ? (0.002 * s) / (s - prev) : 0)
      prev = s
    }
    return 0
  }
  // How far past a side of the box its half-height outline reaches: the median over lines 1 cm apart along it.
  const overreach = (field: RoomField, nx: number, nz: number, half: number, length: number): number => {
    const reach: number[] = []
    for (let t = -length + 0.02; t <= length - 0.02 + 1e-9; t += 0.01) {
      for (let o = half - 0.03; o <= half + 0.1; o += 0.002) {
        if (heightAt(field, BOX.cx + nx * o - nz * t, BOX.cz + nz * o + nx * t) < BOX.h / 2) {
          reach.push(o - half)
          break
        }
      }
    }
    reach.sort((a, b) => a - b)
    return reach[reach.length >> 1]
  }
  const sides = [
    { nx: cos, nz: sin, half: BOX.hx, length: BOX.hz },
    { nx: -cos, nz: -sin, half: BOX.hx, length: BOX.hz },
    { nx: -sin, nz: cos, half: BOX.hz, length: BOX.hx },
    { nx: sin, nz: -cos, half: BOX.hz, length: BOX.hx },
  ]
  const ex = eye.x - BOX.cx
  const ez = eye.z - BOX.cz
  const farOver: number[] = []
  for (const clean of [false, true]) {
    reseed(12345)
    const field = new RoomField(0.02, 300, 2)
    for (let pass = 0; pass < 16; pass++) {
      const samples = look(clean)
      field.integrateRange(samples, 0, samples.length, true, 0.84 / dist / COLS)
    }
    const far: number[] = []
    for (const side of sides) {
      const over = overreach(field, side.nx, side.nz, side.half, side.length)
      // A side faces away when it turns its back on the eye.
      if (side.nx * ex + side.nz * ez < -0.2 * Math.hypot(ex, ez)) {
        far.push(over)
        if (!clean) continue
        const past = field.sdf(BOX.cx + side.nx * (side.half + 0.03), TABLE + BOX.h / 2, BOX.cz + side.nz * (side.half + 0.03))
        assert(past === null || past > 0, `3 cm past the far side, half way up, is not solid, got ${past}`)
      } else {
        assert(Math.abs(over) < 0.012, `a side that was seen stays where it is, got ${(over * 100).toFixed(1)} cm`)
      }
    }
    farOver.push(far.reduce((a, b) => a + b, 0) / far.length)
    if (clean) {
      // The top is still read all over: the edge marks only keep the readings at its rim from spreading.
      let found = 0
      let columns = 0
      for (let a = -BOX.hx + 0.01; a <= BOX.hx - 0.01 + 1e-9; a += 0.01) {
        for (let b = -BOX.hz + 0.01; b <= BOX.hz - 0.01 + 1e-9; b += 0.01) {
          columns++
          if (Math.abs(heightAt(field, BOX.cx + a * cos - b * sin, BOX.cz + a * sin + b * cos) - BOX.h) < 0.01) found++
        }
      }
      assert(found > columns * 0.9, `the top of the box is read across it, ${found} of ${columns}`)
    }
  }
  console.log(`far side overreach ${(farOver[0] * 100).toFixed(1)} cm plain, ${(farOver[1] * 100).toFixed(1)} cm with edge marks`)
  assert(farOver[1] <= farOver[0] * 0.5, 'marking the edges at least halves how far the box spreads past its far side')
}
console.log('edge splat ok')
