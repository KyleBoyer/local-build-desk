import { it, expect, vi } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../src/core/database";
import {
  assertUploadChecks,
  policyDigest,
  resolveDestination,
  testArguments,
  exportedScreenshots,
} from "../src/core/release-validation";
import { releaseChecksSchema } from "../src/core/release-check-schema";
import { assertScreenshotProvenance } from "../src/core/screenshot-provenance";
import { ReleaseJournal } from "../src/core/release-journal";
import { checkpoint, finishCheckpoint } from "../src/core/checkpoints";
import { readinessReport } from "../src/core/readiness";
import { createScreenshotRunner } from "../src/core/screenshot-runner";
import { installQuitController } from "../src/main/quit-controller";
import type { Job, Project, ProjectSettings } from "../src/core/types";

const policy = {
  enabled: true,
  required: true,
  runner: "xcode" as const,
  destinations: [{ deviceType: "iPhone 17 Pro" }],
};
const settings: ProjectSettings = {
  releaseChecks: releaseChecksSchema.parse(policy),
} as ProjectSettings;
const source = "a".repeat(64);
const passing = (over: Partial<Job> = {}): Job =>
  ({
    id: "job-1",
    projectId: "p1",
    kind: "build",
    platform: "ios",
    profile: "production",
    status: "succeeded",
    createdAt: "2026-10-29T00:00:00Z",
    version: "1.2.0",
    buildNumber: "7",
    facts: { sourceHash: source },
    validation: {
      state: "passed",
      mode: "all",
      sourceHash: source,
      policyDigest: policyDigest(settings),
      fingerprint: "f".repeat(64),
      configuration: "Release",
      startedAt: "",
      runs: [{ device: "iPhone", status: "passed" }],
      screenshots: [],
    },
    ...over,
  }) as unknown as Job;
const png = (w: number, h: number, salt = 0) => {
  const b = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[32] = salt;
  return b;
};

it("blocks upload unless passing checks match the artifact's source and policy", () => {
  expect(() => assertUploadChecks(passing(), settings)).not.toThrow();
  expect(() =>
    assertUploadChecks(
      passing({ facts: { sourceHash: "b".repeat(64) } } as Partial<Job>),
      settings,
    ),
  ).toThrow(/RELEASE_CHECKS_REQUIRED|Required release checks/);
  const changed = {
    releaseChecks: releaseChecksSchema.parse({
      ...policy,
      onlyTesting: ["AppTests"],
    }),
  } as ProjectSettings;
  expect(() => assertUploadChecks(passing(), changed)).toThrow(
    /Required release checks/,
  );
  expect(() =>
    assertUploadChecks(
      passing({ validation: { ...passing().validation!, mode: "tests" } }),
      settings,
    ),
  ).toThrow();
  // Optional or disabled policies never gate.
  expect(() =>
    assertUploadChecks(passing({ validation: undefined }), {
      releaseChecks: { ...settings.releaseChecks!, required: false },
    } as ProjectSettings),
  ).not.toThrow();
  expect(() =>
    assertUploadChecks(
      passing({ validation: undefined }),
      {} as ProjectSettings,
    ),
  ).not.toThrow();
});

it("requires simulator destinations and a command for command runners", () => {
  expect(releaseChecksSchema.safeParse({ runner: "xcode" }).success).toBe(
    false,
  );
  expect(
    releaseChecksSchema.safeParse({ runner: "command", destinations: [] })
      .success,
  ).toBe(false);
  expect(
    releaseChecksSchema.safeParse({
      runner: "command",
      command: ["npm", "test"],
    }).success,
  ).toBe(true);
  expect(
    releaseChecksSchema.safeParse({
      ...policy,
      screenshots: { captures: [{ name: "a" }, { name: "a" }] },
    }).success,
  ).toBe(false);
});

