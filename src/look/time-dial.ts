import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  FrontSide,
  Group,
  LinearFilter,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  type Object3D,
  type WebGLRenderer,
} from '@iwsdk/core'
import { REDUCE_MOTION } from '../app/context.js'
import { DIAL_MODES, dialName, type DialMode } from '../capture/time-mode.js'
import {
  TILE_H,
  TILE_W,
  tileCenter,
  tilePick,
  type TilePick,
} from '../interaction/time-gestures.js'
import { PALETTE } from './palette.js'

const APPEAR = 0.16
const DISMISS = 0.14
const PRESS = 0.12
const DROP = 0.18
const NONE: TilePick = { index: -1, near: 0, touch: false }

/**
 * A small frosted stack of mode tiles on the thumb side of an upturned palm.
 * A fingertip draws a thin white line to the tile it nears; a touch presses
 * the tile and carries that mode into the frame.
 */
export class TimeDial {
  readonly group = new Group()
  pressing = false
  private shown = 0
  private fade = 0
  private want = 0
  private hover: TilePick = NONE
  private pressIndex = -1
  private pressT = 0
  private dropT = -1
  private arrive: (() => void) | null = null
  private readonly anchor = new Vector3()
  private readonly xAxis = new Vector3()
  private readonly yAxis = new Vector3()
  private readonly zAxis = new Vector3()
  private readonly basis = new Matrix4()
  private readonly fingerWorld = new Vector3()
  private readonly fingerLocal = new Vector3()
  private readonly edge = new Vector3()
  private readonly dropFrom = new Vector3()
  private readonly dropTo = new Vector3()
  private readonly hasDrop = { value: false }
  private readonly tiles: Mesh[] = []
  private readonly fills: ShaderMaterial[] = []
  private readonly chromes: Mesh[] = []
  private readonly shadowMat: ShaderMaterial
  private readonly dropMat: ShaderMaterial
  private readonly drop: Mesh
  private readonly line: Line
  private readonly linePos: Float32Array

