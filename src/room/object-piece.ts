import { BufferAttribute, BufferGeometry, Group, Mesh, Quaternion, Vector3, type ShaderMaterial, type Texture } from '@iwsdk/core'
import { REDUCE_MOTION } from '../app/context.js'
import { projectPixel } from '../capture/lens.js'
import type { Palette } from '../look/palette.js'
import { ghostMaterial, shellMaterial } from '../look/room-glow.js'
import type { SurfacePoint } from './field.js'
import type { Shell } from './object.js'
import { POP, TACK } from './patch.js'
import type { PieceEvent, PieceState, RoomPiece } from './peel-piece.js'
import type { Skin } from './plates.js'

/** Pull this far, in metres, and a thing you only looked at comes away and flies to your hand. */
const REMOTE_POP = 0.09
/** Seconds for a far thing to close most of the way to the hand. */
const FLY = 0.2
const CARRY_LAG = 0.07
const LAND_TIME = 0.42
/** Seconds the light lingers on the place a thing was lifted from. */
const LINGER = 1.3

function smooth(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x
  return t * t * (3 - 2 * t)
}

/** A shell's geometry about its own centre, shared by the copy and the light on the original. */
export function shellGeometry(shell: Shell): BufferGeometry {
  const geo = new BufferGeometry()
  const local = new Float32Array(shell.positions.length)
  for (let i = 0; i < local.length; i += 3) {
    local[i] = shell.positions[i] - shell.cx
    local[i + 1] = shell.positions[i + 1] - shell.cy
    local[i + 2] = shell.positions[i + 2] - shell.cz
  }
  geo.setAttribute('position', new BufferAttribute(local, 3))
  geo.setAttribute('aEdge', new BufferAttribute(shell.edge, 1))
  geo.setIndex(new BufferAttribute(shell.indices, 1))
  geo.computeVertexNormals()
  return geo
}

/**
 * Where each point of a shell sits in a camera picture, 0..1. Out of range
 * where the camera did not see it.
 */
export function shellImageCoords(shell: Shell, skin: Skin | null): Float32Array {
  const count = shell.positions.length / 3
  const uv = new Float32Array(count * 2).fill(-1)
  if (!skin) return uv
  const px = { x: 0, y: 0 }
  const p = shell.positions
  for (let i = 0; i < count; i++) {
    if (!projectPixel(skin.clip, p[i * 3], p[i * 3 + 1], p[i * 3 + 2], skin.width, skin.height, px)) continue
    uv[i * 2] = px.x / skin.width
    uv[i * 2 + 1] = skin.topDown ? px.y / skin.height : 1 - px.y / skin.height
  }
  return uv
}

export interface ObjectInit {
  shell: Shell
  /** Where the fingers pinched. The pull is measured from here. */
  start: Vector3
  skin: Skin | null
  palette: Palette
  /** `?peel=1.3` makes it take more pull. */
  scale: number
  /** Pinched from across the room, by looking at it. */
  remote: boolean
}

/**
 * A thing lifted out of the room in its own shape. It starts exactly over the
 * real one, slides out with your fingers, and comes away. Light lingers on the
 * real one for a moment, then goes.
 */
export class ObjectPiece implements RoomPiece {
  readonly flat = false
  /** The copy. Its origin is the middle of the thing. */
  readonly anchor = new Group()
  /** The light on the real thing. */
  readonly holeAnchor = new Group()
  readonly source = new Vector3()
  readonly normal = new Vector3(0, 1, 0)
  /** Where it is being looked at from. The owner keeps this current. */
  readonly eye = new Vector3()
  state: PieceState = 'lifting'
  radius: number
  pull = 0
  amount = 0
  travelled = false
  done = false
  open = 0
  readonly events: PieceEvent[] = []
  /** Height of its middle above its lowest point, for setting it down. */
  readonly stand: number
  private readonly mesh: Mesh
  private readonly aura: Mesh
  private readonly mat: ShaderMaterial
  private readonly auraMat: ShaderMaterial
  private readonly start = new Vector3()
  private readonly offset = new Vector3()
  private readonly hold = new Vector3()
  private readonly hand = new Vector3()
  private readonly rest = new Vector3()
  private readonly velocity = new Vector3()
  private readonly drift = new Vector3()
  private readonly fromPos = new Vector3()
  private readonly toPos = new Vector3()
  private readonly tilt = new Quaternion()
  private readonly scratch = new Vector3()
  private readonly scale: number
  private remote: boolean
  private skin: Skin | null
  private own: Texture | null = null
  private readonly shell: Shell
  /** It has a camera picture. */
  private pictured: boolean
  private freed = false
  private since = 0
  private landT = -1
  private landed = false
  private show = 0
  private heat = 0
  private time = 0
  private disposed = false

