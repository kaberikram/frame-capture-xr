import type { Object3D } from '@iwsdk/core'
import { disposeMotes, stepMotes, type MotesRig } from './motes.js'

/** A short-lived visual that steps itself and is removed when it is done. */
export interface Effect {
  /** 'dissolve' marks an empty frame letting go, which the phase reports. */
  kind: 'dissolve' | 'ring'
  group: Object3D
  /** Advance by `dt` seconds. True once it is finished. */
  step(dt: number): boolean
  dispose(): void
}

export function motesEffect(rig: MotesRig): Effect {
  return {
    kind: 'dissolve',
    group: rig.group,
    step: (dt) => stepMotes(rig, dt),
    dispose: () => disposeMotes(rig),
  }
}
