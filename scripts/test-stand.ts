import { register } from 'node:module'
import { farther, mixedPixel } from '../src/room/depth-project.ts'
import { RoomField, type DepthSample } from '../src/room/field.ts'
import { liftShell, readWindow, OBJECT_REACH, type FieldBlock, type Shell } from '../src/room/object.ts'
import type { StandFit, StandProbe } from '../src/room/stand.ts'

// stand.ts imports object.ts as './object.js', as the bundler wants. Node only finds the .ts
// file, so point it there before stand.ts loads.
const hook = `export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) return next(specifier.slice(0, -3) + '.ts', context)
    throw error
  }
}`
register('data:text/javascript,' + encodeURIComponent(hook))
const { fitStanding, buildStanding, StandTrack, BASE_EDGE, BASE_GAP, FAR_K, setStandFar, standFar } = await import('../src/room/stand.ts')

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error(message)
}

// The far-side shrink takes the `?standfar=` flag as it comes.
setStandFar('1.5')
assert(standFar() === 1.5, 'a far-side shrink is set from its flag')
for (const flag of [null, undefined, '', 'x', '-1']) {
  setStandFar(flag)
  assert(standFar() === FAR_K, `no flag, or a bad one, keeps the default far-side shrink (${flag})`)
}

const cm = (x: number) => (x * 100).toFixed(1)
const mm = (x: number) => (x * 1000).toFixed(1)
const deg = (x: number) => ((x * 180) / Math.PI).toFixed(1)
const probe = (): StandProbe => ({ plane: NaN, reason: '' })

/** How far a box's turn is from another, a quarter turn being the same box. */
function turnError(a: number, b: number): number {
  let d = (a - b) % (Math.PI / 2)
  if (d > Math.PI / 4) d -= Math.PI / 2
  if (d < -Math.PI / 4) d += Math.PI / 2
  return Math.abs(d)
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

const table = (x: number, y: number, z: number) => (Math.abs(x) < 0.5 && Math.abs(z) < 0.4 ? y - 0.75 : 1)
/** A box `w` by `d` by `h` metres standing at (x, base, z), turned `yaw` about up. */
function boxAt(x: number, base: number, z: number, w: number, d: number, h: number, yaw: number) {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return (px: number, py: number, pz: number) => {
    const dx = px - x
    const dz = pz - z
    return Math.max(Math.abs(dx * c + dz * s) - w / 2, Math.abs(py - base - h / 2) - h / 2, Math.abs(-dx * s + dz * c) - d / 2)
  }
}
/** An upright slab between two corners. */
function slab(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
  return (x: number, y: number, z: number) => Math.max(x0 - x, x - x1, y0 - y, y - y1, z0 - z, z - z1)
}

// Things on a table, from straight above: every wall is seen alike, so each side is placed by its own wall.
for (const voxel of [0.02, 0.04]) {
  for (const yawDeg of [0, 26, 45]) {
    const yaw = (yawDeg * Math.PI) / 180
    const box = boxAt(-0.2, 0.75, 0, 0.14, 0.14, 0.12, yaw)
    const p = probe()
    const fit = fitStanding(room(voxel, (x, y, z) => Math.min(box(x, y, z), table(x, y, z))), { x: -0.2, y: 0.87, z: 0 }, { x: -0.2, y: 1.5, z: 0 }, p)
    assert(fit !== null && fit.shape === 'box', `a box on a table fits as a box, got ${fit?.shape ?? p.reason} (${voxel}, ${yawDeg} deg)`)
    if (!fit) continue
    assert(Math.abs(2 * fit.hu - 0.14) < 0.005 && Math.abs(2 * fit.hv - 0.14) < 0.005, `the box is 14 cm square, got ${cm(2 * fit.hu)} x ${cm(2 * fit.hv)} (${voxel}, ${yawDeg} deg)`)
    assert(Math.hypot(fit.cx + 0.2, fit.cz) < 0.005, `the box is where it stands, off by ${mm(Math.hypot(fit.cx + 0.2, fit.cz))} mm (${voxel}, ${yawDeg} deg)`)
    assert(turnError(fit.angle, yaw) < (2 * Math.PI) / 180, `the box is turned as it stands, off by ${deg(turnError(fit.angle, yaw))} deg (${voxel}, ${yawDeg} deg)`)
    assert(Math.abs(fit.plane - 0.75) < 0.003 && Math.abs(fit.top - 0.87) < 0.003, `the box stands on the table and is 12 cm tall, plane ${fit.plane.toFixed(4)} top ${fit.top.toFixed(4)} (${voxel})`)
    assert(fit.flat, `the box has a flat top (${voxel}, ${yawDeg} deg)`)
  }
  const can = (x: number, y: number, z: number) => Math.max(Math.hypot(x + 0.2, z) - 0.065, Math.abs(y - 0.8) - 0.05)
  const p = probe()
  const round = fitStanding(room(voxel, (x, y, z) => Math.min(can(x, y, z), table(x, y, z))), { x: -0.2, y: 0.85, z: 0 }, { x: -0.2, y: 1.5, z: 0 }, p)
  assert(round !== null && round.shape === 'round', `a can fits as a round, got ${round?.shape ?? p.reason} (${voxel})`)
  assert(round !== null && Math.abs(round.r - 0.065) < 0.005, `the can's radius is 6.5 cm, got ${round ? cm(round.r) : '-'} (${voxel})`)

  // A ball is no prism: the lift's own shell is better for it.
  const ball = (x: number, y: number, z: number) => Math.hypot(x, y - 0.85, z) - 0.1
  const front = { x: 0, y: 1.5, z: 1.2 }
  const ballScene = room(voxel, (x, y, z) => Math.min(ball(x, y, z), table(x, y, z)))
  const pb = probe()
  assert(fitStanding(ballScene, { x: 0, y: 0.86, z: 0.1 }, front, pb) === null && pb.reason === 'taper', `a ball is not fitted, it tapers, got ${pb.reason} (${voxel})`)
  assert(Math.abs(pb.plane - 0.75) < 0.005, `the ball still stands on the table, ${pb.plane.toFixed(4)} (${voxel})`)

  // Not things: the table itself, a wall, open air.
  const pt = probe()
  assert(fitStanding(ballScene, { x: 0.3, y: 0.75, z: 0.2 }, front, pt) === null && pt.reason === 'on-table', `a pinch on the table is on the table, got ${pt.reason} (${voxel})`)
  const pw = probe()
  assert(fitStanding(room(voxel, (_x, _y, z) => z + 0.6), { x: 0, y: 1.2, z: -0.6 }, front, pw) === null, `a wall is not a standing thing, got ${pw.reason} (${voxel})`)
  const pa = probe()
  assert(fitStanding(ballScene, { x: 0, y: 1.4, z: 0.3 }, front, pa) === null, `nothing stands in open air, got ${pa.reason} (${voxel})`)
}

// A low side table with the floor in view: the nearest level below the pinch is what it stands on.
for (const voxel of [0.02, 0.04]) {
  for (const shelf of [false, true]) {
    const top = slab(-0.275, 0.275, 0.44, 0.47, -0.225, 0.225)
    const floor = (_x: number, y: number) => y
    // The lower shelf is wider than the top, so more of it is in view than of the top.
    const lower = shelf ? slab(-0.4, 0.4, 0.12, 0.15, -0.35, 0.35) : () => 1
    const box = boxAt(0.05, 0.47, 0.02, 0.14, 0.14, 0.08, 0.3)
    const scene = room(voxel, (x, y, z) => Math.min(top(x, y, z), floor(x, y), lower(x, y, z), box(x, y, z)))
    const above = { x: 0.05, y: 1.3, z: 0.02 }
    const pt = probe()
    const onTop = fitStanding(scene, { x: -0.18, y: 0.47, z: -0.15 }, above, pt)
    assert(onTop === null && pt.reason === 'on-table', `a pinch on the side table is on the table, not a box on the floor, got ${onTop?.shape ?? pt.reason} (${voxel}${shelf ? ', with shelf' : ''})`)
    const pb = probe()
    const onBox = fitStanding(scene, { x: 0.05, y: 0.55, z: 0.02 }, above, pb)
    assert(onBox !== null && onBox.shape === 'box', `the box on the side table fits, got ${onBox?.shape ?? pb.reason} (${voxel}${shelf ? ', with shelf' : ''})`)
    assert(onBox !== null && Math.abs(onBox.plane - 0.47) < 0.003, `the box stands on the table top, not the floor or shelf, plane ${onBox?.plane.toFixed(4)} (${voxel}${shelf ? ', with shelf' : ''})`)
  }
}

// ---- Depth seen from one eye and fused, the way the headset's close look does it. ----

/** A thing in the synthetic scene: where a ray from `eye` first meets it, or Infinity. */
type Hit = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) => number

