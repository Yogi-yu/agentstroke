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
layout(location=10) in vec4 aVisual;   // widthRatio, primaryHead, headCount, brushStyle

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
out vec3 vHead;
out vec2 vSegRange;

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
  float sideCssPx = min(uResolution.x, uResolution.y) / uDpr;
  float signatureWidth = clamp(aVisual.x, 0.0, 0.008) * sideCssPx;
  float displayWidth = clamp(7.0 + signatureWidth * 0.5, 7.0, 10.0);
  float brushStyle = aVisual.w;
  float styleWidth = brushStyle < 0.5 ? 0.72 : (brushStyle < 1.5 ? 1.0 : (brushStyle < 2.5 ? 1.28 : 1.08));
  displayWidth *= styleWidth;
  // Brush pressure: pointed pickup/release, semantic width variation through
  // the body, and unequal segment endpoints instead of a uniform tube.
  float envelopeS = pow(max(0.0, sin(3.14159265 * aSeg.x)), 0.7);
  float envelopeE = pow(max(0.0, sin(3.14159265 * aSeg.y)), 0.7);
  float gestureS = 0.68 + 0.32 * (0.5 + 0.5 * sin(aSeg.x * 9.42477796 + aMeta.x * 4.0));
  float gestureE = 0.68 + 0.32 * (0.5 + 0.5 * sin(aSeg.y * 9.42477796 + aMeta.x * 4.0));
  float pressureS = brushStyle < 0.5 ? 0.5 + envelopeS * 0.5 : (brushStyle < 1.5 ? 0.1 + envelopeS * 0.9 : (brushStyle < 2.5 ? 0.28 + envelopeS * 0.72 : (0.08 + envelopeS * 0.92) * gestureS));
  float pressureE = brushStyle < 0.5 ? 0.5 + envelopeE * 0.5 : (brushStyle < 1.5 ? 0.1 + envelopeE * 0.9 : (brushStyle < 2.5 ? 0.28 + envelopeE * 0.72 : (0.08 + envelopeE * 0.92) * gestureE));
  float widthSignalS = pow(clamp(aWidth.x / 6.0, 0.0, 1.0), 1.18);
  float widthSignalE = pow(clamp(aWidth.y / 6.0, 0.0, 1.0), 1.18);
  float semanticS = brushStyle < 0.5 ? mix(0.72, 1.15, widthSignalS) : (brushStyle < 1.5 ? mix(0.35, 1.65, widthSignalS) : (brushStyle < 2.5 ? mix(0.72, 1.38, widthSignalS) : mix(0.3, 1.8, widthSignalS)));
  float semanticE = brushStyle < 0.5 ? mix(0.72, 1.15, widthSignalE) : (brushStyle < 1.5 ? mix(0.35, 1.65, widthSignalE) : (brushStyle < 2.5 ? mix(0.72, 1.38, widthSignalE) : mix(0.3, 1.8, widthSignalE)));
  float ewS = clamp(displayWidth * pressureS * semanticS, 0.65, 18.0);
  float ewE = clamp(displayWidth * pressureE * semanticE, 0.65, 18.0);
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
  vHead = aVisual.yzw;
  vSegRange = aSeg;

  // comet pulse traveling the path — bright head + trailing tail (motion blur)
  float seg01 = mix(aSeg.x, aSeg.y, aCorner.x);
  // One coherent brush head per complete stroke. Segment-local speed affects
  // deposition below, but must not create a separate head on every segment.
  float head = fract(uTime * 0.07 + aAnim.x);
  float dist = seg01 - head;
  dist = dist - floor(dist + 0.5); // wrap to [-0.5,0.5]
  float tail = 0.18;
  float lead = 0.05;
  float p = (dist <= 0.0)
    ? exp(-(dist * dist) / (2.0 * tail * tail))
    : exp(-(dist * dist) / (2.0 * lead * lead));
  vPulse = p * mix(0.82, 1.12, clamp(aAnim.y / 2.0, 0.0, 1.0));

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
in vec3 vHead;
in vec2 vSegRange;

uniform float uContribution; // per-frame additive contribution (1 - decay)

out vec4 frag;

