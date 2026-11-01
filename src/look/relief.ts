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
import { softenField, type DepthField } from '../capture/brightness-depth.js'
import type { Raster } from '../capture/crop.js'

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
      uCurlAxis: { value: new Vector2(1, 0) },
      uCurlFold: { value: 1 },
      uCurlRadius: { value: 0 },
      uCurlShadow: { value: 0 },
      uCurlClear: { value: 0.028 },
      uReliefFloor: { value: -10 },
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
      uniform vec2 uCurlAxis;
      uniform float uCurlFold;
      uniform float uCurlRadius;
      uniform float uCurlShadow;
      uniform float uCurlClear;
      uniform float uReliefFloor;
      varying vec2 vUv;
      varying float vKeep;
      varying float vSide;
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
        float curled = uCurlRadius > 0.001 ? 1.0 : 0.0;
        vKeep = uHasDepth > 0.5 && curled < 0.5 ? 1.0 - smoothstep(uEdge, uEdge + uBand, j) : 1.0;
        float reliefZ = 0.0;
        if (uHasDepth > 0.5) {
          vec2 r = span();
          float d = depthAt(uv);
          float far = min(min(raw(uv + vec2(r.x, 0.0)), raw(uv - vec2(r.x, 0.0))), min(raw(uv + vec2(0.0, r.y)), raw(uv - vec2(0.0, r.y))));
          float cliff = smoothstep(uEdge, uEdge + max(0.02, uBand * 0.35), j);
          float seated = mix(d, min(d, far), cliff);
          reliefZ = (mix(seated, d, curled) - 0.28) * uDepthAmt * uRelief;
          reliefZ = max(reliefZ, uReliefFloor);
        }
        vec3 n = vec3(0.0, 0.0, 1.0);
        float side = -1.0;
        if (uCurlRadius > 0.001) {
          vec2 axis = uCurlAxis;
          float alen = length(axis);
          axis = alen > 0.001 ? axis / alen : vec2(1.0, 0.0);
          float dist = dot(p.xy, axis) - uCurlFold;
          side = dist;
          if (dist > 0.0) {
            float phi = min(dist / uCurlRadius, 0.9);
            float extra = dist - phi * uCurlRadius;
            float along = uCurlRadius * sin(phi) + extra * cos(phi);
            float lift = uCurlRadius * (1.0 - cos(phi)) + extra * sin(phi);
            p.xy += axis * (along - dist);
            // Clear the sheet still stuck to the frame so the curl does not z-fight it.
            p.z += lift + smoothstep(0.0, 0.035, dist) * uCurlClear;
            n = vec3(-axis * sin(phi), cos(phi));
          }
        }
        p += n * reliefZ;
        vSide = side;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uPhoto;
      uniform float uFeather;
      uniform float uCurlRadius;
      uniform float uCurlShadow;
      varying vec2 vUv;
      varying float vKeep;
      varying float vSide;
      ${contentsFn}
      void main() {
        vec4 contents = frameContents(vUv);
        vec2 m = min(vUv, 1.0 - vUv);
        float edge = smoothstep(0.0, max(uFeather, 1e-4), min(m.x, m.y));
        float a = contents.a * edge * vKeep;
        if (a < 0.08) discard;
        float shade = 1.0;
        if (vSide < 0.0 && uCurlShadow > 0.001 && uCurlRadius > 0.001) {
          float band = max(0.025, uCurlRadius * 2.0);
          float t = clamp(-vSide / band, 0.0, 1.0);
          shade = 1.0 - (1.0 - t) * (1.0 - t) * 0.55 * clamp(uCurlShadow, 0.0, 1.0);
        }
        gl_FragColor = vec4(contents.rgb * shade, a);
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

/** How far relief may sink behind the sheet. Stuck stickers sit near zero so they stay on the wall. */
export function setReliefFloor(mat: ShaderMaterial, floor: number): void {
  mat.uniforms.uReliefFloor.value = floor
}

export interface CurlPose {
  axisX: number
  axisY: number
  /** Fold position along the peel axis. Vertices past it lift off the plane. */
  fold: number
  /** Cylinder radius in metres. Zero leaves the photo flat. */
  radius: number
  /** 0..1 darkening of the part still stuck to the frame. */
  shadow: number
  /** Extra lift, in metres, so a peel clears the sheet under it. */
  clear?: number
}

/** Page-curl the relief. A null pose lays it flat again. */
export function applyCurl(mat: ShaderMaterial, pose: CurlPose | null): void {
  const on = pose !== null && pose.radius > 0.001
  mat.uniforms.uCurlRadius.value = on && pose ? pose.radius : 0
  mat.uniforms.uCurlClear.value = pose?.clear ?? 0.028
  if (!on || !pose) return
  ;(mat.uniforms.uCurlAxis.value as Vector2).set(pose.axisX, pose.axisY)
  mat.uniforms.uCurlFold.value = pose.fold
  mat.uniforms.uCurlShadow.value = pose.shadow
}

export function bindMesh(mesh: Mesh): void {
  mesh.frustumCulled = false
  mesh.renderOrder = 2
}