  constructor(init: ObjectInit) {
    const { shell } = init
    this.shell = shell
    this.pictured = init.skin !== null
    this.scale = init.scale
    this.remote = init.remote
    this.skin = init.skin
    this.radius = shell.radius
    this.stand = shell.cy - shell.bottom
    this.source.set(shell.cx, shell.cy, shell.cz)
    this.start.copy(init.start)
    this.hand.copy(init.start)

    const geo = shellGeometry(shell)
    geo.setAttribute('aUv', new BufferAttribute(shellImageCoords(shell, this.skin), 2))
    this.mat = shellMaterial(init.palette)
    if (this.skin) {
      this.mat.uniforms.uMap.value = this.skin.texture
      this.mat.uniforms.uHasMap.value = 1
      this.mat.uniforms.uEncode.value = this.skin.linear ? 1 : 0
    }
    this.mesh = new Mesh(geo, this.mat)
    this.mesh.name = 'room-object'
    this.mesh.renderOrder = 6
    this.mesh.frustumCulled = false
    this.anchor.name = 'room-object-anchor'
    this.anchor.add(this.mesh)
    this.anchor.position.copy(this.source)

    // The light on the real thing is its ghost, with no picture: a pale shape and a bright outline.
    this.auraMat = ghostMaterial(init.palette)
    this.auraMat.uniforms.uLow.value = shell.bottom - shell.cy
    this.auraMat.uniforms.uSpan.value = Math.max(0.02, this.stand * 2)
    this.aura = new Mesh(geo, this.auraMat)
    this.aura.name = 'room-object-light'
    this.aura.renderOrder = 3
    this.aura.frustumCulled = false
    this.holeAnchor.name = 'room-object-light-anchor'
    this.holeAnchor.add(this.aura)
    this.holeAnchor.position.copy(this.source)
    this.cropSkin(geo)
  }

  center(out: Vector3): Vector3 {
    return out.copy(this.anchor.position)
  }

  /** Its points are kept where they were in the room, so a picture can be found for them at any time. */
  get needsSkin(): boolean {
    return !this.pictured && !this.disposed
  }

  setSkin(skin: Skin): void {
    if (!this.needsSkin) {
      skin.dispose()
      return
    }
    this.skin = skin
    this.pictured = true
    const geo = this.mesh.geometry
    const uv = geo.getAttribute('aUv') as BufferAttribute
    ;(uv.array as Float32Array).set(shellImageCoords(this.shell, skin))
    uv.needsUpdate = true
    this.mat.uniforms.uMap.value = skin.texture
    this.mat.uniforms.uHasMap.value = 1
    this.mat.uniforms.uEncode.value = skin.linear ? 1 : 0
    this.mat.uniforms.uUvRect.value.set(0, 0, 1, 1)
    this.cropSkin(geo)
  }

  get loose(): boolean {
    return this.state === 'free' || this.state === 'stuck'
  }

  get parted(): boolean {
    return this.freed
  }

  /** How near a point is to the thing, or -1 when it is not on it. */
  contains(point: Vector3): number {
    const d = point.distanceTo(this.anchor.position)
    return d <= this.radius * 0.9 + 0.03 ? d : -1
  }

