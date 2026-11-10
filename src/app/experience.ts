/**
 * `/clean` is the same experience with no guide, captions, or step prompts.
 * The path is what the page was opened as, so a refresh stays clean.
 */
export const CLEAN = typeof location !== 'undefined' && /\/clean\/?$/.test(location.pathname)

/**
 * `/peel` is its own page: the room peels, and nothing else happens there.
 * `/` is frame capture. `?mode=peel` does the same on a host without the
 * rewrite, and the older `?warp=peel` link still lands here.
 */
export const PEEL = (() => {
  if (typeof location === 'undefined') return false
  if (/\/peel(\/clean)?\/?$/.test(location.pathname)) return true
  const query = new URLSearchParams(location.search)
  return query.get('mode') === 'peel' || query.get('warp') === 'peel'
})()

/**
 * `?preview=1` keeps the desk stand-in even when the dev server’s emulator
 * makes the page look like a headset.
 */
export const PREVIEW_FORCED = typeof location !== 'undefined' && new URLSearchParams(location.search).has('preview')

/** `?cam=1` uses a webcam for the photo instead of a render of the stand-in room. */
export const WEBCAM_REQUESTED = typeof location !== 'undefined' && new URLSearchParams(location.search).get('cam') === '1'

/** `?hands=1` shows IWSDK's tracked hand models over the passthrough hands. */
export const HAND_MODELS = typeof location !== 'undefined' && new URLSearchParams(location.search).get('hands') === '1'

/**
 * `?peel=1.3` makes a sticker take 30% more pull to peel and pop free, `?peel=0.8`
 * less. 1 by default, kept within 0.5–2.
 */
export const PEEL_SCALE = (() => {
  const value = typeof location === 'undefined' ? NaN : Number(new URLSearchParams(location.search).get('peel'))
  return Number.isFinite(value) && value > 0 ? Math.min(2, Math.max(0.5, value)) : 1
})()

/** `?ui=0` hides the launch card. `?at=draw|photo|side` and `?shot=1` drive the desk demo. */
export function queryFlag(name: string): string | null {
  if (typeof location === 'undefined') return null
  return new URLSearchParams(location.search).get(name)
}

/**
 * `camera-access` and `depth-sensing` are optional. Quest Browser rejects the
 * session when either is required, and ignores a session that never asks.
 * A build that refuses one of them is started again without that token.
 * Only the peel page asks for depth, so frame capture does not pay for it.
 */
export function launchSession(launch: () => void, requestCamera: boolean, requestDepth: boolean): void {
  const xr = navigator.xr
  if (!requestCamera || !xr) {
    launch()
    return
  }
  const original = xr.requestSession.bind(xr)
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    xr.requestSession = original
  }
  xr.requestSession = ((sessionMode, init) => {
    restore()
    return requestWith(original, sessionMode, init, true, requestDepth)
  }) as typeof xr.requestSession
  try {
    launch()
  } finally {
    restore()
  }
}

type SessionInit = XRSessionInit & {
  depthSensing?: { usagePreference: string[]; dataFormatPreference: string[] }
}

function requestWith(
  original: XRSystem['requestSession'],
  mode: XRSessionMode,
  init: XRSessionInit | undefined,
  camera: boolean,
  depth: boolean,
): Promise<XRSession> {
  const next: SessionInit = { ...init, optionalFeatures: [...(init?.optionalFeatures ?? [])] }
  if (camera && !next.optionalFeatures?.includes('camera-access')) next.optionalFeatures?.push('camera-access')
  if (depth && !next.optionalFeatures?.includes('depth-sensing')) next.optionalFeatures?.push('depth-sensing')
  if (depth) {
    next.depthSensing = {
      usagePreference: ['cpu-optimized', 'gpu-optimized'],
      dataFormatPreference: ['luminance-alpha', 'float32'],
    }
  }
  return original(mode, next).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (depth && /depth/i.test(message)) {
      console.warn(`[frame] session refused depth-sensing, retrying without it: ${message}`)
      return requestWith(original, mode, init, camera, false)
    }
    if (camera && /camera-access/i.test(message)) {
      console.warn(`[frame] session refused camera-access, retrying without it: ${message}`)
      return requestWith(original, mode, init, false, depth)
    }
    throw error
  })
}
