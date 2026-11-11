import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  type Object3D,
  type PerspectiveCamera,
  type ShaderMaterial,
  type WebGLRenderer,
} from '@iwsdk/core'
import { REDUCE_MOTION } from '../app/context.js'
import { PEEL_SCALE } from '../app/experience.js'
import { makeContactRing } from '../look/contact.js'
import { motesEffect, type Effect } from '../look/effects.js'
import { makeDust } from '../look/motes.js'
import { PALETTE } from '../look/palette.js'
import { poolMaterial, sparkleMaterial } from '../look/room-glow.js'
import { transformPoint, viewFromDepthPixel } from './depth-project.js'
import { RoomField, surfacePoint, type DepthSample, type SurfacePoint } from './field.js'
import { PIECE_MAX, STICK_GAP, TOUCH_GAP, canLand, tangentBasis } from './patch.js'
import { PeelPiece, type PieceState } from './peel-piece.js'
import type { RoomPlates } from './plates.js'

const FUSE_EVERY = 0.22
const EXTRACT_BUDGET = 2
/** Samples fused on one frame. The rest of a depth image waits, so the frame stays smooth. */
const SAMPLE_BUDGET = 140
/** Pieces kept. The oldest fades, and its light closes, to make room for a new one. */
const MAX_PIECES = 12
/** A fingertip this far from a surface starts to gather light on it, metres. */
const POOL_REACH = 0.3
/** Pool slots: one per hand, and one for where a carried piece will land. */
const LANDING = 2

interface DepthView {
  transform: { matrix: ArrayLike<number> }
}

interface CpuDepth {
  width: number
  height: number
  getDepthInMeters(x: number, y: number): number
  normDepthBufferFromNormView: { inverse: { matrix: ArrayLike<number> } }
}

interface DepthFrame {
  getViewerPose?: (space: XRReferenceSpace) => { views: DepthView[] } | undefined
  getDepthInformation?: (view: DepthView) => CpuDepth | undefined
}

interface Pool {
  mesh: Mesh
  mat: ShaderMaterial
  level: number
  goal: number
  radius: number
  placed: boolean
  readonly at: Vector3
  readonly normal: Vector3
}

/**
 * The room peel. Depth is fused into a small distance field that is never
 * shown. What you see is a pool of light on a surface as your hand nears it,
 * the piece that comes away when you pinch and pull, and warm light where it
 * was. Fusion runs on the CPU because Quest Browser's WebGL has no compute
 * shaders. `RoomField.snapshot` is the hook a ghost replay would use.
 */
export class RoomScan {
  readonly group = new Group()
  active = false
  /** Set once when a headset session has no depth-sensing. */
  depthNote: string | null = null
  /** The piece is lifting: `speed` is how fast it is growing, 0..1 per second. */
  onLift: ((at: Vector3, speed: number, dt: number) => void) | null = null
  /** The piece came away from the wall and the light opened. */
  onFree: ((at: Vector3) => void) | null = null
  /** The piece lay down on a surface. */
  onLand: ((at: Vector3) => void) | null = null
  /** Pixels per metre at one metre, so dust keeps its size at any distance. */
  pixelScale: () => number = () => 760
  private readonly field = new RoomField()
  private readonly sparkle: ShaderMaterial
  private readonly meshes = new Map<string, Mesh>()
  private readonly pieces: PeelPiece[] = []
  private readonly effects: Effect[] = []
  private readonly pools: Pool[] = []
  private held: PeelPiece | null = null
  private landing: SurfacePoint | null = null
  private presenting = false
  private lastAmount = 0
  private fuseIn = 0
  private queue: DepthSample[] = []
  private queueAt = 0
  private queueFresh = false
  private depthMiss = 0
  private time = 0
  private readonly raycaster = new Raycaster()
  private readonly ndc = new Vector2()
  private readonly forward = new Vector3(0, 0, 1)
  private readonly scratch = new Vector3()
  private readonly local = new Vector3()
  private readonly centre = new Vector3()
  private readonly quat = new Quaternion()
  private readonly hitA = surfacePoint()
  private readonly hitB = surfacePoint()
  private readonly rim = [new Vector3(), new Vector3(), new Vector3(), new Vector3()]