function slabHit(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Hit {
  return (ox, oy, oz, dx, dy, dz) => {
    let near = -Infinity
    let far = Infinity
    const o = [ox, oy, oz]
    const d = [dx, dy, dz]
    const lo = [x0, y0, z0]
    const hi = [x1, y1, z1]
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-12) {
        if (o[a] < lo[a] || o[a] > hi[a]) return Infinity
        continue
      }
      let t0 = (lo[a] - o[a]) / d[a]
      let t1 = (hi[a] - o[a]) / d[a]
      if (t0 > t1) [t0, t1] = [t1, t0]
      near = Math.max(near, t0)
      far = Math.min(far, t1)
    }
    return near <= far && near > 0 ? near : Infinity
  }
}

function boxHit(cx: number, base: number, cz: number, w: number, d: number, h: number, yaw: number): Hit {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const inner = slabHit(-w / 2, w / 2, base, base + h, -d / 2, d / 2)
  return (ox, oy, oz, dx, dy, dz) => inner((ox - cx) * c + (oz - cz) * s, oy, -(ox - cx) * s + (oz - cz) * c, dx * c + dz * s, dy, -dx * s + dz * c)
}

function canHit(cx: number, base: number, cz: number, r: number, h: number): Hit {
  return (ox, oy, oz, dx, dy, dz) => {
    let best = Infinity
    const px = ox - cx
    const pz = oz - cz
    const a = dx * dx + dz * dz
    const b = px * dx + pz * dz
    const disc = b * b - a * (px * px + pz * pz - r * r)
    if (disc >= 0 && a > 1e-12) {
      const t = (-b - Math.sqrt(disc)) / a
      const y = oy + dy * t
      if (t > 0 && y >= base && y <= base + h) best = t
    }
    if (dy < 0) {
      const t = (base + h - oy) / dy
      const x = px + dx * t
      const z = pz + dz * t
      if (x * x + z * z <= r * r && t < best) best = t
    }
    return best
  }
}

