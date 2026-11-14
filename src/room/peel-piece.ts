import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
  type ShaderMaterial,
  type Texture,
} from '@iwsdk/core'
import { REDUCE_MOTION } from '../app/context.js'
import { projectPixel } from '../capture/lens.js'
import type { Palette } from '../look/palette.js'
import { holeMaterial, pieceMaterial } from '../look/room-glow.js'
import type { RoomField, SurfacePoint } from './field.js'
import {
  PIECE_MAX,
  PIECE_N,
  PIECE_SPAN,
  RELIEF_REACH,
  TACK,
  basisKeeping,
  gridAt,
  peelFate,
  pieceRadius,
  pullAmount,
  settleHeights,
  tangentBasis,
  type Basis,
} from './patch.js'
import type { Skin } from './plates.js'

/**
 * lifting: in your fingers and still joined to the wall at its rim.
 * settling: let go too early, easing back into the wall.
 * carried: free and following your hand.
 * free: free and floating where you left it.
 * landing: on its way down onto a surface.
 * stuck: lying on a surface.
 * fading: being cleared away to make room for a new one.
 */
export type PieceState = 'lifting' | 'settling' | 'carried' | 'free' | 'landing' | 'stuck' | 'fading'

export type PieceEvent = 'freed' | 'landed'

/** What the room keeps of anything lifted out of it, flat or not. */
export interface RoomPiece {
  /** A flat piece leaves a hole of light in the wall; a lifted thing does not. */
  readonly flat: boolean
  readonly anchor: Group
  readonly holeAnchor: Group
  /** Where it was taken from. */
  readonly source: Vector3
  readonly normal: Vector3
  state: PieceState
  radius: number
  pull: number
  amount: number
  travelled: boolean
  done: boolean
  open: number
  readonly events: PieceEvent[]
  readonly loose: boolean
  readonly parted: boolean
  center(out: Vector3): Vector3
  /** How near a point is to the piece, or -1 when it is not on it. */
  contains(point: Vector3): number
  /** How far along a ray the piece is, or -1. */
  rayHit(origin: Vector3, dir: Vector3): number
  drag(hand: Vector3): void
  letGo(): void
  grab(hand: Vector3, remote?: boolean): void
  drop(): void
  land(hit: SurfacePoint, field: RoomField): void
  fade(): void
  step(dt: number): void
  dispose(): void
}

/** Seconds a piece takes to let go of the wall and become one loose sheet. */
const FREE_TIME = 0.32
/** Seconds it takes to lie down on a surface. */
const LAND_TIME = 0.36
/** How closely a carried piece trails the hand, seconds. */
const CARRY_LAG = 0.065

const COUNT = PIECE_N * PIECE_N

function smooth(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x
  return t * t * (3 - 2 * t)
}

/** Ease out: quick away from the wall, gentle as the sheet straightens. */
function easeOut(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x
  return 1 - Math.pow(1 - t, 3)
}

/**
 * Read the surface's shape around a point: for each grid point, how far the
 * real surface sits in front of or behind the plane the piece starts on.
 */
export function readRelief(field: RoomField, origin: Vector3, basis: Basis, normal: Vector3, out: Float32Array): void {
  for (let j = 0; j < PIECE_N; j++) {
    const y = gridAt(j)
    for (let i = 0; i < PIECE_N; i++) {
      const x = gridAt(i)
      const k = i + j * PIECE_N
      if (Math.hypot(x, y) > PIECE_SPAN * 1.05) {
        out[k] = NaN
        continue
      }
      const sx = origin.x + basis.tx * x + basis.bx * y + normal.x * RELIEF_REACH
      const sy = origin.y + basis.ty * x + basis.by * y + normal.y * RELIEF_REACH
      const sz = origin.z + basis.tz * x + basis.bz * y + normal.z * RELIEF_REACH
      const t = field.depthAlong(sx, sy, sz, -normal.x, -normal.y, -normal.z, RELIEF_REACH * 2)
      out[k] = t < 0 ? NaN : RELIEF_REACH - t
    }
  }
  settleHeights(out)
}

