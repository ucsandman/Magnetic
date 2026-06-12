import { describe, expect, it } from 'vitest'
import {
  sequenceDuration,
  spineStartOf,
  connectedStartOf,
  type Clip,
  type ConnectedClip
} from './model'
import {
  append,
  blade,
  connectAt,
  DEFAULT_FX,
  detachAudio,
  insertAt,
  liftDelete,
  move,
  overwriteAt,
  rippleDelete,
  roll,
  setCaptionSettings,
  slip,
  trimConnected,
  trimRipple
} from './ops'
import { F, clip, connected, gap, seq } from './testing'

function newClip(id: string, durationFrames: number, mediaInFrames = 0): Omit<Clip, 'kind'> {
  return {
    id,
    assetId: `asset-${id}`,
    mediaInFlicks: mediaInFrames * F,
    durationFlicks: durationFrames * F,
    sourceDurationFlicks: 600 * F
  }
}

describe('append', () => {
  it('appends a clip to the end of the spine', () => {
    const s = seq([clip('a', 10)])
    const { next, error } = append(s, { clip: newClip('b', 5) })
    expect(error).toBeUndefined()
    expect(next.spine.map((item) => item.id)).toEqual(['a', 'b'])
    expect(sequenceDuration(next)).toBe(15 * F)
  })

  it('rejects clips shorter than one frame', () => {
    const s = seq([])
    const result = append(s, {
      clip: { ...newClip('b', 0), durationFlicks: F - 1 }
    })
    expect(result.error).toBeDefined()
    expect(result.next).toBe(s)
  })

  it('rejects clips whose media range exceeds the source', () => {
    const s = seq([])
    const result = append(s, { clip: newClip('b', 100, 550) }) // 550+100 > 600
    expect(result.error).toBeDefined()
    expect(result.next).toBe(s)
  })

  it('rejects duplicate ids', () => {
    const s = seq([clip('a', 10)])
    const result = append(s, { clip: newClip('a', 5) })
    expect(result.error).toBeDefined()
  })
})

describe('insertAt', () => {
  it('inserts at an exact boundary without splitting', () => {
    const s = seq([clip('a', 10), clip('b', 10)])
    const { next } = insertAt(s, { clip: newClip('c', 5), timeFlicks: 10 * F })
    expect(next.spine.map((item) => item.id)).toEqual(['a', 'c', 'b'])
    expect(spineStartOf(next, 'b')).toBe(15 * F) // downstream rippled
  })

  it('splits a clip when inserting mid-clip, preserving media continuity', () => {
    const s = seq([clip('a', 10, 2)])
    const { next } = insertAt(s, { clip: newClip('c', 5), timeFlicks: 4 * F })
    expect(next.spine).toHaveLength(3)
    const [head, inserted, tail] = next.spine as Clip[]
    expect(head.id).toBe('a')
    expect(head.durationFlicks).toBe(4 * F)
    expect(head.mediaInFlicks).toBe(2 * F)
    expect(inserted.id).toBe('c')
    expect(tail.durationFlicks).toBe(6 * F)
    expect(tail.mediaInFlicks).toBe(6 * F) // 2 + 4: media continues seamlessly
    expect(sequenceDuration(next)).toBe(15 * F)
  })

  it('clamps an insert beyond the sequence end to an append', () => {
    const s = seq([clip('a', 10)])
    const { next } = insertAt(s, { clip: newClip('c', 5), timeFlicks: 99 * F })
    expect(next.spine.map((item) => item.id)).toEqual(['a', 'c'])
  })

  it('inserting at 0 prepends', () => {
    const s = seq([clip('a', 10)])
    const { next } = insertAt(s, { clip: newClip('c', 5), timeFlicks: 0 })
    expect(next.spine.map((item) => item.id)).toEqual(['c', 'a'])
  })
})

