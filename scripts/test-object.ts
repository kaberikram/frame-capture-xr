import { focusRect, viewFromDepth } from '../src/room/depth-project.ts'
import { RoomField, surfacePoint } from '../src/room/field.ts'
import { liftShell, pickShell, PIECE_REACH, type FieldBlock } from '../src/room/object.ts'

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error(message)
}

/** A made-up room: a distance in metres at any point, seen only near its surfaces, as depth sees it. */
function room(voxel: number, dist: (x: number, y: number, z: number) => number): FieldBlock {
  const trunc = voxel * 2
  return {
    voxel,
    grid(x0, y0, z0, nx, ny, nz) {
      const out = new Float32Array(nx * ny * nz)
      for (let k = 0; k < nz; k++) {
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            const d = dist((x0 + i + 0.5) * voxel, (y0 + j + 0.5) * voxel, (z0 + k + 0.5) * voxel) / trunc
            out[i + j * nx + k * nx * ny] = d > 1 ? NaN : d < -0.6 ? NaN : d
          }
        }
      }
      return out
    },
  }
}

const eye = { x: 0, y: 1.5, z: 1.2 }
const ball = (x: number, y: number, z: number) => Math.hypot(x, y - 0.85, z) - 0.1
const table = (x: number, y: number, z: number) => (Math.abs(x) < 0.5 && Math.abs(z) < 0.4 ? y - 0.75 : 1)
const wall = (_x: number, _y: number, z: number) => z + 0.6

for (const voxel of [0.04, 0.02]) {
  // A ball on a table, pinched on its side.
  const scene = room(voxel, (x, y, z) => Math.min(ball(x, y, z), table(x, y, z)))
  const shell = liftShell(scene, { x: 0, y: 0.86, z: 0.1, nx: 0, ny: 0, nz: 1 }, eye)
  assert(shell !== null, `a ball on a table lifts (${voxel})`)
  if (!shell) continue
  assert(shell.kind === 'object', `the ball is one thing, got ${shell.kind} (${voxel})`)
  assert(shell.bottom > 0.75, `the table stays behind, lowest point ${shell.bottom.toFixed(3)} (${voxel})`)
  assert(shell.radius > 0.055 && shell.radius < 0.16, `the shell is the size of the ball, got ${shell.radius.toFixed(3)} (${voxel})`)
  // Only the side that faces the eye is taken: the far side is never seen by depth.
  assert(Math.hypot(shell.cx, shell.cz) < 0.07 && Math.abs(shell.cy - 0.87) < 0.05, `the shell is centred on the ball, got ${shell.cx.toFixed(3)} ${shell.cy.toFixed(3)} ${shell.cz.toFixed(3)} (${voxel})`)
  // Every triangle faces out of the ball.
  let out = 0
  let total = 0
  for (let t = 0; t < shell.indices.length; t += 3) {
    const a = shell.indices[t] * 3
    const b = shell.indices[t + 1] * 3
    const c = shell.indices[t + 2] * 3
    const p = shell.positions
    const ux = p[b] - p[a]
    const uy = p[b + 1] - p[a + 1]
    const uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a]
    const vy = p[c + 1] - p[a + 1]
    const vz = p[c + 2] - p[a + 2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const mx = (p[a] + p[b] + p[c]) / 3
    const my = (p[a + 1] + p[b + 1] + p[c + 1]) / 3 - 0.85
    const mz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3
    total++
    if (nx * mx + ny * my + nz * mz > 0) out++
  }
  assert(total > 20 && out === total, `the shell faces outward, ${out} of ${total} (${voxel})`)
  for (let i = 0; i < shell.positions.length; i += 3) {
    const r = Math.hypot(shell.positions[i], shell.positions[i + 1] - 0.85, shell.positions[i + 2])
    assert(Math.abs(r - 0.1) < voxel * 1.2, `the shell lies on the ball, off by ${(r - 0.1).toFixed(3)} (${voxel})`)
  }

  // The table itself, pinched on top: a round piece of it.
  const top = liftShell(scene, { x: 0.3, y: 0.75, z: 0.2, nx: 0, ny: 1, nz: 0 }, eye)
  assert(top !== null && top.kind === 'piece', `a pinch on the table takes a piece of it (${voxel})`)
  assert(top !== null && top.relief < voxel * 1.5, `a piece of table is flat, relief ${top?.relief.toFixed(3)} (${voxel})`)
  assert(top !== null && top.radius <= PIECE_REACH + 1e-6 && top.radius > PIECE_REACH * 0.7, `the piece is cut round (${voxel})`)

  // A wall is not an object either.
  const flat = liftShell(room(voxel, wall), { x: 0, y: 1.2, z: -0.6, nx: 0, ny: 0, nz: 1 }, eye)
  assert(flat !== null && flat.kind === 'piece', `a wall gives a piece (${voxel})`)
  let rim = 0
  if (flat) for (let i = 0; i < flat.edge.length; i++) rim = Math.max(rim, flat.edge[i])
  assert(rim > 0.85, `a piece knows where its rim is, got ${rim.toFixed(2)} (${voxel})`)

  // A box on the table, pinched on its top: the box, not the table.
  const box = (x: number, y: number, z: number) => Math.max(Math.abs(x + 0.2) - 0.07, Math.abs(y - 0.81) - 0.06, Math.abs(z) - 0.07)
  const boxed = liftShell(room(voxel, (x, y, z) => Math.min(box(x, y, z), table(x, y, z))), { x: -0.2, y: 0.87, z: 0, nx: 0, ny: 1, nz: 0 }, eye)
  assert(boxed !== null && boxed.kind === 'object', `a box pinched on top is one thing, got ${boxed?.kind} (${voxel})`)
  assert(boxed !== null && boxed.bottom > 0.75, `the box leaves the table behind (${voxel})`)

  // Open air.
  assert(liftShell(scene, { x: 0, y: 1.4, z: 0.3, nx: 0, ny: 0, nz: 1 }, eye) === null, `nothing lifts out of open air (${voxel})`)
}

