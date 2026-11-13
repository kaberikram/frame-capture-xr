/**
 * Lift one thing out of the room's distance field as a smooth shell.
 *
 * Pinch a vase on a table and the shell is the vase, not the table: the
 * surface joined to the pinch, with the flat thing it stands on left out.
 * Where the surface runs on past arm's reach (a wall, a sofa) the shell is a
 * round piece of it instead. This file is plain maths, so it is tested without
 * three.js.
 */

/** What the lift reads. `RoomField` is one; a test can be another. */
export interface FieldBlock {
  /** Metres to a voxel's side. */
  readonly voxel: number
  /** Values 1 (open air) to -1 (behind a surface), NaN where unseen. Voxel `i` is centred at `(i + 0.5) * voxel`. */
  grid(x0: number, y0: number, z0: number, nx: number, ny: number, nz: number, out?: Float32Array): Float32Array
}

export interface Shell {
  /** `object` is a whole thing. `piece` is a round piece of something bigger. */
  kind: 'object' | 'piece'
  /** World positions, xyz for each vertex. */
  positions: Float32Array
  indices: Uint32Array
  /** 1 where the shell ends and should fade out: the rim of a piece, the open edge of an object. 0 well inside. */
  edge: Float32Array
  cx: number
  cy: number
  cz: number
  /** Reach of the shell from its centre. */
  radius: number
  /** Its lowest point, for setting it down. */
  bottom: number
  /** How deep the shell is along the way the whole of it faces: near nothing for a wall. */
  relief: number
}

export interface LiftOptions {
  /** How far from the pinch an object may reach, metres. */
  reach?: number
  /** Radius of a piece cut from something bigger, metres. */
  piece?: number
}

/** A thing can reach this far from where it was pinched and still be one object. */
export const OBJECT_REACH = 0.42
/** Radius of a piece cut from something that runs on. */
export const PIECE_REACH = 0.19
/** A level surface with at least this much area in view is somewhere things stand, m². */
const STAND_AREA = 0.02
/** A level surface this big under the pinch is the table itself and not the top of a box, m². */
const TABLE_AREA = 0.12
/** A surface seen this edge-on is the smear between a thing and what is behind it. */
const GRAZE = 0.2
const MIN_CELLS = 10

let block = new Float32Array(0)
let work = {
  px: new Float32Array(0),
  py: new Float32Array(0),
  pz: new Float32Array(0),
  up: new Float32Array(0),
  facing: new Float32Array(0),
  surface: new Uint8Array(0),
  seen: new Uint8Array(0),
  vertexOf: new Int32Array(0),
}

/**
 * The shell around `seed`, a point on a surface. `eye` is where it is seen
 * from. Null when there is too little surface there to make anything.
 */
