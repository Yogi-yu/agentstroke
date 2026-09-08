"use client";

import { useEffect, useRef } from "react";

type Mode = "orbital" | "choice" | "flow";

export default function SiliconField({ mode }: { mode: Mode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let frame = 0;
    let raf = 0;
    let visible = true;

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const line = (x1: number, y1: number, x2: number, y2: number, alpha: number) => {
      context.strokeStyle = `rgba(105, 235, 218, ${alpha})`;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
      context.stroke();
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);
      const t = frame * 0.006;
      const cx = mode === "orbital" ? width * 0.7 : width * 0.5;
      const cy = mode === "choice" ? height * 0.45 : height * 0.5;
      const count = width < 650 ? 28 : 54;
      const points: Array<[number, number]> = [];

      for (let index = 0; index < count; index++) {
        const phase = index / count;
        const angle = phase * Math.PI * 2 + t * (mode === "flow" ? 0.45 : 0.18);
        const wave = Math.sin(index * 2.17 + t * 1.4);
        let x = cx + Math.cos(angle) * (width * (0.12 + phase * 0.21));
        let y = cy + Math.sin(angle * (mode === "choice" ? 2 : 1)) * (height * 0.12) + wave * 15;
        if (mode === "flow") {
          x = width * (0.12 + phase * 0.78);
          y = height * 0.55 + Math.sin(phase * Math.PI * 5 + t) * height * 0.11;
        }
        points.push([x, y]);
      }

      points.forEach(([x, y], index) => {
        const next = points[(index + 1) % points.length];
        if (mode === "flow" && index === points.length - 1) return;
        line(x, y, next[0], next[1], 0.07 + (index % 7 === 0 ? 0.16 : 0));
        context.fillStyle = index % 9 === 0 ? "rgba(182,255,242,.9)" : "rgba(126,232,216,.32)";
        context.beginPath();
        context.arc(x, y, index % 9 === 0 ? 2.2 : 1, 0, Math.PI * 2);
        context.fill();
      });

      if (mode === "choice") {
        const drift = Math.sin(t) * 14;
        line(width * .3, height * .48, width * .7, height * .48 + drift, .22);
        [width * .3, width * .7].forEach((x, index) => {
          context.strokeStyle = index ? "rgba(128,255,231,.65)" : "rgba(255,255,255,.16)";
          context.beginPath(); context.arc(x, height * .48 + (index ? drift : 0), 34, 0, Math.PI * 2); context.stroke();
        });
      }

      if (!reduced && visible) {
        frame += 1;
        raf = requestAnimationFrame(draw);
      }
    };

    const observer = new IntersectionObserver(([entry]) => {
      const nextVisible = entry.isIntersecting;
      if (nextVisible && !visible && !reduced) { visible = true; draw(); }
      else if (!nextVisible) { visible = false; cancelAnimationFrame(raf); }
    }, { threshold: 0.05 });

    resize();
    draw();
    observer.observe(canvas);
    window.addEventListener("resize", resize);
    return () => { cancelAnimationFrame(raf); observer.disconnect(); window.removeEventListener("resize", resize); };
  }, [mode]);

  return <canvas ref={canvasRef} className={`silicon-field silicon-field-${mode}`} aria-hidden="true" />;
}
