// ============================================================================
// strokeRenderer — WebGL2 instanced stroke renderer.
// ----------------------------------------------------------------------------
// Draws ALL stroke segments in one instanced draw over a single interleaved
// VBO. Supports:
//   - upload()      full (re)upload on structural change (add/delete/clear)
//   - updateRange() incremental bufferSubData for a single edited stroke
// Visual stability via a ping-pong feedback buffer (exponential decay →
// flicker-free + motion-blur trails). Selection glow keys on uSelectedStroke.
// Hit-testing is handled on the CPU (StrokeHitmap), so there is no GPU pick.
// ============================================================================

import { FLOATS_PER_INSTANCE, OFF, QUAD_VERTS, STRIDE_BYTES } from "./strokeGeometry";
import {
  STROKE_VERT,
  STROKE_FRAG,
  STAR_VERT,
  STAR_FRAG,
  PRESENT_VERT,
  PRESENT_FRAG,
  linkProgram,
} from "./shader";

const DECAY = 0.92;
const CONTRIBUTION = 1 - DECAY;
const WIDTH_SCALE = 0.7;

interface InstAttr {
  loc: number;
  size: number;
  offsetFloats: number;
}

const STROKE_INSTANCE_ATTRS: InstAttr[] = [
  { loc: 1, size: 2, offsetFloats: OFF.start },
  { loc: 2, size: 2, offsetFloats: OFF.end },
  { loc: 3, size: 2, offsetFloats: OFF.width },
  { loc: 4, size: 3, offsetFloats: OFF.color },
  { loc: 5, size: 3, offsetFloats: OFF.meta },
  { loc: 6, size: 2, offsetFloats: OFF.seg },
  { loc: 7, size: 3, offsetFloats: OFF.anim },
  { loc: 8, size: 1, offsetFloats: OFF.agentIdx },
  { loc: 9, size: 1, offsetFloats: OFF.strokeIdx },
];

interface Uni {
  [name: string]: WebGLUniformLocation | null;
}

export class StrokeRenderer {
  private gl: WebGL2RenderingContext;
  private strokeProg: WebGLProgram;
  private starProg: WebGLProgram;
  private presentProg: WebGLProgram;
  private strokeUni: Uni;
  private starUni: Uni;
  private presentUni: Uni;

  private quadVbo: WebGLBuffer;
  private instanceVbo: WebGLBuffer;
  private starVbo: WebGLBuffer;
  private strokeVao: WebGLVertexArrayObject;
  private starVao: WebGLVertexArrayObject;
  private emptyVao: WebGLVertexArrayObject;

  private sceneTex: (WebGLTexture | null)[] = [null, null];
  private sceneFbo: (WebGLFramebuffer | null)[] = [null, null];

  private instanceCount = 0;
  private capacityFloats = 0;
  private starCount = 0;
  private dpr = 1;
  private frameParity = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 not supported");
    this.gl = gl;

    this.strokeProg = linkProgram(gl, STROKE_VERT, STROKE_FRAG);
    this.starProg = linkProgram(gl, STAR_VERT, STAR_FRAG);
    this.presentProg = linkProgram(gl, PRESENT_VERT, PRESENT_FRAG);

    this.strokeUni = this.uniforms(this.strokeProg, [
      "uResolution", "uTime", "uDpr", "uWidthScale", "uContribution",
      "uFocusStroke", "uFilterAgent", "uViewScale", "uViewTranslate",
    ]);
    this.starUni = this.uniforms(this.starProg, ["uResolution", "uTime", "uDpr", "uContribution"]);
    this.presentUni = this.uniforms(this.presentProg, ["uTex", "uScale"]);