  /** How far along a ray the thing is, or -1 when the ray passes it by. */
  rayHit(origin: Vector3, dir: Vector3): number {
    const t = this.scratch.copy(this.anchor.position).sub(origin).dot(dir)
    if (t <= 0.05) return -1
    const miss = this.scratch.copy(origin).addScaledVector(dir, t).distanceTo(this.anchor.position)
    return miss <= Math.max(this.radius * 0.8, 0.07) ? Math.max(0.05, t - this.radius * 0.5) : -1
  }

  drag(hand: Vector3): void {
    this.hand.copy(hand)
    if (this.state !== 'lifting') return
    this.scratch.copy(hand).sub(this.start)
    this.pull = this.scratch.length()
    const pop = this.popAt()
    const tack = TACK * this.scale
    this.amount = Math.min(1, Math.max(0, (this.pull - tack) / (pop - tack)))
    // It slides out with the fingers, a ghost of the thing leaving the thing.
    this.anchor.position.copy(this.source).add(this.scratch)
    if (this.pull >= pop) {
      this.part()
      this.take(hand)
    }
  }

  letGo(): void {
    // Not far enough to come away: it sinks back into the real thing.
    if (this.state === 'lifting') this.state = 'settling'
  }

  grab(hand: Vector3, remote = false): void {
    if (!this.loose) return
    this.remote = remote
    this.travelled = true
    this.anchor.scale.setScalar(1)
    this.hand.copy(hand)
    this.take(hand)
  }

  drop(): void {
    if (this.state !== 'carried') return
    this.state = 'free'
    this.rest.copy(this.anchor.position)
    // Let go while moving and it drifts on a little, like something weightless.
    this.drift.copy(this.velocity).clampLength(0, 1.1)
  }

  land(hit: SurfacePoint): void {
    if (this.state !== 'carried') return
    this.fromPos.copy(this.anchor.position)
    this.toPos.set(this.anchor.position.x, hit.y + this.stand + 0.003, this.anchor.position.z)
    this.landT = 0
    this.landed = false
    this.travelled = true
    this.state = 'landing'
  }

  fade(): void {
    this.state = 'fading'
  }

  step(dt: number): void {
    this.time += dt
    const fast = REDUCE_MOTION
    switch (this.state) {
      case 'lifting':
        this.show = smooth(this.pull / (TACK * this.scale * 0.6))
        this.open = 0.45 + 0.55 * this.amount
        break
      case 'settling': {
        const k = fast ? 1 : 1 - Math.exp(-dt / 0.07)
        this.anchor.position.lerp(this.source, k)
        this.pull = this.anchor.position.distanceTo(this.source)
        this.amount = 0
        this.show = smooth(this.pull / 0.01)
        this.open *= fast ? 0 : Math.exp(-dt / 0.12)
        if (this.pull < 0.002) this.done = true
        break
      }
      case 'carried':
        this.follow(dt)
        break
      case 'free':
        this.float(dt)
        break
      case 'landing':
        this.settleOn(dt)
        break
      case 'stuck':
        break
      case 'fading':
        this.show = Math.max(0, this.show - dt / (fast ? 0.001 : 0.5))
        this.open = 0
        if (this.show <= 0) this.done = true
        break
      default: {
        const never: never = this.state
        void never
      }
    }
    if (this.freed && this.state !== 'fading') {
      this.since += dt
      this.show = 1
      // The light on the real thing swells as the copy leaves, then goes.
      this.open = fast ? 0 : Math.exp(-this.since / LINGER) * (1 + 0.6 * Math.exp(-this.since / 0.18))
    }
    this.heat *= fast ? 0 : Math.exp(-dt / 0.5)
    const u = this.mat.uniforms
    u.uShow.value = this.show
    u.uHeat.value = this.heat + (this.state === 'lifting' ? 0.25 * this.amount : 0)
    const a = this.auraMat.uniforms
    a.uLevel.value = Math.min(1, this.open) * 0.75
    a.uTime.value = REDUCE_MOTION ? 0 : this.time
    this.aura.visible = this.open > 0.004
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.anchor.removeFromParent()
    this.holeAnchor.removeFromParent()
    this.mesh.geometry.dispose()
    this.mat.dispose()
    this.auraMat.dispose()
    this.skin?.dispose()
    this.skin = null
    this.own?.dispose()
    this.own = null
  }

