import { REDUCE_MOTION, type Look } from '../app/context.js'
import { applyDepth, setRelief } from '../look/relief.js'
import { easeOut } from '../util/math.js'
import { brightnessDepth, detrendDepth, settleDepth } from './brightness-depth.js'
import type { Raster } from './crop.js'
import { estimateDepth } from './depth-model.js'
import type { Held } from './held.js'

/** Seconds to wait for the depth model before brightness stands in. */
const DEPTH_WAIT = 1.4

/** Brightness depth after the wait, then the relief eases out of the frame. */
export function stepDevelop(held: Held, dt: number, look: Look): void {
  held.age += dt
  if (!held.popping && held.depth === 'wait' && held.age >= DEPTH_WAIT && held.raster) {
    applyDepth(held.mat, brightnessDepth(held.raster))
    held.depth = 'brightness'
    held.popping = true
    console.info('[frame] depth brightness')
  }
  if (held.popping) {
    const dur = Math.max(0.05, look.pop)
    held.pop = REDUCE_MOTION ? 1 : Math.min(1, held.pop + dt / dur)
    setRelief(held.mat, easeOut(held.pop))
  }
}

/** Ask the model for depth. When it answers it replaces whatever depth the frame has. */
export function developModelDepth(held: Held, cropped: Raster): void {
  const token = held.token
  void estimateDepth(cropped)
    .then((field) => {
      if (held.token !== token || held.flat) return
      detrendDepth(field)
      settleDepth(field)
      applyDepth(held.mat, field)
      held.depth = 'model'
      if (held.popping && !REDUCE_MOTION) held.pop = Math.min(held.pop, 0.4)
      held.popping = true
      console.info('[frame] depth model')
    })
    .catch((error: unknown) => {
      console.warn('[frame] depth', error)
    })
}
