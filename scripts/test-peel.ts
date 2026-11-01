import { axisExtent, classifyHit, curlFromPull, foldForPeel, nearestCorner, spreadFromPull, springStep } from '../src/interaction/peel-math.ts'

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
if (curlFromPull(-0.02) !== 0) throw new Error('a push stays stuck')
const stuck = curlFromPull(0.04)
const loose = curlFromPull(0.2)
if (stuck <= 0 || stuck >= 0.7 || loose < 0.7) throw new Error(`curl ${stuck} ${loose}`)

console.log('peel ok')
