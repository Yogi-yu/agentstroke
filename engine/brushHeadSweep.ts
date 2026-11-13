import type { BrushHeadProfile } from "@/lib/types";

export interface NibPoint { x: number; y: number }
export interface BrushHeadPose extends NibPoint {
  /** Unit cross-stroke normal; travel is (ny, -nx). */
  nx: number;
  ny: number;
  /** Existing FULL cross-stroke width budget, in CSS pixels. */
  width: number;
  /** Optional material band in normalized nib cross coordinates. */
  low?: number;
  high?: number;
}
/** Exclusive-end polygon ownership for one input pose's incoming sweep + cap. */
export interface BrushHeadSweepRange { start: number; end: number }
export interface SimplifiedBrushHeadPoses {
  poses: BrushHeadPose[];
  /** Original input indices; authored geometry and attribute sampling stay put. */
  indices: number[];
}

const EPSILON = 1e-10;
const MAX_TURN = 0.15;
const ORIGIN: NibPoint = { x: 0, y: 0 };
const finitePoint = (point: NibPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const cross = (a: NibPoint, b: NibPoint, c: NibPoint) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/**
 * Shape and size are separate. One uniform factor establishes a canonical
 * unit-radius outline; its center, concavity and relative radii
 * remain intact. No new random values or pressure/color changes are introduced.
 */
export function normalizeBrushHead(profile: BrushHeadProfile): readonly NibPoint[] {
  const points = (profile.vertices ?? []).map(point => ({
    x: Number.isFinite(point.x) ? point.x : 0,
    y: Number.isFinite(point.y) ? point.y : 0,
  }));
  const radius = points.reduce((largest, point) => Math.max(largest, Math.hypot(point.x, point.y)), 0);
  if (radius <= EPSILON || points.length < 3) {
    // A legacy record with no meaningful outline gets only a tiny connected
    // contact, not a fabricated full-size random brush.
    return [{ x: 0, y: -0.05 }, { x: 0.05, y: 0 }, { x: 0, y: 0.05 }, { x: -0.05, y: 0 }];
  }
  return points.map(point => ({ x: point.x / radius, y: point.y / radius }));
}

function poseNormal(pose: BrushHeadPose): NibPoint {
  const length = Math.hypot(pose.nx, pose.ny);
  return Number.isFinite(length) && length > EPSILON
    ? { x: pose.nx / length, y: pose.ny / length }
    : { x: 0, y: 1 };
}

function crossBounds(vertices: readonly NibPoint[]) {
  let low = Infinity, high = -Infinity;
  for (const point of vertices) {
    if (!Number.isFinite(point.x)) continue;
    low = Math.min(low, point.x);
    high = Math.max(high, point.x);
  }
  if (!Number.isFinite(low)) return { low: -1, high: 1, middle: 0, span: 2 };
  const span = high - low;
  return { low, high, middle: (low + high) / 2, span: span > EPSILON ? span : 2 };
}

/**
 * The actual nib footprint; no stamp changes the authored centerline. Fit its
 * full cross-span to the existing width with a UNIFORM scale, then center that
 * span on the path. The radar origin is transformed along with every vertex,
 * so this placement never distorts a concavity or creates a new fan anchor.
 */
export function placeBrushHead(vertices: readonly NibPoint[], pose: BrushHeadPose, zoom = 1): NibPoint[] {
  const normal = poseNormal(pose);
  const bounds = crossBounds(vertices);
  const scale = (Number.isFinite(pose.width) ? Math.max(0, pose.width) : 0)
    / (bounds.span * (Number.isFinite(zoom) && zoom > EPSILON ? zoom : 1));
  const x = Number.isFinite(pose.x) ? pose.x : 0;
  const y = Number.isFinite(pose.y) ? pose.y : 0;
  return vertices.map(point => ({
    x: x + (normal.x * (point.x - bounds.middle) - normal.y * point.y) * scale,
    y: y + (normal.y * (point.x - bounds.middle) + normal.x * point.y) * scale,
  }));
}

function clipHalfPlane(vertices: readonly NibPoint[], boundary: number, keepAbove: boolean): NibPoint[] {
  if (!vertices.length) return [];
  const result: NibPoint[] = [];
  const inside = (point: NibPoint) => keepAbove ? point.x >= boundary : point.x <= boundary;
  let previous = vertices[vertices.length - 1];
  let previousInside = inside(previous);
  for (const current of vertices) {
    const currentInside = inside(current);
    if (currentInside !== previousInside) {
      const amount = (boundary - previous.x) / (current.x - previous.x);
      result.push({ x: boundary, y: mix(previous.y, current.y, amount) });
    }
    if (currentInside) result.push({ x: current.x, y: current.y });
    previous = current;
    previousInside = currentInside;
  }
  return result;
}

/** Literal x-band clipping, not compression of the entire nib into a stripe. */
export function clipBrushHeadBand(vertices: readonly NibPoint[], low = -Infinity, high = Infinity): NibPoint[] {
  if (Number.isNaN(low) || Number.isNaN(high) || low > high) return [];
  let clipped = vertices.filter(finitePoint).map(point => ({ ...point }));
  if (Number.isFinite(low)) clipped = clipHalfPlane(clipped, low, true);
  if (Number.isFinite(high)) clipped = clipHalfPlane(clipped, high, false);
  return clipped;
}

function signedArea(points: readonly NibPoint[]): number {
  if (points.length < 3) return 0;
  const first = points[0];
  let area = 0;
  for (let index = 1; index < points.length - 1; index++) area += cross(first, points[index], points[index + 1]);
  return area * 0.5;
}

function wound(points: NibPoint[]): NibPoint[] | null {
  const area = signedArea(points);
  if (!Number.isFinite(area) || Math.abs(area) <= EPSILON) return null;
  return area < 0 ? [...points].reverse() : points;
}

/** Tiny (at most eight-point) hull, used only for an individual convex fan. */
function convexHull(points: readonly NibPoint[]): NibPoint[] {
  // Points are immutable prepared geometry; copying each coordinate object
  // here would multiply allocation by every edge and material layer.
  const sorted = points.filter(finitePoint).sort((a, b) => a.x - b.x || a.y - b.y)
    .filter((point, index, all) => !index || Math.hypot(point.x - all[index - 1].x, point.y - all[index - 1].y) > EPSILON);
  if (sorted.length <= 2) return sorted;
  const lower: NibPoint[] = [], upper: NibPoint[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= EPSILON) lower.pop();
    lower.push(point);
  }
  for (let index = sorted.length - 1; index >= 0; index--) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= EPSILON) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function band(pose: BrushHeadPose): { low: number; high: number } {
  return { low: Number.isFinite(pose.low) ? pose.low! : -1, high: Number.isFinite(pose.high) ? pose.high! : 1 };
}

