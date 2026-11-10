import { Raycaster, Vector2, Vector3 } from '@iwsdk/core'
import { DRAW_DISTANCE, WORLD_UP, type Ctx } from '../app/context.js'
import type { Shutter } from '../capture/shutter.js'
import type { DeskCamera } from '../desk/desk-camera.js'
import type { FrameGrab } from '../interaction/frame-grab.js'
import type { Grip } from '../interaction/grip.js'
import { spreadFromPull } from '../interaction/peel.js'
import { routeHit, type Interaction } from '../interaction/router.js'
import type { Stickers } from '../interaction/stickers.js'
import type { RoomScan } from '../room/room-scan.js'
import { clamp } from '../util/math.js'

/**
 * The desk preview's mouse. The left button is the pinch, shift is the second
 * hand, and right-drag (or alt-drag) looks around.
 */
export class DeskPointer {
  private readonly pointer = new Vector2()
  private readonly raycaster = new Raycaster()
  private readonly headPos = new Vector3()
  private readonly at = new Vector3()
  private drawing = false
  private view: HTMLElement | null = null
  /** Peel a patch off the reconstructed room. Set after both exist. */
  room: RoomScan | null = null
  private roomY = 0
  private roomDist = 0.8

  private readonly onDown = (event: PointerEvent): void => {
    if (this.ctx.renderer.xr.isPresenting) return
    if (event.button === 2 || event.altKey) {
      this.deskCamera.startOrbit(event.clientX, event.clientY)
      return
    }
    if (event.button !== 0 || this.blocked()) return
    const el = event.currentTarget
    if (!(el instanceof HTMLElement)) return
    el.setPointerCapture(event.pointerId)
    this.aim(event)
    const ray = this.raycaster.ray
    const hit = this.interaction.aim(ray.origin, ray.direction)
    const route = routeHit(hit, event.shiftKey)
    if (route === 'ignore') return
    if ((route === 'draw' || !hit) && this.room) {
      const surface = this.room.ray(ray.origin, ray.direction)
      if (surface) {
        this.roomY = event.clientY
        this.roomDist = surface.dist
        this.room.begin(surface, null, ray.origin)
        return
      }
    }
    if (route === 'draw' || !hit) {
      this.drawing = true
      this.place(event, true)
      return
    }
    if (route === 'unstick' || route === 'sticker' || route === 'sheets') this.grip.pointerY = event.clientY
    this.interaction.begin(route, hit.held, this.grip.pickAt)
  }

  private readonly onMove = (event: PointerEvent): void => {
    const grip = this.grip
    if (this.deskCamera.orbiting) {
      this.deskCamera.orbitTo(event.clientX, event.clientY)
      return
    }
    if (this.room?.holding) {
      this.aim(event)
      const ray = this.raycaster.ray
      const dist = clamp(this.roomDist - (this.roomY - event.clientY) * 0.004, 0.25, 3.2)
      this.at.copy(ray.origin).addScaledVector(ray.direction, dist)
      this.room.drag(this.at)
      return
    }
    const held = grip.held
    if (grip.touch === 'grab' && held) {
      this.aim(event)
      const ray = this.raycaster.ray
      if (grip.dragOnView(ray.origin, ray.direction, grip.pickAt)) this.frameGrab.move(grip.pickAt)
      return
    }
    if (grip.touch === 'sticker' && held) {
      this.aim(event)
      const ray = this.raycaster.ray
      if (grip.catchDepth) {
        grip.catchDepth = false
        grip.pointerY = event.clientY
        held.photo.getWorldPosition(grip.local)
        grip.grabDist = Math.max(0.2, grip.local.distanceTo(ray.origin))
      }
      // Moving up carries the sticker away from you along the pointer.
      const dist = clamp(grip.grabDist + (grip.pointerY - event.clientY) * 0.008, 0.2, 3.4)
      grip.pickAt.copy(ray.origin).addScaledVector(ray.direction, dist)
      this.stickers.placeStickerCenter(grip.pickAt)
      return
    }
    if (grip.touch === 'curl' && held) {
      this.aim(event)
      this.stickers.trackCurl(held, this.raycaster.ray.origin, this.raycaster.ray.direction)
      return
    }
    if (grip.touch === 'peel' && held) {
      const pull = (event.clientY - grip.pointerY) * (0.16 / 120)
      held.spread = spreadFromPull(pull)
      held.spreadV = 0
      return
    }
    if (!this.drawing) return
    this.place(event, false)
  }

  private readonly onUp = (event: PointerEvent): void => {
    if (this.deskCamera.orbiting && (event.button === 2 || event.altKey || event.button === 0)) {
      this.deskCamera.orbiting = false
      return
    }
    if (this.room?.holding && event.button === 0) {
      this.room.end()
      return
    }
    if (this.grip.touch !== 'none' && event.button === 0) {
      this.interaction.end()
      return
    }
    if (!this.drawing || event.button !== 0) return
    this.drawing = false
    this.shutter.finishGesture()
  }

  private readonly onContextMenu = (event: Event): void => {
    event.preventDefault()
  }

  constructor(
    private readonly ctx: Ctx,
    private readonly grip: Grip,
    private readonly interaction: Interaction,
    private readonly stickers: Stickers,
    private readonly frameGrab: FrameGrab,
    private readonly deskCamera: DeskCamera,
    private readonly shutter: Shutter,
    /** The scripted demo owns the frame while it plays. */
    private readonly blocked: () => boolean,
  ) {}

  attach(view: HTMLElement | null): void {
    this.view = view
    view?.addEventListener('pointerdown', this.onDown)
    view?.addEventListener('pointermove', this.onMove)
    view?.addEventListener('pointerup', this.onUp)
    view?.addEventListener('pointercancel', this.onUp)
    view?.addEventListener('contextmenu', this.onContextMenu)
  }

  detach(): void {
    const view = this.view
    view?.removeEventListener('pointerdown', this.onDown)
    view?.removeEventListener('pointermove', this.onMove)
    view?.removeEventListener('pointerup', this.onUp)
    view?.removeEventListener('pointercancel', this.onUp)
    view?.removeEventListener('contextmenu', this.onContextMenu)
    this.view = null
  }

  /** Point the raycaster through the cursor. */
  private aim(event: PointerEvent): void {
    const el = document.getElementById('scene-container')
    if (!el) return
    const rect = el.getBoundingClientRect()
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.ctx.camera)
    this.ctx.camera.getWorldPosition(this.headPos)
  }

  /** A mouse frame starts on a plane in front of the camera, and its far corner follows the cursor. */
  private place(event: PointerEvent, start: boolean): void {
    if (!document.getElementById('scene-container')) return
    this.aim(event)
    const gesture = this.ctx.gesture
    const ray = this.raycaster.ray
    if (start || !gesture.drawing) {
      this.at.copy(ray.origin).addScaledVector(ray.direction, DRAW_DISTANCE)
      gesture.begin(this.at, this.headPos, WORLD_UP)
      return
    }
    if (!gesture.hitRay(ray.origin, ray.direction, this.at)) return
    gesture.move('a', this.at, this.headPos)
  }
}
