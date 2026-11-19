import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
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
import { DepthMotes } from '../look/depth-motes.js'
import { LiveMesh } from './live-mesh.js'
import { GHOST_JOINTS, cutoutMaterial, ghostMaterial, poolMaterial, shellMaterial } from '../look/room-glow.js'
import { DROP, EDGE, focusRect, onEdge, seesPast, sortReadings, transformPoint, viewFromDepth, type ViewRect } from './depth-project.js'
import { RoomField, surfacePoint, type DepthSample, type SurfacePoint } from './field.js'
import { GpuDepthReader, type GpuDepthInfo } from './gpu-depth.js'
import { liftShell, pickShell, type LiftOptions, type Shell } from './object.js'
import { ObjectPiece, shellGeometry, shellImageCoords } from './object-piece.js'
import { peelMode } from './peel-mode.js'
import { BASE_GAP, StandTrack, fitStanding, setStandFar, standFar, type StandFit, type StandProbe } from './stand.js'
import { PIECE_MAX, STICK_GAP, TOUCH_GAP, basisKeeping, canLand, tangentBasis, type Basis } from './patch.js'
import { PeelPiece, type PieceState, type RoomPiece } from './peel-piece.js'
import type { RoomPlates, Skin } from './plates.js'

const FUSE_EVERY = 0.1
/** Samples fused on one frame. The rest of a depth image waits, so the frame stays smooth. */
const SAMPLE_BUDGET = 260
/** Pieces kept. The oldest fades to make room for a new one. */
const MAX_PIECES = 12
/** A fingertip this far from a surface starts to gather light on it, metres. */
const POOL_REACH = 0.3
/** Pool slots: one per hand, and one for where a carried piece will rest. */
const LANDING = 2
/** The size of a piece of bare surface, the same in its outline and when it comes away, metres. */
const CUT_R = 0.11
/**
 * `?flat=1` brings back the flat peel: a bare surface gives a torn flat piece
 * with an outline first. Without it, everything a pinch takes is a piece of
 * the depth mesh in its real shape.
 */
const FLAT = queryFlag('flat') === '1'
/**
 * `?clear=1`: each depth reading clears what the field holds along the way to
 * it, so a hand that slipped past the mask, or a thing moved, is forgotten.
 * Off by default: a glossy top that mirrors the room reads as far away, and
 * clearing then wears the real top away.
 */
const CLEAR = queryFlag('clear') === '1'
/**
 * The simple peel (chosen on the launch card, or `?simple=1`): the peel as it
 * first was. Light gathers under a fingertip within 30 cm of a surface, and a
 * pinch near any surface peels a flat piece of it there and then, with its
 * relief and its picture, growing as you pull. Nothing is shown before the
 * pinch and nothing is fitted.
 */
const simple = (): boolean => peelMode() === 'simple'
/** `?motes=0` hides the motes of light that show depth being read. */
const MOTES = queryFlag('motes') !== '0'
/** `?mesh=0` hides the live mesh. `?mesh=all` shows all of it, not just where the hand points. */
const MESH = queryFlag('mesh') !== '0'
const MESH_ALL = queryFlag('mesh') === 'all'
/**
 * `?standfar=1.2` sets how far the far sides of a fitted thing are pulled in,
 * in voxels, for tuning on the headset. Without it, or with anything that is
 * not a number, the tuned default stays.
 */
setStandFar(queryFlag('standfar'))
/** How far a hand's torch reaches, metres. */
export const TORCH_REACH = 3
/** The torch's circle on a surface `dist` metres from the hand: wider the further it falls, like a beam. */
export function torchRadius(dist: number): number {
  return Math.min(0.28, Math.max(0.12, 0.08 + 0.1 * dist))
}
/** A pinch this close to the fingertip a preview follows is that hand's pinch, metres. */
const OFFER_HAND = 0.12
/**
 * A piece of something big (a wall, a table, a sofa) shows itself only when
 * the fingertip is this close to it, metres. From further off the torch lights
 * whole things only: a square of wall seen across the room, with the lamp and
 * the shelf in it, is clutter, and pointing at a thing past it lit the wall.
 */
const PIECE_NEAR = 0.3
/** A fingertip this far past a showing ghost's reach is still at it, for telling it from a loose piece, metres. */
const GHOST_REACH = 0.04
/** How far round what has your attention the fine field holds on to what it has, metres. */
const KEEP_FINE = 0.35
/** Seconds an offer stays good after the hand stops showing it. Closing the fingers to pinch takes a moment. */
const OFFER_GRACE = 0.6
/**
 * A whole thing whose ghost is showing stays on offer while a fingertip is
 * within this of it, metres, whatever the fingertip is nearest to. Reaching in
 * puts the hand over the thing and the finger beside the table, and neither
 * should take the thing away from the hand that is about to pinch it.
 */
const LOCK_REACH = 0.12
/** How far away a thing can be and still be lifted by looking at it, metres. */
const GAZE_REACH = 3.2
/** Seconds a look stays live after the hand that was raised closes to pinch. */
const GAZE_GRACE = 0.6

/** Depth readings taken across the view each pass, and down it. */
const DEPTH_COLS = 40
const DEPTH_ROWS = 30
/** The close look: this much of the room around what has your attention, metres. */
const FOCUS_WIDE = 0.84
const FOCUS_TALL = 0.6
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
  /** When it last had a surface. */
  at: number
  /** A fingertip is up this frame, at `from`, whether or not its torch found a surface. */
  up: boolean
}

/**
 * What a pinch would take, shown before the pinch: the ghost of a thing, or
 * the outline of a cut in a bare surface. A pinch takes exactly this.
 */