void main() {
  float entropy = vMeta.x;
  float confidence = vMeta.y;
  float intensity = vMeta.z;
  float brushStyle = vHead.z;

  // capsule SDF: distance from the segment core line
  float t = clamp(vLocal.x / max(vLen, 0.0001), 0.0, 1.0);
  float hw = max(mix(vHW.x, vHW.y, t), 0.5);
  // Only the complete stroke owns start/end caps. Internal instanced segments
  // meet as capless strips, preventing a row of overlapping circular blobs.
  float capDx = 0.0;
  if (vLocal.x < 0.0) {
    if (vSegRange.x <= 0.0001) capDx = -vLocal.x;
    else { capDx = -vLocal.x; if (capDx > 1.0) discard; }
  } else if (vLocal.x > vLen) {
    if (vSegRange.y >= 0.9999) capDx = vLocal.x - vLen;
    else { capDx = vLocal.x - vLen; if (capDx > 1.0) discard; }
  }
  float dCore = length(vec2(capDx, vLocal.y));
  // A hard nib terminates as a cut edge. The other tools retain a rounded,
  // pressure-shaped pickup and release.
  if (brushStyle < 0.5) {
    if (vSegRange.x <= 0.0001 && vLocal.x < -hw * 0.12) discard;
    if (vSegRange.y >= 0.9999 && vLocal.x > vLen + hw * 0.12) discard;
    dCore = abs(vLocal.y);
  }

  // entropy → edge softness; confidence → brightness; intensity → opacity + glow
  float soft = brushStyle < 0.5
    ? 0.16 + entropy * 0.35
    : (brushStyle < 1.5 ? 0.75 + entropy * 1.35 : (brushStyle < 2.5 ? 1.8 + entropy * 2.3 : 0.38 + entropy * 1.15));
  float fiberNoise = 0.5 + 0.5 * sin(vLocal.x * 0.055 + vLocal.y * 2.35 + entropy * 17.0);
  float coarseGrain = 0.5 + 0.5 * sin(vLocal.x * 0.19 + sin(vLocal.y * 1.73) * 3.1 + intensity * 29.0);
  float textureGain = brushStyle < 0.5 ? 0.08 : (brushStyle < 1.5 ? 0.25 : (brushStyle < 2.5 ? 0.18 : 1.0));
  float edgeWobble = (mix(fiberNoise, coarseGrain, brushStyle > 2.5 ? 0.72 : 0.0) - 0.5)
    * (0.35 + entropy * 1.35) * textureGain;
  float core = 1.0 - smoothstep(hw - soft + edgeWobble, hw + soft * 0.5 + edgeWobble, dCore);
  float glowR = hw + (brushStyle < 0.5 ? 0.35 : (brushStyle < 1.5 ? 0.9 : (brushStyle < 2.5 ? 3.4 : 0.65))) + intensity;
  float glowStrength = brushStyle < 0.5 ? 0.012 : (brushStyle < 1.5 ? 0.045 : (brushStyle < 2.5 ? 0.16 : 0.025));
  float glow = (1.0 - smoothstep(hw, glowR, dCore)) * glowStrength;

  float shape = max(core, glow * 0.7);

  // Moving brush head. A stroke can combine up to three primitives; the first
  // and second are encoded explicitly and the third becomes an organic echo.
  float across = abs(vLocal.y) / max(hw, 0.5);
  float primary = vHead.x;
  float headShape = 1.0 - smoothstep(0.62, 1.12, across); // round
  if (primary > 0.5 && primary < 1.5) headShape = 1.0 - step(1.0, across); // square
  else if (primary > 1.5 && primary < 2.5) headShape = 1.0 - smoothstep(0.35, 1.0, across); // diamond
  else if (primary > 2.5 && primary < 3.5) headShape = 1.0 - smoothstep(0.18, 0.92, across); // triangle
  else if (primary > 3.5 && primary < 4.5) headShape = smoothstep(0.32, 0.55, across) * (1.0 - smoothstep(0.78, 1.0, across)); // ring
  else if (primary > 4.5) headShape = 1.0 - smoothstep(0.55 + 0.18 * sin(vLocal.y * 1.7), 1.08, across); // organic
  if (vHead.y > 1.5) {
    float echo = 1.0 - smoothstep(0.2, 0.72, abs(across - 0.48));
    headShape = max(headShape, echo * 0.7);
  }
  if (vHead.y > 2.5) headShape = max(headShape, (1.0 - smoothstep(0.12, 0.38, across)) * 0.8);
  float movingHead = pow(clamp(vPulse, 0.0, 1.0), 5.0) * headShape;
  shape = max(shape, movingHead);
  if (shape <= 0.002) discard;

  float bright = 0.52 + confidence * 0.48;
  float pulseBoost = 1.0 + vPulse * 0.38;
  float ageFade = 0.18 + vAge * 0.82;
  float selBoost = 1.0 + vSel * 0.32;

  float fiberFine = 0.5 + 0.5 * sin(vLocal.y * 6.7 - vLocal.x * 0.023 + confidence * 13.0);
  // A continuous ink body with restrained fibre loss. Texture modulates the
  // pigment but never splits one gesture into several parallel lines.
  float edge01 = clamp(dCore / max(hw, 0.5), 0.0, 1.0);
  float material = brushStyle < 0.5
    ? 0.98
    : (brushStyle < 1.5
      ? 0.9 + fiberNoise * 0.1
      : (brushStyle < 2.5
        // Watercolour stays light through the belly and deposits pigment at
        // both wet edges, producing a characteristic tide line.
        ? 0.76 + smoothstep(0.48, 0.92, edge01) * 0.38
        // A texture nib drags two scales of directional grain through the ink.
        : 0.48 + fiberNoise * 0.24 + fiberFine * 0.12 + coarseGrain * 0.22));
  vec3 col = vColor * material * bright * pulseBoost * selBoost;
  // All tools share the same opacity law. Their identity comes from geometry,
  // edge behaviour and pigment deposition—not transparency presets.
  float alpha = shape * mix(0.88, 1.0, confidence) * ageFade * vAgentDim;
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
  vBright = aStar.y * (0.78 + 0.22 * sin(uTime * 0.0007 + aStar.z));
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
  vec2 skyPoint = (vUV - vec2(0.53, 0.55)) * vec2(1.0, 1.6);
  float atmosphere = exp(-dot(skyPoint, skyPoint) * 3.5);
  vec3 sky = mix(vec3(0.002, 0.004, 0.012), vec3(0.010, 0.020, 0.040), atmosphere);
  // uScale is zero in the clear pass, so the atmosphere never accumulates.
  vec3 c = (texture(uTex, vUV).rgb + sky) * uScale;
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
