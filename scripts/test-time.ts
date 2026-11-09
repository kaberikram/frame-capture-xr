import {
  glassCoversPhoto,
  glassVisible,
  initialWarp,
  nextWarp,
  slotBehind,
  timeMessage,
  warpIndex,
  warpName,
  warpReach,
  WARP_MODES,
  type GlassState,
  type WarpMode,
} from '../src/capture/time-mode.ts'
import {
  easeToward,
  flickCross,
  onRim,
  palmShown,
  stretchScale,
  tileCenter,
  tilePick,
} from '../src/interaction/time-gestures.ts'

function assert(ok: boolean, message: string): void {
  if (!ok) throw new Error(message)
}

const order: WarpMode[] = ['echo', 'slit', 'ripple', 'live']
assert(WARP_MODES.join() === order.join(), 'the mode list drifted')
let mode: WarpMode = 'echo'
for (let i = 0; i < order.length; i++) {
  assert(warpIndex(mode) === i, `${mode} index`)
  assert(warpName(mode).length > 0, `${mode} name`)
  mode = nextWarp(mode)
}
assert(mode === 'echo', 'the cycle returns to echo')

assert(slotBehind(3, 5, 16) === 14, `slot 5 behind 3 should be 14, got ${slotBehind(3, 5, 16)}`)
assert(slotBehind(5, 15, 16) === 6, `the oldest full-ring slot should be just after the head, got ${slotBehind(5, 15, 16)}`)
assert(slotBehind(0, 0) === 0, 'zero steps back is the head')

assert(warpReach(16) === 15, 'a full ring reaches the oldest slot')
assert(warpReach(1) === 0, 'one frame has no past')
assert(initialWarp() === 'echo', `a plain launch is echo, got ${initialWarp()}`)

assert(stretchScale(0.2, 0.2) === 1, 'hands that have not moved leave the pattern alone')
assert(stretchScale(0.2, 0.4) === 1.8, 'pulling apart widens the pattern, up to a limit')
assert(stretchScale(0.2, 0.08) === 0.55, 'pushing together narrows it, down to a limit')
assert(easeToward(0, 1, 0, 0.1) === 0, 'no time means no change')
assert(easeToward(0, 1, 1, 0.0001) === 1, 'a tiny tau snaps')

assert(!flickCross(0.02, -0.02, 0.1), 'a hitch is not a flick')
assert(!flickCross(0.02, 0.01, 0.016), 'staying on one side is not a flick')
assert(flickCross(0.02, -0.01, 0.016), 'a quick crossing is a flick')
assert(!flickCross(0.2, -0.01, 0.016), 'a hand arriving from far away is not a flick')

assert(palmShown(0.8, false), 'a palm facing the viewer opens the menu')
assert(!palmShown(0.6, false), 'a palm that is only partly turned stays quiet')
assert(palmShown(0.5, true), 'once open, the menu stays until the palm turns further')
assert(!palmShown(0.3, true), 'turning the palm away closes the menu')

assert(onRim(0.15, 0, 0.16, 0.11), 'the edge of a frame is a rim')
assert(!onRim(0, 0, 0.16, 0.11), 'the middle of a frame is not a rim')
assert(!onRim(0.16, 0.11, 0.16, 0.11), 'a corner belongs to the peel')

const top = tileCenter(0, 4)
const hit = tilePick(0, top.y, 0, 4)
assert(hit.index === 0 && hit.touch && hit.near > 0.9, 'a fingertip on the top tile touches it')
assert(tilePick(0, top.y, 0.05, 4).index === -1, 'a fingertip off the plane misses')
assert(!tilePick(0.06, top.y, 0, 4).touch && tilePick(0.06, top.y, 0, 4).index === 0, 'a fingertip just beside a tile is near it')
assert(tilePick(0.2, 0, 0, 4).index === -1, 'a fingertip far from the stack misses')

const empty: GlassState = { frameGone: false, flat: false, idle: true, photoReady: false, pop: 0, developT: -1 }
assert(glassVisible(empty) && !glassCoversPhoto(empty), 'an empty frame shows the glass and has no photo to cover')
const blooming: GlassState = { ...empty, photoReady: true, pop: 0.5, developT: 0.2 }
assert(!glassVisible(blooming), 'the photo keeps the frame while it blooms')
const settled: GlassState = { ...empty, photoReady: true, pop: 1, developT: 0.8 }
assert(glassVisible(settled) && glassCoversPhoto(settled), 'after the bloom the glass covers the print')
assert(!glassVisible({ ...settled, flat: true }), 'a flat demo photo is never covered')
assert(!glassVisible({ ...settled, idle: false }), 'a peel puts the print back')
assert(!glassVisible({ ...empty, frameGone: true }), 'a dissolved frame has no glass')

assert(timeMessage(false, false, 'blocked') === null, 'the desk stand-in needs no camera message')
assert(timeMessage(true, true, 'Allow the headset cameras') === 'Allow the headset cameras', 'a camera problem stays on the glass')
assert(timeMessage(false, true, null) === 'Waiting for the camera', 'an empty ring says it is waiting')
assert(timeMessage(true, true, null) === null, 'a playing ring stays quiet')

console.log('time ok')
