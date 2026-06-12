/**
 * Multi-clip review grid sizing. Capped at 9 cells (3×3) — the practical
 * multiview limit shared by Avid's Nine-Split and Resolve's Sync Bin.
 */
export const GRID_MAX_CELLS = 9

/** Column count for an n-cell grid: 1×1, 1×2, 2×2, 2×3, 3×3. */
export function gridColumns(cellCount: number): number {
  if (cellCount <= 2) return Math.max(1, cellCount)
  return cellCount <= 4 ? 2 : 3
}