interface Preview {
  /** What the look at the attention last found: a thing, a piece of something big, or nothing. */
  shell: Shell | null
  /** The thing the ghost is drawn from. Only ever a whole thing. */
  ghostShell: Shell | null
  /** What is on offer this frame. A pinch takes only this. */
  offer: 'ghost' | 'cut' | 'spot' | null
  /** The last thing offered, and when. Closing the fingers to pinch lowers the torch a moment before the pinch lands. */
  offered: 'ghost' | 'cut' | 'spot' | null
  offeredAt: number
  /** The torch's circle: where it falls, how wide, and how lit, 0..1. A pinch takes the mesh inside it. */
  readonly spotHit: SurfacePoint
  spotR: number
  spotLevel: number
  /** The fingertip the preview follows, when it came from a hand. */
  readonly hand: Vector3
  fromHand: boolean
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
  // Written two voxels deep behind each surface, so the live mesh has no holes.
  private readonly field = new RoomField(undefined, undefined, 2)
  private readonly fine: RoomField | null = queryFlag('fine') === '0' ? null : new RoomField(FINE_VOXEL, FINE_CHUNKS, 2)
  /** A thing standing on a level surface, fitted as a clean solid and held steady from one look to the next. */
  private readonly stand = new StandTrack()
  /** What the latest fit found on the way: the surface under the thing, and why there was no fit. */
  private readonly standProbe: StandProbe = { plane: NaN, reason: '' }
  /** The latest fit, or null when there was none, for the debug panel. */
  private standFit: StandFit | null = null
  /** How many times the ghost's shape has been built, for scripted checks: a steady thing is built once. */
  private ghostBuilds = 0
  private readonly pieces: RoomPiece[] = []
  private readonly effects: Effect[] = []
  private readonly pools: Pool[] = []
  private readonly touch: Touch[] = [
    { on: false, hit: surfacePoint(), from: new Vector3(), near: 0, at: -1, up: false },
    { on: false, hit: surfacePoint(), from: new Vector3(), near: 0, at: -1, up: false },
  ]
  /** Where the hands are, joint by joint, so depth does not mistake them for the room. */
  private readonly joints = Array.from({ length: MAX_JOINTS }, () => new Vector3())
  private jointCount = 0
  private readonly jointLo = new Vector3()
  private readonly jointHi = new Vector3()
  /** The hands as they were when the last texture depth read was asked for. */
  private readonly snapJoints = Array.from({ length: MAX_JOINTS }, () => new Vector3())
  private snapCount = 0
  private readonly snapLo = new Vector3()
  private readonly snapHi = new Vector3()
  private held: RoomPiece | null = null
  private landing: SurfacePoint | null = null
  private presenting = false
  private lastAmount = 0
  private fuseIn = 0
  private pass = 0
  private queue: DepthSample[] = []
  private queueField: RoomField = this.field
  private queueAt = 0
  /** The angle between neighbouring readings in the queue, radians. */
  private queueStep = 0
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
  private readonly spotAt = new Vector3()
  /** The last error thrown while stepping, if any, and how many readings the last depth pass gave. */
  private fault: string | null = null
  private lastReadings = 0
  private readonly motes: DepthMotes | null = MOTES ? new DepthMotes(PALETTE) : null
  private readonly live: LiveMesh | null = MESH ? new LiveMesh(PALETTE) : null
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
  private readonly basis = new Matrix4()
  private readonly cutT = new Vector3()
  private readonly cutB = new Vector3()
  private readonly hitA = surfacePoint()
  private readonly hitB = surfacePoint()
  private readonly hitC = surfacePoint()
  private readonly hitD = surfacePoint()
  private readonly hitE = surfacePoint()
  private readonly rim = [new Vector3(), new Vector3(), new Vector3(), new Vector3()]
  private readonly metres = new Float32Array(DEPTH_COLS * DEPTH_ROWS)
  /** What each reading of the grid is: dropped, kept, or kept on an edge. */
  private readonly sorted = new Uint8Array(DEPTH_COLS * DEPTH_ROWS)
  private readonly gridPoints = new Float32Array(DEPTH_COLS * DEPTH_ROWS * 3)
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
    this.field.clears = CLEAR
    if (this.fine) this.fine.clears = CLEAR
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
    if (this.live) this.group.add(this.live.group)
    if (this.motes) this.group.add(this.motes.points)
    this.preview = {
      shell: null,
      ghostShell: null,
      offer: null,
      offered: null,
      offeredAt: -1,
      spotHit: surfacePoint(),
      spotR: 0.1,
      spotLevel: 0,
      hand: new Vector3(),
      fromHand: false,
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

  /** The solid fitted to the thing whose ghost is showing: box, round, prism, or none. */
  get shape(): string {
    return this.preview.ghostShell?.stand?.shape ?? 'none'
  }

  /** How many times a ghost's shape has been built. It stays put while a steady thing is looked at. */
  get ghostBuildCount(): number {
    return this.ghostBuilds
  }

  /** The torch's circle is lit on the mesh, 0 to 1. */
  get spot(): number {
    return this.preview.offer === 'spot' || this.preview.offer === 'ghost' ? this.preview.spotLevel : 0
  }

  /** Chunks of live mesh on show. */
  get meshChunks(): number {
    return this.live?.chunkCount ?? 0
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
    const piece = this.looseAt(point)
    if (piece) {
      piece.grab(point)
      this.held = piece
      return true
    }
    if (view) this.eye.copy(view)
    if (simple()) {
      const hit = this.surfaceAtPinch(point, view)
      if (!hit) return false
      this.begin(hit, point, view, Math.random() * 40)
      return true
    }
    // What you saw is what you get.
    const seen = this.preview
    // Only the hand the preview follows takes it (or any pinch, when it came from looking).
    const mine = !seen.fromHand || point.distanceTo(seen.hand) <= OFFER_HAND
    const offer = seen.offer ?? (this.time - seen.offeredAt < OFFER_GRACE ? seen.offered : null)
    const ghost = seen.ghostShell
    if (offer === 'ghost' && ghost && mine) {
      // A ghost shows only for what the finger is reaching toward or the eye is
      // on. Pinched short of it, it comes to the hand.
      const away = Math.hypot(point.x - ghost.cx, point.y - ghost.cy, point.z - ghost.cz)
      this.beginObject(ghost, point, away > ghost.radius + TOUCH_GAP)
      return true
    }
    if (offer === 'cut' && seen.cutLevel > 0.15 && mine) {
      this.beginCut(point, view)
      return true
    }
    if (offer === 'spot' && seen.spotLevel > 0.1 && mine) {
      // The mesh inside the torch's circle, from wherever the hand is.
      const lit = this.shellAt(seen.spotHit, seen.spotR)
      if (lit) {
        const away = Math.hypot(point.x - lit.cx, point.y - lit.cy, point.z - lit.cz)
        this.beginObject(lit, point, away > lit.radius + TOUCH_GAP)
        return true
      }
    }
    // The preview follows one hand. The other hand's torch still works for its own pinch.
    if (!mine && !FLAT) {
      for (let i = 0; i < this.touch.length; i++) {
        const own = this.touch[i]
        if (this.time - own.at > OFFER_GRACE || point.distanceTo(own.from) > OFFER_HAND) continue
        const lit = this.shellAt(own.hit, torchRadius(own.hit.dist))
        if (!lit) continue
        const away = Math.hypot(point.x - lit.cx, point.y - lit.cy, point.z - lit.cz)
        this.beginObject(lit, point, away > lit.radius + TOUCH_GAP)
        return true
      }
    }
    const hit = this.surfaceAtPinch(point, view)
    if (hit) {
      const shell = this.shellAt(hit)
      if (shell && (!FLAT || shell.kind === 'object')) this.beginObject(shell, point, false)
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

  /** The surface a pinch at `point` is on: within reach of it, or a little past fingers short of it. */
  private surfaceAtPinch(point: Vector3, view: Vector3 | null): SurfacePoint | null {
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
    return hit
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
    if (simple()) {
      this.begin(surface, start, origin, Math.random() * 40)
      return surface.dist
    }
    const seen = this.preview
    const ghost = seen.ghostShell
    if (seen.offer === 'ghost' && ghost && seen.ghostLevel > 0.25 && onShell(ghost, start.x, start.y, start.z)) {
      this.beginObject(ghost, start, false)
      return surface.dist
    }
    if (seen.offer === 'spot' && seen.spotLevel > 0.25) {
      const lit = this.shellAt(seen.spotHit, seen.spotR)
      if (lit) {
        this.beginObject(lit, start, false)
        return surface.dist
      }
    }
    if (seen.offer === 'cut' && seen.cutLevel > 0.25 && start.distanceTo(seen.cutAt) <= CUT_R) {
      this.beginCut(start, origin)
      return surface.dist
    }
    const shell = this.shellAt(surface)
    if (shell && (!FLAT || shell.kind === 'object')) this.beginObject(shell, start, false)
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
    touch.up = false
    if (!origin || !this.active || this.held) {
      pool.goal = 0
      return
    }
    touch.up = true
    touch.from.copy(origin)
    // The simple peel's light is under the fingertip only, as it first was.
    if (simple() && level < 0) reach = Math.min(reach, POOL_REACH)
    let hit = this.field.near(origin.x, origin.y, origin.z, 0.07, this.hitB)
    if (!hit && dir && dir.lengthSq() > 1e-6) {
      hit = this.surfaceOnRay(origin, this.local.copy(dir).normalize(), reach, this.hitB)
    }
    if (!hit && level < 0 && this.presenting) {
      // The torch found nothing the way the hand points. Try the line from your eye through the fingertip.
      this.local.copy(origin).sub(this.eye)
      if (this.local.lengthSq() > 1e-6) hit = this.surfaceOnRay(origin, this.local.normalize(), reach, this.hitB)
    }
    if (!hit) {
      pool.goal = 0
      return
    }
    touch.on = true
    Object.assign(touch.hit, hit)
    const close = 1 - Math.min(1, hit.dist / reach)
    touch.at = this.time
    touch.near = level >= 0 ? level : close
    pool.goal = level >= 0 ? level : Math.pow(close, 0.7)
    // The light draws in under the finger as it nears.
    pool.radius = level >= 0 ? 0.085 : 0.13 - 0.06 * close
    this.aimPool(pool, hit)
  }

  step(dt: number, presenting: boolean, frame: DepthFrame | null, camera: PerspectiveCamera, standIn: Object3D): void {
    try {
      this.run(dt, presenting, frame, camera, standIn)
    } catch (error) {
      // Never fail silently: say so where it can be read in the headset.
      const message = error instanceof Error ? error.message : String(error)
      if (this.fault !== message) console.error(`[frame] room error: ${message}`, error)
      this.fault = message
      this.depthNote = `Room error: ${message}`
    }
  }

  /**
   * What the room is doing, for the `?debug=1` panel: whether depth is
   * arriving, how much room has been built, and whether a hand's torch is
   * landing on it.
   */
  debugLines(): string[] {
    const t = (i: number) => (this.touch[i].on ? `${this.touch[i].hit.dist.toFixed(2)}m` : this.time - this.touch[i].at < 1 ? 'lost' : '-')
    const seen = this.preview
    return [
      `depth ${this.depthMode ?? 'none'}  readings ${this.lastReadings}  passes ${this.pass}  miss ${this.depthMiss}`,
      `room ${this.field.chunkCount} chunks  fine ${this.fine ? this.fine.chunkCount : 'off'}  mesh ${this.live?.chunkCount ?? 'off'}  joints ${this.jointCount}`,
      `mode ${peelMode()}  torch L ${t(0)} R ${t(1)}  offer ${seen.offer ?? '-'}`,
      this.standLine(),
      ...(this.fault ? [`ERROR ${this.fault}`] : []),
    ]
  }

  /**
   * The latest fit of a standing thing: its shape and size in centimetres, how
   * far its outline strays in millimetres, how much of the surface around it
   * was seen, why there was no fit, how long a shape has been held without
   * one, and the far-side pull in use (`?standfar=`).
   */
  private standLine(): string {
    const fit = this.standFit
    const reason = this.standProbe.reason || 'ok'
    const hold = `hold ${this.stand.held.toFixed(1)}s  far ${standFar().toFixed(2)}`
    if (!fit) return `stand none  ${reason}  ${hold}`
    const cm = (m: number) => Math.round(m * 100)
    const across = fit.shape === 'round' ? `${cm(2 * fit.r)}x${cm(2 * fit.r)}` : `${cm(2 * fit.hu)}x${cm(2 * fit.hv)}`
    const size = `${across}x${cm(fit.top - fit.plane)}cm`
    return `stand ${fit.shape} ${size}  res ${Math.round(fit.residual * 1000)}mm  seen ${fit.seenOut.toFixed(2)}  ${reason}  ${hold}`
  }

  private run(dt: number, presenting: boolean, frame: DepthFrame | null, camera: PerspectiveCamera, standIn: Object3D): void {
    this.time += dt
    if (presenting !== this.presenting) {
      // Going into or out of the headset changes which room this is: the desk's
      // stand-in must not be left standing in your real one.
      this.field.clear()
      this.fine?.clear()
      this.motes?.clear()
      this.live?.clear()
      this.queue = []
      this.queueAt = 0
      this.depthMiss = 0
      this.depthNote = null
      this.preview.shell = null
      this.preview.ghostShell = null
      this.stand.reset()
      this.standFit = null
      this.preview.offer = null
      this.preview.offered = null
      this.preview.spotLevel = 0
      // Hands and the mouse from the other side of the change are gone.
      for (let i = 0; i < this.touch.length; i++) this.touch[i].on = false
      for (let i = 0; i < this.pools.length; i++) {
        this.pools[i].goal = 0
        this.pools[i].level = 0
      }
      this.mouse.on = false
      this.gazeUntil = -1
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
        this.fine?.heal(piece.source.x, piece.source.y, piece.source.z, piece.radius)
        this.keepOpenHoles()
      }
      if (!piece.done) continue
      if (piece.flat && piece.parted && !this.healed.has(piece)) {
        this.field.heal(piece.source.x, piece.source.y, piece.source.z, piece.radius)
        this.fine?.heal(piece.source.x, piece.source.y, piece.source.z, piece.radius)
      }
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
    this.motes?.step(this.time, this.pixelScale(), REDUCE_MOTION)
    // The live mesh is drawn from the field a pinch lifts from: the fine one, or the coarse one without it.
    // The live mesh is lit only inside the torch's circle: that is what a pinch takes.
    if (this.live) {
      const seen = this.preview
      this.live.deskDepth = !presenting
      // The whole room's mesh is only for looking at (`?mesh=all`). What a pinch takes is shown by its own ghost.
      this.live.step(dt, this.time, this.field, this.eye, 4, this.cutT.set(1, 0, 0), this.cutB.set(0, 1, 0), MESH_ALL, this.joints, presenting ? this.jointCount : 0, REDUCE_MOTION)
    }
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
    this.motes?.dispose()
    this.live?.dispose()
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

  /**
   * The shell a pinch at `hit` would lift: from the fine field where it has
   * looked closely, or else the coarse one. A thing standing on a level
   * surface comes as a clean fitted solid, the same one each time while it
   * keeps still. Anything else is lifted from the field as it is.
   */
  private shellAt(hit: SurfacePoint, piece?: number): Shell | null {
    const fine = this.fine
    // The same place on the fine field's surface. The coarse one sits a voxel or two off a small
    // thing, so a hit found there is moved onto the fine surface first.
    const at = fine ? this.onFine(hit) : null
    const close = at !== null
    const seed = at ?? hit
    const probe = this.standProbe
    // Fitted in the fine field whenever there is one, even where the hit was not matched to its
    // surface: the thing may be there a few centimetres off. In the coarse field a 14 cm thing is
    // three or four voxels across, and its fits come out the wrong size, or the wrong shape.
    const fit = fitStanding(fine ?? this.field, seed, this.eye, probe)
    this.standFit = fit
    const steady = this.stand.update(fit, seed, this.time)
    if (steady) return steady
    // The surface the fit found all round the thing keeps the cut clear of the table, and the block it
    // read is not read again. A fit that failed before it knew the surface leaves the plane unset.
    const options: LiftOptions = piece === undefined ? {} : { piece, square: this.squareAt(seed) }
    options.floor = probe.plane
    options.window = probe.window
    if (!close || !fine) return liftShell(this.field, hit, this.eye, options)
    // The fine field first: that is the block the fit read.
    const near = liftShell(fine, seed, this.eye, options)
    return pickShell(liftShell(this.field, hit, this.eye, { ...options, window: undefined }), near)
  }

  /**
   * The point on the fine field's surface for `hit`, a point on the coarse
   * field's, or null when the fine field has not looked closely there. Its
   * surface is looked for along the way the coarse one faces, then along the
   * line of sight, a few centimetres either side.
   */
  private onFine(hit: SurfacePoint): SurfacePoint | null {
    const fine = this.fine
    if (!fine) return null
    const out = this.hitE
    if (fine.near(hit.x, hit.y, hit.z, 0.04, out)) return out
    const reach = 0.07
    let found = fine.surfaceAlong(hit.x + hit.nx * reach, hit.y + hit.ny * reach, hit.z + hit.nz * reach, -hit.nx, -hit.ny, -hit.nz, 2 * reach, out)
    if (!found) {
      this.scratch.set(hit.x - this.eye.x, hit.y - this.eye.y, hit.z - this.eye.z)
      const length = this.scratch.length()
      if (length < 1e-6) return null
      this.scratch.multiplyScalar(1 / length)
      found = fine.surfaceAlong(hit.x - this.scratch.x * reach, hit.y - this.scratch.y * reach, hit.z - this.scratch.z * reach, this.scratch.x, this.scratch.y, this.scratch.z, 2 * reach, out)
    }
    if (!found) return null
    found.dist = hit.dist
    return found
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

  /** Healing one hole must not close a neighbouring one whose light is still showing. */
  private keepOpenHoles(): void {
    for (let i = 0; i < this.pieces.length; i++) {
      const other = this.pieces[i]
      if (!(other instanceof PeelPiece) || !other.parted || other.closed || this.healed.has(other)) continue
      const at = other.source
      this.field.carve(at.x, at.y, at.z, other.radius * 0.8)
      this.fine?.carve(at.x, at.y, at.z, other.radius * 0.8)
    }
  }

  /**
   * The sides of the torch's square on the surface at `hit`: level across the
   * way you see it, so on a wall it stands upright and on a table it faces you.
   */
  private squareAt(hit: { x: number; y: number; z: number; nx: number; ny: number; nz: number }): Basis {
    let nx = hit.nx
    let ny = hit.ny
    let nz = hit.nz
    const vx = this.eye.x - hit.x
    const vy = this.eye.y - hit.y
    const vz = this.eye.z - hit.z
    if (nx * nx + ny * ny + nz * nz < 1e-6) {
      const l = Math.hypot(vx, vy, vz) || 1
      nx = vx / l
      ny = vy / l
      nz = vz / l
    }
    // Your right, as you look at it: level, and square to the line of sight.
    const rl = Math.hypot(vz, vx)
    return rl > 1e-4 ? basisKeeping(nx, ny, nz, -vz / rl, 0, vx / rl) : tangentBasis(nx, ny, nz)
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
  /** Peel a flat piece at `hit`: `radius` across, or, without one, growing with the pull. */
  private begin(hit: SurfacePoint, start: Vector3, view: Vector3 | null, seed: number, radius?: number, taken: Skin | null = null): void {
    const pinch = start.clone()
    this.makeRoom()
    this.centre.set(hit.x, hit.y, hit.z)
    const skin = taken ?? this.takeSkin(this.centre, this.scratch.set(hit.nx, hit.ny, hit.nz), Math.min(PIECE_MAX, radius ?? PIECE_MAX) * 1.15)
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
    if (shell === seen.ghostShell && seen.ghostSkin) {
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
    // The thing has been taken: the next look fits it afresh rather than holding on to this shape.
    this.stand.reset()
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
      if (touch && this.looseAt(touch.from)) {
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
    // The simple peel shows nothing before the pinch: only the light under the fingertip.
    if (simple()) target = null
    this.focusOn = target !== null
    if (!target && this.presenting && !this.held) {
      // No hand is up. Depth is still read closely where you look, ready for when one is.
      const far = this.surfaceOnRay(this.eye, this.gazeDir, GAZE_REACH, this.hitC)
      if (far) {
        this.focus.set(far.x, far.y, far.z)
        this.focusOn = true
      }
    }
    let wantSpot = 0
    let wantGhost = 0
    let wantCut = 0
    const locked = this.lockedHand()
    // What has your attention is what a hand will reach for and hide from depth: the fine field holds on to it.
    if (this.fine) this.fine.keep(this.focus.x, this.focus.y, this.focus.z, this.focusOn || locked ? KEEP_FINE : 0)
    if (locked) {
      // The hand is closing in on the thing on show. It stays as it is until the hand has it or
      // leaves: no new look, which the hand itself would spoil by being in the way.
      const ghost = seen.ghostShell!
      this.focus.set(ghost.cx, ghost.cy, ghost.cz)
      this.focusOn = true
      wantGhost = 1
      hand = locked
      near = Math.max(near, 0.9)
      remote = false
      seen.remote = false
    } else if (target) {
      const at = target
      this.focus.set(at.x, at.y, at.z)
      // A whole thing is offered while the torch is on it. A piece of something bigger is cut where
      // the torch fell, so it is offered while the torch stays near where it was cut. (Not the
      // piece's middle: a cut that runs into the edge of what depth has seen is lopsided, and its
      // middle can sit well away from where the torch is, so it was never offered.)
      const cutAt = this.lookedAt
      const on = (shell: Shell | null) =>
        shell !== null &&
        (shell.kind === 'object'
          ? onShell(shell, at.x, at.y, at.z)
          : !FLAT && !remote && Math.hypot(at.x - cutAt.x, at.y - cutAt.y, at.z - cutAt.z) < 0.045)
      // Look again when the attention has moved somewhere new, and now and then as depth fills in.
      const moved = Math.hypot(at.x - this.lookedAt.x, at.y - this.lookedAt.y, at.z - this.lookedAt.z) > 0.05
      if (seen.wait <= 0 && (seen.age > 0.8 || (moved && !on(seen.shell)))) {
        seen.wait = 0.22
        this.lookedAt.set(at.x, at.y, at.z)
        // From a hand, the piece is as wide as the torch's beam there. A piece of something big shows
        // only to a fingertip close to it. The desk's cursor is never near anything, and is the eye too.
        const shell = this.shellAt(at, remote || FLAT ? undefined : torchRadius(at.dist))
        this.show(shell && shell.kind !== 'object' && this.presenting && at.dist > PIECE_NEAR ? null : shell, remote)
      }
      seen.remote = remote
      // What is shown is the very piece of mesh a pinch takes: a whole thing, or the piece under the torch.
      if (on(seen.shell)) wantGhost = 1
      else if (!remote && FLAT) {
        wantCut = 1
        this.aimCut(at)
      }
    }
    seen.offer = wantGhost ? 'ghost' : wantCut ? 'cut' : wantSpot ? 'spot' : null
    if (seen.offer) {
      seen.offered = seen.offer
      seen.offeredAt = this.time
    }
    seen.spotLevel += (wantSpot - seen.spotLevel) * (REDUCE_MOTION ? 1 : Math.min(1, dt * (wantSpot > seen.spotLevel ? 9 : 5)))
    seen.fromHand = hand !== null
    if (hand) seen.hand.copy(hand)
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
    g.uGrid.value = 1
    // Small squares on small things, so a mug still shows a few.
    g.uCell.value = seen.ghostShell && seen.ghostShell.radius < 0.14 ? 0.025 : 0.04
    // Every other joint is enough for the ghost to hide behind the hand.
    const hide = Math.min(GHOST_JOINTS, Math.ceil(this.jointCount / 2))
    for (let i = 0; i < hide; i++) g.uJoints.value[i].copy(this.joints[i * 2])
    g.uJointCount.value = this.presenting ? hide : 0
    if (seen.ghostShell && seen.ghost.visible) {
      // It leans out of the real thing toward you, more as the hand nears.
      this.scratch.copy(this.eye).sub(this.local.set(seen.ghostShell.cx, seen.ghostShell.cy, seen.ghostShell.cz))
      const lean = this.scratch.lengthSq() > 1e-6 ? (0.004 + 0.014 * seen.near) * seen.ghostLevel : 0
      seen.ghost.position.copy(this.local).addScaledVector(this.scratch.normalize(), lean)
    }
    if (seen.ghostLevel < 0.01 && wantGhost === 0) {
      this.releaseGhostSkin()
      seen.ghostShell = null
    }

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
      // The same axes across the surface as the piece will have, so the torn
      // outline shown is the one that comes away, not a turned copy of it.
      const n = seen.cutNormal
      const basis = tangentBasis(n.x, n.y, n.z)
      this.basis.makeBasis(this.cutT.set(basis.tx, basis.ty, basis.tz), this.cutB.set(basis.bx, basis.by, basis.bz), n)
      seen.cut.quaternion.setFromRotationMatrix(this.basis)
      seen.cut.scale.setScalar(CUT_R * 3)
      // Where the fingertip is over the cut, in the cut's own metres.
      // The line draws from the side nearest the finger. Without a finger it keeps the last side.
      if (hand) {
        this.cutHand.copy(hand).sub(seen.cutAt).applyQuaternion(this.quatInverse(seen.cut))
        if (this.cutHand.x * this.cutHand.x + this.cutHand.y * this.cutHand.y > 1e-6) c.uHand.value.set(this.cutHand.x, this.cutHand.y)
      }
    }
  }

  /**
   * The fingertip that holds the ghost on offer, or null: a whole thing was on
   * offer a moment ago and a fingertip is still within reach of it. A finger
   * on a loose piece is taking that piece instead.
   */
  private lockedHand(): Vector3 | null {
    const seen = this.preview
    const ghost = seen.ghostShell
    if (this.held || !ghost || ghost.kind !== 'object') return null
    if (seen.offered !== 'ghost' || this.time - seen.offeredAt > OFFER_GRACE) return null
    let best: Vector3 | null = null
    let bestD = ghost.radius + LOCK_REACH
    for (let i = 0; i < this.touch.length; i++) {
      const touch = this.touch[i]
      if (!touch.up || this.looseAt(touch.from)) continue
      const d = Math.hypot(touch.from.x - ghost.cx, touch.from.y - ghost.cy, touch.from.z - ghost.cz)
      if (d < bestD) {
        best = touch.from
        bestD = d
      }
    }
    return best
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
  private aimCut(hit: SurfacePoint): void {
    const seen = this.preview
    this.scratch.set(hit.x, hit.y, hit.z)
    this.local.set(hit.nx, hit.ny, hit.nz)
    // It faces the eye, the same way the piece will.
    if (this.local.dot(this.cutHand.copy(this.eye).sub(this.scratch)) < 0) this.local.negate()
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
    seen.shell = shell
    seen.remote = remote
    seen.age = 0
    if (shell && shell === seen.ghostShell) {
      // The very shape already on show, as a fitted thing held still gives: nothing to build again.
      // Only a picture it could not get before is asked for again, now that frames may show it.
      if (!seen.ghostSkin) {
        const skin = this.takeGhostSkin(shell)
        if (skin) this.dressGhost(shell, seen.ghost.geometry, skin)
      }
      return
    }
    // Anything but a whole thing leaves the ghost as it is, fading out on the thing it was.
    if (!shell || (shell.kind !== 'object' && (FLAT || remote))) return
    const was = seen.ghostShell
    const moved = !was || Math.hypot(shell.cx - was.cx, shell.cy - was.cy, shell.cz - was.cz) > 0.08
    seen.ghostShell = shell
    this.ghostBuilds++
    const geo = shellGeometry(shell)
    // The same thing again, as depth fills in: keep the picture taken before the hand arrived.
    const skin = (moved ? null : seen.ghostSkin) ?? this.takeGhostSkin(shell)
    seen.ghost.geometry.dispose()
    seen.ghost.geometry = geo
    this.dressGhost(shell, geo, skin)
    seen.ghost.position.set(shell.cx, shell.cy, shell.cz)
    const g = seen.ghostMat.uniforms
    g.uLow.value = shell.bottom - shell.cy
    g.uSpan.value = Math.max(0.02, (shell.cy - shell.bottom) * 2)
    this.frameGrid(shell)
    // The ghost does not jump from one thing to the next: it dims and comes up again.
    if (moved) seen.ghostLevel *= 0.25
  }

  /** A new picture for the ghost of `shell`, across the way it is seen, in place of the one it had. */
  private takeGhostSkin(shell: Shell): Skin | null {
    const centre = this.centre.set(shell.cx, shell.cy, shell.cz)
    this.scratch.copy(this.eye).sub(centre)
    if (this.scratch.lengthSq() < 1e-6) this.scratch.set(0, 0, 1)
    const skin = this.takeSkin(centre, this.scratch.normalize(), shell.radius)
    this.releaseGhostSkin()
    this.preview.ghostSkin = skin
    return skin
  }

  /** Put the picture `skin` (or none) on the ghost's geometry `geo` of `shell`. */
  private dressGhost(shell: Shell, geo: BufferGeometry, skin: Skin | null): void {
    const uv = shellImageCoords(shell, skin)
    const had = geo.getAttribute('aUv') as BufferAttribute | undefined
    if (had && had.array.length === uv.length) {
      ;(had.array as Float32Array).set(uv)
      had.needsUpdate = true
    } else geo.setAttribute('aUv', new BufferAttribute(uv, 3))
    const g = this.preview.ghostMat.uniforms
    g.uMap.value = skin ? skin.texture : null
    g.uHasMap.value = skin ? 1 : 0
    g.uEncode.value = skin?.linear ? 1 : 0
  }

  /**
   * A fitted thing's grid is laid in its own frame, from a corner of its base:
   * squares along its sides, a whole number of them to each side and up its
   * walls, so lines fall on its edges and on its base. Anything else keeps the
   * grid in the room's axes.
   */
  private frameGrid(shell: Shell): void {
    const g = this.preview.ghostMat.uniforms
    const fit = shell.stand
    if (!fit) {
      g.uFramed.value = 0
      return
    }
    // A round has no sides to line up with. A prism lines up with the box around it.
    const a = fit.shape === 'round' ? 0 : fit.angle
    const hu = fit.shape === 'round' ? fit.r : fit.hu
    const hv = fit.shape === 'round' ? fit.r : fit.hv
    const tall = Math.max(0.01, shell.relief)
    // Small squares on small things, as for the room's grid.
    const want = shell.radius < 0.14 ? 0.025 : 0.04
    g.uFramed.value = 1
    g.uFrame.value.set(Math.cos(a), Math.sin(a), fit.cx - shell.cx, fit.cz - shell.cz)
    g.uOrigin.value.set(-hu, fit.plane + BASE_GAP - shell.cy, -hv)
    g.uCells.value.set(
      (2 * hu) / Math.max(2, Math.round((2 * hu) / want)),
      tall / Math.max(1, Math.round(tall / want)),
      (2 * hv) / Math.max(2, Math.round((2 * hv) / want)),
    )
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
      if (!hit) {
        // Carried a little way into a surface, it is past where the field knows how near it is.
        // Come at the surface from your side of it.
        this.scratch.copy(this.eye).sub(c)
        if (this.scratch.lengthSq() > 1e-6) {
          this.scratch.normalize()
          hit = this.field.surfaceAlong(c.x + this.scratch.x * 0.12, c.y + this.scratch.y * 0.12, c.z + this.scratch.z * 0.12, -this.scratch.x, -this.scratch.y, -this.scratch.z, 0.12 + STICK_GAP, this.hitB)
        }
      }
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
      if (piece.flat) {
        this.field.carve(piece.source.x, piece.source.y, piece.source.z, piece.radius * 0.8)
        this.fine?.carve(piece.source.x, piece.source.y, piece.source.z, piece.radius * 0.8)
      }
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

  /**
   * The loose piece a fingertip at `point` is on, as `pieceAt`, unless the
   * thing whose ghost is showing is nearer: a piece left floating beside a
   * thing does not stand in the way of taking the thing.
   */
  private looseAt(point: Vector3): RoomPiece | null {
    const piece = this.pieceAt(point)
    if (!piece) return null
    const ghost = this.preview.ghostShell
    if (!ghost || ghost.kind !== 'object' || this.preview.ghostLevel < 0.15) return piece
    const toGhost = Math.hypot(point.x - ghost.cx, point.y - ghost.cy, point.z - ghost.cz)
    if (toGhost > ghost.radius + GHOST_REACH) return piece
    return toGhost < piece.contains(point) ? null : piece
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
      this.queueField.integrateRange(this.queue, this.queueAt, end, this.queueFresh, this.queueStep)
      this.queueFresh = false
      this.queueAt = end
    }
    // Chunks a field let go of are gone. Nothing is drawn from them.
    const gone = this.field.takeRetired()
    const goneFine = this.fine?.takeRetired()
    void goneFine
    this.live?.drop(gone)
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
      // Every ray first, keeping how far each went, so each reading can see its neighbours.
      const m = this.metres
      const found: (DepthSample | null)[] = []
      for (let y = 0; y < DEPTH_ROWS; y++) {
        for (let x = 0; x < DEPTH_COLS; x++) {
          const ax = ((x + jx) / DEPTH_COLS - 0.5) * FOCUS_WIDE
          const ay = ((y + jy) / DEPTH_ROWS - 0.5) * FOCUS_TALL
          this.rim[1].copy(toward).multiplyScalar(dist).addScaledVector(right, ax).addScaledVector(up, ay).normalize()
          this.raycaster.set(origin, this.rim[1])
          const hit = this.raycaster.intersectObject(standIn, true)[0]
          const k = x + y * DEPTH_COLS
          if (!hit || hit.distance < 0.25 || hit.distance > 3.4) {
            m[k] = 0
            found[k] = null
            continue
          }
          m[k] = hit.distance
          found[k] = this.deskSample(origin, hit)
        }
      }
      // Then the edges of things, the same way a headset's depth is read.
      for (let y = 0; y < DEPTH_ROWS; y++) {
        for (let x = 0; x < DEPTH_COLS; x++) {
          const k = x + y * DEPTH_COLS
          const sample = found[k]
          if (!sample) continue
          if (onEdge(m, DEPTH_COLS, DEPTH_ROWS, x, y)) sample.edge = true
          if (seesPast(m, DEPTH_COLS, DEPTH_ROWS, x, y)) sample.past = true
          samples.push(sample)
        }
      }
      this.enqueue(samples, this.fine ?? this.field)
      return
    }
    const w = 24
    const h = 18
    // As on the headset, a reading well behind the one beside it (past the edge of something nearer)
    // does not clear the space it crossed.
    const m = this.metres
    const found: (DepthSample | null)[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        this.ndc.set(((x + jx) / w) * 2 - 1, 1 - ((y + jy) / h) * 2)
        this.raycaster.setFromCamera(this.ndc, camera)
        const hit = this.raycaster.intersectObject(standIn, true)[0]
        const k = x + y * w
        if (!hit || hit.distance < 0.25 || hit.distance > 3.4) {
          m[k] = 0
          found[k] = null
          continue
        }
        m[k] = hit.distance
        found[k] = this.deskSample(origin, hit)
      }
    }
    for (let k = 0; k < w * h; k++) {
      const sample = found[k]
      if (!sample) continue
      if (seesPast(m, w, h, k % w, Math.floor(k / w))) sample.past = true
      samples.push(sample)
    }
    camera.getWorldDirection(this.scratch)
    this.enqueue(samples, this.field, this.scratch, (2 * Math.tan((camera.fov * Math.PI) / 360) * camera.aspect) / w)
  }

  /** A ray's hit on the stand-in room as a depth reading, with the way the surface faces. */
  private deskSample(origin: Vector3, hit: { point: Vector3; face?: { normal: Vector3 } | null; object: Object3D }): DepthSample {
    const sample: DepthSample = { ox: origin.x, oy: origin.y, oz: origin.z, px: hit.point.x, py: hit.point.y, pz: hit.point.z }
    if (hit.face) {
      const n = this.cutB.copy(hit.face.normal).transformDirection(hit.object.matrixWorld)
      sample.nx = n.x
      sample.ny = n.y
      sample.nz = n.z
    }
    return sample
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
    // The reading comes back a few frames late: mask the hand where it was when the depth was taken.
    if (reading) this.snapHands()
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
        this.fuseGrid(viewMatrix, projection, rect && this.fine ? this.fine : this.field, true)
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
   * between a near thing and what is behind it, are left out. Readings on the
   * edge of a near thing are marked, so the field does not spread them.
   */
  private fuseGrid(viewMatrix: ArrayLike<number>, projection: ArrayLike<number>, field: RoomField, snapped = false): void {
    const origin = transformPoint(viewMatrix, { x: 0, y: 0, z: 0 })
    const samples: DepthSample[] = []
    const m = this.metres
    const at = this.gridPoints
    const count = DEPTH_COLS * DEPTH_ROWS
    // Every reading as a point in the room first, so each can see its neighbours.
    for (let k = 0; k < count; k++) {
      const d = m[k]
      const local = d > 0 ? viewFromDepth(projection, this.us[k], this.vs[k], d) : null
      if (!local) {
        at[k * 3] = NaN
        continue
      }
      const world = transformPoint(viewMatrix, local)
      at[k * 3] = world.x
      at[k * 3 + 1] = world.y
      at[k * 3 + 2] = world.z
    }
    // The blur across a step is left out, and the near side of a jump is marked.
    const sorted = this.sorted
    sortReadings(m, DEPTH_COLS, DEPTH_ROWS, sorted)
    for (let row = 0; row < DEPTH_ROWS; row++) {
      for (let col = 0; col < DEPTH_COLS; col++) {
        const k = col + row * DEPTH_COLS
        const d = m[k]
        if (at[k * 3] !== at[k * 3] || sorted[k] === DROP) continue
        const x = at[k * 3]
        const y = at[k * 3 + 1]
        const z = at[k * 3 + 2]
        if (this.isHand(x, y, z, snapped)) continue
        const sample: DepthSample = { ox: origin.x, oy: origin.y, oz: origin.z, px: x, py: y, pz: z }
        // The edge of a thing, against what is behind it: kept where it was seen.
        if (sorted[k] === EDGE) sample.edge = true
        // Just past the edge of something nearer: no proof that the space it crossed is empty.
        if (seesPast(m, DEPTH_COLS, DEPTH_ROWS, col, row)) sample.past = true
        // The way the surface faces, from the readings beside and above: across an edge there is none.
        const side = col + 1 < DEPTH_COLS ? k + 1 : k - 1
        const up = row + 1 < DEPTH_ROWS ? k + DEPTH_COLS : k - DEPTH_COLS
        const gap = 0.04 + 0.06 * d
        if (at[side * 3] === at[side * 3] && at[up * 3] === at[up * 3] && Math.abs(m[side] - d) < gap && Math.abs(m[up] - d) < gap) {
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
    const ahead = transformPoint(viewMatrix, { x: 0, y: 0, z: -1 })
    this.scratch.set(ahead.x - origin.x, ahead.y - origin.y, ahead.z - origin.z)
    // How far apart the readings are, as an angle: the view's width over the readings across it.
    const step = (2 / Math.abs(projection[0])) / DEPTH_COLS * (this.us[DEPTH_COLS - 1] - this.us[0]) * (DEPTH_COLS / (DEPTH_COLS - 1))
    this.enqueue(samples, field, field === this.field ? this.scratch : undefined, step)
  }

  /** Keep where the hands are now, for a depth reading that will come back later. */
  private snapHands(): void {
    const n = this.jointCount
    this.snapCount = n
    for (let i = 0; i < n; i++) this.snapJoints[i].copy(this.joints[i])
    this.snapLo.copy(this.jointLo)
    this.snapHi.copy(this.jointHi)
  }

  private isHand(x: number, y: number, z: number, snapped = false): boolean {
    const count = snapped ? this.snapCount : this.jointCount
    if (count === 0) return false
    const joints = snapped ? this.snapJoints : this.joints
    const lo = snapped ? this.snapLo : this.jointLo
    const hi = snapped ? this.snapHi : this.jointHi
    if (x < lo.x || y < lo.y || z < lo.z || x > hi.x || y > hi.y || z > hi.z) return false
    const r2 = HAND_CLEAR * HAND_CLEAR
    for (let i = 0; i < count; i++) {
      const j = joints[i]
      const dx = x - j.x
      const dy = y - j.y
      const dz = z - j.z
      if (dx * dx + dy * dy + dz * dz < r2) return true
    }
    return false
  }


  /** What you are looking at is fused first, so the chunk cap keeps the center of the view. */
  private enqueue(samples: DepthSample[], field: RoomField, forward?: Vector3, step = 0): void {
    this.queueStep = step
    this.lastReadings = samples.length
    if (forward && forward.lengthSq() > 1e-6) {
      const fx = forward.x
      const fy = forward.y
      const fz = forward.z
      samples.sort((a, b) => alignment(b, fx, fy, fz) - alignment(a, fx, fy, fz))
    }
    // Show the depth as it is read: a scattering of each look. Fewer while something has your
    // attention, and none over a ghost that is fully shown, so the motes do not snow over it.
    if (this.motes) {
      const share = field === this.field ? (this.focusOn ? 0.03 : 0.06) : 0.08 * (1 - this.preview.ghostLevel)
      for (let i = 0; i < samples.length; i++) {
        if (Math.random() > share) continue
        const p = samples[i]
        this.motes.add(p.px, p.py, p.pz, this.eye, this.time)
      }
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

function alignment(sample: DepthSample, fx: number, fy: number, fz: number): number {
  const dx = sample.px - sample.ox
  const dy = sample.py - sample.oy
  const dz = sample.pz - sample.oz
  const len = Math.hypot(dx, dy, dz) || 1
  return (dx * fx + dy * fy + dz * fz) / len
}
