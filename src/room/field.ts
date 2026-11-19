/**
 * A sparse distance field for the room, in world metres.
 * Chunks are small so a later ghost replay can snapshot one at a time
 * without copying the whole room. This file stays free of three.js so the
 * fusion and the mesh extraction can be tested on their own.
 */

export const VOXEL = 0.04
export const CHUNK = 8
const CELLS = CHUNK * CHUNK * CHUNK
const MIN_WEIGHT = 2
/** A few metres of nearby surface. Older chunks leave once the view moves on. */
export const MAX_CHUNKS = 420
const MAX_SAMPLES = 700
/** A reading clears what the field holds in front of it from this far out, metres: nearer is the headset itself. */
const CLEAR_FROM = 0.25
/**
 * And only this far out, metres: past arm's reach, a hand that was in the way
 * is gone and a thing moved is rarely what the hand is after. The rest of the
 * way to a far wall would cost more than it gives.
 */
const CLEAR_REACH = 1.5
/**
 * The field must say a point is behind a surface (below this) before a
 * reading that passed through it counts against it. A ray that only grazes a
 * thing, or skims along a table, passes outside it and leaves it be.
 */
const CLEAR_INSIDE = 0

export interface DepthSample {
  ox: number
  oy: number
  oz: number
  px: number
  py: number
  pz: number
  /** The way the surface faces there, when its neighbours in the depth image say. The reading is then spread along the surface. */
  nx?: number
  ny?: number
  nz?: number
  /**
   * On the near side of a depth jump: the edge of a thing seen against what is
   * behind it. The reading is not spread sideways and writes only half a voxel
   * behind itself, so the thing does not grow into the space it hides.
   */
  edge?: boolean
  /**
   * Well behind a reading next to it: the ray passed close by the edge of a
   * nearer thing, or read too far. It does not clear the space it crossed, so
   * the corners of a thing are not worn away by rays that only skim them.
   */
  past?: boolean
}

export interface RoomHit {
  x: number
  y: number
  z: number
  nx: number
  ny: number
  nz: number
  dist: number
}

/** One chunk's field. A replay can turn a ring of these back into meshes. */
export interface ChunkSnapshot {
  key: string
  voxel: number
  tsdf: Int8Array
  weight: Uint8Array
}

export interface ChunkMesh {
  key: string
  /** Triangle soup, xyzxyz… */
  positions: Float32Array
  normals: Float32Array
}

interface Chunk {
  key: string
  ix: number
  iy: number
  iz: number
  tsdf: Int8Array
  weight: Uint8Array
  seen: number
  dirty: boolean
  /** Its smooth mesh is out of date. */
  stale: boolean
  positions: Float32Array
  normals: Float32Array
}

interface Tri {
  ax: number
  ay: number
  az: number
  bx: number
  by: number
  bz: number
  cx: number
  cy: number
  cz: number
  nx: number
  ny: number
  nz: number
}

/** A surface point and the direction it faces, written into by the lookups that run every frame. */
export interface SurfacePoint {
  x: number
  y: number
  z: number
  nx: number
  ny: number
  nz: number
  dist: number
}

export function surfacePoint(): SurfacePoint {
  return { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, dist: 0 }
}

/** One chunk of the live mesh: a smooth surface through the field, in world metres. Empty when the chunk holds no surface. */
export interface NetMesh {
  key: string
  positions: Float32Array
  indices: Uint16Array
}

const netBlock = new Float32Array((CHUNK + 2) ** 3)
const netVertex = new Int32Array((CHUNK + 1) ** 3)
/** The eight corners of a cube, and its twelve edges as a corner and a direction. */
const NET_CORNER = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]
const NET_EDGE = [
  0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0,
  0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0,
  0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1,
]

/** One number for a chunk's place, so a lookup does not build a string. Good for ±160 m. */
function chunkId(cx: number, cy: number, cz: number): number {
  return (cx + 512) * 1048576 + (cy + 512) * 1024 + (cz + 512)
}

export class RoomField {
  private readonly chunks = new Map<string, Chunk>()
  private readonly byId = new Map<number, Chunk>()
  private readonly grad = { x: 0, y: 0, z: 0 }
  private readonly tris: Tri[] = []
  private retired: string[] = []
  private soupStale = false
  private clock = 0
  /** Metres to a voxel's side. */
  readonly voxel: number
  private readonly trunc: number
  private readonly maxChunks: number

  private readonly behind: number
  /**
   * Each reading clears what the field holds along the way to it (see
   * `clearAlong`). Off unless asked for: a glossy top that mirrors the room is
   * read as far away, and clearing would then wear the real top away.
   */
  clears = false
  /** Counts readings, so every other one clears the space it crossed. */
  private clearTurn = 0
  /** Chunks this near a point are not let go of: see `keep`. */
  private readonly kept = { x: 0, y: 0, z: 0, r2: 0 }

  /**
   * A finer `voxel` keeps small things; `maxChunks` then bounds how much of
   * the room it holds. `behind` is how far past a surface each reading is
   * written, in voxels: 2 gives a shell thick enough to mesh from any side.
   */
  constructor(voxel = VOXEL, maxChunks = MAX_CHUNKS, behind = 1) {
    this.voxel = voxel
    this.trunc = voxel * 2
    this.maxChunks = maxChunks
    this.behind = behind * voxel
  }

  get chunkCount(): number {
    return this.chunks.size
  }

  /** Forget everything, for when the room being looked at is a different one. */
  clear(): void {
    this.chunks.clear()
    this.byId.clear()
    this.tris.length = 0
    this.retired = []
    this.soupStale = false
  }

