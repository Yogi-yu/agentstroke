// ============================================================================
// GLSL shader sources (WebGL2 / GLSL ES 3.00) + compile helpers.
// ----------------------------------------------------------------------------
//   Stroke pass : instanced thick-line quads with capsule SDF, glow, comet
//                 pulse (motion), temporal age-fade, additive blending.
//   Pick pass   : same geometry rendered as flat unique IDs for color-picking.
//   Star pass   : twinkling background starfield points.
// ============================================================================

// --- Stroke vertex -----------------------------------------------------------
export const STROKE_VERT = /* glsl */ `#version 300 es
precision highp float;

layout(location=0) in vec2 aCorner;   // base quad: x=along 0..1, y=across -1..1
layout(location=1) in vec2 aStart;    // normalized 0..1
layout(location=2) in vec2 aEnd;
layout(location=3) in vec2 aWidth;     // px: start,end
layout(location=4) in vec3 aColor;
layout(location=5) in vec3 aMeta;      // entropy,confidence,intensity
layout(location=6) in vec2 aSeg;       // seg01 start,end
layout(location=7) in vec3 aAnim;      // phase,speed,age01
layout(location=8) in float aAgentIdx;
layout(location=9) in float aStrokeIdx;

uniform vec2 uResolution;
uniform float uTime;
uniform float uDpr;
uniform float uWidthScale;       // nonlinear width emphasis
uniform float uFocusStroke;      // -1 = none; else strokeIdx — Stroke Focus Mode
uniform float uFilterAgent;      // -1 = none; else agentIdx — Agent Filter Mode
uniform float uViewScale;        // Edit Mode zoom (1.0 = no zoom)
uniform vec2 uViewTranslate;     // Edit Mode pan (normalized units)

out vec2 vLocal;   // along px, across px
out float vLen;
out vec2 vHW;      // half width start,end
out vec3 vColor;
out vec3 vMeta;
out float vAge;
out float vPulse;
out float vSel;
out float vAgentDim;

void main() {
  // Edit Mode view transform: screen = world * scale + translate. World position
  // (aStart/aEnd) is the source of truth; this only changes where it is drawn.
  vec2 vStart = aStart * uViewScale + uViewTranslate;
  vec2 vEnd = aEnd * uViewScale + uViewTranslate;
  vec2 sPx = vStart * uResolution;
  vec2 ePx = vEnd * uResolution;
  vec2 d = ePx - sPx;
  float len = max(length(d), 0.0001);
  vec2 dir = d / len;
  vec2 nrm = vec2(-dir.y, dir.x);

  // nonlinear emphasis: width = pow(raw, 1.5) * scale, with a min visible width.
  // Half-widths scale with the view so zoom reads as a true optical zoom.
  float ewS = max(pow(aWidth.x, 1.5) * uWidthScale, 1.2);
  float ewE = max(pow(aWidth.y, 1.5) * uWidthScale, 1.2);
  float hwS = ewS * 0.5 * uDpr * uViewScale;
  float hwE = ewE * 0.5 * uDpr * uViewScale;
  float maxHW = max(hwS, hwE) + 6.0 * uDpr; // pad for glow + caps

  float alongPx = mix(-maxHW, len + maxHW, aCorner.x);
  float acrossPx = aCorner.y * maxHW;
  vec2 posPx = sPx + dir * alongPx + nrm * acrossPx;

  vec2 clip = posPx / uResolution * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);

  vLocal = vec2(alongPx, acrossPx);
  vLen = len;
  vHW = vec2(hwS, hwE);
  vColor = aColor;
  vMeta = aMeta;
  vAge = aAnim.z;

  // comet pulse traveling the path — bright head + trailing tail (motion blur)
  float seg01 = mix(aSeg.x, aSeg.y, aCorner.x);
  float head = fract(uTime * aAnim.y * 0.12 + aAnim.x);
  float dist = seg01 - head;
  dist = dist - floor(dist + 0.5); // wrap to [-0.5,0.5]
  float tail = 0.18;
  float lead = 0.05;
  float p = (dist <= 0.0)
    ? exp(-(dist * dist) / (2.0 * tail * tail))
    : exp(-(dist * dist) / (2.0 * lead * lead));
  vPulse = p;

  vSel = (uFocusStroke >= 0.0 && abs(aStrokeIdx - uFocusStroke) < 0.5) ? 1.0 : 0.0;
  vAgentDim = 1.0;

  // ---- visibility (layered perception modes), priority: focus > filter > all
  // A culled instance is moved outside clip space → fully clipped, so NO
  // fragments are rasterized (no GPU fill cost). Geometry/buffers are untouched;
  // switching modes only changes these two uniforms.
  float visible = 1.0;
  if (uFocusStroke >= 0.0) {
    visible = (abs(aStrokeIdx - uFocusStroke) < 0.5) ? 1.0 : 0.0;
  } else if (uFilterAgent >= 0.0) {
    visible = (abs(aAgentIdx - uFilterAgent) < 0.5) ? 1.0 : 0.0;
  }
  if (visible < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off-clip → culled, no fragments
  }
}
`;

