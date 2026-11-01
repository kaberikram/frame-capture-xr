import {
  Vector3,
  type Entity,
  type Group,
  type InputManager,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
  type World,
  type XROrigin,
} from '@iwsdk/core'
import type { Held } from '../capture/held.js'
import type { RectGesture } from '../input/gesture.js'
import type { DissolveRig } from '../look/dissolve.js'
import { clamp } from '../util/math.js'
import { CaptureLook } from './capture-look.js'

/** The CaptureLook knobs, read once per frame from the settings entity. */
export interface Look {
  relief: number
  pop: number
  edge: number
  band: number
  feather: number
  minSpan: number
  strip: number
  segments: number
  layers: number
  spread: number
  curl: number
  detach: number
  spring: number
  snap: number
  squish: number
  dissolve: number
}

export function defaultLook(): Look {
  return {
    relief: 0.42, pop: 0.85, edge: 0.18, band: 0.1, feather: 0.018, minSpan: 0.12, strip: 0.008, segments: 72,
    layers: 24, spread: 0.2, curl: 0.075, detach: 0.7, spring: 36,
    snap: 0.04, squish: 0.95, dissolve: 0.6,
  }
}

/** What every part of the capture app shares: the IWSDK world, the scene root, the knobs, and the captures. */
export interface Ctx {
  readonly world: World
  readonly renderer: WebGLRenderer
  readonly scene: Scene
  readonly camera: PerspectiveCamera
  readonly player: XROrigin
  readonly input: InputManager
  readonly root: Group
  readonly look: Look
  readonly captures: Held[]
  readonly dissolves: DissolveRig[]
  readonly gesture: RectGesture
}

export const WORLD_UP = new Vector3(0, 1, 0)
/** Metres in front of the desk camera where a mouse-drawn frame sits. */
export const DRAW_DISTANCE = 0.95
/** Peel amount that leaves one corner slightly off a stuck sticker. */
export const LIFT_CURL = 0.26
/** Metres the stuck sheet sits off the surface, so the relief does not clip it. */
export const STICK_GAP = 0.012
export const MAX_CAPTURES = 16

export const REDUCE_MOTION = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function firstEntity(entities: Iterable<Entity>): Entity | null {
  for (const entity of entities) return entity
  return null
}

export function readLook(entity: Entity, look: Look): void {
  const n = (field: keyof Look) => entity.getValue(CaptureLook, field) as number
  look.relief = n('relief')
  look.pop = n('pop')
  look.edge = n('edge')
  look.band = n('band')
  look.feather = n('feather')
  look.minSpan = n('minSpan')
  look.strip = n('strip')
  look.segments = n('segments')
  const layers = n('layers')
  const spread = n('spread')
  const curl = n('curl')
  const detach = n('detach')
  const spring = n('spring')
  if (Number.isFinite(layers)) look.layers = layers
  if (Number.isFinite(spread)) look.spread = spread
  if (Number.isFinite(curl)) look.curl = curl
  if (Number.isFinite(detach)) look.detach = detach
  if (Number.isFinite(spring)) look.spring = spring
  const snap = n('snap')
  const squish = n('squish')
  const dissolve = n('dissolve')
  if (Number.isFinite(snap)) look.snap = snap
  if (Number.isFinite(squish)) look.squish = clamp(squish, 0.8, 1)
  if (Number.isFinite(dissolve)) look.dissolve = dissolve
}
