import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  DoubleSide,
  Group,
  LinearFilter,
  Matrix3,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Quaternion,
  Raycaster,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type Object3D,
  type PerspectiveCamera,
  type WebGLRenderer,
} from '@iwsdk/core'
import { PALETTE } from '../look/palette.js'
import { transformPoint, viewFromDepthPixel } from './depth-project.js'
import { RoomField, type DepthSample, type RoomHit } from './field.js'
import {
  PATCH_N,
  STICK_GAP,
  TOUCH_GAP,
  curlOffset,
  flatPoint,
  shouldStick,
  tangentBasis,
} from './patch.js'

const FUSE_EVERY = 0.22
const EXTRACT_BUDGET = 2
/** Samples fused on one frame. The rest of a depth image waits, so the frame stays smooth. */
const SAMPLE_BUDGET = 80

interface DepthView {
  transform: { matrix: ArrayLike<number> }
}

interface CpuDepth {
  width: number
  height: number
  getDepthInMeters(x: number, y: number): number
  normDepthBufferFromNormView: { inverse: { matrix: ArrayLike<number> } }
}

interface DepthFrame {
  getViewerPose?: (space: XRReferenceSpace) => { views: DepthView[] } | undefined
  getDepthInformation?: (view: DepthView) => CpuDepth | undefined
}

interface Sheet {
  mesh: Mesh
  void: Mesh | null
  source: Vector3
  normal: Vector3
  tangent: Vector3
  bitangent: Vector3
  curl: number
  carved: boolean
  stuck: boolean
}

/**
 * Builds a light mesh from depth and peels camera-coloured sheets off it.
 * Fusion runs on the CPU because Quest Browser's WebGL has no compute shaders.
 * The shimmer is a shader. `RoomField.snapshot` is the hook a ghost replay would use.
 */
export class RoomScan {
  readonly group = new Group()
  active = false
  holding = false
  /** Set once when a headset session has no depth-sensing. */
  depthNote: string | null = null
  /** The current camera frame, copied onto a sheet when one is peeled. */
  liveVideo: HTMLVideoElement | null = null
  private readonly field = new RoomField()
  private readonly shimmer: ShaderMaterial
  private readonly meshes = new Map<string, Mesh>()
  private readonly sheets: Sheet[] = []
  private held: Sheet | null = null
  private fuseIn = 0
  private queue: DepthSample[] = []
  private queueAt = 0
  private queueFresh = false
  private readonly raycaster = new Raycaster()
  private readonly ndc = new Vector2()
  private readonly up = new Vector3(0, 0, 1)
  private readonly scratch = new Vector3()
  private readonly toLocal = new Matrix3()
  private depthMiss = 0

  constructor(parent: Object3D, renderer: WebGLRenderer) {
    this.group.name = 'room-scan'
    parent.add(this.group)
    this.shimmer = shimmerMaterial()
    const scene = new Scene()
    const warm = new Mesh(triangleWarmup(), this.shimmer)
    scene.add(warm)
    const cam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
    cam.position.z = 1
    renderer.compile(scene, cam)
    warm.geometry.dispose()
  }

  get chunkCount(): number {
    return this.field.chunkCount
  }

  get patchCount(): number {
    return this.sheets.length
  }

  setActive(on: boolean): void {
    if (!on && this.holding) this.end()
    this.active = on
    for (const mesh of this.meshes.values()) mesh.visible = on
    this.group.visible = on || this.sheets.length > 0
  }