// --- Stroke fragment ---------------------------------------------------------
export const STROKE_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vLocal;
in float vLen;
in vec2 vHW;
in vec3 vColor;
in vec3 vMeta;
in float vAge;
in float vPulse;
in float vSel;
in float vAgentDim;

uniform float uContribution; // per-frame additive contribution (1 - decay)

out vec4 frag;

void main() {
  float entropy = vMeta.x;
  float confidence = vMeta.y;
  float intensity = vMeta.z;

  // capsule SDF: distance from the segment core line
  float t = clamp(vLocal.x / max(vLen, 0.0001), 0.0, 1.0);
  float hw = max(mix(vHW.x, vHW.y, t), 0.5);
  float cx = clamp(vLocal.x, 0.0, vLen);
  float dCore = length(vec2(vLocal.x - cx, vLocal.y));

  // entropy → edge softness; confidence → brightness; intensity → opacity + glow
  float soft = 0.6 + entropy * 3.5;
  float core = 1.0 - smoothstep(hw - soft, hw + soft * 0.5, dCore);
  float glowR = hw + 2.0 + intensity * 11.0;
  float glow = (1.0 - smoothstep(hw, glowR, dCore)) * (0.12 + intensity * 0.5);

  float shape = max(core, glow * 0.7);
  if (shape <= 0.002) discard;

  float bright = 0.45 + confidence * 0.75;
  float pulseBoost = 1.0 + vPulse * 2.6;
  float ageFade = 0.18 + vAge * 0.82;
  float selBoost = 1.0 + vSel * 1.1;

  vec3 col = vColor * bright * pulseBoost * selBoost;
  float alpha = shape * (0.25 + intensity * 0.75) * ageFade * vAgentDim;
  alpha = clamp(alpha, 0.0, 1.0);

  // premultiplied additive, scaled by per-frame contribution so the feedback
  // buffer settles to the intended value: v = lerp(prev, target, uContribution)
  frag = vec4(col * alpha, alpha) * uContribution;
}
`;

// (Pick pass removed — selection/hit-testing is now CPU-side via StrokeHitmap.)

// --- Star pass ---------------------------------------------------------------
export const STAR_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;   // normalized 0..1
layout(location=1) in vec3 aStar;  // size, baseBrightness, twinklePhase
uniform vec2 uResolution;
uniform float uTime;
uniform float uDpr;
out float vBright;
void main() {
  vec2 clip = aPos * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = aStar.x * uDpr;
  vBright = aStar.y * (0.6 + 0.4 * sin(uTime * 0.0012 + aStar.z));
}
`;

export const STAR_FRAG = /* glsl */ `#version 300 es
precision highp float;
in float vBright;
uniform float uContribution;
out vec4 frag;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = dot(uv, uv);
  float a = (1.0 - smoothstep(0.0, 1.0, d)) * vBright;
  if (a <= 0.001) discard;
  vec3 col = vec3(0.6, 0.72, 1.0) * a;
  frag = vec4(col, a) * uContribution;
}
`;

// --- present / feedback pass (fullscreen, attribute-less) --------------------
export const PRESENT_VERT = /* glsl */ `#version 300 es
precision highp float;
out vec2 vUV;
void main() {
  vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  vUV = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

export const PRESENT_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uScale; // decay (fade pass) or 1.0 (copy to screen)
out vec4 frag;
void main() {
  vec3 c = texture(uTex, vUV).rgb * uScale;
  frag = vec4(c, 1.0);
}
`;

// --- compile helpers ---------------------------------------------------------
export function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}\n${src}`);
  }
  return sh;
}

export function linkProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    throw new Error(`program link failed: ${log}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}
