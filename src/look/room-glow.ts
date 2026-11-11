import {
  CustomBlending,
  DoubleSide,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector3,
  Vector4,
  type Texture,
} from '@iwsdk/core'
import { RIM_LIFT } from '../room/patch.js'
import type { Palette } from './palette.js'

/**
 * The three things the room peel draws: the piece that comes away, the warm
 * light left where it was, and the pool of light that gathers under a hand.
 * The piece and the light share one torn outline, so the hole is exactly the
 * shape of what left it.
 */

/**
 * Distance from the pinch, in metres, with a torn wobble: a few broad lobes so
 * no two pieces are the same shape, and fine tooth so the edge reads as paper.
 * `seed` differs per piece.
 */
const TORN = /* glsl */ `
  float rpHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float rpNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(rpHash(i), rpHash(i + vec2(1.0, 0.0)), f.x), mix(rpHash(i + vec2(0.0, 1.0)), rpHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float torn(vec2 p, float seed) {
    float len = length(p);
    vec2 dir = p / max(len, 1e-4);
    float lobes = rpNoise(dir * 1.9 + seed) - 0.5;
    float tooth = rpNoise(p * 46.0 + seed * 3.1) * 0.65 + rpNoise(p * 120.0 + seed * 7.3) * 0.35 - 0.5;
    return len * (1.0 + 0.3 * lobes) + tooth * 0.011;
  }
`

function vec(rgb: readonly [number, number, number]): Vector3 {
  return new Vector3(rgb[0], rgb[1], rgb[2])
}

/**
 * The piece. Its vertices sit on a grid in the pinch plane, with the height of
 * the real surface at each one, so a table edge or a cushion keeps its shape.
 * `uPull` is where the fingers have taken the middle; the rim follows a little,
 * and the whole piece follows once it is free.
 */