function gridGeometry(h0: Float32Array): BufferGeometry {
  const geo = new BufferGeometry()
  const positions = new Float32Array(COUNT * 3)
  const indices: number[] = []
  for (let j = 0; j < PIECE_N; j++) {
    for (let i = 0; i < PIECE_N; i++) {
      const k = i + j * PIECE_N
      positions[k * 3] = gridAt(i)
      positions[k * 3 + 1] = gridAt(j)
      if (i + 1 < PIECE_N && j + 1 < PIECE_N) indices.push(k, k + 1, k + PIECE_N, k + 1, k + PIECE_N + 1, k + PIECE_N)
    }
  }
  geo.setAttribute('position', new BufferAttribute(positions, 3))
  geo.setAttribute('aH0', new BufferAttribute(h0, 1))
  geo.setIndex(indices)
  return geo
}

export interface PieceInit {
  hit: SurfacePoint
  /** Where the fingers pinched. The pull is measured from here. */
  start: Vector3
  /** Where the viewer is, so the piece faces them. */
  view: Vector3 | null
  field: RoomField
  skin: Skin | null
  palette: Palette
  /** `?peel=1.3` makes it take more pull. */
  scale: number
  /**
   * The size and torn shape the outline showed before the pinch. Given, the
   * piece is that size from the start; left out, it grows with the pull.
   */
  radius?: number
  seed?: number
}

/**
 * One piece of the room: the sheet in your fingers, and the warm light it
 * leaves where it was.
 */
export class PeelPiece implements RoomPiece {
  readonly flat = true
  /** The sheet. Its origin is the pinch point; its z axis faces out of the surface. */
  readonly anchor = new Group()
  /** The light left behind. It stays where the piece was taken from. */
  readonly holeAnchor = new Group()
  readonly source = new Vector3()
  /** The way the piece faces now, in the world. */
  readonly normal = new Vector3()
  state: PieceState = 'lifting'
  radius = 0
  /** Metres the fingers have pulled, and the same from 0 (tack) to 1 (pop). */
  pull = 0
  amount = 0
  /** The piece has been somewhere other than the spot it was torn from. */
  travelled = false
  /** The piece and its light are finished and can be removed. */
  done = false
  /** How open the light is, 0 to 1. */
  open = 0
  readonly events: PieceEvent[] = []
  private readonly mesh: Mesh
  private readonly hole: Mesh
  private readonly mat: ShaderMaterial
  private readonly holeMat: ShaderMaterial
  private readonly h0 = new Float32Array(COUNT)
  private readonly h1 = new Float32Array(COUNT)
  private readonly tangent = new Vector3()
  private readonly bitangent = new Vector3()
  private readonly start = new Vector3()
  private readonly pullLocal = new Vector3()
  private readonly offset = new Vector3()
  private readonly target = new Vector3()
  private readonly rest = new Vector3()
  private readonly velocity = new Vector3()
  private readonly baseQuat = new Quaternion()
  private readonly fromPos = new Vector3()
  private readonly toPos = new Vector3()
  private readonly fromQuat = new Quaternion()
  private readonly toQuat = new Quaternion()
  private readonly tiltQuat = new Quaternion()
  private readonly scratch = new Vector3()
  private readonly aside = new Vector3()
  private readonly matrix = new Matrix4()
  private readonly scale: number
  /** The outline set the size before the pinch: pulling does not grow it. */
  private fixedSize = false
  private skin: Skin | null
  private own: Texture | null = null
  private freeT = -1
  private landT = -1
  private landed = false
  private flash = 0
  private show = 0
  private float = 0
  private tiltX = 0
  private tiltY = 0
  private time = 0
  private disposed = false

