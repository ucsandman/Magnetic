/**
 * Draw-performance harness for the timeline canvas. The canvas registers a
 * driver that performs measured synchronous draws; the MAGNETIC_TEST hook
 * calls measureDraws to pull median frame times into E2E assertions.
 */

export interface DrawStats {
  count: number
  medianMs: number
  maxMs: number
  times: number[]
}

type DrawDriver = (n: number) => Promise<number[]>

let driver: DrawDriver | null = null

export function registerDrawDriver(fn: DrawDriver | null): void {
  driver = fn
}

export async function measureDraws(n: number): Promise<DrawStats> {
  if (driver === null) throw new Error('timeline canvas is not mounted')
  const times = await driver(n)
  const sorted = [...times].sort((a, b) => a - b)
  return {
    count: times.length,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    times
  }
}
