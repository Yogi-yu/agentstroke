// ============================================================================
// Stroke Geometry — typed-array packing format for instanced rendering.
// ----------------------------------------------------------------------------
// One GPU instance == one stroke segment. All per-instance data lives in a
// single interleaved Float32Array so every segment draws in one instanced call.
// Selection/hit-testing is handled on the CPU by the spatial hitmap, so no
// GPU pick channel is needed — only a `strokeIdx` for whole-stroke glow.
// ============================================================================

export const FLOATS_PER_INSTANCE = 19;
export const STRIDE_BYTES = FLOATS_PER_INSTANCE * 4;

// float offsets within one instance record (keep in sync with the shader).
export const OFF = {
  start: 0, // vec2 normalized 0..1
  end: 2, // vec2
  width: 4, // vec2 px (start,end)
  color: 6, // vec3 rgb 0..1
  meta: 9, // vec3 entropy,confidence,intensity
  seg: 12, // vec2 seg01 start,end (position along path)
  anim: 14, // vec3 phase, speed, age01
  agentIdx: 17, // float
  strokeIdx: 18, // float (whole-stroke selection key)
} as const;

// Per-vertex base quad: x = along (0..1), y = across (-1..1). Two triangles.
export const QUAD_VERTS = new Float32Array([
  0, -1, 1, -1, 1, 1,
  0, -1, 1, 1, 0, 1,
]);

/** HSL (h 0..360) → rgb in 0..1, suitable for additive blending. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const k = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [k(hue + 1 / 3), k(hue), k(hue - 1 / 3)];
}
