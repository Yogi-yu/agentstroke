/** Distance travelled along one stroke, independent of its speed or pixel size. */
export const ANIMATED_TRAIL_RETENTION = 0.2;
export const MIN_ANIMATED_TRAIL_RETENTION = 0.2;
export const MAX_ANIMATED_TRAIL_RETENTION = 0.8;
const FADE_DISTANCE = 0.06;
const unit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

export function clampTrailRetention(value: number): number {
  return Number.isFinite(value)
    ? Math.max(MIN_ANIMATED_TRAIL_RETENTION, Math.min(MAX_ANIMATED_TRAIL_RETENTION, value))
    : ANIMATED_TRAIL_RETENTION;
}

/** Keep the feathered rear in the geometry until it has fully disappeared. */
export function animatedTrailStart(progress: number, retention = ANIMATED_TRAIL_RETENTION): number {
  return Math.max(0, unit(progress) - clampTrailRetention(retention) - FADE_DISTANCE);
}

/**
 * No erosion before the selected fraction is drawn (20% by default). A soft front
 * follows the head, fading the oldest pigment first without a threshold pop.
 */
export function animatedTrailOpacity(progress: number, position: number, retention = ANIMATED_TRAIL_RETENTION): number {
  const erasingFront = Math.max(0, unit(progress) - clampTrailRetention(retention));
  const faded = unit((erasingFront - unit(position)) / FADE_DISTANCE);
  return 1 - faded * faded * (3 - 2 * faded);
}
