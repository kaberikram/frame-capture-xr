import type { Held } from '../capture/held.js'
import type { Hold } from '../desk/shot.js'

export type Phase = 'ready' | 'drawing' | 'photo' | 'relief' | 'side' | 'rest' | 'peel' | 'open' | 'curl' | 'detached' | 'dissolve' | 'approach' | 'stuck'

/** `window.__capture`: what the newest frame is doing, for scripted checks. */
export interface CaptureApi {
  phase: Phase
  count: number
  depth: string
  relief: number
  peel: number
  /** Time mode inside the frame: echo, slit, ripple, or live. */
  warp: string
  /** Cycle the time mode and return the new one. Used by the smoke check. */
  cycle: () => string
  /** This is the peel page. */
  room: boolean
  /** Chunks of reconstructed room. */
  roomChunks: number
  /** Pieces peeled off the room and still in the scene. */
  roomPatches: number
  /** What the piece in hand (or the newest one) is doing: none, lifting, carried, free, landing, stuck. */
  roomPiece: string
  /** Radius of that piece, metres. */
  roomRadius: number
  /** Places where warm light is open. */
  roomLights: number
  /** How bright the light under a hand is, 0..1. */
  roomPool: number
  /** Whether the held or newest piece is a thing in its own shape (`object`) or a flat piece (`flat`). */
  roomKind: string
  /** How bright the light on a liftable thing's shape is, 0..1. */
  roomAttention: number
}

export interface PhaseInputs {
  drawing: boolean
  hold: Hold
  drawU: number
  last: Held | undefined
  dissolving: boolean
  previewing: boolean
  /** Desk orbit yaw, radians. */
  yaw: number
}

export function publishApi(): void {
  const api: CaptureApi = {
    phase: 'ready',
    count: 0,
    depth: 'none',
    relief: 0,
    peel: 0,
    warp: 'echo',
    cycle: () => 'echo',
    room: false,
    roomChunks: 0,
    roomPatches: 0,
    roomPiece: 'none',
    roomRadius: 0,
    roomLights: 0,
    roomPool: 0,
    roomKind: 'none',
    roomAttention: 0,
  }
  ;(window as unknown as { __capture: CaptureApi }).__capture = api
}

/** Point the debug hook at the live time window. */
export function publishRoom(room: { active: boolean; chunks: number; pieces: number; piece: string; radius: number; lights: number; pool: number; kind: string; attention: number }): void {
  const api = (window as unknown as { __capture?: CaptureApi }).__capture
  if (!api) return
  api.room = room.active
  api.roomChunks = room.chunks
  api.roomPatches = room.pieces
  api.roomPiece = room.piece
  api.roomRadius = room.radius
  api.roomLights = room.lights
  api.roomPool = room.pool
  api.roomKind = room.kind
  api.roomAttention = room.attention
}

export function bindWarpApi(cycle: () => string): void {
  const api = (window as unknown as { __capture?: CaptureApi }).__capture
  if (!api) return
  api.cycle = cycle
}

export function reliefOf(held: Held | undefined): number {
  return held ? (held.mat.uniforms.uRelief.value as number) : 0
}

export function computePhase(s: PhaseInputs): Phase {
  const last = s.last
  const relief = reliefOf(last)
  const spread = last?.spread ?? 0
  const curl = last?.curl ?? 0
  if (s.drawing && (s.hold !== 'draw' || s.drawU > 0.5)) return 'drawing'
  if (last?.mode === 'stuck') return 'stuck'
  if (s.dissolving && last) return 'dissolve'
  if (s.previewing && last?.mode === 'free') return 'approach'
  if (last?.mode === 'free') return 'detached'
  if (last?.mode === 'curl' && curl > 0.06) return 'curl'
  if (spread > 0.85) return 'open'
  if (spread > 0.22) return 'peel'
  if (s.hold === 'side' && s.yaw > 0.55 && relief > 0.8) return 'side'
  if (resting(s.hold, s.yaw, relief, spread, curl)) return 'rest'
  if (s.yaw > 0.55 && relief > 0.8) return 'side'
  if (last && relief > 0.04) return 'relief'
  if (last) return 'photo'
  return 'ready'
}

export function publishPhase(phase: Phase, count: number, last: Held | undefined, warp?: { mode: string }): void {
  const api = (window as unknown as { __capture?: CaptureApi }).__capture
  if (!api) return
  api.phase = phase
  api.count = count
  api.depth = last?.depth ?? 'none'
  api.relief = reliefOf(last)
  api.peel = last?.mode === 'free' || last?.mode === 'stuck' ? 1 : last?.mode === 'curl' ? last.curl : last?.spread ?? 0
  if (!warp) return
  api.warp = warp.mode
}

function resting(hold: Hold, yaw: number, relief: number, spread: number, curl: number): boolean {
  if (relief <= 0.88 || yaw <= 0.32 || spread >= 0.05 || curl >= 0.05) return false
  switch (hold) {
    case 'rest':
    case 'play':
    case 'curl':
    case 'detached':
    case 'stuck':
    case 'peel':
    case 'open':
      return true
    case 'off':
    case 'draw':
    case 'photo':
    case 'side':
      return false
    default: {
      const never: never = hold
      return never
    }
  }
}
