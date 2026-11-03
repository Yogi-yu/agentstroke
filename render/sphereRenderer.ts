import { screenToSphereUV, sphereRadius, type SphereRotation, type SphereUV } from "@/engine/sphereProjection";

const VERTEX = `#version 300 es
precision highp float;
void main() {
  // One full-screen triangle; the fragment shader intersects an exact sphere.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uRadius;
uniform vec2 uRotation;
uniform sampler2D uArtwork;
out vec4 outColor;
const float PI = 3.141592653589793;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

// Derive the angular footprint from the continuous 3D normal, not fwidth(uv):
// atan's longitude seam would otherwise create a wide flashing grid band.
vec2 angularDelta(vec3 point, vec3 delta) {
  float ring2 = max(0.00001, dot(point.xz, point.xz));
  return vec2((point.z * delta.x - point.x * delta.z) / (2.0 * PI * ring2),
    -delta.y / (PI * sqrt(max(0.00001, 1.0 - point.y * point.y))));
}

void main() {
  vec2 p = (gl_FragCoord.xy - uResolution * 0.5) / uRadius;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  // The positive root is the FRONT surface. No rear texture, interior lines,
  // mesh chords, or semi-transparent hemisphere can show through the body.
  vec3 normal = vec3(p, sqrt(max(0.0, 1.0 - r2)));
  float sy = sin(uRotation.x), cy = cos(uRotation.x);
  float sp = sin(uRotation.y), cp = cos(uRotation.y);
  vec3 unpitched = vec3(normal.x, cp * normal.y + sp * normal.z, -sp * normal.y + cp * normal.z);
  vec3 local = vec3(cy * unpitched.x - sy * unpitched.z, unpitched.y, sy * unpitched.x + cy * unpitched.z);
  vec2 uv = vec2(atan(local.x, local.z) / (2.0 * PI) + 0.5, 0.5 - asin(clamp(local.y, -1.0, 1.0)) / PI);
  vec4 paint = texture(uArtwork, uv);
  vec2 uvFootprint = max(abs(angularDelta(local, dFdx(local))) + abs(angularDelta(local, dFdy(local))), vec2(0.000001));

  float light = max(0.0, dot(normal, normalize(vec3(-0.55, 0.65, 1.2))));
  vec3 surface = mix(vec3(0.012, 0.024, 0.032), vec3(0.041, 0.078, 0.091), light);
  // Delicate latitude/longitude lines follow the same rotation as the art,
  // providing a spatial cue without competing with the existing brush texture.
  vec2 grid = uv * vec2(24.0, 12.0);
  vec2 lineDistance = abs(fract(grid + 0.5) - 0.5);
  vec2 footprint = clamp(uvFootprint * vec2(24.0, 12.0), vec2(0.0001), vec2(0.2));
  float lattice = max(1.0 - smoothstep(0.0, footprint.x * 0.85, lineDistance.x), 1.0 - smoothstep(0.0, footprint.y * 0.85, lineDistance.y));
  surface += vec3(0.09, 0.18, 0.20) * lattice * 0.055 * normal.z;

  // A readable, regular point lattice describes the curved surface even when
  // no stroke is passing in front. Fewer points on high-latitude rings prevent
  // a crowded bright cap at the poles. Rows sit BETWEEN the poles, not on them.
  float dotRows = 32.0;
  float dotRow = min(dotRows - 1.0, floor(uv.y * dotRows));
  float dotV = (dotRow + 0.5) / dotRows;
  float dotColumns = max(6.0, floor(64.0 * sin(dotV * PI) + 0.5));
  float rowOffset = mod(dotRow, 2.0) * 0.5;
  float dotU = abs(fract(uv.x * dotColumns + rowOffset + 0.5) - 0.5) / dotColumns;
  // Bound the antialias footprint to a fraction of a cell. Unbounded polar or
  // grazing derivatives could otherwise merge individual dots into a band.
  vec2 dotFootprint = clamp(uvFootprint, vec2(0.000001), vec2(0.16 / dotColumns, 0.16 / dotRows));
  vec2 dotDistance = vec2(dotU, abs(uv.y - dotV)) / dotFootprint;
  // Screen-space antialiasing keeps dots visible on small displays while the
  // centre-facing rings are brighter than the receding rings at the silhouette.
  float dotRadius = clamp(0.95 + uRadius * 0.0018, 1.3, 2.1);
  float pointLattice = 1.0 - smoothstep(dotRadius * 0.45, dotRadius, length(dotDistance));
  float pointDepth = 0.38 + 0.62 * sqrt(max(0.0, normal.z));
  surface += vec3(0.19, 0.47, 0.49) * pointLattice * pointDepth;

  // Sparse pinpricks belong to the sphere, not a screen-aligned backdrop.
  vec2 cell = uv * vec2(180.0, 90.0);
  vec2 id = floor(cell);
  float seed = hash(id);
  vec2 centre = vec2(hash(id + 13.0), hash(id + 71.0)) * 0.64 + 0.18;
  float starDistance = length((fract(cell) - centre) / max(uvFootprint * vec2(180.0, 90.0), vec2(0.01)));
  float star = (1.0 - smoothstep(0.28, 1.15, starDistance)) * step(0.976, seed);
  surface += vec3(0.06, 0.13, 0.15) * star * (0.3 + normal.z * 0.7);
  float rim = pow(1.0 - normal.z, 5.0);
  surface += vec3(0.08, 0.22, 0.25) * rim;

  // Canvas is uploaded premultiplied. Preserve the real material's color and
  // grain; only the unpainted surface receives the globe's dark shading.
  vec3 color = paint.rgb + surface * (1.0 - paint.a);
  float coverage = smoothstep(0.0, 1.25 / uRadius, 1.0 - sqrt(r2));
  outColor = vec4(color * coverage, coverage);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not allocate the sphere shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Could not compile the sphere shader: ${message ?? "Unknown GPU error"}`);
  }
  return shader;
}