  /**
   * Hold on to everything within `radius` of a point when room runs out, for
   * what has your attention. A hand reaching for a thing hides it from depth,
   * so its chunks are the ones written least lately, and would be the first
   * to go just when they are wanted. A radius of 0 holds on to nothing.
   */
  keep(x: number, y: number, z: number, radius: number): void {
    this.kept.x = x
    this.kept.y = y
    this.kept.z = z
    this.kept.r2 = radius * radius
  }

  /** Fuse surface samples. Each sample is a camera origin and a point on the surface. */
  integrate(samples: readonly DepthSample[]): number {
    return this.integrateRange(samples, 0, samples.length, true)
  }

  /**
   * Fuse a slice of a depth frame. `fresh` starts a new frame so chunks written
   * earlier in that same frame are not treated as old and discarded. `step` is
   * the angle between neighbouring readings, in radians, when it is known.
   */
  integrateRange(samples: readonly DepthSample[], start: number, end: number, fresh: boolean, step = 0): number {
    if (fresh) this.clock += 1
    const from = Math.max(0, start)
    const to = Math.min(samples.length, end, from + MAX_SAMPLES)
    let used = 0
    for (let i = from; i < to; i++) {
      if (this.integrateOne(samples[i], step)) used += 1
    }
    return used
  }

  /**
   * Forget the surface inside a sphere, and keep later depth from healing it.
   * The mesh grows a hole there on the next extract.
   */
  carve(x: number, y: number, z: number, radius: number): void {
    const r2 = radius * radius
    const reach = Math.ceil(radius / this.voxel) + 1
    const gx = Math.floor(x / this.voxel)
    const gy = Math.floor(y / this.voxel)
    const gz = Math.floor(z / this.voxel)
    for (let iz = gz - reach; iz <= gz + reach; iz++) {
      for (let iy = gy - reach; iy <= gy + reach; iy++) {
        for (let ix = gx - reach; ix <= gx + reach; ix++) {
          const cx = (ix + 0.5) * this.voxel
          const cy = (iy + 0.5) * this.voxel
          const cz = (iz + 0.5) * this.voxel
          const dx = cx - x
          const dy = cy - y
          const dz = cz - z
          if (dx * dx + dy * dy + dz * dz > r2) continue
          const cell = this.cell(ix, iy, iz, false)
          if (!cell) continue
          cell.chunk.tsdf[cell.index] = 127
          cell.chunk.weight[cell.index] = 32
          cell.chunk.dirty = true
          cell.chunk.stale = true
          cell.chunk.seen = this.clock
        }
      }
    }
    this.dropTrisNear(x, y, z, radius)
  }

  /** Let depth fill a carved place in again, for when a hole closes. */
  heal(x: number, y: number, z: number, radius: number): void {
    const r2 = radius * radius
    const reach = Math.ceil(radius / this.voxel) + 1
    const gx = Math.floor(x / this.voxel)
    const gy = Math.floor(y / this.voxel)
    const gz = Math.floor(z / this.voxel)
    for (let iz = gz - reach; iz <= gz + reach; iz++) {
      for (let iy = gy - reach; iy <= gy + reach; iy++) {
        for (let ix = gx - reach; ix <= gx + reach; ix++) {
          const dx = (ix + 0.5) * this.voxel - x
          const dy = (iy + 0.5) * this.voxel - y
          const dz = (iz + 0.5) * this.voxel - z
          if (dx * dx + dy * dy + dz * dz > r2) continue
          const cell = this.cell(ix, iy, iz, false)
          if (!cell || cell.chunk.weight[cell.index] < 32) continue
          cell.chunk.tsdf[cell.index] = 0
          cell.chunk.weight[cell.index] = 0
          cell.chunk.dirty = true
          cell.chunk.stale = true
        }
      }
    }
  }

  /**
   * The field at a point, smoothly blended between voxels: 1 is clear air a
   * truncation in front of a surface, 0 is the surface, negative is behind it.
   * Null where the room has not been seen.
   */
  sdf(x: number, y: number, z: number): number | null {
    const fx = x / this.voxel - 0.5
    const fy = y / this.voxel - 0.5
    const fz = z / this.voxel - 0.5
    const gx = Math.floor(fx)
    const gy = Math.floor(fy)
    const gz = Math.floor(fz)
    const tx = fx - gx
    const ty = fy - gy
    const tz = fz - gz
    const c000 = this.value(gx, gy, gz)
    const c100 = this.value(gx + 1, gy, gz)
    const c010 = this.value(gx, gy + 1, gz)
    const c110 = this.value(gx + 1, gy + 1, gz)
    const c001 = this.value(gx, gy, gz + 1)
    const c101 = this.value(gx + 1, gy, gz + 1)
    const c011 = this.value(gx, gy + 1, gz + 1)
    const c111 = this.value(gx + 1, gy + 1, gz + 1)
    const sum = c000 + c100 + c010 + c110 + c001 + c101 + c011 + c111
    if (sum !== sum) return this.patchy(c000, c100, c010, c110, c001, c101, c011, c111, tx, ty, tz)
    const x00 = c000 + (c100 - c000) * tx
    const x10 = c010 + (c110 - c010) * tx
    const x01 = c001 + (c101 - c001) * tx
    const x11 = c011 + (c111 - c011) * tx
    const y0 = x00 + (x10 - x00) * ty
    const y1 = x01 + (x11 - x01) * ty
    return y0 + (y1 - y0) * tz
  }