export function liftShell(
  field: FieldBlock,
  seed: { x: number; y: number; z: number; nx: number; ny: number; nz: number },
  eye: { x: number; y: number; z: number },
  options: LiftOptions = {},
): Shell | null {
  const v = field.voxel
  const reach = options.reach ?? OBJECT_REACH
  const pieceReach = options.piece ?? PIECE_REACH
  const half = Math.ceil(reach / v) + 2
  const n = half * 2 + 1
  const x0 = Math.floor(seed.x / v) - half
  const y0 = Math.floor(seed.y / v) - half
  const z0 = Math.floor(seed.z / v) - half
  if (block.length < n * n * n) block = new Float32Array(n * n * n)
  const values = field.grid(x0, y0, z0, n, n, n, block)

  // A cell is the cube between eight voxel centres. Where the field changes
  // sign inside it, the surface passes through, and the cell gets one vertex.
  const m = n - 1
  const cellCount = m * m * m
  // Kept between calls: this runs a few times a second while something has your attention.
  if (work.px.length < cellCount) {
    work = {
      px: new Float32Array(cellCount),
      py: new Float32Array(cellCount),
      pz: new Float32Array(cellCount),
      up: new Float32Array(cellCount),
      facing: new Float32Array(cellCount),
      surface: new Uint8Array(cellCount),
      seen: new Uint8Array(cellCount),
      vertexOf: new Int32Array(cellCount),
    }
  }
  const { px, py, pz, up, facing, surface } = work
  surface.fill(0, 0, cellCount)
  const nn = n * n
  let sx = 0
  let sy = 0
  let sz = 0
  let crossings = 0
  const cross = (a: number, b: number, ax: number, ay: number, az: number, dx: number, dy: number, dz: number) => {
    if (a !== a || b !== b || a > 0 === b > 0) return
    const t = a / (a - b)
    sx += ax + dx * t
    sy += ay + dy * t
    sz += az + dz * t
    crossings++
  }
  for (let k = 0; k < m; k++) {
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        const at = i + j * n + k * nn
        const c000 = values[at]
        const c100 = values[at + 1]
        const c010 = values[at + n]
        const c110 = values[at + n + 1]
        const c001 = values[at + nn]
        const c101 = values[at + nn + 1]
        const c011 = values[at + nn + n]
        const c111 = values[at + nn + n + 1]
        let known = 0
        let total = 0
        if (c000 === c000) { known++; total += c000 }
        if (c100 === c100) { known++; total += c100 }
        if (c010 === c010) { known++; total += c010 }
        if (c110 === c110) { known++; total += c110 }
        if (c001 === c001) { known++; total += c001 }
        if (c101 === c101) { known++; total += c101 }
        if (c011 === c011) { known++; total += c011 }
        if (c111 === c111) { known++; total += c111 }
        // Depth only sees a voxel or so into a surface, so a cube that straddles
        // one often has a corner nobody saw. Half of them is enough to go on.
        if (known < 4) continue
        const above =
          (c000 > 0 ? 1 : 0) + (c100 > 0 ? 1 : 0) + (c010 > 0 ? 1 : 0) + (c110 > 0 ? 1 : 0) +
          (c001 > 0 ? 1 : 0) + (c101 > 0 ? 1 : 0) + (c011 > 0 ? 1 : 0) + (c111 > 0 ? 1 : 0)
        if (above === 0 || above === known) continue
        // The vertex: the middle of the places where the cube's edges cross the surface.
        sx = 0
        sy = 0
        sz = 0
        crossings = 0
        cross(c000, c100, 0, 0, 0, 1, 0, 0)
        cross(c010, c110, 0, 1, 0, 1, 0, 0)
        cross(c001, c101, 0, 0, 1, 1, 0, 0)
        cross(c011, c111, 0, 1, 1, 1, 0, 0)
        cross(c000, c010, 0, 0, 0, 0, 1, 0)
        cross(c100, c110, 1, 0, 0, 0, 1, 0)
        cross(c001, c011, 0, 0, 1, 0, 1, 0)
        cross(c101, c111, 1, 0, 1, 0, 1, 0)
        cross(c000, c001, 0, 0, 0, 0, 0, 1)
        cross(c100, c101, 1, 0, 0, 0, 0, 1)
        cross(c010, c011, 0, 1, 0, 0, 0, 1)
        cross(c110, c111, 1, 1, 0, 0, 0, 1)
        if (crossings === 0) continue
        const cell = i + j * m + k * m * m
        const wx = (x0 + i + 0.5 + sx / crossings) * v
        const wy = (y0 + j + 0.5 + sy / crossings) * v
        const wz = (z0 + k + 0.5 + sz / crossings) * v
        px[cell] = wx
        py[cell] = wy
        pz[cell] = wz
        // The way the surface faces: up the field's slope, toward open air.
        const fill = total / known
        const f000 = c000 === c000 ? c000 : fill
        const f100 = c100 === c100 ? c100 : fill
        const f010 = c010 === c010 ? c010 : fill
        const f110 = c110 === c110 ? c110 : fill
        const f001 = c001 === c001 ? c001 : fill
        const f101 = c101 === c101 ? c101 : fill
        const f011 = c011 === c011 ? c011 : fill
        const f111 = c111 === c111 ? c111 : fill
        let gx = f100 + f110 + f101 + f111 - f000 - f010 - f001 - f011
        let gy = f010 + f110 + f011 + f111 - f000 - f100 - f001 - f101
        let gz = f001 + f101 + f011 + f111 - f000 - f100 - f010 - f110
        const gl = Math.hypot(gx, gy, gz) || 1
        gx /= gl
        gy /= gl
        gz /= gl
        up[cell] = gy
        const ex = eye.x - wx
        const ey = eye.y - wy
        const ez = eye.z - wz
        const el = Math.hypot(ex, ey, ez) || 1
        facing[cell] = Math.abs((gx * ex + gy * ey + gz * ez) / el)
        surface[cell] = 1
      }
    }
  }

  // The cell the pinch is on.
  const si = Math.round(seed.x / v - 0.5) - x0
  const sj = Math.round(seed.y / v - 0.5) - y0
  const sk = Math.round(seed.z / v - 0.5) - z0
  let start = -1
  let startD = Infinity
  for (let k = Math.max(0, sk - 3); k <= Math.min(m - 1, sk + 2); k++) {
    for (let j = Math.max(0, sj - 3); j <= Math.min(m - 1, sj + 2); j++) {
      for (let i = Math.max(0, si - 3); i <= Math.min(m - 1, si + 2); i++) {
        const cell = i + j * m + k * m * m
        if (!surface[cell]) continue
        const d = Math.hypot(px[cell] - seed.x, py[cell] - seed.y, pz[cell] - seed.z)
        if (d < startD) {
          startD = d
          start = cell
        }
      }
    }
  }
  if (start < 0 || startD > v * 3) return null

  // Level surfaces in view, by height: where things stand.
  const levels = new Float32Array(m)
  for (let cell = 0; cell < cellCount; cell++) {
    if (!surface[cell] || up[cell] < 0.8) continue
    const row = Math.floor(py[cell] / v) - y0
    if (row >= 0 && row < m) levels[row] += 1
  }
  const area = (row: number) => ((levels[row - 1] ?? 0) + levels[row] + (levels[row + 1] ?? 0)) * v * v
  const seedRow = Math.floor(py[start] / v) - y0
  const onLevel = up[start] > 0.8
  // The pinch is on a table when the level surface under it is a big one.
  const onTable = onLevel && area(seedRow) >= TABLE_AREA
  let floor = -Infinity
  if (!onTable) {
    // The nearest level surface below the pinch that is big enough to stand on.
    // The top of the thing itself does not count.
    for (let row = onLevel ? seedRow - 2 : seedRow; row >= 1; row--) {
      if (area(row) < STAND_AREA || levels[row] < levels[row - 1] || levels[row] < (levels[row + 1] ?? 0)) continue
      if (onLevel && area(row) < area(seedRow)) continue
      floor = (y0 + row + 0.5) * v + v * 0.8
      break
    }
  }

  const fill = (limit: number, bottom: number): { cells: number[]; open: boolean } => {
    const seen = work.seen
    seen.fill(0, 0, cellCount)
    const cells: number[] = [start]
    seen[start] = 1
    let open = false
    const limit2 = limit * limit
    for (let head = 0; head < cells.length; head++) {
      const cell = cells[head]
      const i = cell % m
      const j = Math.floor(cell / m) % m
      const k = Math.floor(cell / (m * m))
      for (let dk = -1; dk <= 1; dk++) {
        const kk = k + dk
        if (kk < 0 || kk >= m) continue
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj
          if (jj < 0 || jj >= m) continue
          for (let di = -1; di <= 1; di++) {
            const ii = i + di
            if (ii < 0 || ii >= m) continue
            const next = ii + jj * m + kk * m * m
            if (seen[next] || !surface[next]) continue
            seen[next] = 1
            if (py[next] <= bottom) continue
            if (facing[next] < GRAZE) continue
            const dx = px[next] - seed.x
            const dy = py[next] - seed.y
            const dz = pz[next] - seed.z
            if (dx * dx + dy * dy + dz * dz > limit2) {
              open = true
              continue
            }
            cells.push(next)
          }
        }
      }
    }
    return { cells, open }
  }

  let kind: Shell['kind'] = 'object'
  let filled = onTable ? { cells: [], open: true } : fill(reach, floor)
  if (filled.open) {
    // It runs on past reach, so it is not one thing. Take a round piece of it.
    kind = 'piece'
    filled = fill(pieceReach, floor)
  }
  if (filled.cells.length < MIN_CELLS) return null

  // Join the cells: every voxel edge the surface crosses is shared by four cells, which make a quad.
  const vertexOf = work.vertexOf
  vertexOf.fill(-1, 0, cellCount)
  const cells = filled.cells
  for (let c = 0; c < cells.length; c++) vertexOf[cells[c]] = c
  let positions: Float32Array = new Float32Array(cells.length * 3)
  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c]
    positions[c * 3] = px[cell]
    positions[c * 3 + 1] = py[cell]
    positions[c * 3 + 2] = pz[cell]
  }
  const indices: number[] = []
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    const va = vertexOf[a]
    const vb = vertexOf[b]
    const vc = vertexOf[c]
    const vd = vertexOf[d]
    if (va < 0 || vb < 0 || vc < 0 || vd < 0) return
    if (flip) indices.push(va, vc, vb, va, vd, vc)
    else indices.push(va, vb, vc, va, vc, vd)
  }
  const along = (here: number, there: number, a: number, b: number, c: number, d: number) => {
    if (there !== there || here > 0 === there > 0) return
    quad(a, b, c, d, here > 0)
  }
  const mm = m * m
  for (let k = 1; k < m; k++) {
    for (let j = 1; j < m; j++) {
      for (let i = 1; i < m; i++) {
        const at = i + j * n + k * nn
        const here = values[at]
        if (here !== here) continue
        const cell = i + j * m + k * mm
        // The four cells around each of the three edges leaving this voxel.
        along(here, values[at + 1], cell - m - mm, cell - mm, cell, cell - m)
        along(here, values[at + n], cell - 1 - mm, cell - 1, cell, cell - mm)
        along(here, values[at + nn], cell - 1 - m, cell - m, cell, cell - 1)
      }
    }
  }
  if (indices.length < 12) return null

  // Fusing depth spreads each reading a voxel sideways, so the shell's open
  // edge reaches a voxel past the thing and would wear the background there.
  // A piece's edge fades out anyway.
  const kept = kind === 'object' ? trimRim(indices, cells.length) : indices
  if (kept !== indices && kept.length >= 12) {
    indices.length = 0
    for (let i = 0; i < kept.length; i++) indices.push(kept[i])
  }
  positions = compact(positions, indices)
  cells.length = positions.length / 3

  smooth(positions, indices, 2)

  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let c = 0; c < cells.length; c++) {
    const x = positions[c * 3]
    const y = positions[c * 3 + 1]
    const z = positions[c * 3 + 2]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  // A piece is centred on the pinch, so its soft rim is even all round.
  const cx = kind === 'piece' ? seed.x : (minX + maxX) / 2
  const cy = kind === 'piece' ? seed.y : (minY + maxY) / 2
  const cz = kind === 'piece' ? seed.z : (minZ + maxZ) / 2
  let radius = 0
  let lo = Infinity
  let hi = -Infinity
  const edge = new Float32Array(cells.length)
  for (let c = 0; c < cells.length; c++) {
    const dx = positions[c * 3] - cx
    const dy = positions[c * 3 + 1] - cy
    const dz = positions[c * 3 + 2] - cz
    const d = Math.hypot(dx, dy, dz)
    if (d > radius) radius = d
    edge[c] = d
  }
  // How much shape it has: its depth along the way the whole of it faces. The
  // facing at the pinch alone is too rough to tell a wall from a cushion.
  let ax = 0
  let ay = 0
  let az = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3
    const b = indices[t + 1] * 3
    const c = indices[t + 2] * 3
    const ux = positions[b] - positions[a]
    const uy = positions[b + 1] - positions[a + 1]
    const uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a]
    const vy = positions[c + 1] - positions[a + 1]
    const vz = positions[c + 2] - positions[a + 2]
    ax += uy * vz - uz * vy
    ay += uz * vx - ux * vz
    az += ux * vy - uy * vx
  }
  const al = Math.hypot(ax, ay, az)
  if (al > 1e-9) {
    ax /= al
    ay /= al
    az /= al
  } else {
    ax = seed.nx
    ay = seed.ny
    az = seed.nz
  }
  for (let c = 0; c < cells.length; c++) {
    const out = positions[c * 3] * ax + positions[c * 3 + 1] * ay + positions[c * 3 + 2] * az
    if (out < lo) lo = out
    if (out > hi) hi = out
  }
  if (kind === 'piece') {
    // The rim is wherever the cut came out, which smoothing pulls in a little.
    for (let c = 0; c < cells.length; c++) edge[c] = radius > 0 ? edge[c] / radius : 0
  } else {
    // A whole thing ends where the eye stopped seeing it. That edge is feathered.
    edge.fill(0)
    const open = openEdge(indices, cells.length)
    for (let c = 0; c < cells.length; c++) if (open[c]) edge[c] = 1
  }
  return {
    kind,
    positions,
    indices: Uint32Array.from(indices),
    edge,
    cx,
    cy,
    cz,
    radius: kind === 'piece' ? Math.min(radius, pieceReach) : radius,
    bottom: minY,
    relief: hi - lo,
  }
}

