import {
  CanvasTexture,
  FrontSide,
  Group,
  OrthographicCamera,
  Scene,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  type WebGLRenderer,
} from '@iwsdk/core'
import type { Held } from '../capture/held.js'
import type { Raster } from '../capture/crop.js'
import { TimeHistory, type TimeSource } from '../capture/time-history.js'
import {
  glassCoversPhoto,
  glassVisible,
  initialWarp,
  nextWarp,
  timeMessage,
  warpIndex,
  warpName,
  warpReach,
  TIME_CELL,
  TIME_COLS,
  TIME_SLOTS,
  type GlassState,
  type WarpMode,
} from '../capture/time-mode.js'
import type { LiveRect } from '../input/gesture.js'
import { PALETTE, voice } from './palette.js'

const NOTE_W = 1024
const NOTE_H = 256

/**
 * The rectangle's glass. It samples the ring in `frame` space: a world point
 * on the pane is projected through each stored camera, so a still room lines
 * up and anything that moved is late, trailed, or smeared. Outside the pane
 * the headset's passthrough (or the desk view) is untouched.
 */
export function glassMaterial(): ShaderMaterial {
  const clips = Array.from({ length: TIME_SLOTS }, () => new Matrix4())
  return new ShaderMaterial({
    uniforms: {
      uAtlas: { value: null },
      uClip: { value: clips },
      uHead: { value: 0 },
      uCount: { value: 0 },
      uReach: { value: 0 },
      uMode: { value: 0 },
      uStretch: { value: 1 },
      uFlash: { value: 0 },
      uTime: { value: 0 },
      uHaze: { value: new Vector3(PALETTE.haze[0], PALETTE.haze[1], PALETTE.haze[2]) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vRight;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vRight = normalize(mat3(modelMatrix) * vec3(1.0, 0.0, 0.0));
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: glassFragment(),
    side: FrontSide,
    depthTest: true,
    depthWrite: true,
    transparent: false,
    toneMapped: false,
    fog: false,
  })
}

interface Panes {
  pane: Mesh
  note: Mesh
}

/**
 * Owns the ring, the mode, and one pane per frame. Every effect runs at full
 * strength. `stretch` only widens the pattern while two hands pull the frame.
 */
export class TimeWarp {
  readonly material: ShaderMaterial
  readonly history: TimeHistory
  mode: WarpMode
  /** 1 is the ordinary pattern. Hands pull it wider or narrower. */
  stretch = 1
  /** Fired when the mode changes, with the mode's name. */
  onNote: ((line: string) => void) | null = null
  private flash = 0
  private lastStamp = Number.NaN
  private lastPush = -1
  private message = ''
  private readonly still = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  private logged = false
  private readonly scratch = new Matrix4()
  private readonly noteCanvas = document.createElement('canvas')
  private readonly noteCtx: CanvasRenderingContext2D
  private readonly noteTex: CanvasTexture
  private readonly noteMat: MeshBasicMaterial
  private readonly paneGeo = new PlaneGeometry(1, 1)
  private readonly noteGeo = new PlaneGeometry(0.48, 0.12)
  private readonly drag: Panes
  private readonly panes = new Map<Held, Panes>()

  constructor(
    renderer: WebGLRenderer,
    dragGroup: Group,
    private readonly source: TimeSource,
  ) {
    this.mode = initialWarp()
    this.material = glassMaterial()
    this.history = new TimeHistory(renderer, this.material)
    this.material.uniforms.uAtlas.value = this.history.atlas.texture
    this.material.uniforms.uClip.value = this.history.clips
    this.noteCanvas.width = NOTE_W
    this.noteCanvas.height = NOTE_H
    const ctx = this.noteCanvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas is unavailable')
    this.noteCtx = ctx
    this.noteTex = new CanvasTexture(this.noteCanvas)
    this.noteTex.colorSpace = SRGBColorSpace
    this.noteTex.minFilter = LinearFilter
    this.noteTex.magFilter = LinearFilter
    this.noteTex.generateMipmaps = false
    this.noteMat = new MeshBasicMaterial({ map: this.noteTex, transparent: true, depthWrite: false, depthTest: false })
    this.drag = this.makePanes(dragGroup)
    this.warmShaders(renderer)
    window.addEventListener('keydown', this.onKey)
  }

  /** A photo of the glass, or null to use the live camera (live mode, or no frames yet). */
  capture(held: Held): Raster | null {
    if (this.mode === 'live' || this.history.count < 1) return null
    this.writeUniforms()
    try {
      held.group.updateWorldMatrix(true, false)
      return this.history.snapshot(held.group.matrixWorld, held.width, held.height)
    } catch (error: unknown) {
      console.warn('[frame] time snapshot', error)
      return null
    }
  }

  covers(held: Held): boolean {
    return glassCoversPhoto(stateOf(held))
  }

  /** Copy a new camera frame when one is due, and let the mode-change line fade. */
  update(dt: number, now: number, presenting: boolean, aspect: number): void {
    const video = this.source.liveVideo()
    if (video && this.source.copyClip(this.scratch)) {
      const stamp = this.source.frameStamp()
      const key = stamp ?? now
      if (key !== this.lastStamp && now - this.lastPush >= 1 / 32) {
        this.history.pushVideo(video, this.scratch, now)
        this.lastStamp = key
        this.lastPush = now
      }
    } else if (!presenting && now - this.lastPush >= 0.12) {
      if (this.history.pushRoom(this.source, aspect, now)) this.lastPush = now
    }
    this.flash *= Math.exp(-Math.max(0, dt) / (this.still ? 0.01 : 0.16))
    if (this.flash < 0.01) this.flash = 0
    this.writeUniforms()
    this.paintMessage(timeMessage(this.history.count > 0, presenting, this.source.problem))
    if (!this.logged && this.history.count > 0) {
      this.logged = true
      console.info(`[frame] time window ${TIME_SLOTS}x${TIME_CELL} ${warpName(this.mode).toLowerCase()}`)
    }
  }

  /**
   * Show the glass on the frame being drawn, and on every anchored frame that
   * still has its border.
   */
  sync(drawing: boolean, rect: LiveRect, captures: readonly Held[]): void {
    this.layout(this.drag, rect.halfW * 2, rect.halfH * 2)
    const drawOpen = drawing && rect.valid
    this.drag.pane.visible = drawOpen
    this.drag.note.visible = drawOpen && this.message.length > 0
    const live = new Set(captures)
    for (const [held, panes] of this.panes) {
      if (!live.has(held) || held.frameGone) this.forget(held, panes)
    }
    for (let i = 0; i < captures.length; i++) {
      const held = captures[i]
      if (held.frameGone) continue
      let panes = this.panes.get(held)
      if (!panes) {
        panes = this.makePanes(held.group)
        this.panes.set(held, panes)
      }
      const open = glassVisible(stateOf(held))
      panes.pane.visible = open
      panes.note.visible = open && this.message.length > 0
      this.layout(panes, held.width, held.height)
    }
  }

  debugLine(): string {
    return `time ${this.mode}  ${this.history.count}/${TIME_SLOTS}`
  }

  cycle(): WarpMode {
    this.setMode(nextWarp(this.mode))
    return this.mode
  }

  setMode(mode: WarpMode): void {
    this.mode = mode
    this.flash = this.still ? 0 : 1
    this.note(warpName(mode))
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey)
    this.history.dispose()
    this.material.dispose()
    this.noteMat.dispose()
    this.noteTex.dispose()
    this.paneGeo.dispose()
    this.noteGeo.dispose()
  }

  /** Compile the glass before the first gesture, so that hitch is not mid-pinch. */
  private warmShaders(renderer: WebGLRenderer): void {
    const scene = new Scene()
    scene.add(new Mesh(this.paneGeo, this.material))
    const cam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
    cam.position.z = 1
    renderer.compile(scene, cam)
  }

  private note(line: string): void {
    this.onNote?.(line)
  }

  private writeUniforms(): void {
    const u = this.material.uniforms
    u.uHead.value = this.history.head
    u.uCount.value = this.history.count
    u.uReach.value = warpReach(this.history.count)
    u.uMode.value = warpIndex(this.mode)
    u.uStretch.value = this.stretch
    u.uFlash.value = this.flash
    u.uTime.value = performance.now() / 1000
    this.material.uniformsNeedUpdate = true
  }

  private paintMessage(next: string | null): void {
    const text = next ? voice(next) : ''
    if (text === this.message) return
    this.message = text
    const ctx = this.noteCtx
    ctx.clearRect(0, 0, NOTE_W, NOTE_H)
    if (text) {
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = '300 46px "Hanken Grotesk", "Segoe UI", system-ui, sans-serif'
      const lines = wrap(ctx, text, NOTE_W - 80)
      const lineH = 58
      const top = NOTE_H / 2 - ((lines.length - 1) * lineH) / 2
      ctx.shadowColor = PALETTE.captionGlow
      ctx.shadowBlur = 18
      ctx.fillStyle = PALETTE.captionInk
      for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], NOTE_W / 2, top + i * lineH, NOTE_W - 64)
    }
    this.noteTex.needsUpdate = true
  }

  private layout(panes: Panes, width: number, height: number): void {
    const w = Math.max(width, 0.02)
    const h = Math.max(height, 0.02)
    panes.pane.scale.set(w, h, 1)
    panes.pane.position.set(0, 0, 0.0015)
    const noteW = Math.min(Math.max(w * 0.88, 0.14), 0.52)
    const fit = noteW / 0.48
    panes.note.scale.set(fit, fit, 1)
    panes.note.position.set(0, 0, 0.009)
  }

  private makePanes(parent: Group): Panes {
    const pane = new Mesh(this.paneGeo, this.material)
    pane.name = 'time-pane'
    pane.userData.timeGlass = true
    pane.frustumCulled = false
    pane.renderOrder = 3
    const note = new Mesh(this.noteGeo, this.noteMat)
    note.name = 'time-note'
    note.userData.timeGlass = true
    note.frustumCulled = false
    note.renderOrder = 9
    note.visible = false
    parent.add(pane, note)
    return { pane, note }
  }

  private forget(held: Held, panes: Panes): void {
    panes.pane.removeFromParent()
    panes.note.removeFromParent()
    this.panes.delete(held)
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key
    if (key === '1') this.setMode('echo')
    else if (key === '2') this.setMode('slit')
    else if (key === '3') this.setMode('ripple')
    else if (key === '4') this.setMode('live')
    else if (key === 't' || key === 'T') {
      if (event.repeat) return
      this.cycle()
    }
  }
}