  /** First reconstructed surface along a ray, used by the desk pointer. */
  ray(origin: Vector3, dir: Vector3): RoomHit | null {
    if (!this.active || this.holding) return null
    return this.field.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, 3.6, 0.1)
  }

  /** A pinch already touching the reconstructed surface. */
  touch(point: Vector3): RoomHit | null {
    if (!this.active || this.holding) return null
    return this.field.closest(point.x, point.y, point.z, TOUCH_GAP)
  }

  begin(hit: RoomHit, video: HTMLVideoElement | null, view: Vector3 | null = null): void {
    if (!this.active || this.holding) return
    const normal = new Vector3(hit.nx, hit.ny, hit.nz)
    if (normal.lengthSq() < 1e-6) normal.set(0, 1, 0)
    normal.normalize()
    if (view) {
      const toward =
        (view.x - hit.x) * normal.x + (view.y - hit.y) * normal.y + (view.z - hit.z) * normal.z
      if (toward < 0) normal.negate()
    }
    const basis = tangentBasis(normal.x, normal.y, normal.z)
    const sheet = this.makeSheet(hit, normal, basis, video ?? this.liveVideo)
    this.held = sheet
    this.holding = true
    this.sheets.push(sheet)
    this.place(sheet, 0, new Vector3(hit.x, hit.y, hit.z))
  }

  /** The pinch moved. Pulling off the surface curls the sheet, then it follows the hand. */
  drag(point: Vector3): void {
    const sheet = this.held
    if (!sheet) return
    const pull =
      (point.x - sheet.source.x) * sheet.normal.x +
      (point.y - sheet.source.y) * sheet.normal.y +
      (point.z - sheet.source.z) * sheet.normal.z
    const lift = pull > 0 ? pull : 0
    const curl = lift / 0.07
    sheet.curl = curl > 1 ? 1 : curl
    if (sheet.curl > 0.9 && !sheet.carved) this.openVoid(sheet)
    const follow = sheet.curl > 0.7 ? (sheet.curl - 0.7) / 0.3 : 0
    const center = new Vector3(
      sheet.source.x + sheet.normal.x * lift * (1 - follow) + (point.x - sheet.source.x) * follow,
      sheet.source.y + sheet.normal.y * lift * (1 - follow) + (point.y - sheet.source.y) * follow,
      sheet.source.z + sheet.normal.z * lift * (1 - follow) + (point.z - sheet.source.z) * follow,
    )
    this.place(sheet, sheet.curl, center)
  }

  end(): void {
    const sheet = this.held
    this.held = null
    this.holding = false
    if (!sheet) return
    if (sheet.curl < 0.35) {
      this.dropSheet(sheet)
      return
    }
    if (!sheet.carved) this.openVoid(sheet)
    const center = new Vector3()
    sheet.mesh.getWorldPosition(center)
    const origin = center.clone().addScaledVector(sheet.normal, 0.05)
    const hit =
      this.field.raycast(origin.x, origin.y, origin.z, -sheet.normal.x, -sheet.normal.y, -sheet.normal.z, 0.28, 0.06) ??
      this.field.raycast(center.x, center.y, center.z, sheet.normal.x, sheet.normal.y, sheet.normal.z, 0.28, 0.06)
    const source = { x: sheet.source.x, y: sheet.source.y, z: sheet.source.z }
    if (hit && shouldStick(source, hit, STICK_GAP)) {
      this.conform(sheet, hit)
      sheet.stuck = true
      sheet.curl = 0
      return
    }
    this.place(sheet, 0.12, center)
  }

  step(
    dt: number,
    presenting: boolean,
    frame: DepthFrame | null,
    camera: PerspectiveCamera,
    standIn: Object3D,
  ): void {
    this.shimmer.uniforms.uTime.value += dt
    if (!this.active) return
    this.fuseIn -= dt
    if (this.fuseIn <= 0 && this.queueAt >= this.queue.length) {
      this.fuseIn = FUSE_EVERY
      if (presenting) this.fuseHeadset(frame)
      else this.fuseDesk(camera, standIn)
    }
    if (this.queueAt < this.queue.length) {
      const end = Math.min(this.queue.length, this.queueAt + SAMPLE_BUDGET)
      this.field.integrateRange(this.queue, this.queueAt, end, this.queueFresh)
      this.queueFresh = false
      this.queueAt = end
    }
    const built = this.field.extract(EXTRACT_BUDGET, camera.position)
    const gone = this.field.takeRetired()
    for (let i = 0; i < gone.length; i++) this.hideChunk(gone[i])
    const now = this.shimmer.uniforms.uTime.value as number
    for (let i = 0; i < built.length; i++) this.showChunk(built[i].key, built[i].positions, built[i].normals, now)
  }

  dispose(): void {
    this.group.removeFromParent()
    this.shimmer.dispose()
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose()
    }
    for (let i = 0; i < this.sheets.length; i++) this.dropSheet(this.sheets[i])
  }

  private fuseDesk(camera: PerspectiveCamera, standIn: Object3D): void {
    camera.updateMatrixWorld()
    const origin = camera.position
    const samples: DepthSample[] = []
    const w = 24
    const h = 18
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        this.ndc.set(((x + 0.5) / w) * 2 - 1, 1 - ((y + 0.5) / h) * 2)
        this.raycaster.setFromCamera(this.ndc, camera)
        const hits = this.raycaster.intersectObject(standIn, true)
        const hit = hits[0]
        if (!hit || hit.distance < 0.25 || hit.distance > 3.4) continue
        samples.push({
          ox: origin.x,
          oy: origin.y,
          oz: origin.z,
          px: hit.point.x,
          py: hit.point.y,
          pz: hit.point.z,
        })
      }
    }
    camera.getWorldDirection(this.scratch)
    this.enqueue(samples, this.scratch)
  }

  private fuseHeadset(frame: DepthFrame | null): void {
    if (!frame?.getViewerPose || !frame.getDepthInformation) {
      this.noteMissing('No room depth in this browser')
      return
    }
    const space = rendererSpace()
    if (!space) return
    const pose = frame.getViewerPose(space)
    const view = pose?.views[0]
    if (!view) return
    const depth = frame.getDepthInformation(view)
    if (!depth || typeof depth.getDepthInMeters !== 'function') {
      this.noteMissing('No CPU room depth in this browser')
      return
    }
    this.depthMiss = 0
    this.depthNote = null
    const inverse = depth.normDepthBufferFromNormView.inverse.matrix
    const viewMatrix = view.transform.matrix
    const origin = transformPoint(viewMatrix, { x: 0, y: 0, z: 0 })
    const samples: DepthSample[] = []
    const stepX = Math.max(1, Math.floor(depth.width / 28))
    const stepY = Math.max(1, Math.floor(depth.height / 20))
    for (let y = 0; y < depth.height; y += stepY) {
      for (let x = 0; x < depth.width; x += stepX) {
        const meters = depth.getDepthInMeters(x, y)
        const local = viewFromDepthPixel(inverse, (x + 0.5) / depth.width, (y + 0.5) / depth.height, meters)
        if (!local) continue
        const world = transformPoint(viewMatrix, local)
        samples.push({ ox: origin.x, oy: origin.y, oz: origin.z, px: world.x, py: world.y, pz: world.z })
      }
    }
    const ahead = transformPoint(viewMatrix, { x: 0, y: 0, z: -1 })
    this.scratch.set(ahead.x - origin.x, ahead.y - origin.y, ahead.z - origin.z)
    this.enqueue(samples, this.scratch)
  }

  /** What you are looking at is fused first, so the chunk cap keeps the center of the view. */
  private enqueue(samples: DepthSample[], forward?: Vector3): void {
    if (forward && forward.lengthSq() > 1e-6) {
      const fx = forward.x
      const fy = forward.y
      const fz = forward.z
      samples.sort((a, b) => alignment(b, fx, fy, fz) - alignment(a, fx, fy, fz))
    }
    this.queue = samples
    this.queueAt = 0
    this.queueFresh = true
  }

  private noteMissing(message: string): void {
    this.depthMiss += 1
    if (this.depthMiss < 4 || this.depthNote === message) return
    this.depthNote = message
    console.info(`[frame] ${message}`)
  }

  private showChunk(key: string, positions: Float32Array, normals: Float32Array, now: number): void {
    let mesh = this.meshes.get(key)
    if (!mesh) {
      const geo = new BufferGeometry()
      mesh = new Mesh(geo, this.shimmer)
      mesh.frustumCulled = false
      mesh.renderOrder = 2
      mesh.name = 'room-chunk'
      mesh.userData.born = now
      this.group.add(mesh)
      this.meshes.set(key, mesh)
    }
    mesh.visible = this.active && positions.length > 0
    const count = positions.length / 3
    const bornAt = typeof mesh.userData.born === 'number' ? mesh.userData.born : now
    const born = new Float32Array(count)
    const bary = new Float32Array(count * 3)
    born.fill(bornAt)
    for (let i = 0; i < count; i++) bary[i * 3 + (i % 3)] = 1
    const local = this.toLocalPositions(positions)
    const localNormals = this.toLocalNormals(normals)
    this.setAttr(mesh.geometry, 'position', local, 3)
    this.setAttr(mesh.geometry, 'normal', localNormals, 3)
    this.setAttr(mesh.geometry, 'aBorn', born, 1)
    this.setAttr(mesh.geometry, 'aBary', bary, 3)
    mesh.geometry.computeBoundingSphere()
  }

  private hideChunk(key: string): void {
    const mesh = this.meshes.get(key)
    if (!mesh) return
    this.meshes.delete(key)
    mesh.removeFromParent()
    mesh.geometry.dispose()
  }

  private setAttr(geo: BufferGeometry, name: string, data: Float32Array, size: number): void {
    const prev = geo.getAttribute(name)
    if (prev && prev.itemSize === size && prev.array.length >= data.length) {
      ;(prev.array as Float32Array).set(data)
      prev.needsUpdate = true
      geo.setDrawRange(0, data.length / size)
      return
    }
    geo.setAttribute(name, new BufferAttribute(data, size))
    geo.setDrawRange(0, data.length / size)
  }

  private toLocalPositions(world: Float32Array): Float32Array {
    this.group.updateWorldMatrix(true, false)
    const out = new Float32Array(world.length)
    const p = new Vector3()
    for (let i = 0; i < world.length; i += 3) {
      p.set(world[i], world[i + 1], world[i + 2])
      this.group.worldToLocal(p)
      out[i] = p.x
      out[i + 1] = p.y
      out[i + 2] = p.z
    }
    return out
  }

  private toLocalNormals(world: Float32Array): Float32Array {
    this.group.updateWorldMatrix(true, false)
    this.toLocal.setFromMatrix4(this.group.matrixWorld).transpose()
    const out = new Float32Array(world.length)
    const n = new Vector3()
    for (let i = 0; i < world.length; i += 3) {
      n.set(world[i], world[i + 1], world[i + 2]).applyMatrix3(this.toLocal)
      out[i] = n.x
      out[i + 1] = n.y
      out[i + 2] = n.z
    }
    return out
  }

  private makeSheet(
    hit: RoomHit,
    normal: Vector3,
    basis: ReturnType<typeof tangentBasis>,
    video: HTMLVideoElement | null,
  ): Sheet {
    const geo = sheetGeometry()
    const map = decalTexture(video, normal.y)
    const mesh = new Mesh(
      geo,
      new MeshBasicMaterial({
        map,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      }),
    )
    mesh.name = 'room-sheet'
    mesh.renderOrder = 6
    mesh.frustumCulled = false
    this.group.add(mesh)
    return {
      mesh,
      void: null,
      source: new Vector3(hit.x, hit.y, hit.z),
      normal,
      tangent: new Vector3(basis.tx, basis.ty, basis.tz),
      bitangent: new Vector3(basis.bx, basis.by, basis.bz),
      curl: 0,
      carved: false,
      stuck: false,
    }
  }

  private place(sheet: Sheet, curl: number, center: Vector3): void {
    this.group.updateWorldMatrix(true, false)
    const pos = sheet.mesh.geometry.getAttribute('position')
    for (let j = 0; j < PATCH_N; j++) {
      for (let i = 0; i < PATCH_N; i++) {
        const u = (i / (PATCH_N - 1)) * 2 - 1
        const v = (j / (PATCH_N - 1)) * 2 - 1
        const local = curlOffset(u, v, curl)
        const k = i + j * PATCH_N
        this.scratch.set(
          center.x + sheet.tangent.x * local.x + sheet.bitangent.x * local.y + sheet.normal.x * local.z,
          center.y + sheet.tangent.y * local.x + sheet.bitangent.y * local.y + sheet.normal.y * local.z,
          center.z + sheet.tangent.z * local.x + sheet.bitangent.z * local.y + sheet.normal.z * local.z,
        )
        this.group.worldToLocal(this.scratch)
        pos.setXYZ(k, this.scratch.x, this.scratch.y, this.scratch.z)
      }
    }
    pos.needsUpdate = true
    sheet.mesh.geometry.computeBoundingSphere()
  }

  private conform(sheet: Sheet, hit: RoomHit): void {
    const basis = tangentBasis(hit.nx, hit.ny, hit.nz)
    sheet.normal.set(hit.nx, hit.ny, hit.nz).normalize()
    sheet.tangent.set(basis.tx, basis.ty, basis.tz)
    sheet.bitangent.set(basis.bx, basis.by, basis.bz)
    const pos = sheet.mesh.geometry.getAttribute('position')
    const at = { x: hit.x, y: hit.y, z: hit.z }
    for (let j = 0; j < PATCH_N; j++) {
      for (let i = 0; i < PATCH_N; i++) {
        const flat = flatPoint(at, basis, i, j)
        const landed =
          this.field.raycast(
            flat.x + hit.nx * 0.06,
            flat.y + hit.ny * 0.06,
            flat.z + hit.nz * 0.06,
            -hit.nx,
            -hit.ny,
            -hit.nz,
            0.14,
          ) ?? flat
        const k = i + j * PATCH_N
        this.scratch.set(landed.x + hit.nx * 0.004, landed.y + hit.ny * 0.004, landed.z + hit.nz * 0.004)
        this.group.worldToLocal(this.scratch)
        pos.setXYZ(k, this.scratch.x, this.scratch.y, this.scratch.z)
      }
    }
    pos.needsUpdate = true
    sheet.mesh.geometry.computeBoundingSphere()
  }

  private openVoid(sheet: Sheet): void {
    sheet.carved = true
    this.field.carve(sheet.source.x, sheet.source.y, sheet.source.z, 0.09)
    const disc = new Mesh(
      new CircleGeometry(0.09, 20),
      new MeshBasicMaterial({
        color: 0x2a1a14,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      }),
    )
    disc.name = 'room-void'
    disc.renderOrder = 3
    disc.quaternion.copy(new Quaternion().setFromUnitVectors(this.up, sheet.normal))
    this.scratch.copy(sheet.source).addScaledVector(sheet.normal, 0.006)
    this.group.worldToLocal(this.scratch)
    disc.position.copy(this.scratch)
    this.group.add(disc)
    sheet.void = disc
  }

  private dropSheet(sheet: Sheet): void {
    const index = this.sheets.indexOf(sheet)
    if (index >= 0) this.sheets.splice(index, 1)
    sheet.mesh.removeFromParent()
    sheet.mesh.geometry.dispose()
    const mat = sheet.mesh.material
    if (mat instanceof MeshBasicMaterial) {
      mat.map?.dispose()
      mat.dispose()
    }
    if (sheet.void) {
      sheet.void.removeFromParent()
      sheet.void.geometry.dispose()
      const voidMat = sheet.void.material
      if (voidMat instanceof MeshBasicMaterial) voidMat.dispose()
    }
  }
}