  constructor(init: PieceInit) {
    const { hit, field, palette } = init
    this.scale = init.scale
    this.skin = init.skin
    this.source.set(hit.x, hit.y, hit.z)
    this.start.copy(init.start)
    this.normal.set(hit.nx, hit.ny, hit.nz)
    if (this.normal.lengthSq() < 1e-6) this.normal.set(0, 1, 0)
    this.normal.normalize()
    if (init.view && this.scratch.copy(init.view).sub(this.source).dot(this.normal) < 0) this.normal.negate()
    const basis = tangentBasis(this.normal.x, this.normal.y, this.normal.z)
    this.setBasis(basis)
    readRelief(field, this.source, basis, this.normal, this.h0)
    this.h1.set(this.h0)

    const seed = init.seed ?? Math.random() * 40
    if (init.radius !== undefined) {
      this.radius = init.radius
      this.fixedSize = true
    }
    const geo = gridGeometry(this.h0)
    geo.setAttribute('aH1', new BufferAttribute(this.h1, 1))
    geo.setAttribute('aUv', new BufferAttribute(this.imageCoords(), 2))
    this.mat = pieceMaterial(palette, seed)
    if (this.skin) {
      this.mat.uniforms.uMap.value = this.skin.texture
      this.mat.uniforms.uHasMap.value = 1
      this.mat.uniforms.uEncode.value = this.skin.linear ? 1 : 0
    }
    this.mesh = new Mesh(geo, this.mat)
    this.mesh.name = 'room-piece'
    this.mesh.renderOrder = 6
    this.mesh.frustumCulled = false
    this.anchor.name = 'room-piece-anchor'
    this.anchor.add(this.mesh)
    this.anchor.position.copy(this.source)
    this.anchor.quaternion.copy(this.baseQuat)

    this.holeMat = holeMaterial(palette, seed)
    this.hole = new Mesh(gridGeometry(new Float32Array(this.h0)), this.holeMat)
    this.hole.name = 'room-light'
    this.hole.renderOrder = 3
    this.hole.frustumCulled = false
    this.holeAnchor.name = 'room-light-anchor'
    this.holeAnchor.add(this.hole)
    this.holeAnchor.position.copy(this.source)
    this.holeAnchor.quaternion.copy(this.baseQuat)
    this.cropSkin()
  }

  /** The middle of the piece, in the world. */
  center(out: Vector3): Vector3 {
    return out.copy(this.pullLocal).applyQuaternion(this.anchor.quaternion).add(this.anchor.position)
  }

  /** A hand can take hold of a piece that is floating or lying on a surface. */
  get loose(): boolean {
    return this.state === 'free' || this.state === 'stuck'
  }

  /** The light has opened for good: the piece left the wall. */
  get parted(): boolean {
    return this.freeT >= 0
  }

  contains(point: Vector3): number {
    const local = this.anchor.worldToLocal(this.scratch.copy(point))
    const across = Math.hypot(local.x, local.y)
    if (Math.abs(local.z) > 0.07 || across > this.radius + 0.02) return -1
    return across + Math.abs(local.z)
  }

  /** Where a ray meets the piece's own plane, within its outline. */
  rayHit(origin: Vector3, dir: Vector3): number {
    const n = this.scratch.set(0, 0, 1).applyQuaternion(this.anchor.quaternion)
    const facing = n.dot(dir)
    if (Math.abs(facing) < 1e-4) return -1
    const t = this.aside.copy(this.anchor.position).sub(origin).dot(n) / facing
    if (t <= 0.05) return -1
    const local = this.anchor.worldToLocal(this.scratch.copy(origin).addScaledVector(dir, t))
    return Math.hypot(local.x, local.y) <= this.radius ? t : -1
  }