function rotationDelta(a: number, b: number): number {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  // Antipodal travel has no preferred side; choose the same one every replay.
  return Math.abs(Math.abs(delta) - Math.PI) < EPSILON ? Math.PI : delta;
}

/**
 * The shared physical contact interpolation for both the deposited sweep and
 * the visible moving nib. Interpolating normal components would take a
 * different rotation path (and collapse to zero at an exact reversal).
 * Width here is the EFFECTIVE physical width, after material edge coverage.
 */
export function interpolateBrushHeadPose(a: BrushHeadPose, b: BrushHeadPose, fraction: number): BrushHeadPose {
  const t = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  // Preserve prepared endpoint identity and exact coordinates across spans.
  if (t === 0) return a;
  if (t === 1) return b;
  const na = poseNormal(a), nb = poseNormal(b);
  const angle = Math.atan2(na.y, na.x);
  const direction = angle + rotationDelta(angle, Math.atan2(nb.y, nb.x)) * t;
  const ba = band(a), bb = band(b);
  return {
    x: mix(a.x, b.x, t), y: mix(a.y, b.y, t),
    nx: Math.cos(direction), ny: Math.sin(direction),
    width: mix(Number.isFinite(a.width) ? Math.max(0, a.width) : 0,
      Number.isFinite(b.width) ? Math.max(0, b.width) : 0, t),
    low: mix(ba.low, bb.low, t), high: mix(ba.high, bb.high, t),
  };
}

