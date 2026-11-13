import {
  BufferGeometry,
  Group,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
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
import { PEEL_SCALE, queryFlag } from '../app/experience.js'
import { makeContactRing } from '../look/contact.js'
import { motesEffect, type Effect } from '../look/effects.js'
import { makeDust } from '../look/motes.js'
import { PALETTE } from '../look/palette.js'
import { auraMaterial, poolMaterial, shellMaterial } from '../look/room-glow.js'
import { focusRect, transformPoint, viewFromDepth, type ViewRect } from './depth-project.js'
import { RoomField, surfacePoint, type DepthSample, type SurfacePoint } from './field.js'
import { GpuDepthReader, type GpuDepthInfo } from './gpu-depth.js'
import { liftShell, type Shell } from './object.js'
import { ObjectPiece, shellGeometry } from './object-piece.js'
import { PIECE_MAX, STICK_GAP, TOUCH_GAP, canLand, tangentBasis } from './patch.js'
import { PeelPiece, type PieceState, type RoomPiece } from './peel-piece.js'
import type { RoomPlates, Skin } from './plates.js'

const FUSE_EVERY = 0.16
/** Samples fused on one frame. The rest of a depth image waits, so the frame stays smooth. */
const SAMPLE_BUDGET = 140
/** Pieces kept. The oldest fades to make room for a new one. */
const MAX_PIECES = 12
/** A fingertip this far from a surface starts to gather light on it, metres. */
const POOL_REACH = 0.3
/** Pool slots: one per hand, one for where a carried piece will rest, one for where you look. */
const LANDING = 2
const GAZE = 3
/** How far away a thing can be and still be lifted by looking at it, metres. */
const GAZE_REACH = 3.2
/** Seconds a look stays live after the hand that was raised closes to pinch. */
const GAZE_GRACE = 0.6

/** Depth readings taken across the view each pass, and down it. */
const DEPTH_COLS = 28
const DEPTH_ROWS = 20
/** The close look: this much of the room around what has your attention, metres. */
const FOCUS_WIDE = 0.7
const FOCUS_TALL = 0.5
/** The fine field: small voxels, held only around what has your attention. */
const FINE_VOXEL = 0.02
const FINE_CHUNKS = 300
/** A piece of something big is lifted in its real shape when it has this much shape, metres. */
const SHAPELY = 0.06
/** Depth this close to a hand is the hand. */
const HAND_CLEAR = 0.14

interface DepthView {
  transform: { matrix: ArrayLike<number> }
  projectionMatrix: ArrayLike<number>
}

interface CpuDepth {
  /** `x` and `y` are places in the view from 0 up to, not including, 1. */
  getDepthInMeters(x: number, y: number): number
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

interface Touch {
  on: boolean
  readonly hit: SurfacePoint
}

/**
 * The room, lifted. Depth is fused into distance fields that are never shown:
 * a coarse one for the whole room and a fine one around whatever has your
 * attention. Look at a thing with a hand raised and light gathers on its
 * shape. Pinch, pull, and a copy of it comes away in three dimensions and
 * flies to your hand. A pinch right on a flat wall still peels a flat piece.
 *
 * Fusion runs on the CPU because Quest Browser's WebGL has no compute shaders.
 */
export class RoomScan {
  readonly group = new Group()
  active = false
  /** Set once when a headset session has no depth-sensing. */
  depthNote: string | null = null
  /** The piece is lifting: `speed` is how fast it is growing, 0..1 per second. */
  onLift: ((at: Vector3, speed: number, dt: number) => void) | null = null
  /** The piece came away. */
  onFree: ((at: Vector3) => void) | null = null
  /** The piece was set down on a surface. */
  onLand: ((at: Vector3) => void) | null = null
  /** Pixels per metre at one metre, so dust keeps its size at any distance. */
  pixelScale: () => number = () => 760
  private readonly field = new RoomField()
  private readonly fine: RoomField | null = queryFlag('fine') === '0' ? null : new RoomField(FINE_VOXEL, FINE_CHUNKS, 2)
  private readonly pieces: RoomPiece[] = []
  private readonly effects: Effect[] = []
  private readonly pools: Pool[] = []
  private readonly touch: Touch[] = [
    { on: false, hit: surfacePoint() },
    { on: false, hit: surfacePoint() },
  ]
  private readonly hands = [new Vector3(), new Vector3()]
  private readonly handOn = [false, false]
  private held: RoomPiece | null = null
  private landing: SurfacePoint | null = null
  private presenting = false
  private lastAmount = 0
  private fuseIn = 0
  private pass = 0
  private queue: DepthSample[] = []
  private queueField: RoomField = this.field
  private queueAt = 0
  private queueFresh = false
  private depthMiss = 0
  private depthMode: string | null = null
  private gpuDepth: GpuDepthReader | null = null
  private time = 0
  /** Where the room is seen from, and which way you are looking. */
  private readonly eye = new Vector3()
  private readonly gazeDir = new Vector3(0, 0, -1)
  private gazeUntil = -1
  /** What has your attention: where depth is read closely. */
  private readonly focus = new Vector3()
  private readonly lookedAt = new Vector3(0, -99, 0)
  private focusOn = false
  /** The light on the shape a pinch would lift. */
  private readonly preview: { mesh: Mesh; mat: ShaderMaterial; shell: Shell | null; level: number; goal: number; age: number; wait: number; remote: boolean }
  private readonly raycaster = new Raycaster()
  private readonly ndc = new Vector2()
  private readonly forward = new Vector3(0, 0, 1)
  private readonly scratch = new Vector3()
  private readonly local = new Vector3()
  private readonly centre = new Vector3()
  private readonly hitA = surfacePoint()
  private readonly hitB = surfacePoint()
  private readonly hitC = surfacePoint()
  private readonly hitD = surfacePoint()
  private readonly rim = [new Vector3(), new Vector3(), new Vector3(), new Vector3()]
  private readonly metres = new Float32Array(DEPTH_COLS * DEPTH_ROWS)
  private readonly us = new Float32Array(DEPTH_COLS * DEPTH_ROWS)
  private readonly vs = new Float32Array(DEPTH_COLS * DEPTH_ROWS)

  constructor(
    parent: Object3D,
    private readonly renderer: WebGLRenderer,
    private readonly plates: RoomPlates,
  ) {
    this.group.name = 'room-scan'
    this.group.visible = false
    parent.add(this.group)
    const quad = new PlaneGeometry(1, 1)
    for (let i = 0; i < 4; i++) {
      const mat = poolMaterial(PALETTE)
      const mesh = new Mesh(quad, mat)
      mesh.name = i === LANDING ? 'room-landing' : i === GAZE ? 'room-gaze' : 'room-pool'
      mesh.renderOrder = 2
      mesh.frustumCulled = false
      mesh.visible = false
      this.group.add(mesh)
      this.pools.push({ mesh, mat, level: 0, goal: 0, radius: 0.1, placed: false, at: new Vector3(), normal: new Vector3(0, 1, 0) })
    }
    const aura = auraMaterial(PALETTE)
    const auraMesh = new Mesh(new BufferGeometry(), aura)
    auraMesh.name = 'room-attention'
    auraMesh.renderOrder = 3
    auraMesh.frustumCulled = false
    auraMesh.visible = false
    this.group.add(auraMesh)
    this.preview = { mesh: auraMesh, mat: aura, shell: null, level: 0, goal: 0, age: 0, wait: 0, remote: false }
    // Compile the shaders now, so the first pinch does not hitch.
    const scene = new Scene()
    const shell = shellMaterial(PALETTE)
    scene.add(new Mesh(quad, this.pools[0].mat), new Mesh(quad, aura), new Mesh(quad, shell))
    const cam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
    cam.position.z = 1
    renderer.compile(scene, cam)
    shell.dispose()
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

  /** Whether the held (or newest) piece is a thing in its own shape, or a flat piece of a surface. */
  get kind(): 'object' | 'flat' | 'none' {
    const piece = this.held ?? this.pieces[this.pieces.length - 1]
    return piece ? (piece.flat ? 'flat' : 'object') : 'none'
  }

  /** The held piece is free and following the hand. */
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

  /** A carried piece is over somewhere it can rest. */
  get overSurface(): boolean {
    return this.landing !== null
  }

  /** Light is gathering under a hand. */
  get poolLevel(): number {
    return Math.max(this.pools[0].level, this.pools[1].level)
  }

  /** Light is on the shape of a thing that a pinch would lift, 0 to 1. */
  get attention(): number {
    return this.preview.level
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
   * Where the head is and which way it faces. `ready` is true while an open
   * hand is raised in view: only then does looking at a thing mean anything.
   */
  look(origin: Vector3, dir: Vector3, ready: boolean): void {
    this.eye.copy(origin)
    this.gazeDir.copy(dir).normalize()
    if (ready) this.gazeUntil = this.time + GAZE_GRACE
  }

  /** Where the hands are, so depth does not mistake them for the room. Null for a hand that is not tracked. */
  setHands(a: Vector3 | null, b: Vector3 | null): void {
    this.handOn[0] = a !== null
    this.handOn[1] = b !== null
    if (a) this.hands[0].copy(a)
    if (b) this.hands[1].copy(b)
  }

  /**
   * A pinch closed at `point`. It takes hold of a loose piece if one is there,
   * then of whatever the fingers are on, then of whatever is being looked at.
   * False when the pinch is on nothing.
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
    if (hit) {
      if (view) this.eye.copy(view)
      const shell = this.shellAt(hit)
      if (shell && (shell.kind === 'object' || shell.relief > SHAPELY)) this.beginObject(shell, point, false)
      else this.begin(hit, point, view)
      return true
    }
    // Nothing in reach. Take what is being looked at, from where you stand.
    if (this.time > this.gazeUntil) return false
    const far = this.surfaceOnRay(this.eye, this.gazeDir, GAZE_REACH, this.hitA)
    const loose = this.pieceOnRay(this.eye, this.gazeDir, far ? far.dist + 0.03 : GAZE_REACH)
    if (loose) {
      loose.grab(point, true)
      this.held = loose
      return true
    }
    if (!far) return false
    const seen = this.preview
    const shell = seen.shell && seen.remote && seen.age < 0.5 && seen.goal > 0 ? seen.shell : this.shellAt(far)
    if (!shell) return false
    this.beginObject(shell, point, true)
    return true
  }

  /**
   * The desk's pinch: a press along a ray. Returns how far along the ray it
   * took hold, or -1.
   */
  pressRay(origin: Vector3, dir: Vector3): number {
    if (!this.active || this.held) return -1
    const surface = this.surfaceOnRay(origin, dir, 3.6, this.hitA)
    const best = this.pieceOnRay(origin, dir, surface ? surface.dist + 0.03 : 3.6)
    if (best) {
      const t = best.rayHit(origin, dir)
      best.grab(this.scratch.copy(origin).addScaledVector(dir, t))
      this.held = best
      return t
    }
    if (!surface) return -1
    this.eye.copy(origin)
    const start = this.scratch.set(surface.x, surface.y, surface.z).clone()
    const shell = this.shellAt(surface)
    if (shell && (shell.kind === 'object' || shell.relief > SHAPELY)) this.beginObject(shell, start, false)
    else this.begin(surface, start, origin)
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
    const touch = this.touch[index]
    touch.on = false
    if (!origin || !this.active || this.held) {
      pool.goal = 0
      return
    }
    let hit = this.field.near(origin.x, origin.y, origin.z, 0.07, this.hitB)
    if (!hit && dir && dir.lengthSq() > 1e-6) {
      hit = this.surfaceOnRay(origin, this.local.copy(dir).normalize(), reach, this.hitB)
    }
    if (!hit) {
      pool.goal = 0
      return
    }
    touch.on = true
    Object.assign(touch.hit, hit)
    const close = 1 - Math.min(1, hit.dist / reach)
    pool.goal = level >= 0 ? level : Math.pow(close, 0.7)
    // The light draws in under the finger as it nears.
    pool.radius = level >= 0 ? 0.085 : 0.13 - 0.06 * close
    this.aimPool(pool, hit)
  }

  step(dt: number, presenting: boolean, frame: DepthFrame | null, camera: PerspectiveCamera, standIn: Object3D): void {
    this.time += dt
    if (presenting !== this.presenting) {
      // Going into or out of the headset changes which room this is: the desk's
      // stand-in must not be left standing in your real one.
      this.field.clear()
      this.fine?.clear()
      this.queue = []
      this.queueAt = 0
      this.depthMiss = 0
      this.depthNote = null
      this.preview.shell = null
      this.preview.goal = 0
    }
    this.presenting = presenting
    if (!this.active) return
    // On the desk the view camera is the eye. A headset says where its head is with `look`.
    if (!presenting) camera.getWorldPosition(this.eye)
    this.fuse(dt, presenting, frame, camera, standIn)
    this.attend(dt)
    this.stepHeld(dt)
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const piece = this.pieces[i]
      if (piece instanceof ObjectPiece) piece.eye.copy(this.eye)
      piece.step(dt)
      for (let e = 0; e < piece.events.length; e++) this.react(piece, piece.events[e])
      piece.events.length = 0
      if (!piece.done) continue
      if (piece.flat && piece.parted) this.field.heal(piece.source.x, piece.source.y, piece.source.z, piece.radius)
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
    for (let i = 0; i < this.pieces.length; i++) this.pieces[i].dispose()
    for (let i = 0; i < this.effects.length; i++) this.effects[i].dispose()
    this.pools[0].mesh.geometry.dispose()
    for (let i = 0; i < this.pools.length; i++) this.pools[i].mat.dispose()
    this.preview.mesh.geometry.dispose()
    this.preview.mat.dispose()
  }

  /** The surface a ray meets first, in whichever field sees it better. */
  private surfaceOnRay(origin: Vector3, dir: Vector3, reach: number, out: SurfacePoint): SurfacePoint | null {
    const coarse = this.field.surfaceAlong(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, reach, out)
    if (!this.fine) return coarse
    const fine = this.fine.surfaceAlong(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, reach, this.hitD)
    if (!fine || (coarse && coarse.dist < fine.dist - 0.06)) return coarse
    Object.assign(out, fine)
    return out
  }

  /** The shell a pinch at `hit` would lift: from the fine field where it has looked closely, or else the coarse one. */
  private shellAt(hit: SurfacePoint): Shell | null {
    const coarse = liftShell(this.field, hit, this.eye)
    const fine = this.fine
    if (!fine || !fine.near(hit.x, hit.y, hit.z, 0.04, this.hitD)) return coarse
    const close = liftShell(fine, hit, this.eye)
    if (!close) return coarse
    // The close look only covers part of something big. Then the coarse shell is the whole of it.
    if (coarse && coarse.kind === 'object' && coarse.radius > close.radius * 1.4 + 0.05) return coarse
    return close
  }

  /** Make room: the oldest piece that nobody is holding goes. */
  private makeRoom(): void {
    let live = 0
    for (let i = 0; i < this.pieces.length; i++) if (this.pieces[i].state !== 'fading') live++
    for (let i = 0; i < this.pieces.length && live >= MAX_PIECES; i++) {
      if (this.pieces[i].state === 'fading') continue
      this.pieces[i].fade()
      live--
    }
  }

  /** A picture of the room around `centre`, out to `r`, across the plane that faces along `n`. */
  private takeSkin(centre: Vector3, n: Vector3, r: number): Skin | null {
    const basis = tangentBasis(n.x, n.y, n.z)
    this.rim[0].copy(centre).addScaledVector(this.local.set(basis.tx, basis.ty, basis.tz), r)
    this.rim[1].copy(centre).addScaledVector(this.local, -r)
    this.rim[2].copy(centre).addScaledVector(this.local.set(basis.bx, basis.by, basis.bz), r)
    this.rim[3].copy(centre).addScaledVector(this.local, -r)
    // The lights and other pieces must not be in the desk's picture of the room.
    const shown = this.group.visible
    this.group.visible = false
    const skin = this.plates.skin(centre, this.rim, this.presenting)
    this.group.visible = shown
    return skin
  }

  /** Peel a flat piece off the surface at `hit`. */
  private begin(hit: SurfacePoint, start: Vector3, view: Vector3 | null): void {
    const pinch = start.clone()
    this.makeRoom()
    this.centre.set(hit.x, hit.y, hit.z)
    const skin = this.takeSkin(this.centre, this.scratch.set(hit.nx, hit.ny, hit.nz), PIECE_MAX * 1.15)
    const piece = new PeelPiece({ hit, start: pinch, view, field: this.field, skin, palette: PALETTE, scale: PEEL_SCALE })
    this.hold(piece)
  }

  /** Lift a thing out in its own shape. */
  private beginObject(shell: Shell, start: Vector3, remote: boolean): void {
    const pinch = start.clone()
    this.makeRoom()
    this.centre.set(shell.cx, shell.cy, shell.cz)
    // The picture is taken across the way the thing is seen.
    this.scratch.copy(this.eye).sub(this.centre)
    if (this.scratch.lengthSq() < 1e-6) this.scratch.set(0, 0, 1)
    const skin = this.takeSkin(this.centre, this.scratch.normalize(), shell.radius)
    const piece = new ObjectPiece({ shell, start: pinch, skin, palette: PALETTE, scale: PEEL_SCALE, remote })
    piece.eye.copy(this.eye)
    this.hold(piece)
  }

  private hold(piece: RoomPiece): void {
    this.group.add(piece.holeAnchor, piece.anchor)
    this.pieces.push(piece)
    this.held = piece
    this.lastAmount = 0
    this.preview.goal = 0
    this.preview.level = 0
  }

  /**
   * What has your attention: what a fingertip is nearing, or what you are
   * looking at with a hand raised. Depth is read closely there, and if it is a
   * thing that can be lifted whole, light gathers on its shape.
   */
  private attend(dt: number): void {
    const seen = this.preview
    const dot = this.pools[GAZE]
    dot.goal = 0
    seen.wait -= dt
    seen.age += dt
    let target: SurfacePoint | null = null
    let remote = false
    if (!this.held) {
      if (this.touch[0].on) target = this.touch[0].hit
      else if (this.touch[1].on) target = this.touch[1].hit
      else if (this.time <= this.gazeUntil) {
        target = this.surfaceOnRay(this.eye, this.gazeDir, GAZE_REACH, this.hitC)
        remote = true
      }
    }
    this.focusOn = target !== null
    if (target) {
      const at = target
      this.focus.set(at.x, at.y, at.z)
      const on = (shell: Shell | null) =>
        shell !== null && shell.kind === 'object' && Math.hypot(at.x - shell.cx, at.y - shell.cy, at.z - shell.cz) <= shell.radius * 1.15 + 0.02
      // Look again when the attention has moved somewhere new, and now and then as depth fills in.
      const moved = Math.hypot(at.x - this.lookedAt.x, at.y - this.lookedAt.y, at.z - this.lookedAt.z) > 0.05
      if (seen.wait <= 0 && (seen.age > 0.8 || (moved && !on(seen.shell)))) {
        seen.wait = 0.22
        this.lookedAt.set(at.x, at.y, at.z)
        this.show(this.shellAt(at), remote)
      }
      seen.goal = on(seen.shell) ? 1 : 0
      if (remote && seen.goal === 0) {
        // Nothing to lift whole here: a small soft light where you are looking.
        dot.goal = 0.55
        dot.radius = 0.06
        this.aimPool(dot, at)
      }
    } else seen.goal = 0
    const rate = REDUCE_MOTION ? 1 : Math.min(1, dt * (seen.goal > seen.level ? 6 : 4))
    seen.level += (seen.goal - seen.level) * rate
    seen.mesh.visible = seen.level > 0.01
    seen.mat.uniforms.uLevel.value = seen.level * 0.6
    seen.mat.uniforms.uTime.value = REDUCE_MOTION ? 0 : this.time
  }

  /** Put the light on a new shape. */
  private show(shell: Shell | null, remote: boolean): void {
    const seen = this.preview
    const moved = !seen.shell || !shell || Math.hypot(shell.cx - seen.shell.cx, shell.cy - seen.shell.cy, shell.cz - seen.shell.cz) > 0.08
    seen.shell = shell
    seen.remote = remote
    seen.age = 0
    if (!shell || shell.kind !== 'object') return
    seen.mesh.geometry.dispose()
    seen.mesh.geometry = shellGeometry(shell)
    seen.mesh.position.set(shell.cx, shell.cy, shell.cz)
    seen.mat.uniforms.uLow.value = shell.bottom - shell.cy
    seen.mat.uniforms.uSpan.value = Math.max(0.02, (shell.cy - shell.bottom) * 2)
    // The light does not jump from one thing to the next: it dims and comes up again.
    if (moved) seen.level *= 0.25
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
    const c = piece.center(this.centre)
    let hit: SurfacePoint | null
    if (piece instanceof ObjectPiece) {
      // Is there somewhere level just under it to stand on?
      // Looked for from its top down, so one that has been pushed into a table is set on top of it.
      hit = this.field.surfaceAlong(c.x, c.y + piece.stand, c.z, 0, -1, 0, piece.stand * 2 + STICK_GAP, this.hitB)
      if (hit && hit.ny < 0.6) hit = null
    } else {
      // Is there a surface just under the piece that it could lie on?
      const n = piece.normal
      hit =
        this.field.near(c.x, c.y, c.z, STICK_GAP, this.hitB) ??
        this.field.surfaceAlong(c.x + n.x * 0.02, c.y + n.y * 0.02, c.z + n.z * 0.02, -n.x, -n.y, -n.z, STICK_GAP + 0.03, this.hitB)
    }
    if (!hit) return
    const fromSource = piece.flat
      ? Math.hypot(hit.x - piece.source.x, hit.y - piece.source.y, hit.z - piece.source.z)
      : c.distanceTo(piece.source)
    if (!canLand(fromSource, piece.radius, piece.travelled)) return
    this.landing = hit
    pool.goal = 1
    pool.radius = piece.flat ? piece.radius : Math.min(0.2, piece.radius * 0.7)
    this.aimPool(pool, hit)
  }

  private react(piece: RoomPiece, event: 'freed' | 'landed'): void {
    if (event === 'freed') {
      // New depth must not paint the wall back in behind a flat piece's light.
      if (piece.flat) this.field.carve(piece.source.x, piece.source.y, piece.source.z, piece.radius * 0.8)
      if (!REDUCE_MOTION) {
        const dust = makeDust(piece.flat ? piece.radius * 0.8 : Math.min(0.14, piece.radius * 0.6), PALETTE, this.pixelScale(), piece.flat ? 70 : 40)
        piece.holeAnchor.add(dust.group)
        this.effects.push(motesEffect(dust))
      }
      this.onFree?.(piece.source)
      return
    }
    if (piece.flat && !REDUCE_MOTION) {
      const ring = makeContactRing(piece.radius * 1.5, piece.radius * 1.5, PALETTE)
      ring.group.position.z = 0.001
      piece.anchor.add(ring.group)
      this.effects.push(ring)
    }
    this.onLand?.(piece.center(this.centre))
  }

  /** A loose piece with this point on it, or null. */
  private pieceAt(point: Vector3): RoomPiece | null {
    let best: RoomPiece | null = null
    let bestD = Infinity
    for (let i = 0; i < this.pieces.length; i++) {
      const piece = this.pieces[i]
      if (!piece.loose) continue
      const d = piece.contains(point)
      if (d >= 0 && d < bestD) {
        best = piece
        bestD = d
      }
    }
    return best
  }

  /** The nearest loose piece a ray meets before `reach`, or null. */
  private pieceOnRay(origin: Vector3, dir: Vector3, reach: number): RoomPiece | null {
    let best: RoomPiece | null = null
    let bestT = reach
    for (let i = 0; i < this.pieces.length; i++) {
      const piece = this.pieces[i]
      if (!piece.loose) continue
      const t = piece.rayHit(origin, dir)
      if (t > 0 && t < bestT) {
        best = piece
        bestT = t
      }
    }
    return best
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
      u.uRing.value = i === LANDING || i === GAZE ? 1 : 0
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
      this.pass += 1
      // Every other pass is a close look at what has your attention.
      const close = this.fine !== null && this.focusOn && this.pass % 2 === 1
      if (presenting) this.fuseHeadset(frame, close)
      else this.fuseDesk(camera, standIn, close)
    }
    if (this.queueAt < this.queue.length) {
      const end = Math.min(this.queue.length, this.queueAt + SAMPLE_BUDGET)
      this.queueField.integrateRange(this.queue, this.queueAt, end, this.queueFresh)
      this.queueFresh = false
      this.queueAt = end
    }
    // Chunks a field let go of are gone. Nothing is drawn from them.
    this.field.takeRetired()
    this.fine?.takeRetired()
  }

  private fuseDesk(camera: PerspectiveCamera, standIn: Object3D, close: boolean): void {
    camera.updateMatrixWorld()
    // The first pass can run before anything has been drawn. Without this the
    // room's parts are all still at the origin, and the floor is read as a wall.
    standIn.updateMatrixWorld(true)
    const origin = camera.getWorldPosition(this.centre)
    const samples: DepthSample[] = []
    // Each pass looks through slightly different points, so the gaps between samples fill in.
    const jx = Math.random()
    const jy = Math.random()
    if (close) {
      // The close look: rays through a small window around what has your attention.
      const toward = this.local.copy(this.focus).sub(origin)
      const dist = toward.length()
      toward.normalize()
      const right = this.scratch.crossVectors(toward, camera.up).normalize()
      const up = this.rim[0].crossVectors(right, toward)
      for (let y = 0; y < DEPTH_ROWS; y++) {
        for (let x = 0; x < DEPTH_COLS; x++) {
          const ax = ((x + jx) / DEPTH_COLS - 0.5) * FOCUS_WIDE
          const ay = ((y + jy) / DEPTH_ROWS - 0.5) * FOCUS_TALL
          this.rim[1].copy(toward).multiplyScalar(dist).addScaledVector(right, ax).addScaledVector(up, ay).normalize()
          this.raycaster.set(origin, this.rim[1])
          const hit = this.raycaster.intersectObject(standIn, true)[0]
          if (!hit || hit.distance < 0.25 || hit.distance > 3.4) continue
          samples.push({ ox: origin.x, oy: origin.y, oz: origin.z, px: hit.point.x, py: hit.point.y, pz: hit.point.z })
        }
      }
      this.enqueue(samples, this.fine ?? this.field)
      return
    }
    const w = 24
    const h = 18
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        this.ndc.set(((x + jx) / w) * 2 - 1, 1 - ((y + jy) / h) * 2)
        this.raycaster.setFromCamera(this.ndc, camera)
        const hit = this.raycaster.intersectObject(standIn, true)[0]
        if (!hit || hit.distance < 0.25 || hit.distance > 3.4) continue
        samples.push({ ox: origin.x, oy: origin.y, oz: origin.z, px: hit.point.x, py: hit.point.y, pz: hit.point.z })
      }
    }
    camera.getWorldDirection(this.scratch)
    this.enqueue(samples, this.field, this.scratch)
  }

  private fuseHeadset(frame: DepthFrame | null, close: boolean): void {
    if (!frame?.getViewerPose) {
      this.noteMissing('This browser cannot read the shape of the room')
      return
    }
    const space = boundSpace
    if (!space) return
    const pose = frame.getViewerPose(space)
    const view = pose?.views[0]
    if (!view) return
    const session = this.renderer.xr.getSession() as (XRSession & { depthUsage?: string; depthDataFormat?: string }) | null
    let usage: string | undefined
    try {
      usage = session?.depthUsage
    } catch {
      // Reading it throws when the session was not given depth at all.
      usage = undefined
    }
    if (usage && usage !== this.depthMode) {
      this.depthMode = usage
      console.info(`[frame] room depth is ${usage}`)
    }
    if (usage === 'gpu-optimized') this.fuseTexture(view, close)
    else this.fuseNumbers(frame, view, close)
  }

  /** Depth the browser hands over as numbers: `cpu-optimized`. */
  private fuseNumbers(frame: DepthFrame, view: DepthView, close: boolean): void {
    let depth: CpuDepth | undefined
    try {
      depth = frame.getDepthInformation?.(view)
    } catch {
      depth = undefined
    }
    if (!depth || typeof depth.getDepthInMeters !== 'function') {
      this.noteMissing('This browser cannot read the shape of the room')
      return
    }
    this.depthMiss = 0
    this.depthNote = null
    const rect = close ? focusRect(view.transform.matrix, view.projectionMatrix, this.focus, FOCUS_WIDE, FOCUS_TALL) : null
    // Each pass reads slightly different places, so the gaps between them fill in.
    const jx = Math.random()
    const jy = Math.random()
    for (let row = 0; row < DEPTH_ROWS; row++) {
      for (let col = 0; col < DEPTH_COLS; col++) {
        const k = col + row * DEPTH_COLS
        let u = (col + jx) / DEPTH_COLS
        let v = (row + jy) / DEPTH_ROWS
        if (rect) {
          u = rect.u + u * rect.w
          v = rect.v + v * rect.h
        }
        u = Math.min(0.999, u)
        v = Math.min(0.999, v)
        this.us[k] = u
        this.vs[k] = v
        try {
          this.metres[k] = depth.getDepthInMeters(u, v)
        } catch {
          this.metres[k] = 0
        }
      }
    }
    this.fuseGrid(view.transform.matrix, view.projectionMatrix, rect && this.fine ? this.fine : this.field)
  }

  /** Depth the browser hands over as a texture: `gpu-optimized`, which is what Quest Browser gives. */
  private fuseTexture(view: DepthView, close: boolean): void {
    const xr = this.renderer.xr
    let info: GpuDepthInfo | null | undefined
    try {
      const binding = xr.getBinding() as unknown as { getDepthInformation?: (view: DepthView) => GpuDepthInfo | null } | null
      info = binding?.getDepthInformation?.(view)
    } catch {
      info = undefined
    }
    if (!info || info.isValid === false || !info.texture) {
      this.noteMissing('This browser cannot read the shape of the room')
      return
    }
    this.depthMiss = 0
    this.depthNote = null
    if (!this.gpuDepth) {
      this.gpuDepth = new GpuDepthReader(DEPTH_COLS, DEPTH_ROWS)
      // three.js would hide anything behind the sensed room. Pieces lie right on
      // its surfaces, where depth that rough would make them flicker.
      xr.getDepthSensingMesh = () => null as never
    }
    const jx = Math.random()
    const jy = Math.random()
    // The reading comes back a few frames later, so keep where it was taken from.
    const viewMatrix = Float32Array.from(info.transform?.matrix ?? view.transform.matrix)
    const projection = Float32Array.from(info.projectionMatrix ?? view.projectionMatrix)
    const rect: ViewRect | null = close ? focusRect(viewMatrix, projection, this.focus, FOCUS_WIDE, FOCUS_TALL) : null
    const reading = this.gpuDepth.read(this.renderer, info, jx, jy, rect)
    if (!reading) return
    reading.then(
      (metres) => {
        if (!this.presenting) return
        for (let row = 0; row < DEPTH_ROWS; row++) {
          for (let col = 0; col < DEPTH_COLS; col++) {
            const k = col + row * DEPTH_COLS
            const u = (col + jx) / DEPTH_COLS
            // The texture's rows run bottom to top; a view's run top to bottom.
            const v = 1 - (row + jy) / DEPTH_ROWS
            this.us[k] = rect ? rect.u + u * rect.w : u
            this.vs[k] = rect ? rect.v + v * rect.h : v
            this.metres[k] = metres[k]
          }
        }
        this.fuseGrid(viewMatrix, projection, rect && this.fine ? this.fine : this.field)
      },
      (error: unknown) => {
        console.warn(`[frame] room depth could not be read back: ${error instanceof Error ? error.message : String(error)}`)
        this.depthNote = 'This browser cannot read the shape of the room'
      },
    )
  }

  /**
   * Turn the grid of readings in `us`, `vs` and `metres` into points in the
   * room and queue them for a field. Readings that are a hand, or the smear
   * between a near thing and what is behind it, are left out.
   */
  private fuseGrid(viewMatrix: ArrayLike<number>, projection: ArrayLike<number>, field: RoomField): void {
    const origin = transformPoint(viewMatrix, { x: 0, y: 0, z: 0 })
    const samples: DepthSample[] = []
    const m = this.metres
    for (let row = 0; row < DEPTH_ROWS; row++) {
      for (let col = 0; col < DEPTH_COLS; col++) {
        const k = col + row * DEPTH_COLS
        const d = m[k]
        if (!(d > 0)) continue
        // Depth blurs across an edge. A reading part way between its neighbours on either side is that blur.
        if (col > 0 && col < DEPTH_COLS - 1 && between(d, m[k - 1], m[k + 1])) continue
        if (row > 0 && row < DEPTH_ROWS - 1 && between(d, m[k - DEPTH_COLS], m[k + DEPTH_COLS])) continue
        const local = viewFromDepth(projection, this.us[k], this.vs[k], d)
        if (!local) continue
        const world = transformPoint(viewMatrix, local)
        if (this.isHand(world.x, world.y, world.z)) continue
        samples.push({ ox: origin.x, oy: origin.y, oz: origin.z, px: world.x, py: world.y, pz: world.z })
      }
    }
    const ahead = transformPoint(viewMatrix, { x: 0, y: 0, z: -1 })
    this.scratch.set(ahead.x - origin.x, ahead.y - origin.y, ahead.z - origin.z)
    this.enqueue(samples, field, field === this.field ? this.scratch : undefined)
  }

  private isHand(x: number, y: number, z: number): boolean {
    for (let i = 0; i < 2; i++) {
      if (!this.handOn[i]) continue
      const h = this.hands[i]
      if (Math.hypot(x - h.x, y - h.y, z - h.z) < HAND_CLEAR) return true
    }
    return false
  }

  /** What you are looking at is fused first, so the chunk cap keeps the center of the view. */
  private enqueue(samples: DepthSample[], field: RoomField, forward?: Vector3): void {
    if (forward && forward.lengthSq() > 1e-6) {
      const fx = forward.x
      const fy = forward.y
      const fz = forward.z
      samples.sort((a, b) => alignment(b, fx, fy, fz) - alignment(a, fx, fy, fz))
    }
    this.queue = samples
    this.queueField = field
    this.queueAt = 0
    this.queueFresh = true
  }

  private noteMissing(message: string): void {
    this.depthMiss += 1
    if (this.depthMiss < 4 || this.depthNote === message) return
    this.depthNote = message
    console.info(`[frame] ${message}`)
  }
}

let boundSpace: XRReferenceSpace | null = null

/** The session's reference space, set from the renderer when a headset session starts. */
export function bindRoomSpace(space: XRReferenceSpace | null): void {
  boundSpace = space
}

/** True when a depth reading sits well between the readings either side of it. */
function between(d: number, a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) return false
  const gap = 0.04 + 0.03 * d
  return d - Math.min(a, b) > gap && Math.max(a, b) - d > gap
}

function alignment(sample: DepthSample, fx: number, fy: number, fz: number): number {
  const dx = sample.px - sample.ox
  const dy = sample.py - sample.oy
  const dz = sample.pz - sample.oz
  const len = Math.hypot(dx, dy, dz) || 1
  return (dx * fx + dy * fy + dz * fz) / len
}
