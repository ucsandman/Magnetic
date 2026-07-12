import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { FLICKS_PER_SECOND } from '../../shared/timecode'
import type { Sequence, TransitionKind } from '../../shared/timeline/model'
import {
  addMarker,
  addTransition,
  blade,
  DEFAULT_FX,
  move,
  removeMarker,
  rippleDelete,
  rippleDeleteRange,
  roll,
  setClipFx,
  setClipRole,
  slip,
  trimRipple,
  type OpResult
} from '../../shared/timeline/ops'
import { clipAtTime, spineStartOf } from '../../shared/timeline/model'
import { validateSequence } from '../../shared/timeline/validate'

/**
 * The copilot's hands: every edit tool is a thin wrapper over a pure kernel
 * op executed against a SCRATCH sequence — never the store, never the undo
 * stack. The kernel's own validation plus the validateSequence gate mean a
 * tool call cannot produce an illegal sequence; a failed call returns the
 * typed OpError text so the model can correct itself. There is deliberately
 * no export tool and no way to reach one.
 */

const sec = (value: number): number => Math.round(value * FLICKS_PER_SECOND)

function fmtTime(flicks: number): string {
  const totalSec = flicks / FLICKS_PER_SECOND
  const min = Math.floor(totalSec / 60)
  const rem = totalSec - min * 60
  return `${min}:${rem.toFixed(1).padStart(4, '0')}`
}

export interface ToolOutcome {
  /** The scratch sequence after the call (unchanged on failure/no-op). */
  next: Sequence
  ok: boolean
  /** Sent back to the model as the tool_result content. */
  resultText: string
  /** Plain-English change-list entry; null for failures and no-ops. */
  summary: string | null
  /** Earliest sequence time the call referenced (agent playhead). */
  timeRefFlicks: number | null
}

const failure = (scratch: Sequence, resultText: string): ToolOutcome => ({
  next: scratch,
  ok: false,
  resultText,
  summary: null,
  timeRefFlicks: null
})

const KIND_VALUES = ['dissolve', 'wipeL', 'wipeR', 'fadeBlack'] as const
const ROLE_VALUES = ['dialogue', 'music', 'sfx'] as const
const MARKER_COLOR_VALUES = ['blue', 'green', 'orange', 'red'] as const

const SCHEMAS = {
  ripple_delete_range: z.strictObject({ from_sec: z.number().min(0), to_sec: z.number().min(0) }),
  ripple_delete_clips: z.strictObject({ clip_ids: z.array(z.string()).min(1) }),
  blade: z.strictObject({ clip_id: z.string(), at_sec: z.number().min(0) }),
  trim_clip: z.strictObject({
    clip_id: z.string(),
    edge: z.enum(['head', 'tail']),
    delta_sec: z.number()
  }),
  move_clip: z.strictObject({ clip_id: z.string(), to_index: z.number().int().min(0) }),
  roll_edit: z.strictObject({ edit_point_index: z.number().int().min(0), delta_sec: z.number() }),
  slip_clip: z.strictObject({ clip_id: z.string(), delta_sec: z.number() }),
  add_transition: z.strictObject({
    edit_point_index: z.number().int().min(0),
    duration_sec: z.number().positive(),
    kind: z.enum(KIND_VALUES)
  }),
  set_role: z.strictObject({ clip_id: z.string(), role: z.enum(ROLE_VALUES) }),
  set_volume: z.strictObject({ clip_id: z.string(), volume_db: z.number().min(-96).max(12) }),
  add_marker: z.strictObject({
    at_sec: z.number().min(0),
    text: z.string(),
    color: z.enum(MARKER_COLOR_VALUES).optional()
  }),
  remove_marker: z.strictObject({ marker_id: z.string() })
} as const

type ToolName = keyof typeof SCHEMAS