describe('overwriteAt', () => {
  it('overwrites the middle of a clip, splitting both edges', () => {
    const s = seq([clip('a', 30)])
    const { next } = overwriteAt(s, { clip: newClip('x', 10), timeFlicks: 10 * F })
    expect(next.spine).toHaveLength(3)
    expect(sequenceDuration(next)).toBe(30 * F) // total unchanged
    const [head, mid, tail] = next.spine as Clip[]
    expect(head.durationFlicks).toBe(10 * F)
    expect(mid.id).toBe('x')
    expect(tail.durationFlicks).toBe(10 * F)
    expect(tail.mediaInFlicks).toBe(20 * F)
  })

  it('overwriting beyond the end extends the sequence', () => {
    const s = seq([clip('a', 10)])
    const { next } = overwriteAt(s, { clip: newClip('x', 10), timeFlicks: 5 * F })
    expect(sequenceDuration(next)).toBe(15 * F)
    expect(next.spine.map((item) => item.id)).toEqual(['a', 'x'])
    expect((next.spine[0] as Clip).durationFlicks).toBe(5 * F)
  })

  it('re-attaches connected clips of fully overwritten parents by absolute time', () => {
    const s = seq([clip('a', 10), clip('b', 10), clip('c', 10)], [connected('cc', 'b', 2, 3)])
    // overwrite exactly clip b's range
    const { next } = overwriteAt(s, { clip: newClip('x', 10), timeFlicks: 10 * F })
    const cc = next.connected.find((candidate) => candidate.id === 'cc')!
    expect(cc.parentClipId).toBe('x')
    expect(connectedStartOf(next, 'cc')).toBe(12 * F) // same absolute position
  })
})

describe('connectAt', () => {
  it('connects to the spine clip under the time with the right offset', () => {
    const s = seq([clip('a', 10), clip('b', 10)])
    const { next } = connectAt(s, {
      clip: newClip('cc', 4),
      timeFlicks: 13 * F,
      lane: 1
    })
    const cc = next.connected[0]
    expect(cc.parentClipId).toBe('b')
    expect(cc.offsetFlicks).toBe(3 * F)
    expect(cc.lane).toBe(1)
  })

  it('refuses to connect beyond the sequence end', () => {
    const s = seq([clip('a', 10)])
    const result = connectAt(s, { clip: newClip('cc', 4), timeFlicks: 20 * F, lane: 1 })
    expect(result.error).toBeDefined()
    expect(result.next).toBe(s)
  })

  it('bumps to the next lane instead of overlapping on the same lane', () => {
    const s = seq([clip('a', 20)], [connected('c1', 'a', 0, 10, 1)])
    const { next } = connectAt(s, { clip: newClip('c2', 10), timeFlicks: 5 * F, lane: 1 })
    const c2 = next.connected.find((candidate) => candidate.id === 'c2')!
    expect(c2.lane).toBe(2) // bumped above c1
  })

  it('audio lanes bump downward', () => {
    const s = seq([clip('a', 20)], [connected('c1', 'a', 0, 10, -1)])
    const { next } = connectAt(s, { clip: newClip('c2', 10), timeFlicks: 5 * F, lane: -1 })
    const c2 = next.connected.find((candidate) => candidate.id === 'c2')!
    expect(c2.lane).toBe(-2)
  })

  it('carries the ClipInput fx — including keyframe tracks — onto the connected clip', () => {
    const s = seq([clip('a', 20)])
    const fx = {
      ...DEFAULT_FX,
      scale: 50,
      kf: { scale: [{ atMediaFlicks: 0, value: 50, ease: 'linear' as const }] }
    }
    const { next } = connectAt(s, {
      clip: { ...newClip('cc', 4), fx },
      timeFlicks: 2 * F,
      lane: 1
    })
    expect(next.connected[0].fx).toEqual(fx)
  })

  it('leaves fx undefined when the ClipInput carries none', () => {
    const s = seq([clip('a', 20)])
    const { next } = connectAt(s, { clip: newClip('cc', 4), timeFlicks: 2 * F, lane: 1 })
    expect(next.connected[0].fx).toBeUndefined()
  })
})