export function stateOf(held: Held): GlassState {
  return {
    frameGone: held.frameGone,
    flat: held.flat,
    idle: held.mode === 'idle',
    photoReady: held.raster !== null,
    pop: held.pop,
    developT: held.developT,
  }
}

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let line = ''
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i]
    if (line && ctx.measureText(next).width > max) {
      lines.push(line)
      line = words[i]
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : ['']
}

function glassFragment(): string {
  let chain = ''
  for (let i = 0; i < TIME_SLOTS; i++) chain += `  if (slot == ${i}) return uClip[${i}];\n`
  const inv = (1 / TIME_COLS).toFixed(6)
  const inset = (0.5 / TIME_CELL).toFixed(6)
  return /* glsl */ `
    uniform sampler2D uAtlas;
    uniform mat4 uClip[${TIME_SLOTS}];
    uniform float uHead;
    uniform float uCount;
    uniform float uReach;
    uniform float uMode;
    uniform float uStretch;
    uniform float uFlash;
    uniform float uTime;
    uniform vec3 uHaze;
    varying vec3 vWorld;
    varying vec3 vRight;
    varying vec2 vUv;

    mat4 clipAt(int slot) {
      ${chain}
      return uClip[0];
    }

    int wrapSlot(float back) {
      float w = mod(uHead - back + ${TIME_SLOTS}.0 * 2.0, ${TIME_SLOTS}.0);
      if (w < 0.0) w += ${TIME_SLOTS}.0;
      if (w >= ${TIME_SLOTS}.0) w = 0.0;
      return int(w);
    }

    vec3 sampleSlot(int slot, vec3 world) {
      vec4 c = clipAt(slot) * vec4(world, 1.0);
      if (c.w <= 0.001) return uHaze;
      vec2 uv = c.xy / c.w * 0.5 + 0.5;
      float inside = smoothstep(-0.02, 0.0, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
      vec2 uvi = clamp(uv, vec2(${inset}), vec2(1.0 - ${inset}));
      float s = float(slot);
      vec2 cell = vec2(mod(s, ${TIME_COLS}.0), floor(s / ${TIME_COLS}.0));
      vec3 tex = texture2D(uAtlas, (cell + uvi) * ${inv}).rgb;
      return mix(uHaze, tex, inside);
    }

    vec3 sampleBack(float back, vec3 world) {
      float maxBack = max(uCount - 1.0, 0.0);
      float b = clamp(back, 0.0, maxBack);
      float f = fract(b);
      float i0 = floor(b);
      float i1 = min(i0 + 1.0, maxBack);
      return mix(sampleSlot(wrapSlot(i0), world), sampleSlot(wrapSlot(i1), world), f);
    }

    vec3 echoAt(vec3 world) {
      vec3 col = sampleBack(0.0, world);
      for (int i = 1; i < 6; i++) {
        float back = uReach * float(i) / 6.0;
        vec3 past = sampleSlot(wrapSlot(back), world);
        float diff = length(past - col);
        float w = exp(-float(i) * 0.34) * smoothstep(0.025, 0.2, diff);
        col = mix(col, past, clamp(w, 0.0, 0.82));
      }
      return col;
    }

    void main() {
      if (uCount < 0.5) {
        gl_FragColor = vec4(uHaze, 1.0);
        return;
      }
      float stretch = max(uStretch, 0.35);
      vec2 suv = (vUv - 0.5) / stretch + 0.5;
      vec3 echoWorld = vWorld + vRight * (uStretch - 1.0) * (vUv.x - 0.5) * 0.42;
      vec3 col;
      if (uMode < 0.5) col = echoAt(echoWorld);
      else if (uMode < 1.5) col = sampleBack((1.0 - clamp(suv.x, 0.0, 1.0)) * uReach, vWorld);
      else if (uMode < 2.5) {
        float d = length((vUv - 0.5) / stretch);
        float wave = 0.5 + 0.5 * sin(d * 26.0 - uTime * 2.1);
        col = sampleBack(wave * uReach, vWorld);
      } else col = sampleSlot(wrapSlot(0.0), vWorld);
      if (uMode < 2.5) col = mix(col, col * vec3(1.05, 0.97, 0.91) + uHaze * 0.045, 0.22);
      col += uHaze * smoothstep(0.04, 0.5, abs(uStretch - 1.0)) * 0.1;
      float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
      float aa = max(fwidth(edge), 0.001);
      col = mix(uHaze, col, smoothstep(0.0, aa * 1.5, edge));
      float sweep = abs(edge - 0.04);
      col = mix(col, vec3(1.0), (1.0 - smoothstep(0.0, 0.012, sweep)) * uFlash);
      gl_FragColor = vec4(col, 1.0);
    }`
}