function ballHit(cx: number, cy: number, cz: number, r: number): Hit {
  return (ox, oy, oz, dx, dy, dz) => {
    const px = ox - cx
    const py = oy - cy
    const pz = oz - cz
    const b = px * dx + py * dy + pz * dz
    const disc = b * b - (px * px + py * py + pz * pz - r * r)
    if (disc < 0) return Infinity
    const t = -b - Math.sqrt(disc)
    return t > 0 ? t : Infinity
  }
}

const TABLE_Y = 0.75
/** The prototype's table: its top at 0.75, x within 0.6 m, z from -0.55 to 0.35. */
const deskTop = slabHit(-0.6, 0.6, 0.7, TABLE_Y, -0.55, 0.35)

let seed = 12345
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand())

const COLS = 40
const ROWS = 30

/**
 * One close look from `eye` at `target`: a 40 x 30 grid of jittered readings
 * over `wide` x `high` metres there, with depth noise (0.6 cm + 0.6 cm per
 * metre), 2% wild readings, and readings that blur part way across an edge.
 * Then fuseGrid's filters: flying readings out, mixed readings out, and the
 * near side of a depth jump marked as an edge.
 */
function look(field: RoomField, eye: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }, scene: Hit[], wide = 0.84, high = 0.6): void {
  const cast = (dx: number, dy: number, dz: number) => {
    let best = Infinity
    for (const hit of scene) best = Math.min(best, hit(eye.x, eye.y, eye.z, dx, dy, dz))
    return best
  }
  let fx = target.x - eye.x
  let fy = target.y - eye.y
  let fz = target.z - eye.z
  const fl = Math.hypot(fx, fy, fz)
  fx /= fl
  fy /= fl
  fz /= fl
  let rx = -fz
  let rz = fx
  const rl = Math.hypot(rx, rz)
  rx /= rl
  rz /= rl
  const ux = -rz * fy
  const uy = rz * fx - rx * fz
  const uz = rx * fy
  const jx = rand()
  const jy = rand()
  const m = new Float32Array(COLS * ROWS)
  const at = new Float32Array(COLS * ROWS * 3)
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const ax = ((col + jx) / COLS - 0.5) * wide
      const ay = ((row + jy) / ROWS - 0.5) * high
      let dx = fx * fl + rx * ax + ux * ay
      let dy = fy * fl + uy * ay
      let dz = fz * fl + rz * ax + uz * ay
      const l = Math.hypot(dx, dy, dz)
      dx /= l
      dy /= l
      dz /= l
      const k = col + row * COLS
      let t = cast(dx, dy, dz)
      if (!Number.isFinite(t)) continue
      // Depth blurs across an edge: a reading near one may land part way.
      const t2 = cast(dx + rx * 0.012, dy, dz + rz * 0.012)
      if (Number.isFinite(t2) && Math.abs(t2 - t) > 0.03 && rand() < 0.5) t += (t2 - t) * rand()
      t += gauss() * (0.006 + 0.006 * t)
      if (rand() < 0.02) t *= 0.85 + rand() * 0.3
      m[k] = t
      at[k * 3] = eye.x + dx * t
      at[k * 3 + 1] = eye.y + dy * t
      at[k * 3 + 2] = eye.z + dz * t
    }
  }
  const between = (d: number, a: number, b: number) => {
    if (!(a > 0) || !(b > 0)) return false
    const gap = 0.04 + 0.03 * d
    return d - Math.min(a, b) > gap && Math.max(a, b) - d > gap
  }
  const samples: DepthSample[] = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const k = col + row * COLS
      const d = m[k]
      if (!(d > 0)) continue
      if (col > 0 && col < COLS - 1 && between(d, m[k - 1], m[k + 1])) continue
      if (row > 0 && row < ROWS - 1 && between(d, m[k - COLS], m[k + COLS])) continue
      if (col > 1 && col < COLS - 2 && mixedPixel(d, m[k - 1], m[k + 1], m[k - 2], m[k + 2])) continue
      if (row > 1 && row < ROWS - 2 && mixedPixel(d, m[k - COLS], m[k + COLS], m[k - 2 * COLS], m[k + 2 * COLS])) continue
      const x = at[k * 3]
      const y = at[k * 3 + 1]
      const z = at[k * 3 + 2]
      const sample: DepthSample = { ox: eye.x, oy: eye.y, oz: eye.z, px: x, py: y, pz: z }
      if ((col > 0 && farther(d, m[k - 1])) || (col < COLS - 1 && farther(d, m[k + 1])) || (row > 0 && farther(d, m[k - COLS])) || (row < ROWS - 1 && farther(d, m[k + COLS]))) sample.edge = true
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
  field.integrateRange(samples, 0, samples.length, true, wide / fl / COLS)
}

const EYE = { x: 0.05, y: 1.32, z: 0.5 }
/** The CD stack: 14 x 14 x 8 cm, turned 26 degrees, on the table. */
const STACK = { x: -0.03, z: -0.08, w: 0.14, h: 0.08, yaw: 0.45 }

