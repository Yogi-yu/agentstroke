"use client";

import { useId } from "react";
import type { BrushHeadAxis, BrushHeadProfile } from "@/lib/types";
import { normalizeBrushHead } from "@/engine/brushHeadSweep";
import styles from "./BrushHeadPreview.module.css";

interface Props { profile: BrushHeadProfile }

const CENTER = 180;
const RADIUS = 101;
const LABEL_RADIUS = 132;
const shortLabels: Record<BrushHeadAxis["key"], string> = {
  intensity: "Intensity", confidence: "Confidence", entropy: "Entropy",
  motion_variation: "Motion", stability: "Stability", curvature: "Curvature",
  branching: "Branches", duration: "Dwell",
};
const position = (angle: number, radius: number) => {
  const radians = (angle - 90) * Math.PI / 180;
  return { x: CENTER + Math.cos(radians) * radius, y: CENTER + Math.sin(radians) * radius };
};
const pointString = (points: { x: number; y: number }[]) => points.map(point => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(" ");
const rawValue = (axis: BrushHeadAxis) => axis.rawValue === null ? "Not recorded"
  : axis.key === "duration" ? `${Math.round(axis.rawValue).toLocaleString("en-US")} ms`
    : axis.rawValue.toFixed(3);

/** Displays the same attribute-derived outline swept along the rendered path. */
export default function BrushHeadPreview({ profile }: Props) {
  const id = useId();
  const titleId = `${id}-title`, descriptionId = `${id}-description`;
  const shape = normalizeBrushHead(profile).map(vertex => ({ x: CENTER + vertex.x * RADIUS, y: CENTER + vertex.y * RADIUS }));
  const description = profile.hasData
    ? `The exact rendered brush-head contour, connecting eight attribute-derived radii. ${profile.axes.map(axis => `${axis.label}: contour radius ${axis.value.toFixed(3)}, ${axis.available ? `source signal ${axis.signalValue.toFixed(3)}` : "source not recorded"}`).join("; ")}. Levels, range and early-to-late change form the signals. Bounded contrast reveals their differences; a small connected core prevents detached lobes. All radii are fitted with one uniform scale. The polygon keeps the bearing set by the initial travel direction while its center follows every original path corner exactly. No extra zigzags or rounded shortcuts are added. Original pressure controls size; color, material and timing remain unchanged.`
    : "No recorded path attributes are available to form a brush-head outline.";

  return (
    <section className={styles.preview} aria-labelledby={titleId} data-brush-head-preview="true">
      <div className={styles.heading}>
        <h3 id={titleId}>Brush head</h3>
        <span className={styles.badge}>{profile.hasData ? "Exact contact shape" : "No path data"}</span>
      </div>
      <div className={styles.canvas}>
        <svg className={styles.chart} viewBox="0 0 360 360" role="img" aria-labelledby={`${id}-svg-title ${descriptionId}`}>
          <title id={`${id}-svg-title`}>Exact attribute-shaped brush head</title>
          <desc id={descriptionId}>{description}</desc>
          <g aria-hidden="true">
            {[0.2, 0.4, 0.6, 0.8, 1].map(level => (
              <polygon key={level} points={pointString(profile.axes.map(axis => position(axis.angleDegrees, RADIUS * level)))}
                className={level === 1 ? styles.outerRing : styles.ring} />
            ))}
            {profile.axes.map(axis => {
              const end = position(axis.angleDegrees, RADIUS);
              const label = position(axis.angleDegrees, LABEL_RADIUS);
              return <g key={axis.key}>
                <line x1={CENTER} y1={CENTER} x2={end.x} y2={end.y} className={styles.spoke} />
                <text x={label.x} y={label.y} textAnchor="middle" dominantBaseline="middle" className={styles.axisLabel}>
                  {shortLabels[axis.key]}
                </text>
              </g>;
            })}
            {profile.hasData && <>
              <polygon points={pointString(shape)} className={styles.outline} data-brush-head-outline="true" />
              {shape.map((point, index) => <circle key={profile.axes[index].key} cx={point.x} cy={point.y} r={3.8}
                className={profile.axes[index].available ? styles.vertex : styles.missingVertex}>
                <title>{profile.axes[index].label}: contour radius {profile.axes[index].value.toFixed(3)}{profile.axes[index].available ? "" : "; connected core, source not recorded"}</title>
              </circle>)}
            </>}
            <circle cx={CENTER} cy={CENTER} r={2.3} className={styles.center} />
          </g>
        </svg>
        <div className={styles.scale}><span>Center <b>0</b></span><span>Outer ring <b>1</b></span></div>
      </div>
      <p className={styles.note}>{profile.hasData ? "This exact polygon deposits the ink. It keeps its initial bearing while travel turns, following every original corner without extra zigzags." : "No path attributes recorded yet."} <span>Size follows the original pressure. Color, material and timing stay unchanged.</span></p>
      <details className={styles.mapping}>
        <summary>Attribute mapping <span>8 directions</span></summary>
        <p className={styles.mappingIntro}>Eight source signals, not eight averages. Range and early-to-late change preserve how the agent&apos;s process evolved. Directions start at the top and run clockwise.</p>
        <p className={styles.mappingIntro}>Signals are clamped to 0–1, then given signed square-root contrast around 0.5. A 16% core keeps the contour connected. One uniform fit sets the outermost radius to 1; it never changes stroke width. Missing sources use only that core. Early and late mean the first and last thirds of the recorded path.</p>
        <ol className={styles.axes}>
          {profile.axes.map(axis => <li key={axis.key}>
            <div className={styles.axisHeading}><strong>{axis.label}</strong><span>Radius {axis.value.toFixed(3)}</span></div>
            <div className={styles.raw}><span>{axis.angleDegrees}°</span><span>Raw: {rawValue(axis)}</span><span>Signal: {axis.available ? axis.signalValue.toFixed(3) : "Not recorded"}</span></div>
            {axis.available && axis.spread !== undefined && <div className={styles.raw}><span>Range: {axis.spread.toFixed(3)}</span><span>Late − early: {(axis.trend ?? 0).toFixed(3)}</span></div>}
            <p>{axis.source}</p>
          </li>)}
        </ol>
      </details>
    </section>
  );
}