describe('rippleDelete', () => {
  it('removes the clip and shifts downstream clips left', () => {
    const s = seq([clip('a', 10), clip('b', 10), clip('c', 10)])
    const { next } = rippleDelete(s, { ids: ['b'] })
    expect(next.spine.map((item) => item.id)).toEqual(['a', 'c'])
    expect(spineStartOf(next, 'c')).toBe(10 * F)
    expect(sequenceDuration(next)).toBe(20 * F)
  })

  it('keeps connected clips attached to surviving parents', () => {
    const s = seq([clip('a', 10), clip('b', 10), clip('c', 10)], [connected('cc', 'c', 2, 3)])
    const { next } = rippleDelete(s, { ids: ['a'] })
    const cc = next.connected[0]
    expect(cc.parentClipId).toBe('c')
    expect(connectedStartOf(next, 'cc')).toBe(12 * F) // moved left with its parent
  })

  it('re-attaches connected clips of a deleted parent to the clip now under their time', () => {
    const s = seq([clip('a', 10), clip('b', 10), clip('c', 10)], [connected('cc', 'b', 2, 3)])
    // cc sits at absolute 12; after deleting b, clip c occupies [10,20)
    const { next } = rippleDelete(s, { ids: ['b'] })
    const cc = next.connected.find((candidate) => candidate.id === 'cc')!
    expect(cc.parentClipId).toBe('c')
    expect(connectedStartOf(next, 'cc')).toBe(12 * F)
  })

  it('deletes connected clips whose time no longer exists', () => {
    const s = seq([clip('a', 10), clip('b', 10)], [connected('cc', 'b', 2, 3)])
    const { next } = rippleDelete(s, { ids: ['b'] }) // sequence shrinks to [0,10)
    expect(next.connected).toHaveLength(0)
  })

  it('deleting several clips at once ripples once', () => {
    const s = seq([clip('a', 10), clip('b', 10), clip('c', 10), clip('d', 10)])
    const { next } = rippleDelete(s, { ids: ['a', 'c'] })
    expect(next.spine.map((item) => item.id)).toEqual(['b', 'd'])
    expect(spineStartOf(next, 'd')).toBe(10 * F)
  })

  it('unknown ids are a typed-error no-op', () => {
    const s = seq([clip('a', 10)])
    const result = rippleDelete(s, { ids: ['zzz'] })
    expect(result.error).toBeDefined()
    expect(result.next).toBe(s)
  })
})

describe('liftDelete', () => {
  it('replaces the clip with a gap of identical duration (total preserved)', () => {
    const s = seq([clip('a', 10), clip('b', 10), clip('c', 10)])
    const { next } = liftDelete(s, { ids: ['b'] })
    expect(sequenceDuration(next)).toBe(30 * F)
    expect(next.spine[1].kind).toBe('gap')
    expect(next.spine[1].durationFlicks).toBe(10 * F)
    expect(spineStartOf(next, 'c')).toBe(20 * F) // downstream unmoved
  })

  it('re-attaches connected clips to the replacement gap, keeping absolute time', () => {
    const s = seq([clip('a', 10), clip('b', 10)], [connected('cc', 'b', 2, 3)])
    const { next } = liftDelete(s, { ids: ['b'] })
    const cc = next.connected[0]
    expect(next.spine[1].kind).toBe('gap')
    expect(cc.parentClipId).toBe(next.spine[1].id)
    expect(connectedStartOf(next, 'cc')).toBe(12 * F)
  })
})

describe('blade', () => {
  it('is a no-op at a clip boundary', () => {
    const s = seq([clip('a', 10), clip('b', 10)])
    const result = blade(s, { clipId: 'b', timeFlicks: 10 * F })
    expect(result.next).toBe(s)
    expect(result.error).toBeUndefined()
  })

  it('splits mid-clip into two clips whose durations sum exactly', () => {
    const s = seq([clip('a', 10, 5)])
    const { next } = blade(s, { clipId: 'a', timeFlicks: 3 * F })
    expect(next.spine).toHaveLength(2)
    const [head, tail] = next.spine as Clip[]
    expect(head.id).toBe('a')
    expect(head.durationFlicks + tail.durationFlicks).toBe(10 * F)
    expect(head.durationFlicks).toBe(3 * F)
    expect(tail.mediaInFlicks).toBe(8 * F) // 5 + 3
    expect(tail.assetId).toBe(head.assetId)
  })

  it('blading twice at the same point changes nothing the second time', () => {
    const s = seq([clip('a', 10)])
    const first = blade(s, { clipId: 'a', timeFlicks: 3 * F })
    const second = blade(first.next, { clipId: 'a', timeFlicks: 3 * F })
    expect(second.next).toBe(first.next)
  })

  it('keeps connected clips with the half that contains them', () => {
    const s = seq([clip('a', 10)], [connected('early', 'a', 1, 2), connected('late', 'a', 7, 2)])
    const { next } = blade(s, { clipId: 'a', timeFlicks: 5 * F })
    const early = next.connected.find((candidate) => candidate.id === 'early')!
    const late = next.connected.find((candidate) => candidate.id === 'late')!
    expect(early.parentClipId).toBe('a')
    expect(late.parentClipId).toBe(next.spine[1].id)
    expect(connectedStartOf(next, 'early')).toBe(1 * F)
    expect(connectedStartOf(next, 'late')).toBe(7 * F)
  })
})

