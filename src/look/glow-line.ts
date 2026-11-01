import { CustomBlending, Mesh, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, ShaderMaterial, Vector2, Vector3 } from '@iwsdk/core'
import type { Palette } from './palette.js'

/** How far the glow reaches past the line, in metres. The quad is this much larger on every side. */
const MARGIN = 0.06

/**
 * A rectangle of light: a crisp core line with a soft falloff and a slow
 * shimmer travelling around it. One shader for the frame being drawn, a
 * captured frame's border, and the outline where a sticker will land.
 * Colours are sRGB and blend premultiplied: the core covers, the glow adds.
 */
export interface GlowLine {
  mesh: Mesh
  mat: ShaderMaterial
}

export interface GlowState {
  halfW: number
  halfH: number
  /** Core line width, metres. */
  core: number
  /** 0..~2 strength of the falloff. */
  glow: number
  /** 0..1 wash inside the rectangle. */
  tint: number
  opacity: number
  /** Seconds, drives the shimmer. */
  time: number
}

export function makeGlowLine(palette: Palette, renderOrder = 5): GlowLine {
  const mat = new ShaderMaterial({
    uniforms: {
      uHalf: { value: new Vector2(0.1, 0.1) },
      uSize: { value: new Vector2(1, 1) },
      uCore: { value: 0.006 },
      uGlowW: { value: 0.012 },
      uGlow: { value: 1 },
      uTint: { value: 0 },
      uOpacity: { value: 1 },
      uTime: { value: 0 },
      uCoreCol: { value: new Vector3(...palette.core) },
      uGlowCol: { value: new Vector3(...palette.glow) },
      uTintCol: { value: new Vector3(...palette.tint) },
    },
    vertexShader: /* glsl */ `
      uniform vec2 uSize;
      varying vec2 vL;
      void main() {
        vL = position.xy * uSize;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec2 uHalf;
      uniform float uCore;
      uniform float uGlowW;
      uniform float uGlow;
      uniform float uTint;
      uniform float uOpacity;
      uniform float uTime;
      uniform vec3 uCoreCol;
      uniform vec3 uGlowCol;
      uniform vec3 uTintCol;
      varying vec2 vL;
      void main() {
        vec2 q = abs(vL) - uHalf;
        float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
        float d = abs(sd);
        float aa = max(fwidth(d), 0.0006);
        float core = 1.0 - smoothstep(uCore * 0.5 - aa, uCore * 0.5 + aa, d);
        float around = atan(vL.y / max(uHalf.y, 1e-3), vL.x / max(uHalf.x, 1e-3));
        float shimmer = 0.74 + 0.26 * sin(around * 2.0 - uTime * 1.7) * sin(around * 5.0 + uTime * 0.9);
        float glow = exp(-d / uGlowW) * uGlow * shimmer;
        float corner = exp(-length(abs(vL) - uHalf) / 0.01) * 0.55 * uGlow;
        vec3 col = uCoreCol * core * 0.96 + uGlowCol * (glow * 0.85 + corner);
        if (sd < 0.0) col += uTintCol * uTint;
        gl_FragColor = vec4(col, core * 0.94) * uOpacity;
      }`,
    transparent: true,
    depthWrite: false,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  })
  const mesh = new Mesh(new PlaneGeometry(1, 1), mat)
  mesh.frustumCulled = false
  mesh.renderOrder = renderOrder
  return { mesh, mat }
}

/** Size the quad to the rectangle plus the glow margin and push the look into the shader. */
export function setGlowLine(line: GlowLine, s: GlowState): void {
  const w = s.halfW * 2 + MARGIN * 2
  const h = s.halfH * 2 + MARGIN * 2
  line.mesh.scale.set(w, h, 1)
  const u = line.mat.uniforms
  ;(u.uHalf.value as Vector2).set(s.halfW, s.halfH)
  ;(u.uSize.value as Vector2).set(w, h)
  u.uCore.value = s.core
  u.uGlow.value = s.glow
  u.uTint.value = s.tint
  u.uOpacity.value = s.opacity
  u.uTime.value = s.time
  line.mesh.visible = s.opacity > 0.002
}

export function disposeGlowLine(line: GlowLine): void {
  line.mesh.geometry.dispose()
  line.mat.dispose()
  line.mesh.removeFromParent()
}