function intermediatePoses(a: BrushHeadPose, b: BrushHeadPose, vertices: readonly NibPoint[], bounds: ReturnType<typeof crossBounds>): BrushHeadPose[] {
  const na = poseNormal(a), nb = poseNormal(b);
  const angle = Math.atan2(na.y, na.x), turn = rotationDelta(angle, Math.atan2(nb.y, nb.x));
  const steps = Math.max(1, Math.ceil(Math.abs(turn) / MAX_TURN));
  const fractions = [0, 1];
  for (let step = 1; step < steps; step++) fractions.push(step / steps);
  const ba = band(a), bb = band(b);
  // A changing material cut can pass a vertex between samples. Include that
  // contact so an appearing/disappearing fan is swept from its actual birth,
  // rather than jumping into a disconnected spot at the following sample.
  for (const side of ["low", "high"] as const) {
    const movement = bb[side] - ba[side];
    if (Math.abs(movement) <= EPSILON) continue;
    for (const point of [ORIGIN, ...vertices]) {
      const normalizedCross = (point.x - bounds.middle) * 2 / bounds.span;
      const fraction = (normalizedCross - ba[side]) / movement;
      if (fraction > EPSILON && fraction < 1 - EPSILON) fractions.push(fraction);
    }
  }
  fractions.sort((x, y) => x - y);
  return fractions.filter((fraction, index) => !index || fraction - fractions[index - 1] > EPSILON)
    .map(fraction => interpolateBrushHeadPose(a, b, fraction));
}

/**
 * Remove only render poses whose actual nib contact is subpixel-equivalent.
 * Unlike centerline-only RDP, this tests EVERY transformed outline vertex,
 * including pressure, angle and the material cut. The authored samples are
 * never edited; returned indices let palette/timing retain their original
 * resolution. Coordinates are compared in CSS pixels, independent of zoom.
 */
