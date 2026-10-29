import type { Job, Stage } from "./types";
export function checkpoint(
  job: Job,
  stage: Stage,
  at = new Date().toISOString(),
) {
  const previous = job.checkpoints?.at(-1);
  if (previous?.state === "running") {
    previous.state = "complete";
    previous.finishedAt = at;
  }
  (job.checkpoints ??= []).push({ stage, state: "running", startedAt: at });
}
export function finishCheckpoint(
  job: Job,
  success: boolean | "interrupted",
  at = new Date().toISOString(),
) {
  const last = job.checkpoints?.at(-1);
  if (last?.state === "running") {
    last.state =
      success === "interrupted"
        ? "interrupted"
        : success
          ? "complete"
          : "failed";
    last.finishedAt = at;
    last.detail = job.error;
  }
}
