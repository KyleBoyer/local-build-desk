import { useEffect, useRef, useState } from "react";
import type { WorkProgress as Progress } from "../../core/types";
import { elapsedLabel } from "../../core/progress";
export function WorkProgress({
  progress,
  startedAt,
  label,
  note,
}: {
  progress?: Progress;
  startedAt?: string;
  label: string;
  note: string;
}) {
  const mounted = useRef(Date.now());
  const [time, setTime] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const start =
    Date.parse(startedAt ?? progress?.startedAt ?? "") || mounted.current;
  const percent =
    progress?.totalBytes && progress.completedBytes !== undefined
      ? (progress.completedBytes / progress.totalBytes) * 100
      : progress?.percent;
  const value =
    percent === undefined ? undefined : Math.max(0, Math.min(100, percent));
  const format = (bytes: number) =>
    bytes >= 1000 ** 3
      ? `${(bytes / 1000 ** 3).toFixed(2)} GB`
      : `${(bytes / 1000 ** 2).toFixed(1)} MB`;
  const age = progress?.updatedAt
    ? Math.max(0, time - Date.parse(progress.updatedAt))
    : 0;
  return (
    <div className="work-progress">
      <div className="work-progress-heading">
        <strong>{progress?.label ?? label}</strong>
        <span className="work-progress-clock" aria-label="Elapsed time">
          {elapsedLabel(time - start)} elapsed
        </span>
      </div>
      <div
        className={`work-progress-rail ${value === undefined ? "indeterminate" : ""}`}
        role="progressbar"
        aria-label={progress?.label ?? label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={
          value === undefined ? undefined : Number(value.toFixed(1))
        }
      >
        <span
          style={value === undefined ? undefined : { width: `${value}%` }}
        />
      </div>
      <div className="work-progress-metrics">
        <span>
          {progress?.completedBytes !== undefined && progress.totalBytes
            ? `${format(progress.completedBytes)} / ${format(progress.totalBytes)}`
            : value !== undefined
              ? "Reported by the tool"
              : "In progress"}
        </span>
        <span>
          {value === undefined
            ? ""
            : `${value === 100 ? 100 : Math.floor(value)}%`}
        </span>
      </div>
      <p>{progress?.detail ?? note}</p>
      {age >= 15000 && (
        <small>Last progress update {elapsedLabel(age)} ago.</small>
      )}
    </div>
  );
}