/** Each true side's error: how far the fit's outline runs past it, metres, and whether it faces the eye. */
function sideErrors(fit: StandFit, x: number, z: number, half: number, yaw: number, eye: { x: number; z: number }): { error: number; near: boolean }[] {
  const out: { error: number; near: boolean }[] = []
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const fc = Math.cos(fit.angle)
  const fs = Math.sin(fit.angle)
  for (const [nu, nw] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = nu * c - nw * s
    const nz = nu * s + nw * c
    const reach = fit.hu * Math.abs(nx * fc + nz * fs) + fit.hv * Math.abs(-nx * fs + nz * fc)
    out.push({ error: (fit.cx - x) * nx + (fit.cz - z) * nz + reach - half, near: nx * (eye.x - x) + nz * (eye.z - z) > 0 })
  }
  return out
}

function fused(scene: Hit[], target: { x: number; y: number; z: number }, passes: number, eye = EYE, start = 12345): RoomField {
  seed = start
  const field = new RoomField(0.02, 300, 2)
  for (let p = 0; p < passes; p++) look(field, eye, target, scene)
  return field
}

// The CD stack, fused: the fit is the box, with its far side pulled back to where it is.
const stackScene = [deskTop, boxHit(STACK.x, TABLE_Y, STACK.z, STACK.w, STACK.w, STACK.h, STACK.yaw)]
const stackTop = { x: STACK.x + 0.01, y: TABLE_Y + STACK.h, z: STACK.z + 0.01 }
const stackField = fused(stackScene, stackTop, 12)
{
  const p = probe()
  const fit = fitStanding(stackField, stackTop, EYE, p)
  assert(fit !== null && fit.shape === 'box', `the fused CD stack fits as a box, got ${fit?.shape ?? p.reason}`)
  if (fit) {
    const sides = sideErrors(fit, STACK.x, STACK.z, STACK.w / 2, STACK.yaw, EYE)
    const size = [2 * fit.hu - STACK.w, 2 * fit.hv - STACK.w]
    const centre = Math.hypot(fit.cx - STACK.x, fit.cz - STACK.z)
    const turn = turnError(fit.angle, STACK.yaw)
    console.log(
      `fused box: ${cm(2 * fit.hu)} x ${cm(2 * fit.hv)} cm (true 14 x 14), sides past the box ${sides.map((s) => `${cm(s.error)}${s.near ? ' near' : ' far'}`).join(', ')} cm, ` +
        `centre ${mm(centre)} mm, turn ${deg(turn)} deg, plane ${mm(fit.plane - TABLE_Y)} mm, top ${mm(fit.top - TABLE_Y - STACK.h)} mm, res ${mm(fit.residual)} mm, seen ${fit.seenOut.toFixed(2)}`,
    )
    assert(Math.abs(size[0]) < 0.015 && Math.abs(size[1]) < 0.015, `the fused box is 14 cm across both ways, got ${cm(2 * fit.hu)} x ${cm(2 * fit.hv)}`)
    assert(centre < 0.01, `the fused box is where it stands, off by ${mm(centre)} mm`)
    assert(turn < (3 * Math.PI) / 180, `the fused box is turned as it stands, off by ${deg(turn)} deg`)
    assert(Math.abs(fit.plane - TABLE_Y) < 0.005, `the fused box stands on the table, off by ${mm(fit.plane - TABLE_Y)} mm`)
    assert(Math.abs(fit.top - TABLE_Y - STACK.h) < 0.005, `the fused box is 8 cm tall, off by ${mm(fit.top - TABLE_Y - STACK.h)} mm`)
    assert(fit.flat, 'the fused box has a flat top')
  }
}

// The same box from other places and turns: every one a box, every side within 1.5 cm.
{
  const eyes = [EYE, { x: -0.35, y: 1.25, z: 0.45 }, { x: 0.3, y: 1.45, z: 0.35 }]
  const errors: number[] = []
  let worstTurn = 0
  for (const eye of eyes) {
    for (const yaw of [0, 0.2, 0.785]) {
      const scene = [deskTop, boxHit(STACK.x, TABLE_Y, STACK.z, STACK.w, STACK.w, STACK.h, yaw)]
      const p = probe()
      const fit = fitStanding(fused(scene, stackTop, 12, eye, 222), stackTop, eye, p)
      assert(fit !== null && fit.shape === 'box', `the box seen from ${eye.x}, ${eye.z} turned ${deg(yaw)} deg fits as a box, got ${fit?.shape ?? p.reason}`)
      if (!fit) continue
      for (const side of sideErrors(fit, STACK.x, STACK.z, STACK.w / 2, yaw, eye)) errors.push(side.error)
      worstTurn = Math.max(worstTurn, turnError(fit.angle, yaw))
    }
  }
  errors.sort((a, b) => a - b)
  console.log(`fused box, 3 eyes x 3 turns: sides past the box from ${cm(errors[0])} to ${cm(errors[errors.length - 1])} cm (middle ${cm(errors[errors.length >> 1])}), worst turn ${deg(worstTurn)} deg`)
  assert(Math.abs(errors[0]) < 0.015 && Math.abs(errors[errors.length - 1]) < 0.015, `every side within 1.5 cm, got ${cm(errors[0])} to ${cm(errors[errors.length - 1])} cm`)
}

