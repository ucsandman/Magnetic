import type { CaptionSettings } from '../../shared/timeline/model'
import { SEQUENCE_H, SEQUENCE_W } from '../playback/compositor/compositor'
import type { CaptionCue } from './cues'

/**
 * Caption rendering: active cue → offscreen 2D canvas (full sequence frame
 * with transparency) → compositor texture, mirroring titles/render.ts.
 * Presets: 'block' draws the whole cue, 'pop-in' draws words up to the
 * active word, 'karaoke' draws all words with the active one highlighted.
 */

const CARD_COLOR = 'rgba(0, 0, 0, 0.65)'
const CARD_PAD_X = 24
const MAX_LINE_W = SEQUENCE_W * 0.8

const POSITION_Y: Record<CaptionSettings['position'], number> = {
  bottom: SEQUENCE_H * 0.88,
  middle: SEQUENCE_H * 0.5,
  top: SEQUENCE_H * 0.12
}

interface Line {
  /** Global word indices (into cue.words) on this line. */
  wordIndexes: number[]
  width: number
}

/** Greedy word wrap using measured widths; layout always uses ALL words so pop-in never reflows. */
function layoutLines(ctx: CanvasRenderingContext2D, words: string[], spaceW: number): Line[] {
  const lines: Line[] = []
  let current: Line = { wordIndexes: [], width: 0 }
  for (let i = 0; i < words.length; i++) {
    const wordW = ctx.measureText(words[i]).width
    const extra = current.wordIndexes.length === 0 ? wordW : spaceW + wordW
    if (current.wordIndexes.length > 0 && current.width + extra > MAX_LINE_W) {
      lines.push(current)
      current = { wordIndexes: [i], width: wordW }
    } else {
      current.wordIndexes.push(i)
      current.width += extra
    }
  }
  if (current.wordIndexes.length > 0) lines.push(current)
  return lines
}

/** Render at 2× and downscale for crisp text (same approach as renderTitle). */
export function renderCaption(
  cue: CaptionCue,
  settings: CaptionSettings,
  activeWordIndex: number
): HTMLCanvasElement {
  const scale = 2
  const large = document.createElement('canvas')
  large.width = SEQUENCE_W * scale
  large.height = SEQUENCE_H * scale
  const ctx = large.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.font = `600 ${settings.sizePx}px ${settings.font}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'

  const spaceW = ctx.measureText(' ').width
  const lines = layoutLines(
    ctx,
    cue.words.map((word) => word.text),
    spaceW
  )
  const lineHeight = settings.sizePx * 1.4
  const centerY = POSITION_Y[settings.position]
  const blockTop = centerY - ((lines.length - 1) * lineHeight) / 2

  // caption card: one backdrop rect per line, sized to the full line
  ctx.fillStyle = CARD_COLOR
  lines.forEach((line, lineIndex) => {
    const lineY = blockTop + lineIndex * lineHeight
    ctx.fillRect(
      (SEQUENCE_W - line.width) / 2 - CARD_PAD_X,
      lineY - lineHeight / 2,
      line.width + 2 * CARD_PAD_X,
      lineHeight
    )
  })

  lines.forEach((line, lineIndex) => {
    const lineY = blockTop + lineIndex * lineHeight
    let x = (SEQUENCE_W - line.width) / 2
    for (const wordIndex of line.wordIndexes) {
      const text = cue.words[wordIndex].text
      const wordW = ctx.measureText(text).width
      const visible = settings.preset !== 'pop-in' || wordIndex <= activeWordIndex
      if (visible) {
        ctx.fillStyle =
          settings.preset === 'karaoke' && wordIndex === activeWordIndex
            ? settings.highlightColor
            : settings.color
        ctx.fillText(text, x, lineY)
      }
      x += wordW + spaceW
    }
  })

  const out = document.createElement('canvas')
  out.width = SEQUENCE_W
  out.height = SEQUENCE_H
  out.getContext('2d')!.drawImage(large, 0, 0, SEQUENCE_W, SEQUENCE_H)
  return out
}
