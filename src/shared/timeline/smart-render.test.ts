import { describe, expect, it } from 'vitest'
import type { CaptionSettings, Clip, ClipFx, ConnectedClip, Sequence } from './model'
import { DEFAULT_FX } from './ops'
import { smartRenderPlan } from './smart-render'
import { F, FPS30, deepFreeze, gap } from './testing'

/** A spine clip from the SAME asset (testing.ts's clip() makes one asset per id). */
function vclip(
  id: string,
  durationFrames: number,
  mediaInFrames = 0,
  extra: Partial<Clip> = {}
): Clip {
  return {
    kind: 'clip',
    id,
    assetId: 'asset-vod',
    mediaInFlicks: mediaInFrames * F,
    durationFlicks: durationFrames * F,
    sourceDurationFlicks: 600 * F,
    ...extra
  }
}

function audioClip(
  id: string,
  parentClipId: string,
  extra: Partial<ConnectedClip> = {}
): ConnectedClip {
  return {
    id,
    assetId: 'asset-music',
    parentClipId,
    offsetFlicks: 0,
    lane: -1,
    mediaInFlicks: 0,
    durationFlicks: 30 * F,
    sourceDurationFlicks: 600 * F,
    ...extra
  }
}

function seqOf(parts: Partial<Sequence>): Sequence {
  return deepFreeze({ id: 'seq', fps: FPS30, spine: [], connected: [], ...parts })
}

const captionsOff: CaptionSettings = {
  enabled: false,
  preset: 'pop-in',
  font: 'Inter',
  sizePx: 48,
  color: '#fff',
  highlightColor: '#ff0',
  position: 'bottom'
}

describe('smartRenderPlan eligibility', () => {
  it('single untouched clip → full-asset plan', () => {
    const plan = smartRenderPlan(seqOf({ spine: [vclip('a', 300)] }))
    expect(plan).toEqual({ assetId: 'asset-vod', mediaInFlicks: 0, durationFlicks: 300 * F })
  })

  it('single trimmed clip → trim plan (head + tail trims stay eligible)', () => {
    const plan = smartRenderPlan(seqOf({ spine: [vclip('a', 100, 50)] }))
    expect(plan).toEqual({ assetId: 'asset-vod', mediaInFlicks: 50 * F, durationFlicks: 100 * F })
  })

  it('blade rejoin (media-contiguous splits) stays eligible', () => {
    const plan = smartRenderPlan(
      seqOf({ spine: [vclip('a', 40, 10), vclip('b', 60, 50), vclip('c', 25, 110)] })
    )
    expect(plan).toEqual({ assetId: 'asset-vod', mediaInFlicks: 10 * F, durationFlicks: 125 * F })
  })

  it('empty spine → null', () => {
    expect(smartRenderPlan(seqOf({}))).toBeNull()
  })

  it('gap in the spine → null', () => {
    expect(
      smartRenderPlan(seqOf({ spine: [vclip('a', 40), gap('g', 10), vclip('b', 40, 40)] }))
    ).toBeNull()
  })

  it('second asset on the spine → null', () => {
    const other = { ...vclip('b', 40, 40), assetId: 'asset-other' }
    expect(smartRenderPlan(seqOf({ spine: [vclip('a', 40), other] }))).toBeNull()
  })

  it('media-discontiguous (cut removed in the middle) → null', () => {
    expect(smartRenderPlan(seqOf({ spine: [vclip('a', 40, 0), vclip('b', 40, 50)] }))).toBeNull()
  })

  it('out-of-order media (rearranged pieces) → null', () => {
    expect(smartRenderPlan(seqOf({ spine: [vclip('a', 40, 40), vclip('b', 40, 0)] }))).toBeNull()
  })

  it('overlapping media (repeated span) → null', () => {
    expect(smartRenderPlan(seqOf({ spine: [vclip('a', 40, 0), vclip('b', 40, 20)] }))).toBeNull()
  })

  it('transition → null; empty transitions array is fine', () => {
    const spine = [vclip('a', 40, 0), vclip('b', 40, 40)]
    expect(
      smartRenderPlan(
        seqOf({
          spine,
          transitions: [{ id: 't', afterClipId: 'a', durationFlicks: 10 * F, kind: 'dissolve' }]
        })
      )
    ).toBeNull()
    expect(smartRenderPlan(seqOf({ spine, transitions: [] }))).not.toBeNull()
  })

  it('title (connected, titleData) → null', () => {
    const title = audioClip('t', 'a', {
      lane: 1,
      titleData: {
        text: 'hi',
        font: 'Inter',
        sizePx: 64,
        color: '#fff',
        x: 960,
        y: 540,
        preset: 'basic'
      }
    })
    expect(smartRenderPlan(seqOf({ spine: [vclip('a', 40)], connected: [title] }))).toBeNull()
  })

  it('connected VIDEO clip (lane > 0) → null', () => {
    const overlay = audioClip('v', 'a', { lane: 1 })
    expect(smartRenderPlan(seqOf({ spine: [vclip('a', 40)], connected: [overlay] }))).toBeNull()
  })

  it('connected AUDIO clips (lane < 0, music bed) stay eligible', () => {
    const plan = smartRenderPlan(
      seqOf({ spine: [vclip('a', 40)], connected: [audioClip('m', 'a')] })
    )
    expect(plan).not.toBeNull()
  })

  it('captions enabled → null; disabled or absent stays eligible', () => {
    const spine = [vclip('a', 40)]
    expect(
      smartRenderPlan(seqOf({ spine, captions: { ...captionsOff, enabled: true } }))
    ).toBeNull()
    expect(smartRenderPlan(seqOf({ spine, captions: captionsOff }))).not.toBeNull()
  })

  it.each([
    ['posX', 10],
    ['posY', -4],
    ['scale', 50],
    ['rotation', 90],
    ['opacity', 80],
    ['exposure', 0.5],
    ['contrast', 1.2],
    ['saturation', 0],
    ['temperature', -0.3]
  ] as const)('non-default video/color fx %s → null', (param, value) => {
    const fx: ClipFx = { ...DEFAULT_FX, [param]: value }
    expect(smartRenderPlan(seqOf({ spine: [vclip('a', 40, 0, { fx })] }))).toBeNull()
  })

  it('keyframes → null even when the scalars are at default', () => {
    const fx: ClipFx = {
      ...DEFAULT_FX,
      kf: { opacity: [{ atMediaFlicks: 0, value: 100, ease: 'linear' }] }
    }
    expect(smartRenderPlan(seqOf({ spine: [vclip('a', 40, 0, { fx })] }))).toBeNull()
  })

  it('empty keyframe tracks and audio-only fx stay eligible (audio is re-mixed)', () => {
    const fx: ClipFx = {
      ...DEFAULT_FX,
      volumeDb: -6,
      pan: 0.5,
      fadeInFlicks: 10 * F,
      fadeOutFlicks: 10 * F,
      kf: { opacity: [] }
    }
    expect(smartRenderPlan(seqOf({ spine: [vclip('a', 40, 0, { fx })] }))).not.toBeNull()
  })

  it('audioDisabled spine clip + detached audio in lane −1 stays eligible', () => {
    const detached = audioClip('d', 'a', { assetId: 'asset-vod' })
    const plan = smartRenderPlan(
      seqOf({ spine: [vclip('a', 40, 0, { audioDisabled: true })], connected: [detached] })
    )
    expect(plan).toEqual({ assetId: 'asset-vod', mediaInFlicks: 0, durationFlicks: 40 * F })
  })
})
