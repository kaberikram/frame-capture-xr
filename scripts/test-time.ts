import {
  advancePlay,
  clampIntensity,
  glassCoversPhoto,
  glassVisible,
  initialWarp,
  nextWarp,
  slotBehind,
  slowPlayback,
  timeMessage,
  warpIndex,
  warpName,
  warpReach,
  WARP_MODES,
  type GlassState,
  type WarpMode,
} from '../src/capture/time-mode.ts'

function assert(ok: boolean, message: string): void {
  if (!ok) throw new Error(message)
}

const order: WarpMode[] = ['slow', 'echo', 'slit', 'ripple', 'live']
assert(WARP_MODES.join() === order.join(), 'the mode list drifted')
let mode: WarpMode = 'slow'
for (let i = 0; i < order.length; i++) {
  assert(warpIndex(mode) === i, `${mode} index`)
  assert(warpName(mode).length > 0, `${mode} name`)
  mode = nextWarp(mode)
}
assert(mode === 'slow', 'the cycle returns to slow motion')

assert(slotBehind(3, 5, 16) === 14, `slot 5 behind 3 should be 14, got ${slotBehind(3, 5, 16)}`)
assert(slotBehind(5, 15, 16) === 6, `the oldest full-ring slot should be just after the head, got ${slotBehind(5, 15, 16)}`)
assert(slotBehind(0, 0) === 0, 'zero steps back is the head')

let play = 0
for (let i = 0; i < 10; i++) play = advancePlay(play, 0.5, 2, 4)
assert(play >= 0 && play < 4, `playback stays inside the reach, got ${play}`)
assert(advancePlay(0, 1, 0, 3) === 0, 'a stopped playback stays')
assert(advancePlay(1, 1, 1, 0) === 0, 'an empty ring has nothing to play')

assert(Math.abs(warpReach(0, 16) - 0.3 * 15) < 1e-6, 'low intensity still reaches into the ring')
assert(warpReach(1, 1) === 0, 'one frame has no past')
assert(slowPlayback(0) === 0.5, 'slow motion starts at half speed')
assert(slowPlayback(1) < 0.15, 'full intensity is much slower')
assert(clampIntensity(-1) === 0.12 && clampIntensity(4) === 1, 'strength stays in range')
const boot = initialWarp()
assert(boot.mode === 'slow' && boot.intensity === 0.62, `a plain launch is slow at 62%, got ${boot.mode} ${boot.intensity}`)

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
