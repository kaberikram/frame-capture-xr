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
  Vector3,
  type Texture,
} from '@iwsdk/core'
import type { DepthField } from '../capture/brightness-depth.js'
import type { Raster } from '../capture/crop.js'
import { PALETTE, linear } from './palette.js'

/**
 * Per-frame contents. The time window is a separate pane, not this photo.
 * `vec4 frameContents(vec2 uv)` samples the captured photo.
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
      /** The depth being faded out while a new map fades in. */
      uDepthPrev: { value: depth },
      uDepthMix: { value: 1 },
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
      /** 0 is warm haze, 1 the photo itself. */
      uDevelop: { value: 1 },
      /** 0..1 strength of the glossy sweep that says depth is on its way. */
      uSheenOn: { value: 0 },
      uTime: { value: 0 },
      /** Strength of the vinyl highlight along a bend. */
      uShine: { value: 0 },
      uHaze: { value: new Vector3(...linear(PALETTE.haze)) },
      uSheenCol: { value: new Vector3(...linear(PALETTE.sheen)) },
    },
    vertexShader: /* glsl */ `
      uniform sampler2D uDepth;
      uniform sampler2D uDepthPrev;
      uniform float uDepthMix;
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
      varying vec3 vN;
      varying vec3 vView;
      float raw(vec2 q) {
        vec2 c = clamp(q, vec2(0.002), vec2(0.998));
        return mix(texture(uDepthPrev, c).r, texture(uDepth, c).r, uDepthMix);
      }
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
        vN = normalize(normalMatrix * n);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vView = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uPhoto;
      uniform float uFeather;
      uniform float uCurlRadius;
      uniform float uCurlShadow;
      uniform float uDevelop;
      uniform float uSheenOn;
      uniform float uTime;
      uniform float uShine;
      uniform vec3 uHaze;
      uniform vec3 uSheenCol;
      varying vec2 vUv;
      varying float vKeep;
      varying float vSide;
      varying vec3 vN;
      varying vec3 vView;
      ${contentsFn}
      void main() {
        vec4 contents = frameContents(vUv);
        vec3 col = contents.rgb;
        if (uDevelop < 0.999) {
          // Develop: a soft, warm, lifted haze that resolves into the photo.
          float b = (1.0 - uDevelop) * 0.012;
          vec3 soft = (frameContents(vUv + vec2(b, b)).rgb + frameContents(vUv + vec2(-b, b)).rgb
            + frameContents(vUv + vec2(b, -b)).rgb + frameContents(vUv + vec2(-b, -b)).rgb) * 0.25;
          col = mix(soft, col, smoothstep(0.35, 1.0, uDevelop));
          vec3 haze = mix(col * 0.55, uHaze, 0.6) + uHaze * 0.08;
          col = mix(haze, col, smoothstep(0.05, 1.0, uDevelop));
        }
        // Thinking: a glossy band sweeps across while depth is on its way.
        float s = (vUv.x + (1.0 - vUv.y)) * 0.5;
        float pos = fract(uTime / 1.6) * 1.7 - 0.35;
        col += uSheenCol * exp(-pow((s - pos) / 0.06, 2.0)) * 0.16 * uSheenOn;
        // Vinyl: a highlight where the bend turns toward the light.
        if (uShine > 0.001) {
          vec3 N = normalize(vN);
          vec3 H = normalize(normalize(vec3(-0.5, -0.25, 0.83)) + normalize(-vView));
          col += uSheenCol * pow(max(dot(N, H), 0.0), 90.0) * uShine * 0.32;
        }
        vec2 m = min(vUv, 1.0 - vUv);
        float edge = smoothstep(0.0, max(uFeather, 1e-4), min(m.x, m.y));
        float a = contents.a * edge * vKeep * smoothstep(0.0, 0.25, uDevelop);
        if (a < 0.08) discard;
        float shade = 1.0;
        if (vSide < 0.0 && uCurlShadow > 0.001 && uCurlRadius > 0.001) {
          float band = max(0.025, uCurlRadius * 2.0);
          float t = clamp(-vSide / band, 0.0, 1.0);
          shade = 1.0 - (1.0 - t) * (1.0 - t) * 0.55 * clamp(uCurlShadow, 0.0, 1.0);
        }
        gl_FragColor = vec4(col * shade, a);
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

/**
 * Upload a depth map (already softened by the worker that made it). With
 * `crossfade` the old map stays bound as uDepthPrev and setDepthMix fades
 * between them, so a better depth reshapes the relief instead of snapping.
 */
export function applyDepth(mat: ShaderMaterial, field: DepthField, crossfade = false): void {
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
  const u = mat.uniforms
  const current = u.uDepth.value as Texture
  const prev = u.uDepthPrev.value as Texture
  if (crossfade && u.uHasDepth.value > 0.5) {
    if (prev !== current) prev.dispose()
    u.uDepthPrev.value = current
    u.uDepthMix.value = 0
  } else {
    if (prev !== current) prev.dispose()
    current.dispose()
    u.uDepthPrev.value = tex
    u.uDepthMix.value = 1
  }
  u.uDepth.value = tex
  ;(u.uTexel.value as Vector2).set(1 / field.width, 1 / field.height)
  u.uHasDepth.value = 1
}

/** 0 shows the previous depth, 1 the newest. At 1 the previous map is released. */
export function setDepthMix(mat: ShaderMaterial, mix: number): void {
  const u = mat.uniforms
  u.uDepthMix.value = mix
  if (mix < 1) return
  const prev = u.uDepthPrev.value as Texture
  const current = u.uDepth.value as Texture
  if (prev === current) return
  prev.dispose()
  u.uDepthPrev.value = current
}

/** Develop progress (0 haze, 1 photo), the thinking sweep's strength, and its clock. */
export function setDevelop(mat: ShaderMaterial, develop: number, sheen: number, time: number): void {
  mat.uniforms.uDevelop.value = develop
  mat.uniforms.uSheenOn.value = sheen
  mat.uniforms.uTime.value = time
}

export function setShine(mat: ShaderMaterial, shine: number): void {
  mat.uniforms.uShine.value = shine
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
