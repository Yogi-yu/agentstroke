declare module "p5.brush/standalone" {
  export type TipSurface = {
    fill(value: number | string): void;
    noStroke(): void;
    rect(x: number, y: number, width: number, height: number): void;
    ellipse(x: number, y: number, width: number, height: number): void;
  };

  export function load(canvas: HTMLCanvasElement | OffscreenCanvas): void;
  export function clear(color?: string): void;
  export function render(): void;
  export function push(): void;
  export function pop(): void;
  export function translate(x: number, y: number): void;
  export function seed(value: number): void;
  export function noiseSeed(value: number): void;
  export function box(): string[];
  export function add(name: string, params: Record<string, unknown>): void;
  export function set(name: string, color: string, weight?: number): void;
  export function spline(points: number[][], curvature?: number): unknown;
}