  private popAt(): number {
    return (this.remote ? REMOTE_POP : POP) * this.scale
  }

  private part(): void {
    if (this.freed) return
    this.freed = true
    this.since = 0
    this.heat = REDUCE_MOTION ? 0 : 0.7
    this.events.push('freed')
  }

  /** It is in the hand now. Pinched from afar, it flies in to sit just past the fingers. */
  private take(hand: Vector3): void {
    this.state = 'carried'
    this.offset.copy(this.anchor.position).sub(hand)
    this.velocity.set(0, 0, 0)
  }

  private follow(dt: number): void {
    if (this.remote) {
      this.hold.copy(this.hand).sub(this.eye)
      if (this.hold.lengthSq() < 1e-6) this.hold.set(0, 0, -1)
      this.hold.normalize().multiplyScalar(this.radius * 0.6 + 0.05)
      this.offset.lerp(this.hold, REDUCE_MOTION ? 1 : 1 - Math.exp(-dt / FLY))
    }
    const k = REDUCE_MOTION ? 1 : 1 - Math.exp(-dt / CARRY_LAG)
    this.scratch.copy(this.hand).add(this.offset).sub(this.anchor.position).multiplyScalar(k)
    this.anchor.position.add(this.scratch)
    if (dt > 0) this.velocity.lerp(this.scratch.multiplyScalar(1 / dt), Math.min(1, dt * 10))
    if (REDUCE_MOTION) return
    // It leans into the way it is moving.
    const lean = (v: number) => Math.max(-0.22, Math.min(0.22, v * 0.25))
    this.tilt.set(lean(this.velocity.z) * 0.5, 0, lean(-this.velocity.x) * 0.5, 1).normalize()
    this.anchor.quaternion.slerp(this.tilt, Math.min(1, dt * 8))
  }

  private float(dt: number): void {
    if (REDUCE_MOTION) return
    this.rest.addScaledVector(this.drift, dt)
    this.drift.multiplyScalar(Math.exp(-dt / 0.45))
    const t = this.time
    this.anchor.position.copy(this.rest)
    this.anchor.position.y += Math.sin(t * 1.1) * 0.006
    this.tilt.set(Math.sin(t * 0.7) * 0.012, Math.sin(t * 0.45 + 0.9) * 0.03, Math.sin(t * 0.6 + 2.1) * 0.01, 1).normalize()
    this.anchor.quaternion.slerp(this.tilt, Math.min(1, dt * 3))
  }

  private settleOn(dt: number): void {
    this.landT = REDUCE_MOTION ? 1 : Math.min(1, this.landT + dt / LAND_TIME)
    const k = 1 - Math.pow(1 - this.landT, 3)
    this.anchor.position.lerpVectors(this.fromPos, this.toPos, k)
    this.tilt.set(0, 0, 0, 1)
    this.anchor.quaternion.slerp(this.tilt, k)
    // A small squash as it takes its own weight, then back.
    this.anchor.scale.set(1, 1 - 0.05 * Math.sin(Math.PI * Math.min(1, this.landT * 1.15)), 1)
    if (!this.landed && this.landT >= 0.7) {
      this.landed = true
      this.events.push('landed')
    }
    if (this.landT >= 1) {
      this.anchor.scale.setScalar(1)
      this.state = 'stuck'
    }
  }

  /** Keep only the part of the camera frame this thing shows. */
  private cropSkin(geo: BufferGeometry): void {
    const skin = this.skin
    if (!skin) return
    const uv = geo.getAttribute('aUv').array as Float32Array
    let u0 = 1
    let v0 = 1
    let u1 = 0
    let v1 = 0
    for (let i = 0; i < uv.length; i += 2) {
      const u = uv[i]
      const v = uv[i + 1]
      if (u < 0 || u > 1 || v < 0 || v > 1) continue
      if (u < u0) u0 = u
      if (v < v0) v0 = v
      if (u > u1) u1 = u
      if (v > v1) v1 = v
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
