"use client";

import { useId } from "react";
import { MAX_ANIMATED_TRAIL_RETENTION, MIN_ANIMATED_TRAIL_RETENTION, clampTrailRetention } from "@/engine/meteorTrail";

interface Props {
  value: number;
  onChange: (value: number) => void;
  editMode: boolean;
  displayMode: "animated" | "static";
}

export default function TrailRetentionControl({ value, onChange, editMode, displayMode }: Props) {
  const id = useId();
  const percent = Math.round(clampTrailRetention(value) * 100);
  const disabled = editMode || displayMode !== "animated";
  const hint = editMode ? "Unavailable while editing" : displayMode !== "animated"
    ? "Animated mode only" : `Full trail until ${percent}% is drawn, then the rear fades.`;

  return (
    <div className={`snapshot-trail-controls${editMode ? " is-editing" : ""}`}>
      <div className="snapshot-trail-label">
        <label htmlFor={id}>Trail retention</label>
        <output htmlFor={id}>{percent}%</output>
      </div>
      <input
        id={id}
        type="range"
        min={MIN_ANIMATED_TRAIL_RETENTION * 100}
        max={MAX_ANIMATED_TRAIL_RETENTION * 100}
        step={1}
        value={percent}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        aria-valuetext={`${percent}% of the stroke`}
        onChange={(event) => {
          if (!disabled) onChange(clampTrailRetention(Number(event.currentTarget.value) / 100));
        }}
      />
      <p id={`${id}-hint`} className="snapshot-trail-hint">{hint}</p>
    </div>
  );
}