/** Anthropic tool declarations. Times are SECONDS matching the context's m:ss.s. */
export const EDIT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'ripple_delete_range',
    description:
      'Delete a sequence-time range; everything after it ripples left (the magnetic timeline never leaves a hole). The workhorse for removing dead air, fillers, and rambles.',
    input_schema: {
      type: 'object',
      properties: {
        from_sec: { type: 'number', description: 'Range start, sequence seconds' },
        to_sec: { type: 'number', description: 'Range end, sequence seconds' }
      },
      required: ['from_sec', 'to_sec']
    }
  },
  {
    name: 'ripple_delete_clips',
    description:
      'Delete whole spine clips by id (ids are listed in the timeline context); later clips ripple left.',
    input_schema: {
      type: 'object',
      properties: { clip_ids: { type: 'array', items: { type: 'string' } } },
      required: ['clip_ids']
    }
  },
  {
    name: 'blade',
    description:
      'Split a spine clip at a sequence time, producing two clips. Use before deleting or rearranging part of a clip.',
    input_schema: {
      type: 'object',
      properties: {
        clip_id: { type: 'string' },
        at_sec: { type: 'number', description: 'Cut point, sequence seconds' }
      },
      required: ['clip_id', 'at_sec']
    }
  },
  {
    name: 'trim_clip',
    description:
      'Ripple-trim one edge of a spine clip. edge=head: positive delta_sec removes from the front. edge=tail: positive delta_sec extends the end (if source media allows), negative shortens it.',
    input_schema: {
      type: 'object',
      properties: {
        clip_id: { type: 'string' },
        edge: { type: 'string', enum: ['head', 'tail'] },
        delta_sec: { type: 'number' }
      },
      required: ['clip_id', 'edge', 'delta_sec']
    }
  },
  {
    name: 'move_clip',
    description:
      'Move a spine clip to a new spine index (0-based); the timeline closes up magnetically.',
    input_schema: {
      type: 'object',
      properties: { clip_id: { type: 'string' }, to_index: { type: 'number' } },
      required: ['clip_id', 'to_index']
    }
  },
  {
    name: 'roll_edit',
    description:
      'Roll edit point N — the cut between spine items N and N+1 (0-based): one side gains what the other loses; total duration is unchanged.',
    input_schema: {
      type: 'object',
      properties: { edit_point_index: { type: 'number' }, delta_sec: { type: 'number' } },
      required: ['edit_point_index', 'delta_sec']
    }
  },
  {
    name: 'slip_clip',
    description:
      'Slip a clip: shift which part of the source media it shows without moving it or changing its duration.',
    input_schema: {
      type: 'object',
      properties: { clip_id: { type: 'string' }, delta_sec: { type: 'number' } },
      required: ['clip_id', 'delta_sec']
    }
  },
  {
    name: 'add_transition',
    description:
      'Add a transition at spine edit point N — the cut between items N and N+1 (0-based). Both sides need spare source media (handles). Kinds: dissolve, wipeL, wipeR, fadeBlack. Useful to smooth jump cuts left by deletions.',
    input_schema: {
      type: 'object',
      properties: {
        edit_point_index: { type: 'number' },
        duration_sec: { type: 'number' },
        kind: { type: 'string', enum: [...KIND_VALUES] }
      },
      required: ['edit_point_index', 'duration_sec', 'kind']
    }
  },
  {
    name: 'set_role',
    description:
      'Tag a clip (spine or connected, by id) with an audio role: dialogue, music, or sfx. Roles drive the mixer mute/solo buttons and auto-ducking targets. Looped beds already default to music.',
    input_schema: {
      type: 'object',
      properties: {
        clip_id: { type: 'string' },
        role: { type: 'string', enum: ['dialogue', 'music', 'sfx'] }
      },
      required: ['clip_id', 'role']
    }
  },
  {
    name: 'add_marker',
    description:
      'Drop a marker at a sequence time on the clip playing there — use to flag review notes, sync points, or spots the human should look at. Colors: blue (default), green, orange, red. Markers ride the media through later edits.',
    input_schema: {
      type: 'object',
      properties: {
        at_sec: { type: 'number', description: 'Sequence time in seconds' },
        text: { type: 'string', description: 'The note shown to the human' },
        color: { type: 'string', enum: ['blue', 'green', 'orange', 'red'] }
      },
      required: ['at_sec', 'text']
    }
  },
  {
    name: 'remove_marker',
    description:
      'Remove a marker by id (marker ids are listed in the timeline context under Markers).',
    input_schema: {
      type: 'object',
      properties: { marker_id: { type: 'string' } },
      required: ['marker_id']
    }
  },
  {
    name: 'set_volume',
    description:
      'Set a clip’s volume in dB (−96 to +12, 0 = unity). Applies to spine or connected clips by id. Use to balance levels or pull a bed down manually.',
    input_schema: {
      type: 'object',
      properties: {
        clip_id: { type: 'string' },
        volume_db: { type: 'number', description: 'Absolute volume in dB, 0 = unchanged gain' }
      },
      required: ['clip_id', 'volume_db']
    }
  }
]

