export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function smoothStep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

export function easeOut(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return 1 - (1 - x) ** 3
}

/** Move `from` toward `to` by at most `step`. */
export function approach(from: number, to: number, step: number): number {
  if (Math.abs(to - from) <= step) return to
  return from + Math.sign(to - from) * step
}
