import { describe, expect, it } from 'vitest'
import type { AudioEnvelope } from '../../shared/types'
import type { Clip } from '../../shared/timeline/model'
import { clip, connected, deepFreeze, gap, seq } from '../../shared/timeline/testing'
import { detectSilence } from './detect'

const SEC = 705_600_000
/** One 50 ms envelope window in flicks. */
const W = SEC / 20

/** Build an envelope from [windowCount, dB] runs, e.g. runs([20, -10], [20, -50]). */
function runs(...segments: [number, number][]): AudioEnvelope {
  const rmsDb: number[] = []
  for (const [count, db] of segments) rmsDb.push(...Array<number>(count).fill(db))
  return deepFreeze({ windowMs: 50, rmsDb })
}

function envelopes(map: Record<string, AudioEnvelope>): Map<string, AudioEnvelope> {
  return new Map(Object.entries(map))
}

/** A spine clip with an explicit assetId (testing.ts derives it from the id). */
function clipOf(id: string, assetId: string, durationFrames: number, mediaInFrames = 0): Clip {
  return { ...clip(id, durationFrames, mediaInFrames), assetId }
}

describe('detectSilence', () => {
  it('finds a padded mid-clip run with exact window→flicks math (defaults)', () => {
    // 3 s clip = 60 windows: 1 s loud, 1 s silent, 1 s loud
    const s = seq([clip('a', 90)])
    const found = detectSilence(s, envelopes({ 'asset-a': runs([20, -10], [20, -50], [20, -10]) }))
    // run = [20W, 40W) = [1 s, 2 s); default 100 ms pad insets both ends
    expect(found).toEqual([{ fromFlicks: 20 * W + SEC / 10, toFlicks: 40 * W - SEC / 10 }])
    expect(found[0].fromFlicks).toBe(776_160_000) // 1.1 s exactly
    expect(found[0].toFlicks).toBe(1_340_640_000) // 1.9 s exactly
  })

  it('treats a window exactly at the threshold as NOT silent (strictly below)', () => {
    const s = seq([clip('a', 90)])
    const opts = { thresholdDb: -34, minDurationFlicks: W, padFlicks: 0 }
    expect(
      detectSilence(s, envelopes({ 'asset-a': runs([20, -10], [20, -34], [20, -10]) }), opts)
    ).toEqual([])
    expect(
      detectSilence(s, envelopes({ 'asset-a': runs([20, -10], [20, -34.1], [20, -10]) }), opts)
    ).toEqual([{ fromFlicks: 20 * W, toFlicks: 40 * W }])
  })

  it('drops runs shorter than minDuration; keeps runs exactly at it', () => {
    const s = seq([clip('a', 90)])
    const nine = envelopes({ 'asset-a': runs([20, -10], [9, -50], [31, -10]) })
    const ten = envelopes({ 'asset-a': runs([20, -10], [10, -50], [30, -10]) })
    const opts = { minDurationFlicks: SEC / 2, padFlicks: 0 }
    expect(detectSilence(s, nine, opts)).toEqual([]) // 0.45 s < 0.5 s
    expect(detectSilence(s, ten, opts)).toEqual([{ fromFlicks: 20 * W, toFlicks: 30 * W }])
  })

  it('padding only shrinks: a run whose padded extent collapses is dropped', () => {
    const s = seq([clip('a', 90)])
    const e = envelopes({ 'asset-a': runs([20, -10], [10, -50], [30, -10]) }) // 0.5 s run
    expect(
      detectSilence(s, e, { minDurationFlicks: SEC / 2, padFlicks: SEC / 4 }) // 2×250 ms ≥ 500 ms
    ).toEqual([])
    expect(
      detectSilence(s, e, { minDurationFlicks: SEC / 2, padFlicks: SEC / 5 }) // 100 ms left
    ).toEqual([{ fromFlicks: 20 * W + SEC / 5, toFlicks: 30 * W - SEC / 5 }])
  })

  it('maps through mediaIn: clip slice of the envelope lands in sequence time', () => {
    // clip shows media [1 s, 3 s); asset is silent over media [0 s, 2 s)
    const s = seq([clip('a', 60, 30)])
    const found = detectSilence(s, envelopes({ 'asset-a': runs([40, -60], [20, -10]) }))
    // silent slice inside the clip = media [1 s, 2 s) → sequence [0 s, 1 s), padded
    expect(found).toEqual([{ fromFlicks: SEC / 10, toFlicks: SEC - SEC / 10 }])
  })

  it('clips ranges to clip boundaries when the silent run extends past them', () => {
    // clip shows media [0.5 s, 1.5 s) of an asset that is silent throughout
    const s = seq([clip('a', 30, 15)])
    const found = detectSilence(s, envelopes({ 'asset-a': runs([60, -60]) }), { padFlicks: 0 })
    expect(found).toEqual([{ fromFlicks: 0, toFlicks: SEC }])
  })

  it('walks multiple clips (and spine gaps) emitting ascending ranges', () => {
    // a: loud 1 s then silent 2 s · 1 s authored gap · b: silent 1 s then loud 2 s
    const s = seq([clip('a', 90), gap('g', 30), clip('b', 90)])
    const found = detectSilence(
      s,
      envelopes({
        'asset-a': runs([20, -10], [40, -50]),
        'asset-b': runs([20, -50], [40, -10])
      }),
      { padFlicks: 0 }
    )
    // authored gap [3 s, 4 s) is intentionally NOT detected; b starts at 4 s
    expect(found).toEqual([
      { fromFlicks: SEC, toFlicks: 3 * SEC },
      { fromFlicks: 4 * SEC, toFlicks: 5 * SEC }
    ])
  })

  it('skips clips whose asset has no envelope', () => {
    const s = seq([clip('a', 90), clip('b', 90)])
    const found = detectSilence(s, envelopes({ 'asset-b': runs([20, -50], [40, -10]) }), {
      padFlicks: 0
    })
    expect(found).toEqual([{ fromFlicks: 3 * SEC, toFlicks: 4 * SEC }])
  })

  it('skips audio-disabled spine clips (detached audio lives in lane −1)', () => {
    const muted: Clip = { ...clip('a', 90), audioDisabled: true }
    const s = seq([muted])
    expect(detectSilence(s, envelopes({ 'asset-a': runs([60, -60]) }), { padFlicks: 0 })).toEqual(
      []
    )
  })

  it('detects over connected clips and merges overlap with the spine range', () => {
    // spine clip silent over [1 s, 3 s); connected clip (lane −1) silent over its whole 2 s
    const cc = { ...connected('c', 'a', 60, 60, -1), assetId: 'asset-c' }
    const s = seq([clip('a', 90)], [cc])
    const found = detectSilence(
      s,
      envelopes({
        'asset-a': runs([20, -10], [40, -50]),
        'asset-c': runs([40, -60])
      }),
      { padFlicks: 0 }
    )
    // spine [1 s, 3 s) ∪ connected [2 s, 4 s) → merged [1 s, 4 s)
    expect(found).toEqual([{ fromFlicks: SEC, toFlicks: 4 * SEC }])
  })

  it('merges touching ranges from adjacent clips cut out of one silent region', () => {
    const s = seq([clipOf('a1', 'asset-a', 30, 0), clipOf('a2', 'asset-a', 30, 30)])
    const found = detectSilence(s, envelopes({ 'asset-a': runs([60, -60]) }), { padFlicks: 0 })
    expect(found).toEqual([{ fromFlicks: 0, toFlicks: 2 * SEC }])
  })

  it('returns [] for an empty sequence', () => {
    expect(detectSilence(seq([]), envelopes({}))).toEqual([])
  })

  it('handles a clip duration that ends mid-window (partial last window)', () => {
    // 45 frames = 1.5 s = 30 windows exactly; mediaIn 0.025 s offsets window grid
    const s = seq([{ ...clip('a', 45), mediaInFlicks: W / 2 }])
    // silent from window 10 to the end of the envelope (covers the clip tail)
    const found = detectSilence(s, envelopes({ 'asset-a': runs([10, -10], [25, -50]) }), {
      padFlicks: 0
    })
    // run starts at 10W in media time → sequence 10W − W/2; ends at clip end (1.5 s)
    expect(found).toEqual([{ fromFlicks: 10 * W - W / 2, toFlicks: 30 * W }])
  })
})