// A can and a ball, fused.
const canScene = [deskTop, canHit(STACK.x, TABLE_Y, STACK.z, 0.065, 0.1)]
const canTop = { x: STACK.x + 0.01, y: TABLE_Y + 0.1, z: STACK.z + 0.01 }
{
  const p = probe()
  const fit = fitStanding(fused(canScene, canTop, 12), canTop, EYE, p)
  console.log(`fused can: ${fit ? `${fit.shape} r ${cm(fit.r)} cm (true 6.5), centre ${mm(Math.hypot(fit.cx - STACK.x, fit.cz - STACK.z))} mm, top ${mm(fit.top - TABLE_Y - 0.1)} mm` : p.reason}`)
  assert(fit !== null && fit.shape === 'round', `the fused can fits as a round, got ${fit?.shape ?? p.reason}`)
  assert(fit !== null && Math.abs(fit.r - 0.065) < 0.005, `the fused can's radius is 6.5 cm, got ${fit ? cm(fit.r) : '-'}`)
}
{
  const ballScene = [deskTop, ballHit(STACK.x, TABLE_Y + 0.09, STACK.z, 0.09)]
  const ballTop = { x: STACK.x, y: TABLE_Y + 0.18, z: STACK.z + 0.01 }
  const p = probe()
  const fit = fitStanding(fused(ballScene, ballTop, 12), ballTop, EYE, p)
  assert(fit === null, `a fused ball is not fitted, got ${fit?.shape}`)
  console.log(`fused ball: no fit (${p.reason}), plane ${p.plane.toFixed(3)}`)
}
// The desk's vase: an egg 26 cm across, sunk in a stand 34 cm square. It barely draws in at its
// foot, but it does near its top, and it is no can: the lift's own shell is better for it.
{
  const egg: Hit = (ox, oy, oz, dx, dy, dz) => {
    const py = (oy - 0.74) / 1.25
    const ey = dy / 1.25
    const px = ox + 0.72
    const pz = oz + 1.45
    const a = dx * dx + ey * ey + dz * dz
    const b = px * dx + py * ey + pz * dz
    const disc = b * b - a * (px * px + py * py + pz * pz - 0.13 * 0.13)
    if (disc < 0) return Infinity
    const t = (-b - Math.sqrt(disc)) / a
    return t > 0 ? t : Infinity
  }
  const vaseScene = [slabHit(-0.89, -0.55, 0, 0.62, -1.62, -1.28), egg]
  const deskEye = { x: 0, y: 1.7, z: 0 }
  const vaseSide = { x: -0.72, y: 0.84, z: -1.33 }
  seed = 779
  const field = new RoomField(0.02, 300, 2)
  for (let pass = 0; pass < 24; pass++) look(field, deskEye, vaseSide, vaseScene)
  const p = probe()
  const fit = fitStanding(field, vaseSide, deskEye, p)
  assert(fit === null && p.reason === 'taper', `the desk's vase is not fitted, it draws in, got ${fit ? `${fit.shape} r ${cm(fit.r)} cm` : p.reason}`)
  assert(Math.abs(p.plane - 0.62) < 0.005, `the vase stands on its stand, ${p.plane.toFixed(4)}`)
  console.log(`fused vase in a stand: no fit (${p.reason}), plane ${p.plane.toFixed(3)}`)
}

// The lift reads the block the fit read, and cuts at the plane the fit measured.
{
  const p = probe()
  const fit = fitStanding(stackField, stackTop, EYE, p)
  assert(fit !== null && p.window !== undefined, 'the fit hands back the block it read')
  const reused = p.window ? readWindow(stackField, stackTop, OBJECT_REACH, p.window) : null
  assert(reused === p.window, 'a block read just before is used again')
  const plain = liftShell(stackField, stackTop, EYE)
  const shared = liftShell(stackField, stackTop, EYE, { window: p.window })
  assert(plain !== null && shared !== null && plain.positions.length === shared.positions.length, 'the lift makes the same shell from the shared block')
  readWindow(stackField, { x: 0.3, y: 0.9, z: -0.2 }, OBJECT_REACH)
  assert(p.window !== undefined && readWindow(stackField, stackTop, OBJECT_REACH, p.window) !== p.window, 'a block read before another read is not used again')
  const cut = liftShell(stackField, stackTop, EYE, { floor: p.plane })
  assert(cut !== null && cut.bottom > p.plane + 0.008, `the lift cuts just above the measured plane, lowest point ${cut ? mm(cut.bottom - p.plane) : '-'} mm above it`)
}

