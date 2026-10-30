import { open } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Redactor } from "../core/process";
import type { Engine } from "../core/engine";
import type { Job, LogEntry, Artifact } from "../core/types";
import type { MonitorSnapshot, MonitorJob, MonitorLogs } from "./types";
const redactor = new Redactor();
export function monitorText(
  text: string | undefined,
  roots: string[] = [],
): string | undefined {
  if (text === undefined) return;
  let value = redactor
    .redact(text)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(
      /((?:api[-_]?key|client[-_]?secret|access[-_]?key)\s*[=:]\s*)[^\s,]+/gi,
      "$1[REDACTED]",
    );
  for (const root of [...new Set([...roots, homedir()])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    value = value.split(root).join("[Mac path]");
  return value
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/gi, "$1?[REDACTED]")
    .slice(0, 20000);
}
export function monitorJob(
  job: Job,
  artifacts: Artifact[],
  roots: string[],
): MonitorJob {
  const text = (value: string | undefined) => monitorText(value, roots);
  const submission = job.submission;
  return {
    id: job.id,
    projectId: job.projectId,
    projectName: job.projectName,
    platform: job.platform,
    profile: job.profile,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    stageStartedAt: job.stageStartedAt,
    bundleId: job.bundleId,
    version: job.version,
    buildNumber: job.buildNumber,
    error: text(job.error),
    progress: job.progress
      ? {
          kind: job.progress.kind,
          label: text(job.progress.label) ?? "Working",
          startedAt: job.progress.startedAt,
          updatedAt: job.progress.updatedAt,
          completedBytes: job.progress.completedBytes,
          totalBytes: job.progress.totalBytes,
          percent: job.progress.percent,
          detail: text(job.progress.detail),
        }
      : undefined,
    submission: submission
      ? {
          state: submission.state,
          destination: submission.destination,
          message: text(submission.message),
          uploadedAt: submission.uploadedAt,
          lastCheckedAt: submission.lastCheckedAt,
          rollout: submission.rollout,
        }
      : undefined,
    checkpoints: job.checkpoints?.map((c) => ({
      stage: c.stage,
      state: c.state,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      detail: text(c.detail),
    })),
    validation: job.validation
      ? {
          state: job.validation.state,
          configuration: job.validation.configuration,
          startedAt: job.validation.startedAt,
          finishedAt: job.validation.finishedAt,
          error: text(job.validation.error),
          mode: job.validation.mode,
          runs: job.validation.runs.map((r) => ({
            device: r.device,
            runtime: r.runtime,
            status: r.status,
            passed: r.passed,
            failed: r.failed,
            skipped: r.skipped,
          })),
          screenshots: job.validation.screenshots.map((s, index) => ({
            index,
            name: s.name,
            device: s.device,
            width: s.width,
            height: s.height,
          })),
        }
      : undefined,
    source: job.facts
      ? {
          hash: job.facts.sourceHash,
          commit: job.facts.sourceCommit,
          configuration: job.facts.configuration,
        }
      : undefined,
    toolchain: job.toolchain
      ? {
          xcodeVersion: job.toolchain.xcodeVersion,
          iosSdk: job.toolchain.iosSdk,
        }
      : undefined,
    artifacts: artifacts
      .filter(
        (a) =>
          a.jobId === (job.parentJobId ?? job.id) || a.id === job.artifactId,
      )
      .map((a) => ({
        id: a.id,
        jobId: a.jobId,
        platform: a.platform,
        kind: a.kind,
        sha256: a.sha256,
        size: a.size,
        bundleId: a.bundleId,
        version: a.version,
        buildNumber: a.buildNumber,
        iosSdk: a.iosSdk,
      })),
  };
}
export function monitorSnapshot(
  engine: Engine,
  version: string,
  startedAt: string,
): MonitorSnapshot {
  const state = engine.state(),
    roots = [
      engine.store.root,
      ...state.projects.map((p) => p.path),
      ...state.projects.map((p) => p.settings.buildDirectory ?? ""),
    ];
  const jobs = state.jobs.map((j) => monitorJob(j, state.artifacts, roots));
  const active = (j: MonitorJob) =>
    ["running", "queued"].includes(j.status) ||
    j.submission?.state === "processing";
  const recent = jobs
    .filter(active)
    .concat(jobs.filter((j) => !active(j)).slice(0, 100));
  return {
    server: {
      name: "Local Build Desk",
      version,
      startedAt,
      now: new Date().toISOString(),
    },
    projects: state.projects.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      platforms: p.platforms,
      bundleId: p.bundleId,
      packageName: p.packageName,
      version: p.version,
    })),
    jobs: recent,
    counts: {
      active: jobs.filter((j) => j.status === "running").length,
      queued: jobs.filter((j) => j.status === "queued").length,
      processing: jobs.filter((j) => j.submission?.state === "processing")
        .length,
      attention: jobs.filter(
        (j) =>
          ["failed", "interrupted", "needs-attention"].includes(j.status) &&
          j.submission?.state !== "processing",
      ).length,
      total: jobs.length,
    },
  };
}
/** Read a bounded byte window. The cursor ends at a complete JSONL line, so
 * reconnecting after a burst neither splits UTF-8 nor loses the partial tail. */
export async function monitorLogs(
  engine: Engine,
  jobId: string,
  after?: number,
): Promise<MonitorLogs> {
  const state = engine.state();
  if (!state.jobs.some((j) => j.id === jobId))
    throw new Error("Build not found.");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId))
    throw new Error("Unsupported build ID.");
  const roots = [
    engine.store.root,
    ...state.projects.map((p) => p.path),
    ...state.projects.map((p) => p.settings.buildDirectory ?? ""),
  ];
  const file = await open(
    join(engine.store.root, "jobs", jobId, "logs.jsonl"),
    "r",
  ).catch(() => undefined);
  if (!file) return { entries: [], cursor: 0, hasMore: false, reset: !!after };
  try {
    const size = (await file.stat()).size,
      reset = after !== undefined && after > size;
    const initial = after === undefined || reset;
    const start = initial ? Math.max(0, size - 256 * 1024) : after!;
    const bytes = Buffer.alloc(Math.min(size - start, 512 * 1024));
    await file.read(bytes, 0, bytes.length, start);
    const end = bytes.lastIndexOf(10);
    if (end < 0) {
      // A partial final record is retried when it completes. An oversized record
      // must advance the bounded cursor so it cannot trap a client forever.
      const oversized = bytes.length === 512 * 1024;
      return {
        entries: [],
        cursor: oversized ? start + bytes.length : start,
        hasMore: oversized && start + bytes.length < size,
        reset,
      };
    }
    let offset = initial && start > 0 ? bytes.indexOf(10) + 1 : 0;
    const entries: LogEntry[] = [];
    for (const line of bytes.subarray(offset, end).toString("utf8").split("\n"))
      try {
        const row = JSON.parse(line);
        if (
          typeof row.time === "string" &&
          typeof row.stage === "string" &&
          typeof row.text === "string"
        )
          entries.push({
            time: row.time,
            stage: row.stage,
            text: monitorText(row.text, roots) ?? "",
          });
      } catch {}
    return {
      entries: initial ? entries.slice(-500) : entries,
      cursor: start + end + 1,
      hasMore: start + end + 1 < size,
      reset,
    };
  } finally {
    await file.close();
  }
}