  /** The fingers moved. */
  drag(hand: Vector3): void {
    if (this.state === 'carried') {
      this.target.copy(hand).add(this.offset)
      return
    }
    if (this.state !== 'lifting') return
    this.scratch.copy(hand).sub(this.start)
    const out = Math.max(0, this.scratch.dot(this.normal))
    this.pullLocal.set(this.scratch.dot(this.tangent), this.scratch.dot(this.bitangent), out)
    this.pull = this.pullLocal.length()
    this.amount = pullAmount(this.pull, this.scale)
    if (!this.fixedSize) this.radius = Math.max(this.radius, pieceRadius(this.pull, this.scale))
    if (peelFate(this.pull, this.scale) === 'pop') {
      this.part()
      this.state = 'carried'
      this.offset.copy(this.anchor.position).sub(hand)
      this.target.copy(this.anchor.position)
    }
  }

  /** The fingers opened while the piece was still joined to the wall. */
  letGo(): void {
    if (this.state !== 'lifting') return
    if (peelFate(this.pull, this.scale) === 'settle') {
      this.state = 'settling'
      return
    }
    this.part()
    this.hover()
  }

  /** Take hold of a loose piece. */
  grab(hand: Vector3): void {
    if (!this.loose) return
    if (this.state === 'stuck') {
      // It keeps the shape of the surface it was lying on.
      this.h0.set(this.h1)
      this.attribute('aH0').needsUpdate = true
      this.mat.uniforms.uLand.value = 0
      this.baseQuat.copy(this.anchor.quaternion)
    }
    this.travelled = true
    this.state = 'carried'
    this.offset.copy(this.anchor.position).sub(hand)
    this.target.copy(this.anchor.position)
  }

  /** Let go in open air: it floats where it is. */
  drop(): void {
    if (this.state !== 'carried') return
    this.hover()
  }

  /** Let go over a surface: lie down on it, taking its shape. */
  land(hit: SurfacePoint, field: RoomField): void {
    if (this.state !== 'carried') return
    this.fold()
    const n = this.scratch.set(hit.nx, hit.ny, hit.nz).normalize()
    const basis = basisKeeping(n.x, n.y, n.z, this.tangent.x, this.tangent.y, this.tangent.z)
    this.fromPos.copy(this.anchor.position)
    this.fromQuat.copy(this.anchor.quaternion)
    this.normal.copy(n)
    this.setBasis(basis)
    this.toQuat.copy(this.baseQuat)
    this.toPos.set(hit.x + n.x * 0.004, hit.y + n.y * 0.004, hit.z + n.z * 0.004)
    readRelief(field, this.scratch.set(hit.x, hit.y, hit.z), basis, this.normal, this.h1)
    this.attribute('aH1').needsUpdate = true
    this.landT = 0
    this.landed = false
    this.travelled = true
    this.state = 'landing'
  }

  /** Clear the piece away gently. */
  fade(): void {
    if (this.state === 'fading') return
    this.state = 'fading'
  }

  step(dt: number): void {
    this.time += dt
    const u = this.mat.uniforms
    const fast = REDUCE_MOTION
    switch (this.state) {
      case 'lifting':
        this.show = smooth(this.pull / (TACK * this.scale * 0.6))
        this.open = smooth(this.amount * 1.4) * 0.85
        break
      case 'settling': {
        this.pullLocal.multiplyScalar(fast ? 0 : Math.exp(-dt / 0.055))
        this.pull = this.pullLocal.length()
        this.amount = pullAmount(this.pull, this.scale)
        this.open *= fast ? 0 : Math.exp(-dt / 0.08)
        this.show = smooth(this.pull / 0.004)
        if (this.pull < 0.0015) this.done = true
        break
      }
      case 'carried':
        this.follow(dt)
        break
      case 'free':
        this.bob()
        break
      case 'landing':
        this.settleOn(dt)
        break
      case 'stuck':
        break
      case 'fading':
        this.show = Math.max(0, this.show - dt / (fast ? 0.001 : 0.4))
        this.open = Math.max(0, this.open - dt / (fast ? 0.001 : 0.4))
        if (this.show <= 0 && this.open <= 0) this.done = true
        break
      default: {
        const never: never = this.state
        void never
      }
    }
    if (this.freeT >= 0) {
      if (this.freeT < 1) {
        this.freeT = fast ? 1 : Math.min(1, this.freeT + dt / FREE_TIME)
        if (this.freeT >= 1) this.fold()
      }
      if (this.state !== 'fading') {
        this.open += (1 - this.open) * Math.min(1, dt * 7)
        this.show = 1
      }
    }
    this.flash *= Math.exp(-dt / 0.35)
    const floating = this.state === 'carried' || this.state === 'free' ? 1 : 0
    this.float += (floating - this.float) * Math.min(1, dt * 5)
    u.uR.value = this.radius
    u.uPull.value.copy(this.pullLocal)
    u.uFree.value = this.freeT < 0 ? 0 : easeOut(this.freeT)
    u.uShow.value = this.show
    u.uFloat.value = fast ? 0 : this.float
    u.uTime.value = this.time
    const h = this.holeMat.uniforms
    h.uR.value = this.radius
    h.uOpen.value = this.open + this.flash
    h.uTime.value = this.time
    this.hole.visible = this.open + this.flash > 0.003
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.anchor.removeFromParent()
    this.holeAnchor.removeFromParent()
    this.mesh.geometry.dispose()
    this.hole.geometry.dispose()
    this.mat.dispose()
    this.holeMat.dispose()
    this.skin?.dispose()
    this.skin = null
    this.own?.dispose()
    this.own = null
  }

