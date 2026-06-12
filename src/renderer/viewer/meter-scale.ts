/**
 * Audio meter scale: RMS power (0..1 from the engine's AnalyserNode) to a
 * dBFS bar. Pure math so the zones and floor are unit-testable.
 */

export const METER_FLOOR_DB = -60

export interface MeterReading {
  /** Bar length, 0 (floor) .. 1 (0 dBFS). */
  fraction: number
  zone: 'green' | 'yellow' | 'red'
  /** Clamped dBFS, METER_FLOOR_DB .. 0. */
  db: number
}

export function rmsToMeter(rms: number): MeterReading {
  const rawDb = rms <= 0 ? METER_FLOOR_DB : 20 * Math.log10(rms)
  const db = Math.min(0, Math.max(METER_FLOOR_DB, rawDb))
  const fraction = (db - METER_FLOOR_DB) / -METER_FLOOR_DB
  const zone = db >= -6 ? 'red' : db >= -12 ? 'yellow' : 'green'
  return { fraction, zone, db }
}
