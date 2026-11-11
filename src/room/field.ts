/**
 * A sparse distance field for the room, in world metres.
 * Chunks are small so a later ghost replay can snapshot one at a time
 * without copying the whole room. This file stays free of three.js so the
 * fusion and the mesh extraction can be tested on their own.
 */

export const VOXEL = 0.04
export const CHUNK = 8
const CELLS = CHUNK * CHUNK * CHUNK
const TRUNC = 0.08
const MIN_WEIGHT = 2
/** A few metres of nearby surface. Older chunks leave once the view moves on. */
export const MAX_CHUNKS = 420
const MAX_SAMPLES = 700

export interface DepthSample {
  ox: number
  oy: number
  oz: number
  px: number
  py: number
  pz: number
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

  get chunkCount(): number {
    return this.chunks.size
  }

  /** Fuse surface samples. Each sample is a camera origin and a point on the surface. */
  integrate(samples: readonly DepthSample[]): number {
    return this.integrateRange(samples, 0, samples.length, true)
  }

  /**
   * Fuse a slice of a depth frame. `fresh` starts a new frame so chunks written
   * earlier in that same frame are not treated as old and discarded.
   */
  integrateRange(samples: readonly DepthSample[], start: number, end: number, fresh: boolean): number {
    if (fresh) this.clock += 1
    const from = Math.max(0, start)
    const to = Math.min(samples.length, end, from + MAX_SAMPLES)
    let used = 0
    for (let i = from; i < to; i++) {
      if (this.integrateOne(samples[i])) used += 1
    }
    return used
  }

  /**
   * Forget the surface inside a sphere, and keep later depth from healing it.
   * The mesh grows a hole there on the next extract.
   */
  carve(x: number, y: number, z: number, radius: number): void {
    const r2 = radius * radius
    const reach = Math.ceil(radius / VOXEL) + 1
    const gx = Math.floor(x / VOXEL)
    const gy = Math.floor(y / VOXEL)
    const gz = Math.floor(z / VOXEL)
    for (let iz = gz - reach; iz <= gz + reach; iz++) {
      for (let iy = gy - reach; iy <= gy + reach; iy++) {
        for (let ix = gx - reach; ix <= gx + reach; ix++) {
          const cx = (ix + 0.5) * VOXEL
          const cy = (iy + 0.5) * VOXEL
          const cz = (iz + 0.5) * VOXEL
          const dx = cx - x
          const dy = cy - y
          const dz = cz - z
          if (dx * dx + dy * dy + dz * dz > r2) continue
          const cell = this.cell(ix, iy, iz, false)
          if (!cell) continue
          cell.chunk.tsdf[cell.index] = 127
          cell.chunk.weight[cell.index] = 32
          cell.chunk.dirty = true
          cell.chunk.seen = this.clock
        }
      }
    }
    this.dropTrisNear(x, y, z, radius)
  }

