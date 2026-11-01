import {
  PEEL_MARK,
  PEEL_POP,
  PEEL_TACK,
  axisExtent,
  classifyHit,
  curlFromPull,
  foldForPeel,
  nearestCorner,
  peelsFree,
  spreadFromPull,
  springStep,
} from '../src/interaction/peel-math.ts'

const halfW = 0.16
const halfH = 0.11
const strip = 0.008

const photo = classifyHit(0, 0, halfW, halfH, strip)
const handle = classifyHit(0, -halfH - strip - 0.004, halfW, halfH, strip)
const outside = classifyHit(0.4, 0, halfW, halfH, strip)
if (photo !== 'photo' || handle !== 'handle' || outside !== 'miss') {
  throw new Error(`hit ${photo} ${handle} ${outside}`)
}

if (spreadFromPull(-0.05) !== 0) throw new Error('push should stay closed')
if (spreadFromPull(1) !== 1) throw new Error('a long pull should open fully')
const mid = spreadFromPull(0.08)
if (mid <= 0 || mid >= 1) throw new Error(`mid pull ${mid}`)

let spread = 1
let velocity = 0
for (let i = 0; i < 240; i++) {
  const next = springStep(spread, velocity, 36, 1 / 60)
  spread = next.spread
  velocity = next.velocity
  if (spread < 0) throw new Error('spring crossed zero')
}
if (spread > 0.02) throw new Error(`spring did not settle ${spread}`)

const corner = classifyHit(halfW - 0.02, halfH - 0.01, halfW, halfH, strip)
const justOutside = classifyHit(halfW - 0.07, halfH, halfW, halfH, strip)
if (corner !== 'corner') throw new Error(`corner zone ${corner}`)
if (justOutside !== 'photo') throw new Error(`outside the 6 cm disc ${justOutside}`)
const grabbed = nearestCorner(halfW, halfH, halfW, halfH)
if (!grabbed || grabbed.id !== 0) throw new Error('top-right corner')
const extent = axisExtent(halfW, halfH, grabbed.axisX, grabbed.axisY)
if (Math.abs(foldForPeel(0, extent) - extent) > 1e-6) throw new Error('a rest peel sits on the corner')
if (Math.abs(foldForPeel(1, extent) + extent) > 1e-6) throw new Error('a full peel reaches the far edge')
const detach = 0.7
if (curlFromPull(-0.02, detach) !== 0) throw new Error('a push stays stuck')
if (curlFromPull(PEEL_TACK * 0.9, detach) !== 0) throw new Error('the tack holds a tiny pull')
const slight = curlFromPull(0.04, detach)
if (slight <= 0 || slight > 0.12) throw new Error(`a slight pull lifts only a little: ${slight}`)
let last = 0
for (let pull = 0; pull <= PEEL_POP + 0.02; pull += 0.005) {
  const curl = curlFromPull(pull, detach)
  if (curl < last - 1e-9) throw new Error(`more pull never peels less (${pull})`)
  if (!peelsFree(pull) && curl > detach + 0.07) throw new Error(`curl ${curl} while still stuck`)
  last = curl
}
if (Math.abs(curlFromPull(PEEL_MARK, detach) - detach) > 1e-6) throw new Error('the mark reaches detach')
const holding = (PEEL_MARK + PEEL_POP) * 0.5
if (curlFromPull(holding, detach) <= detach || peelsFree(holding)) throw new Error('past the mark the last bit holds')
if (!peelsFree(PEEL_POP)) throw new Error('the pop lets go')
if (PEEL_POP - PEEL_MARK < 0.02) throw new Error('the hold is long enough to feel')

console.log('peel ok')