  /** The piece leaves the wall: the light opens fully and the sheet becomes one loose thing. */
  private part(): void {
    if (this.freeT >= 0) return
    this.freeT = 0
    this.flash = REDUCE_MOTION ? 0 : 0.55
    this.events.push('freed')
  }

  /** Stay where it is, floating. */
  private hover(): void {
    this.state = 'free'
    this.rest.copy(this.anchor.position)
  }

  /** Move the pull into the anchor, so the piece's origin is its middle again. */
  private fold(): void {
    if (this.freeT >= 0) this.freeT = 1
    if (this.pullLocal.lengthSq() === 0) return
    this.scratch.copy(this.pullLocal).applyQuaternion(this.anchor.quaternion)
    this.anchor.position.add(this.scratch)
    this.target.add(this.scratch)
    this.offset.add(this.scratch)
    this.rest.add(this.scratch)
    this.pullLocal.set(0, 0, 0)
  }

  /** Trail the hand a little, and lean into the movement. */
  private follow(dt: number): void {
    const k = REDUCE_MOTION ? 1 : 1 - Math.exp(-dt / CARRY_LAG)
    this.scratch.copy(this.target).sub(this.anchor.position).multiplyScalar(k)
    this.anchor.position.add(this.scratch)
    if (dt > 0) this.velocity.lerp(this.scratch.multiplyScalar(1 / dt), Math.min(1, dt * 12))
    // The lean is about the piece's own axes: moving up tips its top back.
    const lx = this.velocity.dot(this.tangent)
    const ly = this.velocity.dot(this.bitangent)
    const lean = (v: number) => Math.max(-0.3, Math.min(0.3, v * 0.35))
    const ease = Math.min(1, dt * 8)
    this.tiltX += (lean(ly) - this.tiltX) * ease
    this.tiltY += (lean(-lx) - this.tiltY) * ease
    if (REDUCE_MOTION) return
    this.tiltQuat.set(this.tiltX * 0.5, this.tiltY * 0.5, 0, 1).normalize()
    this.anchor.quaternion.copy(this.baseQuat).multiply(this.tiltQuat)
  }

  private bob(): void {
    if (REDUCE_MOTION) return
    const t = this.time
    this.anchor.position.copy(this.rest).addScaledVector(this.normal, Math.sin(t * 1.3) * 0.004)
    this.anchor.position.y += Math.sin(t * 0.9 + 1.7) * 0.003
    this.tiltQuat.set(Math.sin(t * 0.8) * 0.012, Math.sin(t * 0.6 + 0.9) * 0.014, 0, 1).normalize()
    this.anchor.quaternion.copy(this.baseQuat).multiply(this.tiltQuat)
  }