export function simplifyBrushHeadPoses(
  poses: readonly BrushHeadPose[], vertices: readonly NibPoint[], zoom = 1,
): SimplifiedBrushHeadPoses {
  const unchanged = () => ({ poses: [...poses], indices: poses.map((_, index) => index) });
  if (poses.length < 3 || vertices.length < 3 || !vertices.every(finitePoint)) return unchanged();
  const ratio = Number.isFinite(zoom) && zoom > EPSILON ? zoom : 1;
  const bounds = crossBounds(vertices);
  const keep = new Uint8Array(poses.length);
  const distances = new Float64Array(poses.length);
  const normal = poses.map(poseNormal);
  const angles = normal.map(value => Math.atan2(value.y, value.x));
  const bands = poses.map(band);
  const widths = poses.map(pose => Number.isFinite(pose.width) ? Math.max(0, pose.width) : 0);
  const local = vertices.map(point => ({ x: (point.x - bounds.middle) / bounds.span, y: point.y / bounds.span }));
  const locations = poses.map((pose, index) => {
    return local.map(point => ({
      x: pose.x * ratio + (normal[index].x * point.x - normal[index].y * point.y) * widths[index],
      y: pose.y * ratio + (normal[index].y * point.x + normal[index].x * point.y) * widths[index],
    }));
  });
  keep[0] = keep[poses.length - 1] = 1;
  for (let index = 1; index < poses.length; index++) {
    const a = poses[index - 1], b = poses[index];
    const distance = Math.hypot(b.x - a.x, b.y - a.y) * ratio;
    distances[index] = distances[index - 1] + (Number.isFinite(distance) ? distance : 0);
    // A stationary contact can still rotate, press or change material. Never
    // elide it, bridge a bad record, or smooth away a sharp nib turn.
    if (!finitePoint(a) || !finitePoint(b) || distance <= EPSILON
      || Math.abs(rotationDelta(angles[index - 1], angles[index])) > MAX_TURN) {
      keep[index - 1] = keep[index] = 1;
    }
    if (index < poses.length - 1) {
      const c = poses[index + 1];
      const ax = b.x - a.x, ay = b.y - a.y, bx = c.x - b.x, by = c.y - b.y;
      if (Math.hypot(ax, ay) > EPSILON && Math.hypot(bx, by) > EPSILON
        && Math.atan2(Math.abs(ax * by - ay * bx), ax * bx + ay * by) > MAX_TURN) keep[index] = 1;
    }
  }
  const intervals: [number, number][] = [];
  let anchor = 0;
  for (let index = 1; index < poses.length; index++) if (keep[index]) {
    if (index - anchor > 1) intervals.push([anchor, index]);
    anchor = index;
  }
  // Small guard below the public budgets absorbs floating-point boundary
  // comparisons while maintaining <= 0.08 px contact / <= 0.04 px cut error.
  const contactBudget = 0.079;
  const cutBudget = 0.039;
  const contactBudget2 = contactBudget * contactBudget;
  const cutBudget2 = cutBudget * cutBudget;
  while (intervals.length) {
    const [first, last] = intervals.pop()!;
    const a = poses[first], b = poses[last];
    const travelled = distances[last] - distances[first];
    if (travelled <= EPSILON || !finitePoint(a) || !finitePoint(b)
      || Math.hypot(b.x - a.x, b.y - a.y) * ratio <= EPSILON) {
      for (let index = first + 1; index < last; index++) keep[index] = 1;
      continue;
    }
    const turn = rotationDelta(angles[first], angles[last]);
    let worst = 1, split = -1;
    for (let index = first + 1; index < last; index++) {
      const fraction = (distances[index] - distances[first]) / travelled;
      const heading = angles[first] + turn * fraction;
      const nx = Math.cos(heading), ny = Math.sin(heading);
      const width = mix(widths[first], widths[last], fraction);
      const x = mix(a.x, b.x, fraction) * ratio, y = mix(a.y, b.y, fraction) * ratio;
      let error = 0;
      for (let vertex = 0; vertex < vertices.length; vertex++) {
        const point = local[vertex], actual = locations[index][vertex];
        const dx = actual.x - x - (nx * point.x - ny * point.y) * width;
        const dy = actual.y - y - (ny * point.x + nx * point.y) * width;
        error = Math.max(error, (dx * dx + dy * dy) / contactBudget2);
      }
      // Cut fractions belong to the same full physical width. A changing cut
      // cannot hide behind a centerline/outline that otherwise looks constant.
      for (const side of ["low", "high"] as const) {
        const expected = mix(bands[first][side], bands[last][side], fraction);
        const displacement = Math.abs(bands[index][side] - expected) * Math.max(widths[index], width) / 2;
        error = Math.max(error, displacement * displacement / cutBudget2);
      }
      if (!Number.isFinite(error)) error = Infinity;
      if (error > worst) { worst = error; split = index; }
    }
    if (split >= 0) {
      keep[split] = 1;
      if (split - first > 1) intervals.push([first, split]);
      if (last - split > 1) intervals.push([split, last]);
    }
  }
  const indices: number[] = [];
  for (let index = 0; index < poses.length; index++) if (keep[index]) indices.push(index);
  return { poses: indices.map(index => poses[index]), indices };
}

/**
 * One continuous footprint union, suitable for a SINGLE nonzero fill/clip.
 * Each original center/edge triangle is swept independently: a hull of the
 * entire nib would erase its concave notches. Translation and uniform width
 * changes need no stamp-spacing approximation; only changing heading is
 * subdivided. No alpha/color is deposited here, so overlap cannot brighten ink.
 */
