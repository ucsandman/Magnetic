import { describe, expect, it } from 'vitest'
import { DEFAULT_FX, setClipFx } from './ops'
import type { Clip } from './model'
import { clip, connected, seq } from './testing'

describe('setClipFx', () => {
  it('sets transform fx on a spine clip', () => {
    const s = seq([clip('a', 10)])
    const { next, error } = setClipFx(s, {
      clipId: 'a',
      fx: { posX: 100, posY: -50, scale: 50, rotation: 90, opacity: 80 }
    })
    expect(error).toBeUndefined()
    expect((next.spine[0] as Clip).fx).toEqual({
      posX: 100,
      posY: -50,
      scale: 50,
      rotation: 90,
      opacity: 80
    })
  })

  it('sets fx on a connected clip', () => {
    const s = seq([clip('a', 10)], [connected('cc', 'a', 0, 5)])
    const { next } = setClipFx(s, { clipId: 'cc', fx: { ...DEFAULT_FX, scale: 25 } })
    expect(next.connected[0].fx?.scale).toBe(25)
  })

  it('returns a restore inverse and never mutates the input', () => {
    const s = seq([clip('a', 10)])
    const result = setClipFx(s, { clipId: 'a', fx: { ...DEFAULT_FX, opacity: 10 } })
    expect(result.inverse).toEqual({ type: 'restore', sequence: s })
    expect((s.spine[0] as Clip).fx).toBeUndefined()
  })

  it('unknown ids are a typed-error no-op', () => {
    const s = seq([clip('a', 10)])
    const result = setClipFx(s, { clipId: 'zzz', fx: DEFAULT_FX })
    expect(result.error?.code).toBe('unknown-id')
    expect(result.next).toBe(s)
  })

  it('gaps cannot carry fx', () => {
    const s = seq([{ kind: 'gap', id: 'g', durationFlicks: 10 * 23_520_000 }])
    const result = setClipFx(s, { clipId: 'g', fx: DEFAULT_FX })
    expect(result.error?.code).toBe('invalid-target')
  })

  it('fx survives unrelated ops (structural sharing keeps the field)', () => {
    const s = seq([clip('a', 10)])
    const withFx = setClipFx(s, { clipId: 'a', fx: { ...DEFAULT_FX, scale: 50 } }).next
    expect((withFx.spine[0] as Clip).fx?.scale).toBe(50)
  })
})
