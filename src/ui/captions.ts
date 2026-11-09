import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Vector3, type Object3D } from '@iwsdk/core'
import { REDUCE_MOTION } from '../app/context.js'
import { PALETTE, voice } from '../look/palette.js'

const W = 1024
const H = 160
const FONT = '"Hanken Grotesk", "Segoe UI", system-ui, sans-serif'

/** Hints that each show once, at the moment they help, and then retire. */
export type Hint = 'draw' | 'peel' | 'wall' | 'time'

const HINTS: Record<Hint, string> = {
  draw: 'Pinch the air and draw a frame',
  time: 'Pinch the mark above the frame to change time',
  peel: 'Pinch a corner to peel',
  wall: 'Bring it to a wall',
}

/** After this long with nothing happening, the hint for the current moment may show again. */
const IDLE_AGAIN = 45

/**
 * A line of light text that drifts along a little below where you look, with
 * no box behind it. It eases after your head instead of being fixed to it,
 * which is easier on the eyes, and fades between lines.
 */
export class Captions {
  readonly mesh: Mesh
  private readonly canvas = document.createElement('canvas')
  private readonly ctx2d: CanvasRenderingContext2D
  private readonly tex: CanvasTexture
  private readonly mat: MeshBasicMaterial
  private readonly retired = new Set<Hint>()
  private painted = ''
  private wanted = ''
  private alpha = 0
  private idle = 0
  private placed = false
  private fontReady = false
  private readonly target = new Vector3()
  private readonly head = new Vector3()
  private readonly forward = new Vector3()

  constructor() {
    this.canvas.width = W
    this.canvas.height = H
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas is unavailable')
    this.ctx2d = ctx
    this.tex = new CanvasTexture(this.canvas)
    this.tex.colorSpace = SRGBColorSpace
    this.mat = new MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, depthTest: false, opacity: 0 })
    this.mesh = new Mesh(new PlaneGeometry(0.6, (0.6 * H) / W), this.mat)
    this.mesh.renderOrder = 25
    this.mesh.visible = false
    this.mesh.frustumCulled = false
    this.mesh.name = 'captions'
    void document.fonts?.load(`300 64px ${FONT}`).then(() => {
      this.fontReady = true
      this.painted = ''
    }).catch(() => undefined)
  }

  /** The hint for this moment, unless it has already been shown. */
  hint(which: Hint | null): string | null {
    if (!which || this.retired.has(which)) return null
    return HINTS[which]
  }

  /** The person did the thing a hint asks for: it never shows again (until a long idle). */
  retire(which: Hint): void {
    this.retired.add(which)
  }

  /** Something happened, so the idle clock starts over. */
  active(): void {
    this.idle = 0
  }

  /**
   * Show `line` (or nothing). `head` is the viewer; the caption eases toward a
   * spot ahead of it and a little below the line of sight.
   */
  update(line: string | null, head: Object3D, presenting: boolean, dt: number): void {
    this.idle += dt
    if (this.idle > IDLE_AGAIN && this.retired.size > 0) {
      this.retired.clear()
      this.idle = 0
    }
    if (!presenting) {
      this.mesh.visible = false
      this.placed = false
      return
    }
    const text = line ? voice(line) : ''
    // Fade out, change the words, fade back in.
    if (text !== this.wanted) {
      if (this.alpha > 0.02 && this.painted) {
        this.alpha = Math.max(0, this.alpha - dt / 0.25)
      } else {
        this.wanted = text
      }
    } else {
      const goal = text ? 1 : 0
      const rate = REDUCE_MOTION ? 1 : dt / 0.4
      this.alpha += Math.sign(goal - this.alpha) * Math.min(Math.abs(goal - this.alpha), rate)
    }
    if (this.wanted !== this.painted || (!this.fontReady && this.wanted && !this.painted)) this.paint(this.wanted)
    this.mat.opacity = this.alpha
    this.mesh.visible = this.alpha > 0.01

    head.updateWorldMatrix(true, false)
    const e = head.matrixWorld.elements
    this.head.set(e[12], e[13], e[14])
    this.forward.set(-e[8], 0, -e[10])
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1)
    this.forward.normalize()
    this.target.copy(this.head).addScaledVector(this.forward, 0.8)
    this.target.y = this.head.y - 0.18
    if (!this.placed || REDUCE_MOTION) {
      this.mesh.position.copy(this.target)
      this.placed = true
    } else {
      this.mesh.position.lerp(this.target, 1 - Math.exp(-dt / 0.35))
    }
    this.mesh.lookAt(this.head)
  }

  dispose(): void {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mat.dispose()
    this.tex.dispose()
  }

  private paint(text: string): void {
    this.painted = text
    const ctx = this.ctx2d
    ctx.clearRect(0, 0, W, H)
    if (!text) {
      this.tex.needsUpdate = true
      return
    }
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `300 60px ${FONT}`
    ctx.shadowColor = PALETTE.captionGlow
    ctx.shadowBlur = 26
    ctx.fillStyle = PALETTE.captionInk
    // Twice: once to build the glow, once crisp on top.
    ctx.fillText(text, W / 2, H / 2, W - 40)
    ctx.shadowBlur = 6
    ctx.fillText(text, W / 2, H / 2, W - 40)
    this.tex.needsUpdate = true
  }
}