/**
 * Live brush atlas -> opaque 3D spherical surface. The existing MeteorRenderer
 * remains responsible for the exact paths, pressure, pigments and time phases.
 */
export class SphereRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private readonly vao: WebGLVertexArrayObject;
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private width = 1;
  private height = 1;
  private atlasWidth = 0;
  private atlasHeight = 0;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error("Noema Sphere requires WebGL2 support.");
    this.gl = gl;
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!program) throw new Error("Could not allocate the sphere program.");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Could not link the sphere program: ${message ?? "Unknown GPU error"}`);
    }
    this.program = program;
    const texture = gl.createTexture();
    const vao = gl.createVertexArray();
    if (!texture || !vao) throw new Error("Could not allocate the sphere surface.");
    this.texture = texture;
    this.vao = vao;
    this.uniforms = Object.fromEntries(["uResolution", "uRadius", "uRotation", "uArtwork"].map(name => [name, gl.getUniformLocation(program, name)]));
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.width = Math.max(1, cssWidth);
    this.height = Math.max(1, cssHeight);
    const ratio = Math.max(1, Math.min(2, dpr));
    const width = Math.round(this.width * ratio), height = Math.round(this.height * ratio);
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.gl.viewport(0, 0, width, height);
  }

  draw(atlas: HTMLCanvasElement, rotation: SphereRotation, zoom = 1): void {
    if (this.disposed || !atlas.width || !atlas.height) return;
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // UV v=0 addresses the TOP row of the source canvas, matching hitUV.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (this.atlasWidth !== atlas.width || this.atlasHeight !== atlas.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
      this.atlasWidth = atlas.width;
      this.atlasHeight = atlas.height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    }
    gl.uniform1i(this.uniforms.uArtwork, 0);
    gl.uniform2f(this.uniforms.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uniforms.uRadius, sphereRadius(this.width, this.height, zoom) * this.canvas.width / this.width);
    gl.uniform2f(this.uniforms.uRotation, rotation.yaw, rotation.pitch);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  hitUV(x: number, y: number, rotation: SphereRotation, zoom = 1): SphereUV | null {
    return screenToSphereUV(x, y, this.width, this.height, rotation, zoom);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.deleteTexture(this.texture);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
  }
}
