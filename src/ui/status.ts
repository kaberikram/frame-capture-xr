import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from '@iwsdk/core'
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
  if (s.drawing) return 'Release to take the photo'
  if (s.waitingOnHands) return 'Let your hands fall away from the frame'
  if (last?.depth === 'wait' && !last.flat) return 'Reading depth'
  if (last?.depth === 'model') return `${s.count} captured · depth model`
  if (last?.depth === 'brightness') return `${s.count} captured · brightness depth`
  if (last?.flat) return 'Photo held flat'
  if (s.phase === 'photo') return 'Photo in the frame'
  return s.presenting
    ? 'Pinch a corner and pull. Bring the sticker to a wall to stick it.'
    : 'Drag to draw. Drag a corner to peel. Drag a free sticker up onto the wall. Right-drag looks around.'
}

/** The launch card's status line on the page, and the same line on a small panel in the headset. */
export class Status {
  readonly hud: Mesh
  private text = ''
  private hudText = ''
  private flashText = ''
  private flashUntil = 0
  private readonly canvas = document.createElement('canvas')
  private readonly ctx2d: CanvasRenderingContext2D

  constructor() {
    this.canvas.width = 512
    this.canvas.height = 128
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas is unavailable')
    this.ctx2d = ctx
    const tex = new CanvasTexture(this.canvas)
    tex.colorSpace = SRGBColorSpace
    const mat = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    this.hud = new Mesh(new PlaneGeometry(0.42, 0.105), mat)
    this.hud.position.set(-0.18, 0.16, -0.75)
    this.hud.renderOrder = 10
    this.hud.visible = false
  }

  /** Show a one-off message for a few seconds over the running status line. */
  flash(text: string, seconds = 2.8): void {
    this.flashText = text
    this.flashUntil = performance.now() / 1000 + seconds
    this.note(text)
  }

  note(text: string): void {
    const shown = performance.now() / 1000 < this.flashUntil ? this.flashText : text
    if (shown === this.text) return
    this.text = shown
    const el = document.getElementById('status')
    if (el) el.textContent = shown
  }

  paintHud(): void {
    const line = this.text
    if (line === this.hudText) return
    this.hudText = line
    const ctx = this.ctx2d
    ctx.clearRect(0, 0, 512, 128)
    ctx.fillStyle = 'rgba(12, 14, 18, 0.72)'
    roundRect(ctx, 8, 28, 496, 72, 16)
    ctx.fill()
    ctx.fillStyle = '#f4f1ea'
    ctx.font = '500 28px sans-serif'
    ctx.fillText(line, 28, 74)
    const map = (this.hud.material as { map?: { needsUpdate: boolean } }).map
    if (map) map.needsUpdate = true
  }
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

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
