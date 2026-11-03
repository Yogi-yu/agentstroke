export const MIN_MOTION_SPEED = 0.25;
export const MAX_MOTION_SPEED = 3;
export const DEFAULT_MOTION_SPEED = 1;

export interface SphereViewControls {
  autoRotate: boolean;
  playing: boolean;
  /** Changing the camera must not restart any artwork's independent clock. */
  resetKey: number;
}
export const DEFAULT_SPHERE_CONTROLS: Readonly<SphereViewControls> = { autoRotate: true, playing: true, resetKey: 0 };

export function clampMotionSpeed(value: number): number {
  return Number.isFinite(value) ? Math.max(MIN_MOTION_SPEED, Math.min(MAX_MOTION_SPEED, value)) : DEFAULT_MOTION_SPEED;
}

/** Apply the live multiplier only to future elapsed time: never seek/restart. */
export function scaledMotionDelta(deltaMs: number, speed: number): number {
  return (Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0) * clampMotionSpeed(speed);
}

export function motionSpeedLabel(speed: number): string {
  return `${Number(clampMotionSpeed(speed).toFixed(2))}×`;
}
