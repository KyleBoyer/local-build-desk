// @vitest-environment jsdom
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BuildLogPanel } from "../src/renderer/src/BuildLogPanel";
import type { DeskEvent, LogPage } from "../src/core/types";
let host: HTMLDivElement, root: Root;
let reads: { job: string; resolve: (page: LogPage) => void }[],
  listeners: Set<(event: DeskEvent) => void>;
const cancelled = vi.fn();
const row = (offset: number, text: string) => ({
  offset,
  entry: { time: "2026-10-30T12:00:00.000Z", stage: "compile" as const, text },
});
const page = (rows: LogPage["rows"]): LogPage => ({
  rows,
  before: rows[0]?.offset ?? 0,
  end: 1000,
  hasEarlier: false,
  shortened: 0,
  skipped: 0,
  path: "/fixture/logs.jsonl",
});
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  reads = [];
  listeners = new Set();
  cancelled.mockClear();
  window.desk = {
    logPage: (job: string) =>
      new Promise<LogPage>((resolve) => reads.push({ job, resolve })),
    cancelLogRead: cancelled.mockResolvedValue(undefined),
    onEvent: (listener: (event: DeskEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as any;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("merges output arriving during the initial read exactly once and bounds live bursts", async () => {
  await act(async () => root.render(<BuildLogPanel jobId="job" />));
  await act(async () => {
    for (const listener of listeners)
      listener({
        type: "log",
        jobId: "job",
        logOffset: 1,
        entry: row(1, "arrived during read").entry,
      });
    reads[0].resolve(page([row(0, "first"), row(1, "arrived during read")]));
  });
  expect(host.querySelectorAll(".logs > div")).toHaveLength(2);
  await act(async () => {
    for (let i = 2; i < 2002; i++)
      for (const listener of listeners)
        listener({
          type: "log",
          jobId: "job",
          logOffset: i,
          entry: row(i, `live ${i}`).entry,
        });
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(host.querySelectorAll(".logs > div")).toHaveLength(300);
  expect(host.querySelector(".logs")!.textContent).toContain("live 2001");
  const older = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Older output",
  )!;
  expect(older.disabled).toBe(false);
});
it("cancels pending reads and ignores late responses when changing builds or leaving the page", async () => {
  await act(async () =>
    root.render(<BuildLogPanel key="first" jobId="first" />),
  );
  expect(listeners.size).toBe(1);
  await act(async () =>
    root.render(<BuildLogPanel key="second" jobId="second" />),
  );
  expect(cancelled).toHaveBeenCalledWith("first");
  expect(listeners.size).toBe(1);
  await act(async () => {
    reads[1].resolve(page([row(0, "second output")]));
  });
  await act(async () => {
    reads[0].resolve(page([row(0, "stale first output")]));
  });
  expect(host.querySelector(".logs")!.textContent).toContain("second output");
  expect(host.querySelector(".logs")!.textContent).not.toContain("stale");
  await act(async () => root.render(null));
  expect(cancelled).toHaveBeenCalledWith("second");
  expect(listeners.size).toBe(0);
});