export function pieceMaterial(palette: Palette, seed: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uMap: { value: null as Texture | null },
      /** Offset and size of the piece's crop within the picture it was first mapped to. */
      uUvRect: { value: new Vector4(0, 0, 1, 1) },
      uHasMap: { value: 0 },
      /** 1 when the picture is a render in linear light, which must be encoded for the screen. */
      uEncode: { value: 0 },
      uR: { value: 0 },
      uSeed: { value: seed },
      uPull: { value: new Vector3() },
      uFree: { value: 0 },
      uLand: { value: 0 },
      uSquish: { value: 1 },
      uShow: { value: 0 },
      uFloat: { value: 0 },
      uTime: { value: 0 },
      uRim: { value: RIM_LIFT },
      uPaper: { value: vec(palette.core) },
      uFilm: { value: vec(palette.haze) },
      uSheen: { value: vec(palette.sheen) },
      uWarm: { value: vec(palette.glow) },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aUv;
      attribute float aH0;
      attribute float aH1;
      uniform vec3 uPull;
      uniform float uR, uFree, uLand, uSquish, uRim, uFloat, uTime;
      varying vec2 vP;
      varying vec2 vUv;
      varying vec3 vView;
      void main() {
        vec2 p = position.xy;
        vP = p;
        vUv = aUv;
        float k = clamp(length(p) / max(uR, 1e-4), 0.0, 1.0);
        float bump = 1.0 - k * k * (3.0 - 2.0 * k);
        float held = uRim + (1.0 - uRim) * bump;
        float w = mix(held, 1.0, uFree);
        float h = mix(aH0, aH1, uLand);
        vec3 q = vec3(p * uSquish, h) + uPull * w;
        // A free piece breathes a little, like paper in still air.
        q.z += uFloat * 0.0022 * sin(uTime * 1.3 + p.x * 16.0 + p.y * 11.0);
        vec4 mv = modelViewMatrix * vec4(q, 1.0);
        vView = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec4 uUvRect;
      uniform float uHasMap, uEncode, uR, uSeed, uShow, uFree;
      uniform vec3 uPaper, uFilm, uSheen, uWarm;
      varying vec2 vP;
      varying vec2 vUv;
      varying vec3 vView;
      ${TORN}
      void main() {
        float inside = uR - torn(vP, uSeed);
        if (inside <= 0.0) discard;
        vec2 uv = (vUv - uUvRect.xy) / uUvRect.zw;
        vec3 photo = texture2D(uMap, clamp(uv, 0.0, 1.0)).rgb;
        photo = mix(photo, pow(photo, vec3(1.0 / 2.2)), uEncode);
        // Where the camera did not see, the piece is a warm film instead of a smear.
        float seen = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0) * uHasMap;
        vec3 col = mix(uFilm * 0.86, photo, seen);
        col = mix(col, col * vec3(1.03, 0.99, 0.94) + uWarm * 0.02, 0.6);
        // The back of the piece is plain paper.
        if (!gl_FrontFacing) col = uPaper * 0.9;
        // A soft gloss where the piece turns away from you, so its shape reads.
        vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
        float facing = abs(dot(n, normalize(-vView)));
        col += uSheen * pow(1.0 - facing, 3.0) * 0.22;
        // A torn edge shows the paper it is made of.
        float lip = 1.0 - smoothstep(0.0012, 0.0045, inside);
        col = mix(col, uPaper, lip * 0.85);
        float alpha = smoothstep(0.0, 0.0012, inside) * uShow;
        gl_FragColor = vec4(col, alpha);
      }`,
    transparent: true,
    depthWrite: false,
    // Passthrough has no depth to hide behind, and the desk's stand-in must not cut into it.
    depthTest: false,
    side: DoubleSide,
    toneMapped: false,
  })
}

/**
 * Warm light where the room was peeled. The opening has the piece's own torn
 * outline. Looking in at an angle shows a little of its side, lit from inside,
 * so the wall seems to have thickness. Light spills a few centimetres onto the
 * wall around it.
 */
export function holeMaterial(palette: Palette, seed: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uR: { value: 0 },
      uSeed: { value: seed },
      uOpen: { value: 0 },
      uTime: { value: 0 },
      uDepth: { value: 0.028 },
      uCore: { value: vec(palette.core) },
      uGlow: { value: vec(palette.glow) },
      uAccent: { value: vec(palette.accent) },
      uShadow: { value: vec(palette.shadow) },
    },
    vertexShader: /* glsl */ `
      attribute float aH0;
      varying vec2 vP;
      varying vec3 vToEye;
      void main() {
        vP = position.xy;
        vec4 world = modelMatrix * vec4(position.xy, aH0 + 0.002, 1.0);
        // The view direction in the opening's own axes: x and y across it, z out of the wall.
        vToEye = (cameraPosition - world.xyz) * mat3(modelMatrix);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uR, uSeed, uOpen, uTime, uDepth;
      uniform vec3 uCore, uGlow, uAccent, uShadow;
      varying vec2 vP;
      varying vec3 vToEye;
      ${TORN}
      void main() {
        float lip = uR - torn(vP, uSeed);
        float breathe = 0.94 + 0.06 * sin(uTime * 1.5 + uSeed);
        float level = uOpen * breathe;
        if (lip <= 0.0) {
          // Light on the wall around the opening.
          // It dies away before the edge of the square the light is drawn on.
          float within = 1.0 - smoothstep(0.14, 0.195, max(abs(vP.x), abs(vP.y)));
          float spill = (exp(lip / 0.018) * 0.55 + exp(lip / 0.06) * 0.12) * within;
          vec3 light = mix(uAccent, uGlow, 0.55) * spill * level;
          if (spill * level < 0.004) discard;
          gl_FragColor = vec4(light, 0.0);
          return;
        }
        vec3 eye = normalize(vToEye);
        vec2 shift = eye.xy / max(eye.z, 0.3) * uDepth;
        vec2 back = vP - shift;
        float backLip = uR - torn(back, uSeed);
        vec3 col;
        if (backLip > 0.0) {
          // The back of the hollow: the light itself, creamy in the middle.
          float r = clamp(length(back) / max(uR, 1e-4), 0.0, 1.0);
          float shimmer = 0.92 + 0.16 * rpNoise(back * 26.0 + vec2(uTime * 0.21, -uTime * 0.17));
          col = mix(uCore, uGlow, smoothstep(0.0, 0.7, r));
          col = mix(col, uAccent, smoothstep(0.55, 1.05, r) * 0.6) * shimmer;
        } else {
          // The side of the hollow: dark at the lip, lit deeper in.
          float deep = clamp(lip / max(lip - backLip, 1e-5), 0.0, 1.0);
          col = mix(mix(uShadow, uAccent, 0.45), mix(uAccent, uGlow, 0.6), deep);
        }
        // A bright thread right at the torn rim.
        col += uCore * (1.0 - smoothstep(0.0, 0.004, lip)) * 0.35;
        float a = smoothstep(0.0, 0.0015, lip);
        gl_FragColor = vec4(col * level * a, a * clamp(uOpen * 1.6, 0.0, 1.0));
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: DoubleSide,
    toneMapped: false,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  })
}

