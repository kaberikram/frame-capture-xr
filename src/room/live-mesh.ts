import { BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, ShaderMaterial, Vector3 } from '@iwsdk/core'
import type { Palette } from '../look/palette.js'
import { GHOST_JOINTS } from '../look/room-glow.js'
import type { NetMesh, RoomField } from './field.js'

/** Milliseconds a frame may spend re-meshing. */
const BUDGET_MS = 2.5
/** The mesh shows this far around what has your attention, metres. */
export const MESH_REACH = 0.36

/**
 * The live mesh of the room, shown: a fine grid of light lying on the real
 * surfaces around whatever has your attention, re-meshed a few chunks a frame
 * as depth comes in. It is the same field a pinch lifts from, so what you see
 * forming is what you can pull.
 */
export class LiveMesh {
  readonly group = new Group()
  private readonly mat: ShaderMaterial
  private readonly meshes = new Map<string, Mesh>()
  private level = 0

  constructor(palette: Palette) {
    this.group.name = 'room-live-mesh'
    this.mat = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLevel: { value: 0 },
        uFocus: { value: new Vector3() },
        uReach: { value: MESH_REACH },
        uCore: { value: new Vector3(...palette.core) },
        uGlow: { value: new Vector3(...palette.glow) },
        uJoints: { value: Array.from({ length: GHOST_JOINTS }, () => new Vector3()) },
        uJointCount: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute float aBorn;
        varying vec3 vWorld;
        varying float vBorn;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          vBorn = aBorn;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uLevel, uReach;
        uniform vec3 uFocus, uCore, uGlow;
        uniform vec3 uJoints[${GHOST_JOINTS}];
        uniform int uJointCount;
        varying vec3 vWorld;
        varying float vBorn;
        const float CELL = 0.04;
        void main() {
          float away = length(vWorld - uFocus);
          float near = 1.0 - smoothstep(uReach * 0.45, uReach, away);
          if (near * uLevel < 0.01) discard;
          // Behind your hand, as seen from the eye, the mesh gives way to the hand.
          vec3 ray = vWorld - cameraPosition;
          float far = length(ray);
          ray /= max(far, 1e-4);
          float clear = 1.0;
          for (int i = 0; i < ${GHOST_JOINTS}; i++) {
            if (i >= uJointCount) break;
            vec3 j = uJoints[i] - cameraPosition;
            float along = dot(j, ray);
            if (along > far + 0.01) continue;
            clear = min(clear, smoothstep(0.018, 0.04, length(j - ray * along)));
          }
          // Grid lines every few centimetres, in the room's own axes, so they lie still on the surface.
          vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
          vec3 g = vWorld / CELL;
          vec3 d = abs(fract(g - 0.5) - 0.5) / max(fwidth(g), 1e-5);
          vec3 lines = (1.0 - smoothstep(0.6, 1.6, d)) * (1.0 - abs(n) * abs(n));
          float line = max(lines.x, max(lines.y, lines.z));
          // A chunk forms: it comes up bright, then settles.
          float age = uTime - vBorn;
          float form = smoothstep(0.0, 0.25, age);
          float fresh = exp(-age / 0.6);
          // A slow ripple running out from where you are attending.
          float ripple = exp(-pow((away - fract(uTime * 0.35) * uReach) / 0.05, 2.0));
          float a = (line * (0.34 + 0.4 * fresh + 0.25 * ripple) + 0.035 + 0.1 * fresh) * near * form * uLevel * clear;
          if (a < 0.012) discard;
          gl_FragColor = vec4(mix(uGlow, uCore, 0.35 + 0.65 * line), a);
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: DoubleSide,
      toneMapped: false,
    })
  }

  get chunkCount(): number {
    return this.meshes.size
  }

  /**
   * Re-mesh what has changed near `focus`, and draw. `on` is whether anything
   * has your attention. `joints` are the hand's, for hiding behind.
   */
  step(dt: number, time: number, field: RoomField, focus: Vector3, on: boolean, joints: readonly Vector3[], jointCount: number, still: boolean): void {
    const goal = on ? 1 : 0
    this.level += (goal - this.level) * (still ? 1 : Math.min(1, dt * (goal > this.level ? 4 : 1.2)))
    const u = this.mat.uniforms
    u.uTime.value = time
    u.uLevel.value = this.level
    this.group.visible = this.level > 0.01
    if (on) {
      // The pool of mesh glides to where your attention goes.
      u.uFocus.value.lerp(focus, still ? 1 : Math.min(1, dt * 6))
      const built = field.netStale(BUDGET_MS, focus, MESH_REACH)
      for (let i = 0; i < built.length; i++) this.put(built[i], time)
    }
    const hide = Math.min(GHOST_JOINTS, Math.ceil(jointCount / 2))
    for (let i = 0; i < hide; i++) u.uJoints.value[i].copy(joints[i * 2])
    u.uJointCount.value = hide
  }

  /** Chunks the field has let go of. */
  drop(keys: readonly string[]): void {
    for (let i = 0; i < keys.length; i++) this.remove(keys[i])
  }

  clear(): void {
    for (const key of [...this.meshes.keys()]) this.remove(key)
    this.level = 0
  }

  dispose(): void {
    this.clear()
    this.group.removeFromParent()
    this.mat.dispose()
  }

  private put(net: NetMesh, time: number): void {
    let mesh = this.meshes.get(net.key)
    if (net.indices.length === 0) {
      if (mesh) this.remove(net.key)
      return
    }
    if (!mesh) {
      mesh = new Mesh(new BufferGeometry(), this.mat)
      mesh.name = 'room-live-chunk'
      mesh.frustumCulled = false
      mesh.renderOrder = 1
      mesh.userData.born = time
      this.group.add(mesh)
      this.meshes.set(net.key, mesh)
    }
    const geo = mesh.geometry
    geo.setAttribute('position', new BufferAttribute(net.positions, 3))
    geo.setAttribute('aBorn', new BufferAttribute(new Float32Array(net.positions.length / 3).fill(mesh.userData.born as number), 1))
    geo.setIndex(new BufferAttribute(net.indices, 1))
  }

  private remove(key: string): void {
    const mesh = this.meshes.get(key)
    if (!mesh) return
    this.meshes.delete(key)
    mesh.removeFromParent()
    mesh.geometry.dispose()
  }
}
