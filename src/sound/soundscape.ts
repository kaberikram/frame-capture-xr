import type { Vector3 } from '@iwsdk/core'
import { queryFlag } from '../app/experience.js'

/**
 * Small synthesized sounds, placed where each thing happens. Hands-only input
 * has no haptics, so a soft tick on pinch and a shutter hush on release are the
 * touch feedback. Nothing is loaded from disk. `?sound=0` keeps it silent.
 */
export class Soundscape {
  readonly enabled = queryFlag('sound') !== '0'
  private ctx: AudioContext | null = null
  private out: GainNode | null = null
  private wet: GainNode | null = null
  private noise: AudioBuffer | null = null
  private grainDebt = 0

  /** Create or wake the audio context. Call from a click or pinch, which browsers require. */
  resume(): void {
    if (!this.enabled) return
    if (!this.ctx) this.build()
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined)
  }

  /** Keep the listener on the head so sounds come from where they happen. */
  listen(pos: Vector3, forward: Vector3, up: Vector3): void {
    const ctx = this.live()
    if (!ctx) return
    const l = ctx.listener
    if (l.positionX) {
      const t = ctx.currentTime
      l.positionX.setTargetAtTime(pos.x, t, 0.015)
      l.positionY.setTargetAtTime(pos.y, t, 0.015)
      l.positionZ.setTargetAtTime(pos.z, t, 0.015)
      l.forwardX.setTargetAtTime(forward.x, t, 0.015)
      l.forwardY.setTargetAtTime(forward.y, t, 0.015)
      l.forwardZ.setTargetAtTime(forward.z, t, 0.015)
      l.upX.setTargetAtTime(up.x, t, 0.015)
      l.upY.setTargetAtTime(up.y, t, 0.015)
      l.upZ.setTargetAtTime(up.z, t, 0.015)
    } else {
      l.setPosition(pos.x, pos.y, pos.z)
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z)
    }
  }

  /** Fingers met: a tiny soft tick. */
  pinch(at: Vector3): void {
    const ctx = this.live()
    if (!ctx) return
    const voice = this.voice(at, 0.08)
    this.tone(voice, 1320, 1180, 0.004, 0.03, 0.11)
  }

  /** The frame anchors and the photo is taken: a distant film-camera hush with a low thump. */
  shutter(at: Vector3): void {
    const ctx = this.live()
    if (!ctx) return
    const voice = this.voice(at, 0.3)
    this.burst(voice, 'bandpass', 1900, 0.8, 0.002, 0.07, 0.22)
    this.burst(voice, 'bandpass', 2600, 1.2, 0.002, 0.035, 0.08, 0.045)
    this.tone(voice, 96, 52, 0.004, 0.13, 0.3)
  }

  /** The relief has its depth: two soft bell notes, a fifth apart. */
  bloom(at: Vector3): void {
    const ctx = this.live()
    if (!ctx) return
    const voice = this.voice(at, 0.55)
    this.bell(voice, 440, 0, 0.1)
    this.bell(voice, 659.25, 0.13, 0.08)
  }

  /** Call every frame while a corner is pulled. `speed` is peel amount per second. */
  peel(at: Vector3, speed: number, dt: number): void {
    const ctx = this.live()
    if (!ctx || speed <= 0.01) {
      this.grainDebt = 0
      return
    }
    // Vinyl lifting off: more crackle the faster it peels.
    this.grainDebt += Math.min(90, speed * 260) * dt
    if (this.grainDebt < 1) return
    const voice = this.voice(at, 0.06)
    while (this.grainDebt >= 1) {
      this.grainDebt -= 1
      const delay = Math.random() * dt
      this.burst(voice, 'highpass', 2400 + Math.random() * 2400, 0.7, 0.001, 0.004 + Math.random() * 0.008, 0.1 + Math.random() * 0.12, delay)
    }
  }

  /** The sticker comes free: a gentle pop and a few airy sparkles. */
  detach(at: Vector3): void {
    const ctx = this.live()
    if (!ctx) return
    const voice = this.voice(at, 0.45)
    this.tone(voice, 330, 140, 0.003, 0.08, 0.2)
    for (let i = 0; i < 6; i++) {
      this.tone(voice, 2200 + Math.random() * 2200, 0, 0.004, 0.12, 0.025, 0.05 + i * 0.05 + Math.random() * 0.03)
    }
  }

  /** It lands on a surface: a soft low thup. */
  stick(at: Vector3): void {
    const ctx = this.live()
    if (!ctx) return
    const voice = this.voice(at, 0.2)
    this.burst(voice, 'lowpass', 420, 0.7, 0.002, 0.07, 0.34)
    this.tone(voice, 118, 84, 0.003, 0.1, 0.18)
  }

  /** Warm light opens where a piece of the room came away: a low, slow swell with a fifth above it. */
  glow(at: Vector3): void {
    const ctx = this.live()
    if (!ctx) return
    const voice = this.voice(at, 0.6)
    this.tone(voice, 174.6, 196, 0.22, 1.5, 0.085)
    this.tone(voice, 261.6, 293.7, 0.3, 1.3, 0.05, 0.06)
    this.bell(voice, 587.3, 0.18, 0.035)
  }

  dispose(): void {
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
  }

  private live(): AudioContext | null {
    const ctx = this.ctx
    return ctx && ctx.state === 'running' ? ctx : null
  }

  private build(): void {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor({ latencyHint: 'interactive' })
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -12
    limiter.ratio.value = 6
    limiter.connect(ctx.destination)
    const out = ctx.createGain()
    out.gain.value = 0.55
    out.connect(limiter)
    const room = ctx.createConvolver()
    room.buffer = impulse(ctx, 1.7)
    const wet = ctx.createGain()
    wet.gain.value = 1
    wet.connect(room)
    room.connect(out)
    const noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.5), ctx.sampleRate)
    const data = noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    this.ctx = ctx
    this.out = out
    this.wet = wet
    this.noise = noise
  }

  /** A short-lived spatial input at a point, with `send` of it going to the room reverb. */
  private voice(at: Vector3, send: number): AudioNode {
    const ctx = this.ctx as AudioContext
    const panner = ctx.createPanner()
    panner.panningModel = 'HRTF'
    panner.distanceModel = 'inverse'
    panner.refDistance = 0.6
    panner.rolloffFactor = 1
    if (panner.positionX) {
      panner.positionX.value = at.x
      panner.positionY.value = at.y
      panner.positionZ.value = at.z
    } else {
      panner.setPosition(at.x, at.y, at.z)
    }
    const input = ctx.createGain()
    input.connect(panner)
    panner.connect(this.out as GainNode)
    const sendGain = ctx.createGain()
    sendGain.gain.value = send
    panner.connect(sendGain)
    sendGain.connect(this.wet as GainNode)
    // Let the graph go once the longest sound here has rung out.
    setTimeout(() => {
      input.disconnect()
      panner.disconnect()
      sendGain.disconnect()
    }, 2500)
    return input
  }

  /** A sine that glides from `from` to `to` Hz (0 keeps it steady) with a quick attack and an exponential decay. */
  private tone(dest: AudioNode, from: number, to: number, attack: number, decay: number, gain: number, delay = 0): void {
    const ctx = this.ctx as AudioContext
    const t = ctx.currentTime + delay
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(from, t)
    if (to > 0) osc.frequency.exponentialRampToValueAtTime(to, t + attack + decay)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(gain, t + attack)
    env.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    osc.connect(env)
    env.connect(dest)
    osc.start(t)
    osc.stop(t + attack + decay + 0.02)
  }

  /** Filtered noise with a quick attack and an exponential decay. */
  private burst(dest: AudioNode, type: BiquadFilterType, freq: number, q: number, attack: number, decay: number, gain: number, delay = 0): void {
    const ctx = this.ctx as AudioContext
    const t = ctx.currentTime + delay
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    src.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = type
    filter.frequency.value = freq
    filter.Q.value = q
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(gain, t + attack)
    env.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    src.connect(filter)
    filter.connect(env)
    env.connect(dest)
    src.start(t, Math.random() * 0.4)
    src.stop(t + attack + decay + 0.02)
  }

  /** A soft bell: fundamental, a quiet octave, and a faint inharmonic shimmer. */
  private bell(dest: AudioNode, freq: number, delay: number, gain: number): void {
    this.tone(dest, freq, 0, 0.008, 1.6, gain, delay)
    this.tone(dest, freq * 2, 0, 0.006, 0.7, gain * 0.18, delay)
    this.tone(dest, freq * 3.01, 0, 0.004, 0.35, gain * 0.06, delay)
  }
}

/** A warm room: stereo noise that decays exponentially, softened by a one-pole low-pass. */
function impulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.round(ctx.sampleRate * seconds)
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c)
    let lp = 0
    for (let i = 0; i < length; i++) {
      const decay = Math.pow(1 - i / length, 3.2)
      lp += 0.32 * ((Math.random() * 2 - 1) - lp)
      data[i] = lp * decay * 0.6
    }
  }
  return buffer
}
