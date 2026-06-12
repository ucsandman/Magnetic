import { describe, expect, it } from 'vitest'
import { METER_FLOOR_DB, rmsToMeter } from './meter-scale'

describe('rmsToMeter', () => {
  it('floors at -60 dB for zero, negative, and tiny rms', () => {
    for (const rms of [0, -1, 1e-9]) {
      const reading = rmsToMeter(rms)
      expect(reading.db).toBe(METER_FLOOR_DB)
      expect(reading.fraction).toBe(0)
      expect(reading.zone).toBe('green')
    }
  })

  it('maps full scale to fraction 1 and clamps above 0 dBFS', () => {
    expect(rmsToMeter(1)).toEqual({ fraction: 1, zone: 'red', db: 0 })
    expect(rmsToMeter(2).db).toBe(0)
    expect(rmsToMeter(2).fraction).toBe(1)
  })

  it('breaks zones at -12 dB (yellow) and -6 dB (red)', () => {
    // probe just inside each zone — exact boundaries are FP-noisy
    expect(rmsToMeter(Math.pow(10, -12.1 / 20)).zone).toBe('green')
    expect(rmsToMeter(Math.pow(10, -11.9 / 20)).zone).toBe('yellow')
    expect(rmsToMeter(Math.pow(10, -6.1 / 20)).zone).toBe('yellow')
    expect(rmsToMeter(Math.pow(10, -5.9 / 20)).zone).toBe('red')
  })

  it('is monotonic in rms', () => {
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const { fraction } = rmsToMeter(i / 100)
      expect(fraction).toBeGreaterThanOrEqual(prev)
      prev = fraction
    }
  })
})