  /**
   * March a ray through the field to the first place it passes from in front
   * of a surface to behind it. Costs a few lookups per step, whatever the size
   * of the room, so a whole grid of these fits in a frame. Unseen space is
   * stepped over. `out` is filled in and returned, or null when nothing is met.
   */
  surfaceAlong(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    reach: number,
    out: SurfacePoint,
  ): SurfacePoint | null {
    const len = Math.hypot(dx, dy, dz)
    if (len < 1e-6) return null
    const ix = dx / len
    const iy = dy / len
    const iz = dz / len
    const step = this.voxel * 0.5
    let prev: number | null = null
    for (let t = 0; t <= reach + step; t += step) {
      const s = this.sdf(ox + ix * t, oy + iy * t, oz + iz * t)
      if (s !== null && prev !== null && prev > 0 && s <= 0) {
        const at = t - step + (step * prev) / (prev - s)
        if (at > reach) return null
        out.x = ox + ix * at
        out.y = oy + iy * at
        out.z = oz + iz * at
        out.dist = at
        this.face(out, -ix, -iy, -iz)
        return out
      }
      prev = s
    }
    return null
  }

  /**
   * The same march, returning only how far along the ray the surface is, or -1.
   * Cheaper than `surfaceAlong` when the facing is not needed.
   */
  depthAlong(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, reach: number): number {
    const step = this.voxel * 0.5
    let prev: number | null = null
    for (let t = 0; t <= reach + step; t += step) {
      const s = this.sdf(ox + dx * t, oy + dy * t, oz + dz * t)
      if (s !== null && prev !== null && prev > 0 && s <= 0) {
        const at = t - step + (step * prev) / (prev - s)
        return at > reach ? -1 : at
      }
      prev = s
    }
    return -1
  }

  /**
   * The surface next to a point that is already within `maxDist` of it, for a
   * pinch on the room. Null in open air and over a place that was peeled away.
   */
  near(x: number, y: number, z: number, maxDist: number, out: SurfacePoint): SurfacePoint | null {
    const s = this.sdf(x, y, z)
    if (s === null || s >= 0.98 || s <= -0.98) return null
    const d = s * this.trunc
    if (Math.abs(d) > maxDist) return null
    out.x = x
    out.y = y
    out.z = z
    if (!this.face(out, 0, 0, 0)) return null
    out.x = x - out.nx * d
    out.y = y - out.ny * d
    out.z = z - out.nz * d
    // The field is only roughly a distance, so step once more onto the surface.
    const again = this.sdf(out.x, out.y, out.z)
    if (again !== null && again > -0.98 && again < 0.98) {
      out.x -= out.nx * again * this.trunc
      out.y -= out.ny * again * this.trunc
      out.z -= out.nz * again * this.trunc
    }
    out.dist = Math.abs(d)
    return out
  }

  /**
   * Rebuild at most `budget` dirty chunks and refresh the raycast soup.
   * When `near` is set, the chunks in front of that point go first.
   */
  extract(budget: number, near?: { x: number; y: number; z: number }, soup = true): ChunkMesh[] {
    const built: ChunkMesh[] = []
    const dirty: Chunk[] = []
    for (const chunk of this.chunks.values()) if (chunk.dirty) dirty.push(chunk)
    if (near && dirty.length > 1) {
      const nx = near.x
      const ny = near.y
      const nz = near.z
      const v = this.voxel
      dirty.sort((a, b) => chunkDist(a, nx, ny, nz, v) - chunkDist(b, nx, ny, nz, v))
    }
    const n = Math.min(budget, dirty.length)
    for (let i = 0; i < n; i++) built.push(this.buildChunk(dirty[i]))
    // `raycast` and `closest` read the soup. A caller that only marches the field can skip it.
    if (soup && (built.length > 0 || this.soupStale)) {
      this.rebuildTris()
      this.soupStale = false
    }
    return built
  }

  /**
   * Chunks dropped since the last call. A ghost replay would snapshot a chunk
   * before it appears here; the live field has already let it go.
   */
  takeRetired(): string[] {
    if (this.retired.length === 0) return this.retired
    const out = this.retired
    this.retired = []
    return out
  }

  /** Closest surface to a point, for a pinch that is already on the room. */
  closest(x: number, y: number, z: number, maxDist: number): RoomHit | null {
    let best: RoomHit | null = null
    let bestD = maxDist
    for (let i = 0; i < this.tris.length; i++) {
      const tri = this.tris[i]
      const cx = (tri.ax + tri.bx + tri.cx) / 3
      const cy = (tri.ay + tri.by + tri.cy) / 3
      const cz = (tri.az + tri.bz + tri.cz) / 3
      const dx = x - cx
      const dy = y - cy
      const dz = z - cz
      const d = Math.hypot(dx, dy, dz)
      if (d >= bestD) continue
      const plane = (x - tri.ax) * tri.nx + (y - tri.ay) * tri.ny + (z - tri.az) * tri.nz
      bestD = d
      best = {
        x: x - tri.nx * plane,
        y: y - tri.ny * plane,
        z: z - tri.nz * plane,
        nx: tri.nx,
        ny: tri.ny,
        nz: tri.nz,
        dist: Math.abs(plane),
      }
    }
    return best
  }

