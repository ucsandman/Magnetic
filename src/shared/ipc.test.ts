import { describe, expect, it } from 'vitest'
import {
  binaryProbeResultSchema,
  diagBinariesResultSchema,
  saveSequencePayloadSchema,
  sequenceSchema
} from './ipc'
import type { Sequence } from './timeline/model'

describe('IPC schemas', () => {
  it('accepts a valid probe result', () => {
    const valid = { ok: true, exitCode: 0, firstLine: 'ffprobe version 8.1.1' }
    expect(binaryProbeResultSchema.parse(valid)).toEqual(valid)
  })

  it('rejects malformed probe results', () => {
    expect(binaryProbeResultSchema.safeParse({ ok: 'yes', exitCode: 0 }).success).toBe(false)
    expect(binaryProbeResultSchema.safeParse(null).success).toBe(false)
  })

  it('rejects a diag result with a missing binary entry', () => {
    const result = diagBinariesResultSchema.safeParse({
      ffprobe: { ok: true, exitCode: 0, firstLine: '' }
    })
    expect(result.success).toBe(false)
  })
})

/**
 * z.object STRIPS unknown keys, so any sequence-level field missing from
 * sequenceSchema is silently lost on the saveSequence round-trip. These tests
 * pin that `captions` survives schema validation verbatim.
 */
describe('sequenceSchema captions round-trip', () => {
  const base: Sequence = {
    id: 's1',
    fps: { num: 30, den: 1 },
    spine: [
      {
        kind: 'clip',
        id: 'a',
        assetId: 'asset-a',
        mediaInFlicks: 0,
        durationFlicks: 23_520_000,
        sourceDurationFlicks: 235_200_000
      }
    ],
    connected: []
  }

  it('preserves caption settings through parse (saveSequence path)', () => {
    const sequence: Sequence = {
      ...base,
      captions: {
        enabled: true,
        preset: 'karaoke',
        font: 'system-ui, sans-serif',
        sizePx: 56,
        color: '#ffffff',
        highlightColor: '#ffd60a',
        position: 'bottom'
      }
    }
    const parsed = saveSequencePayloadSchema.parse({ projectId: 'p1', sequence })
    expect(parsed.sequence).toEqual(sequence)
  })

  it('keeps captions optional: older sequences without the field still parse', () => {
    const parsed = sequenceSchema.parse(base)
    expect(parsed.captions).toBeUndefined()
    expect(parsed).toEqual(base)
  })

  it('rejects malformed caption settings instead of corrupting the project', () => {
    const result = sequenceSchema.safeParse({
      ...base,
      captions: { enabled: true, preset: 'bouncy' }
    })
    expect(result.success).toBe(false)
  })
})
