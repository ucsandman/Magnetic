import type { TitleData } from '../../shared/timeline/model'
import { SEQUENCE_H, SEQUENCE_W } from '../playback/compositor/compositor'

/**
 * Title rendering: text → offscreen 2D canvas (full sequence frame with
 * transparency) → compositor texture. Presets pick position and styling.
 */

export const TITLE_PRESETS: Record<TitleData['preset'], { label: string; make(): TitleData }> = {
  basic: {
    label: 'Basic',
    make: () => ({
      text: 'Title',
      font: 'system-ui, sans-serif',
      sizePx: 96,
      color: '#ffffff',
      x: SEQUENCE_W / 2,
      y: SEQUENCE_H / 2,
      preset: 'basic'
    })
  },
  lowerThird: {
    label: 'Lower Third',
    make: () => ({
      text: 'Lower Third',
      font: 'system-ui, sans-serif',
      sizePx: 64,
      color: '#ffffff',
      x: SEQUENCE_W * 0.22,
      y: SEQUENCE_H * 0.82,
      preset: 'lowerThird'
    })
  },
  bumper: {
    label: 'Bumper',
    make: () => ({
      text: 'Bumper',
      font: 'system-ui, sans-serif',
      sizePx: 140,
      color: '#ffffff',
      x: SEQUENCE_W / 2,
      y: SEQUENCE_H / 2,
      preset: 'bumper'
    })
  }
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((word) => word !== '')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (ctx.measureText(candidate).width > maxWidth && current !== '') {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current !== '') lines.push(current)
  return lines.length > 0 ? lines : ['']
}

/** Render at 2× and downscale for crisp text. */
export function renderTitle(title: TitleData): HTMLCanvasElement {
  const scale = 2
  const large = document.createElement('canvas')
  large.width = SEQUENCE_W * scale
  large.height = SEQUENCE_H * scale
  const ctx = large.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.font = `600 ${title.sizePx}px ${title.font}`
  ctx.fillStyle = title.color
  ctx.textBaseline = 'middle'
  ctx.textAlign = title.preset === 'lowerThird' ? 'left' : 'center'
  const lines = wrapLines(ctx, title.text, SEQUENCE_W * 0.8)
  const lineHeight = title.sizePx * 1.2
  const blockTop = title.y - ((lines.length - 1) * lineHeight) / 2
  if (title.preset === 'lowerThird') {
    // accent bar to the left of the text block
    ctx.fillStyle = '#0a84ff'
    const barHeight = lines.length * lineHeight + 16
    ctx.fillRect(
      title.x - 28,
      blockTop - barHeight / 2 + ((lines.length - 1) * lineHeight) / 2,
      10,
      barHeight
    )
    ctx.fillStyle = title.color
  }
  lines.forEach((line, index) => {
    ctx.fillText(line, title.x, blockTop + index * lineHeight)
  })
  const out = document.createElement('canvas')
  out.width = SEQUENCE_W
  out.height = SEQUENCE_H
  out.getContext('2d')!.drawImage(large, 0, 0, SEQUENCE_W, SEQUENCE_H)
  return out
}
