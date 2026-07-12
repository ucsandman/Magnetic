import { describe, expect, it } from 'vitest'
import { buildClipboardPayload, pasteSteps, selectionEndFlicks } from './clipboard'
import { connectedStartOf, spineStartOf, type Clip, type ConnectedClip } from './model'
import { connectAt, DEFAULT_FX, insertAt } from './ops'
import { UndoStack } from './undo'
import { F, clip, connected, deepFreeze, seq } from './testing'

const fxWithKf = deepFreeze({
  ...DEFAULT_FX,
  scale: 40,
  kf: {
    scale: [
      { atMediaFlicks: 0, value: 100, ease: 'linear' as const },
      { atMediaFlicks: 4 * F, value: 40, ease: 'easeInOut' as const }
    ]
  }
})

describe('buildClipboardPayload', () => {
  it('orders by derived start with offsets relative to the earliest clip', () => {
    const s = seq([clip('a', 10), clip('b', 10), clip('c', 10)], [connected('cc', 'c', 2, 4, 1)])
    // ids deliberately out of timeline order
    const payload = buildClipboardPayload(s, ['cc', 'c', 'b'])
    expect(payload.map((entry) => entry.relOffsetFlicks)).toEqual([0, 10 * F, 12 * F])
    expect(payload.map((entry) => entry.lane)).toEqual([undefined, undefined, 1])
  })

  it('snapshots fx (incl. keyframes), audioDisabled, lane −1, and titleData', () => {
    const detached: Clip = { ...clip('a', 10), fx: fxWithKf, audioDisabled: true }
    const audio: ConnectedClip = { ...connected('aud', 'a', 0, 10, -1) }
    const title: ConnectedClip = {
      ...connected('tt', 'a', 1, 4, 1),
      titleData: {
        text: 'Hi',
        font: 'Inter',
        sizePx: 64,
        color: '#fff',
        x: 960,
        y: 540,
        preset: 'basic' as const
      }
    }
    const s = seq([detached], [audio, title])
    const payload = buildClipboardPayload(s, ['a', 'aud', 'tt'])
    expect(payload).toHaveLength(3)
    const [spineEntry, audioEntry, titleEntry] = payload
    expect(spineEntry.fx).toEqual(fxWithKf)
    expect(spineEntry.audioDisabled).toBe(true)
    expect(spineEntry.lane).toBeUndefined()
    expect(audioEntry.lane).toBe(-1)
    expect(audioEntry.relOffsetFlicks).toBe(0)
    expect(titleEntry.lane).toBe(1)
    expect(titleEntry.titleData?.text).toBe('Hi')
    expect(titleEntry.relOffsetFlicks).toBe(1 * F)
  })

  it('skips gaps and unknown ids; empty selection yields an empty payload', () => {
    const s = seq([clip('a', 10), { kind: 'gap', id: 'g', durationFlicks: 5 * F }])
    expect(buildClipboardPayload(s, ['g', 'nope'])).toEqual([])
    expect(buildClipboardPayload(s, [])).toEqual([])
  })

  it('deep-clones fx so the payload is isolated from later edits', () => {
    const source: Clip = { ...clip('a', 10), fx: structuredClone(fxWithKf) }
    const s = seq([source])
    const payload = buildClipboardPayload(s, ['a'])
    expect(payload[0].fx).not.toBe(source.fx)
    expect(payload[0].fx!.kf!.scale).not.toBe(source.fx!.kf!.scale)
    expect(payload[0].fx).toEqual(source.fx)
  })
})