describe('trimRipple', () => {
  it('tail trim extends within source bounds and ripples downstream', () => {
    const s = seq([clip('a', 10), clip('b', 10)])
    const { next } = trimRipple(s, { clipId: 'a', edge: 'tail', deltaFlicks: 5 * F })
    expect((next.spine[0] as Clip).durationFlicks).toBe(15 * F)
    expect(spineStartOf(next, 'b')).toBe(15 * F)
  })

  it('tail trim clamps at the source media end', () => {
    const s = seq([clip('a', 10, 595)]) // only 595..600 available, 5 frames of tail room... none: 595+10>600 invalid? builder caps at 600: 595+10=605 — use legit clip
    const legit = seq([clip('b', 10, 580)]) // media 580..590, tail room = 10 frames
    const { next } = trimRipple(legit, { clipId: 'b', edge: 'tail', deltaFlicks: 50 * F })
    expect((next.spine[0] as Clip).durationFlicks).toBe(20 * F) // clamped to source end (580+20=600)
    void s
  })

  it('tail trim clamps shrink at one frame minimum', () => {
    const s = seq([clip('a', 10)])
    const { next } = trimRipple(s, { clipId: 'a', edge: 'tail', deltaFlicks: -100 * F })
    expect((next.spine[0] as Clip).durationFlicks).toBe(F)
  })

  it('head trim shrinks from the front: duration down, mediaIn up, downstream ripples', () => {
    const s = seq([clip('a', 10, 2), clip('b', 10)])
    const { next } = trimRipple(s, { clipId: 'a', edge: 'head', deltaFlicks: 3 * F })
    const a = next.spine[0] as Clip
    expect(a.durationFlicks).toBe(7 * F)
    expect(a.mediaInFlicks).toBe(5 * F)
    expect(spineStartOf(next, 'b')).toBe(7 * F)
  })

  it('head trim extending clamps at media start (mediaIn 0)', () => {
    const s = seq([clip('a', 10, 2)])
    const { next } = trimRipple(s, { clipId: 'a', edge: 'head', deltaFlicks: -50 * F })
    const a = next.spine[0] as Clip
    expect(a.mediaInFlicks).toBe(0)
    expect(a.durationFlicks).toBe(12 * F)
  })

  it('gaps trim freely but never below one frame', () => {
    const s = seq([clip('a', 10), gap('g', 5), clip('b', 10)])
    const shrunk = trimRipple(s, { clipId: 'g', edge: 'tail', deltaFlicks: -20 * F })
    expect(shrunk.next.spine[1].durationFlicks).toBe(F)
    const grown = trimRipple(s, { clipId: 'g', edge: 'tail', deltaFlicks: 5 * F })
    expect(grown.next.spine[1].durationFlicks).toBe(10 * F)
  })
})

describe('roll', () => {
  it('moves the edit point while preserving total duration', () => {
    const s = seq([clip('a', 10, 0), clip('b', 10, 10)])
    const { next } = roll(s, { editPointIndex: 0, deltaFlicks: 3 * F })
    const [a, b] = next.spine as Clip[]
    expect(a.durationFlicks).toBe(13 * F)
    expect(b.durationFlicks).toBe(7 * F)
    expect(b.mediaInFlicks).toBe(13 * F)
    expect(sequenceDuration(next)).toBe(20 * F)
  })

  it('clamps the roll so both sides keep at least one frame', () => {
    const s = seq([clip('a', 10), clip('b', 10, 10)])
    const { next } = roll(s, { editPointIndex: 0, deltaFlicks: 100 * F })
    const [a, b] = next.spine as Clip[]
    expect(b.durationFlicks).toBe(F)
    expect(a.durationFlicks).toBe(19 * F)
    expect(sequenceDuration(next)).toBe(20 * F)
  })

  it('clamps against media bounds of the extending side', () => {
    const s = seq([clip('a', 10, 590), clip('b', 10, 10)]) // a has no tail media room
    const { next } = roll(s, { editPointIndex: 0, deltaFlicks: 5 * F })
    expect((next.spine[0] as Clip).durationFlicks).toBe(10 * F) // could not extend
    expect(sequenceDuration(next)).toBe(20 * F)
  })

  it('invalid edit point index is a typed-error no-op', () => {
    const s = seq([clip('a', 10)])
    const result = roll(s, { editPointIndex: 5, deltaFlicks: F })
    expect(result.error).toBeDefined()
  })
})

