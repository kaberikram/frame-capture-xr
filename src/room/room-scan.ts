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
import { PEEL_SCALE, queryFlag } from '../app/experience.js'
import { makeContactRing } from '../look/contact.js'
import { motesEffect, type Effect } from '../look/effects.js'
import { makeDust } from '../look/motes.js'
import { PALETTE } from '../look/palette.js'
import { cutoutMaterial, ghostMaterial, poolMaterial, shellMaterial } from '../look/room-glow.js'
import { focusRect, transformPoint, viewFromDepth, type ViewRect } from './depth-project.js'
import { RoomField, surfacePoint, type DepthSample, type SurfacePoint } from './field.js'
import { GpuDepthReader, type GpuDepthInfo } from './gpu-depth.js'
import { liftShell, pickShell, type Shell } from './object.js'
import { ObjectPiece, shellGeometry, shellImageCoords } from './object-piece.js'
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
/** Pool slots: one per hand, and one for where a carried piece will rest. */
const LANDING = 2
/** The size of a piece of bare surface, the same in its outline and when it comes away, metres. */
const CUT_R = 0.11
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
/** Depth this close to a joint of a hand or forearm is the hand, metres. Depth arrives a little late, so it is generous. */
const HAND_CLEAR = 0.055
/** Hand joints kept: both hands' joints and a few points down each forearm. */
const MAX_JOINTS = 64

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
  /** Where it is gliding to. */
  readonly to: Vector3
  readonly toNormal: Vector3
}

interface Touch {
  on: boolean
  readonly hit: SurfacePoint
  /** The fingertip, and how near it is to the surface, 0..1. */
  readonly from: Vector3
  near: number
}

/**
 * What a pinch would take, shown before the pinch: the ghost of a thing, or
 * the outline of a cut in a bare surface. A pinch takes exactly this.
 */
