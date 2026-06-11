import type { ClipFx, TransitionKind } from '../../../shared/timeline/model'
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
  /** Non-video upload (title canvas); used when frame is null. */
  image?: TexImageSource & { width: number; height: number }
  /** Transition: blend this layer (A) with slotB's texture (B). */
  blend?: {
    slotB: string
    frameB: VideoFrame | null
    progress: number
    kind: TransitionKind
  }
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
uniform float uExposure;    // -1..1 stops
uniform float uContrast;    // 0..2
uniform float uSaturation;  // 0..2
uniform float uTemperature; // -1..1
out vec4 outColor;
void main() {
  vec4 color = texture(uTexture, vUv);
  vec3 rgb = color.rgb;
  // color board, in order: temperature -> exposure -> contrast -> saturation
  rgb += vec3(uTemperature * 0.1, 0.0, -uTemperature * 0.1);
  rgb *= pow(2.0, uExposure);
  rgb = (rgb - 0.5) * uContrast + 0.5;
  float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(luma), rgb, uSaturation);
  outColor = vec4(clamp(rgb, 0.0, 1.0), color.a) * uOpacity;
}`

/** Full-canvas transition pass: sample both fitted layers, blend per kind. */
const TRANSITION_VERTEX_SRC = `#version 300 es
in vec2 aPos;
out vec2 vPx;
void main() {
  vec2 unit = aPos + 0.5;
  vPx = unit * vec2(${SEQUENCE_W}.0, ${SEQUENCE_H}.0);
  gl_Position = vec4(unit.x * 2.0 - 1.0, 1.0 - unit.y * 2.0, 0.0, 1.0);
}`

const TRANSITION_FRAGMENT_SRC = `#version 300 es
precision mediump float;
in vec2 vPx;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform vec4 uRectA; // x,y,w,h in sequence px
uniform vec4 uRectB;
uniform float uProgress;
uniform int uKind; // 1 dissolve, 2 wipeL, 3 wipeR, 4 fadeBlack
out vec4 outColor;
vec4 sampleLayer(sampler2D tex, vec4 rect) {
  vec2 uv = (vPx - rect.xy) / rect.zw;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0, 0.0, 0.0, 1.0);
  return texture(tex, uv);
}
void main() {
  vec4 a = sampleLayer(uTexA, uRectA);
  vec4 b = sampleLayer(uTexB, uRectB);
  if (uKind == 1) {
    outColor = mix(a, b, uProgress);
  } else if (uKind == 2) {
    float edge = uProgress * ${SEQUENCE_W}.0;
    outColor = mix(b, a, smoothstep(edge - 1.0, edge + 1.0, vPx.x));
  } else if (uKind == 3) {
    float edge = (1.0 - uProgress) * ${SEQUENCE_W}.0;
    outColor = mix(a, b, smoothstep(edge - 1.0, edge + 1.0, vPx.x));
  } else {
    vec4 black = vec4(0.0, 0.0, 0.0, 1.0);
    outColor = uProgress < 0.5 ? mix(a, black, uProgress * 2.0) : mix(black, b, (uProgress - 0.5) * 2.0);
  }
}`

const KIND_CODES: Record<TransitionKind, number> = {
  dissolve: 1,
  wipeL: 2,
  wipeR: 3,
  fadeBlack: 4
}

interface StoredLayer {
  slot: string
  fx: ClipFx | undefined
  blend?: { slotB: string; progress: number; kind: TransitionKind }
}

export class Compositor {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private programVao: WebGLVertexArrayObject
  private transitionProgram: WebGLProgram
  private transitionVao: WebGLVertexArrayObject
  private uniforms: Record<
    | 'center'
    | 'size'
    | 'rotation'
    | 'opacity'
    | 'exposure'
    | 'contrast'
    | 'saturation'
    | 'temperature',
    WebGLUniformLocation
  >
  private transitionUniforms: Record<'rectA' | 'rectB' | 'progress' | 'kind', WebGLUniformLocation>
  private slots = new Map<string, SlotTexture>()
  private lastLayers: StoredLayer[] = []

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

    const quad = new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5])
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)

    const makeVao = (program: WebGLProgram): WebGLVertexArrayObject => {
      const vao = gl.createVertexArray()!
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      const aPos = gl.getAttribLocation(program, 'aPos')
      gl.enableVertexAttribArray(aPos)
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
      gl.bindVertexArray(null)
      return vao
    }

    this.program = this.makeProgram(VERTEX_SRC, FRAGMENT_SRC)
    this.programVao = makeVao(this.program)
    this.transitionProgram = this.makeProgram(TRANSITION_VERTEX_SRC, TRANSITION_FRAGMENT_SRC)
    this.transitionVao = makeVao(this.transitionProgram)

    const u = (name: string): WebGLUniformLocation => gl.getUniformLocation(this.program, name)!
    this.uniforms = {
      center: u('uCenter'),
      size: u('uSize'),
      rotation: u('uRotation'),
      opacity: u('uOpacity'),
      exposure: u('uExposure'),
      contrast: u('uContrast'),
      saturation: u('uSaturation'),
      temperature: u('uTemperature')
    }
    gl.useProgram(this.program)
    gl.uniform1i(gl.getUniformLocation(this.program, 'uTexture'), 0)

    const tu = (name: string): WebGLUniformLocation =>
      gl.getUniformLocation(this.transitionProgram, name)!
    this.transitionUniforms = {
      rectA: tu('uRectA'),
      rectB: tu('uRectB'),
      progress: tu('uProgress'),
      kind: tu('uKind')
    }
    gl.useProgram(this.transitionProgram)
    gl.uniform1i(gl.getUniformLocation(this.transitionProgram, 'uTexA'), 0)
    gl.uniform1i(gl.getUniformLocation(this.transitionProgram, 'uTexB'), 1)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.viewport(0, 0, SEQUENCE_W, SEQUENCE_H)
    gl.clearColor(0, 0, 0, 1)
  }

  private makeProgram(vertexSrc: string, fragmentSrc: string): WebGLProgram {
    const gl = this.gl
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
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSrc))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSrc))
    gl.linkProgram(program)
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`)
    }
    return program
  }

  /** Upload any new frames/images (closing frames) and paint back-to-front. */
  draw(layers: CompositedLayer[]): void {
    for (const layer of layers) {
      if (layer.frame !== null) {
        this.upload(layer.slot, layer.frame, layer.frame.displayWidth, layer.frame.displayHeight)
        layer.frame.close()
      } else if (layer.image !== undefined) {
        this.upload(layer.slot, layer.image, layer.image.width, layer.image.height)
      }
      if (layer.blend !== undefined && layer.blend.frameB !== null) {
        this.upload(
          layer.blend.slotB,
          layer.blend.frameB,
          layer.blend.frameB.displayWidth,
          layer.blend.frameB.displayHeight
        )
        layer.blend.frameB.close()
      }
    }
    this.lastLayers = layers.map(({ slot, fx, blend }) => ({
      slot,
      fx,
      blend:
        blend === undefined
          ? undefined
          : { slotB: blend.slotB, progress: blend.progress, kind: blend.kind }
    }))
    this.renderLast()
  }

  private upload(slot: string, source: TexImageSource, width: number, height: number): void {
    const gl = this.gl
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
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, source)
  }

  /** Letterbox-fit rect of a slot's texture in sequence space (no rotation). */
  private fitRect(entry: SlotTexture, fx: ClipFx | undefined): [number, number, number, number] {
    const effective = fx ?? DEFAULT_FX
    const fit = Math.min(SEQUENCE_W / entry.width, SEQUENCE_H / entry.height)
    const scale = (fit * effective.scale) / 100
    const w = entry.width * scale
    const h = entry.height * scale
    return [SEQUENCE_W / 2 + effective.posX - w / 2, SEQUENCE_H / 2 + effective.posY - h / 2, w, h]
  }

  private renderLast(): void {
    const gl = this.gl
    gl.clear(gl.COLOR_BUFFER_BIT)
    for (const layer of this.lastLayers) {
      const entry = this.slots.get(layer.slot)
      if (entry === undefined) continue
      if (layer.blend !== undefined) {
        const entryB = this.slots.get(layer.blend.slotB)
        if (entryB !== undefined) {
          this.drawTransition(entry, entryB, layer)
          continue
        }
      }
      const fx = layer.fx ?? DEFAULT_FX
      const fit = Math.min(SEQUENCE_W / entry.width, SEQUENCE_H / entry.height)
      const scale = (fit * fx.scale) / 100
      gl.useProgram(this.program)
      gl.bindVertexArray(this.programVao)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, entry.texture)
      gl.uniform2f(this.uniforms.center, SEQUENCE_W / 2 + fx.posX, SEQUENCE_H / 2 + fx.posY)
      gl.uniform2f(this.uniforms.size, entry.width * scale, entry.height * scale)
      gl.uniform1f(this.uniforms.rotation, (fx.rotation * Math.PI) / 180)
      gl.uniform1f(this.uniforms.opacity, fx.opacity / 100)
      gl.uniform1f(this.uniforms.exposure, fx.exposure)
      gl.uniform1f(this.uniforms.contrast, fx.contrast)
      gl.uniform1f(this.uniforms.saturation, fx.saturation)
      gl.uniform1f(this.uniforms.temperature, fx.temperature)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    gl.bindVertexArray(null)
  }

  private drawTransition(entryA: SlotTexture, entryB: SlotTexture, layer: StoredLayer): void {
    const gl = this.gl
    const blend = layer.blend!
    gl.useProgram(this.transitionProgram)
    gl.bindVertexArray(this.transitionVao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, entryA.texture)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, entryB.texture)
    gl.uniform4f(this.transitionUniforms.rectA, ...this.fitRect(entryA, layer.fx))
    gl.uniform4f(this.transitionUniforms.rectB, ...this.fitRect(entryB, undefined))
    gl.uniform1f(this.transitionUniforms.progress, blend.progress)
    gl.uniform1i(this.transitionUniforms.kind, KIND_CODES[blend.kind])
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.activeTexture(gl.TEXTURE0)
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