let boundSpace: XRReferenceSpace | null = null

/** The session's reference space, set from the renderer when a headset session starts. */
export function bindRoomSpace(space: XRReferenceSpace | null): void {
  boundSpace = space
}

function sheetGeometry(): BufferGeometry {
  const geo = new BufferGeometry()
  const positions = new Float32Array(PATCH_N * PATCH_N * 3)
  const uvs = new Float32Array(PATCH_N * PATCH_N * 2)
  const indices: number[] = []
  for (let j = 0; j < PATCH_N; j++) {
    for (let i = 0; i < PATCH_N; i++) {
      const k = i + j * PATCH_N
      uvs[k * 2] = i / (PATCH_N - 1)
      uvs[k * 2 + 1] = j / (PATCH_N - 1)
      if (i + 1 < PATCH_N && j + 1 < PATCH_N) {
        indices.push(k, k + 1, k + PATCH_N, k + 1, k + PATCH_N + 1, k + PATCH_N)
      }
    }
  }
  geo.setAttribute('position', new BufferAttribute(positions, 3))
  geo.setAttribute('uv', new BufferAttribute(uvs, 2))
  geo.setIndex(indices)
  return geo
}

function decalTexture(video: HTMLVideoElement | null, normalY: number): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (ctx) {
    if (video && video.readyState >= 2 && video.videoWidth > 2) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      ctx.fillStyle = 'rgba(255, 214, 186, 0.32)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    } else {
      ctx.fillStyle = normalY > 0.65 ? '#8d8578' : '#d7c4ae'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = 'rgba(255, 179, 138, 0.38)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    ctx.strokeStyle = 'rgba(255, 250, 246, 0.92)'
    ctx.lineWidth = 6
    ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16)
  }
  const map = new CanvasTexture(canvas)
  map.colorSpace = SRGBColorSpace
  map.minFilter = LinearFilter
  map.magFilter = LinearFilter
  map.generateMipmaps = false
  return map
}

