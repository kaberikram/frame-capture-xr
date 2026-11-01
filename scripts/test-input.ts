import { insideQuad, quadMargin } from '../src/capture/clearance.ts'
import { OneEuro3 } from '../src/input/one-euro.ts'
import { PinchTrail } from '../src/input/pinch-trail.ts'

// One Euro: a still hand with millimetre jitter comes out much steadier.
{
  const filter = new OneEuro3()
  const out = { x: 0, y: 0, z: 0 }
  let seed = 3
  const noise = () => {
    seed = (seed * 16807) % 2147483647
    return ((seed - 1) / 2147483646 - 0.5) * 0.004
  }
  let rawSpread = 0
  let outSpread = 0
  let prev = 0
  for (let i = 0; i < 240; i++) {
    const raw = 0.5 + noise()
    filter.filter(raw, 1.2, -0.4, i / 72, out)
    if (i > 60) {
      rawSpread = Math.max(rawSpread, Math.abs(raw - 0.5))
      outSpread = Math.max(outSpread, Math.abs(out.x - 0.5))
      if (i > 61 && Math.abs(out.x - prev) > 0.0015) throw new Error('filtered point still jumps')
    }
    prev = out.x
  }
  if (outSpread > rawSpread * 0.5) throw new Error(`jitter not reduced: raw ${rawSpread} out ${outSpread}`)
}

// One Euro: a fast sweep is followed closely, not dragged behind.
{
  const filter = new OneEuro3()
  const out = { x: 0, y: 0, z: 0 }
  for (let i = 0; i <= 36; i++) filter.filter(i * (0.6 / 36), 0, 0, i / 72, out)
  const lag = 0.6 - out.x
  if (lag > 0.05) throw new Error(`fast sweep lags ${lag.toFixed(3)} m`)
}

// One Euro: the first sample passes straight through, and a reset starts over.
{
  const filter = new OneEuro3()
  const out = { x: 0, y: 0, z: 0 }
  filter.filter(1, 2, 3, 0, out)
  if (out.x !== 1 || out.y !== 2 || out.z !== 3) throw new Error('first sample should pass through')
  filter.reset()
  filter.filter(-1, 0, 0, 0.5, out)
  if (out.x !== -1) throw new Error('reset should drop history')
}

// Release rewind: opening the fingers drags the point; the rewind returns the tightest moment.
{
  const trail = new PinchTrail()
  const out = { x: 0, y: 0, z: 0 }
  let t = 0
  for (let i = 0; i < 20; i++, t += 1 / 72) trail.push(t, 0.3, 1.2, -0.5, 0.012)
  // Fingers open over four frames while the point slides 1.5 cm.
  for (let i = 1; i <= 4; i++, t += 1 / 72) trail.push(t, 0.3 + i * 0.004, 1.2 - i * 0.002, -0.5, 0.012 + i * 0.006)
  if (!trail.rewind(t, 0.15, out)) throw new Error('rewind found nothing')
  if (Math.abs(out.x - 0.3) > 1e-9 || Math.abs(out.y - 1.2) > 1e-9) throw new Error(`rewind landed at ${out.x}, ${out.y}`)
  if (trail.rewind(t + 1, 0.15, out)) throw new Error('old samples should be ignored')
  trail.clear()
  if (trail.rewind(t, 0.15, out)) throw new Error('a cleared trail is empty')
}

// Clearance: a joint in the photo blocks the shutter; one beside it does not.
{
  const quad = { bl: { x: 100, y: 400 }, br: { x: 500, y: 410 }, tr: { x: 490, y: 120 }, tl: { x: 110, y: 110 } }
  const margin = quadMargin(quad, 0.04)
  if (margin < 15 || margin > 17) throw new Error(`margin ${margin}`)
  if (!insideQuad(quad, 300, 260, margin)) throw new Error('center should be inside')
  if (!insideQuad(quad, 96, 260, margin)) throw new Error('just outside the left edge is within the margin')
  if (insideQuad(quad, 40, 260, margin)) throw new Error('well left of the frame is clear')
  if (insideQuad(quad, 300, 470, margin)) throw new Error('below the frame is clear')
  const flipped = { bl: quad.br, br: quad.bl, tr: quad.tl, tl: quad.tr }
  if (!insideQuad(flipped, 300, 260, margin)) throw new Error('winding should not matter')
}

console.log('input ok')