// ---- Holding a shape steady. ----
{
  seed = 4242
  const field = new RoomField(0.02, 300, 2)
  for (let p = 0; p < 10; p++) look(field, EYE, stackTop, stackScene)
  const track = new StandTrack()
  const shells = new Set<Shell>()
  const xs: number[] = []
  const zs: number[] = []
  let now = 0
  let last: Shell | null = null
  for (let i = 0; i < 20; i++) {
    look(field, EYE, stackTop, stackScene)
    const shell = track.update(fitStanding(field, stackTop, EYE), stackTop, now, EYE)
    now += 0.25
    assert(shell !== null && shell.stand?.shape === 'box', `a still box stays a box, update ${i}`)
    if (!shell) continue
    shells.add(shell)
    xs.push(shell.cx)
    zs.push(shell.cz)
    last = shell
  }
  const sd = (v: number[]) => {
    const mean = v.reduce((a, b) => a + b, 0) / v.length
    return Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length)
  }
  console.log(`tracker: ${shells.size} shells over 20 fits of a still box, centre sd ${mm(sd(xs))} x ${mm(sd(zs))} mm`)
  assert(shells.size <= 3, `a still box is rebuilt at most 3 times in 20 fits, got ${shells.size}`)
  assert(sd(xs) < 0.001 && sd(zs) < 0.001, `a still box holds still, centre sd ${mm(sd(xs))} x ${mm(sd(zs))} mm`)

  // A hand in the way: the same shape for up to a second while the pinch stays on it.
  const seenAt = now - 0.25
  assert(track.update(null, stackTop, seenAt + 0.3, EYE) === last, 'a missed fit holds the shape')
  assert(Math.abs(track.held - 0.3) < 1e-9, `the hold is counted, ${track.held.toFixed(2)} s`)
  assert(track.update(null, stackTop, seenAt + 0.95, EYE) === last, 'a missed fit holds the shape for most of a second')
  assert(track.update(null, stackTop, seenAt + 1.05, EYE) === null, 'after a second without a fit the shape goes')
  assert(track.update(fitStanding(field, stackTop, EYE), stackTop, seenAt + 1.1, EYE) !== null, 'the shape comes straight back')
  assert(track.update(null, { x: 1, z: 1 }, seenAt + 1.2, EYE) === null, 'a pinch off the shape lets it go')

  // Moved 5 cm: followed within 3 updates.
  const moved = { x: STACK.x + 0.05, z: STACK.z }
  const movedTop = { x: moved.x + 0.01, y: stackTop.y, z: moved.z + 0.01 }
  track.reset()
  now = 10
  track.update(fitStanding(field, stackTop, EYE), stackTop, now, EYE)
  const movedScene = [deskTop, boxHit(moved.x, TABLE_Y, moved.z, STACK.w, STACK.w, STACK.h, STACK.yaw)]
  const movedField = fused(movedScene, movedTop, 10, EYE, 777)
  let followed = -1
  for (let i = 0; i < 4; i++) {
    look(movedField, EYE, movedTop, movedScene)
    now += 0.25
    const shell = track.update(fitStanding(movedField, movedTop, EYE), movedTop, now, EYE)
    if (followed < 0 && shell && Math.hypot(shell.cx - moved.x, shell.cz - moved.z) < 0.012) followed = i + 1
  }
  assert(followed > 0 && followed <= 3, `a box moved 5 cm is followed within 3 updates, took ${followed}`)
  console.log(`tracker: a box moved 5 cm is followed after ${followed} updates`)

  // Swapped for a can in place: the shape changes on the second fit that agrees, not the first.
  track.reset()
  now = 20
  track.update(fitStanding(field, stackTop, EYE), stackTop, now, EYE)
  const canField = fused(canScene, canTop, 10, EYE, 999)
  const shapes: string[] = []
  for (let i = 0; i < 3; i++) {
    look(canField, EYE, canTop, canScene)
    now += 0.25
    const fit = fitStanding(canField, canTop, EYE)
    assert(fit !== null && fit.shape === 'round', `the can fits as a round, got ${fit?.shape}`)
    shapes.push(track.update(fit, canTop, now, EYE)?.stand?.shape ?? 'none')
  }
  assert(shapes[0] === 'box' && shapes[1] === 'round' && shapes[2] === 'round', `the can takes over on the second agreeing fit, got ${shapes.join(', ')}`)
}

