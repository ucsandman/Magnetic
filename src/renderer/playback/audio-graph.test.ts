import { describe, expect, it } from 'vitest'
import { flicksToSeconds } from '../../shared/timecode'
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
