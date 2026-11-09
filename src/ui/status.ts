import { PREVIEW_FORCED, queryFlag } from '../app/experience.js'
import type { Held } from '../capture/held.js'
import type { Phase } from '../debug/api.js'
import type { Touch } from '../interaction/grip.js'

export interface StatusInputs {
  touch: Touch
  previewing: boolean
  last: Held | undefined
  drawing: boolean
  phase: Phase
  presenting: boolean
  count: number
  /** A hand has been in a waiting frame's photo for a moment. */
  waitingOnHands: boolean
  /** Name of the time mode inside the frame. */
  warp: string
  /** Why the headset camera is not running, or null. */
  camera: string | null
}

/** One line that says what is happening or what to do next. */
export function statusLine(s: StatusInputs): string {
  const last = s.last
  if (s.touch === 'curl') return 'Pull the corner. Past the mark the sticker comes free'
  if (s.previewing) return 'Release to stick it on'
  if (s.touch === 'sticker') return 'The sticker follows your hand'
  if (last?.mode === 'stuck') return 'Pinch the lifted corner to peel it off'
  if (s.touch === 'peel') return 'Both hands pull the depth apart'
  if (s.touch === 'grab') return 'The handle moves and tilts the frame'
  if (s.touch === 'time') return 'Slide sideways to change the strength. A tap changes the mode'
  if (s.drawing) return 'Release to take the photo'
  if (s.waitingOnHands) return 'Let your hands fall away from the frame'
  if (last?.depth === 'wait' && !last.flat) return 'Reading depth'
  if (last?.depth === 'model') return `${s.count} captured · depth model`
  if (last?.depth === 'brightness') return `${s.count} captured · brightness depth`
  if (last?.flat) return 'Photo held flat'
  if (s.presenting && s.camera) return s.camera
  if (s.phase === 'photo') return 'Photo in the frame'
  return s.presenting
    ? `${s.warp} inside the frame. Pinch the mark above it to change time, or a corner to peel.`
    : 'Drag to draw. Drag a corner to peel. Keys 1–5 change the time inside the frame, [ and ] the strength. Right-drag looks around.'
}

/** The launch card's status line on the page. In a headset the captions carry the words. */
export class Status {
  private text = ''
  private flashText = ''
  private flashUntil = 0

  /** Show a one-off message for a few seconds over the running status line. */
  flash(text: string, seconds = 2.8): void {
    this.flashText = text
    this.flashUntil = performance.now() / 1000 + seconds
    this.note(text)
  }

  /** The one-off message still showing, if any. */
  get flashing(): string | null {
    return performance.now() / 1000 < this.flashUntil ? this.flashText : null
  }

  note(text: string): void {
    const shown = this.flashing ?? text
    if (shown === this.text) return
    this.text = shown
    const el = document.getElementById('status')
    if (el) el.textContent = shown
  }
}

/** A line on the launch card about the camera. Empty text hides it. */
export function launchNote(text: string): void {
  const el = document.getElementById('camera')
  if (el) el.textContent = text
}

/** The page card: hide it with `?ui=0`, and enable Enter once the browser can run passthrough. */
export function wireLaunch(onEnter: () => void): void {
  const enter = document.getElementById('enter') as HTMLButtonElement | null
  const hint = document.getElementById('hint')
  const card = document.getElementById('launch')
  if (queryFlag('ui') === '0' && card) card.hidden = true
  if (PREVIEW_FORCED && hint) hint.textContent = 'Preview is on. Drag in the view. Right-drag orbits.'
  const xr = navigator.xr
  if (!enter) return
  enter.disabled = true
  enter.addEventListener('click', onEnter)
  if (!xr) {
    if (hint && !PREVIEW_FORCED) hint.textContent = 'Open this page in the Meta Quest browser for passthrough.'
    return
  }
  void xr.isSessionSupported('immersive-ar').then((ok) => {
    enter.disabled = !ok
    if (!ok && hint && !PREVIEW_FORCED) hint.textContent = 'Open this page in the Meta Quest browser for passthrough.'
  })
}