// The real field hands out the same block its own lookups read.
const field = new RoomField(0.02, 64)
const samples = []
for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) samples.push({ ox: 0, oy: 1, oz: 0, px: -0.11 + x * 0.02, py: 0.89 + y * 0.02, pz: -1 })
for (let pass = 0; pass < 3; pass++) field.integrate(samples)
assert(field.voxel === 0.02 && field.chunkCount > 0, 'a fine field fills')
const hit = field.surfaceAlong(0, 1, 0, 0, 0, -1, 2, surfacePoint())
assert(hit !== null && Math.abs(hit.z + 1) < 0.01, `a fine field finds its wall, got ${hit?.z}`)
const g = field.grid(-3, 47, -53, 6, 6, 6)
let matches = 0
for (let k = 0; k < 6; k++) {
  for (let j = 0; j < 6; j++) {
    for (let i = 0; i < 6; i++) {
      const direct = field.sdf((-3 + i + 0.5) * 0.02, (47 + j + 0.5) * 0.02, (-53 + k + 0.5) * 0.02)
      const blockValue = g[i + j * 6 + k * 36]
      if (direct === null) continue
      // At the edge of what was seen, a point read fills in from its neighbours and a block read does not.
      if (blockValue === blockValue && Math.abs(direct - blockValue) < 1e-3) matches++
    }
  }
}
assert(matches > 50, `the block covers the wall, ${matches} voxels`)
const piece = hit ? liftShell(field, hit, { x: 0, y: 1, z: 0 }) : null
assert(piece !== null && piece.indices.length > 60, 'a shell comes out of the real field')