export function executeEditTool(scratch: Sequence, name: string, input: unknown): ToolOutcome {
  if (!(name in SCHEMAS)) {
    return failure(scratch, `unknown tool "${name}" — only the declared edit tools exist`)
  }
  const parsed = SCHEMAS[name as ToolName].safeParse(input)
  if (!parsed.success) {
    return failure(
      scratch,
      `invalid input for ${name}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
    )
  }

  let result: OpResult
  let summary: string
  let timeRefFlicks: number | null
  const args = parsed.data
  switch (name as ToolName) {
    case 'ripple_delete_range': {
      const a = args as z.infer<(typeof SCHEMAS)['ripple_delete_range']>
      result = rippleDeleteRange(scratch, { fromFlicks: sec(a.from_sec), toFlicks: sec(a.to_sec) })
      summary = `Removed ${fmtTime(sec(a.from_sec))}–${fmtTime(sec(a.to_sec))} (${(a.to_sec - a.from_sec).toFixed(1)}s), ripple`
      timeRefFlicks = sec(a.from_sec)
      break
    }
    case 'ripple_delete_clips': {
      const a = args as z.infer<(typeof SCHEMAS)['ripple_delete_clips']>
      result = rippleDelete(scratch, { ids: a.clip_ids })
      summary = `Deleted clip(s) ${a.clip_ids.join(', ')}, ripple`
      timeRefFlicks = null
      break
    }
    case 'blade': {
      const a = args as z.infer<(typeof SCHEMAS)['blade']>
      result = blade(scratch, { clipId: a.clip_id, timeFlicks: sec(a.at_sec) })
      summary = `Bladed ${a.clip_id} at ${fmtTime(sec(a.at_sec))}`
      timeRefFlicks = sec(a.at_sec)
      break
    }
    case 'trim_clip': {
      const a = args as z.infer<(typeof SCHEMAS)['trim_clip']>
      result = trimRipple(scratch, {
        clipId: a.clip_id,
        edge: a.edge,
        deltaFlicks: sec(a.delta_sec)
      })
      summary = `Trimmed ${a.edge} of ${a.clip_id} by ${a.delta_sec.toFixed(1)}s`
      timeRefFlicks = null
      break
    }
    case 'move_clip': {
      const a = args as z.infer<(typeof SCHEMAS)['move_clip']>
      result = move(scratch, { clipId: a.clip_id, toIndex: a.to_index })
      summary = `Moved ${a.clip_id} to position ${a.to_index + 1}`
      timeRefFlicks = null
      break
    }
    case 'roll_edit': {
      const a = args as z.infer<(typeof SCHEMAS)['roll_edit']>
      result = roll(scratch, { editPointIndex: a.edit_point_index, deltaFlicks: sec(a.delta_sec) })
      summary = `Rolled edit point ${a.edit_point_index} by ${a.delta_sec.toFixed(1)}s`
      timeRefFlicks = null
      break
    }
    case 'slip_clip': {
      const a = args as z.infer<(typeof SCHEMAS)['slip_clip']>
      result = slip(scratch, { clipId: a.clip_id, deltaFlicks: sec(a.delta_sec) })
      summary = `Slipped ${a.clip_id} by ${a.delta_sec.toFixed(1)}s`
      timeRefFlicks = null
      break
    }
    case 'add_transition': {
      const a = args as z.infer<(typeof SCHEMAS)['add_transition']>
      result = addTransition(scratch, {
        editPointIndex: a.edit_point_index,
        durationFlicks: sec(a.duration_sec),
        kind: a.kind as TransitionKind
      })
      summary = `Added ${a.duration_sec.toFixed(1)}s ${a.kind} at edit point ${a.edit_point_index}`
      timeRefFlicks = null
      break
    }
    case 'set_role': {
      const a = args as z.infer<(typeof SCHEMAS)['set_role']>
      result = setClipRole(scratch, { clipId: a.clip_id, role: a.role })
      summary = `Tagged ${a.clip_id} as ${a.role}`
      timeRefFlicks = null
      break
    }
    case 'add_marker': {
      const a = args as z.infer<(typeof SCHEMAS)['add_marker']>
      const at = sec(a.at_sec)
      const item = clipAtTime(scratch, at)
      if (item === null || item.kind !== 'clip') {
        return failure(scratch, `invalid-target: no spine clip at ${fmtTime(at)}`)
      }
      const start = spineStartOf(scratch, item.id) ?? 0
      result = addMarker(scratch, {
        assetId: item.assetId,
        atMediaFlicks: item.mediaInFlicks + (at - start),
        text: a.text,
        color: a.color ?? 'blue'
      })
      summary = `Added a ${a.color ?? 'blue'} marker at ${fmtTime(at)}: "${a.text}"`
      timeRefFlicks = at
      break
    }
    case 'remove_marker': {
      const a = args as z.infer<(typeof SCHEMAS)['remove_marker']>
      result = removeMarker(scratch, { markerId: a.marker_id })
      summary = `Removed marker ${a.marker_id}`
      timeRefFlicks = null
      break
    }
    case 'set_volume': {
      const a = args as z.infer<(typeof SCHEMAS)['set_volume']>
      const target =
        scratch.spine.find((item) => item.id === a.clip_id && item.kind === 'clip') ??
        scratch.connected.find((cc) => cc.id === a.clip_id)
      if (target === undefined || !('fx' in target || 'assetId' in target)) {
        return failure(scratch, `unknown-id: no clip "${a.clip_id}"`)
      }
      const fx = { ...DEFAULT_FX, ...(target.fx ?? {}) }
      result = setClipFx(scratch, { clipId: a.clip_id, fx: { ...fx, volumeDb: a.volume_db } })
      summary = `Set ${a.clip_id} volume to ${a.volume_db.toFixed(1)} dB`
      timeRefFlicks = null
      break
    }
  }

  if (result.error !== undefined) {
    return failure(scratch, `${result.error.code}: ${result.error.message}`)
  }
  if (result.next === scratch) {
    return {
      next: scratch,
      ok: true,
      resultText: 'no-op: the call changed nothing (already at a boundary or clamped away)',
      summary: null,
      timeRefFlicks
    }
  }
  const violations = validateSequence(result.next)
  if (violations.length > 0) {
    return failure(
      scratch,
      `rejected: the result would break timeline invariants — ${violations.map((v) => v.message).join('; ')}`
    )
  }
  return { next: result.next, ok: true, resultText: `ok — ${summary}`, summary, timeRefFlicks }
}