  private settleOn(dt: number): void {
    this.landT = REDUCE_MOTION ? 1 : Math.min(1, this.landT + dt / LAND_TIME)
    const k = 1 - Math.pow(1 - this.landT, 3)
    this.anchor.position.lerpVectors(this.fromPos, this.toPos, k)
    this.anchor.quaternion.slerpQuaternions(this.fromQuat, this.toQuat, k)
    const u = this.mat.uniforms
    u.uLand.value = k
    // A small squash as it meets the surface, then back.
    u.uSquish.value = 1 - 0.05 * Math.sin(Math.PI * Math.min(1, this.landT * 1.15))
    if (!this.landed && this.landT >= 0.7) {
      this.landed = true
      this.events.push('landed')
    }
    if (this.landT >= 1) {
      u.uSquish.value = 1
      this.state = 'stuck'
    }
  }

  private setBasis(basis: Basis): void {
    this.tangent.set(basis.tx, basis.ty, basis.tz)
    this.bitangent.set(basis.bx, basis.by, basis.bz)
    this.matrix.makeBasis(this.tangent, this.bitangent, this.normal)
    this.baseQuat.setFromRotationMatrix(this.matrix)
  }

  private attribute(name: string): BufferAttribute {
    return this.mesh.geometry.getAttribute(name) as BufferAttribute
  }

  /** Where each point of the piece sits in the picture, 0..1. Outside the picture is left out of range. */
  private imageCoords(): Float32Array {
    const uv = new Float32Array(COUNT * 2).fill(-1)
    const skin = this.skin
    if (!skin) return uv
    const px = { x: 0, y: 0 }
    const p = this.scratch
    for (let j = 0; j < PIECE_N; j++) {
      for (let i = 0; i < PIECE_N; i++) {
        const k = i + j * PIECE_N
        p.copy(this.source)
          .addScaledVector(this.tangent, gridAt(i))
          .addScaledVector(this.bitangent, gridAt(j))
          .addScaledVector(this.normal, this.h0[k])
        if (!projectPixel(skin.clip, p.x, p.y, p.z, skin.width, skin.height, px)) continue
        uv[k * 2] = px.x / skin.width
        uv[k * 2 + 1] = skin.topDown ? px.y / skin.height : 1 - px.y / skin.height
      }
    }
    return uv
  }

  /**
   * Swap the whole camera frame for a copy of just the part this piece shows,
   * so a dozen pieces do not each keep a full frame alive.
   */
  private cropSkin(): void {
    const skin = this.skin
    if (!skin) return
    const uv = this.attribute('aUv').array as Float32Array
    let u0 = 1
    let v0 = 1
    let u1 = 0
    let v1 = 0
    const limit = PIECE_MAX * 1.3
    for (let j = 0; j < PIECE_N; j++) {
      for (let i = 0; i < PIECE_N; i++) {
        if (Math.hypot(gridAt(i), gridAt(j)) > limit) continue
        const k = i + j * PIECE_N
        const u = uv[k * 2]
        const v = uv[k * 2 + 1]
        if (u < 0) continue
        u0 = Math.min(u0, u)
        v0 = Math.min(v0, v)
        u1 = Math.max(u1, u)
        v1 = Math.max(v1, v)
      }
    }
    u0 = Math.max(0, u0 - 0.01)
    v0 = Math.max(0, v0 - 0.01)
    u1 = Math.min(1, u1 + 0.01)
    v1 = Math.min(1, v1 + 0.01)
    if (u1 - u0 < 0.01 || v1 - v0 < 0.01) return
    void skin.crop(u0, v0, u1, v1).then((texture) => {
      if (!texture) return
      if (this.disposed) {
        texture.dispose()
        return
      }
      this.own = texture
      this.mat.uniforms.uMap.value = texture
      this.mat.uniforms.uUvRect.value.set(u0, v0, u1 - u0, v1 - v0)
      skin.dispose()
      if (this.skin === skin) this.skin = null
    })
  }
}
