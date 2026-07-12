import { describe, expect, it } from 'vitest'
import { effectiveRole } from './model'
import { setClipRole, setMutedRoles } from './ops'
import { clip, connected, gap, seq } from './testing'

describe('effectiveRole', () => {
  it('defaults spine clips to dialogue', () => {
    expect(effectiveRole(clip('a', 100))).toBe('dialogue')
  })

  it('lets an explicit role win', () => {
    expect(effectiveRole({ ...clip('a', 100), role: 'sfx' })).toBe('sfx')
  })

  it('classifies looped connected clips as music by default', () => {
    expect(effectiveRole({ ...connected('m', 'a', 0, 200, -2), loop: true })).toBe('music')
  })

  it('explicit role beats the loop heuristic', () => {
    expect(effectiveRole({ ...connected('m', 'a', 0, 200, -2), loop: true, role: 'sfx' })).toBe(
      'sfx'
    )
  })

  it('returns null for gaps and titles (nothing to hear)', () => {
    expect(effectiveRole(gap('g', 10))).toBeNull()
    expect(
      effectiveRole({
        ...connected('t', 'a', 0, 50),
        titleData: {
          text: 'hi',
          font: 'sans',
          sizePx: 40,
          color: '#fff',
          x: 960,
          y: 540,
          preset: 'basic' as const
        }
      })
    ).toBeNull()
  })
})

describe('setClipRole', () => {
  it('sets the role of a spine clip', () => {
    const base = seq([clip('a', 100)])
    const result = setClipRole(base, { clipId: 'a', role: 'music' })
    expect(result.error).toBeUndefined()
    const item = result.next.spine[0]
    expect(item.kind === 'clip' && item.role).toBe('music')
  })

  it('sets the role of a connected clip', () => {
    const base = seq([clip('a', 100)], [connected('c', 'a', 0, 50, -1)])
    const result = setClipRole(base, { clipId: 'c', role: 'sfx' })
    expect(result.error).toBeUndefined()
    expect(result.next.connected[0].role).toBe('sfx')
  })

  it('is a no-op when the role is already set', () => {
    const base = seq([{ ...clip('a', 100), role: 'music' as const }])
    const result = setClipRole(base, { clipId: 'a', role: 'music' })
    expect(result.next).toBe(base)
    expect(result.error).toBeUndefined()
  })

  it('rejects gaps, titles, and unknown ids', () => {
    const title = {
      ...connected('t', 'a', 0, 50),
      titleData: {
        text: 'hi',
        font: 'sans',
        sizePx: 40,
        color: '#fff',
        x: 960,
        y: 540,
        preset: 'basic' as const
      }
    }
    const base = seq([clip('a', 100), gap('g', 10)], [title])
    expect(setClipRole(base, { clipId: 'g', role: 'music' }).error?.code).toBe('invalid-target')
    expect(setClipRole(base, { clipId: 't', role: 'music' }).error?.code).toBe('invalid-target')
    expect(setClipRole(base, { clipId: 'zzz', role: 'music' }).error?.code).toBe('unknown-id')
  })

  it('round-trips through the inverse restore', () => {
    const base = seq([clip('a', 100)])
    const result = setClipRole(base, { clipId: 'a', role: 'sfx' })
    expect(result.inverse.sequence).toBe(base)
  })
})

describe('setMutedRoles', () => {
  it('sets the sequence-level muted roles, deduped and sorted', () => {
    const base = seq([clip('a', 100)])
    const result = setMutedRoles(base, { roles: ['music', 'music', 'dialogue'] })
    expect(result.error).toBeUndefined()
    expect(result.next.mutedRoles).toEqual(['dialogue', 'music'])
  })

  it('clears the muted set with an empty list', () => {
    const base = { ...seq([clip('a', 100)]), mutedRoles: ['music' as const] }
    const result = setMutedRoles(base, { roles: [] })
    expect(result.next.mutedRoles).toEqual([])
  })

  it('is a no-op when the set is unchanged', () => {
    const base = { ...seq([clip('a', 100)]), mutedRoles: ['music' as const] }
    expect(setMutedRoles(base, { roles: ['music'] }).next).toBe(base)
  })

  it('rejects unknown role names', () => {
    const base = seq([clip('a', 100)])
    const result = setMutedRoles(base, { roles: ['narration' as never] })
    expect(result.error?.code).toBe('invalid-target')
  })
})
