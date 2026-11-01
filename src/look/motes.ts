import {
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  Group,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Points,
  ShaderMaterial,
} from '@iwsdk/core'
import type { Palette } from './palette.js'

const COUNT = 140

interface Mote {
  x: number
  y: number
  vx: number
  vy: number
  vz: number
  delay: number
  life: number
  phase: number
}

/** The empty frame, let go as warm dust that drifts up and twinkles out, like dust in sunlight. */
export interface MotesRig {
  group: Group
  points: Points
  motes: Mote[]
  age: number
  /** Seconds until the last mote is gone. */
  span: number
}

/** Motes start along the frame's edge in its local XY. Size is in metres; the shader scales by distance. */
export function makeMotes(halfW: number, halfH: number, palette: Palette, pixelScale: number): MotesRig {
  const positions = new Float32Array(COUNT * 3)
  const alpha = new Float32Array(COUNT)
  const size = new Float32Array(COUNT)
  const color = new Float32Array(COUNT * 3)
  const motes: Mote[] = []
  const perimeter = 4 * (halfW + halfH)
  let span = 0
  for (let i = 0; i < COUNT; i++) {
    let d = Math.random() * perimeter
    let x: number
    let y: number
    if (d < 2 * halfW) {
      x = -halfW + d
      y = halfH
    } else if ((d -= 2 * halfW) < 2 * halfH) {
      x = halfW
      y = halfH - d
    } else if ((d -= 2 * halfH) < 2 * halfW) {
      x = halfW - d
      y = -halfH
    } else {
      d -= 2 * halfW
      x = -halfW
      y = -halfH + d
    }
    const len = Math.hypot(x, y) || 1
    const mote: Mote = {
      x,
      y,
      vx: (x / len) * (0.015 + 0.04 * Math.random()),
      vy: (y / len) * (0.015 + 0.04 * Math.random()) + 0.03 + 0.05 * Math.random(),
      vz: 0.01 + 0.03 * Math.random(),
      delay: Math.random() * 0.25,
      life: 0.9 + Math.random() * 0.7,
      phase: Math.random() * Math.PI * 2,
    }
    span = Math.max(span, mote.delay + mote.life)
    motes.push(mote)
    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = 0.004
    size[i] = 0.004 + Math.random() * 0.006
    const k = Math.random()
    color[i * 3] = palette.glow[0] + (palette.mote[0] - palette.glow[0]) * k
    color[i * 3 + 1] = palette.glow[1] + (palette.mote[1] - palette.glow[1]) * k
    color[i * 3 + 2] = palette.glow[2] + (palette.mote[2] - palette.glow[2]) * k
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('aAlpha', new BufferAttribute(alpha, 1))
  geometry.setAttribute('aSize', new BufferAttribute(size, 1))
  geometry.setAttribute('aColor', new BufferAttribute(color, 3))
  const mat = new ShaderMaterial({
    uniforms: { uScale: { value: pixelScale } },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      attribute float aSize;
      attribute vec3 aColor;
      uniform float uScale;
      varying float vA;
      varying vec3 vC;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(1.0, aSize * uScale / -mv.z);
        vA = aAlpha;
        vC = aColor;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      varying vec3 vC;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c) * 2.0;
        float f = exp(-r * r * 3.5) * (1.0 - smoothstep(0.75, 1.0, r));
        gl_FragColor = vec4(vC * f * vA * 1.5, 0.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  })
  const points = new Points(geometry, mat)
  points.frustumCulled = false
  points.renderOrder = 6
  const group = new Group()
  group.name = 'frame-motes'
  group.add(points)
  return { group, points, motes, age: 0, span }
}

/** Advance the drift. True once every mote has faded. */
export function stepMotes(rig: MotesRig, dt: number): boolean {
  rig.age += dt
  const geometry = rig.points.geometry
  const positions = geometry.attributes.position.array as Float32Array
  const alpha = geometry.attributes.aAlpha.array as Float32Array
  for (let i = 0; i < rig.motes.length; i++) {
    const m = rig.motes[i]
    const a = rig.age - m.delay
    const o = i * 3
    if (a <= 0) {
      alpha[i] = 0
      continue
    }
    positions[o] = m.x + m.vx * a + 0.006 * Math.sin(a * 3 + m.phase)
    positions[o + 1] = m.y + m.vy * a + 0.015 * a * a
    positions[o + 2] = 0.004 + m.vz * a
    const rise = a < 0.12 ? (a / 0.12) * (a / 0.12) * (3 - 2 * (a / 0.12)) : 1
    const t = a / m.life
    const fade = t >= 1 ? 0 : 1 - t * t * (3 - 2 * t)
    alpha[i] = rise * fade * (0.62 + 0.38 * Math.sin(a * 14 + m.phase))
  }
  geometry.attributes.position.needsUpdate = true
  geometry.attributes.aAlpha.needsUpdate = true
  return rig.age >= rig.span
}

export function disposeMotes(rig: MotesRig): void {
  rig.points.geometry.dispose()
  ;(rig.points.material as ShaderMaterial).dispose()
  rig.group.removeFromParent()
}