function shimmerMaterial(): ShaderMaterial {
  const haze = PALETTE.haze
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uHaze: { value: { x: haze[0], y: haze[1], z: haze[2] } },
    },
    vertexShader: /* glsl */ `
      attribute float aBorn;
      attribute vec3 aBary;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vBary;
      varying float vFresh;
      uniform float uTime;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vBary = aBary;
        vFresh = clamp(1.0 - (uTime - aBorn) / 1.6, 0.0, 1.0);
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vBary;
      varying float vFresh;
      uniform float uTime;
      uniform vec3 uHaze;
      void main() {
        float edge = min(vBary.x, min(vBary.y, vBary.z));
        float wire = 1.0 - smoothstep(0.0, 0.055, edge);
        float scan = 0.5 + 0.5 * sin(vWorld.y * 34.0 - uTime * 1.05);
        float band = smoothstep(0.62, 0.96, scan);
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - abs(dot(normalize(vNormal), viewDir)), 2.0);
        vec3 col = mix(uHaze, vec3(1.0, 0.97, 0.94), wire * band + vFresh * 0.35);
        float alpha = 0.028 + fres * 0.05 + wire * (0.05 + band * 0.26) + vFresh * (0.1 + wire * 0.32);
        if (alpha < 0.03) discard;
        gl_FragColor = vec4(col, alpha);
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
  })
}

function alignment(sample: DepthSample, fx: number, fy: number, fz: number): number {
  const dx = sample.px - sample.ox
  const dy = sample.py - sample.oy
  const dz = sample.pz - sample.oz
  const len = Math.hypot(dx, dy, dz) || 1
  return (dx * fx + dy * fy + dz * fz) / len
}

function rendererSpace(): XRReferenceSpace | null {
  return boundSpace
}

function triangleWarmup(): BufferGeometry {
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]), 3))
  geo.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3))
  geo.setAttribute('aBorn', new BufferAttribute(new Float32Array([0, 0, 0]), 1))
  geo.setAttribute('aBary', new BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), 3))
  return geo
}
