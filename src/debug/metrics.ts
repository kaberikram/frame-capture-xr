import { queryFlag } from '../app/experience.js'

/** `?debug=1` shows the overlay and keeps the timing lines. */
export const DEBUG = queryFlag('debug') === '1'

const values = new Map<string, string>()

/** Record the latest value of something worth seeing on a headset: a timing, a size, a state. */
export function metric(name: string, value: number | string, unit = ''): void {
  values.set(name, typeof value === 'number' ? `${Math.round(value)}${unit}` : value)
}

export function metrics(): ReadonlyMap<string, string> {
  return values
}
