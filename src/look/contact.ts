import { CustomBlending, Mesh, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, ShaderMaterial, Vector2, Vector3 } from '@iwsdk/core'
import type { Effect } from './effects.js'
import type { Palette } from './palette.js'

/** How far the shadow reaches past the sticker on each side, metres. */
const SHADOW_REACH = 0.07

/**
 * A soft, warm shadow just behind a sticker on a surface: a rounded rectangle
 * that fades out over a few centimetres, a little lower than the sticker, as if lit from above.
 */
export function makeContactShadow(width: number, height: number, palette: Palette): Mesh {
  const size = new Vector2(width + SHADOW_REACH * 2, height + SHADOW_REACH * 2)
  const mat = new ShaderMaterial({
    uniforms: {
      uHalf: { value: new Vector2(width * 0.51, height * 0.51) },
      uSize: { value: size },
      uCol: { value: new Vector3(...palette.shadow) },
      uOpacity: { value: 0.3 },
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
      uniform vec3 uCol;
      uniform float uOpacity;
      varying vec2 vL;
      void main() {
        vec2 q = abs(vL) - uHalf + 0.012;
        float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.012;
        float a = (1.0 - smoothstep(-0.012, 0.045, sd)) * uOpacity;
        gl_FragColor = vec4(uCol, a);
      }`,
    transparent: true,
    depthWrite: false,
  })
  const mesh = new Mesh(new PlaneGeometry(1, 1), mat)
  mesh.scale.set(size.x, size.y, 1)
  mesh.name = 'contact-shadow'
  mesh.position.set(0, -0.012, -0.0105)
  mesh.renderOrder = 3
  mesh.frustumCulled = false
  return mesh
}

/**
 * A ring of warm light that spreads across the surface where a sticker lands,
 * and fades as it goes. Attach it to the sticker; it removes itself.
 */
export function makeContactRing(width: number, height: number, palette: Palette, duration = 0.6): Effect {
  const reach = Math.max(width, height) * 1.6
  const mat = new ShaderMaterial({
    uniforms: {
      uK: { value: 0 },
      uR0: { value: Math.hypot(width, height) * 0.45 },
      uR1: { value: reach },
      uCol: { value: new Vector3(...palette.accent) },
      uCol2: { value: new Vector3(...palette.glow) },
      uSize: { value: reach * 2.2 },
    },
    vertexShader: /* glsl */ `
      uniform float uSize;
      varying vec2 vL;
      void main() {
        vL = position.xy * uSize;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uK;
      uniform float uR0;
      uniform float uR1;
      uniform vec3 uCol;
      uniform vec3 uCol2;
      varying vec2 vL;
      void main() {
        float r = length(vL);
        float e = 1.0 - pow(1.0 - uK, 3.0);
        float R = mix(uR0, uR1, e);
        float ring = exp(-pow((r - R) / 0.014, 2.0));
        float fill = exp(-pow(r / (R * 0.85), 2.0)) * 0.1;
        vec3 col = mix(uCol, uCol2, e) * (ring + fill) * pow(1.0 - uK, 1.6);
        gl_FragColor = vec4(col, 0.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  })
  const mesh = new Mesh(new PlaneGeometry(1, 1), mat)
  const size = reach * 2.2
  mesh.scale.set(size, size, 1)
  mesh.position.z = -0.011
  mesh.renderOrder = 4
  mesh.frustumCulled = false
  let age = 0
  return {
    kind: 'ring',
    group: mesh,
    step(dt: number): boolean {
      age += dt
      const k = Math.min(1, age / Math.max(0.05, duration))
      mat.uniforms.uK.value = k
      return k >= 1
    },
    dispose(): void {
      mesh.removeFromParent()
      mesh.geometry.dispose()
      mat.dispose()
    },
  }
}