// ---- The shell built from a fit. ----
function checkShell(name: string, fit: StandFit, eye: { x: number; y: number; z: number }): void {
  const shell = buildStanding(fit, eye)
  const p = shell.positions
  const count = p.length / 3
  assert(shell.kind === 'object' && !shell.runsOn && shell.stand === fit, `${name}: a whole thing that carries its fit`)
  assert(Math.abs(shell.bottom - fit.plane - BASE_GAP) < 1e-6, `${name}: it stands just above the plane`)
  let low = Infinity
  let high = -Infinity
  for (let i = 0; i < count; i++) {
    low = Math.min(low, p[i * 3 + 1])
    high = Math.max(high, p[i * 3 + 1])
    const r = Math.hypot(p[i * 3] - shell.cx, p[i * 3 + 1] - shell.cy, p[i * 3 + 2] - shell.cz)
    assert(r <= shell.radius + 1e-6, `${name}: the radius bounds every point`)
  }
  assert(Math.abs(low - shell.bottom) < 1e-6 && Math.abs(shell.relief - (high - low)) < 1e-6, `${name}: bottom and relief match the points`)
  if (fit.flat) assert(Math.abs(shell.relief - (fit.top - fit.plane - BASE_GAP)) < 1e-6, `${name}: relief is its height`)
  // Edges by where their ends are: every one is used twice, the top's rim by the top and the wall, except along the base.
  const key = (i: number) => `${p[i * 3].toFixed(5)},${p[i * 3 + 1].toFixed(5)},${p[i * 3 + 2].toFixed(5)}`
  const uses = new Map<string, number>()
  const edgeKey = (a: number, b: number) => [key(a), key(b)].sort().join('|')
  for (let t = 0; t < shell.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const k = edgeKey(shell.indices[t + e], shell.indices[t + ((e + 1) % 3)])
      uses.set(k, (uses.get(k) ?? 0) + 1)
    }
  }
  const base = (i: number) => Math.abs(p[i * 3 + 1] - shell.bottom) < 1e-6
  for (let t = 0; t < shell.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = shell.indices[t + e]
      const b = shell.indices[t + ((e + 1) % 3)]
      const n = uses.get(edgeKey(a, b))
      if (base(a) && base(b)) assert(n === 1, `${name}: the base is open`)
      else assert(n === 2, `${name}: every edge but the base joins two triangles, got ${n}`)
    }
  }
  // Every triangle faces out: the top up, the walls away from the middle.
  const onTop = new Uint8Array(count)
  for (let t = 0; t < shell.indices.length; t += 3) {
    const a = shell.indices[t] * 3
    const b = shell.indices[t + 1] * 3
    const c = shell.indices[t + 2] * 3
    const ux = p[b] - p[a]
    const uy = p[b + 1] - p[a + 1]
    const uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a]
    const vy = p[c + 1] - p[a + 1]
    const vz = p[c + 2] - p[a + 2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    if (Math.abs(ny) < Math.hypot(nx, nz)) {
      const mx = (p[a] + p[b] + p[c]) / 3 - fit.cx
      const mz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3 - fit.cz
      assert(nx * mx + nz * mz > 0, `${name}: wall triangles face out`)
    } else {
      assert(ny > 0, `${name}: top triangles face up`)
      onTop[shell.indices[t]] = onTop[shell.indices[t + 1]] = onTop[shell.indices[t + 2]] = 1
    }
  }
  // The base ring is the contact line; nothing else is edge. Walls turned from the eye were never seen.
  for (let i = 0; i < count; i++) {
    assert(base(i) ? Math.abs(shell.edge[i] - BASE_EDGE) < 1e-6 : shell.edge[i] === 0, `${name}: edge marks the base ring only`)
  }
  assert(shell.unseen !== undefined, `${name}: it says what was never seen`)
  let walls = 0
  for (let t = 0; t < shell.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const i = shell.indices[t + e]
      if (!base(i)) continue
      // A base vertex is a wall vertex: it faces the way its outline point does.
      const dx = p[i * 3] - fit.cx
      const dz = p[i * 3 + 2] - fit.cz
      const outward = fit.shape === 'round' ? dx * (eye.x - p[i * 3]) + dz * (eye.z - p[i * 3 + 2]) : NaN
      if (outward === outward && Math.abs(outward) > 1e-4) assert((shell.unseen[i] === 1) === outward < 0, `${name}: the far walls are the unseen ones`)
      walls++
    }
  }
  assert(walls > 0, `${name}: it has walls`)
  // Seen from above, the top is seen.
  for (let i = 0; i < count; i++) if (onTop[i] && eye.y > high) assert(shell.unseen[i] === 0, `${name}: the top is seen from above`)
}

{
  const fit = fitStanding(stackField, stackTop, EYE)
  assert(fit !== null, 'a fit to build from')
  if (fit) {
    checkShell('box', fit, EYE)
    // A box's far walls: those facing away from the eye, by the side they are on.
    const shell = buildStanding(fit, EYE)
    const c = Math.cos(fit.angle)
    const s = Math.sin(fit.angle)
    let checked = 0
    for (let i = 0; i < shell.positions.length / 3; i++) {
      const x = shell.positions[i * 3]
      const y = shell.positions[i * 3 + 1]
      const z = shell.positions[i * 3 + 2]
      if (Math.abs(y - shell.bottom) > 1e-6) continue
      const u = (x - fit.cx) * c + (z - fit.cz) * s
      const w = -(x - fit.cx) * s + (z - fit.cz) * c
      // On a flat side, not round a corner.
      let nu = 0
      let nw = 0
      if (Math.abs(Math.abs(u) - fit.hu) < 1e-5 && Math.abs(w) < fit.hv - fit.corner - 1e-5) nu = Math.sign(u)
      else if (Math.abs(Math.abs(w) - fit.hv) < 1e-5 && Math.abs(u) < fit.hu - fit.corner - 1e-5) nw = Math.sign(w)
      else continue
      const nx = nu * c - nw * s
      const nz = nu * s + nw * c
      const facing = nx * (EYE.x - x) + nz * (EYE.z - z)
      assert((shell.unseen![i] === 1) === facing < 0, 'the box walls turned from the eye are the unseen ones')
      checked++
    }
    assert(checked > 20, `the box has flat sides to check, ${checked}`)
  }
  const round = fitStanding(fused(canScene, canTop, 12), canTop, EYE)
  assert(round !== null, 'a round to build from')
  if (round) checkShell('round', round, EYE)
  // A prism: a rounded triangle, by hand.
  const radii = new Float32Array(64)
  for (let k = 0; k < 64; k++) radii[k] = 0.06 + 0.015 * Math.cos(3 * ((k / 64) * 2 * Math.PI))
  const prism: StandFit = {
    shape: 'prism',
    plane: 0.75,
    top: 0.83,
    flat: true,
    mad: 0,
    cx: 0.1,
    cz: -0.1,
    angle: 0.3,
    hu: 0.075,
    hv: 0.07,
    corner: 0,
    r: 0,
    radii,
    heights: null,
    gx: 0,
    gz: 0,
    gw: 0,
    gd: 0,
    residual: 0,
    seenOut: 1,
    voxel: 0.02,
  }
  checkShell('prism', prism, EYE)
  // A three-sided thing is neither a box nor a round: a prism round its own outline.
  const three = (x: number, y: number, z: number) => {
    let d = Math.abs(y - 0.79) - 0.04
    for (let k = 0; k < 3; k++) {
      const a = (k * 2 * Math.PI) / 3 + 0.3
      d = Math.max(d, (x + 0.2) * Math.cos(a) + z * Math.sin(a) - 0.05)
    }
    return d
  }
  const pt = probe()
  const wedge3 = fitStanding(room(0.02, (x, y, z) => Math.min(three(x, y, z), table(x, y, z))), { x: -0.2, y: 0.83, z: 0 }, { x: -0.2, y: 1.5, z: 0 }, pt)
  assert(wedge3 !== null && wedge3.shape === 'prism', `a three-sided thing fits as a prism, got ${wedge3?.shape ?? pt.reason}`)
  if (wedge3) {
    const near = Math.min(...wedge3.radii)
    const far = Math.max(...wedge3.radii)
    assert(Math.abs(near - 0.05) < 0.007 && far > 0.075, `the prism reaches its sides and its corners, ${cm(near)} to ${cm(far)} cm`)
    checkShell('three-sided', wedge3, EYE)
  }
  // A top that is not flat: a box with a sloping top, from the field.
  const wedge = (x: number, y: number, z: number) => Math.max(Math.abs(x + 0.2) - 0.08, 0.75 - y, y - (0.83 + 0.25 * (x + 0.2)), Math.abs(z) - 0.08)
  const sloped = fitStanding(room(0.02, (x, y, z) => Math.min(wedge(x, y, z), table(x, y, z))), { x: -0.2, y: 0.83, z: 0 }, { x: -0.2, y: 1.5, z: 0 })
  assert(sloped !== null && !sloped.flat && sloped.heights !== null, `a sloping top is not flat, got ${sloped ? (sloped.flat ? 'flat' : 'sloped') : 'no fit'}`)
  if (sloped) {
    checkShell('sloped', sloped, { x: -0.2, y: 1.5, z: 0.5 })
    const shell = buildStanding(sloped, { x: -0.2, y: 1.5, z: 0.5 })
    let lowTop = Infinity
    let highTop = -Infinity
    for (let i = 0; i < shell.positions.length / 3; i++) {
      const x = shell.positions[i * 3]
      const y = shell.positions[i * 3 + 1]
      if (y < 0.79) continue
      if (x < -0.25) lowTop = Math.min(lowTop, y)
      if (x > -0.15) highTop = Math.max(highTop, y)
    }
    assert(highTop - lowTop > 0.02, `the sloping top slopes, ${cm(highTop - lowTop)} cm`)
  }
}

