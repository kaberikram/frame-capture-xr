import { Matrix4 } from '@iwsdk/core'
import { MAX_CAPTURES, type Ctx } from '../app/context.js'
import { applyPhoto } from '../look/relief.js'
import type { CameraRig } from './camera-rig.js'
import { cropQuad, cropSize } from './crop.js'
import { developModelDepth } from './develop.js'
import { makeHeld } from './held.js'

/** Long side of the cropped photo, in pixels. */
const CROP_LONG = 640

/** Anchors a finished frame where it was drawn and photographs what it covers. */
export class Shutter {
  private token = 0
  private readonly basis = new Matrix4()

  constructor(
    private readonly ctx: Ctx,
    private readonly rig: CameraRig,
    private readonly note: (text: string) => void,
  ) {}

  /** Releasing the pinch (or the mouse) anchors the frame and takes the photo. */
  finishGesture(): void {
    const { gesture, look } = this.ctx
    const rect = gesture.rect
    const wide = rect.halfW * 2 >= look.minSpan && rect.halfH * 2 >= look.minSpan
    const result = gesture.drawing ? gesture.end() : 'cancel'
    if (result === 'commit' && wide) this.commit(false)
    else if (result === 'commit') this.note('Draw a larger frame')
  }

  /** `holdFlat` keeps the photo flat; the desk demo uses it to show the bare photo. */
  commit(holdFlat: boolean): void {
    const { captures, gesture, look, renderer, root } = this.ctx
    if (captures.length >= MAX_CAPTURES) {
      this.note('Sixteen frames is the limit for this session')
      return
    }
    const rect = gesture.rect
    const hw = rect.halfW
    const hh = rect.halfH
    const held = makeHeld(look, hw, hh, holdFlat, ++this.token)
    const group = held.group
    gesture.pose(group.position, group.quaternion, this.basis)
    root.add(group)
    captures.push(held)
    group.updateWorldMatrix(true, false)
    if (renderer.xr.isPresenting && this.rig.feed.width < 2) {
      this.note('Waiting for the camera')
      console.info('[frame] capture waiting for the camera')
      return
    }
    const quad = this.rig.projectGroup(group, hw, hh)
    const raster = this.rig.grabRaster()
    if (!quad || !raster) {
      this.note('The frame is outside the camera')
      console.info('[frame] capture missed the camera')
      return
    }
    const size = cropSize(held.width / held.height, CROP_LONG)
    const cropped = cropQuad(raster, quad, size.width, size.height)
    if (!cropped) {
      this.note('The frame is outside the camera')
      return
    }
    held.raster = cropped
    applyPhoto(held.mat, cropped)
    held.photo.visible = true
    renderer.initTexture(held.mat.uniforms.uPhoto.value)
    console.info(`[frame] capture ${held.width.toFixed(2)}x${held.height.toFixed(2)}m`)
    if (holdFlat) return
    developModelDepth(held, cropped)
  }
}
