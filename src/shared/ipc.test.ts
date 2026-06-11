import { describe, expect, it } from 'vitest'
import { binaryProbeResultSchema, diagBinariesResultSchema } from './ipc'

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