describe('slip', () => {
  it('changes the media in-point without moving the clip', () => {
    const s = seq([clip('a', 10), clip('b', 10, 20)])
    const { next } = slip(s, { clipId: 'b', deltaFlicks: 5 * F })
    const b = next.spine[1] as Clip
    expect(b.mediaInFlicks).toBe(25 * F)
    expect(b.durationFlicks).toBe(10 * F)
    expect(spineStartOf(next, 'b')).toBe(10 * F)
    expect(sequenceDuration(next)).toBe(sequenceDuration(s))
  })

  it('clamps the slip within [0, source - duration]', () => {
    const s = seq([clip('a', 10, 5)])
    expect(
      (slip(s, { clipId: 'a', deltaFlicks: -100 * F }).next.spine[0] as Clip).mediaInFlicks
    ).toBe(0)
    expect(
      (slip(s, { clipId: 'a', deltaFlicks: 100_000 * F }).next.spine[0] as Clip).mediaInFlicks
    ).toBe(590 * F)
  })

  it('slipping a gap is a typed-error no-op', () => {
    const s = seq([gap('g', 10)])
    expect(slip(s, { clipId: 'g', deltaFlicks: F }).error).toBeDefined()
  })
})

/** Lane −1 audio clip with a non-zero media in-point (the builder's default is 0). */
function audioConnected(
  id: string,
  parentClipId: string,
  offsetFrames: number,
  durationFrames: number,
  mediaInFrames = 0,
  lane = -1
): ConnectedClip {
  return {
    ...connected(id, parentClipId, offsetFrames, durationFrames, lane),
    mediaInFlicks: mediaInFrames * F
  }
}

describe('detachAudio', () => {
  it('disables the spine clip audio and adds a matching lane -1 connected clip', () => {
    const s = seq([clip('a', 10, 2)])
    const { next, error } = detachAudio(s, { clipId: 'a' })
    expect(error).toBeUndefined()
    const spineClip = next.spine[0] as Clip
    expect(spineClip.audioDisabled).toBe(true)
    expect(spineClip.mediaInFlicks).toBe(2 * F) // video untouched
    expect(spineClip.durationFlicks).toBe(10 * F)
    expect(next.connected).toHaveLength(1)
    const audio = next.connected[0]
    expect(audio.id).toBe('a:audio')
    expect(audio.assetId).toBe('asset-a')
    expect(audio.parentClipId).toBe('a')
    expect(audio.offsetFlicks).toBe(0)
    expect(audio.lane).toBe(-1)
    expect(audio.mediaInFlicks).toBe(2 * F)
    expect(audio.durationFlicks).toBe(10 * F)
    expect(audio.sourceDurationFlicks).toBe(600 * F)
    expect(connectedStartOf(next, 'a:audio')).toBe(0)
  })

  it('rejects a second detach on the same clip', () => {
    const s = seq([clip('a', 10)])
    const first = detachAudio(s, { clipId: 'a' })
    const second = detachAudio(first.next, { clipId: 'a' })
    expect(second.error?.code).toBe('invalid-target')
    expect(second.next).toBe(first.next)
  })

  it('rejects gaps and non-spine ids (titles/connected clips)', () => {
    const s = seq([clip('a', 10), gap('g', 5)], [connected('title', 'a', 0, 4)])
    expect(detachAudio(s, { clipId: 'g' }).error?.code).toBe('invalid-target')
    expect(detachAudio(s, { clipId: 'title' }).error?.code).toBe('unknown-id')
    expect(detachAudio(s, { clipId: 'zzz' }).error?.code).toBe('unknown-id')
  })

  it('bumps to lane -2 when an audio clip already occupies lane -1', () => {
    const s = seq([clip('a', 10)], [connected('music', 'a', 0, 10, -1)])
    const { next } = detachAudio(s, { clipId: 'a' })
    const audio = next.connected.find((cc) => cc.id === 'a:audio')!
    expect(audio.lane).toBe(-2) // earlier clip keeps lane -1
    expect(next.connected.find((cc) => cc.id === 'music')!.lane).toBe(-1)
  })

  it('allocates a fresh id when <clipId>:audio is taken', () => {
    const s = seq([clip('a', 10)], [connected('a:audio', 'a', 0, 3)])
    const { next } = detachAudio(s, { clipId: 'a' })
    expect(next.connected.map((cc) => cc.id)).toContain('a:audio~2')
  })

  it('returns an inverse that restores the pre-detach sequence', () => {
    const s = seq([clip('a', 10, 2)])
    const result = detachAudio(s, { clipId: 'a' })
    expect(result.next).not.toBe(s)
    expect(result.inverse.type).toBe('restore')
    expect(result.inverse.sequence).toEqual(s)
  })
})

