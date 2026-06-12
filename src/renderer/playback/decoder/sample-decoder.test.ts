import { describe, expect, it } from 'vitest'
import { planBatch } from './sample-decoder'

function table(entries: [offset: number, size: number][]): { offset: number; size: number }[] {
  return entries.map(([offset, size]) => ({ offset, size }))
}

describe('planBatch', () => {
  it('coalesces consecutive samples into one span', () => {
    const t = table([
      [100, 50],
      [150, 50],
      [300, 100] // gap (interleaved audio) still covered by the span
    ])
    expect(planBatch(t, 0)).toEqual({ endIndex: 3, spanStart: 100, spanEnd: 399 })
  })

  it('caps by sample count', () => {
    const t = table(Array.from({ length: 10 }, (_, i) => [i * 10, 10] as [number, number]))
    expect(planBatch(t, 0, 4, Infinity)).toEqual({ endIndex: 4, spanStart: 0, spanEnd: 39 })
  })

  it('caps by span bytes', () => {
    const t = table([
      [0, 10],
      [10, 10],
      [1000, 10] // would blow the byte budget
    ])
    expect(planBatch(t, 0, 96, 100)).toEqual({ endIndex: 2, spanStart: 0, spanEnd: 19 })
  })

  it('always includes the requested sample even when oversized', () => {
    const t = table([[0, 5000]])
    expect(planBatch(t, 0, 96, 100)).toEqual({ endIndex: 1, spanStart: 0, spanEnd: 4999 })
  })

  it('stops at backwards offsets (non-monotonic mdat layout)', () => {
    const t = table([
      [1000, 10],
      [500, 10]
    ])
    expect(planBatch(t, 0)).toEqual({ endIndex: 1, spanStart: 1000, spanEnd: 1009 })
    // and the backwards sample still gets its own batch
    expect(planBatch(t, 1)).toEqual({ endIndex: 2, spanStart: 500, spanEnd: 509 })
  })

  it('starts mid-table', () => {
    const t = table([
      [0, 10],
      [10, 10],
      [20, 10]
    ])
    expect(planBatch(t, 1, 1, Infinity)).toEqual({ endIndex: 2, spanStart: 10, spanEnd: 19 })
  })
})

import { startIndexFor } from './sample-decoder'

describe('startIndexFor', () => {
  const timescale = 30
  const micros = (frames: number): number => (frames / timescale) * 1_000_000
  const ts = (s: { cts: number }): number => Math.round((s.cts / timescale) * 1_000_000)

  function oracle(samples: { cts: number }[], fromMicros: number): number {
    const found = samples.findIndex((s) => ts(s) >= fromMicros)
    return found === -1 ? samples.length - 1 : found
  }
  function reorder(samples: { cts: number; dts: number }[]): number {
    return Math.max(...samples.map((s) => s.cts - s.dts), 0)
  }

  it('matches the linear scan exactly on monotonic tables', () => {
    const samples = Array.from({ length: 120 }, (_, i) => ({ dts: i, cts: i }))
    for (const frame of [0, 1, 17, 118, 119]) {
      for (const target of [micros(frame) - 1, micros(frame), micros(frame) + 1]) {
        const clamped = Math.max(0, target)
        expect(startIndexFor(samples, timescale, clamped, reorder(samples))).toBe(
          oracle(samples, clamped)
        )
      }
    }
  })

  it('matches the linear scan on B-frame reordered tables', () => {
    // decode order with cts reordering: I P B B | I P B B
    const samples = [
      { dts: 0, cts: 0 },
      { dts: 1, cts: 3 },
      { dts: 2, cts: 1 },
      { dts: 3, cts: 2 },
      { dts: 4, cts: 4 },
      { dts: 5, cts: 7 },
      { dts: 6, cts: 5 },
      { dts: 7, cts: 6 }
    ]
    for (let frame = 0; frame <= 8; frame += 1) {
      for (const target of [Math.max(0, micros(frame) - 1), micros(frame)]) {
        expect(startIndexFor(samples, timescale, target, reorder(samples))).toBe(
          oracle(samples, target)
        )
      }
    }
  })

  it('clamps past-the-end targets to the last sample', () => {
    const samples = [
      { dts: 0, cts: 0 },
      { dts: 1, cts: 1 }
    ]
    expect(startIndexFor(samples, timescale, micros(100), 0)).toBe(1)
  })
})