  /** Let depth fill a carved place in again, for when a hole closes. */
  heal(x: number, y: number, z: number, radius: number): void {
    const r2 = radius * radius
    const reach = Math.ceil(radius / VOXEL) + 1
    const gx = Math.floor(x / VOXEL)
    const gy = Math.floor(y / VOXEL)
    const gz = Math.floor(z / VOXEL)
    for (let iz = gz - reach; iz <= gz + reach; iz++) {
      for (let iy = gy - reach; iy <= gy + reach; iy++) {
        for (let ix = gx - reach; ix <= gx + reach; ix++) {
          const dx = (ix + 0.5) * VOXEL - x
          const dy = (iy + 0.5) * VOXEL - y
          const dz = (iz + 0.5) * VOXEL - z
          if (dx * dx + dy * dy + dz * dz > r2) continue
          const cell = this.cell(ix, iy, iz, false)
          if (!cell || cell.chunk.weight[cell.index] < 32) continue
          cell.chunk.tsdf[cell.index] = 0
          cell.chunk.weight[cell.index] = 0
          cell.chunk.dirty = true
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
    const fx = x / VOXEL - 0.5
    const fy = y / VOXEL - 0.5
    const fz = z / VOXEL - 0.5
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
    const step = VOXEL * 0.5
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
    const step = VOXEL * 0.5
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
    const d = s * TRUNC
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
      out.x -= out.nx * again * TRUNC
      out.y -= out.ny * again * TRUNC
      out.z -= out.nz * again * TRUNC
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
      dirty.sort((a, b) => chunkDist(a, nx, ny, nz) - chunkDist(b, nx, ny, nz))
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
    return { key, voxel: VOXEL, tsdf: new Int8Array(chunk.tsdf), weight: new Uint8Array(chunk.weight) }
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
    const h = VOXEL * 0.75
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

  private integrateOne(sample: DepthSample): boolean {
    const dx = sample.px - sample.ox
    const dy = sample.py - sample.oy
    const dz = sample.pz - sample.oz
    const depth = Math.hypot(dx, dy, dz)
    if (depth < 0.25 || depth > 3.4) return false
    const ix = dx / depth
    const iy = dy / depth
    const iz = dz / depth
    const basis = tangentOf(ix, iy, iz)
    const step = VOXEL * 0.5
    for (let t = depth - TRUNC; t <= depth + TRUNC * 0.5; t += step) {
      if (t < 0.2) continue
      const sdf = (depth - t) / TRUNC
      const clamped = sdf > 1 ? 1 : sdf < -1 ? -1 : sdf
      const x = sample.ox + ix * t
      const y = sample.oy + iy * t
      const z = sample.oz + iz * t
      // A few voxels either side of the ray, so coarse depth samples join into a sheet.
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          this.write(
            x + basis.tx * i * VOXEL + basis.bx * j * VOXEL,
            y + basis.ty * i * VOXEL + basis.by * j * VOXEL,
            z + basis.tz * i * VOXEL + basis.bz * j * VOXEL,
            clamped,
          )
        }
      }
    }
    return true
  }

  private write(x: number, y: number, z: number, sdf: number): void {
    const gx = Math.floor(x / VOXEL)
    const gy = Math.floor(y / VOXEL)
    const gz = Math.floor(z / VOXEL)
    const cell = this.cell(gx, gy, gz, true)
    if (!cell) return
    const { chunk, index } = cell
    if (chunk.weight[index] >= 32 && chunk.tsdf[index] > 100) return
    const w = chunk.weight[index]
    const old = w === 0 ? 0 : chunk.tsdf[index] / 127
    const nw = Math.min(24, w + 1)
    const mixed = w === 0 ? sdf : (old * w + sdf) / nw
    const stored = Math.round((mixed > 1 ? 1 : mixed < -1 ? -1 : mixed) * 127)
    chunk.tsdf[index] = stored
    chunk.weight[index] = nw
    chunk.dirty = true
    chunk.seen = this.clock
  }

  private cell(gx: number, gy: number, gz: number, create: boolean): { chunk: Chunk; index: number } | null {
    const cx = Math.floor(gx / CHUNK)
    const cy = Math.floor(gy / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const id = chunkId(cx, cy, cz)
    let chunk = this.byId.get(id)
    if (!chunk && create) {
      if (this.chunks.size >= MAX_CHUNKS && !this.evict()) return null
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

  /** Drop the chunk least recently written, never one touched in this fuse. */
  private evict(): boolean {
    let oldest: Chunk | null = null
    for (const chunk of this.chunks.values()) {
      if (chunk.seen === this.clock) continue
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
    const x0 = (gx + 0.5) * VOXEL
    const y0 = (gy + 0.5) * VOXEL
    const z0 = (gz + 0.5) * VOXEL
    const px = x0 + ax * VOXEL * t
    const py = y0 + ay * VOXEL * t
    const pz = z0 + az * VOXEL * t
    const nSign = a.sdf > b.sdf ? -1 : 1
    const nx = ax * nSign
    const ny = ay * nSign
    const nz = az * nSign
    const quad = faceCorners(px, py, pz, ax, ay, az, VOXEL * 0.62)
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

function chunkDist(chunk: Chunk, x: number, y: number, z: number): number {
  const cx = (chunk.ix * CHUNK + CHUNK / 2) * VOXEL
  const cy = (chunk.iy * CHUNK + CHUNK / 2) * VOXEL
  const cz = (chunk.iz * CHUNK + CHUNK / 2) * VOXEL
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
