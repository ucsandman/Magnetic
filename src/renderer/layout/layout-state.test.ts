import { describe, expect, it } from 'vitest'
import { clampLayoutSize, LAYOUT_DEFAULTS, loadLayout, saveLayout } from './layout-state'

function memoryStorage(initial: Record<string, string> = {}): {
  data: Record<string, string>
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
} {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    },
    removeItem: (key) => {
      delete data[key]
    }
  }
}

describe('layout sizes', () => {
  it('clamps each dimension to its limits', () => {
    expect(clampLayoutSize('browserW', 10)).toBe(240)
    expect(clampLayoutSize('browserW', 9999)).toBe(560)
    expect(clampLayoutSize('inspectorW', 300)).toBe(300)
    expect(clampLayoutSize('timelineH', 100)).toBe(160)
  })

  it('loads defaults when storage is empty or corrupt', () => {
    expect(loadLayout(memoryStorage())).toEqual(LAYOUT_DEFAULTS)
    expect(loadLayout(memoryStorage({ 'magnetic.layout.v1': 'not json' }))).toEqual(LAYOUT_DEFAULTS)
    expect(loadLayout(memoryStorage({ 'magnetic.layout.v1': '{"browserW":"wide"}' }))).toEqual(
      LAYOUT_DEFAULTS
    )
  })

  it('round-trips saved sizes, clamping on load', () => {
    const storage = memoryStorage()
    saveLayout({ browserW: 400, inspectorW: 320, timelineH: 9999 }, storage)
    expect(loadLayout(storage)).toEqual({ browserW: 400, inspectorW: 320, timelineH: 600 })
  })

  it('saving the defaults clears the stored override', () => {
    const storage = memoryStorage()
    saveLayout({ browserW: 400, inspectorW: 320, timelineH: 300 }, storage)
    saveLayout({ ...LAYOUT_DEFAULTS }, storage)
    expect(storage.data['magnetic.layout.v1']).toBeUndefined()
  })
})