// The close look: the part of a view around a point, and back again.
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const lens = [1.2, 0, 0, 0, 0, 1.5, 0, 0, 0.1, -0.05, -1, -1, 0, 0, -0.2, 0]
const rect = focusRect(identity, lens, { x: 0.2, y: -0.1, z: -1.5 }, 0.7, 0.5)
assert(rect !== null, 'a point ahead has a place in the view')
if (rect) {
  const mid = viewFromDepth(lens, rect.u + rect.w / 2, rect.v + rect.h / 2, 1.5)
  assert(mid !== null && Math.abs(mid.x - 0.2) < 1e-6 && Math.abs(mid.y + 0.1) < 1e-6, `the middle of the close look is the point, got ${mid?.x} ${mid?.y}`)
  const left = viewFromDepth(lens, rect.u, rect.v, 1.5)
  const right = viewFromDepth(lens, rect.u + rect.w, rect.v + rect.h, 1.5)
  assert(left !== null && right !== null && Math.abs(right.x - left.x - 0.7) < 1e-6 && Math.abs(left.y - right.y - 0.5) < 1e-6, 'the close look is as wide and tall as asked')
}
assert(focusRect(identity, lens, { x: 0, y: 0, z: 1 }, 0.7, 0.5) === null, 'a point behind the view has no place in it')
assert(focusRect(identity, lens, { x: 5, y: 0, z: -1 }, 0.7, 0.5) === null, 'a point far off to the side has no place in it')
const edge = focusRect(identity, lens, { x: 0.7, y: 0, z: -1 }, 0.7, 0.5)
assert(edge !== null && edge.u + edge.w <= 1 + 1e-9, 'a close look near the edge stays inside the view')

// A ball on a stand, seen the way depth sees it: rays from one eye, fused into the fine field.
const seenFrom = { x: 0, y: 1.5, z: 1.2 }
const fused = new RoomField(0.02, 300, 2)
const hitBall = (dx: number, dy: number, dz: number): number => {
  // Ball of radius 0.13 at (0, 0.75, 0), on a stand whose top is y = 0.62.
  const ox = seenFrom.x
  const oy = seenFrom.y - 0.75
  const oz = seenFrom.z
  const b = ox * dx + oy * dy + oz * dz
  const c = ox * ox + oy * oy + oz * oz - 0.13 * 0.13
  const disc = b * b - c
  let t = disc >= 0 ? -b - Math.sqrt(disc) : Infinity
  if (dy < 0) {
    const tp = (0.62 - seenFrom.y) / dy
    const x = seenFrom.x + dx * tp
    const z = seenFrom.z + dz * tp
    if (Math.abs(x) < 0.17 && Math.abs(z) < 0.17 && tp < t) t = tp
  }
  return t
}
let seed = 1
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
for (let pass = 0; pass < 6; pass++) {
  const rays = []
  const jx = rand()
  const jy = rand()
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 28; x++) {
      const tx = ((x + jx) / 28 - 0.5) * 0.7
      const ty = 0.75 + ((y + jy) / 20 - 0.5) * 0.5
      const dx = tx - seenFrom.x
      const dy = ty - seenFrom.y
      const dz = -seenFrom.z
      const l = Math.hypot(dx, dy, dz)
      const t = hitBall(dx / l, dy / l, dz / l)
      if (!Number.isFinite(t)) continue
      rays.push({ ox: seenFrom.x, oy: seenFrom.y, oz: seenFrom.z, px: seenFrom.x + (dx / l) * t, py: seenFrom.y + (dy / l) * t, pz: seenFrom.z + (dz / l) * t })
    }
  }
  fused.integrate(rays)
}
const onBall = fused.surfaceAlong(seenFrom.x, seenFrom.y, seenFrom.z, 0, 0.78 - seenFrom.y, 0.12 - seenFrom.z, 3, surfacePoint())
assert(onBall !== null, 'the fused ball is there to pinch')
const lifted = onBall ? liftShell(fused, onBall, seenFrom) : null
assert(lifted !== null && lifted.kind === 'object', `the fused ball lifts as one thing, got ${lifted?.kind}`)
if (lifted) {
  // The eye sees a little under half of it. Most of that should come away, in one unbroken sheet.
  let area = 0
  const p = lifted.positions
  for (let t = 0; t < lifted.indices.length; t += 3) {
    const a = lifted.indices[t] * 3
    const b = lifted.indices[t + 1] * 3
    const c = lifted.indices[t + 2] * 3
    const ux = p[b] - p[a]
    const uy = p[b + 1] - p[a + 1]
    const uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a]
    const vy = p[c + 1] - p[a + 1]
    const vz = p[c + 2] - p[a + 2]
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  }
  const seenArea = 2 * Math.PI * 0.13 * 0.13
  assert(area > seenArea * 0.4, `most of the seen side of the ball comes away, ${(area / seenArea).toFixed(2)} of it`)
  assert(lifted.bottom > 0.62, `the stand stays behind, lowest point ${lifted.bottom.toFixed(3)}`)
}