export function buildBrushHeadSweep(
  poses: readonly BrushHeadPose[], vertices: readonly NibPoint[], zoom = 1,
  ranges?: BrushHeadSweepRange[],
): NibPoint[][] {
  const outline = vertices.filter(finitePoint);
  if (ranges) ranges.length = 0;
  if (outline.length < 3 || !poses.length) {
    if (ranges) for (let index = 0; index < poses.length; index++) ranges.push({ start: 0, end: 0 });
    return [];
  }
  const bounds = crossBounds(outline);
  const fans = outline.map((point, index) => [ORIGIN, point, outline[(index + 1) % outline.length]]);
  const polygons: NibPoint[][] = [];
  const append = (points: NibPoint[]) => { const polygon = wound(points); if (polygon) polygons.push(polygon); };
  interface PreparedPose {
    normal: NibPoint;
    full: boolean;
    outline: NibPoint[];
    fans: NibPoint[][];
  }
  const preparedPoses = new Map<BrushHeadPose, PreparedPose>();
  const clippedFans = new Map<string, NibPoint[][]>();
  const safeZoom = Number.isFinite(zoom) && zoom > EPSILON ? zoom : 1;
  const prepare = (pose: BrushHeadPose): PreparedPose => {
    const cached = preparedPoses.get(pose);
    if (cached) return cached;
    const fraction = band(pose), normal = poseNormal(pose);
    // Material bands describe fractions of the EXISTING full physical width,
    // not absolute x values on an asymmetric attribute polygon.
    const low = bounds.middle + fraction.low * bounds.span / 2;
    const high = bounds.middle + fraction.high * bounds.span / 2;
    const full = low <= bounds.low + EPSILON && high >= bounds.high - EPSILON;
    let localFans = fans;
    if (!full) {
      const key = `${low}:${high}`;
      let clipped = clippedFans.get(key);
      if (!clipped) {
        clipped = fans.map(fan => clipBrushHeadBand(fan, low, high));
        clippedFans.set(key, clipped);
      }
      localFans = clipped;
    }
    const scale = (Number.isFinite(pose.width) ? Math.max(0, pose.width) : 0) / (bounds.span * safeZoom);
    // A full nib's fan triangles share their center and two neighboring
    // vertices. Transform each coordinate once, not once per fan per segment.
    const placed = new Map<NibPoint, NibPoint>();
    const place = (point: NibPoint) => {
      let result = placed.get(point);
      if (!result) {
        result = {
          x: pose.x + (normal.x * (point.x - bounds.middle) - normal.y * point.y) * scale,
          y: pose.y + (normal.y * (point.x - bounds.middle) + normal.x * point.y) * scale,
        };
        placed.set(point, result);
      }
      return result;
    };
    const result = { normal, full, outline: full ? outline.map(place) : [], fans: localFans.map(fan => fan.map(place)) };
    preparedPoses.set(pose, result);
    return result;
  };
  const appendCap = (pose: BrushHeadPose) => {
    const prepared = prepare(pose);
    if (prepared.full) append(prepared.outline);
    else for (const fan of prepared.fans) append(fan);
  };
  let previous: BrushHeadPose | null = null;
  for (const pose of poses) {
    const rangeStart = polygons.length;
    // Invalid authored coordinates never produce a bridge across missing data.
    if (!finitePoint(pose)) {
      previous = null;
      ranges?.push({ start: rangeStart, end: polygons.length });
      continue;
    }
    if (!previous) appendCap(pose);
    else {
      const interval = intermediatePoses(previous, pose, outline, bounds);
      for (let step = 1; step < interval.length; step++) {
        const a = prepare(interval[step - 1]), b = prepare(interval[step]);
        if (a.full && b.full && Math.abs(a.normal.x - b.normal.x) < 1e-9 && Math.abs(a.normal.y - b.normal.y) < 1e-9) {
          // Exact translation / positive uniform scale: the caps plus swept
          // boundary trapezoids are the true union. No triangle hulls needed,
          // and concave vertices are not replaced by a whole-nib convex hull.
          for (let edge = 0; edge < outline.length; edge++) {
            const next = (edge + 1) % outline.length;
            append([a.outline[edge], a.outline[next], b.outline[next], b.outline[edge]]);
          }
        } else {
          for (let fan = 0; fan < fans.length; fan++) append(convexHull([...a.fans[fan], ...b.fans[fan]]));
        }
      }
      appendCap(pose);
    }
    previous = pose;
    ranges?.push({ start: rangeStart, end: polygons.length });
  }
  return polygons;
}

export interface BrushHeadPathContext {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
}

/** Does not begin, fill or reset the caller's material path/compositing state. */
export function appendBrushHeadSweep(context: BrushHeadPathContext, polygons: readonly (readonly NibPoint[])[]): void {
  for (const polygon of polygons) {
    if (polygon.length < 3) continue;
    context.moveTo(polygon[0].x, polygon[0].y);
    for (let index = 1; index < polygon.length; index++) context.lineTo(polygon[index].x, polygon[index].y);
    context.closePath();
  }
}