  constructor(
    parent: Object3D,
    renderer: WebGLRenderer,
    private readonly plates: RoomPlates,
  ) {
    this.group.name = 'room-scan'
    this.group.visible = false
    parent.add(this.group)
    this.sparkle = sparkleMaterial(PALETTE)
    const quad = new PlaneGeometry(1, 1)
    for (let i = 0; i < 3; i++) {
      const mat = poolMaterial(PALETTE)
      const mesh = new Mesh(quad, mat)
      mesh.name = i === LANDING ? 'room-landing' : 'room-pool'
      mesh.renderOrder = 2
      mesh.frustumCulled = false
      mesh.visible = false
      this.group.add(mesh)
      this.pools.push({ mesh, mat, level: 0, goal: 0, radius: 0.1, placed: false, at: new Vector3(), normal: new Vector3(0, 1, 0) })
    }
    // Compile the shaders now, so the first pinch does not hitch.
    const scene = new Scene()
    const warm = new Mesh(warmupTriangle(), this.sparkle)
    const warmPool = new Mesh(quad, this.pools[0].mat)
    scene.add(warm, warmPool)
    const cam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
    cam.position.z = 1
    renderer.compile(scene, cam)
    warm.geometry.dispose()
  }

  get chunkCount(): number {
    return this.field.chunkCount
  }

  /** Pieces in the scene, in any state. */
  get pieceCount(): number {
    return this.pieces.length
  }

  /** Places where the light is open. */
  get lightCount(): number {
    let n = 0
    for (let i = 0; i < this.pieces.length; i++) if (this.pieces[i].parted && this.pieces[i].open > 0.5) n++
    return n
  }

  /** A hand or the mouse has hold of a piece. */
  get holding(): boolean {
    return this.held !== null
  }

  /** What the held piece is doing, or the newest piece when none is held. */
  get state(): PieceState | 'none' {
    const piece = this.held ?? this.pieces[this.pieces.length - 1]
    return piece ? piece.state : 'none'
  }

  /** The held piece is free of the wall and following the hand. */
  get carrying(): boolean {
    return this.held?.state === 'carried'
  }

  /** How far the held piece has been pulled, 0 (tack) to 1 (pop). */
  get pullAmount(): number {
    return this.held?.state === 'lifting' ? this.held.amount : 0
  }

  /** Radius of the held (or newest) piece, metres. */
  get pieceRadius(): number {
    const piece = this.held ?? this.pieces[this.pieces.length - 1]
    return piece ? piece.radius : 0
  }

  /** A carried piece is over somewhere it can land. */
  get overSurface(): boolean {
    return this.landing !== null
  }

  /** Light is gathering under a hand. */
  get poolLevel(): number {
    return Math.max(this.pools[0].level, this.pools[1].level)
  }

  /** At least one piece has been laid on a surface. */
  get anyStuck(): boolean {
    for (let i = 0; i < this.pieces.length; i++) if (this.pieces[i].state === 'stuck') return true
    return false
  }

  /** At least one piece is loose in the air. */
  get anyFloating(): boolean {
    for (let i = 0; i < this.pieces.length; i++) if (this.pieces[i].state === 'free') return true
    return false
  }

  setActive(on: boolean): void {
    if (!on && this.held) this.end()
    this.active = on
    this.group.visible = on
  }

  /**
   * A pinch closed at `point`. It takes hold of a loose piece if one is there,
   * or of the room's surface. False when the pinch is on nothing.
   */
  press(point: Vector3, view: Vector3 | null): boolean {
    if (!this.active || this.held) return false
    const piece = this.pieceAt(point)
    if (piece) {
      piece.grab(point)
      this.held = piece
      return true
    }
    let hit = this.field.near(point.x, point.y, point.z, TOUCH_GAP, this.hitA)
    if (!hit && view) {
      // Fingers a little short of the wall still take it: look on past them.
      this.scratch.copy(point).sub(view).normalize()
      hit = this.field.surfaceAlong(
        point.x - this.scratch.x * 0.04,
        point.y - this.scratch.y * 0.04,
        point.z - this.scratch.z * 0.04,
        this.scratch.x,
        this.scratch.y,
        this.scratch.z,
        0.04 + TOUCH_GAP,
        this.hitA,
      )
    }
    if (!hit) return false
    this.begin(hit, point, view)
    return true
  }

