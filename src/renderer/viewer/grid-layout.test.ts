import { describe, expect, it } from 'vitest'
import { GRID_MAX_CELLS, gridColumns } from './grid-layout'

describe('gridColumns', () => {
  it('lays out 1–9 cells as 1×1, 1×2, 2×2, 2×3, 3×3', () => {
    expect(gridColumns(1)).toBe(1)
    expect(gridColumns(2)).toBe(2)
    expect(gridColumns(3)).toBe(2)
    expect(gridColumns(4)).toBe(2)
    expect(gridColumns(5)).toBe(3)
    expect(gridColumns(6)).toBe(3)
    expect(gridColumns(GRID_MAX_CELLS)).toBe(3)
  })

  it('never returns zero columns', () => {
    expect(gridColumns(0)).toBe(1)
  })
})
