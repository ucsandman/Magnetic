import type { Sequence } from '../../shared/timeline/model'
import type { LibrarySnapshot } from '../../shared/types'
import { SEQUENCE_H, SEQUENCE_W } from '../playback/compositor/compositor'
import { PlaybackEngine, playbackEngine } from '../playback/engine'

/**
 * A/B still rendering for proposal review. The flagged risk was two live
 * engines contending for the shared per-asset decoder sessions — so this
 * runs ONE dedicated engine on an off-DOM canvas, renders base and proposed
 * frames strictly sequentially (a module-level queue serializes overlapping
 * requests), captures each as an ImageBitmap, and refuses to run while the
 * main engine is playing or exporting. No concurrency, no contention.
 */

let engine: PlaybackEngine | null = null
let canvas: HTMLCanvasElement | null = null
let queue: Promise<unknown> = Promise.resolve()

function ensureEngine(): { engine: PlaybackEngine; canvas: HTMLCanvasElement } {
  if (engine === null || canvas === null) {
    canvas = document.createElement('canvas')
    canvas.width = SEQUENCE_W
    canvas.height = SEQUENCE_H
    engine = new PlaybackEngine()
    engine.attach(canvas)
  }
  return { engine, canvas }
}

export interface ABFrames {
  base: ImageBitmap
  proposed: ImageBitmap
}

/**
 * Render the base sequence at `baseFlicks` and the proposed sequence at
 * `proposedFlicks`, returning both frames. Null while the main engine owns
 * the decoders (playback/export) — the review pane shows a hint instead.
 */
export function renderProposalPair(
  base: Sequence,
  proposed: Sequence,
  snapshot: LibrarySnapshot,
  baseFlicks: number,
  proposedFlicks: number
): Promise<ABFrames | null> {
  const run = async (): Promise<ABFrames | null> => {
    if (playbackEngine.isPlaying || playbackEngine.isExporting) return null
    const preview = ensureEngine()
    await preview.engine.renderStill(base, snapshot, baseFlicks)
    const baseBitmap = await createImageBitmap(preview.canvas)
    await preview.engine.renderStill(proposed, snapshot, proposedFlicks)
    const proposedBitmap = await createImageBitmap(preview.canvas)
    return { base: baseBitmap, proposed: proposedBitmap }
  }
  const result = queue.then(run)
  queue = result.catch(() => undefined)
  return result
}
