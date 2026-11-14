import { BufferAttribute, BufferGeometry, NormalBlending, Points, ShaderMaterial, Vector3 } from '@iwsdk/core'
import type { Palette } from './palette.js'

/** Motes kept. The oldest are written over. */
const COUNT = 4096
/** Seconds a mote lives. */
const LIFE = 1.7

/**
 * The room's depth, seen as it is read: each reading is a mote of light that
 * drifts in from a little in front of the surface, settles on it, and fades.
 * Where you look, the shape of things forms out of them. Drawn with real
 * opacity, because faint added light does not show over passthrough.
 */
export class DepthMotes {
  readonly points: Points
  private readonly mat: ShaderMaterial
  private readonly position: BufferAttribute
  private readonly toward: BufferAttribute
  private readonly born: BufferAttribute
  private next = 0
  private dirty = false

  constructor(palette: Palette) {
    const geo = new BufferGeometry()
    this.position = new BufferAttribute(new Float32Array(COUNT * 3), 3)
    this.toward = new BufferAttribute(new Float32Array(COUNT * 3), 3)
    this.born = new BufferAttribute(new Float32Array(COUNT).fill(-100), 1)
    geo.setAttribute('position', this.position)
    geo.setAttribute('aToward', this.toward)
    geo.setAttribute('aBorn', this.born)
    this.mat = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        /** Pixels a metre covers at one metre away. */
        uScale: { value: 760 },
        uStill: { value: 0 },
        uCore: { value: new Vector3(...palette.core) },
        uGlow: { value: new Vector3(...palette.glow) },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aToward;
        attribute float aBorn;
        uniform float uTime, uScale, uStill;
        varying float vAge;
        varying float vSeed;
        void main() {
          float age = (uTime - aBorn) / ${LIFE.toFixed(2)};
          vAge = age;
          vSeed = fract(sin(dot(position.xy + position.z, vec2(12.9898, 78.233))) * 43758.5453);
          // It drifts in from in front of the surface and settles onto it.
          float settle = 1.0 - clamp(age / 0.3, 0.0, 1.0);
          settle = settle * settle * (1.0 - uStill);
          vec3 p = position + aToward * (0.012 + 0.07 * settle * (0.4 + 0.6 * vSeed));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float size = 0.0055 * (0.6 + 0.8 * vSeed) * (1.0 + 1.2 * settle);
          gl_PointSize = age < 0.0 || age > 1.0 ? 0.0 : clamp(size * uScale / max(0.2, -mv.z), 1.5, 14.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uCore, uGlow;
        uniform float uTime;
        varying float vAge;
        varying float vSeed;
        void main() {
          if (vAge < 0.0 || vAge > 1.0) discard;
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float dot_ = 1.0 - smoothstep(0.35, 1.0, r);
          float fade = smoothstep(0.0, 0.12, vAge) * (1.0 - smoothstep(0.45, 1.0, vAge));
          float twinkle = 0.75 + 0.25 * sin(uTime * 5.0 + vSeed * 40.0);
          float a = dot_ * fade * twinkle * 0.7;
          if (a < 0.02) discard;
          gl_FragColor = vec4(mix(uGlow, uCore, 0.35 + 0.65 * (1.0 - r)), a);
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: NormalBlending,
      toneMapped: false,
    })
    this.points = new Points(geo, this.mat)
    this.points.name = 'room-depth-motes'
    this.points.frustumCulled = false
    this.points.renderOrder = 2
  }

  /** A depth reading at a point in the room, seen from `eye`. */
  add(x: number, y: number, z: number, eye: { x: number; y: number; z: number }, time: number): void {
    const i = this.next
    this.next = (i + 1) % COUNT
    let dx = eye.x - x
    let dy = eye.y - y
    let dz = eye.z - z
    const l = Math.hypot(dx, dy, dz) || 1
    dx /= l
    dy /= l
    dz /= l
    this.position.setXYZ(i, x, y, z)
    this.toward.setXYZ(i, dx, dy, dz)
    this.born.setX(i, time)
    this.dirty = true
  }

  clear(): void {
    ;(this.born.array as Float32Array).fill(-100)
    this.dirty = true
  }

  step(time: number, pixelScale: number, still: boolean): void {
    this.mat.uniforms.uTime.value = time
    this.mat.uniforms.uScale.value = pixelScale
    this.mat.uniforms.uStill.value = still ? 1 : 0
    if (!this.dirty) return
    this.dirty = false
    this.position.needsUpdate = true
    this.toward.needsUpdate = true
    this.born.needsUpdate = true
  }

  dispose(): void {
    this.points.removeFromParent()
    this.points.geometry.dispose()
    this.mat.dispose()
  }
}
