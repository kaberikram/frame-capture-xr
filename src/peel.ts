import {
  DoubleSide,
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  type Texture,
} from '@iwsdk/core'
import { PHOTO_CONTENTS } from './relief.js'
export { spreadFromPull, springStep } from './peel-math.js'

/** Sheets built per capture. The live count is the CaptureLook knob, at most this. */
export const PEEL_CAP = 32

export interface PeelRig {
  root: Group
  geometry: PlaneGeometry
  meshes: Mesh[]
  mats: ShaderMaterial[]
}

/**
 * One flat card per depth band. High depth is near, so the last sheet is the front.
 * A pixel is drawn only on the sheet whose band contains it, so the gaps stay empty.
 */
export function makePeel(width: number, height: number): PeelRig {
  const root = new Group()
  root.name = 'peel'
  const geometry = new PlaneGeometry(width, height, 1, 1)
  const meshes: Mesh[] = []
  const mats: ShaderMaterial[] = []
  for (let layer = 0; layer < PEEL_CAP; layer++) {
    const mat = sheetMaterial(layer)
    const mesh = new Mesh(geometry, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = 12 + layer
    mesh.visible = false
    root.add(mesh)
    meshes.push(mesh)
    mats.push(mat)
  }
  return { root, geometry, meshes, mats }
}

export function bindPeel(rig: PeelRig, photo: Texture | null, depth: Texture | null, texel: Vector2, feather: number, hasDepth: number): void {
  for (let i = 0; i < rig.mats.length; i++) {
    const uniforms = rig.mats[i].uniforms
    uniforms.uPhoto.value = photo
    uniforms.uDepth.value = depth
    ;(uniforms.uTexel.value as Vector2).copy(texel)
    uniforms.uFeather.value = feather
    uniforms.uHasDepth.value = hasDepth
  }
}

export interface PeelPose {
  layers: number
  /** 0 closed, 1 pulled to maxSpread. */
  spread: number
  maxSpread: number
  /** 0..1 pop of the compact relief, so a closed stack sits where the relief sat. */
  relief: number
  depthAmt: number
  feather: number
}

/** Park each live sheet on its band and slide it forward by the pull. */
export function layoutPeel(rig: PeelRig, pose: PeelPose): void {
  const layers = clampInt(pose.layers, 8, PEEL_CAP)
  const spread = pose.spread < 0 ? 0 : pose.spread > 1 ? 1 : pose.spread
  const opened = spread > 0.02
  const denom = Math.max(1, layers - 1)
  for (let i = 0; i < rig.meshes.length; i++) {
    const mesh = rig.meshes[i]
    const live = opened && i < layers
    mesh.visible = live
    if (!live) continue
    const mat = rig.mats[i]
    mat.uniforms.uLayer.value = i
    mat.uniforms.uLayers.value = layers
    mat.uniforms.uFeather.value = pose.feather
    mat.uniforms.uReveal.value = smooth(Math.min(1, spread / 0.08))
    const depth = (i + 0.5) / layers
    const reliefZ = (depth - 0.28) * pose.depthAmt * pose.relief
    const peelZ = (i / denom) * spread * pose.maxSpread
    mesh.position.set(0, 0, reliefZ + peelZ)
  }
}

function sheetMaterial(layer: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uPhoto: { value: null as Texture | null },
      uDepth: { value: null as Texture | null },
      uTexel: { value: new Vector2(1, 1) },
      uFeather: { value: 0.018 },
      uHasDepth: { value: 0 },
      uLayer: { value: layer },
      uLayers: { value: 24 },
      uReveal: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uPhoto;
      uniform sampler2D uDepth;
      uniform float uFeather;
      uniform float uHasDepth;
      uniform float uLayer;
      uniform float uLayers;
      uniform float uReveal;
      varying vec2 vUv;
      ${PHOTO_CONTENTS}
      void main() {
        if (uHasDepth < 0.5 || uReveal < 0.01) discard;
        float d = texture(uDepth, clamp(vUv, vec2(0.002), vec2(0.998))).r;
        float band = 1.0 / max(uLayers, 1.0);
        float lo = uLayer * band;
        float hi = lo + band;
        float f = band * 0.42;
        float keep = smoothstep(lo - f, lo + f * 0.2, d) * (1.0 - smoothstep(hi - f * 0.2, hi + f, d));
        if (uLayer < 0.5) keep = 1.0 - smoothstep(hi - f * 0.2, hi + f, d);
        if (uLayer > uLayers - 1.5) keep = smoothstep(lo - f, lo + f * 0.2, d);
        vec4 contents = frameContents(vUv);
        vec2 m = min(vUv, 1.0 - vUv);
        float edge = smoothstep(0.0, max(uFeather, 1e-4), min(m.x, m.y));
        float a = contents.a * edge * keep * uReveal;
        if (a < 0.04) discard;
        gl_FragColor = vec4(contents.rgb, a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  })
}

function smooth(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.round(v)
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}
