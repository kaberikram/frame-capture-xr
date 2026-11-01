import { REDUCE_MOTION, type Look } from '../app/context.js'
import { metric } from '../debug/metrics.js'
import { bloom, bloomProgress } from '../look/bloom.js'
import { applyDepth, setDepthMix, setRelief } from '../look/relief.js'
import { smoothStep } from '../util/math.js'
import type { Raster } from './crop.js'
import { estimateDepth } from './depth-model.js'
import type { Held } from './held.js'

/** Seconds after the photo before brightness depth shows. */
const DEPTH_WAIT = 1.4
/** While the model is still expected, brightness is a gentle preview at this share of the full relief. */
const PREVIEW = 0.45
/** Seconds after the photo before the preview stops waiting for the model and blooms fully. */
const MODEL_PATIENCE = 3.5
/** Seconds the newest depth takes to fade in over the old one. */
const CROSSFADE = 0.7

/** Start a bloom from wherever the relief is now toward `to`. */
function aim(held: Held, to: number): void {
  if (held.popping && held.reliefTo === to) return
  held.reliefFrom = held.mat.uniforms.uRelief.value as number
  held.reliefTo = to
  held.bloomT = 0
  held.pop = 0
  held.popping = true
}

/**
 * The photo develops: brightness depth after a moment (a gentle preview while
 * the model is still coming), then the model's depth fades in and the relief
 * blooms fully, with a little overshoot so it breathes out instead of stopping.
 */
export function stepDevelop(held: Held, dt: number, look: Look): void {
  held.age += dt
  if (held.depth === 'wait' && held.age >= DEPTH_WAIT && held.preview) {
    applyDepth(held.mat, held.preview, false)
    held.depth = 'brightness'
    aim(held, held.modelPending ? PREVIEW : 1)
    console.info('[frame] depth brightness')
  }
  if (held.depth === 'brightness' && held.modelPending && held.age >= MODEL_PATIENCE) aim(held, 1)
  if (held.popping) {
    held.bloomT += dt
    const dur = Math.max(0.05, look.pop)
    const k = REDUCE_MOTION ? 1 : bloom(held.bloomT, dur)
    held.pop = REDUCE_MOTION ? 1 : bloomProgress(held.bloomT, dur)
    setRelief(held.mat, held.reliefFrom + (held.reliefTo - held.reliefFrom) * k)
  }
  if (held.depthMix < 1) {
    held.depthMix = REDUCE_MOTION ? 1 : Math.min(1, held.depthMix + dt / CROSSFADE)
    setDepthMix(held.mat, smoothStep(held.depthMix))
  }
}

/** Ask the model for depth. When it answers it fades in over whatever depth the frame shows. */
export function developModelDepth(held: Held, cropped: Raster): void {
  const token = held.token
  held.modelPending = true
  const started = performance.now()
  void estimateDepth(cropped)
    .then((field) => {
      if (held.token !== token || held.flat) return
      held.modelPending = false
      const fade = held.depth === 'brightness'
      applyDepth(held.mat, field, fade)
      held.depthMix = fade ? 0 : 1
      held.depth = 'model'
      aim(held, 1)
      const took = performance.now() - started
      metric('depth model', took, ' ms')
      console.info(`[frame] depth model in ${Math.round(took)} ms`)
    })
    .catch((error: unknown) => {
      if (held.token !== token) return
      held.modelPending = false
      if (held.depth === 'brightness') aim(held, 1)
      metric('depth model', 'failed, using brightness')
      console.warn('[frame] depth', error)
    })
}
