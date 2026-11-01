import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, type Object3D } from '@iwsdk/core'
import { metrics } from './metrics.js'

const W = 640
const H = 400

/**
 * `?debug=1`: frame rate, the worst frame, long main-thread tasks, and the
 * latest capture timings. On a headset it rides low and to the left of view;
 * on the desk it is a panel in the page corner.
 */
export class DebugOverlay {
  readonly mesh: Mesh
  private readonly canvas = document.createElement('canvas')
  private readonly ctx2d: CanvasRenderingContext2D
  private readonly tex: CanvasTexture
  private readonly panel: HTMLPreElement
  private frames = 0
  private windowStart = 0
  private worstFrame = 0
  private fps = 0
  private worstShown = 0
  private longTasks = 0
  private longest = 0
  private lastPaint = 0
  private observer: PerformanceObserver | null = null

  constructor() {
    this.canvas.width = W
    this.canvas.height = H
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas is unavailable')
    this.ctx2d = ctx
    this.tex = new CanvasTexture(this.canvas)
    this.tex.colorSpace = SRGBColorSpace
    this.mesh = new Mesh(new PlaneGeometry(0.32, 0.2), new MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, depthTest: false }))
    this.mesh.renderOrder = 20
    this.mesh.position.set(-0.24, -0.16, -0.62)
    this.mesh.rotation.set(0.25, 0.3, 0)
    this.panel = document.createElement('pre')
    this.panel.style.cssText =
      'position:fixed;top:8px;right:8px;z-index:5;margin:0;padding:8px 10px;max-width:46vw;font:11px/1.35 ui-monospace,Menlo,monospace;' +
      'color:#e9f0e6;background:rgba(10,12,14,0.72);border-radius:6px;pointer-events:none;white-space:pre-wrap'
    document.body.appendChild(this.panel)
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTasks += 1
          if (entry.duration > this.longest) this.longest = entry.duration
        }
      })
      this.observer.observe({ type: 'longtask', buffered: false })
    } catch {
      this.observer = null
    }
  }

  /** Attach to the head so it rides along in a headset. */
  mount(head: Object3D): void {
    head.add(this.mesh)
  }

  /** Call once per frame with the real time between frames, in milliseconds. */
  frame(nowMs: number, frameMs: number, lines: readonly string[], presenting: boolean): void {
    if (this.windowStart === 0) this.windowStart = nowMs
    this.frames += 1
    if (frameMs > this.worstFrame) this.worstFrame = frameMs
    const span = nowMs - this.windowStart
    if (span >= 1000) {
      this.fps = (this.frames * 1000) / span
      this.worstShown = this.worstFrame
      this.frames = 0
      this.worstFrame = 0
      this.windowStart = nowMs
    }
    this.mesh.visible = presenting
    if (nowMs - this.lastPaint < 250) return
    this.lastPaint = nowMs
    const all = [
      `fps ${this.fps.toFixed(0)}   worst frame ${this.worstShown.toFixed(0)} ms`,
      `long tasks ${this.longTasks}   longest ${this.longest.toFixed(0)} ms${this.observer ? '' : ' (not reported here)'}`,
      ...lines,
      ...[...metrics()].map(([k, v]) => `${k} ${v}`),
    ]
    this.panel.textContent = all.join('\n')
    if (!presenting) return
    const ctx = this.ctx2d
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = 'rgba(10, 12, 14, 0.72)'
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = '#e9f0e6'
    ctx.font = '20px ui-monospace, Menlo, monospace'
    for (let i = 0; i < all.length && i < 15; i++) ctx.fillText(all[i].slice(0, 54), 14, 30 + i * 25)
    this.tex.needsUpdate = true
  }

  dispose(): void {
    this.observer?.disconnect()
    this.panel.remove()
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    ;(this.mesh.material as MeshBasicMaterial).dispose()
    this.tex.dispose()
  }
}