interface Preview {
  /** The thing whose ghost shows. */
  shell: Shell | null
  /** It was found by looking, not by reaching. */
  remote: boolean
  age: number
  wait: number
  /** How near the hand is, 0..1. */
  near: number
  readonly ghost: Mesh
  readonly ghostMat: ShaderMaterial
  ghostLevel: number
  /** The ghost's picture, taken before the hand arrived. The copy a pinch lifts keeps it. */
  ghostSkin: Skin | null
  readonly cut: Mesh
  readonly cutMat: ShaderMaterial
  cutLevel: number
  cutDraw: number
  /** A picture of the cut, taken as the hand neared it, before it covered the spot. */
  cutSkin: Skin | null
  readonly cutSkinAt: Vector3
  cutSkinWait: number
  /** The torn shape the cut will have. */
  seed: number
  readonly cutAt: Vector3
  readonly cutNormal: Vector3
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
    { on: false, hit: surfacePoint(), from: new Vector3(), near: 0 },
    { on: false, hit: surfacePoint(), from: new Vector3(), near: 0 },
  ]
  /** Where the hands are, joint by joint, so depth does not mistake them for the room. */
  private readonly joints = Array.from({ length: MAX_JOINTS }, () => new Vector3())
  private jointCount = 0
  private readonly jointLo = new Vector3()
  private readonly jointHi = new Vector3()
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
  private readonly preview: Preview
  private readonly cutHand = new Vector3()
  /** Pieces that came without a camera picture, and when. A later frame that saw the spot will do. */
  private readonly bare = new Map<RoomPiece, number>()
  /** Flat pieces whose place in the wall has been given back. */
  private readonly healed = new Set<RoomPiece>()
  private bareWait = 0
  /** The mouse's last ray, on the desk. */
  private readonly mouse = { on: false, origin: new Vector3(), dir: new Vector3(), reach: 3.6, level: 0.8 }
  private readonly raycaster = new Raycaster()
  private readonly ndc = new Vector2()
  private readonly forward = new Vector3(0, 0, 1)
  private readonly scratch = new Vector3()
  private readonly local = new Vector3()
  private readonly centre = new Vector3()
  private readonly quat = new Quaternion()
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
    for (let i = 0; i < 3; i++) {
      const mat = poolMaterial(PALETTE)
      const mesh = new Mesh(quad, mat)
      mesh.name = i === LANDING ? 'room-landing' : 'room-pool'
      mesh.renderOrder = 2
      mesh.frustumCulled = false
      mesh.visible = false
      this.group.add(mesh)
      this.pools.push({ mesh, mat, level: 0, goal: 0, radius: 0.1, placed: false, at: new Vector3(), normal: new Vector3(0, 1, 0), to: new Vector3(), toNormal: new Vector3(0, 1, 0) })
    }
    const ghostMat = ghostMaterial(PALETTE)
    const ghost = new Mesh(new BufferGeometry(), ghostMat)
    ghost.name = 'room-ghost'
    // Over pieces already set down, so a ghost is never hidden under an old copy.
    ghost.renderOrder = 7
    ghost.frustumCulled = false
    ghost.visible = false
    const seed = Math.random() * 40
    const cutMat = cutoutMaterial(PALETTE, seed)
    const cut = new Mesh(quad, cutMat)
    cut.name = 'room-cut'
    cut.renderOrder = 3
    cut.frustumCulled = false
    cut.visible = false
    this.group.add(ghost, cut)
    this.preview = {
      shell: null,
      remote: false,
      age: 0,
      wait: 0,
      near: 0,
      ghost,
      ghostMat,
      ghostLevel: 0,
      ghostSkin: null,
      cut,
      cutMat,
      cutLevel: 0,
      cutDraw: 0,
      cutSkin: null,
      cutSkinAt: new Vector3(),
      cutSkinWait: 0,
      seed,
      cutAt: new Vector3(),
      cutNormal: new Vector3(0, 1, 0),
    }
    // Compile the shaders now, so the first pinch does not hitch.
    const scene = new Scene()
    const shell = shellMaterial(PALETTE)
    scene.add(new Mesh(quad, this.pools[0].mat), new Mesh(quad, ghostMat), new Mesh(quad, cutMat), new Mesh(quad, shell))
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

  /** The ghost of a thing a pinch would lift is showing, 0 to 1. */
  get attention(): number {
    return this.preview.ghostLevel
  }

  /** The outline of the cut a pinch would make in a bare surface is showing, 0 to 1. */
  get outline(): number {
    return this.preview.cutLevel
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

  /**
   * Where the hands are, every joint and a few points down each forearm, so
   * depth readings of a hand are not fused into the room.
   */
  setHandJoints(points: readonly Vector3[], count: number): void {
    const n = Math.min(count, MAX_JOINTS)
    this.jointCount = n
    if (n === 0) return
    this.jointLo.set(Infinity, Infinity, Infinity)
    this.jointHi.set(-Infinity, -Infinity, -Infinity)
    for (let i = 0; i < n; i++) {
      this.joints[i].copy(points[i])
      this.jointLo.min(points[i])
      this.jointHi.max(points[i])
    }
    this.jointLo.subScalar(HAND_CLEAR)
    this.jointHi.addScalar(HAND_CLEAR)
  }

  /**
   * A pinch closed at `point`. It takes hold of a loose piece if one is there,
   * then of whatever was showing as about to be taken (a thing's ghost, or the
   * outline of a cut), then of whatever the fingers are on, then of whatever
   * thing is being looked at. False when the pinch is on nothing.
   */
  press(point: Vector3, view: Vector3 | null): boolean {
    if (!this.active || this.held) return false
    const piece = this.pieceAt(point)
    if (piece) {
      piece.grab(point)
      this.held = piece
      return true
    }
    if (view) this.eye.copy(view)
    // What you saw is what you get.
    const seen = this.preview
    if (seen.shell && seen.ghostLevel > 0.25) {
      // A ghost shows only for what the finger is reaching toward or the eye is
      // on. Pinched short of it, it comes to the hand.
      const away = Math.hypot(point.x - seen.shell.cx, point.y - seen.shell.cy, point.z - seen.shell.cz)
      this.beginObject(seen.shell, point, away > seen.shell.radius + TOUCH_GAP)
      return true
    }
    if (seen.cutLevel > 0.25 && point.distanceTo(seen.cutAt) <= CUT_R + POOL_REACH) {
      this.beginCut(point, view)
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
      const shell = this.shellAt(hit)
      if (shell && shell.kind === 'object') this.beginObject(shell, point, false)
      else this.begin(hit, point, view, Math.random() * 40, CUT_R)
      return true
    }
    // Nothing in reach. Take the thing being looked at, from where you stand.
    if (this.time > this.gazeUntil) return false
    const far = this.surfaceOnRay(this.eye, this.gazeDir, GAZE_REACH, this.hitA)
    const loose = this.pieceOnRay(this.eye, this.gazeDir, far ? far.dist + 0.03 : GAZE_REACH)
    if (loose) {
      loose.grab(point, true)
      this.held = loose
      return true
    }
    if (!far) return false
    // Only a whole thing comes from across the room. A bare wall stays where it is.
    const shell = this.shellAt(far)
    if (!shell || shell.kind !== 'object') return false
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
    const start = new Vector3(surface.x, surface.y, surface.z)
    const seen = this.preview
    if (seen.shell && seen.ghostLevel > 0.25 && start.distanceTo(this.local.set(seen.shell.cx, seen.shell.cy, seen.shell.cz)) <= seen.shell.radius + 0.03) {
      this.beginObject(seen.shell, start, false)
      return surface.dist
    }
    if (seen.cutLevel > 0.25 && start.distanceTo(seen.cutAt) <= CUT_R) {
      this.beginCut(start, origin)
      return surface.dist
    }
    const shell = this.shellAt(surface)
    if (shell && shell.kind === 'object') this.beginObject(shell, start, false)
    else this.begin(surface, start, origin, Math.random() * 40, CUT_R)
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
    // The mouse only says where it is when it moves. Keep its ray, and look along it again every frame.
    if (level >= 0 && index === 0) {
      if (origin && dir) {
        this.mouse.origin.copy(origin)
        this.mouse.dir.copy(dir)
        this.mouse.reach = reach
        this.mouse.level = level
        this.mouse.on = true
      } else this.mouse.on = false
    } else if (index === 0 && !origin) this.mouse.on = false
    this.look1(index, origin, dir, reach, level)
  }

  private look1(index: 0 | 1, origin: Vector3 | null, dir: Vector3 | null, reach: number, level: number): void {
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
    touch.from.copy(origin)
    touch.near = level >= 0 ? level : close
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
      this.preview.ghostLevel = 0
      this.preview.cutLevel = 0
      this.releaseGhostSkin()
      this.preview.cutSkin?.dispose()
      this.preview.cutSkin = null
    }
    this.presenting = presenting
    if (!this.active) return
    // On the desk the view camera is the eye. A headset says where its head is with `look`.
    if (!presenting) camera.getWorldPosition(this.eye)
    this.fuse(dt, presenting, frame, camera, standIn)
    if (!presenting && this.mouse.on && !this.held) this.look1(0, this.mouse.origin, this.mouse.dir, this.mouse.reach, this.mouse.level)
    this.attend(dt)
    this.dress(dt)
    this.stepHeld(dt)
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const piece = this.pieces[i]
      if (piece instanceof ObjectPiece) piece.eye.copy(this.eye)
      piece.step(dt)
      for (let e = 0; e < piece.events.length; e++) this.react(piece, piece.events[e])
      piece.events.length = 0
      // Once the light where a flat piece left has gone, the wall there is whole again.
      if (piece instanceof PeelPiece && piece.closed && !this.healed.has(piece)) {
        this.healed.add(piece)
        this.field.heal(piece.source.x, piece.source.y, piece.source.z, piece.radius)
      }
      if (!piece.done) continue
      if (piece.flat && piece.parted && !this.healed.has(piece)) this.field.heal(piece.source.x, piece.source.y, piece.source.z, piece.radius)
      this.healed.delete(piece)
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
    this.preview.ghost.geometry.dispose()
    this.preview.ghostMat.dispose()
    this.preview.cutMat.dispose()
    this.releaseGhostSkin()
    this.preview.cutSkin?.dispose()
    this.preview.cutSkin = null
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
    return pickShell(coarse, liftShell(fine, hit, this.eye))
  }

  /**
   * A piece that came without a camera picture (no kept frame had seen the
   * spot) keeps asking for one for a few seconds. The room behind it has not
   * changed, and the piece itself is never in a camera frame.
   */
  private dress(dt: number): void {
    if (this.bare.size === 0) return
    this.bareWait -= dt
    if (this.bareWait > 0) return
    this.bareWait = 0.3
    for (const [piece, since] of this.bare) {
      if (!piece.needsSkin || piece.done || this.time - since > 3) {
        this.bare.delete(piece)
        continue
      }
      // Across the way it faces, or for a thing, across the way it is seen.
      if (piece.flat) this.scratch.copy(piece.normal)
      else this.scratch.copy(this.eye).sub(piece.source)
      if (this.scratch.lengthSq() < 1e-6) this.scratch.set(0, 0, 1)
      const skin = this.takeSkin(piece.source, this.scratch.normalize(), Math.max(0.03, piece.radius))
      if (!skin) continue
      piece.setSkin(skin)
      this.bare.delete(piece)
    }
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

  /** Peel a flat piece off the surface at `hit`, `radius` across with the torn shape `seed`. */
  private begin(hit: SurfacePoint, start: Vector3, view: Vector3 | null, seed: number, radius: number, taken: Skin | null = null): void {
    const pinch = start.clone()
    this.makeRoom()
    this.centre.set(hit.x, hit.y, hit.z)
    const skin = taken ?? this.takeSkin(this.centre, this.scratch.set(hit.nx, hit.ny, hit.nz), Math.min(PIECE_MAX, radius) * 1.15)
    const piece = new PeelPiece({ hit, start: pinch, view, field: this.field, skin, palette: PALETTE, scale: PEEL_SCALE, seed, radius })
    this.hold(piece)
  }

  /** Peel exactly the cut whose outline was showing. */
  private beginCut(start: Vector3, view: Vector3 | null): void {
    const seen = this.preview
    const hit = this.hitC
    hit.x = seen.cutAt.x
    hit.y = seen.cutAt.y
    hit.z = seen.cutAt.z
    hit.nx = seen.cutNormal.x
    hit.ny = seen.cutNormal.y
    hit.nz = seen.cutNormal.z
    hit.dist = 0
    // The picture taken as the hand neared, if it is of this spot.
    let skin: Skin | null = null
    if (seen.cutSkin && seen.cutSkinAt.distanceTo(seen.cutAt) < 0.05) {
      skin = seen.cutSkin
      seen.cutSkin = null
    }
    this.begin(hit, start, view, seen.seed, CUT_R, skin)
  }

  /** Lift a thing out in its own shape. */
  private beginObject(shell: Shell, start: Vector3, remote: boolean): void {
    const pinch = start.clone()
    this.makeRoom()
    this.centre.set(shell.cx, shell.cy, shell.cz)
    // The ghost's picture was taken before the hand got in the way. Otherwise
    // one is taken now, across the way the thing is seen.
    const seen = this.preview
    let skin: Skin | null = null
    if (shell === seen.shell && seen.ghostSkin) {
      skin = seen.ghostSkin
      seen.ghostSkin = null
      seen.ghostMat.uniforms.uMap.value = null
      seen.ghostMat.uniforms.uHasMap.value = 0
    } else {
      this.scratch.copy(this.eye).sub(this.centre)
      if (this.scratch.lengthSq() < 1e-6) this.scratch.set(0, 0, 1)
      skin = this.takeSkin(this.centre, this.scratch.normalize(), shell.radius)
    }
    const piece = new ObjectPiece({ shell, start: pinch, skin, palette: PALETTE, scale: PEEL_SCALE, remote })
    piece.eye.copy(this.eye)
    this.hold(piece)
  }

  private hold(piece: RoomPiece): void {
    if (piece.needsSkin) this.bare.set(piece, this.time)
    this.group.add(piece.holeAnchor, piece.anchor)
    this.pieces.push(piece)
    this.held = piece
    this.lastAmount = 0
    // The ghost or the outline becomes the piece itself.
    this.preview.ghostLevel = 0
    this.preview.cutLevel = 0
    this.preview.ghost.visible = false
    this.preview.cut.visible = false
  }

  /**
   * What has your attention: what a fingertip is nearing, or what you are
   * looking at with a hand raised. Depth is read closely there. What a pinch
   * would take shows itself: a whole thing as a ghost of its own shape, lifting
   * a little off it; a bare surface as the outline of the cut.
   */
  private attend(dt: number): void {
    const seen = this.preview
    seen.wait -= dt
    seen.age += dt
    let target: SurfacePoint | null = null
    let remote = false
    let near = 0
    let hand: Vector3 | null = null
    if (!this.held) {
      const a = this.touch[0]
      const b = this.touch[1]
      const touch = a.on && (!b.on || a.hit.dist <= b.hit.dist) ? a : b.on ? b : null
      // A finger on a piece already lifted takes that piece: nothing else is offered.
      if (touch && this.pieceAt(touch.from)) {
        target = null
      } else if (touch) {
        target = touch.hit
        near = touch.near
        hand = touch.from
      } else if (this.time <= this.gazeUntil) {
        target = this.surfaceOnRay(this.eye, this.gazeDir, GAZE_REACH, this.hitC)
        remote = true
        near = 0.35
      }
    }
    this.focusOn = target !== null
    let wantGhost = 0
    let wantCut = 0
    if (target) {
      const at = target
      this.focus.set(at.x, at.y, at.z)
      const on = (shell: Shell | null) => shell !== null && shell.kind === 'object' && onShell(shell, at.x, at.y, at.z)
      // Look again when the attention has moved somewhere new, and now and then as depth fills in.
      const moved = Math.hypot(at.x - this.lookedAt.x, at.y - this.lookedAt.y, at.z - this.lookedAt.z) > 0.05
      if (seen.wait <= 0 && (seen.age > 0.8 || (moved && !on(seen.shell)))) {
        seen.wait = 0.22
        this.lookedAt.set(at.x, at.y, at.z)
        this.show(this.shellAt(at), remote)
      }
      seen.remote = remote
      if (on(seen.shell)) wantGhost = 1
      else if (!remote) {
        wantCut = 1
        this.aimCut(at, hand)
      }
    }
    this.pictureCut(dt, wantCut > 0)
    const ease = (from: number, to: number, up: number, down: number) =>
      REDUCE_MOTION ? to : from + (to - from) * Math.min(1, dt * (to > from ? up : down))
    seen.near = ease(seen.near, near, 8, 4)
    seen.ghostLevel = ease(seen.ghostLevel, wantGhost, 5, 6)
    // A cut that has gone out is a new cut next time, with its own torn shape.
    if (wantCut > 0 && seen.cutLevel < 0.01) {
      seen.seed = Math.random() * 40
      seen.cutDraw = REDUCE_MOTION ? 1 : 0
    }
    seen.cutLevel = ease(seen.cutLevel, wantCut, 7, 6)
    seen.cutDraw = Math.min(1, seen.cutDraw + dt / 0.4)

    const g = seen.ghostMat.uniforms
    seen.ghost.visible = seen.ghostLevel > 0.01
    g.uLevel.value = seen.ghostLevel
    g.uNear.value = seen.near
    g.uTime.value = REDUCE_MOTION ? 0 : this.time
    if (seen.shell && seen.ghost.visible) {
      // It leans out of the real thing toward you, more as the hand nears.
      this.scratch.copy(this.eye).sub(this.local.set(seen.shell.cx, seen.shell.cy, seen.shell.cz))
      const lean = this.scratch.lengthSq() > 1e-6 ? (0.004 + 0.014 * seen.near) * seen.ghostLevel : 0
      seen.ghost.position.copy(this.local).addScaledVector(this.scratch.normalize(), lean)
    }
    if (seen.ghostLevel < 0.01 && wantGhost === 0) this.releaseGhostSkin()

    const c = seen.cutMat.uniforms
    seen.cut.visible = seen.cutLevel > 0.01
    c.uLevel.value = seen.cutLevel
    c.uNear.value = seen.near
    c.uDraw.value = seen.cutDraw
    c.uSeed.value = seen.seed
    c.uR.value = CUT_R
    c.uHalf.value = CUT_R * 1.5
    c.uTime.value = REDUCE_MOTION ? 0 : this.time
    if (seen.cut.visible) {
      seen.cut.position.copy(seen.cutAt).addScaledVector(seen.cutNormal, 0.004)
      seen.cut.quaternion.setFromUnitVectors(this.forward, seen.cutNormal)
      seen.cut.scale.setScalar(CUT_R * 3)
      // Where the fingertip is over the cut, in the cut's own metres.
      this.cutHand.copy(hand ?? seen.cutAt).sub(seen.cutAt).applyQuaternion(this.quatInverse(seen.cut))
      c.uHand.value.set(this.cutHand.x, this.cutHand.y)
    }
  }

  /**
   * In the headset, take the cut's picture as the hand nears, before the hand
   * is over the spot, and again if the cut moves on. On the desk there is no
   * hand in the way, and a picture is a render, so it waits for the pinch.
   */
  private pictureCut(dt: number, showing: boolean): void {
    const seen = this.preview
    seen.cutSkinWait -= dt
    if (!showing || !this.presenting) {
      if (!showing && seen.cutLevel < 0.01 && seen.cutSkin) {
        seen.cutSkin.dispose()
        seen.cutSkin = null
      }
      return
    }
    if (seen.cutSkinWait > 0) return
    if (seen.cutSkin && seen.cutSkinAt.distanceTo(seen.cutAt) < 0.04) return
    seen.cutSkinWait = 0.3
    const skin = this.takeSkin(seen.cutAt, seen.cutNormal, CUT_R * 1.15)
    if (!skin) return
    seen.cutSkin?.dispose()
    seen.cutSkin = skin
    seen.cutSkinAt.copy(seen.cutAt)
  }

  /** The cut sits under the fingertip, and glides with it. */
  private aimCut(hit: SurfacePoint, hand: Vector3 | null): void {
    const seen = this.preview
    this.scratch.set(hit.x, hit.y, hit.z)
    this.local.set(hit.nx, hit.ny, hit.nz)
    // It faces whoever is looking at it.
    if (this.local.dot(this.cutHand.copy(hand ?? this.eye).sub(this.scratch)) < 0) this.local.negate()
    if (seen.cutLevel < 0.02) {
      seen.cutAt.copy(this.scratch)
      seen.cutNormal.copy(this.local)
      return
    }
    seen.cutAt.lerp(this.scratch, 0.3)
    seen.cutNormal.lerp(this.local, 0.2).normalize()
  }

  private quatInverse(mesh: Mesh) {
    return this.quat.copy(mesh.quaternion).invert()
  }

  /** Show the ghost of a new thing, wearing the newest picture of it with no hand in the way. */
  private show(shell: Shell | null, remote: boolean): void {
    const seen = this.preview
    const moved = !seen.shell || !shell || Math.hypot(shell.cx - seen.shell.cx, shell.cy - seen.shell.cy, shell.cz - seen.shell.cz) > 0.08
    seen.shell = shell
    seen.remote = remote
    seen.age = 0
    if (!shell || shell.kind !== 'object') return
    const geo = shellGeometry(shell)
    this.releaseGhostSkin()
    const centre = this.centre.set(shell.cx, shell.cy, shell.cz)
    this.scratch.copy(this.eye).sub(centre)
    if (this.scratch.lengthSq() < 1e-6) this.scratch.set(0, 0, 1)
    const skin = this.takeSkin(centre, this.scratch.normalize(), shell.radius)
    seen.ghostSkin = skin
    geo.setAttribute('aUv', new BufferAttribute(shellImageCoords(shell, skin), 2))
    seen.ghost.geometry.dispose()
    seen.ghost.geometry = geo
    seen.ghost.position.set(shell.cx, shell.cy, shell.cz)
    const g = seen.ghostMat.uniforms
    g.uMap.value = skin ? skin.texture : null
    g.uHasMap.value = skin ? 1 : 0
    g.uEncode.value = skin?.linear ? 1 : 0
    g.uLow.value = shell.bottom - shell.cy
    g.uSpan.value = Math.max(0.02, (shell.cy - shell.bottom) * 2)
    // The ghost does not jump from one thing to the next: it dims and comes up again.
    if (moved) seen.ghostLevel *= 0.25
  }

  private releaseGhostSkin(): void {
    const seen = this.preview
    if (!seen.ghostSkin) return
    seen.ghostSkin.dispose()
    seen.ghostSkin = null
    seen.ghostMat.uniforms.uMap.value = null
    seen.ghostMat.uniforms.uHasMap.value = 0
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
    pool.to.set(hit.x + hit.nx * 0.006, hit.y + hit.ny * 0.006, hit.z + hit.nz * 0.006)
    pool.toNormal.set(hit.nx, hit.ny, hit.nz)
    // A light that has gone out appears where it is wanted. One that is lit glides there, frame by frame.
    if (!pool.placed || pool.level < 0.02) {
      pool.at.copy(pool.to)
      pool.normal.copy(pool.toNormal)
      pool.placed = true
    }
  }

  private stepPools(dt: number): void {
    for (let i = 0; i < this.pools.length; i++) {
      const pool = this.pools[i]
      const rate = REDUCE_MOTION ? 1 : Math.min(1, dt * (pool.goal > pool.level ? 9 : 5))
      pool.level += (pool.goal - pool.level) * rate
      if (pool.placed) {
        const glide = REDUCE_MOTION ? 1 : 1 - Math.exp(-dt / 0.045)
        pool.at.lerp(pool.to, glide)
        pool.normal.lerp(pool.toNormal, glide).normalize()
      }
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
    if (this.jointCount === 0) return false
    const lo = this.jointLo
    const hi = this.jointHi
    if (x < lo.x || y < lo.y || z < lo.z || x > hi.x || y > hi.y || z > hi.z) return false
    const r2 = HAND_CLEAR * HAND_CLEAR
    for (let i = 0; i < this.jointCount; i++) {
      const j = this.joints[i]
      const dx = x - j.x
      const dy = y - j.y
      const dz = z - j.z
      if (dx * dx + dy * dy + dz * dz < r2) return true
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

/**
 * Is a point on this thing: within a few centimetres of its surface, not just
 * near its middle? A finger on the table beside it is not on it.
 */
function onShell(shell: Shell, x: number, y: number, z: number): boolean {
  const reach = 0.035
  if (Math.hypot(x - shell.cx, y - shell.cy, z - shell.cz) > shell.radius + reach) return false
  const p = shell.positions
  const r2 = reach * reach
  for (let i = 0; i < p.length; i += 3) {
    const dx = p[i] - x
    const dy = p[i + 1] - y
    const dz = p[i + 2] - z
    if (dx * dx + dy * dy + dz * dz < r2) return true
  }
  return false
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
