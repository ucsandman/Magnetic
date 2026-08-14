import { describe, expect, it } from 'vitest'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import { clip, F, seq } from '../../shared/timeline/testing'
import { EDIT_TOOLS, executeEditBatch, executeEditTool } from './tools'

// 10 s + 5 s clips @30fps; b starts 1 s into its source so the edit point
// between them has media handles on both sides (transitions need them)
const base = seq([clip('a', 300), clip('b', 150, 30)])

// 5 s of importable source media for the assemble ops (append/insert/connect).
const assets = { 'asset-x': { durationFlicks: 5 * FLICKS_PER_SECOND } }

describe('executeEditTool', () => {
  it('ripple_delete_range removes the range and reports a summary', () => {
    const outcome = executeEditTool(base, 'ripple_delete_range', { from_sec: 2, to_sec: 3.5 })
    expect(outcome.ok).toBe(true)
    const total = outcome.next.spine.reduce((sum, item) => sum + item.durationFlicks, 0)
    expect(total).toBe(450 * F - 1.5 * FLICKS_PER_SECOND)
    expect(outcome.summary).toContain('0:02.0')
    expect(outcome.summary).toContain('0:03.5')
    expect(outcome.timeRefFlicks).toBe(2 * FLICKS_PER_SECOND)
    // the frozen base is untouched (deepFreeze would have thrown otherwise)
    expect(base.spine).toHaveLength(2)
  })

  it('returns the typed op error and an unchanged sequence for an unknown clip', () => {
    const outcome = executeEditTool(base, 'blade', { clip_id: 'ghost', at_sec: 1 })
    expect(outcome.ok).toBe(false)
    expect(outcome.resultText).toContain('unknown-id')
    expect(outcome.next).toBe(base)
    expect(outcome.summary).toBeNull()
  })

  it('treats a boundary blade as an explicit no-op, not a change', () => {
    const outcome = executeEditTool(base, 'blade', { clip_id: 'a', at_sec: 0 })
    expect(outcome.ok).toBe(true)
    expect(outcome.next).toBe(base)
    expect(outcome.summary).toBeNull()
    expect(outcome.resultText).toContain('no-op')
  })

  it('trim_clip head shrinks the front of the clip', () => {
    const outcome = executeEditTool(base, 'trim_clip', {
      clip_id: 'b',
      edge: 'head',
      delta_sec: 1
    })
    expect(outcome.ok).toBe(true)
    const b = outcome.next.spine.find((item) => item.id === 'b')!
    expect(b.durationFlicks).toBe(150 * F - FLICKS_PER_SECOND)
  })

  it('add_transition attaches at an edit point', () => {
    const outcome = executeEditTool(base, 'add_transition', {
      edit_point_index: 0, // the cut between a and b
      duration_sec: 1,
      kind: 'dissolve'
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.next.transitions?.length ?? 0).toBe(1)
    expect(outcome.summary).toContain('dissolve')
  })

  it('rejects malformed input with a readable error instead of throwing', () => {
    const outcome = executeEditTool(base, 'ripple_delete_range', { from_sec: 'two' })
    expect(outcome.ok).toBe(false)
    expect(outcome.next).toBe(base)
    expect(outcome.resultText.toLowerCase()).toContain('invalid')
  })

  it('rejects an unknown tool name', () => {
    const outcome = executeEditTool(base, 'export_video', {})
    expect(outcome.ok).toBe(false)
    expect(outcome.resultText).toContain('unknown tool')
  })

  it('set_role tags a clip with an audio role', () => {
    const outcome = executeEditTool(base, 'set_role', { clip_id: 'a', role: 'music' })
    expect(outcome.ok).toBe(true)
    const item = outcome.next.spine[0]
    expect(item.kind === 'clip' && item.role).toBe('music')
    expect(outcome.summary).toContain('music')
  })

  it('set_role rejects an unknown clip and an invalid role', () => {
    expect(executeEditTool(base, 'set_role', { clip_id: 'zzz', role: 'music' }).ok).toBe(false)
    expect(executeEditTool(base, 'set_role', { clip_id: 'a', role: 'narration' }).ok).toBe(false)
  })

  it('set_volume writes volumeDb while preserving the rest of the fx', () => {
    const withFade = executeEditTool(base, 'set_volume', { clip_id: 'b', volume_db: -6 })
    expect(withFade.ok).toBe(true)
    const item = withFade.next.spine[1]
    expect(item.kind === 'clip' && item.fx?.volumeDb).toBe(-6)
    expect(withFade.summary).toContain('-6.0 dB')
  })

  it('set_volume rejects out-of-range values and unknown clips', () => {
    expect(executeEditTool(base, 'set_volume', { clip_id: 'a', volume_db: 40 }).ok).toBe(false)
    expect(executeEditTool(base, 'set_volume', { clip_id: 'zzz', volume_db: 0 }).ok).toBe(false)
  })

  it('add_marker anchors a note to the clip playing at the given time', () => {
    const outcome = executeEditTool(base, 'add_marker', {
      at_sec: 2,
      text: 'check this cut',
      color: 'red'
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.next.markers).toHaveLength(1)
    expect(outcome.next.markers?.[0].color).toBe('red')
    expect(outcome.timeRefFlicks).toBe(2 * 705_600_000)
  })

  it('remove_marker deletes by id and fails on unknown ids', () => {
    const withMarker = executeEditTool(base, 'add_marker', { at_sec: 2, text: 'x' }).next
    const markerId = withMarker.markers![0].id
    const removed = executeEditTool(withMarker, 'remove_marker', { marker_id: markerId })
    expect(removed.ok).toBe(true)
    expect(removed.next.markers).toHaveLength(0)
    expect(executeEditTool(base, 'remove_marker', { marker_id: 'zzz' }).ok).toBe(false)
  })

  it('append_clip lands a new clip at the spine end', () => {
    const outcome = executeEditTool(base, 'append_clip', { asset_id: 'asset-x' }, assets)
    expect(outcome.ok).toBe(true)
    expect(outcome.next.spine).toHaveLength(3)
    const appended = outcome.next.spine[2]
    expect(appended.kind).toBe('clip')
    expect(appended.kind === 'clip' && appended.assetId).toBe('asset-x')
    expect(appended.durationFlicks).toBe(5 * FLICKS_PER_SECOND)
    expect(outcome.summary).toContain('asset-x')
  })

  it('insert_clip at an index ripples the rest of the spine later', () => {
    const outcome = executeEditTool(
      base,
      'insert_clip',
      { asset_id: 'asset-x', at_index: 1 },
      assets
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.next.spine).toHaveLength(3)
    expect(outcome.next.spine[0].id).toBe('a')
    const inserted = outcome.next.spine[1]
    expect(inserted.kind === 'clip' && inserted.assetId).toBe('asset-x')
    expect(outcome.next.spine[2].id).toBe('b')
    // b now starts after a's 10s plus the inserted clip's 5s
    const bStart = outcome.next.spine
      .slice(0, 2)
      .reduce((sum, item) => sum + item.durationFlicks, 0)
    expect(bStart).toBe(300 * F + 5 * FLICKS_PER_SECOND)
  })

  it('connect_clip attaches a connected clip at the requested time, lane 1 by default', () => {
    const outcome = executeEditTool(
      base,
      'connect_clip',
      { asset_id: 'asset-x', at_sec: 2 },
      assets
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.next.connected).toHaveLength(1)
    const cc = outcome.next.connected[0]
    expect(cc.assetId).toBe('asset-x')
    expect(cc.lane).toBe(1)
    expect(cc.parentClipId).toBe('a')
    expect(outcome.timeRefFlicks).toBe(2 * FLICKS_PER_SECOND)
  })

  it('the assemble ops reject an unknown asset_id, naming it', () => {
    const outcome = executeEditTool(base, 'append_clip', { asset_id: 'ghost-asset' }, assets)
    expect(outcome.ok).toBe(false)
    expect(outcome.resultText).toContain('ghost-asset')
    expect(outcome.next).toBe(base)
  })

  it('kernel clip validation still applies: a sub-frame asset is rejected', () => {
    const tinyAssets = { 'asset-tiny': { durationFlicks: 1 } }
    const outcome = executeEditTool(base, 'append_clip', { asset_id: 'asset-tiny' }, tinyAssets)
    expect(outcome.ok).toBe(false)
    expect(outcome.resultText).toContain('invalid-clip')
  })
})

describe('executeEditBatch', () => {
  it('rejects the WHOLE batch when any op references an unknown asset_id, naming it', () => {
    const batch = executeEditBatch(
      base,
      [
        { name: 'append_clip', input: { asset_id: 'asset-x' } },
        { name: 'append_clip', input: { asset_id: 'ghost-asset' } }
      ],
      assets
    )
    expect(batch.ok).toBe(false)
    expect(batch.error).toContain('ghost-asset')
    expect(batch.next).toBe(base)
    expect(batch.executed).toHaveLength(0)
  })

  it('runs every op in order once every asset_id resolves', () => {
    const batch = executeEditBatch(
      base,
      [
        { name: 'append_clip', input: { asset_id: 'asset-x' } },
        { name: 'connect_clip', input: { asset_id: 'asset-x', at_sec: 1 } }
      ],
      assets
    )
    expect(batch.ok).toBe(true)
    expect(batch.executed).toHaveLength(2)
    expect(batch.next.spine).toHaveLength(3)
    expect(batch.next.connected).toHaveLength(1)
  })

  it('still runs the batch (unaffected) when a non-asset op fails — same skip-and-continue as before', () => {
    const batch = executeEditBatch(
      base,
      [
        { name: 'append_clip', input: { asset_id: 'asset-x' } },
        { name: 'blade', input: { clip_id: 'ghost', at_sec: 1 } }
      ],
      assets
    )
    expect(batch.ok).toBe(true)
    expect(batch.executed).toHaveLength(1)
    expect(batch.results.some((r) => r.includes('unknown-id'))).toBe(true)
  })
})

describe('EDIT_TOOLS', () => {
  it('declares every executor tool with an input schema, and no export tool', () => {
    const names = EDIT_TOOLS.map((tool) => tool.name)
    expect(names).toContain('ripple_delete_range')
    expect(names).toContain('blade')
    expect(names).toContain('trim_clip')
    expect(names).toContain('move_clip')
    expect(names).toContain('add_transition')
    expect(names.some((name) => name.includes('export'))).toBe(false)
    for (const tool of EDIT_TOOLS) {
      expect(tool.input_schema).toBeDefined()
      expect(tool.description!.length).toBeGreaterThan(20)
    }
  })
})