// ---- The fine field sees only a small window. A patch of a big thing seen through it is not a standing thing. ----
{
  // A big cushion on a seat, seen across its front edge: the outline is the edge of what was seen on three sides.
  const scene = [slabHit(-1, 1, 0.35, 0.45, -1, 0.6), slabHit(-0.4, 0.4, 0.45, 0.55, -0.7, 0.1)]
  const eye = { x: 0, y: 1.3, z: 0.45 }
  const edge = { x: 0, y: 0.55, z: 0.1 }
  seed = 31
  const field = new RoomField(0.02, 300, 2)
  for (let p = 0; p < 10; p++) look(field, eye, edge, scene, 0.3, 0.25)
  const on = { x: 0.01, y: 0.55, z: 0.04 }
  const p = probe()
  const fit = fitStanding(field, on, eye, p)
  assert(fit === null && (p.reason === 'seen' || p.reason === 'border'), `a cushion seen through a small window is not a standing thing, got ${fit?.shape ?? p.reason}`)
  // A low table's edge, with the floor below: the top is cut off by the window, not by its own edge.
  const low = [slabHit(-1.5, 1.5, -0.05, 0, -1.5, 1.5), slabHit(-0.6, 0.6, 0.37, 0.4, -0.9, 0.1)]
  const lowEye = { x: 0, y: 1.1, z: 0.5 }
  seed = 32
  const lowField = new RoomField(0.02, 300, 2)
  for (let p = 0; p < 10; p++) look(lowField, lowEye, { x: 0, y: 0.4, z: 0.1 }, low, 0.3, 0.25)
  const pl = probe()
  const lowFit = fitStanding(lowField, { x: 0.01, y: 0.4, z: 0.03 }, lowEye, pl)
  assert(lowFit === null && (pl.reason === 'seen' || pl.reason === 'border'), `a table edge seen through a small window is not a standing thing, got ${lowFit?.shape ?? pl.reason}`)
  console.log(`small window: cushion edge ${p.reason}, low table edge ${pl.reason}`)
}

// ---- Cost: it runs a few times a second on the headset. ----
{
  const at = fitStanding(stackField, stackTop, EYE)
  assert(at !== null, 'the cost is measured on a real fit')
  const times: number[] = []
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now()
    fitStanding(stackField, stackTop, EYE)
    times.push(performance.now() - t0)
  }
  const lifts: number[] = []
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now()
    liftShell(stackField, stackTop, EYE)
    lifts.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  lifts.sort((a, b) => a - b)
  const builds: number[] = []
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now()
    if (at) buildStanding(at, EYE)
    builds.push(performance.now() - t0)
  }
  builds.sort((a, b) => a - b)
  console.log(`cost: fit ${times[50].toFixed(2)} ms, build ${builds[15].toFixed(2)} ms, liftShell ${lifts[15].toFixed(2)} ms (medians, n=47 block)`)
  assert(times[50] < 3, `the fit takes under 3 ms, got ${times[50].toFixed(2)} ms`)
}

console.log('stand ok')
