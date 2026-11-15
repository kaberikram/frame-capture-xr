import { BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, ShaderMaterial, Vector3 } from '@iwsdk/core'
import type { Palette } from '../look/palette.js'
import { GHOST_JOINTS } from '../look/room-glow.js'
import type { NetMesh, RoomField } from './field.js'
import { SQUARE_CORNER } from './object.js'

/** Milliseconds a frame may spend re-meshing. */
const BUDGET_MS = 3

/**
 * The live mesh of the room, shown: one connected skin over everything the
 * headset has seen, a few metres out, with a square grid drawn on it. It is
 * re-meshed a few chunks a frame as depth comes in, nearest your attention
 * first.
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
        uReach: { value: 0.1 },
        uCore: { value: new Vector3(...palette.core) },
        uGlow: { value: new Vector3(...palette.glow) },
        uRim: { value: new Vector3(1, 0.72, 0.38) },
        /** The two directions across the surface that the square's sides run along. */
        uAcross: { value: new Vector3(1, 0, 0) },
        uUp: { value: new Vector3(0, 1, 0) },
        uJoints: { value: Array.from({ length: GHOST_JOINTS }, () => new Vector3()) },
        uJointCount: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute float aBorn;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vBorn;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          vBorn = aBorn;
          vNormal = normal;
          // Drawn a touch nearer along the line of sight: the same place on screen, but in front of
          // the desk's stand-in wall it lies on, which would otherwise hide it.
          vec4 mv = viewMatrix * world;
          mv.xyz *= 0.985;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uLevel, uReach;
        uniform vec3 uFocus, uCore, uGlow, uRim, uAcross, uUp;
        uniform vec3 uJoints[${GHOST_JOINTS}];
        uniform int uJointCount;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vBorn;
        const float CELL = 0.12;
        void main() {
          // The torch's lit area: a rounded square across the surface, as deep as it is wide.
          vec3 off = vWorld - uFocus;
          float corner = uReach * ${SQUARE_CORNER.toFixed(2)};
          vec2 q = abs(vec2(dot(off, uAcross), dot(off, uUp))) - (uReach - corner);
          float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - corner;
          float near = (1.0 - smoothstep(-0.006, 0.0, sd)) * (1.0 - smoothstep(uReach * 1.6, uReach * 2.0, length(off)));
          if (near * uLevel < 0.01) discard;
          // Its rim, drawn on the surface itself.
          float rim = exp(-pow((sd + 0.012) / 0.006, 2.0));
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
          // One square grid per surface, laid across whichever of the room's axes it faces most,
          // so the lines on a wall or a table all run the same two ways.
          vec3 n = normalize(vNormal);
          vec3 w = pow(abs(n), vec3(8.0));
          w /= w.x + w.y + w.z;
          vec3 g = vWorld / CELL;
          vec3 d = abs(fract(g - 0.5) - 0.5) / max(fwidth(g), 1e-5);
          vec3 on = 1.0 - smoothstep(0.7, 1.7, d);
          float line = w.x * max(on.y, on.z) + w.y * max(on.x, on.z) + w.z * max(on.x, on.y);
          // A chunk forms: it comes up bright, then settles.
          float age = uTime - vBorn;
          float form = smoothstep(0.0, 0.25, age);
          float fresh = exp(-age / 0.6);
          // A slow ripple running out from where you are attending.
          float a = (max(line * (0.5 + 0.3 * fresh), rim * 0.95) + 0.16 + 0.1 * fresh) * near * form * uLevel * clear;
          if (a < 0.012) discard;
          gl_FragColor = vec4(mix(mix(uGlow, uCore, 0.35 + 0.65 * line), uRim, rim), a);
        }`,
      transparent: true,
      // It hides its own far side, so a table does not show through the thing standing on it.
      depthWrite: true,
      depthTest: true,
      side: DoubleSide,
      toneMapped: false,
    })
  }

  get chunkCount(): number {
    return this.meshes.size
  }

  /**
   * Light the mesh inside a rounded square: `centre`, half-width `radius`, and
   * the two directions its sides run along, while `on`. Only the chunks it
   * touches are re-meshed. `joints` are the hand's, for hiding behind.
   */
  step(dt: number, time: number, field: RoomField, centre: Vector3, radius: number, across: Vector3, up: Vector3, on: boolean, joints: readonly Vector3[], jointCount: number, still: boolean): void {
    const goal = on ? 1 : 0
    this.level += (goal - this.level) * (still ? 1 : Math.min(1, dt * (goal > this.level ? 10 : 6)))
    const u = this.mat.uniforms
    u.uTime.value = time
    u.uLevel.value = this.level
    this.group.visible = this.level > 0.01
    if (on) {
      // The circle glides with the hand; it does not jump.
      const fresh = this.level < 0.05 || still
      u.uFocus.value.lerp(centre, fresh ? 1 : Math.min(1, dt * 16))
      u.uReach.value += (radius - u.uReach.value) * (fresh ? 1 : Math.min(1, dt * 10))
      u.uAcross.value.lerp(across, fresh ? 1 : Math.min(1, dt * 10)).normalize()
      u.uUp.value.lerp(up, fresh ? 1 : Math.min(1, dt * 10)).normalize()
      const built = field.netStale(BUDGET_MS, centre, radius * 1.42 + 0.3)
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
    geo.computeVertexNormals()
  }

  private remove(key: string): void {
    const mesh = this.meshes.get(key)
    if (!mesh) return
    this.meshes.delete(key)
    mesh.removeFromParent()
    mesh.geometry.dispose()
  }
}
