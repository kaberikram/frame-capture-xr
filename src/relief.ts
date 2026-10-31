import {
  CanvasTexture,
  DataTexture,
  FrontSide,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  Vector2,
  type Texture,
} from '@iwsdk/core'
import { softenField, type DepthField } from './brightness-depth.js'
import type { Raster } from './crop.js'

/**
 * Per-frame contents. Slit-scan and slow motion replace this GLSL function
 * (`vec4 frameContents(vec2 uv)`) and can read extra uniforms on the material.
 * The default samples the captured photo.
 */
export const PHOTO_CONTENTS = `
vec4 frameContents(vec2 uv) {
  return texture(uPhoto, uv);
}
`

export interface ReliefLook {
  depthAmt: number
  edge: number
  band: number
  feather: number
  width: number
  height: number
}

/**
 * A subdivided photo that displaces along its normal. High depth is near and
 * comes forward. Steep depth jumps fade out so a cliff does not stretch into
 * a sheet you can see from the side.
 */
export function reliefMaterial(contentsFn = PHOTO_CONTENTS): ShaderMaterial {
  const depth = new DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1)
  depth.colorSpace = LinearSRGBColorSpace
  depth.magFilter = LinearFilter
  depth.minFilter = LinearFilter
  depth.generateMipmaps = false
  depth.flipY = true
  depth.needsUpdate = true
  return new ShaderMaterial({
    uniforms: {
      uPhoto: { value: null as Texture | null },
      uDepth: { value: depth },
      uTexel: { value: new Vector2(1, 1) },
      uRelief: { value: 0 },
      uHasDepth: { value: 0 },
      uDepthAmt: { value: 0.2 },
      uEdge: { value: 0.18 },
      uBand: { value: 0.1 },
      uFeather: { value: 0.018 },
      uSize: { value: new Vector2(0.3, 0.2) },
    },
    vertexShader: /* glsl */ `
      uniform sampler2D uDepth;
      uniform vec2 uTexel;
      uniform float uRelief;
      uniform float uHasDepth;
      uniform float uDepthAmt;
      uniform float uEdge;
      uniform float uBand;
      uniform vec2 uSize;
      varying vec2 vUv;
      varying float vKeep;
      float raw(vec2 q) { return texture(uDepth, clamp(q, vec2(0.002), vec2(0.998))).r; }
      float depthAt(vec2 q) {
        vec2 r = uTexel * 1.5;
        return (raw(q) * 2.0
          + raw(q + vec2(r.x, 0.0)) + raw(q - vec2(r.x, 0.0))
          + raw(q + vec2(0.0, r.y)) + raw(q - vec2(0.0, r.y))) / 6.0;
      }
      // Two texels on a coarse map, and at least ~1% of a 0.32 m frame on a fine one.
      vec2 span() {
        float widen = clamp(0.32 / max(uSize.x, 0.05), 0.0, 1.0);
        return max(uTexel * 2.0, vec2(0.012 * widen));
      }
      float jump(vec2 q) {
        vec2 r = span();
        float dx = raw(q + vec2(r.x, 0.0)) - raw(q - vec2(r.x, 0.0));
        float dy = raw(q + vec2(0.0, r.y)) - raw(q - vec2(0.0, r.y));
        return length(vec2(dx, dy));
      }
      void main() {
        vUv = uv;
        vec3 p = position;
        float j = uHasDepth > 0.5 ? jump(uv) : 0.0;
        vKeep = uHasDepth > 0.5 ? 1.0 - smoothstep(uEdge, uEdge + uBand, j) : 1.0;
        if (uHasDepth > 0.5) {
          vec2 r = span();
          float d = depthAt(uv);
          float far = min(min(raw(uv + vec2(r.x, 0.0)), raw(uv - vec2(r.x, 0.0))), min(raw(uv + vec2(0.0, r.y)), raw(uv - vec2(0.0, r.y))));
          float cliff = smoothstep(uEdge, uEdge + max(0.02, uBand * 0.35), j);
          p.z += (mix(d, min(d, far), cliff) - 0.28) * uDepthAmt * uRelief;
        }
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uPhoto;
      uniform float uFeather;
      varying vec2 vUv;
      varying float vKeep;
      ${contentsFn}
      void main() {
        vec4 contents = frameContents(vUv);
        vec2 m = min(vUv, 1.0 - vUv);
        float edge = smoothstep(0.0, max(uFeather, 1e-4), min(m.x, m.y));
        float a = contents.a * edge * vKeep;
        if (a < 0.08) discard;
        gl_FragColor = vec4(contents.rgb, a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: true,
    side: FrontSide,
  })
}

export function reliefGeometry(width: number, height: number, segments: number): PlaneGeometry {
  const long = Math.max(width, height)
  const nx = Math.max(8, Math.round(segments * (width / long)))
  const ny = Math.max(8, Math.round(segments * (height / long)))
  return new PlaneGeometry(width, height, nx, ny)
}

export function applyLook(mat: ShaderMaterial, look: ReliefLook): void {
  mat.uniforms.uDepthAmt.value = look.depthAmt
  mat.uniforms.uEdge.value = look.edge
  mat.uniforms.uBand.value = look.band
  mat.uniforms.uFeather.value = look.feather
  ;(mat.uniforms.uSize.value as Vector2).set(Math.max(look.width, 0.05), Math.max(look.height, 0.05))
}

export function applyPhoto(mat: ShaderMaterial, raster: Raster): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = raster.width
  canvas.height = raster.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas is unavailable')
  const pixels = new Uint8ClampedArray(raster.data)
  ctx.putImageData(new ImageData(pixels, raster.width, raster.height), 0, 0)
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.generateMipmaps = false
  const prev = mat.uniforms.uPhoto.value as Texture | null
  prev?.dispose()
  mat.uniforms.uPhoto.value = tex
  return tex
}

export function applyDepth(mat: ShaderMaterial, field: DepthField): void {
  softenField(field, 2)
  const rgba = new Uint8Array(field.width * field.height * 4)
  for (let i = 0; i < field.data.length; i++) {
    const v = field.data[i]
    const j = i * 4
    rgba[j] = v
    rgba[j + 1] = v
    rgba[j + 2] = v
    rgba[j + 3] = 255
  }
  const tex = new DataTexture(rgba, field.width, field.height)
  tex.colorSpace = LinearSRGBColorSpace
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.generateMipmaps = false
  tex.flipY = true
  tex.needsUpdate = true
  const prev = mat.uniforms.uDepth.value as Texture
  if (prev !== tex) prev.dispose()
  mat.uniforms.uDepth.value = tex
  ;(mat.uniforms.uTexel.value as Vector2).set(1 / field.width, 1 / field.height)
  mat.uniforms.uHasDepth.value = 1
}

export function setRelief(mat: ShaderMaterial, amount: number): void {
  mat.uniforms.uRelief.value = amount
}

export function bindMesh(mesh: Mesh): void {
  mesh.frustumCulled = false
  mesh.renderOrder = 2
}
