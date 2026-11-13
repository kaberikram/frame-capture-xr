import {
  ExternalTexture,
  Mesh,
  NearestFilter,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  WebGLRenderTarget,
  type WebGLRenderer,
} from '@iwsdk/core'
import type { ViewRect } from './depth-project.js'

/** What `XRWebGLBinding.getDepthInformation` hands back in a `gpu-optimized` session. */
export interface GpuDepthInfo {
  texture: WebGLTexture | null
  isValid?: boolean
  imageIndex?: number | null
  rawValueToMeters: number
  depthNear: number
  /** Where the depth was seen from, when the headset says so. Otherwise it matches the view. */
  transform?: { matrix: ArrayLike<number> }
  projectionMatrix?: ArrayLike<number>
}

/** Metres are packed into three bytes over this range. */
const RANGE = 16

/** Unpack one reading written by the shader below. 0 means nothing was seen there. */
export function metresFromBytes(r: number, g: number, b: number, a: number): number {
  if (a < 128) return 0
  return (r / 255 + g / 65025 + b / 16581375) * RANGE
}

/**
 * Quest Browser gives depth as a texture, not as numbers a page can read. This
 * draws a small grid of readings from that texture into a tiny target and reads
 * the target back, without holding up the frame.
 *
 * The texture holds depth-buffer values with the far plane at infinity, so
 * metres are `rawValueToMeters * depthNear / (1 - value)`. Its rows run bottom
 * to top, like the screen.
 */
export class GpuDepthReader {
  private readonly target: WebGLRenderTarget
  private readonly source = new ExternalTexture()
  private readonly material: ShaderMaterial
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly bytes: Uint8Array
  private readonly metres: Float32Array
  private busy = false

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.target = new WebGLRenderTarget(cols, rows, {
      depthBuffer: false,
      format: RGBAFormat,
      type: UnsignedByteType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
    })
    this.bytes = new Uint8Array(cols * rows * 4)
    this.metres = new Float32Array(cols * rows)
    this.material = new ShaderMaterial({
      uniforms: {
        uDepth: { value: this.source },
        uLayer: { value: 0 },
        uNear: { value: 0.1 },
        uToMeters: { value: 1 },
        uJitter: { value: [0.5, 0.5] },
        uGrid: { value: [cols, rows] },
        /** The part of the texture the grid covers: left, bottom, width, height. */
        uRect: { value: [0, 0, 1, 1] },
      },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        precision highp float;
        precision highp sampler2DArray;
        uniform sampler2DArray uDepth;
        uniform float uLayer;
        uniform float uNear;
        uniform float uToMeters;
        uniform vec2 uJitter;
        uniform vec2 uGrid;
        uniform vec4 uRect;
        void main() {
          vec2 uv = uRect.xy + (floor(gl_FragCoord.xy) + uJitter) / uGrid * uRect.zw;
          float raw = texture(uDepth, vec3(uv, uLayer)).r;
          if (raw <= 0.0 || raw >= 1.0) {
            gl_FragColor = vec4(0.0);
            return;
          }
          float metres = uToMeters * uNear / (1.0 - raw);
          float t = clamp(metres / ${RANGE.toFixed(1)}, 0.0, 0.999999);
          vec3 enc = fract(t * vec3(1.0, 255.0, 65025.0));
          enc.xy -= enc.yz / 255.0;
          gl_FragColor = vec4(enc, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      toneMapped: false,
    })
    const quad = new Mesh(new PlaneGeometry(2, 2), this.material)
    quad.frustumCulled = false
    this.scene.add(quad)
  }

  /**
   * Read the grid. `jx` and `jy`, each 0..1, pick the place inside every cell.
   * `rect` reads just part of the view, for a close look at one place. The
   * answer is metres for each cell, row 0 at the bottom of that part, and is
   * only good until the next call. Null while an earlier read is still out.
   */
  read(renderer: WebGLRenderer, info: GpuDepthInfo, jx: number, jy: number, rect: ViewRect | null = null): Promise<Float32Array> | null {
    if (this.busy || !info.texture) return null
    this.busy = true
    this.source.sourceTexture = info.texture
    const u = this.material.uniforms
    u.uLayer.value = info.imageIndex ?? 0
    u.uNear.value = info.depthNear
    u.uToMeters.value = info.rawValueToMeters
    u.uJitter.value[0] = jx
    u.uJitter.value[1] = jy
    // A view's rows run top to bottom; the texture's run bottom to top.
    u.uRect.value[0] = rect ? rect.u : 0
    u.uRect.value[1] = rect ? 1 - rect.v - rect.h : 0
    u.uRect.value[2] = rect ? rect.w : 1
    u.uRect.value[3] = rect ? rect.h : 1
    // The headset's own cameras must not be used for this small picture.
    const xr = renderer.xr.enabled
    const before = renderer.getRenderTarget()
    renderer.xr.enabled = false
    renderer.setRenderTarget(this.target)
    renderer.render(this.scene, this.camera)
    renderer.setRenderTarget(before)
    renderer.xr.enabled = xr
    return renderer
      .readRenderTargetPixelsAsync(this.target, 0, 0, this.cols, this.rows, this.bytes)
      .then(() => {
        const { bytes, metres } = this
        for (let i = 0; i < metres.length; i++) {
          const at = i * 4
          metres[i] = metresFromBytes(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
        }
        return metres
      })
      .finally(() => {
        this.busy = false
      })
  }
}
