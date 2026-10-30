import { EventEmitter } from "node:events";
import { it, expect, vi } from "vitest";
import { runCLI } from "../src/cli/commands";
import type { Engine } from "../src/core/engine";
import type { Job } from "../src/core/types";
function fixture(states: ("processing" | "accepted" | "rejected" | Error)[]) {
  let job = {
    id: "job",
    projectId: "project",
    platform: "ios",
    profile: "production",
    status: "needs-attention",
    stage: "processing",
    submission: { state: "processing" },
  } as Job;
  const engine = Object.assign(new EventEmitter(), {
    state: () => ({
      projects: [],
      jobs: [structuredClone(job)],
      artifacts: [],
      credentials: [],
    }),
    store: { get: () => structuredClone(job) },
    reconcile: vi.fn(async () => {
      const next = states.shift() ?? "processing";
      if (next instanceof Error) throw next;
      job = {
        ...job,
        status:
          next === "accepted"
            ? "succeeded"
            : next === "rejected"
              ? "failed"
              : "needs-attention",
        submission: {
          state: next,
          destination: "TestFlight",
          lastCheckedAt: new Date().toISOString(),
        },
      };
    }),
    submit: vi.fn(async () => structuredClone(job)),
    logs: () => [],
  });
  let output = "",
    now = 0;
  return {
    engine: engine as unknown as Engine,
    raw: engine,
    write: (text: string) => {
      output += text;
    },
    output: () => output,
    runtime: {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      pollIntervalMs: 10,
    },
  };
}
it("status refreshes Apple without a running desktop and returns the final accepted state", async () => {
  const f = fixture(["accepted"]);
  expect(await runCLI(f.engine, ["status", "--job", "job"], f.write)).toBe(0);
  expect(f.raw.reconcile).toHaveBeenCalledOnce();
  expect(JSON.parse(f.output()).submission.state).toBe("accepted");
});
it("distinguishes pending processing from failure and explains how to wait", async () => {
  const f = fixture(["processing"]);
  expect(await runCLI(f.engine, ["status", "--job", "job"], f.write)).toBe(2);
  expect(JSON.parse(f.output()).statusRefresh.nextAction).toContain("--wait");
  const submission = fixture(["processing"]);
  expect(
    await runCLI(
      submission.engine,
      ["submit", "--artifact", "ipa"],
      submission.write,
    ),
  ).toBe(2);
  expect(submission.output()).toContain("exit 2");
});
it("--wait follows processing to acceptance or rejection without uploading again", async () => {
  const f = fixture(["processing", "accepted"]);
  expect(
    await runCLI(
      f.engine,
      ["submit", "--artifact", "ipa", "--wait"],
      f.write,
      f.runtime,
    ),
  ).toBe(0);
  expect(f.raw.submit).toHaveBeenCalledOnce();
  expect(f.raw.reconcile).toHaveBeenCalledTimes(2);
  const rejected = fixture(["processing", "rejected"]);
  expect(
    await runCLI(
      rejected.engine,
      ["status", "--job", "job", "--wait"],
      rejected.write,
      rejected.runtime,
    ),
  ).toBe(1);
});
it("--wait times out with pending exit 2, and fails fast for expired authorization", async () => {
  const f = fixture([]);
  expect(
    await runCLI(
      f.engine,
      ["status", "--job", "job", "--wait", "--timeout", "0.025"],
      f.write,
      f.runtime,
    ),
  ).toBe(2);
  expect(f.raw.reconcile).toHaveBeenCalledTimes(4);
  const denied = fixture([
    Object.assign(new Error("Apple key expired"), { code: "APPLE_401" }),
  ]);
  expect(
    await runCLI(
      denied.engine,
      ["status", "--job", "job", "--wait"],
      denied.write,
      denied.runtime,
    ),
  ).toBe(1);
  expect(denied.raw.reconcile).toHaveBeenCalledOnce();
  expect(JSON.parse(denied.output()).statusRefresh.errors[0].message).toContain(
    "expired",
  );
});
it("updates through the owner's updater and reports how the update applies", async () => {
  const f = fixture([]);
  const updater = {
    status: vi.fn(() => ({ state: "idle" as const, currentVersion: "0.1.0" })),
    check: vi.fn(async () => ({
      state: "available" as const,
      currentVersion: "0.1.0",
      version: "0.2.0",
    })),
    prepare: vi.fn(async () => ({
      state: "ready" as const,
      currentVersion: "0.1.0",
      version: "0.2.0",
    })),
  };
  const apply = vi.fn(() => "exit" as const);
  const runtime = { ...f.runtime, updates: { updater, apply } };
  expect(await runCLI(f.engine, ["update", "--check"], f.write, runtime)).toBe(
    0,
  );
  expect(updater.prepare).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
  expect(f.output()).toContain("0.2.0 is available");
  expect(await runCLI(f.engine, ["update"], f.write, runtime)).toBe(0);
  expect(updater.prepare).toHaveBeenCalledWith(1800 * 1000);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(f.output()).toContain('"install": "exit"');
  expect(f.output()).toContain("installs when this command exits");
});
it("does not apply anything when the app is current or the check fails", async () => {
  const f = fixture([]);
  const apply = vi.fn(() => "restart" as const);
  const updater = {
    status: () => ({ state: "idle" as const, currentVersion: "0.1.0" }),
    check: vi.fn(),
    prepare: vi
      .fn()
      .mockResolvedValueOnce({ state: "current", currentVersion: "0.1.0" })
      .mockResolvedValueOnce({
        state: "error",
        currentVersion: "0.1.0",
        error: "offline",
      }),
  };
  const runtime = { ...f.runtime, updates: { updater, apply } };
  expect(await runCLI(f.engine, ["update"], f.write, runtime)).toBe(0);
  expect(f.output()).toContain("0.1.0 is up to date");
  expect(await runCLI(f.engine, ["update"], f.write, runtime)).toBe(1);
  expect(f.output()).toContain("Could not update: offline");
  expect(apply).not.toHaveBeenCalled();
});
it("explains that a source checkout cannot self-update", async () => {
  const f = fixture([]);
  expect(await runCLI(f.engine, ["update"], f.write, f.runtime)).toBe(1);
  expect(f.output()).toContain("signed Local Build Desk app");
});
