import { bloom, bloomProgress } from '../src/look/bloom.ts'

const dur = 0.85
if (bloom(0, dur) !== 0 || bloom(-1, dur) !== 0) throw new Error('a bloom starts at rest')
let peak = 0
for (let t = 0; t <= dur * 3; t += 1 / 240) peak = Math.max(peak, bloom(t, dur))
if (peak < 1.02 || peak > 1.06) throw new Error(`overshoot should be a few percent, got ${peak.toFixed(3)}`)
if (Math.abs(bloom(dur, dur) - 1) > 0.03) throw new Error(`settled by the duration, got ${bloom(dur, dur).toFixed(3)}`)
if (Math.abs(bloom(dur * 3, dur) - 1) > 0.002) throw new Error('settles at 1')
let prev = 0
for (let t = 0; t <= dur; t += 1 / 72) {
  const p = bloomProgress(t, dur)
  if (p < prev || p > 1) throw new Error('progress only rises and stops at 1')
  prev = p
}
if (bloomProgress(dur, dur) !== 1) throw new Error('progress reaches 1 at the duration')

console.log('look ok')