// The fine field sees only a small window. A wall seen through one must not pass for a closed thing.
{
  const eye = { x: 0, y: 1.4, z: 0 }
  const fineWall = new RoomField(0.02, 300, 2)
  let s = 7
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (let pass = 0; pass < 8; pass++) {
    const rays = []
    const jx = r()
    const jy = r()
    for (let y = 0; y < 20; y++) for (let x = 0; x < 28; x++) {
      rays.push({ ox: eye.x, oy: eye.y, oz: eye.z, px: ((x + jx) / 28 - 0.5) * 0.5, py: 1.3 + ((y + jy) / 20 - 0.5) * 0.36, pz: -1.2 + (r() - 0.5) * 0.01 })
    }
    fineWall.integrate(rays)
  }
  const at = fineWall.surfaceAlong(eye.x, eye.y, eye.z, 0, -0.1, -1.2, 3, surfacePoint())
  assert(at !== null, 'the windowed wall is there')
  if (at) {
    const fine = liftShell(fineWall, at, eye)
    const coarse = liftShell(room(0.04, (_x, _y, z) => z + 1.2), at, eye)
    assert(coarse !== null && coarse.kind === 'piece' && coarse.runsOn, 'the coarse field sees the wall run on')
    const picked = pickShell(coarse, fine)
    assert(picked !== null && picked.kind === 'piece', `a wall seen through a small window is a piece of wall, got ${picked?.kind} (fine said ${fine?.kind})`)
  }
  // A box on a table: the coarse field sees the table, which does not run on in the same way, so the fine box stands.
  const box = (x: number, y: number, z: number) => Math.max(Math.abs(x + 0.2) - 0.07, Math.abs(y - 0.81) - 0.06, Math.abs(z) - 0.07)
  const table = (x: number, y: number, z: number) => (Math.abs(x) < 0.5 && Math.abs(z) < 0.4 ? y - 0.75 : 1)
  const scene = (x: number, y: number, z: number) => Math.min(box(x, y, z), table(x, y, z))
  const seedTop = { x: -0.2, y: 0.87, z: 0, nx: 0, ny: 1, nz: 0 }
  const view = { x: 0, y: 1.5, z: 1.2 }
  const fineBox = liftShell(room(0.02, scene), seedTop, view)
  const coarseBox = liftShell(room(0.04, scene), seedTop, view)
  const pickedBox = pickShell(coarseBox, fineBox)
  assert(pickedBox !== null && pickedBox.kind === 'object', `a box on a table stays a thing, got ${pickedBox?.kind} (coarse ${coarseBox?.kind}${coarseBox?.runsOn ? ' runs on' : ''})`)
  // The ball on its stand, the same.
  const ballScene = room(0.04, (x, y, z) => Math.min(Math.hypot(x, y - 0.85, z) - 0.1, table(x, y, z)))
  const ballSeed = { x: 0, y: 0.86, z: 0.1, nx: 0, ny: 0, nz: 1 }
  const pickedBall = pickShell(liftShell(ballScene, ballSeed, view), liftShell(room(0.02, (x, y, z) => Math.min(Math.hypot(x, y - 0.85, z) - 0.1, table(x, y, z))), ballSeed, view))
  assert(pickedBall !== null && pickedBall.kind === 'object', `a ball on a table stays a thing, got ${pickedBall?.kind}`)
  // A ball 4 cm in front of a wall: the coarse field runs it into the wall, but the fine one sees it has depth of its own.
  const wallBall = (x: number, y: number, z: number) => Math.min(Math.hypot(x, y - 0.85, z) - 0.1, z + 0.14)
  const nearWall = pickShell(liftShell(room(0.04, wallBall), ballSeed, view), liftShell(room(0.02, wallBall), ballSeed, view))
  assert(nearWall !== null && nearWall.kind === 'object', `a ball in front of a wall stays a thing, got ${nearWall?.kind}`)
}

console.log('object ok')
