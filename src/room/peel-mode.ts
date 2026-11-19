/**
 * How the peel page takes things. `box`: a thing on a table comes away whole,
 * fitted as a box or a round, and a bare surface as a piece of its mesh.
 * `simple`: the peel as it first was, a flat piece of whatever surface is
 * pinched, with nothing shown before the pinch and nothing fitted.
 *
 * Chosen on the launch card. `?simple=1` or `?simple=0` in the address picks
 * one for that visit; otherwise the last choice made on this browser is kept.
 */

export type PeelMode = 'box' | 'simple'

const KEY = 'peel-mode'

let mode: PeelMode = initial()

function initial(): PeelMode {
  if (typeof location !== 'undefined') {
    const asked = new URLSearchParams(location.search).get('simple')
    if (asked === '1') return 'simple'
    if (asked === '0') return 'box'
  }
  try {
    return globalThis.localStorage?.getItem(KEY) === 'simple' ? 'simple' : 'box'
  } catch {
    // Storage can be blocked: start in the default mode.
    return 'box'
  }
}

/** The mode in use. */
export function peelMode(): PeelMode {
  return mode
}

/** Switch mode now, and keep it for the next visit on this browser and for a reload of this address. */
export function setPeelMode(next: PeelMode): void {
  mode = next
  try {
    globalThis.localStorage?.setItem(KEY, next)
  } catch {
    // Not kept for next time; it still holds for this visit.
  }
  if (typeof location === 'undefined' || typeof history === 'undefined') return
  const url = new URL(location.href)
  if (!url.searchParams.has('simple')) return
  // An address that asked for one mode would bring it back on reload: say the new one instead.
  url.searchParams.set('simple', next === 'simple' ? '1' : '0')
  history.replaceState(history.state, '', url)
}
