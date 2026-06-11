/** Test-only builders for kernel tests (excluded from coverage). */
import type { Clip, ConnectedClip, GapClip, Sequence } from './model'

export const FPS30 = { num: 30, den: 1 }
/** One frame at 30 fps, in flicks. */
export const F = 23_520_000

export function clip(id: string, durationFrames: number, mediaInFrames = 0): Clip {
  return {
    kind: 'clip',
    id,
    assetId: `asset-${id}`,
    mediaInFlicks: mediaInFrames * F,
    durationFlicks: durationFrames * F,
    sourceDurationFlicks: 600 * F
  }
}

export function gap(id: string, durationFrames: number): GapClip {
  return { kind: 'gap', id, durationFlicks: durationFrames * F }
}

export function connected(
  id: string,
  parentClipId: string,
  offsetFrames: number,
  durationFrames: number,
  lane = 1
): ConnectedClip {
  return {
    id,
    assetId: `asset-${id}`,
    parentClipId,
    offsetFlicks: offsetFrames * F,
    lane,
    mediaInFlicks: 0,
    durationFlicks: durationFrames * F,
    sourceDurationFlicks: 600 * F
  }
}

export function seq(
  spine: Sequence['spine'],
  connectedClips: Sequence['connected'] = []
): Sequence {
  return deepFreeze({ id: 'seq', fps: FPS30, spine, connected: connectedClips })
}

/** Ops must never mutate their inputs — frozen fixtures turn mutation into a throw. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}