it("never substitutes another simulator runtime", () => {
  const catalog = {
    devices: [
      { identifier: "phone", name: "iPhone 17 Pro" },
      { identifier: "watch", name: "Apple Watch" },
    ],
    runtimes: [
      {
        identifier: "ios26",
        name: "iOS 26.2",
        version: "26.2",
        isAvailable: true,
        supportedDeviceTypes: [{ identifier: "phone" }],
      },
      {
        identifier: "ios18",
        name: "iOS 18.6",
        version: "18.6",
        isAvailable: true,
        supportedDeviceTypes: [],
      },
    ],
    instances: {},
  };
  expect(
    resolveDestination({ deviceType: "iPhone 17 Pro" }, catalog, "26.2").runtime
      .identifier,
  ).toBe("ios26");
  expect(
    resolveDestination({ deviceType: "phone", runtime: "18.6" }, catalog)
      .runtime.identifier,
  ).toBe("ios18");
  expect(() =>
    resolveDestination({ deviceType: "phone", runtime: "17.0" }, catalog),
  ).toThrow(/unavailable/);
  expect(() =>
    resolveDestination({ deviceType: "Apple Watch" }, catalog),
  ).toThrow(/iPhone or iPad/);
});

it("runs tests serially on the leased simulator without signing", async () => {
  const src = await mkdtemp(join(tmpdir(), "lbd-src-"));
  const args = testArguments(
    {
      container: { kind: "workspace", path: "App.xcworkspace" },
      scheme: "App",
      configuration: "Release",
    } as any,
    src,
    releaseChecksSchema.parse({
      ...policy,
      testPlan: "Release",
      onlyTesting: ["AppTests/LoginTests"],
    }),
    "UDID",
    "/r.xcresult",
    "/dd",
  );
  expect(args).toEqual(
    expect.arrayContaining([
      "-testPlan",
      "Release",
      "-only-testing:AppTests/LoginTests",
      "CODE_SIGNING_ALLOWED=NO",
      "test",
    ]),
  );
  expect(args.join(" ")).toContain("platform=iOS Simulator,id=UDID");
  expect(args.join(" ")).toContain("-parallel-testing-enabled NO");
});

it("exports exactly one PNG attachment per named capture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lbd-shots-"));
  await writeFile(join(dir, "home.png"), png(1320, 2868));
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify([
      {
        attachments: [
          {
            exportedFileName: "home.png",
            suggestedHumanReadableName: "store-home_0_1.png",
          },
        ],
      },
    ]),
  );
  const [shot] = await exportedScreenshots(
    dir,
    ["home"],
    "iPhone 17 Pro Max",
    "26.2",
  );
  expect(shot).toMatchObject({
    name: "home",
    width: 1320,
    height: 2868,
    displayType: "APP_IPHONE_67",
  });
  await expect(exportedScreenshots(dir, ["missing"], "d", "r")).rejects.toThrow(
    /received 0/,
  );
});

it("generates a self-contained capture harness from the plan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lbd-harness-"));
  await createScreenshotRunner(dir, "com.example.app", {
    appearance: "dark",
    language: "en",
    locale: "en_US",
    captures: [
      {
        name: "home",
        launchArguments: ["-demo"],
        launchEnvironment: {},
        steps: [{ action: "tap", identifier: "start" }],
      },
    ],
  });
  expect(
    JSON.parse(await readFile(join(dir, "plan.json"), "utf8")),
  ).toMatchObject({ bundleId: "com.example.app" });
  const pbx = await readFile(
    join(dir, "DeskScreenshots.xcodeproj/project.pbxproj"),
    "utf8",
  );
  expect(pbx).toContain("com.apple.product-type.bundle.ui-testing");
  expect(await readFile(join(dir, "Screenshots.swift"), "utf8")).toContain(
    '"store-" + capture.name',
  );
});