/** Marks the vertices on the mesh's open edge: those on an edge only one triangle uses. */
function openEdge(indices: readonly number[], count: number): Uint8Array {
  const uses = new Map<number, number>()
  const key = (a: number, b: number) => (a < b ? a * count + b : b * count + a)
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const k = key(indices[t + e], indices[t + ((e + 1) % 3)])
      uses.set(k, (uses.get(k) ?? 0) + 1)
    }
  }
  const rim = new Uint8Array(count)
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e]
      const b = indices[t + ((e + 1) % 3)]
      if (uses.get(key(a, b)) === 1) {
        rim[a] = 1
        rim[b] = 1
      }
    }
  }
  return rim
}

/** Drop the triangles along the mesh's open edge: one ring of them. */
function trimRim(indices: readonly number[], count: number): number[] {
  const rim = openEdge(indices, count)
  const kept: number[] = []
  for (let t = 0; t < indices.length; t += 3) {
    if (rim[indices[t]] || rim[indices[t + 1]] || rim[indices[t + 2]]) continue
    kept.push(indices[t], indices[t + 1], indices[t + 2])
  }
  return kept
}

/** The vertices that triangles use, closed up, with `indices` renumbered to match. */
function compact(positions: Float32Array, indices: number[]): Float32Array {
  const slot = new Int32Array(positions.length / 3).fill(-1)
  const out = new Float32Array(positions.length)
  let next = 0
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]
    if (slot[v] < 0) {
      slot[v] = next
      out[next * 3] = positions[v * 3]
      out[next * 3 + 1] = positions[v * 3 + 1]
      out[next * 3 + 2] = positions[v * 3 + 2]
      next++
    }
    indices[i] = slot[v]
  }
  return out.slice(0, next * 3)
}

/** Ease every vertex toward the middle of its neighbours, so voxel steps and depth noise soften. */
function smooth(positions: Float32Array, indices: readonly number[], passes: number): void {
  const count = positions.length / 3
  const sum = new Float32Array(count * 3)
  const links = new Uint16Array(count)
  for (let pass = 0; pass < passes; pass++) {
    sum.fill(0)
    links.fill(0)
    for (let t = 0; t < indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = indices[t + e]
        const b = indices[t + ((e + 1) % 3)]
        sum[a * 3] += positions[b * 3]
        sum[a * 3 + 1] += positions[b * 3 + 1]
        sum[a * 3 + 2] += positions[b * 3 + 2]
        links[a]++
      }
    }
    for (let c = 0; c < count; c++) {
      if (links[c] === 0) continue
      for (let axis = 0; axis < 3; axis++) {
        const at = c * 3 + axis
        positions[at] += (sum[at] / links[c] - positions[at]) * 0.5
      }
    }
  }
}
