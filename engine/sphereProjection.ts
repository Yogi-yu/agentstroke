/**
 * Display-only orthographic globe coordinates. Every artwork point is sampled
 * on a unit sphere, never interpolated as a straight 3D chord through its body.
 * Canvas/atlas y points down; world y points up; the camera sees positive z.
 */
export interface SpherePoint { x: number; y: number; z: number }
export interface SphereRotation { yaw: number; pitch: number }
export interface SphereUV { u: number; v: number }
// Default diameter fills 94% of the available drawing area. The viewport's
// controls live outside that area, so the entire silhouette remains visible.
export const SPHERE_RADIUS_RATIO = 0.47;
export const MIN_SPHERE_ZOOM = 0.75;
export const MAX_SPHERE_ZOOM = 1.35;

export function clampSphereZoom(zoom = 1): number {
  return Number.isFinite(zoom) ? Math.max(MIN_SPHERE_ZOOM, Math.min(MAX_SPHERE_ZOOM, zoom)) : 1;
}

export function sphereRadius(width: number, height: number, zoom = 1): number {
  return Math.max(1, Math.min(width, height)) * SPHERE_RADIUS_RATIO * clampSphereZoom(zoom);
}

/** u is periodic: a seam crossing lands at the same surface point. */
export function spherePointFromUV(u: number, v: number): SpherePoint {
  const longitude = (u - 0.5) * Math.PI * 2;
  const latitude = (0.5 - Math.max(0, Math.min(1, v))) * Math.PI;
  const ring = Math.cos(latitude);
  return { x: Math.sin(longitude) * ring, y: Math.sin(latitude), z: Math.cos(longitude) * ring };
}

/** Local longitude rotation, followed by camera-relative latitude rotation. */
export function rotateSpherePoint(point: SpherePoint, rotation: SphereRotation): SpherePoint {
  const sy = Math.sin(rotation.yaw), cy = Math.cos(rotation.yaw);
  const sp = Math.sin(rotation.pitch), cp = Math.cos(rotation.pitch);
  const x = cy * point.x + sy * point.z;
  const z = -sy * point.x + cy * point.z;
  return { x, y: cp * point.y - sp * z, z: sp * point.y + cp * z };
}

export function unrotateSpherePoint(point: SpherePoint, rotation: SphereRotation): SpherePoint {
  const sy = Math.sin(rotation.yaw), cy = Math.cos(rotation.yaw);
  const sp = Math.sin(rotation.pitch), cp = Math.cos(rotation.pitch);
  const y = cp * point.y + sp * point.z;
  const z = -sp * point.y + cp * point.z;
  return { x: cy * point.x - sy * z, y, z: sy * point.x + cy * z };
}

export function sphereUVFromPoint(point: SpherePoint): SphereUV {
  const radius = Math.hypot(point.x, point.y, point.z);
  if (radius < 1e-12) return { u: 0.5, v: 0.5 };
  const u = Math.atan2(point.x, point.z) / (Math.PI * 2) + 0.5;
  return { u: ((u % 1) + 1) % 1, v: 0.5 - Math.asin(Math.max(-1, Math.min(1, point.y / radius))) / Math.PI };
}

/** Back-side points have no visible screen projection: the globe is opaque. */
export function projectSphereUV(
  uv: SphereUV, rotation: SphereRotation, width: number, height: number, zoom = 1,
): { x: number; y: number; z: number } | null {
  const point = rotateSpherePoint(spherePointFromUV(uv.u, uv.v), rotation);
  if (point.z < -1e-10) return null;
  const radius = sphereRadius(width, height, zoom);
  return { x: width * 0.5 + point.x * radius, y: height * 0.5 - point.y * radius, z: point.z };
}

/**
 * Ray/sphere intersection uses ONLY the nearer surface (+sqrt). It cannot hit
 * a stroke on the hidden hemisphere, or any imaginary path through the centre.
 */
export function screenToSphereUV(
  x: number, y: number, width: number, height: number, rotation: SphereRotation, zoom = 1,
): SphereUV | null {
  if (![x, y, width, height, rotation.yaw, rotation.pitch].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  const radius = sphereRadius(width, height, zoom);
  const nx = (x - width * 0.5) / radius;
  const ny = (height * 0.5 - y) / radius;
  const squaredRadius = nx * nx + ny * ny;
  if (squaredRadius > 1) return null;
  const normal = { x: nx, y: ny, z: Math.sqrt(Math.max(0, 1 - squaredRadius)) };
  return sphereUVFromPoint(unrotateSpherePoint(normal, rotation));
}
