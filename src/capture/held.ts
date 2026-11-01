import { Group, Mesh, Quaternion, Vector2, Vector3, type ShaderMaterial } from '@iwsdk/core'
import type { Look } from '../app/context.js'
import { makeHandle, placeHandle } from '../interaction/handle.js'
import { makePeel, type PeelRig } from '../interaction/peel.js'
import { REDUCE_MOTION } from '../app/context.js'
import { makeGlowLine, setGlowLine, type GlowLine } from '../look/glow-line.js'
import { PALETTE } from '../look/palette.js'
import { applyLook, bindMesh, reliefGeometry, reliefMaterial, type ReliefLook } from '../look/relief.js'
import type { DepthField } from './brightness-depth.js'
import type { Raster } from './crop.js'

export type DepthKind = 'wait' | 'brightness' | 'model'
/** idle on the frame, curling, fanned into sheets, a free sticker, or stuck to a surface. */
export type StickerMode = 'idle' | 'curl' | 'sheets' | 'free' | 'stuck'

/** One captured frame: its scene graph and where it is in the develop, peel, and stick story. */
export interface Held {
  group: Group
  photo: Mesh
  mat: ShaderMaterial
  raster: Raster | null
  /** Brightness depth from the darkroom, shown while the model works. */
  preview: DepthField | null
  /** The model has been asked and has not answered or failed yet. */
  modelPending: boolean
  /** 0..1 progress through the current bloom, without the overshoot. Gates read this. */
  pop: number
  popping: boolean
  /** Relief amount the current bloom starts from and heads to. */
  reliefFrom: number
  reliefTo: number
  bloomT: number
  /** 0..1 crossfade from the previous depth map to the newest. */
  depthMix: number
  /** The depth sheets were laid out open last frame. */
  sheetsOpen: boolean
  flat: boolean
  age: number
  depth: DepthKind
  token: number
  width: number
  height: number
  peel: PeelRig
  handle: Mesh
  /** 0 closed, 1 pulled out to the max sheet spread. */
  spread: number
  spreadV: number
  mode: StickerMode
  /** 0 stuck, 1 peeled to the far edge. */
  curl: number
  curlV: number
  axisX: number
  axisY: number
  cornerX: number
  cornerY: number
  /** The pinch or the desk demo is driving the gesture, so the spring waits. */
  holding: boolean
  /** The white frame has broken apart. The photo lives on the root. */
  frameGone: boolean
  /** 0 at contact, 1 after the squish eases back to full size. */
  squishT: number
  shadow: Mesh | null
  /** The frame's line of light. */
  border: GlowLine
  /** Page-clock seconds when the frame was anchored. */
  since: number
  /** Seconds since the photo arrived, for the develop. -1 before it arrives. */
  developT: number
  /** 0..1 strength of the thinking sweep, eased. */
  sheen: number
  /** Where a carried sticker is heading; the photo follows it on a short lag. */
  follow: Vector3
  following: boolean
  /** The sticker's pose when it was picked up, before the tilt from moving. */
  baseQuat: Quaternion
  /** Smoothed tilt from motion, radians about the sticker's right and up axes. */
  tilt: Vector2
  /** Seconds of gentle bob since it was let go in open air. */
  bobT: number
}

export function heldLook(look: Look, width: number, height: number): ReliefLook {
  return {
    depthAmt: Math.max(width, height) * look.relief,
    edge: look.edge,
    band: look.band,
    feather: look.feather,
    width,
    height,
  }
}