  constructor(
    parent: Object3D,
    private readonly renderer: WebGLRenderer,
  ) {
    this.group.name = 'time-dial'
    this.group.frustumCulled = false
    this.group.visible = false
    parent.add(this.group)
    this.shadowMat = tileFill(PALETTE.shadow, 0.2, (TILE_W * 1.08) / (TILE_H * 1.2))
    for (let i = 0; i < DIAL_MODES.length; i++) this.addTile(DIAL_MODES[i], i)
    this.dropMat = tileFill(PALETTE.sheen, 0.92, TILE_W / TILE_H)
    this.drop = new Mesh(new PlaneGeometry(1, 1), this.dropMat)
    this.drop.name = 'time-dial-drop'
    this.drop.visible = false
    this.drop.frustumCulled = false
    this.drop.renderOrder = 12
    parent.add(this.drop)
    this.linePos = new Float32Array(6)
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(this.linePos, 3))
    this.line = new Line(
      geo,
      new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false, toneMapped: false }),
    )
    this.line.frustumCulled = false
    this.line.renderOrder = 11
    this.line.visible = false
    parent.add(this.line)
    this.paintLabels()
    void document.fonts?.ready.then(() => this.paintLabels())
    this.warm()
  }

  /** `anchor` is world space. Pass null and the stack scales away. */
  setHand(anchor: Vector3 | null, palm: Vector3, fingers: Vector3): void {
    if (!anchor || palm.lengthSq() < 0.5) {
      this.want = 0
      return
    }
    this.want = 1
    this.anchor.copy(anchor)
    this.zAxis.copy(palm).normalize()
    this.yAxis.copy(fingers).addScaledVector(this.zAxis, -fingers.dot(this.zAxis))
    if (this.yAxis.lengthSq() < 1e-6) this.yAxis.set(0, 1, 0).addScaledVector(this.zAxis, -this.zAxis.y)
    if (this.yAxis.lengthSq() < 1e-6) this.yAxis.set(0, 0, -1)
    this.yAxis.normalize()
    this.xAxis.crossVectors(this.yAxis, this.zAxis).normalize()
    this.basis.makeBasis(this.xAxis, this.yAxis, this.zAxis)
    this.group.position.copy(anchor)
    this.group.quaternion.setFromRotationMatrix(this.basis)
  }

  /** Where the other hand's index tip is. Returns the tile it is approaching. */
  point(world: Vector3): TilePick {
    this.fingerWorld.copy(world)
    if (this.shown < 0.72 || this.pressing) {
      this.hover = NONE
      return NONE
    }
    this.group.updateWorldMatrix(true, false)
    this.group.worldToLocal(this.fingerLocal.copy(world))
    this.hover = tilePick(this.fingerLocal.x, this.fingerLocal.y, this.fingerLocal.z, DIAL_MODES.length)
    return this.hover
  }

  clearPoint(): void {
    this.hover = NONE
  }

  /**
   * Press `index` in, then carry a copy of the tile to `to`.
   * `arrive` runs when the mode should land. `to` null lands as the press finishes.
   */
  press(index: number, to: Vector3 | null, arrive: () => void): void {
    if (REDUCE_MOTION) {
      arrive()
      return
    }
    if (this.pressing || index < 0 || index >= this.tiles.length) return
    this.pressing = true
    this.pressIndex = index
    this.pressT = 0
    this.dropT = -1
    this.arrive = arrive
    this.hasDrop.value = to !== null && !REDUCE_MOTION
    if (to) this.dropTo.copy(to)
  }

  step(dt: number): void {
    const dur = this.want > 0 ? APPEAR : DISMISS
    const speed = REDUCE_MOTION || dur <= 0 ? 1 : dt / dur
    if (this.shown < this.want) this.shown = Math.min(this.want, this.shown + speed)
    else if (this.shown > this.want) this.shown = Math.max(this.want, this.shown - speed)
    this.fade = this.want > 0 ? 1 - (1 - this.shown) * (1 - this.shown) : this.shown
    const show = this.fade > 0.02
    this.group.visible = show
    this.group.scale.setScalar(0.9 + 0.1 * this.fade)
    this.shadowMat.uniforms.uFade.value = this.fade
    this.placeTiles()
    this.placeTether()
    this.advancePress(dt)
  }

  dispose(): void {
    this.group.removeFromParent()
    this.drop.removeFromParent()
    this.line.removeFromParent()
    this.shadowMat.dispose()
    this.dropMat.dispose()
    this.drop.geometry.dispose()
    this.line.geometry.dispose()
    const lineMat = this.line.material
    if (lineMat instanceof LineBasicMaterial) lineMat.dispose()
    for (let i = 0; i < this.fills.length; i++) this.fills[i].dispose()
    for (let i = 0; i < this.chromes.length; i++) {
      const mat = this.chromes[i].material
      if (mat instanceof MeshBasicMaterial) {
        mat.map?.dispose()
        mat.dispose()
      }
    }
    sharedTileGeo().dispose()
    sharedShadowGeo().dispose()
    tileGeo = null
    shadowGeo = null
  }

  private addTile(mode: DialMode, index: number): void {
    const fill = tileFill(PALETTE.haze, 0.42, TILE_W / TILE_H)
    fill.uniforms.uHot.value = new Vector3(PALETTE.sheen[0], PALETTE.sheen[1], PALETTE.sheen[2])
    const tile = new Mesh(sharedTileGeo(), fill)
    const c = tileCenter(index, DIAL_MODES.length)
    tile.position.set(c.x, c.y, 0)
    tile.renderOrder = 9
    tile.frustumCulled = false
    const shadow = new Mesh(sharedShadowGeo(), this.shadowMat)
    shadow.position.z = -0.0025
    shadow.renderOrder = 8
    shadow.frustumCulled = false
    tile.add(shadow)
    const chrome = new Mesh(sharedTileGeo(), chromeMaterial(mode))
    chrome.position.z = 0.001
    chrome.renderOrder = 10
    chrome.frustumCulled = false
    tile.add(chrome)
    this.group.add(tile)
    this.tiles.push(tile)
    this.fills.push(fill)
    this.chromes.push(chrome)
  }

  private placeTiles(): void {
    for (let i = 0; i < this.tiles.length; i++) {
      const hot = this.hover.index === i ? this.hover.near : 0
      const pressed = this.pressIndex === i && this.pressing ? Math.min(1, this.pressT) : 0
      const solid = pressed > 0 ? 1 : hot
      const fill = this.fills[i]
      fill.uniforms.uSolid.value = solid
      fill.uniforms.uFade.value = this.fade
      const lift = pressed > 0 ? -0.0035 * pressed : 0.003 * hot
      const c = tileCenter(i, DIAL_MODES.length)
      const sink = pressed > 0 ? 0.96 : 1
      this.tiles[i].position.set(c.x, c.y, lift)
      this.tiles[i].scale.setScalar(sink)
      const chrome = this.chromes[i].material
      if (chrome instanceof MeshBasicMaterial) chrome.opacity = this.fade
    }
  }

  private placeTether(): void {
    const mat = this.line.material
    const show = this.hover.index >= 0 && !this.hover.touch && !this.pressing && this.fade > 0.7
    this.line.visible = show
    if (!(mat instanceof LineBasicMaterial) || !show) return
    const tile = this.tiles[this.hover.index]
    if (!tile) return
    edgePoint(this.fingerLocal.x, this.fingerLocal.y, tile.position.x, tile.position.y, this.edge)
    tile.parent?.localToWorld(this.edge)
    this.linePos[0] = this.edge.x
    this.linePos[1] = this.edge.y
    this.linePos[2] = this.edge.z
    this.linePos[3] = this.fingerWorld.x
    this.linePos[4] = this.fingerWorld.y
    this.linePos[5] = this.fingerWorld.z
    this.line.geometry.attributes.position.needsUpdate = true
    mat.opacity = 0.35 + 0.65 * this.hover.near
  }

  private advancePress(dt: number): void {
    if (!this.pressing) return
    if (this.dropT < 0) {
      this.pressT += dt / PRESS
      if (this.pressT < 1) return
      if (!this.hasDrop.value || REDUCE_MOTION) {
        this.finish()
        return
      }
      const tile = this.tiles[this.pressIndex]
      tile?.getWorldPosition(this.dropFrom)
      this.dropT = 0
      this.drop.visible = true
      this.drop.quaternion.copy(this.group.quaternion)
    }
    this.dropT += dt / DROP
    const u = this.dropT < 0 ? 0 : this.dropT > 1 ? 1 : this.dropT
    const e = 1 - (1 - u) * (1 - u)
    this.drop.position.lerpVectors(this.dropFrom, this.dropTo, e)
    const s = 1 - e * 0.82
    this.drop.scale.set(TILE_W * s, TILE_H * s, 1)
    this.dropMat.uniforms.uFade.value = 1 - e
    this.dropMat.uniforms.uSolid.value = 1
    if (this.dropT < 1) return
    this.drop.visible = false
    this.finish()
  }

  private finish(): void {
    const arrive = this.arrive
    this.arrive = null
    this.pressing = false
    this.pressIndex = -1
    this.dropT = -1
    this.hover = NONE
    arrive?.()
  }

  private paintLabels(): void {
    for (let i = 0; i < this.chromes.length; i++) {
      const mat = this.chromes[i].material
      const mode = DIAL_MODES[i]
      if (mat instanceof MeshBasicMaterial && mat.map && mode) paintChrome(mat.map.image as HTMLCanvasElement, mode)
      if (mat instanceof MeshBasicMaterial && mat.map) mat.map.needsUpdate = true
    }
  }

  private warm(): void {
    const scene = new Scene()
    const stand = new Mesh(sharedTileGeo(), this.fills[0])
    scene.add(stand)
    const cam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
    cam.position.z = 1
    this.renderer.compile(scene, cam)
    stand.removeFromParent()
  }
}

