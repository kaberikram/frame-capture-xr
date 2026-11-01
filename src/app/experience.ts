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
 * `camera-access` is optional: Quest Browser rejects the session when it is required,
 * and ignores a session that never asks. If a build rejects the token, start again without it.
 */
export function launchSession(launch: () => void, requestCamera: boolean): void {
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
    const optional = [...(init?.optionalFeatures ?? [])]
    if (!optional.includes('camera-access')) optional.push('camera-access')
    return original(sessionMode, { ...init, optionalFeatures: optional }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (!/camera-access/i.test(message)) throw error
      console.warn(`[frame] session refused camera-access, retrying without it: ${message}`)
      return original(sessionMode, init)
    })
  }) as typeof xr.requestSession
  try {
    launch()
  } finally {
    restore()
  }
}