    this.quadVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTS, gl.STATIC_DRAW);
    this.instanceVbo = gl.createBuffer()!;
    this.starVbo = gl.createBuffer()!;

    this.strokeVao = this.buildVao(STROKE_INSTANCE_ATTRS);
    this.starVao = this.buildStarVao();
    this.emptyVao = gl.createVertexArray()!;
  }

  private uniforms(prog: WebGLProgram, names: string[]): Uni {
    const gl = this.gl;
    const u: Uni = {};
    for (const n of names) u[n] = gl.getUniformLocation(prog, n);
    return u;
  }

  private buildVao(attrs: InstAttr[]): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
    for (const a of attrs) {
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, STRIDE_BYTES, a.offsetFloats * 4);
      gl.vertexAttribDivisor(a.loc, 1);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  private buildStarVao(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 5 * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 5 * 4, 2 * 4);
    gl.bindVertexArray(null);
    return vao;
  }

  private makeColorTarget(w: number, h: number) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo };
  }

  resize(cssW: number, cssH: number, dpr: number) {
    const gl = this.gl;
    this.dpr = dpr;
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));
    gl.canvas.width = w;
    gl.canvas.height = h;
    for (let i = 0; i < 2; i++) {
      if (this.sceneTex[i]) gl.deleteTexture(this.sceneTex[i]);
      if (this.sceneFbo[i]) gl.deleteFramebuffer(this.sceneFbo[i]);
      const t = this.makeColorTarget(w, h);
      this.sceneTex[i] = t.tex;
      this.sceneFbo[i] = t.fbo;
    }
    this.regenStars(w, h);
  }

  private regenStars(w: number, h: number) {
    const count = Math.min(1400, Math.floor((w * h) / 6000));
    const arr = new Float32Array(count * 5);
    let a = 0x1234567;
    const rng = () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      const o = i * 5;
      arr[o] = rng();
      arr[o + 1] = rng();
      arr[o + 2] = rng() * 1.6 + 0.4;
      arr[o + 3] = rng() * 0.5 + 0.12;
      arr[o + 4] = rng() * Math.PI * 2;
    }
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.starVbo);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, arr, this.gl.STATIC_DRAW);
    this.starCount = count;
  }

  /** Full (re)upload — used on structural change. Grows GPU storage as needed. */
  upload(data: Float32Array, count: number) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
    if (data.byteLength > this.capacityFloats * 4 || this.capacityFloats === 0) {
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      this.capacityFloats = data.length;
    } else {
      // reuse existing GPU allocation
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    }
    this.instanceCount = count;
  }

  /** Incremental update of one stroke's float range (transform edit). */
  updateRange(offsetFloats: number, sub: Float32Array) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, offsetFloats * 4, sub);
  }

  private fullscreen() {
    const gl = this.gl;
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  render(
    time: number,
    focusStroke: number,
    filterAgent: number,
    view: { scale: number; translateX: number; translateY: number } = { scale: 1, translateX: 0, translateY: 0 },
  ) {
    const gl = this.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const cur = this.frameParity & 1;
    const prev = cur ^ 1;

    gl.disable(gl.DEPTH_TEST);

    // 1) fade previous frame into current target (exponential decay)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo[cur]);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(this.presentProg);
    gl.uniform1f(this.presentUni.uScale, DECAY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex[prev]);
    gl.uniform1i(this.presentUni.uTex, 0);
    this.fullscreen();

    // 2) additive content
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(this.starProg);
    gl.uniform2f(this.starUni.uResolution, w, h);
    gl.uniform1f(this.starUni.uTime, time);
    gl.uniform1f(this.starUni.uDpr, this.dpr);
    gl.uniform1f(this.starUni.uContribution, CONTRIBUTION);
    gl.bindVertexArray(this.starVao);
    gl.drawArrays(gl.POINTS, 0, this.starCount);

    if (this.instanceCount > 0) {
      gl.useProgram(this.strokeProg);
      gl.uniform2f(this.strokeUni.uResolution, w, h);
      gl.uniform1f(this.strokeUni.uTime, time);
      gl.uniform1f(this.strokeUni.uDpr, this.dpr);
      gl.uniform1f(this.strokeUni.uWidthScale, WIDTH_SCALE);
      gl.uniform1f(this.strokeUni.uContribution, CONTRIBUTION);
      gl.uniform1f(this.strokeUni.uFocusStroke, focusStroke);
      gl.uniform1f(this.strokeUni.uFilterAgent, filterAgent);
      gl.uniform1f(this.strokeUni.uViewScale, view.scale);
      gl.uniform2f(this.strokeUni.uViewTranslate, view.translateX, view.translateY);
      gl.bindVertexArray(this.strokeVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
    }

    // 3) present current target to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(this.presentProg);
    gl.uniform1f(this.presentUni.uScale, 1.0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex[cur]);
    gl.uniform1i(this.presentUni.uTex, 0);
    this.fullscreen();

    gl.bindVertexArray(null);
    this.frameParity ^= 1;
  }

  dispose() {
    const gl = this.gl;
    gl.deleteBuffer(this.quadVbo);
    gl.deleteBuffer(this.instanceVbo);
    gl.deleteBuffer(this.starVbo);
    gl.deleteVertexArray(this.strokeVao);
    gl.deleteVertexArray(this.starVao);
    gl.deleteVertexArray(this.emptyVao);
    gl.deleteProgram(this.strokeProg);
    gl.deleteProgram(this.starProg);
    gl.deleteProgram(this.presentProg);
    for (let i = 0; i < 2; i++) {
      if (this.sceneTex[i]) gl.deleteTexture(this.sceneTex[i]);
      if (this.sceneFbo[i]) gl.deleteFramebuffer(this.sceneFbo[i]);
    }
  }
}

export { FLOATS_PER_INSTANCE };