  /**
   * The desk's pinch: a press along a ray. Returns how far along the ray it
   * took hold, or -1.
   */
  pressRay(origin: Vector3, dir: Vector3): number {
    if (!this.active || this.held) return -1
    const surface = this.field.surfaceAlong(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, 3.6, this.hitA)
    let best: PeelPiece | null = null
    let bestT = surface ? surface.dist + 0.03 : 3.6
    for (let i = 0; i < this.pieces.length; i++) {
      const piece = this.pieces[i]
      if (!piece.loose) continue
      const t = this.rayToPiece(piece, origin, dir)
      if (t > 0 && t < bestT) {
        best = piece
        bestT = t
      }
    }
    if (best) {
      best.grab(this.scratch.copy(origin).addScaledVector(dir, bestT))
      this.held = best
      return bestT
    }
    if (!surface) return -1
    this.begin(surface, this.scratch.set(surface.x, surface.y, surface.z), origin)
    return surface.dist
  }

  /** How far along a ray the room's surface is, or -1. Pieces are not counted. */
  rayDist(origin: Vector3, dir: Vector3): number {
    return this.field.depthAlong(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, 3.6)
  }

  /** The pinch moved. */
  drag(point: Vector3): void {
    this.held?.drag(point)
  }

  /** The pinch opened. */
  end(): void {
    const piece = this.held
    this.held = null
    if (!piece) return
    if (piece.state === 'lifting') piece.letGo()
    else if (piece.state === 'carried') {
      if (this.landing) piece.land(this.landing, this.field)
      else piece.drop()
    }
    this.landing = null
  }

  /**
   * A fingertip (or the cursor) is here, reaching along `dir`. Light gathers on
   * the surface it is nearing. `level` fixes the brightness, for the mouse,
   * which is never near anything.
   */
  hover(index: 0 | 1, origin: Vector3 | null, dir: Vector3 | null, reach = POOL_REACH, level = -1): void {
    const pool = this.pools[index]
    if (!origin || !this.active || this.held) {
      pool.goal = 0
      return
    }
    let hit = this.field.near(origin.x, origin.y, origin.z, 0.07, this.hitB)
    if (!hit && dir && dir.lengthSq() > 1e-6) {
      hit = this.field.surfaceAlong(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, reach, this.hitB)
    }
    if (!hit) {
      pool.goal = 0
      return
    }
    const close = 1 - Math.min(1, hit.dist / reach)
    pool.goal = level >= 0 ? level : Math.pow(close, 0.7)
    // The light draws in under the finger as it nears.
    pool.radius = level >= 0 ? 0.085 : 0.13 - 0.06 * close
    this.aimPool(pool, hit)
  }

