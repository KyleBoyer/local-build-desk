import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/database";
import { run } from "../src/core/process";
import { releaseChecksSchema } from "../src/core/release-check-schema";
import { runReleaseChecks } from "../src/core/release-validation";
import type { BuildContext } from "../src/core/build";
import type { IOSBuildTarget, Profile, Job } from "../src/core/types";

vi.mock("../src/core/process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/process")>()),
  run: vi.fn(),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  statfs: vi.fn(async () => ({ bavail: 100000000, bsize: 4096 })),
}));

const deviceId = "11111111-2222-3333-4444-555555555555";
const orphanId = "22222222-2222-3333-4444-555555555555";
let root: string, store: Store, controller: AbortController, ctx: BuildContext;
const target = {
  container: { kind: "project", path: "App.xcodeproj" },
  scheme: "App",
  configuration: "Release",
} as IOSBuildTarget;
const profile = { configuration: "Release" } as Profile;
function success(stdout = "", code = 0) {
  return { stdout, stderr: "", code };
}
function respond(command: string, args: string[]) {
  if (args[0] === "simctl" && args[1] === "list")
    return success(
      JSON.stringify({
        devicetypes: [{ identifier: "phone", name: "iPhone 17 Pro" }],
        runtimes: [
          {
            identifier: "iOS-27-2",
            name: "iOS 27.2",
            version: "27.2",
            isAvailable: true,
            supportedDeviceTypes: ["phone"],
          },
        ],
        devices: {
          "iOS-27-2": [{ udid: orphanId, name: "Local Build Desk crashed 0" }],
        },
      }),
    );
  if (args[0] === "simctl" && args[1] === "create") return success(deviceId);
  if (args[0] === "xcresulttool")
    return success(
      JSON.stringify({
        passedTests: 2,
        failedTests: 0,
        skippedTests: 0,
        totalTestCount: 2,
      }),
    );
  return success();
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desk-runner-regression-"));
  store = new Store(join(root, "state"));
  controller = new AbortController();
  await mkdir(join(root, "source"));
  ctx = {
    project: {
      id: "project",
      path: join(root, "source"),
      settings: {
        releaseChecks: releaseChecksSchema.parse({
          runner: "xcode",
          destinations: [{ deviceType: "phone", runtime: "27.2" }],
        }),
      },
    },
    job: {
      id: "job",
      kind: "test",
      projectId: "project",
      platform: "ios",
      status: "running",
      facts: { sourceHash: "a".repeat(64) },
      toolchain: { iosSdk: "27.2" },
    },
    store,
    signal: controller.signal,
    stage: vi.fn(),
    log: vi.fn(),
    save: vi.fn(),
  } as unknown as BuildContext;
  store.putJob(ctx.job);
  vi.mocked(run).mockReset();
  vi.mocked(run).mockImplementation(async (command, args) =>
    respond(command, args),
  );
});
afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});
it("fails closed when Xcode exits successfully but executes zero tests, then cleans up its simulator", async () => {
  vi.mocked(run).mockImplementation(async (command, args) =>
    args[0] === "xcresulttool"
      ? success(
          JSON.stringify({
            passedTests: 0,
            failedTests: 0,
            skippedTests: 0,
            totalTestCount: 0,
          }),
        )
      : respond(command, args),
  );
  await expect(
    runReleaseChecks(
      ctx,
      target,
      profile,
      join(root, "source"),
      join(root, "artifacts"),
      { cwd: join(root, "source"), signal: controller.signal },
    ),
  ).rejects.toThrow(/no tests ran/);
  expect(ctx.job.validation).toMatchObject({
    state: "failed",
    runs: [{ passed: 0, status: "failed" }],
  });
  expect(
    vi
      .mocked(run)
      .mock.calls.some(
        ([, args]) => args.join(" ") === `simctl delete ${deviceId}`,
      ),
  ).toBe(true);
  expect(store.preference("simulator-leases", [])).toEqual([]);
});
it("cancels a running test and still tears down only its owned device with an un-aborted cleanup signal", async () => {
  vi.mocked(run).mockImplementation(async (command, args) => {
    if (command === "xcodebuild") {
      controller.abort();
      throw new Error("Cancelled");
    }
    return respond(command, args);
  });
  await expect(
    runReleaseChecks(
      ctx,
      target,
      profile,
      join(root, "source"),
      join(root, "artifacts"),
      { signal: controller.signal },
    ),
  ).rejects.toThrow(/Cancelled/);
  expect(ctx.job.validation?.state).toBe("cancelled");
  const cleanup = vi
    .mocked(run)
    .mock.calls.filter(
      ([, args]) =>
        args[0] === "simctl" && ["shutdown", "delete"].includes(args[1]!),
    );
  expect(cleanup.map(([, args]) => args[2])).toEqual([deviceId, deviceId]);
  expect(cleanup.every(([, , options]) => options?.signal === undefined)).toBe(
    true,
  );
});
it("retains a crashed simulator lease when CoreSimulator refuses deletion so later runs can retry", async () => {
  store.putJob({ id: "crashed", status: "interrupted" } as Job);
  store.setPreference("simulator-leases", [
    { id: orphanId, name: "Local Build Desk crashed 0", jobId: "crashed" },
  ]);
  vi.mocked(run).mockImplementation(async (command, args) =>
    args.join(" ") === `simctl delete ${orphanId}`
      ? success("", 1)
      : respond(command, args),
  );
  await runReleaseChecks(
    ctx,
    target,
    profile,
    join(root, "source"),
    join(root, "artifacts"),
    {},
  );
  expect(ctx.job.validation?.state).toBe("passed");
  expect(store.preference("simulator-leases", [])).toEqual([
    { id: orphanId, name: "Local Build Desk crashed 0", jobId: "crashed" },
  ]);
});