/** A frame's scene graph at the size just drawn. The caller poses the group and adds it to the root. */
export function makeHeld(look: Look, halfW: number, halfH: number, holdFlat: boolean, token: number): Held {
  const group = new Group()
  group.name = 'capture'
  const border = makeGlowLine(PALETTE, 5)
  border.mesh.position.z = 0.004
  group.add(border.mesh)
  const width = halfW * 2
  const height = halfH * 2
  const mat = reliefMaterial()
  applyLook(mat, heldLook(look, width, height))
  const photo = new Mesh(reliefGeometry(width, height, look.segments), mat)
  bindMesh(photo)
  photo.visible = false
  group.add(photo)
  const peel = makePeel(width, height)
  group.add(peel.root)
  const handle = makeHandle()
  placeHandle(handle, halfH, look.strip)
  group.add(handle)
  return {
    group, photo, mat, raster: null, preview: null, modelPending: false, pop: 0, popping: false,
    reliefFrom: 0, reliefTo: 0, bloomT: 0, depthMix: 1, sheetsOpen: false,
    flat: holdFlat, age: 0, depth: 'wait', token,
    width, height, peel, handle, spread: 0, spreadV: 0, holding: false,
    mode: 'idle', curl: 0, curlV: 0, axisX: 1, axisY: 0, cornerX: width * 0.5, cornerY: height * 0.5,
    frameGone: false, squishT: 1, shadow: null,
    border, since: performance.now() / 1000, developT: -1, sheen: 0,
    follow: new Vector3(), following: false, baseQuat: new Quaternion(), tilt: new Vector2(), bobT: 0,
  }
}

/**
 * The frame's line of light. On release it inhales, brighter and thicker for a
 * moment; while the shutter waits for hands it breathes; then it settles to a
 * quiet glow. `now` is page-clock seconds.
 */
export function layoutBorder(held: Held, strip: number, now: number, waiting: boolean): void {
  if (held.frameGone) return
  const k = now - held.since
  const inhale = !REDUCE_MOTION && k > 0 && k < 0.3 ? Math.sin((Math.PI * k) / 0.3) : 0
  const s = Math.min(1, Math.max(0, k / 0.6))
  const settled = s * s * (3 - 2 * s)
  let glow = (1 - 0.5 * settled) * (1 + 0.9 * inhale)
  if (waiting && !REDUCE_MOTION) glow *= 0.85 + 0.25 * Math.sin(now * 4)
  const t = Math.min(1, Math.max(0, k / 0.4))
  setGlowLine(held.border, {
    halfW: held.width * 0.5,
    halfH: held.height * 0.5,
    core: strip * 0.75 * (1 + 0.6 * inhale),
    glow,
    tint: 0.035 * (1 - t * t * (3 - 2 * t)),
    opacity: 1,
    time: now,
  })
}

/** Every mode change goes through here, so leaving or reaching a surface always fixes up the shadow and squish. */
export function setMode(held: Held, next: StickerMode): void {
  const was = held.mode
  if (was === next) return
  held.mode = next
  if (was === 'stuck') {
    held.photo.scale.set(1, 1, 1)
    held.squishT = 1
    if (held.shadow) held.shadow.visible = false
  }
  if (next === 'stuck' && held.shadow) held.shadow.visible = true
}

/** The photo has eased far enough out of the frame to be peeled or fanned. */
export function canPeel(held: Held): boolean {
  if (held.flat || held.depth === 'wait' || held.mode === 'free' || held.frameGone) return false
  return (held.mat.uniforms.uRelief.value as number) > 0.55
}

/** Throw away a frame that never got its photo, and everything in it. */
export function disposeHeld(held: Held): void {
  dropFrame(held)
  held.photo.removeFromParent()
  held.photo.geometry.dispose()
  const photo = held.mat.uniforms.uPhoto.value as { dispose(): void } | null
  const depth = held.mat.uniforms.uDepth.value as { dispose(): void } | null
  const prev = held.mat.uniforms.uDepthPrev.value as { dispose(): void } | null
  photo?.dispose()
  depth?.dispose()
  if (prev !== depth) prev?.dispose()
  held.mat.dispose()
}

/** Throw away the empty frame: border, handle, and sheets. The photo has already moved to the root. */
export function dropFrame(held: Held): void {
  held.peel.geometry.dispose()
  for (let i = 0; i < held.peel.mats.length; i++) held.peel.mats[i].dispose()
  held.handle.geometry.dispose()
  const handleMat = held.handle.material
  if (!Array.isArray(handleMat)) handleMat.dispose()
  for (let i = 0; i < held.group.children.length; i++) {
    const child = held.group.children[i]
    if (child === held.peel.root || child === held.handle || child === held.photo) continue
    const mesh = child as Mesh
    mesh.geometry?.dispose()
    const mat = mesh.material
    if (mat && !Array.isArray(mat)) mat.dispose()
  }
  held.group.removeFromParent()
  held.frameGone = true
}