describe('pasteSteps', () => {
  const payload = (): ReturnType<typeof buildClipboardPayload> =>
    buildClipboardPayload(seq([clip('a', 10), clip('b', 5)], [connected('cc', 'b', 1, 3, -1)]), [
      'a',
      'b',
      'cc'
    ])

  it('insert mode: spine clips back-to-back at the paste point, connected at rel offset', () => {
    let n = 0
    const steps = pasteSteps(payload(), 100 * F, 'insert', () => `new-${n++}`)
    expect(steps.map((step) => step.kind)).toEqual(['insert', 'insert', 'connect'])
    expect(steps.map((step) => step.timeFlicks)).toEqual([100 * F, 110 * F, 111 * F])
    expect(steps[2].lane).toBe(-1)
    expect(new Set(steps.map((step) => step.clip.id)).size).toBe(3) // ids fresh + unique
  })

  it('connect mode: everything connects; spine clips default to lane 1', () => {
    let n = 0
    const steps = pasteSteps(payload(), 7 * F, 'connect', () => `new-${n++}`)
    expect(steps.every((step) => step.kind === 'connect')).toBe(true)
    expect(steps.map((step) => step.lane)).toEqual([1, 1, -1])
    expect(steps.map((step) => step.timeFlicks)).toEqual([7 * F, 17 * F, 18 * F])
  })

  it('carries fx and audioDisabled through to the planned ClipInputs', () => {
    const detached: Clip = { ...clip('a', 10), fx: fxWithKf, audioDisabled: true }
    const s = seq([detached])
    const steps = pasteSteps(buildClipboardPayload(s, ['a']), 0, 'insert', () => 'fresh')
    expect(steps[0].clip.fx).toEqual(fxWithKf)
    expect(steps[0].clip.audioDisabled).toBe(true)
  })

  it('grouped replay round-trips media windows + fx and undoes in one step', () => {
    const source = seq(
      [{ ...clip('a', 10, 2), fx: fxWithKf }, clip('b', 5)],
      [connected('cc', 'a', 1, 3, 1)]
    )
    const payload = buildClipboardPayload(source, ['a', 'b', 'cc'])
    let n = 0
    const steps = pasteSteps(payload, 15 * F, 'insert', () => `p${n++}`)
    const stack = new UndoStack(source)
    stack.beginGroup()
    for (const step of steps) {
      const result = stack.apply((current) =>
        step.kind === 'insert'
          ? insertAt(current, { clip: step.clip, timeFlicks: step.timeFlicks })
          : connectAt(current, {
              clip: step.clip,
              timeFlicks: step.timeFlicks,
              lane: step.lane,
              titleData: step.titleData
            })
      )
      expect(result.error).toBeUndefined()
    }
    stack.endGroup()
    const next = stack.current
    expect(next.spine).toHaveLength(4) // a, b + two pasted copies appended
    const pastedA = next.spine[2] as Clip
    const pastedB = next.spine[3] as Clip
    expect(pastedA).toMatchObject({
      assetId: 'asset-a',
      mediaInFlicks: 2 * F,
      durationFlicks: 10 * F,
      sourceDurationFlicks: 600 * F
    })
    expect(pastedA.fx).toEqual(fxWithKf)
    expect(pastedA.id).not.toBe('a')
    expect(pastedB.assetId).toBe('asset-b')
    // newId runs in payload order (a, cc, b — sorted by start), so cc got 'p1'
    const pastedCc = next.connected.find((cc) => cc.id === 'p1')!
    expect(connectedStartOf(next, pastedCc.id)).toBe(16 * F) // paste point + rel 1
    expect(pastedCc.lane).toBe(1)
    // the whole paste is ONE history entry
    stack.undo()
    expect(stack.current).toBe(source)
    expect(stack.canUndo).toBe(false)
  })
})

describe('pasteSteps regressions', () => {
  let nextId = 0
  const newId = (): string => `id-${nextId++}`

  it('keeps connected children glued when copied spine clips were not contiguous', () => {
    // spine A [0,5), spine B [10,15) (5-frame hole collapses on paste),
    // child attached 2 frames into B => must land 2 frames into pasted B.
    const payload = [
      {
        assetId: 'a',
        mediaInFlicks: 0,
        durationFlicks: 5 * F,
        sourceDurationFlicks: 600 * F,
        relOffsetFlicks: 0
      },
      {
        assetId: 'b',
        mediaInFlicks: 0,
        durationFlicks: 5 * F,
        sourceDurationFlicks: 600 * F,
        relOffsetFlicks: 10 * F
      },
      {
        assetId: 'c',
        mediaInFlicks: 0,
        durationFlicks: 2 * F,
        sourceDurationFlicks: 600 * F,
        lane: 1,
        relOffsetFlicks: 12 * F
      }
    ]
    const steps = pasteSteps(payload, 100 * F, 'insert', newId)
    const connect = steps.find((step) => step.kind === 'connect')
    expect(connect).toBeDefined()
    // B lands at 105 (gap collapsed, delta -5), child follows: 100 + 12 - 5
    expect(connect?.timeFlicks).toBe(107 * F)
  })

  it('carries audioDisabled into connect mode so a detached pair stays single-audio', () => {
    const payload = [
      {
        assetId: 'a',
        mediaInFlicks: 0,
        durationFlicks: 5 * F,
        sourceDurationFlicks: 600 * F,
        audioDisabled: true,
        relOffsetFlicks: 0
      }
    ]
    const [step] = pasteSteps(payload, 0, 'connect', newId)
    expect(step.kind).toBe('connect')
    expect(step.clip.audioDisabled).toBe(true)
  })
})

describe('selectionEndFlicks', () => {
  it('returns the max derived end across spine and connected clips', () => {
    const s = seq([clip('a', 10), clip('b', 5)], [connected('cc', 'b', 2, 6, 1)])
    expect(selectionEndFlicks(s, ['a'])).toBe(10 * F)
    expect(selectionEndFlicks(s, ['a', 'cc'])).toBe(18 * F) // 10 + 2 + 6
    expect(selectionEndFlicks(s, ['nope'])).toBeNull()
    expect(spineStartOf(s, 'b')).toBe(10 * F) // sanity: derived starts as expected
  })
})
