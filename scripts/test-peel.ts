import { classifyHit, spreadFromPull, springStep } from '../src/peel-math.ts'

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

console.log('peel ok')
