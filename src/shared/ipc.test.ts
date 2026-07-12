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

/** Same strips-keys trap: pin clip `role` tags and sequence `mutedRoles`. */
describe('sequenceSchema role round-trip', () => {
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
        sourceDurationFlicks: 235_200_000,
        role: 'music'
      }
    ],
    connected: [
      {
        id: 'c',
        assetId: 'asset-c',
        parentClipId: 'a',
        offsetFlicks: 0,
        lane: -1,
        mediaInFlicks: 0,
        durationFlicks: 23_520_000,
        sourceDurationFlicks: 235_200_000,
        role: 'sfx'
      }
    ],
    mutedRoles: ['music']
  }

  it('preserves role tags and mutedRoles through parse', () => {
    const parsed = sequenceSchema.parse(base)
    expect(parsed).toEqual(base)
  })

  it('rejects unknown role names', () => {
    const result = sequenceSchema.safeParse({ ...base, mutedRoles: ['narration'] })
    expect(result.success).toBe(false)
  })
})

/** Same z.object-strips-keys trap for connected-clip fields: pin `loop`. */
describe('sequenceSchema connected-clip loop round-trip', () => {
  const base: Sequence = {
    id: 's1',
    fps: { num: 30, den: 1 },
    spine: [
      {
        kind: 'clip',
        id: 'a',
        assetId: 'asset-a',
        mediaInFlicks: 0,
        durationFlicks: 235_200_000,
        sourceDurationFlicks: 235_200_000
      }
    ],
    connected: []
  }
  const connected = {
    id: 'cc',
    assetId: 'asset-cc',
    parentClipId: 'a',
    offsetFlicks: 0,
    lane: -1,
    mediaInFlicks: 0,
    durationFlicks: 235_200_000,
    sourceDurationFlicks: 23_520_000
  }

  it('preserves loop: true through parse (saveSequence path)', () => {
    const sequence: Sequence = { ...base, connected: [{ ...connected, loop: true }] }
    const parsed = saveSequencePayloadSchema.parse({ projectId: 'p1', sequence })
    expect(parsed.sequence).toEqual(sequence)
    expect(parsed.sequence.connected[0].loop).toBe(true)
  })

  it('keeps loop optional: clips without the flag still parse unchanged', () => {
    const sequence: Sequence = {
      ...base,
      connected: [{ ...connected, durationFlicks: 23_520_000 }]
    }
    const parsed = sequenceSchema.parse(sequence)
    expect(parsed.connected[0].loop).toBeUndefined()
    expect(parsed).toEqual(sequence)
  })

  it('rejects a non-boolean loop instead of corrupting the project', () => {
    const result = sequenceSchema.safeParse({
      ...base,
      connected: [{ ...connected, loop: 'yes' }]
    })
    expect(result.success).toBe(false)
  })
})
