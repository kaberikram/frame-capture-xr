import { CLEAN, PEEL, PREVIEW_FORCED, queryFlag } from '../app/experience.js'
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
  /** This is the peel page. */
  room: boolean
  /** Set when the headset session has no depth sensing. */
  roomNote: string | null
  /** What the piece in hand is doing on the peel page, or 'none'. */
  piece: string
  /** A carried piece is over somewhere it can land. */
  overSurface: boolean
}

/** One line that says what is happening or what to do next. */
export function statusLine(s: StatusInputs): string {
  const last = s.last
  if (s.room) {
    if (s.presenting && s.camera) return s.camera
    if (s.roomNote) return s.roomNote
    if (s.piece === 'lifting') return s.presenting ? 'Keep pulling. Let go and it tears free at this size' : 'Keep dragging up. Let go and it tears free at this size'
    if (s.piece === 'carried') return s.overSurface ? 'Let go to lay it down' : 'Carry it to another surface, or let go and it floats'
    if (s.piece === 'free') return s.presenting ? 'Pinch the floating piece to carry it' : 'Press the floating piece to carry it'
    return s.presenting
      ? 'Bring a hand to a surface. Pinch it and pull.'
      : 'Press a surface and drag up to pull it off. Right-drag looks around.'
  }
  if (s.touch === 'curl') return 'Pull the corner. Past the mark the sticker comes free'
  if (s.previewing) return 'Release to stick it on'
  if (s.touch === 'sticker') return 'The sticker follows your hand'
  if (last?.mode === 'stuck') return 'Pinch the lifted corner to peel it off'
  if (s.touch === 'peel') return 'Both hands pull the depth apart'
  if (s.touch === 'grab') return 'The handle moves and tilts the frame'
  if (s.drawing) return 'Release to take the photo'
  if (s.waitingOnHands) return 'Let your hands fall away from the frame'
  if (last?.depth === 'wait' && !last.flat) return 'Reading depth'
  if (last?.depth === 'model') return `${s.count} captured · depth model`
  if (last?.depth === 'brightness') return `${s.count} captured · brightness depth`
  if (last?.flat) return 'Photo held flat'
  if (s.presenting && s.camera) return s.camera
  if (s.phase === 'photo') return 'Photo in the frame'
  return s.presenting
    ? `${s.warp} inside the frame. Turn a palm toward you, or flick a hand through it. Pinch a corner to peel.`
    : 'Drag to draw. Drag a corner to peel. Keys 1–4 change the time inside the frame. Right-drag looks around.'
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
  if (CLEAN && enter) enter.textContent = 'Enter'
  if (PREVIEW_FORCED && hint && !CLEAN) hint.textContent = PEEL ? 'Preview is on. Press a surface and drag up. Right-drag orbits.' : 'Preview is on. Drag in the view. Right-drag orbits.'
  const xr = navigator.xr
  if (!enter) return
  enter.disabled = true
  enter.addEventListener('click', onEnter)
  if (!xr) {
    if (hint && !PREVIEW_FORCED && !CLEAN) hint.textContent = 'Open this page in the Meta Quest browser for passthrough.'
    return
  }
  void xr.isSessionSupported('immersive-ar').then((ok) => {
    enter.disabled = !ok
    if (!ok && hint && !PREVIEW_FORCED && !CLEAN) hint.textContent = 'Open this page in the Meta Quest browser for passthrough.'
  })
}