describe('trimConnected', () => {
  it('head trim shrinks from the front: offset up, mediaIn up, duration down', () => {
    const s = seq([clip('a', 10)], [audioConnected('cc', 'a', 2, 5, 3)])
    const { next } = trimConnected(s, { clipId: 'cc', edge: 'head', deltaFlicks: 2 * F })
    const cc = next.connected[0]
    expect(cc.offsetFlicks).toBe(4 * F)
    expect(cc.mediaInFlicks).toBe(5 * F)
    expect(cc.durationFlicks).toBe(3 * F)
    expect(connectedStartOf(next, 'cc')).toBe(4 * F)
  })

  it('negative head delta pulls the start before the parent (negative offset = J-cut)', () => {
    const s = seq([clip('p', 10), clip('a', 10)], [audioConnected('cc', 'a', 0, 10, 5)])
    const { next, error } = trimConnected(s, { clipId: 'cc', edge: 'head', deltaFlicks: -2 * F })
    expect(error).toBeUndefined()
    const cc = next.connected[0]
    expect(cc.offsetFlicks).toBe(-2 * F)
    expect(cc.mediaInFlicks).toBe(3 * F)
    expect(cc.durationFlicks).toBe(12 * F)
    expect(connectedStartOf(next, 'cc')).toBe(8 * F) // before the parent's start at 10
  })

  it('head extension clamps at the media start (mediaIn 0)', () => {
    const s = seq([clip('p', 10), clip('a', 10)], [audioConnected('cc', 'a', 0, 10, 3)])
    const { next } = trimConnected(s, { clipId: 'cc', edge: 'head', deltaFlicks: -100 * F })
    const cc = next.connected[0]
    expect(cc.mediaInFlicks).toBe(0)
    expect(cc.offsetFlicks).toBe(-3 * F)
    expect(cc.durationFlicks).toBe(13 * F)
  })

  it('head extension clamps so the derived absolute start stays >= 0', () => {
    // plenty of media headroom (mediaIn 50) but only 1 frame of timeline room
    const s = seq([clip('a', 10)], [audioConnected('cc', 'a', 1, 5, 50)])
    const { next } = trimConnected(s, { clipId: 'cc', edge: 'head', deltaFlicks: -100 * F })
    const cc = next.connected[0]
    expect(cc.offsetFlicks).toBe(0)
    expect(cc.mediaInFlicks).toBe(49 * F)
    expect(connectedStartOf(next, 'cc')).toBe(0)
  })

  it('head shrink clamps at one frame of remaining duration', () => {
    const s = seq([clip('a', 10)], [audioConnected('cc', 'a', 0, 5, 3)])
    const { next } = trimConnected(s, { clipId: 'cc', edge: 'head', deltaFlicks: 100 * F })
    expect(next.connected[0].durationFlicks).toBe(F)
  })

  it('head extension fully clamped to zero is a clean no-op', () => {
    // mediaIn 0 at absolute 0: nothing earlier to reveal in either dimension
    const s = seq([clip('a', 10)], [audioConnected('cc', 'a', 0, 5)])
    const result = trimConnected(s, { clipId: 'cc', edge: 'head', deltaFlicks: -5 * F })
    expect(result.next).toBe(s)
    expect(result.error).toBeUndefined()
  })

  it('tail extension clamps at the source media end (the L-cut bound)', () => {
    const s = seq([clip('a', 10)], [audioConnected('cc', 'a', 0, 5, 3)])
    const { next } = trimConnected(s, { clipId: 'cc', edge: 'tail', deltaFlicks: 100_000 * F })
    expect(next.connected[0].durationFlicks).toBe(597 * F) // 600 source - 3 mediaIn
    expect(next.connected[0].mediaInFlicks).toBe(3 * F)
  })

  it('tail shrink clamps at one frame', () => {
    const s = seq([clip('a', 10)], [audioConnected('cc', 'a', 0, 5)])
    const { next } = trimConnected(s, { clipId: 'cc', edge: 'tail', deltaFlicks: -100 * F })
    expect(next.connected[0].durationFlicks).toBe(F)
  })

  it('unknown ids (including spine ids) are typed-error no-ops', () => {
    const s = seq([clip('a', 10)], [audioConnected('cc', 'a', 0, 5)])
    expect(trimConnected(s, { clipId: 'zzz', edge: 'head', deltaFlicks: F }).error?.code).toBe(
      'unknown-id'
    )
    expect(trimConnected(s, { clipId: 'a', edge: 'tail', deltaFlicks: F }).error?.code).toBe(
      'unknown-id'
    )
  })

  it('returns an inverse that restores the pre-trim sequence', () => {
    const s = seq([clip('p', 10), clip('a', 10)], [audioConnected('cc', 'a', 0, 10, 5)])
    const result = trimConnected(s, { clipId: 'cc', edge: 'head', deltaFlicks: -2 * F })
    expect(result.inverse.type).toBe('restore')
    expect(result.inverse.sequence).toEqual(s)
  })
})

