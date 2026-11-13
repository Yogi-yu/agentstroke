export interface MeteorCenterlinePoint { x: number; y: number }

/**
 * Densify the original ordered polyline without rounding or cutting corners.
 * Every surviving control vertex remains exact. At most 256 additional
 * arc-spaced samples provide pressure/material detail without discarding a
 * turn to meet a sample cap. Callers must use cumulative travelled distance,
 * not sample index, because retained corners make sample spacing nonuniform.
 *
 * The sharpness argument remains source-compatible; a rendering pass must
 * not move an already-authored route to implement an aesthetic preference.
 */
export function sampleMeteorCenterline(
  controls: readonly MeteorCenterlinePoint[],
  width: number,
  height: number,
  _sharpness = 0,
): { points: MeteorCenterlinePoint[]; length: number } {
  const source: MeteorCenterlinePoint[] = [];
  for (const control of controls) {
    if (!Number.isFinite(control.x) || !Number.isFinite(control.y)) continue;
    const point = { x: control.x * width, y: control.y * height };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const last = source[source.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 0.0001) source.push(point);
  }
  if (source.length < 2) return { points: source, length: 0 };

  const distances = [0];
  for (let index = 1; index < source.length; index++) {
    const a = source[index - 1], b = source[index];
    distances.push(distances[index - 1] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const length = distances[distances.length - 1];
  if (!Number.isFinite(length) || length < 0.0001) return { points: [source[0]], length: 0 };

  const segments = Math.max(32, Math.min(256, Math.ceil(length / 2.5)));
  const points = [source[0]];
  let cursor = 1;
  for (let index = 1; index < segments; index++) {
    const distance = index / segments * length;
    // Merge source vertices into the uniform arc grid rather than replacing
    // them: otherwise two samples straddling a turn would form a shortcut.
    while (cursor < source.length && distances[cursor] <= distance) points.push(source[cursor++]);
    if (cursor >= source.length) break;
    if (distance - distances[cursor - 1] <= 1e-10) continue;
    const a = source[cursor - 1], b = source[cursor];
    const local = (distance - distances[cursor - 1]) / (distances[cursor] - distances[cursor - 1]);
    points.push({ x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local });
  }
  while (cursor < source.length) points.push(source[cursor++]);
  return { points, length };
}
