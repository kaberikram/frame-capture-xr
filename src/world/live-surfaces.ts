import { XRMesh, XRPlane, type Entity, type Mesh } from '@iwsdk/core'
import type { Ctx } from '../app/context.js'
import { appendBoxFaces, readVec3, surfaceFromMatrix, type Surface } from './surfaces.js'

const MAX_SURFACES = 48

/**
 * Surfaces a sticker can land on in a headset: detected planes, bounded faces
 * of the room mesh, and hit-test poses from the view and the hands.
 */
export class LiveSurfaces {
  readonly list: Surface[] = []
  private warned = false
  private session: XRSession | null = null
  private hitArmed = false
  private hitSource: XRHitTestSource | null = null
  private handHits: XRTransientInputHitTestSource | null = null

  constructor(private readonly ctx: Ctx) {}

  collect(planes: Iterable<Entity>, meshes: Iterable<Entity>): void {
    this.list.length = 0
    if (!this.ctx.renderer.xr.isPresenting) return
    // A surface that cannot be read is skipped. It must never stop the frame.
    try {
      for (const entity of planes) {
        if (this.list.length >= MAX_SURFACES) break
        this.pushPlane(entity)
      }
      for (const entity of meshes) {
        if (this.list.length >= MAX_SURFACES) break
        this.pushMesh(entity)
      }
      this.pushHits()
    } catch (error) {
      if (!this.warned) console.warn('[frame] room scan', error)
      this.warned = true
    }
  }

  /** Ask for hit-test sources once per session. */
  arm(session: XRSession | null): void {
    this.session = session
    if (this.hitArmed || !session) return
    const world = this.ctx.world
    this.hitArmed = true
    void session
      .requestReferenceSpace('viewer')
      .then((viewer) => {
        if (this.session !== session) return undefined
        return world.requestHitTestSource({ space: viewer })
      })
      .then((source) => {
        if (this.session !== session) {
          source?.cancel()
          return
        }
        this.hitSource = source ?? null
      })
      .catch(() => {
        this.hitSource = null
      })
    void world.requestHitTestSourceForTransientInput({ profile: 'generic-hand' }).then((source) => {
      if (this.session !== session) {
        source?.cancel()
        return
      }
      this.handHits = source ?? null
    })
  }

  clear(): void {
    this.hitSource?.cancel()
    this.handHits?.cancel()
    this.hitSource = null
    this.handHits = null
    this.hitArmed = false
  }

  private pushPlane(entity: Entity): void {
    const obj = entity.object3D
    if (!obj) return
    obj.updateWorldMatrix(true, false)
    let halfU = 0.5
    let halfV = 0.5
    let centerU = 0
    let centerV = 0
    const raw = entity.getValue(XRPlane, '_plane') as { polygon?: ArrayLike<{ x: number; z: number }> } | undefined
    const polygon = raw?.polygon
    if (polygon && polygon.length >= 3) {
      let minX = Infinity
      let maxX = -Infinity
      let minZ = Infinity
      let maxZ = -Infinity
      for (let i = 0; i < polygon.length; i++) {
        const point = polygon[i]
        if (point.x < minX) minX = point.x
        if (point.x > maxX) maxX = point.x
        if (point.z < minZ) minZ = point.z
        if (point.z > maxZ) maxZ = point.z
      }
      if (maxX > minX && maxZ > minZ) {
        centerU = (minX + maxX) * 0.5
        centerV = (minZ + maxZ) * 0.5
        halfU = (maxX - minX) * 0.5
        halfV = (maxZ - minZ) * 0.5
      }
    } else {
      const geometry = (obj as Mesh).geometry
      if (geometry && !geometry.boundingBox) geometry.computeBoundingBox()
      const bounds = geometry?.boundingBox
      if (bounds) {
        halfU = (bounds.max.x - bounds.min.x) * 0.5
        halfV = (bounds.max.z - bounds.min.z) * 0.5
      }
    }
    this.list.push(surfaceFromMatrix(obj.matrixWorld.elements, halfU, halfV, centerU, centerV))
  }

  private pushMesh(entity: Entity): void {
    if (!entity.getValue(XRMesh, 'isBounded3D')) return
    const obj = entity.object3D
    if (!obj) return
    // Vec3 fields only read through a vector view; getValue throws on them.
    const min = readVec3(entity.getVectorView(XRMesh, 'min'))
    const max = readVec3(entity.getVectorView(XRMesh, 'max'))
    if (!min || !max) return
    obj.updateWorldMatrix(true, false)
    appendBoxFaces(this.list, obj.matrixWorld.elements, min, max)
    if (this.list.length > MAX_SURFACES) this.list.length = MAX_SURFACES
  }

  private pushHits(): void {
    if (this.list.length >= MAX_SURFACES) return
    const { world } = this.ctx
    const space = world.xrReferenceSpace
    const frame = world.xrFrame
    if (!space || !frame) return
    if (this.hitSource) {
      const hits = world.getHitTestResults(this.hitSource)
      for (let i = 0; i < hits.length && this.list.length < MAX_SURFACES; i++) {
        const pose = hits[i].getPose(space)
        if (pose) this.list.push(surfaceFromMatrix(pose.transform.matrix, 0.3, 0.3))
      }
    }
    if (!this.handHits || !frame.getHitTestResultsForTransientInput) return
    const batches = frame.getHitTestResultsForTransientInput(this.handHits)
    for (let i = 0; i < batches.length && this.list.length < MAX_SURFACES; i++) {
      const results = batches[i].results
      for (let j = 0; j < results.length && this.list.length < MAX_SURFACES; j++) {
        const pose = results[j].getPose(space)
        if (pose) this.list.push(surfaceFromMatrix(pose.transform.matrix, 0.3, 0.3))
      }
    }
  }
}
