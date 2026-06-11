import type { ClipFx } from '../../../shared/timeline/model'
import { DEFAULT_FX } from '../../../shared/timeline/ops'

/**
 * WebGL2 compositor: one textured quad per visible layer, painted
 * back-to-front into a fixed 1920×1080 sequence-space framebuffer (other
 * aspect ratios letterbox). Textures persist across frames so paused
 * re-renders and readPixels never need the original VideoFrames.
 */

export const SEQUENCE_W = 1920
export const SEQUENCE_H = 1080

export interface CompositedLayer {
  /** Stable per-clip slot key; textures are reused across frames. */
  slot: string
  /** New frame to upload, or null to re-present the slot's last texture. */
  frame: VideoFrame | null
  fx: ClipFx | undefined
}

interface SlotTexture {
  texture: WebGLTexture
  width: number
  height: number
}

const VERTEX_SRC = `#version 300 es
in vec2 aPos;
uniform vec2 uCenter;    // sequence-space px
uniform vec2 uSize;      // layer size in sequence-space px (after fit + scale)
uniform float uRotation; // radians
out vec2 vUv;
void main() {
  vUv = aPos + 0.5;
  vec2 local = aPos * uSize;
  float c = cos(uRotation);
  float s = sin(uRotation);
  vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 px = uCenter + rotated;
  vec2 clip = vec2(px.x / ${SEQUENCE_W / 2}.0 - 1.0, 1.0 - px.y / ${SEQUENCE_H / 2}.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}`

const FRAGMENT_SRC = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform float uOpacity;
out vec4 outColor;
void main() {
  vec4 color = texture(uTexture, vUv);
  outColor = vec4(color.rgb, color.a) * uOpacity;
}`

export class Compositor {
  private gl: WebGL2RenderingContext
  private uniforms: {
    center: WebGLUniformLocation
    size: WebGLUniformLocation
    rotation: WebGLUniformLocation
    opacity: WebGLUniformLocation
  }
  private slots = new Map<string, SlotTexture>()
  private lastLayers: { slot: string; fx: ClipFx | undefined }[] = []

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = SEQUENCE_W
    canvas.height = SEQUENCE_H
    const gl = canvas.getContext('webgl2', {
      preserveDrawingBuffer: false,
      alpha: false,
      antialias: false
    })
    if (gl === null) throw new Error('WebGL2 is unavailable')
    this.gl = gl

    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type)!
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
        throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader)}`)
      }
      return shader
    }
    const program = gl.createProgram()!
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SRC))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SRC))
    gl.linkProgram(program)
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`)
    }
    gl.useProgram(program)

    const quad = new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5])
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    this.uniforms = {
      center: gl.getUniformLocation(program, 'uCenter')!,
      size: gl.getUniformLocation(program, 'uSize')!,
      rotation: gl.getUniformLocation(program, 'uRotation')!,
      opacity: gl.getUniformLocation(program, 'uOpacity')!
    }
    gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.viewport(0, 0, SEQUENCE_W, SEQUENCE_H)
    gl.clearColor(0, 0, 0, 1)
  }

  /** Upload any new frames (closing them) and paint layers back-to-front. */
  draw(layers: CompositedLayer[]): void {
    for (const layer of layers) {
      if (layer.frame !== null) {
        this.upload(layer.slot, layer.frame)
        layer.frame.close()
      }
    }
    this.lastLayers = layers.map(({ slot, fx }) => ({ slot, fx }))
    this.renderLast()
  }

  private upload(slot: string, frame: VideoFrame): void {
    const gl = this.gl
    const width = frame.displayWidth
    const height = frame.displayHeight
    let entry = this.slots.get(slot)
    gl.activeTexture(gl.TEXTURE0)
    if (entry === undefined || entry.width !== width || entry.height !== height) {
      if (entry !== undefined) gl.deleteTexture(entry.texture)
      const texture = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      // allocate once per size; subsequent frames reuse via texSubImage2D
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      entry = { texture, width, height }
      this.slots.set(slot, entry)
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.texture)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, frame)
  }

  private renderLast(): void {
    const gl = this.gl
    gl.clear(gl.COLOR_BUFFER_BIT)
    for (const layer of this.lastLayers) {
      const entry = this.slots.get(layer.slot)
      if (entry === undefined) continue
      const fx = layer.fx ?? DEFAULT_FX
      // letterbox-fit the native frame into sequence space, then apply scale
      const fit = Math.min(SEQUENCE_W / entry.width, SEQUENCE_H / entry.height)
      const scale = (fit * fx.scale) / 100
      gl.bindTexture(gl.TEXTURE_2D, entry.texture)
      gl.uniform2f(this.uniforms.center, SEQUENCE_W / 2 + fx.posX, SEQUENCE_H / 2 + fx.posY)
      gl.uniform2f(this.uniforms.size, entry.width * scale, entry.height * scale)
      gl.uniform1f(this.uniforms.rotation, (fx.rotation * Math.PI) / 180)
      gl.uniform1f(this.uniforms.opacity, fx.opacity / 100)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
  }

  /**
   * Test/export hook: re-render the last layer set, then read pixels.
   * Coordinates are top-left-origin sequence-space; rows returned top-down.
   */
  readPixels(x: number, y: number, w: number, h: number): Uint8ClampedArray {
    const gl = this.gl
    this.renderLast()
    const raw = new Uint8Array(w * h * 4)
    gl.readPixels(x, SEQUENCE_H - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
    // flip rows: GL reads bottom-up
    const flipped = new Uint8ClampedArray(w * h * 4)
    for (let row = 0; row < h; row++) {
      flipped.set(raw.subarray((h - row - 1) * w * 4, (h - row) * w * 4), row * w * 4)
    }
    return flipped
  }

  dispose(): void {
    for (const entry of this.slots.values()) this.gl.deleteTexture(entry.texture)
    this.slots.clear()
    this.lastLayers = []
  }
}