const CHROME_W = 512
const CHROME_H = 214

function paintChrome(canvas: HTMLCanvasElement, mode: DialMode): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, CHROME_W, CHROME_H)
  ctx.strokeStyle = '#fffaf6'
  ctx.lineWidth = 2
  roundRect(ctx, 3, 3, CHROME_W - 6, CHROME_H - 6, 46)
  ctx.stroke()
  ctx.strokeStyle = '#3b241c'
  ctx.fillStyle = '#3b241c'
  ctx.lineWidth = 2
  drawIcon(ctx, mode)
  const label = dialName(mode).toUpperCase()
  ctx.fillStyle = '#3b241c'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.letterSpacing = '1.5px'
  let size = 42
  ctx.font = `500 ${size}px "Hanken Grotesk", "Segoe UI", system-ui, sans-serif`
  while (size > 24 && ctx.measureText(label).width > 330) {
    size -= 2
    ctx.font = `500 ${size}px "Hanken Grotesk", "Segoe UI", system-ui, sans-serif`
  }
  ctx.fillText(label, 108, CHROME_H / 2 + 1)
}

function drawIcon(ctx: CanvasRenderingContext2D, mode: DialMode): void {
  ctx.save()
  ctx.translate(58, CHROME_H / 2)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  switch (mode) {
    case 'echo':
      ctx.globalAlpha = 0.45
      ctx.strokeRect(-16, -8, 22, 10)
      ctx.globalAlpha = 0.75
      ctx.strokeRect(-10, -2, 22, 10)
      ctx.globalAlpha = 1
      ctx.strokeRect(-4, 4, 22, 10)
      break
    case 'slit':
      for (let i = 0; i < 4; i++) {
        ctx.beginPath()
        ctx.moveTo(-14 + i * 10, 16 - i * 4)
        ctx.lineTo(-14 + i * 10, -16 + i * 3)
        ctx.stroke()
      }
      break
    case 'ripple':
      ctx.beginPath()
      ctx.arc(0, 0, 8, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(0, 0, 16, 0, Math.PI * 2)
      ctx.stroke()
      break
    case 'live':
      ctx.beginPath()
      ctx.arc(0, 0, 7, 0, Math.PI * 2)
      ctx.fillStyle = '#3b241c'
      ctx.fill()
      break
    default: {
      const never: never = mode
      void never
    }
  }
  ctx.restore()
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

function chromeMaterial(mode: DialMode): MeshBasicMaterial {
  const canvas = document.createElement('canvas')
  canvas.width = CHROME_W
  canvas.height = CHROME_H
  paintChrome(canvas, mode)
  const map = new CanvasTexture(canvas)
  map.colorSpace = SRGBColorSpace
  map.minFilter = LinearFilter
  map.magFilter = LinearFilter
  map.generateMipmaps = false
  return new MeshBasicMaterial({
    map,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: FrontSide,
  })
}

function tileFill(rgb: readonly [number, number, number], opacity: number, aspect: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Vector3(rgb[0], rgb[1], rgb[2]) },
      uHot: { value: new Vector3(PALETTE.sheen[0], PALETTE.sheen[1], PALETTE.sheen[2]) },
      uSolid: { value: 0 },
      uFade: { value: 1 },
      uBase: { value: opacity },
      uAspect: { value: aspect },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uHot;
      uniform float uSolid;
      uniform float uFade;
      uniform float uBase;
      uniform float uAspect;
      varying vec2 vUv;
      float roundBox(vec2 p, vec2 b, float r) {
        vec2 q = abs(p) - b + vec2(r);
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
      }
      void main() {
        vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
        float d = roundBox(p, vec2(uAspect * 0.5, 0.5), 0.2);
        float inside = smoothstep(0.02, 0.0, d);
        vec3 col = mix(uColor, uHot, uSolid);
        float alpha = mix(uBase, 0.92, uSolid) * uFade * inside;
        gl_FragColor = vec4(col, alpha);
      }`,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: DoubleSide,
  })
}

let tileGeo: PlaneGeometry | null = null
let shadowGeo: PlaneGeometry | null = null

function sharedTileGeo(): PlaneGeometry {
  if (!tileGeo) tileGeo = new PlaneGeometry(TILE_W, TILE_H)
  return tileGeo
}

function sharedShadowGeo(): PlaneGeometry {
  if (!shadowGeo) shadowGeo = new PlaneGeometry(TILE_W * 1.08, TILE_H * 1.2)
  return shadowGeo
}

/** A point on the tile rectangle's boundary, toward the fingertip. */
function edgePoint(px: number, py: number, cx: number, cy: number, out: Vector3): void {
  const dx = px - cx
  const dy = py - cy
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  const hw = TILE_W * 0.5
  const hh = TILE_H * 0.5
  if (ax <= hw && ay <= hh) {
    const dL = hw + dx
    const dR = hw - dx
    const dB = hh + dy
    const dT = hh - dy
    const m = Math.min(dL, dR, dB, dT)
    if (m === dL) out.set(cx - hw, cy, 0.001)
    else if (m === dR) out.set(cx + hw, cy, 0.001)
    else if (m === dB) out.set(cx, cy - hh, 0.001)
    else out.set(cx, cy + hh, 0.001)
    return
  }
  const sx = hw / Math.max(ax, 1e-5)
  const sy = hh / Math.max(ay, 1e-5)
  const s = Math.min(sx, sy)
  out.set(cx + dx * s, cy + dy * s, 0.001)
}