  /**
   * First surface a ray meets, or null. `slop` lets a ray that passes close to a
   * tile count, so a coarse scan can still be pinched between its faces.
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    reach: number,
    slop = 0,
  ): RoomHit | null {
    const len = Math.hypot(dx, dy, dz)
    if (len < 1e-6) return null
    const ix = dx / len
    const iy = dy / len
    const iz = dz / len
    let best: RoomHit | null = null
    let bestT = reach
    let loose: RoomHit | null = null
    let looseT = reach
    const slop2 = slop * slop
    for (let i = 0; i < this.tris.length; i++) {
      const tri = this.tris[i]
      const hit = rayTri(ox, oy, oz, ix, iy, iz, tri)
      if (hit !== null && hit < bestT && hit >= 0.02) {
        bestT = hit
        best = {
          x: ox + ix * hit,
          y: oy + iy * hit,
          z: oz + iz * hit,
          nx: tri.nx,
          ny: tri.ny,
          nz: tri.nz,
          dist: hit,
        }
        continue
      }
      if (slop <= 0 || best) continue
      const cx = (tri.ax + tri.bx + tri.cx) / 3
      const cy = (tri.ay + tri.by + tri.cy) / 3
      const cz = (tri.az + tri.bz + tri.cz) / 3
      const t = (cx - ox) * ix + (cy - oy) * iy + (cz - oz) * iz
      if (t < 0.05 || t >= looseT) continue
      const px = ox + ix * t
      const py = oy + iy * t
      const pz = oz + iz * t
      const ex = cx - px
      const ey = cy - py
      const ez = cz - pz
      if (ex * ex + ey * ey + ez * ez > slop2) continue
      const plane = (px - tri.ax) * tri.nx + (py - tri.ay) * tri.ny + (pz - tri.az) * tri.nz
      looseT = t
      loose = {
        x: px - tri.nx * plane,
        y: py - tri.ny * plane,
        z: pz - tri.nz * plane,
        nx: tri.nx,
        ny: tri.ny,
        nz: tri.nz,
        dist: t,
      }
    }
    return best ?? loose
  }

  /**
   * A solid block of the field, for work that visits every voxel in a region.
   * `x0`, `y0`, `z0` are voxel indices; voxel `i` is centred at `(i + 0.5) * voxel`.
   * Values run 1 (open air) to -1 (behind a surface), NaN where unseen.
   */
  grid(x0: number, y0: number, z0: number, nx: number, ny: number, nz: number, out?: Float32Array): Float32Array {
    const values = out && out.length >= nx * ny * nz ? out : new Float32Array(nx * ny * nz)
    values.fill(NaN, 0, nx * ny * nz)
    const c0x = Math.floor(x0 / CHUNK)
    const c0y = Math.floor(y0 / CHUNK)
    const c0z = Math.floor(z0 / CHUNK)
    const c1x = Math.floor((x0 + nx - 1) / CHUNK)
    const c1y = Math.floor((y0 + ny - 1) / CHUNK)
    const c1z = Math.floor((z0 + nz - 1) / CHUNK)
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          const chunk = this.byId.get(chunkId(cx, cy, cz))
          if (!chunk) continue
          const bx = cx * CHUNK
          const by = cy * CHUNK
          const bz = cz * CHUNK
          const fromZ = Math.max(bz, z0)
          const toZ = Math.min(bz + CHUNK, z0 + nz)
          const fromY = Math.max(by, y0)
          const toY = Math.min(by + CHUNK, y0 + ny)
          const fromX = Math.max(bx, x0)
          const toX = Math.min(bx + CHUNK, x0 + nx)
          for (let z = fromZ; z < toZ; z++) {
            for (let y = fromY; y < toY; y++) {
              let src = fromX - bx + (y - by) * CHUNK + (z - bz) * CHUNK * CHUNK
              let dst = fromX - x0 + (y - y0) * nx + (z - z0) * nx * ny
              for (let x = fromX; x < toX; x++, src++, dst++) {
                if (chunk.weight[src] >= MIN_WEIGHT) values[dst] = chunk.tsdf[src] / 127
              }
            }
          }
        }
      }
    }
    return values
  }

  /**
   * Smooth meshes (surface nets) for chunks whose field has changed, nearest
   * to `near` first, until `budgetMs` is spent. Each chunk meshes the cubes it
   * owns and reads one voxel into its neighbours, so chunks join without gaps.
   * This is the live mesh: call it every frame with a small budget.
   */
  netStale(budgetMs: number, near: { x: number; y: number; z: number }, reach: number): NetMesh[] {
    const out: NetMesh[] = []
    const v = this.voxel
    const stale: Chunk[] = []
    const r2 = (reach + CHUNK * v) * (reach + CHUNK * v)
    for (const chunk of this.chunks.values()) {
      if (chunk.stale && chunkDist(chunk, near.x, near.y, near.z, v) <= r2) stale.push(chunk)
    }
    if (stale.length === 0) return out
    stale.sort((a, b) => chunkDist(a, near.x, near.y, near.z, v) - chunkDist(b, near.x, near.y, near.z, v))
    const start = performance.now()
    for (let i = 0; i < stale.length; i++) {
      out.push(this.netChunk(stale[i]))
      if (performance.now() - start > budgetMs) break
    }
    return out
  }

  private netChunk(chunk: Chunk): NetMesh {
    chunk.stale = false
    const v = this.voxel
    // Voxels -1..CHUNK of this chunk: the cubes between them are cells -1..CHUNK-1.
    const n = CHUNK + 2
    const m = n - 1
    const x0 = chunk.ix * CHUNK - 1
    const y0 = chunk.iy * CHUNK - 1
    const z0 = chunk.iz * CHUNK - 1
    const values = this.grid(x0, y0, z0, n, n, n, netBlock)
    const nn = n * n
    const mm = m * m
    const vertexOf = netVertex
    vertexOf.fill(-1)
    const positions: number[] = []
    for (let k = 0; k < m; k++) {
      for (let j = 0; j < m; j++) {
        for (let i = 0; i < m; i++) {
          const at = i + j * n + k * nn
          let sx = 0
          let sy = 0
          let sz = 0
          let crossings = 0
          let known = 0
          for (let c = 0; c < 8; c++) {
            const value = values[at + NET_CORNER[c * 3] + NET_CORNER[c * 3 + 1] * n + NET_CORNER[c * 3 + 2] * nn]
            if (value === value) known++
          }
          if (known < 4) continue
          for (let e = 0; e < 12; e++) {
            const ax = NET_EDGE[e * 6]
            const ay = NET_EDGE[e * 6 + 1]
            const az = NET_EDGE[e * 6 + 2]
            const dx = NET_EDGE[e * 6 + 3]
            const dy = NET_EDGE[e * 6 + 4]
            const dz = NET_EDGE[e * 6 + 5]
            const a = values[at + ax + ay * n + az * nn]
            const b = values[at + ax + dx + (ay + dy) * n + (az + dz) * nn]
            if (a !== a || b !== b || a > 0 === b > 0) continue
            const t = a / (a - b)
            sx += ax + dx * t
            sy += ay + dy * t
            sz += az + dz * t
            crossings++
          }
          if (crossings === 0) continue
          vertexOf[i + j * m + k * mm] = positions.length / 3
          positions.push((x0 + i + 0.5 + sx / crossings) * v, (y0 + j + 0.5 + sy / crossings) * v, (z0 + k + 0.5 + sz / crossings) * v)
        }
      }
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
    // The voxel edges this chunk owns start at its own voxels: block indices 1..CHUNK.
    for (let k = 1; k <= CHUNK; k++) {
      for (let j = 1; j <= CHUNK; j++) {
        for (let i = 1; i <= CHUNK; i++) {
          const at = i + j * n + k * nn
          const here = values[at]
          if (here !== here) continue
          const cell = i + j * m + k * mm
          const flip = here > 0
          let there = values[at + 1]
          if (there === there && flip !== there > 0) quad(cell - m - mm, cell - mm, cell, cell - m, flip)
          there = values[at + n]
          if (there === there && flip !== there > 0) quad(cell - 1 - mm, cell - 1, cell, cell - mm, flip)
          there = values[at + nn]
          if (there === there && flip !== there > 0) quad(cell - 1 - m, cell - m, cell, cell - 1, flip)
        }
      }
    }
    return { key: chunk.key, positions: Float32Array.from(positions), indices: Uint16Array.from(indices) }
  }

  /** Keys of chunks that currently exist, oldest last is not promised. */
  listChunks(): string[] {
    return [...this.chunks.keys()]
  }

  /**
   * A detached copy of one chunk. Mutating it does not change the live field.
   * A ghost replay can keep these and mesh them later with the same extractor.
   */
  snapshot(key: string): ChunkSnapshot | null {
    const chunk = this.chunks.get(key)
    if (!chunk) return null
    return { key, voxel: this.voxel, tsdf: new Int8Array(chunk.tsdf), weight: new Uint8Array(chunk.weight) }
  }

  /**
   * The blend when some of the eight voxels around a point are unseen. Depth
   * samples are sparse, so a seen surface has small unseen gaps in it. With
   * most of the corners known, the unknown ones stand in as their average.
   */
  private patchy(
    c000: number,
    c100: number,
    c010: number,
    c110: number,
    c001: number,
    c101: number,
    c011: number,
    c111: number,
    tx: number,
    ty: number,
    tz: number,
  ): number | null {
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
    if (known < 4) return null
    const fill = total / known
    const a = c000 === c000 ? c000 : fill
    const b = c100 === c100 ? c100 : fill
    const c = c010 === c010 ? c010 : fill
    const d = c110 === c110 ? c110 : fill
    const e = c001 === c001 ? c001 : fill
    const f = c101 === c101 ? c101 : fill
    const g = c011 === c011 ? c011 : fill
    const h = c111 === c111 ? c111 : fill
    const x00 = a + (b - a) * tx
    const x10 = c + (d - c) * tx
    const x01 = e + (f - e) * tx
    const x11 = g + (h - g) * tx
    const y0 = x00 + (x10 - x00) * ty
    const y1 = x01 + (x11 - x01) * ty
    return y0 + (y1 - y0) * tz
  }

  /** A voxel's stored value, or NaN where the room has not been seen enough. */
  private value(gx: number, gy: number, gz: number): number {
    const chunk = this.byId.get(chunkId(Math.floor(gx / CHUNK), Math.floor(gy / CHUNK), Math.floor(gz / CHUNK)))
    if (!chunk) return NaN
    const index = mod(gx, CHUNK) + mod(gy, CHUNK) * CHUNK + mod(gz, CHUNK) * CHUNK * CHUNK
    if (chunk.weight[index] < MIN_WEIGHT) return NaN
    return chunk.tsdf[index] / 127
  }

  /**
   * Write the way the surface faces at `out`'s position: up the field's slope,
   * toward the open side. Falls back to the given direction where the slope
   * cannot be read. False when there is neither.
   */
  private face(out: SurfacePoint, fx: number, fy: number, fz: number): boolean {
    const h = this.voxel * 0.75
    const g = this.grad
    const x1 = this.sdf(out.x + h, out.y, out.z)
    const x0 = this.sdf(out.x - h, out.y, out.z)
    const y1 = this.sdf(out.x, out.y + h, out.z)
    const y0 = this.sdf(out.x, out.y - h, out.z)
    const z1 = this.sdf(out.x, out.y, out.z + h)
    const z0 = this.sdf(out.x, out.y, out.z - h)
    g.x = x1 !== null && x0 !== null ? x1 - x0 : 0
    g.y = y1 !== null && y0 !== null ? y1 - y0 : 0
    g.z = z1 !== null && z0 !== null ? z1 - z0 : 0
    let len = Math.hypot(g.x, g.y, g.z)
    if (len < 0.05) {
      g.x = fx
      g.y = fy
      g.z = fz
      len = Math.hypot(fx, fy, fz)
      if (len < 1e-6) return false
    }
    out.nx = g.x / len
    out.ny = g.y / len
    out.nz = g.z / len
    return true
  }

  private integrateOne(sample: DepthSample, angle = 0): boolean {
    const dx = sample.px - sample.ox
    const dy = sample.py - sample.oy
    const dz = sample.pz - sample.oz
    const depth = Math.hypot(dx, dy, dz)
    if (depth < 0.25 || depth > 3.4) return false
    const ix = dx / depth
    const iy = dy / depth
    const iz = dz / depth
    // Spread along the surface where its facing is known, so a table seen at a shallow angle stays
    // flat. Otherwise across the line of sight.
    const basis = sample.nx !== undefined && sample.ny !== undefined && sample.nz !== undefined ? tangentOf(sample.nx, sample.ny, sample.nz) : tangentOf(ix, iy, iz)
    // An edge reading stays where it was seen. Spread sideways or deep, it would fill the hidden
    // space beyond the edge and the thing would come out too big.
    const edge = sample.edge === true
    // Far readings are further apart. Each is spread to meet its neighbours, so the sheet has no gaps.
    const wide = edge ? 0 : angle > 0 && (depth * angle * 0.5) / this.voxel > 1.15 ? 2 : 1
    const behind = edge ? this.voxel * 0.5 : this.behind
    const step = this.voxel * 0.5
    // Every other reading is enough to clear by, at half the cost: readings lie a voxel or two apart.
    if (this.clears && sample.past !== true && (this.clearTurn++ & 1) === 0) this.clearAlong(sample.ox, sample.oy, sample.oz, ix, iy, iz, depth - this.trunc - this.voxel)
    for (let t = depth - this.trunc; t <= depth + behind; t += step) {
      if (t < 0.2) continue
      const sdf = (depth - t) / this.trunc
      const clamped = sdf > 1 ? 1 : sdf < -1 ? -1 : sdf
      const x = sample.ox + ix * t
      const y = sample.oy + iy * t
      const z = sample.oz + iz * t
      // A few voxels either side of the ray, so coarse depth samples join into a sheet.
      for (let j = -wide; j <= wide; j++) {
        for (let i = -wide; i <= wide; i++) {
          this.write(
            x + basis.tx * i * this.voxel + basis.bx * j * this.voxel,
            y + basis.ty * i * this.voxel + basis.by * j * this.voxel,
            z + basis.tz * i * this.voxel + basis.bz * j * this.voxel,
            clamped,
          )
        }
      }
    }
    return true
  }

  /**
   * The reading saw open air from the eye to `end` metres along its ray. Where
   * the field holds something solid there, it is not there now: a hand or an
   * arm that was in the way, a thing since moved, a stray reading. Each look
   * through such a place counts against it as a reading of open air, so it is
   * gone in a second or so, while one stray look through a real thing changes
   * little. Only places the field already holds are touched.
   */
  private clearAlong(ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, end: number): void {
    const v = this.voxel
    const step = v * 0.5
    let lastId = -1
    let chunk: Chunk | undefined
    const stop = Math.min(end, CLEAR_REACH)
    for (let t = CLEAR_FROM; t < stop; t += step) {
      const x = ox + ix * t
      const y = oy + iy * t
      const z = oz + iz * t
      const gx = Math.floor(x / v)
      const gy = Math.floor(y / v)
      const gz = Math.floor(z / v)
      const id = chunkId(Math.floor(gx / CHUNK), Math.floor(gy / CHUNK), Math.floor(gz / CHUNK))
      if (id !== lastId) {
        lastId = id
        chunk = this.byId.get(id)
      }
      if (!chunk) {
        // Nothing held here: on a little faster, as most of the way to a wall is.
        t += step
        continue
      }
      // Cheap first: the voxel the point is in holds nothing, or open air.
      const index = mod(gx, CHUNK) + mod(gy, CHUNK) * CHUNK + mod(gz, CHUNK) * CHUNK * CHUNK
      const w = chunk.weight[index]
      if (w === 0 || w >= 32 || chunk.tsdf[index] > 0) continue
      // Then exactly: is this very point behind a surface, as the field has it? A ray that only
      // grazes a thing passes outside it, and leaves it be.
      const s = this.sdf(x, y, z)
      if (s === null || s > CLEAR_INSIDE) continue
      this.open(chunk, index)
    }
  }

  /** Count one reading of open air against a voxel that holds something. */
  private open(chunk: Chunk, index: number): void {
    const w = chunk.weight[index]
    const was = chunk.tsdf[index]
    // Nothing held, a place peeled away, or open air already.
    if (w === 0 || w >= 32 || was > 0) return
    const nw = Math.min(24, w + 1)
    const stored = Math.round(((was / 127) * (nw - 1) + 1) / nw * 127)
    chunk.tsdf[index] = stored
    chunk.weight[index] = nw
    chunk.dirty = true
    if (stored <= 0 && stored - was < 4) return
    chunk.stale = true
    const lx = index % CHUNK
    const ly = Math.floor(index / CHUNK) % CHUNK
    const lz = Math.floor(index / (CHUNK * CHUNK))
    if (lx === 0) this.staleAt(chunk.ix - 1, chunk.iy, chunk.iz)
    else if (lx === CHUNK - 1) this.staleAt(chunk.ix + 1, chunk.iy, chunk.iz)
    if (ly === 0) this.staleAt(chunk.ix, chunk.iy - 1, chunk.iz)
    else if (ly === CHUNK - 1) this.staleAt(chunk.ix, chunk.iy + 1, chunk.iz)
    if (lz === 0) this.staleAt(chunk.ix, chunk.iy, chunk.iz - 1)
    else if (lz === CHUNK - 1) this.staleAt(chunk.ix, chunk.iy, chunk.iz + 1)
  }

  private write(x: number, y: number, z: number, sdf: number): void {
    const gx = Math.floor(x / this.voxel)
    const gy = Math.floor(y / this.voxel)
    const gz = Math.floor(z / this.voxel)
    const cell = this.cell(gx, gy, gz, true)
    if (!cell) return
    const { chunk, index } = cell
    if (chunk.weight[index] >= 32 && chunk.tsdf[index] > 100) return
    const w = chunk.weight[index]
    const old = w === 0 ? 0 : chunk.tsdf[index] / 127
    // A running average of the last couple of dozen readings. Once the weight is full, each new
    // reading still counts for one share in 24, so the value settles instead of drifting to ±1.
    const nw = Math.min(24, w + 1)
    const mixed = w === 0 ? sdf : (old * (nw - 1) + sdf) / nw
    const stored = Math.round((mixed > 1 ? 1 : mixed < -1 ? -1 : mixed) * 127)
    const moved = w < 3 || Math.abs(stored - chunk.tsdf[index]) >= 4
    chunk.tsdf[index] = stored
    chunk.weight[index] = nw
    chunk.dirty = true
    chunk.seen = this.clock
    // The smooth mesh only needs making again when the surface has really moved, not for depth noise.
    if (!moved) return
    chunk.stale = true
    // A chunk's mesh reads one voxel into its neighbours, so a change at a face is theirs too.
    const lx = index % CHUNK
    const ly = Math.floor(index / CHUNK) % CHUNK
    const lz = Math.floor(index / (CHUNK * CHUNK))
    if (lx === 0) this.staleAt(chunk.ix - 1, chunk.iy, chunk.iz)
    else if (lx === CHUNK - 1) this.staleAt(chunk.ix + 1, chunk.iy, chunk.iz)
    if (ly === 0) this.staleAt(chunk.ix, chunk.iy - 1, chunk.iz)
    else if (ly === CHUNK - 1) this.staleAt(chunk.ix, chunk.iy + 1, chunk.iz)
    if (lz === 0) this.staleAt(chunk.ix, chunk.iy, chunk.iz - 1)
    else if (lz === CHUNK - 1) this.staleAt(chunk.ix, chunk.iy, chunk.iz + 1)
  }

  private staleAt(cx: number, cy: number, cz: number): void {
    const chunk = this.byId.get(chunkId(cx, cy, cz))
    if (chunk) chunk.stale = true
  }

  private cell(gx: number, gy: number, gz: number, create: boolean): { chunk: Chunk; index: number } | null {
    const cx = Math.floor(gx / CHUNK)
    const cy = Math.floor(gy / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const id = chunkId(cx, cy, cz)
    let chunk = this.byId.get(id)
    if (!chunk && create) {
      if (this.chunks.size >= this.maxChunks && !this.evict()) return null
      const key = `${cx},${cy},${cz}`
      chunk = {
        key,
        ix: cx,
        iy: cy,
        iz: cz,
        tsdf: new Int8Array(CELLS),
        weight: new Uint8Array(CELLS),
        seen: this.clock,
        dirty: true,
        stale: true,
        positions: new Float32Array(0),
        normals: new Float32Array(0),
      }
      this.chunks.set(key, chunk)
      this.byId.set(id, chunk)
    }
    if (!chunk) return null
    const lx = mod(gx, CHUNK)
    const ly = mod(gy, CHUNK)
    const lz = mod(gz, CHUNK)
    return { chunk, index: lx + ly * CHUNK + lz * CHUNK * CHUNK }
  }

  /** Drop the chunk least recently written, never one touched in this fuse or one being held on to. */
  private evict(): boolean {
    let oldest: Chunk | null = null
    const kept = this.kept
    for (const chunk of this.chunks.values()) {
      if (chunk.seen === this.clock) continue
      if (kept.r2 > 0 && chunkDist(chunk, kept.x, kept.y, kept.z, this.voxel) < kept.r2) continue
      if (!oldest || chunk.seen < oldest.seen) oldest = chunk
    }
    if (!oldest) return false
    this.retired.push(oldest.key)
    this.soupStale = true
    this.chunks.delete(oldest.key)
    this.byId.delete(chunkId(oldest.ix, oldest.iy, oldest.iz))
    return true
  }

  private sample(gx: number, gy: number, gz: number): { sdf: number; weight: number } | null {
    const cell = this.cell(gx, gy, gz, false)
    if (!cell || cell.chunk.weight[cell.index] < MIN_WEIGHT) return null
    return { sdf: cell.chunk.tsdf[cell.index] / 127, weight: cell.chunk.weight[cell.index] }
  }

  private buildChunk(chunk: Chunk): ChunkMesh {
    const positions: number[] = []
    const normals: number[] = []
    const ox = chunk.ix * CHUNK
    const oy = chunk.iy * CHUNK
    const oz = chunk.iz * CHUNK
    for (let z = 0; z < CHUNK; z++) {
      for (let y = 0; y < CHUNK; y++) {
        for (let x = 0; x < CHUNK; x++) {
          this.quad(ox + x, oy + y, oz + z, 1, 0, 0, positions, normals)
          this.quad(ox + x, oy + y, oz + z, 0, 1, 0, positions, normals)
          this.quad(ox + x, oy + y, oz + z, 0, 0, 1, positions, normals)
        }
      }
    }
    chunk.positions = Float32Array.from(positions)
    chunk.normals = Float32Array.from(normals)
    chunk.dirty = false
    return { key: chunk.key, positions: chunk.positions, normals: chunk.normals }
  }

  private quad(
    gx: number,
    gy: number,
    gz: number,
    ax: number,
    ay: number,
    az: number,
    positions: number[],
    normals: number[],
  ): void {
    const a = this.sample(gx, gy, gz)
    const b = this.sample(gx + ax, gy + ay, gz + az)
    if (!a || !b || a.sdf === 0 || b.sdf === 0) return
    if (a.sdf > 0 === b.sdf > 0) return
    const t = a.sdf / (a.sdf - b.sdf)
    const x0 = (gx + 0.5) * this.voxel
    const y0 = (gy + 0.5) * this.voxel
    const z0 = (gz + 0.5) * this.voxel
    const px = x0 + ax * this.voxel * t
    const py = y0 + ay * this.voxel * t
    const pz = z0 + az * this.voxel * t
    const nSign = a.sdf > b.sdf ? -1 : 1
    const nx = ax * nSign
    const ny = ay * nSign
    const nz = az * nSign
    const quad = faceCorners(px, py, pz, ax, ay, az, this.voxel * 0.62)
    pushTri(positions, normals, quad, 0, 1, 2, nx, ny, nz)
    pushTri(positions, normals, quad, 0, 2, 3, nx, ny, nz)
  }

  private rebuildTris(): void {
    this.tris.length = 0
    for (const chunk of this.chunks.values()) {
      const p = chunk.positions
      const n = chunk.normals
      for (let i = 0; i + 8 < p.length; i += 9) {
        this.tris.push({
          ax: p[i],
          ay: p[i + 1],
          az: p[i + 2],
          bx: p[i + 3],
          by: p[i + 4],
          bz: p[i + 5],
          cx: p[i + 6],
          cy: p[i + 7],
          cz: p[i + 8],
          nx: n[i],
          ny: n[i + 1],
          nz: n[i + 2],
        })
      }
    }
  }

  private dropTrisNear(x: number, y: number, z: number, radius: number): void {
    const r2 = radius * radius
    for (let i = this.tris.length - 1; i >= 0; i--) {
      const tri = this.tris[i]
      const cx = (tri.ax + tri.bx + tri.cx) / 3
      const cy = (tri.ay + tri.by + tri.cy) / 3
      const cz = (tri.az + tri.bz + tri.cz) / 3
      const dx = cx - x
      const dy = cy - y
      const dz = cz - z
      if (dx * dx + dy * dy + dz * dz <= r2) this.tris.splice(i, 1)
    }
  }
}

function faceCorners(px: number, py: number, pz: number, ax: number, ay: number, az: number, h: number): number[] {
  if (ax !== 0) {
    return [px, py - h, pz - h, px, py + h, pz - h, px, py + h, pz + h, px, py - h, pz + h]
  }
  if (ay !== 0) {
    return [px - h, py, pz - h, px + h, py, pz - h, px + h, py, pz + h, px - h, py, pz + h]
  }
  return [px - h, py - h, pz, px + h, py - h, pz, px + h, py + h, pz, px - h, py + h, pz]
}

function pushTri(
  positions: number[],
  normals: number[],
  quad: number[],
  i: number,
  j: number,
  k: number,
  nx: number,
  ny: number,
  nz: number,
): void {
  const ids = [i, j, k]
  for (let n = 0; n < 3; n++) {
    const o = ids[n] * 3
    positions.push(quad[o], quad[o + 1], quad[o + 2])
    normals.push(nx, ny, nz)
  }
}

function rayTri(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tri: Tri): number | null {
  const e1x = tri.bx - tri.ax
  const e1y = tri.by - tri.ay
  const e1z = tri.bz - tri.az
  const e2x = tri.cx - tri.ax
  const e2y = tri.cy - tri.ay
  const e2z = tri.cz - tri.az
  const px = dy * e2z - dz * e2y
  const py = dz * e2x - dx * e2z
  const pz = dx * e2y - dy * e2x
  const det = e1x * px + e1y * py + e1z * pz
  if (Math.abs(det) < 1e-8) return null
  const inv = 1 / det
  const sx = ox - tri.ax
  const sy = oy - tri.ay
  const sz = oz - tri.az
  const u = (sx * px + sy * py + sz * pz) * inv
  if (u < 0 || u > 1) return null
  const qx = sy * e1z - sz * e1y
  const qy = sz * e1x - sx * e1z
  const qz = sx * e1y - sy * e1x
  const v = (dx * qx + dy * qy + dz * qz) * inv
  if (v < 0 || u + v > 1) return null
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv
  return t > 0 ? t : null
}

function chunkDist(chunk: Chunk, x: number, y: number, z: number, voxel: number): number {
  const cx = (chunk.ix * CHUNK + CHUNK / 2) * voxel
  const cy = (chunk.iy * CHUNK + CHUNK / 2) * voxel
  const cz = (chunk.iz * CHUNK + CHUNK / 2) * voxel
  const dx = cx - x
  const dy = cy - y
  const dz = cz - z
  return dx * dx + dy * dy + dz * dz
}

function tangentOf(ix: number, iy: number, iz: number): { tx: number; ty: number; tz: number; bx: number; by: number; bz: number } {
  const ax = Math.abs(iy) < 0.9 ? 0 : 1
  const ay = Math.abs(iy) < 0.9 ? 1 : 0
  const tx = ay * iz
  const ty = -ax * iz
  const tz = ax * iy - ay * ix
  const tl = Math.hypot(tx, ty, tz) || 1
  const bx = iy * (tz / tl) - iz * (ty / tl)
  const by = iz * (tx / tl) - ix * (tz / tl)
  const bz = ix * (ty / tl) - iy * (tx / tl)
  return { tx: tx / tl, ty: ty / tl, tz: tz / tl, bx, by, bz }
}

function mod(n: number, d: number): number {
  return ((n % d) + d) % d
}