describe('move', () => {
  it('rearranges magnetically: the spine closes and reopens', () => {
    const s = seq([clip('a', 10), clip('b', 10), clip('c', 10)])
    const { next } = move(s, { clipId: 'a', toIndex: 2 })
    expect(next.spine.map((item) => item.id)).toEqual(['b', 'c', 'a'])
    expect(spineStartOf(next, 'b')).toBe(0)
    expect(spineStartOf(next, 'a')).toBe(20 * F)
    expect(sequenceDuration(next)).toBe(30 * F)
  })

  it('connected clips travel with their moved parent', () => {
    const s = seq([clip('a', 10), clip('b', 10)], [connected('cc', 'a', 2, 3)])
    const { next } = move(s, { clipId: 'a', toIndex: 1 })
    expect(connectedStartOf(next, 'cc')).toBe(12 * F)
  })

  it('clamps the target index', () => {
    const s = seq([clip('a', 10), clip('b', 10)])
    const { next } = move(s, { clipId: 'a', toIndex: 99 })
    expect(next.spine.map((item) => item.id)).toEqual(['b', 'a'])
  })

  it('moving to its own index is a clean no-op', () => {
    const s = seq([clip('a', 10), clip('b', 10)])
    const result = move(s, { clipId: 'a', toIndex: 0 })
    expect(result.next).toBe(s)
    expect(result.error).toBeUndefined()
  })
})

describe('sub-frame edge clamps (fast-check regressions)', () => {
  it('overwriting one flick past a frame boundary snaps instead of cutting a sliver', () => {
    // shrunk fast-check counterexample: 1-frame clip, overwrite at timeFlicks=1
    const s = seq([clip('a', 1)])
    const { next } = overwriteAt(s, { clip: newClip('x', 1), timeFlicks: 1 })
    for (const item of next.spine) {
      expect(item.durationFlicks).toBeGreaterThanOrEqual(F)
    }
  })

  it('inserting one flick into a clip snaps to the nearest boundary instead of splitting', () => {
    const s = seq([clip('a', 10)])
    const { next } = insertAt(s, { clip: newClip('x', 5), timeFlicks: 1 })
    expect(next.spine.map((item) => item.id)).toEqual(['x', 'a'])
    expect(sequenceDuration(next)).toBe(15 * F)
  })

  it('overwriting beyond the end never creates a sub-frame gap filler', () => {
    const s = seq([clip('a', 10)])
    const { next } = overwriteAt(s, { clip: newClip('x', 5), timeFlicks: 10 * F + 1 })
    expect(next.spine.map((item) => item.id)).toEqual(['a', 'x'])
    const farther = overwriteAt(s, { clip: newClip('x', 5), timeFlicks: 13 * F })
    expect(farther.next.spine[1].kind).toBe('gap')
    expect(farther.next.spine[1].durationFlicks).toBe(3 * F)
  })
})