  step(dt: number, presenting: boolean, frame: DepthFrame | null, camera: PerspectiveCamera, standIn: Object3D): void {
    this.time += dt
    this.presenting = presenting
    this.sparkle.uniforms.uTime.value = this.time
    if (!this.active) return
    this.fuse(dt, presenting, frame, camera, standIn)
    this.stepHeld(dt)
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const piece = this.pieces[i]
      piece.step(dt)
      for (let e = 0; e < piece.events.length; e++) this.react(piece, piece.events[e])
      piece.events.length = 0
      if (!piece.done) continue
      if (piece.parted) this.field.heal(piece.source.x, piece.source.y, piece.source.z, piece.radius)
      if (this.held === piece) this.held = null
      piece.dispose()
      this.pieces.splice(i, 1)
    }
    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (!this.effects[i].step(dt)) continue
      this.effects[i].dispose()
      this.effects.splice(i, 1)
    }
    this.stepPools(dt)
  }

  dispose(): void {
    this.group.removeFromParent()
    this.sparkle.dispose()
    for (const mesh of this.meshes.values()) mesh.geometry.dispose()
    for (let i = 0; i < this.pieces.length; i++) this.pieces[i].dispose()
    for (let i = 0; i < this.effects.length; i++) this.effects[i].dispose()
    this.pools[0].mesh.geometry.dispose()
    for (let i = 0; i < this.pools.length; i++) this.pools[i].mat.dispose()
  }

  private begin(hit: SurfacePoint, start: Vector3, view: Vector3 | null): void {
    const pinch = start.clone()
    // Make room first: the oldest piece that nobody is holding goes.
    let live = 0
    for (let i = 0; i < this.pieces.length; i++) if (this.pieces[i].state !== 'fading') live++
    for (let i = 0; i < this.pieces.length && live >= MAX_PIECES; i++) {
      if (this.pieces[i].state === 'fading') continue
      this.pieces[i].fade()
      live--
    }
    this.centre.set(hit.x, hit.y, hit.z)
    const basis = tangentBasis(hit.nx, hit.ny, hit.nz)
    const r = PIECE_MAX * 1.15
    this.rim[0].copy(this.centre).addScaledVector(this.scratch.set(basis.tx, basis.ty, basis.tz), r)
    this.rim[1].copy(this.centre).addScaledVector(this.scratch, -r)
    this.rim[2].copy(this.centre).addScaledVector(this.scratch.set(basis.bx, basis.by, basis.bz), r)
    this.rim[3].copy(this.centre).addScaledVector(this.scratch, -r)
    // The pools and other pieces must not be in the desk's picture of the room.
    const shown = this.group.visible
    this.group.visible = false
    const skin = this.plates.skin(this.centre, this.rim, this.presenting)
    this.group.visible = shown
    const piece = new PeelPiece({ hit, start: pinch, view, field: this.field, skin, palette: PALETTE, scale: PEEL_SCALE })
    this.group.add(piece.holeAnchor, piece.anchor)
    this.pieces.push(piece)
    this.held = piece
    this.lastAmount = 0
  }

  private stepHeld(dt: number): void {
    this.landing = null
    const piece = this.held
    const pool = this.pools[LANDING]
    pool.goal = 0
    if (!piece) return
    if (piece.state === 'lifting') {
      if (dt > 0) {
        const speed = Math.max(0, piece.amount - this.lastAmount) / dt
        this.onLift?.(piece.center(this.centre), speed, dt)
      }
      this.lastAmount = piece.amount
      return
    }
    if (piece.state !== 'carried') return
    // Is there a surface just under the piece that it could lie on?
    const c = piece.center(this.centre)
    const n = piece.normal
    const hit =
      this.field.near(c.x, c.y, c.z, STICK_GAP, this.hitB) ??
      this.field.surfaceAlong(c.x + n.x * 0.02, c.y + n.y * 0.02, c.z + n.z * 0.02, -n.x, -n.y, -n.z, STICK_GAP + 0.03, this.hitB)
    if (!hit) return
    const fromSource = Math.hypot(hit.x - piece.source.x, hit.y - piece.source.y, hit.z - piece.source.z)
    if (!canLand(fromSource, piece.radius, piece.travelled)) return
    this.landing = hit
    pool.goal = 1
    pool.radius = piece.radius
    this.aimPool(pool, hit)
  }

  private react(piece: PeelPiece, event: 'freed' | 'landed'): void {
    if (event === 'freed') {
      // New depth must not paint the wall back in behind the light.
      this.field.carve(piece.source.x, piece.source.y, piece.source.z, piece.radius * 0.8)
      if (!REDUCE_MOTION) {
        const dust = makeDust(piece.radius * 0.8, PALETTE, this.pixelScale())
        piece.holeAnchor.add(dust.group)
        this.effects.push(motesEffect(dust))
      }
      this.onFree?.(piece.source)
      return
    }
    if (!REDUCE_MOTION) {
      const ring = makeContactRing(piece.radius * 1.5, piece.radius * 1.5, PALETTE)
      ring.group.position.z = 0.001
      piece.anchor.add(ring.group)
      this.effects.push(ring)
    }
    this.onLand?.(piece.center(this.centre))
  }

  /** A loose piece with this point on it, or null. */
  private pieceAt(point: Vector3): PeelPiece | null {
    let best: PeelPiece | null = null
    let bestD = Infinity
    for (let i = 0; i < this.pieces.length; i++) {
      const piece = this.pieces[i]
      if (!piece.loose) continue
      this.local.copy(point)
      piece.anchor.worldToLocal(this.local)
      const across = Math.hypot(this.local.x, this.local.y)
      if (Math.abs(this.local.z) > 0.07 || across > piece.radius + 0.02) continue
      const d = across + Math.abs(this.local.z)
      if (d < bestD) {
        best = piece
        bestD = d
      }
    }
    return best
  }

  /** Where a ray meets a piece's own plane, within its outline. -1 when it misses. */
  private rayToPiece(piece: PeelPiece, origin: Vector3, dir: Vector3): number {
    piece.anchor.getWorldQuaternion(this.quat)
    const n = this.local.set(0, 0, 1).applyQuaternion(this.quat)
    const facing = n.dot(dir)
    if (Math.abs(facing) < 1e-4) return -1
    const t = this.scratch.copy(piece.anchor.position).sub(origin).dot(n) / facing
    if (t <= 0.05) return -1
    this.scratch.copy(origin).addScaledVector(dir, t)
    piece.anchor.worldToLocal(this.scratch)
    return Math.hypot(this.scratch.x, this.scratch.y) <= piece.radius ? t : -1
  }

  private aimPool(pool: Pool, hit: SurfacePoint): void {
    this.scratch.set(hit.x + hit.nx * 0.006, hit.y + hit.ny * 0.006, hit.z + hit.nz * 0.006)
    this.local.set(hit.nx, hit.ny, hit.nz)
    // A light that has gone out appears where it is wanted. One that is lit glides there.
    if (!pool.placed || pool.level < 0.02) {
      pool.at.copy(this.scratch)
      pool.normal.copy(this.local)
      pool.placed = true
      return
    }
    pool.at.lerp(this.scratch, 0.35)
    pool.normal.lerp(this.local, 0.2).normalize()
  }

  private stepPools(dt: number): void {
    for (let i = 0; i < this.pools.length; i++) {
      const pool = this.pools[i]
      const rate = REDUCE_MOTION ? 1 : Math.min(1, dt * (pool.goal > pool.level ? 9 : 5))
      pool.level += (pool.goal - pool.level) * rate
      const on = pool.level > 0.01 && pool.placed
      pool.mesh.visible = on
      if (!on) continue
      const u = pool.mat.uniforms
      const half = Math.max(pool.radius * 1.6, 0.08)
      u.uHalf.value = half
      u.uR.value = pool.radius
      u.uLevel.value = pool.level
      u.uRing.value = i === LANDING ? 1 : 0
      u.uTime.value = REDUCE_MOTION ? 0 : this.time
      pool.mesh.position.copy(pool.at)
      pool.mesh.quaternion.setFromUnitVectors(this.forward, pool.normal)
      pool.mesh.scale.setScalar(half * 2)
    }
  }

  private fuse(dt: number, presenting: boolean, frame: DepthFrame | null, camera: PerspectiveCamera, standIn: Object3D): void {
    this.fuseIn -= dt
    if (this.fuseIn <= 0 && this.queueAt >= this.queue.length) {
      this.fuseIn = FUSE_EVERY
      if (presenting) this.fuseHeadset(frame)
      else this.fuseDesk(camera, standIn)
    }
    if (this.queueAt < this.queue.length) {
      const end = Math.min(this.queue.length, this.queueAt + SAMPLE_BUDGET)
      this.field.integrateRange(this.queue, this.queueAt, end, this.queueFresh)
      this.queueFresh = false
      this.queueAt = end
    }
    const built = this.field.extract(EXTRACT_BUDGET, camera.position, false)
    const gone = this.field.takeRetired()
    for (let i = 0; i < gone.length; i++) this.hideChunk(gone[i])
    for (let i = 0; i < built.length; i++) this.showChunk(built[i].key, built[i].positions)
  }

  private fuseDesk(camera: PerspectiveCamera, standIn: Object3D): void {
    camera.updateMatrixWorld()
    // The first pass can run before anything has been drawn. Without this the
    // room's parts are all still at the origin, and the floor is read as a wall.
    standIn.updateMatrixWorld(true)
    const origin = camera.getWorldPosition(this.centre)
    const samples: DepthSample[] = []
    const w = 24
    const h = 18
    // Each pass looks through slightly different points, so the gaps between samples fill in.
    const jx = Math.random()
    const jy = Math.random()
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        this.ndc.set(((x + jx) / w) * 2 - 1, 1 - ((y + jy) / h) * 2)
        this.raycaster.setFromCamera(this.ndc, camera)
        const hits = this.raycaster.intersectObject(standIn, true)
        const hit = hits[0]
        if (!hit || hit.distance < 0.25 || hit.distance > 3.4) continue
        samples.push({ ox: origin.x, oy: origin.y, oz: origin.z, px: hit.point.x, py: hit.point.y, pz: hit.point.z })
      }
    }
    camera.getWorldDirection(this.scratch)
    this.enqueue(samples, this.scratch)
  }

  private fuseHeadset(frame: DepthFrame | null): void {
    if (!frame?.getViewerPose || !frame.getDepthInformation) {
      this.noteMissing('This browser cannot read the shape of the room')
      return
    }
    const space = boundSpace
    if (!space) return
    const pose = frame.getViewerPose(space)
    const view = pose?.views[0]
    if (!view) return
    let depth: CpuDepth | undefined
    try {
      depth = frame.getDepthInformation(view)
    } catch {
      depth = undefined
    }
    if (!depth || typeof depth.getDepthInMeters !== 'function') {
      this.noteMissing('This browser cannot read the shape of the room')
      return
    }
    this.depthMiss = 0
    this.depthNote = null
    const inverse = depth.normDepthBufferFromNormView.inverse.matrix
    const viewMatrix = view.transform.matrix
    const origin = transformPoint(viewMatrix, { x: 0, y: 0, z: 0 })
    const samples: DepthSample[] = []
    const stepX = Math.max(1, Math.floor(depth.width / 28))
    const stepY = Math.max(1, Math.floor(depth.height / 20))
    // Start each pass on a different pixel, so the gaps between samples fill in.
    const startX = Math.floor(Math.random() * stepX)
    const startY = Math.floor(Math.random() * stepY)
    for (let y = startY; y < depth.height; y += stepY) {
      for (let x = startX; x < depth.width; x += stepX) {
        const meters = depth.getDepthInMeters(x, y)
        const local = viewFromDepthPixel(inverse, (x + 0.5) / depth.width, (y + 0.5) / depth.height, meters)
        if (!local) continue
        const world = transformPoint(viewMatrix, local)
        samples.push({ ox: origin.x, oy: origin.y, oz: origin.z, px: world.x, py: world.y, pz: world.z })
      }
    }
    const ahead = transformPoint(viewMatrix, { x: 0, y: 0, z: -1 })
    this.scratch.set(ahead.x - origin.x, ahead.y - origin.y, ahead.z - origin.z)
    this.enqueue(samples, this.scratch)
  }

  /** What you are looking at is fused first, so the chunk cap keeps the center of the view. */
  private enqueue(samples: DepthSample[], forward?: Vector3): void {
    if (forward && forward.lengthSq() > 1e-6) {
      const fx = forward.x
      const fy = forward.y
      const fz = forward.z
      samples.sort((a, b) => alignment(b, fx, fy, fz) - alignment(a, fx, fy, fz))
    }
    this.queue = samples
    this.queueAt = 0
    this.queueFresh = true
  }

  private noteMissing(message: string): void {
    this.depthMiss += 1
    if (this.depthMiss < 4 || this.depthNote === message) return
    this.depthNote = message
    console.info(`[frame] ${message}`)
  }

  /** The scan itself is only ever a brief sparkle where the room has just been read. */
  private showChunk(key: string, positions: Float32Array): void {
    let mesh = this.meshes.get(key)
    if (!mesh) {
      mesh = new Mesh(new BufferGeometry(), this.sparkle)
      mesh.frustumCulled = false
      mesh.renderOrder = 1
      mesh.name = 'room-chunk'
      mesh.userData.born = this.time
      this.group.add(mesh)
      this.meshes.set(key, mesh)
    }
    mesh.visible = positions.length > 0
    const count = positions.length / 3
    const born = new Float32Array(count)
    born.fill(typeof mesh.userData.born === 'number' ? mesh.userData.born : this.time)
    setAttr(mesh.geometry, 'position', positions, 3)
    setAttr(mesh.geometry, 'aBorn', born, 1)
  }

  private hideChunk(key: string): void {
    const mesh = this.meshes.get(key)
    if (!mesh) return
    this.meshes.delete(key)
    mesh.removeFromParent()
    mesh.geometry.dispose()
  }
}

let boundSpace: XRReferenceSpace | null = null

/** The session's reference space, set from the renderer when a headset session starts. */
export function bindRoomSpace(space: XRReferenceSpace | null): void {
  boundSpace = space
}

function setAttr(geo: BufferGeometry, name: string, data: Float32Array, size: number): void {
  const prev = geo.getAttribute(name)
  if (prev && prev.itemSize === size && prev.array.length >= data.length) {
    ;(prev.array as Float32Array).set(data)
    ;(prev as BufferAttribute).needsUpdate = true
    geo.setDrawRange(0, data.length / size)
    return
  }
  geo.setAttribute(name, new BufferAttribute(data.slice(), size))
  geo.setDrawRange(0, data.length / size)
}

function alignment(sample: DepthSample, fx: number, fy: number, fz: number): number {
  const dx = sample.px - sample.ox
  const dy = sample.py - sample.oy
  const dz = sample.pz - sample.oz
  const len = Math.hypot(dx, dy, dz) || 1
  return (dx * fx + dy * fy + dz * fz) / len
}

function warmupTriangle(): BufferGeometry {
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]), 3))
  geo.setAttribute('aBorn', new BufferAttribute(new Float32Array([0, 0, 0]), 1))
  return geo
}
