import { openSample } from './sample-decoder'

export interface SpikeResult {
  frameCount: number
  codedWidth: number
  codedHeight: number
  displayWidth: number
  displayHeight: number
  maxQueued: number
}

export interface DecoderSpike {
  decodeFrames(url: string, count: number): Promise<SpikeResult>
}

declare global {
  interface Window {
    __decoderSpike?: DecoderSpike
  }
}

/** Test-only harness (installed when MAGNETIC_TEST=1) — drives the WebCodecs spike from E2E. */
export function installDecoderSpike(): void {
  window.__decoderSpike = {
    async decodeFrames(url: string, count: number): Promise<SpikeResult> {
      const handle = await openSample(url)
      let frameCount = 0
      let codedWidth = 0
      let codedHeight = 0
      let displayWidth = 0
      let displayHeight = 0
      try {
        for await (const frame of handle.decodeRange(0, count)) {
          frameCount += 1
          codedWidth = frame.codedWidth
          codedHeight = frame.codedHeight
          displayWidth = frame.displayWidth
          displayHeight = frame.displayHeight
          frame.close()
        }
      } finally {
        handle.close()
      }
      return {
        frameCount,
        codedWidth,
        codedHeight,
        displayWidth,
        displayHeight,
        maxQueued: handle.stats.maxQueued
      }
    }
  }
}
