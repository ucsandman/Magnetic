import { describe, expect, it } from 'vitest'
import { clip, connected, seq } from '../../shared/timeline/testing'
import { collectAudioJobs } from './audio-graph'

describe('collectAudioJobs role muting', () => {
  const music = { ...connected('m', 'a', 0, 100, -2), loop: true }

  it('includes every audible clip when nothing is muted', () => {
    const sequence = seq([clip('a', 100)], [music])
    expect(
      collectAudioJobs(sequence)
        .map((job) => job.assetId)
        .sort()
    ).toEqual(['asset-a', 'asset-m'])
  })

  it('drops music-role clips when music is muted', () => {
    const sequence = { ...seq([clip('a', 100)], [music]), mutedRoles: ['music' as const] }
    expect(collectAudioJobs(sequence).map((job) => job.assetId)).toEqual(['asset-a'])
  })

  it('drops dialogue-role spine clips when dialogue is muted', () => {
    const sequence = { ...seq([clip('a', 100)], [music]), mutedRoles: ['dialogue' as const] }
    expect(collectAudioJobs(sequence).map((job) => job.assetId)).toEqual(['asset-m'])
  })

  it('respects an explicit role over the loop heuristic', () => {
    const tagged = { ...music, role: 'sfx' as const }
    const sequence = { ...seq([clip('a', 100)], [tagged]), mutedRoles: ['music' as const] }
    expect(
      collectAudioJobs(sequence)
        .map((job) => job.assetId)
        .sort()
    ).toEqual(['asset-a', 'asset-m'])
  })
})
