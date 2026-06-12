/**
 * Loop-playback view setting: pure end-of-sequence decision plus
 * load/save persistence, mirroring the layout-state pattern.
 */

export type SequenceEndAction = 'wrap' | 'stop'

/** What sequence playback does when the clock reaches the sequence end. */
export function sequenceEndAction(loop: boolean): SequenceEndAction {
  return loop ? 'wrap' : 'stop'
}

const STORAGE_KEY = 'magnetic.playback.v1'

export function loadLoopPref(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return false
    const parsed: unknown = JSON.parse(raw)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as Record<string, unknown>).loop === true
    )
  } catch {
    return false
  }
}

export function saveLoopPref(
  loop: boolean,
  storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage
): void {
  if (loop) storage.setItem(STORAGE_KEY, JSON.stringify({ loop }))
  else storage.removeItem(STORAGE_KEY)
}
