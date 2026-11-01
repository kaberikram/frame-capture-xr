import { AdditiveBlending, CanvasTexture, Color, Group, SRGBColorSpace, Sprite, SpriteMaterial, Vector3 } from '@iwsdk/core'
import type { Palette } from './palette.js'

interface Light {
  halo: Sprite
  spark: Sprite
  level: number
  bloom: number
  was: boolean
}

/**
 * A small warm light that gathers between thumb and index as they close and
 * blooms when they meet. Hands-only input has no haptics; this is how a pinch
 * feels like it registered.
 */
export class PinchLights {
  readonly group = new Group()
  private readonly lights: Light[] = []
  private readonly tex: CanvasTexture

  constructor(palette: Palette, count = 2) {
    this.group.name = 'pinch-lights'
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 128
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas is unavailable')
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.22, 'rgba(255,255,255,0.55)')
    g.addColorStop(0.55, 'rgba(255,255,255,0.12)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 128, 128)
    this.tex = new CanvasTexture(canvas)
    this.tex.colorSpace = SRGBColorSpace
    const tint = (rgb: Palette['glow']) => new Color().setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace)
    for (let i = 0; i < count; i++) {
      const make = (rgb: Palette['glow'], order: number) => {
        const sprite = new Sprite(
          new SpriteMaterial({ map: this.tex, color: tint(rgb), blending: AdditiveBlending, depthTest: false, depthWrite: false, transparent: true }),
        )
        sprite.renderOrder = order
        sprite.visible = false
        sprite.frustumCulled = false
        this.group.add(sprite)
        return sprite
      }
      this.lights.push({ halo: make(palette.glow, 30), spark: make(palette.core, 31), level: 0, bloom: 0, was: false })
    }
  }

  /**
   * One light per slot. `readiness` is 0 (fingers open) to 1 (touching), or
   * -1 when the hand is not tracked. `pinched` blooms it.
   */
  set(index: number, at: Vector3 | null, readiness: number, pinched: boolean, dt: number): void {
    const light = this.lights[index]
    if (!light) return
    const show = at !== null && readiness >= 0
    // It only gathers in the last few centimetres, so a resting hand shows nothing.
    const target = !show ? 0 : pinched ? 1 : Math.max(0, (readiness - 0.45) / 0.55) ** 2 * 0.6
    const rate = target > light.level ? 14 : 6
    light.level += (target - light.level) * Math.min(1, dt * rate)
    if (pinched && !light.was) light.bloom = 1
    light.was = pinched
    light.bloom = Math.max(0, light.bloom - dt * 4)
    const visible = light.level > 0.01 && at !== null
    light.halo.visible = visible
    light.spark.visible = visible
    if (!visible || !at) return
    const scale = 0.022 + 0.02 * light.level + 0.03 * light.bloom
    light.halo.position.copy(at)
    light.spark.position.copy(at)
    light.halo.scale.setScalar(scale)
    light.spark.scale.setScalar(scale * 0.3)
    ;(light.halo.material as SpriteMaterial).opacity = 0.7 * light.level
    ;(light.spark.material as SpriteMaterial).opacity = Math.min(1, light.level * 1.2 + light.bloom * 0.4)
  }

  dispose(): void {
    for (const light of this.lights) {
      ;(light.halo.material as SpriteMaterial).dispose()
      ;(light.spark.material as SpriteMaterial).dispose()
    }
    this.tex.dispose()
    this.group.removeFromParent()
  }
}