it("rejects listing screenshots that no longer describe the attached build", async () => {
  const root = await mkdtemp(join(tmpdir(), "lbd-prov-"));
  const store = new Store(join(root, "data"));
  const job = passing();
  store.putJob(job);
  const file = join(root, "home.png"),
    bytes = png(1320, 2868);
  await writeFile(file, bytes);
  const generated = {
    jobId: job.id,
    sourceHash: source,
    validationFingerprint: job.validation!.fingerprint,
    buildNumber: "7",
    version: "1.2.0",
    files: [
      {
        name: "home",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  const loaded = {
    listing: { generatedScreenshots: generated },
    screenshots: [{ path: file, name: "home.png" } as any],
  };
  const project = { id: "p1" } as Project;
  await expect(
    assertScreenshotProvenance(store, project, loaded, "7", "1.2.0"),
  ).resolves.toBeUndefined();
  await expect(
    assertScreenshotProvenance(store, project, loaded, "8", "1.2.0"),
  ).rejects.toThrow(/captured from build 7/);
  await expect(
    assertScreenshotProvenance(store, project, loaded, undefined, "1.2.0"),
  ).rejects.toThrow(/no verified build/);
  await expect(
    assertScreenshotProvenance(store, project, loaded, "7", "1.3.0"),
  ).rejects.toThrow(/version 1.2.0/);
  await writeFile(file, png(1320, 2868, 1));
  await expect(
    assertScreenshotProvenance(store, project, loaded, "7", "1.2.0"),
  ).rejects.toThrow(/changed on disk/);
  // Hand-made listings carry no claim to check.
  await expect(
    assertScreenshotProvenance(
      store,
      project,
      { listing: {}, screenshots: [] },
      undefined,
      "1.2.0",
    ),
  ).resolves.toBeUndefined();
  store.close();
});

it("journals POSTs and reconciles an unanswered one instead of resending", async () => {
  const root = await mkdtemp(join(tmpdir(), "lbd-journal-"));
  const store = new Store(join(root, "data"));
  const context = {
    projectId: "p1",
    bundleId: "com.example",
    version: "1.2.0",
    appId: "app1",
    manifestHash: "m",
  };
  const request = vi.fn(async () => {
    throw new Error("fetch failed");
  });
  const journal = new ReleaseJournal(store, context);
  const body = {
    data: {
      type: "appStoreVersionLocalizations",
      attributes: { locale: "en-US" },
      relationships: { appStoreVersion: { data: { id: "v1" } } },
    },
  };
  await expect(
    journal
      .wrap({ request } as any)
      .request("/appStoreVersionLocalizations", "POST", body),
  ).rejects.toThrow();
  const reopened = new ReleaseJournal(store, context);
  expect(reopened.data).toMatchObject({
    state: "uncertain",
    pending: {
      path: "/appStoreVersionLocalizations",
      relationships: { appStoreVersion: "v1" },
    },
  });
  // While uncertain, no further mutation is allowed.
  await expect(
    reopened.wrap({ request } as any).request("/x", "PATCH", {}),
  ).rejects.toThrow(/Reconcile/);
  // Apple shows two matches: still ambiguous, journal preserved.
  const twice = {
    request: vi.fn(async () => ({
      data: [
        { id: "a", attributes: { locale: "en-US" } },
        { id: "b", attributes: { locale: "en-US" } },
      ],
    })),
  };
  await expect(reopened.reconcile(twice as any)).rejects.toThrow(/2 matching/);
  const once = {
    request: vi.fn(async () => ({
      data: [
        { id: "a", attributes: { locale: "en-US" } },
        { id: "c", attributes: { locale: "fr-FR" } },
      ],
    })),
  };
  await reopened.reconcile(once as any);
  expect(reopened.data.pending).toBeUndefined();
  expect(reopened.data.completed).toHaveLength(1);
  // A definite 4xx rejection is not uncertain.
  const rejected = vi.fn(async () => {
    throw new Error("Apple 409: duplicate");
  });
  await expect(
    reopened
      .wrap({ request: rejected } as any)
      .request("/appStoreVersions", "POST", {
        data: { attributes: { versionString: "1.2.0" } },
      }),
  ).rejects.toThrow();
  expect(new ReleaseJournal(store, context).data).toMatchObject({
    state: "interrupted",
  });
  expect(
    JSON.stringify(store.preference("release-journals", [])),
  ).not.toContain("contactEmail");
  store.close();
});

it("records stage checkpoints and marks the open one on finish", () => {
  const job = { checkpoints: undefined } as unknown as Job;
  checkpoint(job, "testing", "t1");
  checkpoint(job, "screenshots", "t2");
  finishCheckpoint(job, "interrupted", "t3");
  expect(job.checkpoints).toEqual([
    { stage: "testing", state: "complete", startedAt: "t1", finishedAt: "t2" },
    {
      stage: "screenshots",
      state: "interrupted",
      startedAt: "t2",
      finishedAt: "t3",
      detail: undefined,
    },
  ]);
});

it("blocks readiness when required checks are stale and tracks delivery separately", () => {
  const project = {
    id: "p1",
    settings: {
      ...settings,
      appleConnectionId: "c",
      iosSigningId: "s",
      testFlightGroupId: "g",
      testFlightGroupName: "Team",
    },
  } as unknown as Project;
  const artifact = {
    id: "a1",
    kind: "ipa",
    version: "1.2.0",
    buildNumber: "7",
    sha256: "0".repeat(64),
  };
  const checks = ["Xcode", "iOS SDK", "Build storage"].map((name) => ({
    name,
    status: "ok",
    detail: "",
  }));
  const ready = readinessReport(
    project,
    [passing({ artifactId: "a1", storeEligible: true } as Partial<Job>)],
    [artifact as any],
    checks as any,
  );
  expect(ready.items.find((i) => i.id === "tests")?.status).toBe("ready");
  expect(ready.delivery).toEqual({
    built: true,
    uploaded: false,
    processed: false,
    assigned: false,
  });
  const stale = readinessReport(
    project,
    [
      passing({
        artifactId: "a1",
        storeEligible: true,
        facts: { sourceHash: "b".repeat(64) },
      } as Partial<Job>),
    ],
    [artifact as any],
    checks as any,
  );
  expect(stale.items.find((i) => i.id === "tests")?.status).toBe("blocked");
  expect(stale.canUpload).toBe(false);
});

it("runs shutdown cleanup once and force-exits only while installing an update", async () => {
  vi.useFakeTimers();
  const handlers: Record<string, (e: any) => void> = {};
  const app = {
    on: (n: string, f: any) => {
      handlers[n] = f;
    },
    quit: vi.fn(),
    exit: vi.fn(),
  };
  let finish!: () => void;
  const cleanup = vi.fn(
    () =>
      new Promise<void>((r) => {
        finish = r;
      }),
  );
  installQuitController(app as any, cleanup, () => true, 100);
  const event = () => ({ preventDefault: vi.fn() });
  const first = event(),
    second = event();
  handlers["before-quit"]!(first);
  handlers["before-quit"]!(second);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(second.preventDefault).toHaveBeenCalled();
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(app.quit).toHaveBeenCalledTimes(1);
  const after = event();
  handlers["before-quit"]!(after);
  expect(after.preventDefault).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(app.exit).toHaveBeenCalledWith(0);
  vi.useRealTimers();
});

it("waits for asynchronously freed disk space, but not forever", async () => {
  const { freeSpace } = await import("../src/core/release-validation");
  expect(await freeSpace(tmpdir(), 1, 0)).toBe(true);
  const huge = Number.MAX_SAFE_INTEGER;
  const started = Date.now();
  expect(await freeSpace(tmpdir(), huge, 50, undefined, 10)).toBe(false);
  expect(Date.now() - started).toBeLessThan(1000);
  const aborted = new AbortController();
  aborted.abort();
  expect(await freeSpace(tmpdir(), huge, 60000, aborted.signal)).toBe(false);
});

it("distinguishes capture names that share prefixes or numeric suffixes", async () => {
  const { rm } = await import("node:fs/promises");
  const folder = await mkdtemp(join(tmpdir(), "lbd-capture-names-"));
  try {
    const names = ["home", "home-detail", "home_0", "home_0_1"];
    await Promise.all(
      names.map((name, index) =>
        writeFile(join(folder, `${name}.png`), png(1320, 2868, index)),
      ),
    );
    await writeFile(
      join(folder, "manifest.json"),
      JSON.stringify([
        {
          attachments: names.map((name) => ({
            exportedFileName: `${name}.png`,
            suggestedHumanReadableName: `store-${name}_0_3A36378A-3034-4782-BD1A-605666BF8B17.png`,
          })),
        },
      ]),
    );
    const shots = await exportedScreenshots(folder, names, "iPhone", "27.2");
    expect(shots.map((s) => s.name)).toEqual(names);
    expect(new Set(shots.map((s) => s.sha256)).size).toBe(4);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it("uses the production artifact and its independent submission for readiness", () => {
  const project = {
    id: "p1",
    settings: {
      ...settings,
      appleConnectionId: "apple",
      iosSigningId: "ios",
      testFlightGroupId: "group",
    },
  } as Project;
  const build = passing({ artifactId: "ipa", storeEligible: true });
  const preview = passing({
    id: "preview",
    artifactId: "app",
    profile: "development",
    storeEligible: false,
    createdAt: "2026-10-30T00:00:00Z",
  });
  const unrelated = passing({
    id: "other",
    artifactId: "other-ipa",
    kind: "submit",
    createdAt: "2026-10-31T00:00:00Z",
    submission: {
      state: "accepted",
      destination: "TestFlight",
      message: "available to internal group Team",
    },
  });
  const submitted = passing({
    id: "submission",
    artifactId: "ipa",
    kind: "submit",
    createdAt: "2026-10-29T00:01:00Z",
    submission: {
      state: "accepted",
      destination: "TestFlight",
      message: "Processed by Apple and available to internal group Team.",
    },
  });
  const artifact = {
    id: "ipa",
    kind: "ipa",
    sha256: "f".repeat(64),
    version: "1.2.0",
    buildNumber: "7",
  } as any;
  const checks = ["Xcode", "iOS SDK", "Build storage"].map((name) => ({
    name,
    status: "ok",
    detail: "Installed",
  })) as any;
  const report = readinessReport(
    project,
    [build, preview, submitted, unrelated],
    [artifact],
    checks,
  );
  expect(report.jobId).toBe(build.id);
  expect(report.delivery).toEqual({
    built: true,
    uploaded: true,
    processed: true,
    assigned: true,
  });
  expect(report.canUpload).toBe(false);
  expect(report.items.find((i) => i.id === "delivery")?.status).toBe("ready");
  const queued = {
    ...submitted,
    status: "queued",
    submission: undefined,
  } as Job;
  const active = readinessReport(project, [build, queued], [artifact], checks);
  expect(active.delivery.uploaded).toBe(false);
  expect(active.canUpload).toBe(false);
});

it("shares native snapshot inputs across builds, reuse and resume for each project type", async () => {
  const { snapshotInputs } = await import("../src/core/snapshot");
  const expo = { type: "expo", native: { ios: true, android: false } } as any;
  expect(snapshotInputs(expo, { appDirectory: "apps/mobile" })).toEqual({
    native: { ios: true, android: false },
    requiredPaths: ["apps/mobile/ios"],
  });
  expect(
    snapshotInputs(
      {
        type: "capacitor",
        native: { ios: true, android: false },
        capacitor: { iosPath: "custom/apple", androidPath: "custom/google" },
      } as any,
      {},
    ),
  ).toEqual({
    native: { ios: true, android: true },
    requiredPaths: ["custom/apple", "custom/google"],
  });
  expect(
    snapshotInputs(
      {
        type: "native-ios",
        containers: [
          { path: "apps/ios/App.xcodeproj" },
          { path: "Root.xcworkspace" },
        ],
      } as any,
      {},
    ),
  ).toEqual({
    native: { ios: true, android: true },
    requiredPaths: ["apps/ios", "Root.xcworkspace"],
  });
});
