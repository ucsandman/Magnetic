import { describe, expect, it } from 'vitest'
import { flicksToSeconds } from '../../shared/timecode'
import type { ConnectedClip } from '../../shared/timeline/model'
import { detachAudio, trimConnected } from '../../shared/timeline/ops'
import { F, clip, seq } from '../../shared/timeline/testing'
import { collectAudioJobs } from './audio-graph'

/**
 * Audible-path unit proof for detach + split edits: audio-disabled spine clips
 * schedule nothing, the detached lane −1 clip schedules in their place, and a
 * negative offset (J-cut) starts the audio before the parent's video.
 */
describe('collectAudioJobs with detached audio', () => {
  it('skips spine clips with audioDisabled; the detached clip plays instead', () => {
    const s = seq([clip('a', 10), clip('b', 10)])
    const { next } = detachAudio(s, { clipId: 'a' })
    const jobs = collectAudioJobs(next)
    // spine: only b; connected: a:audio — never both halves of a
    expect(jobs).toHaveLength(2)
    const spineJob = jobs.find((job) => job.assetId === 'asset-b')!
    expect(spineJob.clipStartSec).toBe(flicksToSeconds(10 * F))
    const audioJob = jobs.find((job) => job.assetId === 'asset-a')!
    expect(audioJob.clipStartSec).toBe(0)
    expect(audioJob.durSec).toBe(flicksToSeconds(10 * F))
  })

  it('a J-cut (negative offset) schedules audio before the parent video starts', () => {
    const s = seq([clip('p', 10), clip('a', 10, 5)])
    const detached = detachAudio(s, { clipId: 'a' }).next
    const { next, error } = trimConnected(detached, {
      clipId: 'a:audio',
      edge: 'head',
      deltaFlicks: -2 * F
    })
    expect(error).toBeUndefined()
    const jobs = collectAudioJobs(next)
    const audioJob = jobs.find((job) => job.assetId === 'asset-a')!
    // parent video starts at 10 frames; its audio leads in at 8
    expect(audioJob.clipStartSec).toBe(flicksToSeconds(8 * F))
    expect(audioJob.mediaInSec).toBe(flicksToSeconds(3 * F))
    expect(audioJob.durSec).toBe(flicksToSeconds(12 * F))
  })
})

/** Lane −1 music clip; source is 600 frames (the testing.ts default). */
function musicClip(overrides: Partial<ConnectedClip>): ConnectedClip {
  return {
    id: 'music',
    assetId: 'asset-music',
    parentClipId: 'a',
    offsetFlicks: 0,
    lane: -1,
    mediaInFlicks: 0,
    durationFlicks: 600 * F,
    sourceDurationFlicks: 600 * F,
    loop: true,
    ...overrides
  }
}

describe('collectAudioJobs loop tiling', () => {
  const sec = (frames: number): number => flicksToSeconds(frames * F)

  it('tiles a looped clip: [mediaIn, source) first, then full-source wraps', () => {
    // mediaIn 60, source 600, duration 1500 → iterations 540 + 600 + 360
    const s = seq(
      [{ ...clip('a', 100), audioDisabled: true }],
      [musicClip({ mediaInFlicks: 60 * F, durationFlicks: 1500 * F })]
    )
    const jobs = collectAudioJobs(s)
    expect(jobs.map((job) => [job.clipStartSec, job.mediaInSec, job.durSec])).toEqual([
      [0, sec(60), sec(540)],
      [sec(540), 0, sec(600)],
      [sec(1140), 0, sec(360)]
    ])
    // every iteration shares the whole-clip envelope span (fade-out at the END)
    for (const job of jobs) {
      expect(job.env).toEqual({ clipStartSec: 0, durSec: sec(1500) })
    }
  })

  it('a mediaIn pushed past the source by head trims wraps into the source', () => {
    const s = seq(
      [{ ...clip('a', 100), audioDisabled: true }],
      [musicClip({ mediaInFlicks: 750 * F, durationFlicks: 480 * F })]
    )
    const jobs = collectAudioJobs(s)
    expect(jobs.map((job) => [job.mediaInSec, job.durSec])).toEqual([
      [sec(150), sec(450)], // 750 mod 600 = 150 → plays to the source end
      [0, sec(30)]
    ])
  })

  it('a looped clip shorter than its remaining source stays a single job', () => {
    const s = seq(
      [{ ...clip('a', 100), audioDisabled: true }],
      [musicClip({ durationFlicks: 90 * F })]
    )
    const jobs = collectAudioJobs(s)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].durSec).toBe(sec(90))
    expect(jobs[0].mediaInSec).toBe(0)
  })

  it('non-loop connected clips are untouched (no env, one job)', () => {
    const s = seq(
      [{ ...clip('a', 100), audioDisabled: true }],
      [musicClip({ loop: undefined, durationFlicks: 90 * F })]
    )
    const jobs = collectAudioJobs(s)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].env).toBeUndefined()
  })
})
