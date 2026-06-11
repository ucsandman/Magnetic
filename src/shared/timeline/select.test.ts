import { describe, expect, it } from 'vitest'
import {
  addToSelection,
  clearRange,
  emptySelection,
  isSelected,
  pruneSelection,
  removeFromSelection,
  selectOnly,
  setRange,
  toggleInSelection
} from './select'
import { F, clip, connected, seq } from './testing'

describe('selection model', () => {
  it('starts empty', () => {
    const sel = emptySelection()
    expect(sel.clipIds).toEqual([])
    expect(sel.range).toBeNull()
  })

  it('selectOnly replaces the whole selection', () => {
    const sel = selectOnly(addToSelection(emptySelection(), 'a'), 'b')
    expect(sel.clipIds).toEqual(['b'])
  })

  it('addToSelection appends without duplicating', () => {
    let sel = addToSelection(emptySelection(), 'a')
    sel = addToSelection(sel, 'b')
    sel = addToSelection(sel, 'a')
    expect(sel.clipIds).toEqual(['a', 'b'])
  })

  it('toggleInSelection adds when absent and removes when present', () => {
    const added = toggleInSelection(emptySelection(), 'a')
    expect(isSelected(added, 'a')).toBe(true)
    const removed = toggleInSelection(added, 'a')
    expect(isSelected(removed, 'a')).toBe(false)
  })

  it('removeFromSelection drops only the given id', () => {
    const sel = addToSelection(addToSelection(emptySelection(), 'a'), 'b')
    expect(removeFromSelection(sel, 'a').clipIds).toEqual(['b'])
  })

  it('setRange normalizes reversed bounds', () => {
    const sel = setRange(emptySelection(), 10 * F, 2 * F)
    expect(sel.range).toEqual({ startFlicks: 2 * F, endFlicks: 10 * F })
  })

  it('clearRange drops the range but keeps clip selection', () => {
    const sel = clearRange(setRange(addToSelection(emptySelection(), 'a'), 0, 5 * F))
    expect(sel.range).toBeNull()
    expect(sel.clipIds).toEqual(['a'])
  })

  it('removing an id that is not selected returns the same reference', () => {
    const sel = addToSelection(emptySelection(), 'a')
    expect(removeFromSelection(sel, 'zzz')).toBe(sel)
  })

  it('clearing an absent range returns the same reference', () => {
    const sel = emptySelection()
    expect(clearRange(sel)).toBe(sel)
  })

  it('pruneSelection keeps only ids that still exist in the sequence', () => {
    const s = seq([clip('a', 10)], [connected('cc', 'a', 2, 3)])
    let sel = addToSelection(emptySelection(), 'a')
    sel = addToSelection(sel, 'cc')
    sel = addToSelection(sel, 'deleted-clip')
    expect(pruneSelection(sel, s).clipIds).toEqual(['a', 'cc'])
  })

  it('pruneSelection returns the same reference when nothing changed', () => {
    const s = seq([clip('a', 10)])
    const sel = addToSelection(emptySelection(), 'a')
    expect(pruneSelection(sel, s)).toBe(sel)
  })
})
