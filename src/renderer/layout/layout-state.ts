/**
 * Panel layout sizes: pure load/clamp/save logic for the resizable app
 * shell. Defaults match the original fixed grid so a fresh profile renders
 * pixel-identically to pre-resize builds.
 */

export interface LayoutSizes {
  /** Browser column width, px. */
  browserW: number
  /** Inspector column width, px. */
  inspectorW: number
  /** Timeline row height, px. */
  timelineH: number
}

export const LAYOUT_DEFAULTS: LayoutSizes = { browserW: 340, inspectorW: 300, timelineH: 280 }

const LIMITS: Record<keyof LayoutSizes, { min: number; max: number }> = {
  browserW: { min: 240, max: 560 },
  inspectorW: { min: 240, max: 480 },
  timelineH: { min: 160, max: 600 }
}

const STORAGE_KEY = 'magnetic.layout.v1'

export function clampLayoutSize(key: keyof LayoutSizes, value: number): number {
  const { min, max } = LIMITS[key]
  return Math.round(Math.min(max, Math.max(min, value)))
}

export function loadLayout(storage: Pick<Storage, 'getItem'> = localStorage): LayoutSizes {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return { ...LAYOUT_DEFAULTS }
    const parsed: unknown = JSON.parse(raw)
    const sizes = { ...LAYOUT_DEFAULTS }
    if (typeof parsed === 'object' && parsed !== null) {
      for (const key of Object.keys(LIMITS) as Array<keyof LayoutSizes>) {
        const value = (parsed as Record<string, unknown>)[key]
        if (typeof value === 'number' && Number.isFinite(value)) {
          sizes[key] = clampLayoutSize(key, value)
        }
      }
    }
    return sizes
  } catch {
    return { ...LAYOUT_DEFAULTS }
  }
}

export function saveLayout(
  sizes: LayoutSizes,
  storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage
): void {
  const isDefault = (Object.keys(LIMITS) as Array<keyof LayoutSizes>).every(
    (key) => sizes[key] === LAYOUT_DEFAULTS[key]
  )
  if (isDefault) storage.removeItem(STORAGE_KEY)
  else storage.setItem(STORAGE_KEY, JSON.stringify(sizes))
}
