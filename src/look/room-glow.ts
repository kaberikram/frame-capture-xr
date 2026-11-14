import {
  CustomBlending,
  DoubleSide,
  FrontSide,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector2,
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

/**
 * The headset camera exposes a dim room about a quarter brighter than
 * passthrough shows it, so a peeled wall read cream against the real one.
 * Camera pictures are scaled by this; the desk's renders are not.
 */
const CAMERA_GAIN = '0.8'

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
      const float CAMERA_GAIN = ${CAMERA_GAIN};
      void main() {
        float inside = uR - torn(vP, uSeed);
        if (inside <= 0.0) discard;
        vec2 uv = (vUv - uUvRect.xy) / uUvRect.zw;
        vec3 photo = texture2D(uMap, clamp(uv, 0.0, 1.0)).rgb;
        photo = mix(photo, pow(photo, vec3(1.0 / 2.2)), uEncode);
        // The headset camera exposes a dim room brighter than passthrough shows it.
        photo *= mix(CAMERA_GAIN, 1.0, uEncode);
        // Where the camera did not see, the piece is a warm film instead of a smear.
        float seen = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0) * uHasMap;
        vec3 col = mix(uFilm * 0.86, photo, seen);
        col = mix(col, col * vec3(1.03, 0.99, 0.94) + uWarm * 0.02, 0.6);
        // Seen from behind, the picture shows through, dim and warm, like a paper lantern.
        if (!gl_FrontFacing) col = col * 0.5 + uWarm * 0.2;
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
          vec3 light = mix(uAccent, uGlow, 0.55) * spill * level * 0.5;
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
        // The room shows through: this is light on the wall, not a patch over it.
        gl_FragColor = vec4(col * level * a * 0.5, a * clamp(uOpen * 1.6, 0.0, 1.0) * 0.38);
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
 * to pinch it. With `uRing` it is the plain soft light where a carried piece
 * will come to rest. Drawn on a flat square a little bigger than the light.
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
        // Under a hand: a soft pool that is brightest in the middle. What a pinch
        // would take is shown by its own outline, so the pool has no ring of its own.
        float pool = exp(-pow(r / (uR * 0.75), 2.0)) * 0.3;
        vec3 under = uGlow * pool + uCore * exp(-pow(r / 0.012, 2.0)) * 0.25;
        // Where a carried piece will come to rest: a soft patch of light, with no outline.
        vec3 landing = uGlow * exp(-pow(r / (uR * 0.8), 2.0)) * (0.16 + 0.04 * breathe);
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

/**
 * A thing lifted out of the room: a shell in its real shape, wearing the
 * camera's picture of it. `aEdge` rises to 1 where the shell ends, which fades
 * out softly.
 */
export function shellMaterial(palette: Palette): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uMap: { value: null as Texture | null },
      uUvRect: { value: new Vector4(0, 0, 1, 1) },
      uHasMap: { value: 0 },
      uEncode: { value: 0 },
      uShow: { value: 0 },
      /** Warm light in the shell as it comes away. */
      uHeat: { value: 0 },
      uFilm: { value: vec(palette.haze) },
      uSheen: { value: vec(palette.sheen) },
      uWarm: { value: vec(palette.glow) },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aUv;
      attribute float aEdge;
      varying vec2 vUv;
      varying float vEdge;
      varying vec3 vView;
      varying vec3 vN;
      void main() {
        vUv = aUv;
        vEdge = aEdge;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = mv.xyz;
        vN = normalMatrix * normal;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec4 uUvRect;
      uniform float uHasMap, uEncode, uShow, uHeat;
      uniform vec3 uFilm, uSheen, uWarm;
      varying vec2 vUv;
      varying float vEdge;
      varying vec3 vView;
      varying vec3 vN;
      const float CAMERA_GAIN = ${CAMERA_GAIN};
      void main() {
        float alpha = uShow * (1.0 - smoothstep(0.7, 1.0, vEdge));
        if (alpha < 0.02) discard;
        vec2 uv = (vUv - uUvRect.xy) / uUvRect.zw;
        vec3 photo = texture2D(uMap, clamp(uv, 0.0, 1.0)).rgb;
        photo = mix(photo, pow(photo, vec3(1.0 / 2.2)), uEncode);
        photo *= mix(CAMERA_GAIN, 1.0, uEncode);
        float seen = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0) * uHasMap;
        vec3 col = mix(uFilm * 0.8, photo, seen);
        col = mix(col, col * vec3(1.03, 0.99, 0.94) + uWarm * 0.02, 0.6);
        float facing = abs(dot(normalize(vN), normalize(-vView)));
        float rim = pow(1.0 - facing, 3.0);
        // The far side was never seen. From behind, the picture glows through like a lantern.
        if (!gl_FrontFacing) col = col * 0.5 + uWarm * 0.2;
        col += uSheen * rim * 0.16;
        col += uWarm * uHeat * (0.2 + 0.55 * rim);
        gl_FragColor = vec4(col, alpha);
      }`,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    // The copy starts exactly where the real thing is, and must not flicker against the desk's stand-in.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: DoubleSide,
    toneMapped: false,
  })
}

/**
 * Light on a thing's own shape: a soft edge glow that breathes, with a slow
 * shimmer rising through it. It shows what a pinch would lift, and lingers a
 * moment where a thing was lifted from.
 */
export function auraMaterial(palette: Palette): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uLevel: { value: 0 },
      uTime: { value: 0 },
      /** The lowest point of the shape and its height, in its own space. */
      uLow: { value: 0 },
      uSpan: { value: 1 },
      uGlow: { value: vec(palette.glow) },
      uCore: { value: vec(palette.core) },
    },
    vertexShader: /* glsl */ `
      attribute float aEdge;
      varying float vEdge;
      varying float vY;
      varying vec3 vView;
      varying vec3 vN;
      void main() {
        vEdge = aEdge;
        vY = position.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = mv.xyz;
        vN = normalMatrix * normal;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uLevel, uTime, uLow, uSpan;
      uniform vec3 uGlow, uCore;
      varying float vEdge;
      varying float vY;
      varying vec3 vView;
      varying vec3 vN;
      void main() {
        float facing = abs(dot(normalize(vN), normalize(-vView)));
        float rim = pow(1.0 - facing, 1.6);
        float breathe = 0.86 + 0.14 * sin(uTime * 2.1);
        float h = (vY - uLow) / max(uSpan, 1e-3);
        float sweep = fract(uTime * 0.3) * 1.6 - 0.3;
        float band = exp(-pow((h - sweep) / 0.13, 2.0));
        vec3 col = uGlow * (0.07 + 0.6 * rim) + uCore * (0.22 * rim * rim + 0.1 * band);
        col *= uLevel * breathe * (1.0 - smoothstep(0.6, 1.0, vEdge));
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

/**
 * The ghost of a thing a pinch would lift: the thing's own shell, swelled a
 * few millimetres off the real one, wearing a washed-out copy of its picture,
 * with a bright line where its shape turns away and where it ends. Normal
 * blending with real opacity, so it reads over passthrough in a dim room,
 * where faint added light does not.
 */
export function ghostMaterial(palette: Palette): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uMap: { value: null as Texture | null },
      uUvRect: { value: new Vector4(0, 0, 1, 1) },
      uHasMap: { value: 0 },
      uEncode: { value: 0 },
      /** How present the ghost is, 0..1. */
      uLevel: { value: 0 },
      /** How close the hand is, 0..1: the ghost swells and brightens toward it. */
      uNear: { value: 0 },
      uTime: { value: 0 },
      /** The lowest point of the shape and its height, in its own space, for the light rising through it. */
      uLow: { value: 0 },
      uSpan: { value: 1 },
      uCore: { value: vec(palette.core) },
      uGlow: { value: vec(palette.glow) },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aUv;
      attribute float aEdge;
      uniform float uNear;
      varying vec2 vUv;
      varying float vEdge;
      varying float vY;
      varying vec3 vView;
      varying vec3 vN;
      void main() {
        vUv = aUv;
        vEdge = aEdge;
        vY = position.y;
        // It stands a little proud of the real thing, more as the hand nears, as if coming loose.
        vec3 p = position + normal * (0.003 + 0.007 * uNear);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vView = mv.xyz;
        vN = normalMatrix * normal;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec4 uUvRect;
      uniform float uHasMap, uEncode, uLevel, uNear, uTime, uLow, uSpan;
      uniform vec3 uCore, uGlow;
      varying vec2 vUv;
      varying float vEdge;
      varying float vY;
      varying vec3 vView;
      varying vec3 vN;
      void main() {
        vec2 uv = (vUv - uUvRect.xy) / uUvRect.zw;
        vec3 photo = texture2D(uMap, clamp(uv, 0.0, 1.0)).rgb;
        photo = mix(photo, pow(photo, vec3(1.0 / 2.2)), uEncode);
        float seen = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0) * uHasMap;
        // A washed, lighter copy of the thing: clearly a ghost of it, not the thing.
        vec3 fill = mix(uCore * 0.92, photo * 0.75 + uCore * 0.35, seen);
        float facing = abs(dot(normalize(vN), normalize(-vView)));
        // The outline: where the shape turns away from you, and where it ends.
        float rim = smoothstep(0.55, 0.05, facing);
        float ends = smoothstep(0.35, 0.9, vEdge);
        float line = max(rim, ends);
        // A slow band of light rising through it.
        float h = (vY - uLow) / max(uSpan, 1e-3);
        float sweep = fract(uTime * 0.32) * 1.5 - 0.25;
        float band = exp(-pow((h - sweep) / 0.09, 2.0));
        float breathe = 0.9 + 0.1 * sin(uTime * 2.3);
        vec3 col = mix(fill, mix(uCore, uGlow, 0.25), clamp(line * 0.85 + band * 0.4, 0.0, 1.0));
        float a = (0.2 + 0.16 * uNear) + line * 0.7 + band * 0.18;
        a = clamp(a, 0.0, 0.92) * uLevel * breathe;
        if (a < 0.01) discard;
        gl_FragColor = vec4(col, a);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    // Only the faces turned toward you: a shell's faces all point out of the thing,
    // and drawing the far ones too would stack their opacity unevenly.
    side: FrontSide,
    toneMapped: false,
  })
}

/**
 * The cut a pinch on a bare surface would make, drawn on the surface before
 * the pinch: the exact torn outline the piece will have, a soft groove just
 * outside it, and a faint lift inside that leans toward the fingertip. The
 * line draws itself around from the side nearest the finger when it appears.
 * Drawn on a flat square a little bigger than the piece.
 */
export function cutoutMaterial(palette: Palette, seed: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      /** Metres from the middle of the square to its edge. */
      uHalf: { value: 0.2 },
      uR: { value: 0.1 },
      uSeed: { value: seed },
      uLevel: { value: 0 },
      uNear: { value: 0 },
      /** How far the line has drawn itself around, 0..1. */
      uDraw: { value: 1 },
      /** Where the fingertip is over the square, in its own metres. */
      uHand: { value: new Vector2() },
      uTime: { value: 0 },
      uCore: { value: vec(palette.core) },
      uGlow: { value: vec(palette.glow) },
      uShadow: { value: vec(palette.shadow) },
    },
    vertexShader: /* glsl */ `
      uniform float uHalf;
      varying vec2 vL;
      void main() {
        vL = position.xy * 2.0 * uHalf;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uR, uSeed, uLevel, uNear, uDraw, uTime;
      uniform vec2 uHand;
      uniform vec3 uCore, uGlow, uShadow;
      varying vec2 vL;
      ${TORN}
      void main() {
        float d = uR - torn(vL, uSeed);
        // The line draws around both ways from the side nearest the finger.
        float start = dot(uHand, uHand) > 1e-8 ? atan(uHand.y, uHand.x) : 0.0;
        float ang = abs(mod(atan(vL.y, vL.x) - start + 3.14159265, 6.2831853) - 3.14159265) / 3.14159265;
        float drawn = uDraw >= 1.0 ? 1.0 : 1.0 - smoothstep(uDraw - 0.04, uDraw, ang);
        float line = exp(-pow(d / 0.0024, 2.0)) * drawn;
        float groove = (1.0 - step(0.0, d)) * exp(-pow((d + 0.003) / 0.0035, 2.0)) * drawn;
        float inside = smoothstep(0.0, 0.004, d);
        float toward = 1.0 - clamp(length(vL - uHand) / (uR * 2.2), 0.0, 1.0);
        float lift = inside * (0.07 + 0.13 * toward * uNear) * (0.92 + 0.08 * sin(uTime * 2.1));
        vec3 col = uShadow;
        float a = groove * 0.32;
        col = mix(col, mix(uGlow, uCore, 0.6), clamp(lift * 6.0, 0.0, 1.0));
        a = max(a, lift);
        col = mix(col, uCore, line);
        a = max(a, line * 0.9);
        a *= uLevel;
        if (a < 0.01) discard;
        gl_FragColor = vec4(col, a);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: DoubleSide,
    toneMapped: false,
  })
}
