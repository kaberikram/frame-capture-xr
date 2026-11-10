/**
 * Stays local so the mode math can run under `node --experimental-strip-types`
 * without pulling the app graph in. It matches `queryFlag`.
 */
function queryFlag(name: string): string | null {
  if (typeof location === 'undefined') return null
  return new URLSearchParams(location.search).get(name)
}

/**
 * How the glass inside a frame treats the recent camera frames.
 * `live` is the camera now, so a photo is the ordinary picture.
 * Each effect always runs at full strength.
 */
export const WARP_MODES = ['echo', 'slit', 'ripple', 'live'] as const
export type WarpMode = (typeof WARP_MODES)[number]

/** Slots in the ring. The atlas is a square grid of this many cells. */
export const TIME_SLOTS = 16
/** Cells along one edge of the atlas. `TIME_SLOTS` must be `TIME_COLS` squared. */
export const TIME_COLS = 4
/** Texels on one cell. 16 × 320 × 320 × 4 bytes is about 6.3 MB. */
export const TIME_CELL = 320

export function isWarpMode(value: string | null): value is WarpMode {
  if (!value) return false
  for (let i = 0; i < WARP_MODES.length; i++) if (WARP_MODES[i] === value) return true
  return false
}

export function warpName(mode: WarpMode): string {
  switch (mode) {
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
    case 'echo':
      return 0
    case 'slit':
      return 1
    case 'ripple':
      return 2
    case 'live':
      return 3
    default: {
      const never: never = mode
      return never
    }
  }
}

/** The palm stack. Peel is the room, not a time effect, so a flick does not land on it. */
export const DIAL_MODES = ['echo', 'slit', 'ripple', 'live', 'peel'] as const
export type DialMode = (typeof DIAL_MODES)[number]

export function isDialMode(value: string | null): value is DialMode {
  if (!value) return false
  for (let i = 0; i < DIAL_MODES.length; i++) if (DIAL_MODES[i] === value) return true
  return false
}

export function dialName(mode: DialMode): string {
  switch (mode) {
    case 'peel':
      return 'Peel'
    case 'echo':
    case 'slit':
    case 'ripple':
    case 'live':
      return warpName(mode)
    default: {
      const never: never = mode
      return never
    }
  }
}

export function isTimeDial(mode: DialMode): mode is WarpMode {
  return mode !== 'peel'
}

export function nextWarp(mode: WarpMode): WarpMode {
  switch (mode) {
    case 'echo':
      return 'slit'
    case 'slit':
      return 'ripple'
    case 'ripple':
      return 'live'
    case 'live':
      return 'echo'
    default: {
      const never: never = mode
      return never
    }
  }
}

/** How many slots back from the newest the effect reaches. Always the whole ring. */
export function warpReach(count: number): number {
  return Math.max(0, count - 1)
}

/** Slot `back` steps behind `head`, wrapping through the ring. */
export function slotBehind(head: number, back: number, slots = TIME_SLOTS): number {
  const b = Math.max(0, Math.floor(back))
  return ((head - b) % slots + slots) % slots
}

function reducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** `?warp=echo`. Reduced motion starts on live unless the URL asks. An unknown mode is echo. */
export function initialWarp(): WarpMode {
  const asked = queryFlag('warp')
  if (isWarpMode(asked)) return asked
  return reducedMotion() ? 'live' : 'echo'
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
