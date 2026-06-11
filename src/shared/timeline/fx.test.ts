import { describe, expect, it } from 'vitest'
import { DEFAULT_FX, connectAt, setClipFx, setTitleData } from './ops'
import type { Clip, TitleData } from './model'
import { F, clip, connected, seq } from './testing'

const TITLE: TitleData = {
  text: 'Hello',
  font: 'system-ui',
  sizePx: 96,
  color: '#ffffff',
  x: 960,
  y: 540,
  preset: 'basic'
}

describe('setClipFx', () => {
  it('sets transform fx on a spine clip', () => {
    const s = seq([clip('a', 10)])
    const fx = { ...DEFAULT_FX, posX: 100, posY: -50, scale: 50, rotation: 90, opacity: 80 }
    const { next, error } = setClipFx(s, { clipId: 'a', fx })
    expect(error).toBeUndefined()
    expect((next.spine[0] as Clip).fx).toEqual(fx)
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

describe('titles', () => {
  it('connectAt carries titleData onto the connected clip', () => {
    const s = seq([clip('a', 10)])
    const { next, error } = connectAt(s, {
      clip: {
        id: 't1',
        assetId: 'title',
        mediaInFlicks: 0,
        durationFlicks: 4 * F,
        sourceDurationFlicks: 600 * F
      },
      timeFlicks: 0,
      lane: 1,
      titleData: TITLE
    })
    expect(error).toBeUndefined()
    expect(next.connected[0].titleData).toEqual(TITLE)
  })

  it('setTitleData updates a connected title (undoable, typed errors)', () => {
    const s = seq([clip('a', 10)], [{ ...connected('t1', 'a', 0, 4), titleData: TITLE }])
    const updated = setTitleData(s, { clipId: 't1', titleData: { ...TITLE, text: 'Bye' } })
    expect(updated.error).toBeUndefined()
    expect(updated.next.connected[0].titleData?.text).toBe('Bye')
    expect(updated.inverse).toEqual({ type: 'restore', sequence: s })
    expect(setTitleData(s, { clipId: 'zzz', titleData: TITLE }).error?.code).toBe('unknown-id')
  })
})
