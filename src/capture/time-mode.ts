/**
 * These two stay local so the mode math can run under `node --experimental-strip-types`
 * without pulling the app graph in. They match `clamp` and `queryFlag`.
 */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function queryFlag(name: string): string | null {
  if (typeof location === 'undefined') return null
  return new URLSearchParams(location.search).get(name)
}

/**
 * How the glass inside a frame treats the recent camera frames.
 * `live` is the camera now, so a photo is the ordinary picture.
 */
export const WARP_MODES = ['slow', 'echo', 'slit', 'ripple', 'live'] as const
export type WarpMode = (typeof WARP_MODES)[number]

/** Slots in the ring. The atlas is a square grid of this many cells. */
export const TIME_SLOTS = 16
/** Cells along one edge of the atlas. `TIME_SLOTS` must be `TIME_COLS` squared. */
export const TIME_COLS = 4
/** Texels on one cell. 16 × 320 × 320 × 4 bytes is about 6.3 MB. */
export const TIME_CELL = 320

export function isWarpMode(value: string | null): value is WarpMode {
  return value === 'slow' || value === 'echo' || value === 'slit' || value === 'ripple' || value === 'live'
}

export function warpName(mode: WarpMode): string {
  switch (mode) {
    case 'slow':
      return 'Slow motion'
    case 'echo':
      return 'Echo'
    case 'slit':
      return 'Slit scan'
    case 'ripple':
      return 'Ripple'
    case 'live':
      return 'Live'
    default: {
      const never: never = mode
      return never
    }
  }
}

export function warpIndex(mode: WarpMode): number {
  switch (mode) {
    case 'slow':
      return 0
    case 'echo':
      return 1
    case 'slit':
      return 2
    case 'ripple':
      return 3
    case 'live':
      return 4
    default: {
      const never: never = mode
      return never
    }
  }
}

export function nextWarp(mode: WarpMode): WarpMode {
  switch (mode) {
    case 'slow':
      return 'echo'
    case 'echo':
      return 'slit'
    case 'slit':
      return 'ripple'
    case 'ripple':
      return 'live'
    case 'live':
      return 'slow'
    default: {
      const never: never = mode
      return never
    }
  }
}

/** How many slots back from the newest the effect may reach. */
export function warpReach(intensity: number, count: number): number {
  const span = Math.max(0, count - 1)
  return (0.3 + 0.7 * clamp(intensity, 0, 1)) * span
}

/**
 * Fraction of real time the slow playback moves through the ring.
 * 0.5 is a gentle lag; 0.12 stretches the buffered moment out.
 */
export function slowPlayback(intensity: number): number {
  return 0.5 - 0.38 * clamp(intensity, 0, 1)
}

/** Slot `back` steps behind `head`, wrapping through the ring. */
export function slotBehind(head: number, back: number, slots = TIME_SLOTS): number {
  const b = Math.max(0, Math.floor(back))
  return ((head - b) % slots + slots) % slots
}

/** Advance a playback head that loops inside `reach` slots. */
export function advancePlay(play: number, dt: number, slotsPerSec: number, reach: number): number {
  if (reach <= 0.001) return 0
  const next = play + Math.max(0, dt) * Math.max(0, slotsPerSec)
  if (next < reach) return next
  return next % reach
}

export function clampIntensity(value: number): number {
  return clamp(value, 0.12, 1)
}

function reducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** `?warp=echo&warpamt=0.8`. Reduced motion starts on live unless the URL asks. */
export function initialWarp(): { mode: WarpMode; intensity: number } {
  const asked = queryFlag('warp')
  const mode = isWarpMode(asked) ? asked : reducedMotion() ? 'live' : 'slow'
  const raw = queryFlag('warpamt')
  const amount = raw === null ? Number.NaN : Number(raw)
  const intensity = Number.isFinite(amount) ? clampIntensity(amount) : 0.62
  return { mode, intensity }
}

export interface GlassState {
  frameGone: boolean
  flat: boolean
  idle: boolean
  /** A photo has arrived. Independent of whether the mesh is currently drawn. */
  photoReady: boolean
  /** 0..1 through the relief bloom, without the overshoot. */
  pop: number
  /** Seconds since the photo arrived, or -1 before it. */
  developT: number
}

/**
 * The glass shows while a frame is empty, and again once the photo has
 * finished blooming. During the bloom the photo has the frame to itself.
 */
export function glassVisible(s: GlassState): boolean {
  if (s.frameGone || !s.idle) return false
  if (!s.photoReady) return true
  if (s.flat) return false
  return s.pop >= 1 && s.developT >= 0.75
}

/** The glass is up and a photo exists, so the print should step aside until a peel. */
export function glassCoversPhoto(s: GlassState): boolean {
  return s.photoReady && glassVisible(s)
}

/**
 * Words for the glass when the headset camera is missing. Null when the ring
 * is playing, or on the desk, where the stand-in room fills the window.
 * A problem is shown even if a few old frames are still in the ring.
 */
export function timeMessage(ready: boolean, presenting: boolean, problem: string | null): string | null {
  if (!presenting) return null
  if (problem) return problem
  if (!ready) return 'Waiting for the camera'
  return null
}

/** What a pinch on the mode mark talks to. The slide is in the frame's local x, metres. */
export interface TimeControls {
  beginSlide(originX: number): void
  slide(x: number): void
  finishSlide(): void
}