describe('typed-error and no-op edges', () => {
  it('append rejects a negative media in-point', () => {
    const s = seq([])
    const result = append(s, { clip: { ...newClip('b', 5), mediaInFlicks: -1 } })
    expect(result.error?.code).toBe('invalid-clip')
    expect(result.next).toBe(s)
  })

  it('connectAt rejects lane 0', () => {
    const s = seq([clip('a', 10)])
    const result = connectAt(s, { clip: newClip('cc', 4), timeFlicks: 0, lane: 0 })
    expect(result.error?.code).toBe('invalid-target')
  })

  it('connectAt can attach to a gap', () => {
    const s = seq([clip('a', 10), gap('g', 10)])
    const { next, error } = connectAt(s, { clip: newClip('cc', 4), timeFlicks: 15 * F, lane: 1 })
    expect(error).toBeUndefined()
    expect(next.connected[0].parentClipId).toBe('g')
  })

  it('liftDelete with an unknown id is a typed-error no-op', () => {
    const s = seq([clip('a', 10)])
    const result = liftDelete(s, { ids: ['zzz'] })
    expect(result.error?.code).toBe('unknown-id')
    expect(result.next).toBe(s)
  })

  it('deleting nothing is a clean no-op', () => {
    const s = seq([clip('a', 10)])
    expect(rippleDelete(s, { ids: [] }).next).toBe(s)
    expect(liftDelete(s, { ids: [] }).next).toBe(s)
  })

  it('blade and trim on unknown ids are typed-error no-ops', () => {
    const s = seq([clip('a', 10)])
    expect(blade(s, { clipId: 'zzz', timeFlicks: F }).error?.code).toBe('unknown-id')
    expect(trimRipple(s, { clipId: 'zzz', edge: 'tail', deltaFlicks: F }).error?.code).toBe(
      'unknown-id'
    )
    expect(slip(s, { clipId: 'zzz', deltaFlicks: F }).error?.code).toBe('unknown-id')
    expect(move(s, { clipId: 'zzz', toIndex: 0 }).error?.code).toBe('unknown-id')
  })

  it('split ids stay unique even when a clip re-covers an old cut point', () => {
    const s = seq([clip('a', 10)])
    const first = blade(s, { clipId: 'a', timeFlicks: 3 * F }) // tail gets id a:<3F>
    const healed = trimRipple(first.next, { clipId: 'a', edge: 'tail', deltaFlicks: 2 * F })
    const second = blade(healed.next, { clipId: 'a', timeFlicks: 3 * F }) // same cut again
    const ids = second.next.spine.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('setCaptionSettings', () => {
  const captions = {
    enabled: true,
    preset: 'karaoke' as const,
    font: 'system-ui, sans-serif',
    sizePx: 56,
    color: '#ffffff',
    highlightColor: '#ffd60a',
    position: 'bottom' as const
  }

  it('sets sequence-level captions without touching spine/connected', () => {
    const s = seq([clip('a', 10)], [connected('cc', 'a', 2, 3)])
    const { next, error } = setCaptionSettings(s, { captions })
    expect(error).toBeUndefined()
    expect(next.captions).toEqual(captions)
    expect(next.spine).toBe(s.spine)
    expect(next.connected).toBe(s.connected)
  })

  it('returns a restore inverse (undoable back to no captions)', () => {
    const s = seq([clip('a', 10)])
    const result = setCaptionSettings(s, { captions })
    expect(result.inverse).toEqual({ type: 'restore', sequence: s })
    expect(result.inverse.sequence.captions).toBeUndefined()
  })

  it('rejects unknown presets and positions as typed errors', () => {
    const s = seq([clip('a', 10)])
    const badPreset = setCaptionSettings(s, {
      captions: { ...captions, preset: 'bouncy' as never }
    })
    expect(badPreset.error?.code).toBe('invalid-target')
    expect(badPreset.next).toBe(s)
    const badPosition = setCaptionSettings(s, {
      captions: { ...captions, position: 'left' as never }
    })
    expect(badPosition.error?.code).toBe('invalid-target')
    expect(badPosition.next).toBe(s)
  })

  it('rejects non-positive or non-finite sizes', () => {
    const s = seq([clip('a', 10)])
    expect(setCaptionSettings(s, { captions: { ...captions, sizePx: 0 } }).error?.code).toBe(
      'invalid-target'
    )
    expect(setCaptionSettings(s, { captions: { ...captions, sizePx: NaN } }).error?.code).toBe(
      'invalid-target'
    )
  })
})

describe('inverses (spot checks — the property suite covers the rest)', () => {
  it('every op returns an inverse that restores the previous sequence', () => {
    const s = seq([clip('a', 10), clip('b', 10)], [connected('cc', 'a', 2, 3)])
    const ops = [
      append(s, { clip: newClip('z', 5) }),
      insertAt(s, { clip: newClip('z', 5), timeFlicks: 4 * F }),
      rippleDelete(s, { ids: ['a'] }),
      blade(s, { clipId: 'a', timeFlicks: 4 * F }),
      trimRipple(s, { clipId: 'a', edge: 'tail', deltaFlicks: 3 * F })
    ]
    for (const result of ops) {
      expect(result.error).toBeUndefined()
      // restore-style inverse: applying it must yield the original
      expect(result.inverse.type).toBe('restore')
      if (result.inverse.type === 'restore') {
        expect(result.inverse.sequence).toEqual(s)
      }
    }
  })
})
