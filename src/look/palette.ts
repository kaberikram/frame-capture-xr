import { queryFlag } from '../app/experience.js'

/**
 * Every colour the app draws comes from one of these. `?look=her` or
 * `?look=neutral` overrides the default, so both can be compared in the headset.
 * Values are sRGB 0..1 so shaders can use them as they are.
 */
export type LookName = 'her' | 'neutral'

export interface Palette {
  name: LookName
  /** The frame's line. */
  core: Rgb
  /** The light that falls off around the line, the pinch light, and the motes. */
  glow: Rgb
  /** The contact ring and the strongest touches of colour. */
  accent: Rgb
  /** Contact shadow under a stuck sticker. */
  shadow: Rgb
  /** What a photo develops out of. */
  haze: Rgb
  /** Glossy highlights on the photo. */
  sheen: Rgb
  /** Mixed with `glow` for the dissolve's motes. */
  mote: Rgb
  /** The faint wash inside a frame while it is drawn. */
  tint: Rgb
  /** Captions are lowercase in the warm look. */
  lowercase: boolean
  /** CSS for caption text and its glow. */
  captionInk: string
  captionGlow: string
}

export type Rgb = readonly [number, number, number]

function hex(value: string): Rgb {
  const n = parseInt(value.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export const PALETTES: Record<LookName, Palette> = {
  her: {
    name: 'her',
    core: hex('#FFF6EC'),
    glow: hex('#FFB38A'),
    accent: hex('#E8604C'),
    shadow: hex('#2A1A14'),
    haze: hex('#FFD2B8'),
    sheen: hex('#FFE6D4'),
    mote: hex('#FFF6EC'),
    tint: hex('#FFB38A'),
    lowercase: true,
    captionInk: '#FFF6EC',
    captionGlow: 'rgba(255, 140, 100, 0.75)',
  },
  neutral: {
    name: 'neutral',
    core: hex('#FFFFFF'),
    glow: hex('#EEF2F6'),
    accent: hex('#FFFFFF'),
    shadow: hex('#10141A'),
    haze: hex('#F2F4F7'),
    sheen: hex('#FFFFFF'),
    mote: hex('#E6ECF2'),
    tint: hex('#FFFFFF'),
    lowercase: false,
    captionInk: '#FFFFFF',
    captionGlow: 'rgba(0, 0, 0, 0.6)',
  },
}

/** Provisional until the look comparison is decided. Both stay reachable with ?look=. */
export const DEFAULT_LOOK: LookName = 'her'

export function readPalette(): Palette {
  const asked = queryFlag('look')
  if (asked === 'her' || asked === 'neutral') return PALETTES[asked]
  return PALETTES[DEFAULT_LOOK]
}

export const PALETTE = readPalette()