/**
 * A soft pool of warm light on a surface, under a hand that is close enough
 * to pinch it. With `uRing` it is the outline of where a carried piece will
 * land. Drawn on a flat square a little bigger than the light.
 */
export function poolMaterial(palette: Palette): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      /** Metres from the middle of the square to its edge. */
      uHalf: { value: 0.2 },
      uR: { value: 0.1 },
      uLevel: { value: 0 },
      uRing: { value: 0 },
      uTime: { value: 0 },
      uGlow: { value: vec(palette.glow) },
      uCore: { value: vec(palette.core) },
      uAccent: { value: vec(palette.accent) },
    },
    vertexShader: /* glsl */ `
      uniform float uHalf;
      varying vec2 vL;
      void main() {
        vL = position.xy * 2.0 * uHalf;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uR, uLevel, uRing, uTime;
      uniform vec3 uGlow, uCore, uAccent;
      varying vec2 vL;
      void main() {
        float r = length(vL);
        float breathe = 0.5 + 0.5 * sin(uTime * 2.4);
        // Under a hand: a pool that is brightest in the middle, with a faint ring drawing in.
        float pool = exp(-pow(r / (uR * 0.75), 2.0)) * 0.3;
        float draw = uR * (0.55 + 0.45 * fract(1.0 - uTime * 0.45));
        float ripple = exp(-pow((r - draw) / 0.006, 2.0)) * 0.12 * (1.0 - fract(1.0 - uTime * 0.45));
        vec3 under = uGlow * pool + uCore * (ripple + exp(-pow(r / 0.012, 2.0)) * 0.25);
        // Where a piece will land: its outline, breathing.
        float edge = uR * (0.97 + 0.03 * breathe);
        float line = exp(-pow((r - edge) / 0.005, 2.0)) * (0.5 + 0.3 * breathe);
        float fill = (1.0 - smoothstep(edge * 0.7, edge, r)) * 0.07;
        vec3 landing = mix(uGlow, uCore, 0.5) * line + uGlow * fill;
        vec3 col = mix(under, landing, uRing) * uLevel;
        if (max(col.r, max(col.g, col.b)) < 0.003) discard;
        gl_FragColor = vec4(col, 0.0);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: DoubleSide,
    toneMapped: false,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  })
}

/** A brief sparkle on the scan where the room has just been read, and nothing otherwise. */
export function sparkleMaterial(palette: Palette): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uGlow: { value: vec(palette.glow) },
    },
    vertexShader: /* glsl */ `
      attribute float aBorn;
      uniform float uTime;
      varying float vFresh;
      varying vec3 vWorld;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        vFresh = clamp(1.0 - (uTime - aBorn) / 1.2, 0.0, 1.0);
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uGlow;
      uniform float uTime;
      varying float vFresh;
      varying vec3 vWorld;
      void main() {
        if (vFresh <= 0.01) discard;
        float grain = fract(sin(dot(floor(vWorld.xy * 90.0) + floor(vWorld.z * 90.0), vec2(12.9898, 78.233))) * 43758.5453);
        float glint = step(0.93, grain) * vFresh * vFresh;
        if (glint < 0.01) discard;
        gl_FragColor = vec4(uGlow * glint * 0.5, 0.0);
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  })
}
