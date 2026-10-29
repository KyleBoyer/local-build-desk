import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  cp,
  realpath,
  statfs,
} from "node:fs/promises";
import { join, resolve, basename, sep } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { run, type CommandOptions } from "./process";
import type { BuildContext } from "./build";
import type {
  CapturedScreenshot,
  IOSBuildTarget,
  Job,
  Profile,
  ProjectSettings,
  ValidationResult,
} from "./types";
import { containerArguments } from "./xcode-project";
import {
  releaseChecksSchema,
  type ReleaseCheckPolicy,
  type SimulatorDestination,
} from "./release-check-schema";
import { createScreenshotRunner } from "./screenshot-runner";
import { displayTypeFor } from "./app-store-listing";
import { withLock } from "./locks";
import { invariant, messageOf } from "./errors";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const policyDigest = (settings: ProjectSettings) =>
  settings.releaseChecks
    ? hash(releaseChecksSchema.parse(settings.releaseChecks))
    : "disabled";
export function validationFingerprint(
  job: Job,
  policy: ReleaseCheckPolicy,
  environmentHash: string,
) {
  return hash({
    source: job.facts?.sourceHash,
    target: job.facts?.nativeTarget,
    configuration: policy.configuration ?? job.facts?.configuration,
    toolchain: job.toolchain,
    policy: hash(policy),
    environmentHash,
  });
}
export function assertUploadChecks(job: Job, settings: ProjectSettings) {
  const policy = settings.releaseChecks;
  if (!policy?.enabled || !policy.required) return;
  invariant(
    job.validation?.state === "passed" &&
      job.validation.mode === "all" &&
      job.validation.sourceHash === job.facts?.sourceHash &&
      job.validation.policyDigest === policyDigest(settings),
    "RELEASE_CHECKS_REQUIRED",
    "Required release checks have not passed for this artifact and policy. Build fresh with Tests enabled before uploading. A different checkout's tests cannot approve an older IPA/AAB.",
  );
}
interface Runtime {
  identifier: string;
  name: string;
  version: string;
  isAvailable: boolean;
  supportedDeviceTypes?: ({ identifier: string } | string)[];
}
interface Device {
  identifier: string;
  name: string;
  productFamily?: string;
}
export async function simulatorCatalog(options: CommandOptions = {}) {
  const result = await run("xcrun", ["simctl", "list", "--json"], {
    ...options,
    log: undefined,
  });
  const data = JSON.parse(result.stdout);
  return {
    devices: data.devicetypes as Device[],
    runtimes: (data.runtimes as Runtime[]).filter(
      (r) => r.isAvailable && r.identifier.includes("iOS"),
    ),
    instances: data.devices as Record<string, { udid: string; name: string }[]>,
  };
}
export function resolveDestination(
  choice: SimulatorDestination,
  catalog: Awaited<ReturnType<typeof simulatorCatalog>>,
  sdk?: string,
) {
  const device = catalog.devices.find(
    (d) => d.identifier === choice.deviceType || d.name === choice.deviceType,
  );
  invariant(
    device && /iPhone|iPad/.test(device.name),
    "SIMULATOR_DEVICE",
    "Choose an installed iPhone or iPad simulator device type.",
  );
  const runtime = catalog.runtimes
    .filter((r) =>
      choice.runtime
        ? [r.identifier, r.version, r.name].includes(choice.runtime)
        : !sdk ||
          r.version.split(".").slice(0, 2).join(".") ===
            sdk.split(".").slice(0, 2).join("."),
    )
    .filter(
      (r) =>
        !r.supportedDeviceTypes?.length ||
        r.supportedDeviceTypes.some(
          (d) =>
            (typeof d === "string" ? d : d.identifier) === device.identifier,
        ),
    )
    .sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }),
    )[0];
  invariant(
    runtime,
    "SIMULATOR_RUNTIME",
    `The requested iOS simulator runtime (${choice.runtime ?? sdk ?? "selected SDK"}) is unavailable. Install it in Toolchain; another runtime will not be silently substituted.`,
  );
  if (runtime.supportedDeviceTypes?.length)
    invariant(
      runtime.supportedDeviceTypes.some(
        (d) => (typeof d === "string" ? d : d.identifier) === device.identifier,
      ),
      "SIMULATOR_COMPATIBILITY",
      `${device.name} is not supported by ${runtime.name}. Choose a supported pairing.`,
    );
  return { device, runtime };
}
export function testArguments(
  target: IOSBuildTarget,
  root: string,
  policy: ReleaseCheckPolicy,
  deviceId: string,
  results: string,
  derived: string,
) {
  return [
    ...containerArguments(target.container, root),
    "-scheme",
    policy.scheme ?? target.scheme,
    "-configuration",
    policy.configuration ?? target.configuration,
    "-destination",
    `platform=iOS Simulator,id=${deviceId}`,
    "-derivedDataPath",
    derived,
    "-resultBundlePath",
    results,
    "-parallel-testing-enabled",
    "NO",
    "-maximum-concurrent-test-simulator-destinations",
    "1",
    ...(policy.testPlan ? ["-testPlan", policy.testPlan] : []),
    ...policy.onlyTesting.map((t) => `-only-testing:${t}`),
    "CODE_SIGNING_ALLOWED=NO",
    "ENABLE_TESTABILITY=YES",
    "ONLY_ACTIVE_ARCH=YES",
    "test",
  ];
}
export async function resultSummary(path: string, options: CommandOptions) {
  const result = await run(
    "xcrun",
    [
      "xcresulttool",
      "get",
      "test-results",
      "summary",
      "--path",
      path,
      "--compact",
    ],
    { ...options, log: undefined, allowFailure: true },
  );
  if (result.code) return undefined;
  const data = JSON.parse(result.stdout);
  return {
    passed: Number(data.passedTests ?? 0),
    failed: Number(data.failedTests ?? 0),
    skipped: Number(data.skippedTests ?? 0),
    total: Number(data.totalTestCount ?? 0),
  };
}
export async function exportedScreenshots(
  folder: string,
  names: string[],
  device: string,
  runtime: string,
): Promise<CapturedScreenshot[]> {
  const manifest = JSON.parse(
    await readFile(join(folder, "manifest.json"), "utf8"),
  ) as {
    attachments: {
      exportedFileName: string;
      suggestedHumanReadableName: string;
    }[];
  }[];
  const attachments = manifest.flatMap((m) => m.attachments);
  const shots: CapturedScreenshot[] = [];
  for (const name of names) {
    const matches = attachments.filter(
      (a) =>
        a.suggestedHumanReadableName.includes(`store-${name}`) &&
        a.exportedFileName.endsWith(".png"),
    );
    invariant(
      matches.length === 1,
      "SCREENSHOT_ATTACHMENT",
      `Expected one screenshot attachment named store-${name}; received ${matches.length}. Inspect the test results before retrying.`,
    );
    const selected = matches[0]!;
    invariant(
      basename(selected.exportedFileName) === selected.exportedFileName,
      "SCREENSHOT_PATH",
      "An exported attachment path escapes the result folder.",
    );
    const path = join(folder, selected.exportedFileName),
      bytes = await readFile(path);
    invariant(
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      "SCREENSHOT_FORMAT",
      "The test attachment is not a PNG.",
    );
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    shots.push({
      name,
      path,
      width,
      height,
      displayType: displayTypeFor(width, height),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      device,
      runtime,
    });
  }
  return shots;
}

/** Whether `path`'s volume has `bytes` free, polling for up to `waitMs`. */
export async function freeSpace(
  path: string,
  bytes: number,
  waitMs: number,
  signal?: AbortSignal,
  pollMs = 2000,
) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const disk = await statfs(path);
    if (disk.bavail * disk.bsize >= bytes) return true;
    if (Date.now() >= deadline || signal?.aborted) return false;
    await sleep(pollMs, undefined, { signal }).catch(() => undefined);
  }
}

/** Captures/tests run sequentially on owned disposable devices. Never boot, erase
 * or shut down a user's simulator, and never change global Xcode selection. */
export async function runReleaseChecks(
  ctx: BuildContext,
  target: IOSBuildTarget | undefined,
  profile: Profile,
  source: string,
  output: string,
  options: CommandOptions,
) {
  const raw = ctx.project.settings.releaseChecks;
  const wanted =
    ctx.job.kind === "test" || (!!raw?.enabled && ctx.job.storeEligible);
  if (!wanted) return;
  invariant(
    raw?.enabled,
    "TESTS_NOT_CONFIGURED",
    "Configure Tests for this project before running checks.",
  );
  const policy = releaseChecksSchema.parse(raw);
  const mode = ctx.job.checksMode ?? "all";
  invariant(
    ctx.job.platform === "ios" ||
      (policy.runner === "command" && !policy.screenshots),
    "TEST_PLATFORM",
    "Android checks use a project-owned command. Simulator screenshot plans require iOS.",
  );
  const result: ValidationResult = {
    state: "running",
    fingerprint: validationFingerprint(
      ctx.job,
      policy,
      hash(options.env ?? {}),
    ),
    sourceHash: ctx.job.facts?.sourceHash ?? "",
    policyDigest: policyDigest(ctx.project.settings),
    configuration: policy.configuration ?? profile.configuration,
    startedAt: new Date().toISOString(),
    mode,
    runs: [],
    screenshots: [],
  };
  ctx.job.validation = result;
  ctx.save();
  const root = join(output, "checks");
  await mkdir(root, { recursive: true });
  const processOptions = {
    ...options,
    timeout: policy.timeoutSeconds * 1000,
    allowFailure: true,
  };
  const writeManifest = async () => {
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
    ctx.save();
  };
  try {
    if (mode !== "screenshots" && policy.runner === "command") {
      ctx.stage("testing");
      ctx.log("Running the project's test command in the isolated snapshot…");
      const [executable, ...args] = policy.command!;
      const command = executable!.includes("/")
        ? resolve(options.cwd ?? source, executable!)
        : executable!;
      if (executable!.includes("/"))
        invariant(
          (await realpath(command)).startsWith((await realpath(source)) + sep),
          "TEST_COMMAND_PATH",
          "The project-owned test executable must stay inside the snapshot.",
        );
      const runResult = await run(command, args, processOptions);
      result.runs.push({
        device: "Project command",
        status: runResult.code === 0 ? "passed" : "failed",
      });
      await writeManifest();
      invariant(
        runResult.code === 0,
        "TEST_FAILURE",
        "The project test command failed. Open the retained logs; upload is blocked when these checks are required.",
      );
    }
    if (
      ctx.job.platform === "ios" &&
      (policy.runner === "xcode" || policy.screenshots)
    ) {
      invariant(
        target,
        "TEST_TARGET",
        "Choose an Xcode application scheme before testing.",
      );
      await withLock("desk-simulator-validation", ctx.signal, async () => {
        const catalog = await simulatorCatalog(options);
        // Recover only device IDs journaled by this engine, after their owning
        // job stopped. This also handles a crash between create and cleanup.
        type Lease = { id: string; name: string; jobId: string };
        let leases = ctx.store.preference<Lease[]>("simulator-leases", []);
        for (const lease of [...leases]) {
          const owner = ctx.store
            .list<Job>("jobs")
            .find((j) => j.id === lease.jobId);
          if (owner && ["queued", "running"].includes(owner.status)) continue;
          const instance = Object.values(catalog.instances)
            .flat()
            .find(
              (d) =>
                d.udid === lease.id &&
                d.name === lease.name &&
                d.name.startsWith("Local Build Desk "),
            );
          if (instance)
            await run("xcrun", ["simctl", "delete", lease.id], {
              ...options,
              signal: undefined,
              allowFailure: true,
              timeout: 60000,
            });
          leases = leases.filter((l) => l.id !== lease.id);
        }
        ctx.store.setPreference("simulator-leases", leases);
        for (const [index, choice] of policy.destinations.entries()) {
          const { device, runtime } = resolveDestination(
            choice,
            catalog,
            ctx.job.toolchain?.iosSdk,
          );
          // CoreSimulator frees a deleted device in the background, so the
          // previous destination's space can take a minute to come back.
          const needed = 3 * 1024 ** 3;
          let enough = await freeSpace(tmpdir(), needed, 0);
          if (!enough && index > 0) {
            ctx.log(
              "Waiting for the previous simulator's disk space to be released…",
            );
            enough = await freeSpace(tmpdir(), needed, 120000, ctx.signal);
          }
          invariant(
            enough,
            "SIMULATOR_STORAGE",
            "Simulator tests need at least 3 GB free on the Mac's system disk, even when build storage is elsewhere. Free space and resume; other people's simulators and files will not be removed.",
          );
          const name = `Local Build Desk ${ctx.job.id} ${index}`;
          ctx.stage("testing");
          ctx.log(
            `Preparing ${device.name} · ${runtime.name}. The first boot can take a few minutes…`,
          );
          const created = await run(
            "xcrun",
            ["simctl", "create", name, device.identifier, runtime.identifier],
            { ...options, log: undefined },
          );
          const deviceId = created.stdout.trim();
          invariant(
            /^[0-9A-F-]{36}$/i.test(deviceId),
            "SIMULATOR_CREATE",
            "Simulator did not return a device ID.",
          );
          leases.push({ id: deviceId, name, jobId: ctx.job.id });
          ctx.store.setPreference("simulator-leases", leases);
          try {
            await run("xcrun", ["simctl", "boot", deviceId], {
              ...options,
              timeout: 180000,
            });
            await run("xcrun", ["simctl", "bootstatus", deviceId, "-b"], {
              ...options,
              timeout: 240000,
            });
            const folder = join(root, String(index));
            await mkdir(folder, { recursive: true });
            const derived = join(root, "DerivedData");
            if (mode !== "screenshots" && policy.runner === "xcode") {
              ctx.stage("testing");
              ctx.log(
                `Testing ${device.name} · ${runtime.name} (${result.configuration})…`,
              );
              const bundle = join(folder, "tests.xcresult");
              const test = await run(
                "xcodebuild",
                testArguments(
                  target!,
                  source,
                  policy,
                  deviceId,
                  bundle,
                  derived,
                ),
                processOptions,
              );
              const summary = await resultSummary(bundle, options).catch(
                () => undefined,
              );
              result.runs.push({
                device: device.name,
                runtime: runtime.version,
                resultBundle: bundle,
                status:
                  test.code === 0 &&
                  !!summary &&
                  summary.passed > 0 &&
                  summary.failed === 0
                    ? "passed"
                    : "failed",
                ...summary,
              });
              await writeManifest();
              invariant(
                result.runs.at(-1)!.status === "passed",
                "TEST_FAILURE",
                `Tests failed or no tests ran on ${device.name}. Inspect the retained xcresult; required checks block upload.`,
              );
            }
            if (mode !== "tests" && policy.screenshots) {
              ctx.stage("screenshots");
              ctx.log(
                `Capturing ${policy.screenshots.captures.length} screens on ${device.name}…`,
              );
              await run(
                "xcrun",
                [
                  "simctl",
                  "ui",
                  deviceId,
                  "appearance",
                  policy.screenshots.appearance,
                ],
                options,
              );
              await run(
                "xcrun",
                [
                  "simctl",
                  "status_bar",
                  deviceId,
                  "override",
                  "--time",
                  "9:41",
                  "--dataNetwork",
                  "wifi",
                  "--wifiMode",
                  "active",
                  "--wifiBars",
                  "3",
                  "--batteryState",
                  "charged",
                  "--batteryLevel",
                  "100",
                ],
                options,
              );
              await run(
                "xcodebuild",
                [
                  ...containerArguments(target!.container, source),
                  "-scheme",
                  target!.scheme,
                  "-configuration",
                  result.configuration,
                  "-sdk",
                  `iphonesimulator${ctx.job.toolchain?.iosSdk ?? ""}`,
                  "-destination",
                  `id=${deviceId}`,
                  "-derivedDataPath",
                  derived,
                  "CODE_SIGNING_ALLOWED=NO",
                  "build",
                ],
                { ...options, timeout: policy.timeoutSeconds * 1000 },
              );
              const products = join(
                derived,
                "Build/Products",
                `${result.configuration}-iphonesimulator`,
              );
              let app: string | undefined;
              for (const entry of await readdir(products))
                if (entry.endsWith(".app")) {
                  const candidate = join(products, entry);
                  const info = await run(
                    "plutil",
                    [
                      "-extract",
                      "CFBundleIdentifier",
                      "raw",
                      "-o",
                      "-",
                      join(candidate, "Info.plist"),
                    ],
                    { ...options, log: undefined, allowFailure: true },
                  );
                  if (info.stdout.trim() === ctx.job.bundleId) {
                    invariant(
                      !app,
                      "SCREENSHOT_APP",
                      "Several simulator apps have the selected bundle ID.",
                    );
                    app = candidate;
                  }
                }
              invariant(
                app,
                "SCREENSHOT_APP",
                "The simulator build did not produce the selected app.",
              );
              await run("xcrun", ["simctl", "install", deviceId, app], options);
              const harness = join(folder, "capture-runner");
              await createScreenshotRunner(
                harness,
                ctx.job.bundleId!,
                policy.screenshots,
              );
              const bundle = join(folder, "screenshots.xcresult");
              const captured = await run(
                "xcodebuild",
                [
                  "-project",
                  join(harness, "DeskScreenshots.xcodeproj"),
                  "-scheme",
                  "DeskScreenshots",
                  "-destination",
                  `id=${deviceId}`,
                  "-derivedDataPath",
                  join(root, "CaptureDerivedData"),
                  "-resultBundlePath",
                  bundle,
                  "-parallel-testing-enabled",
                  "NO",
                  "CODE_SIGNING_ALLOWED=NO",
                  "ONLY_ACTIVE_ARCH=YES",
                  "test",
                ],
                processOptions,
              );
              const attachments = join(folder, "attachments");
              await run(
                "xcrun",
                [
                  "xcresulttool",
                  "export",
                  "attachments",
                  "--path",
                  bundle,
                  "--output-path",
                  attachments,
                ],
                { ...options, allowFailure: true },
              );
              result.runs.push({
                device: device.name,
                runtime: runtime.version,
                resultBundle: bundle,
                attachments,
                status: captured.code === 0 ? "passed" : "failed",
              });
              await writeManifest();
              invariant(
                captured.code === 0,
                "SCREENSHOT_FAILURE",
                `The capture plan failed on ${device.name}. Failure screenshots and test results are retained; no store upload will proceed when checks are required.`,
              );
              result.screenshots.push(
                ...(await exportedScreenshots(
                  attachments,
                  policy.screenshots.captures.map((c) => c.name),
                  device.name,
                  runtime.version,
                )),
              );
              await writeManifest();
            }
          } finally {
            const cleanup = {
              ...options,
              signal: undefined,
              timeout: 60000,
              allowFailure: true,
              log: undefined,
            };
            await run("xcrun", ["simctl", "shutdown", deviceId], cleanup).catch(
              () => undefined,
            );
            const deleted = await run(
              "xcrun",
              ["simctl", "delete", deviceId],
              cleanup,
            ).catch(() => ({ code: 1 }));
            if (!deleted.code) {
              leases = leases.filter((l) => l.id !== deviceId);
              ctx.store.setPreference("simulator-leases", leases);
            }
          }
        }
      });
    }
    invariant(
      result.runs.length > 0,
      "NO_CHECKS",
      "The selected mode has no configured tests or screenshots.",
    );
    result.state = "passed";
  } catch (error) {
    result.state = ctx.signal.aborted ? "cancelled" : "failed";
    result.error =
      options.secrets?.redact(messageOf(error)) ?? messageOf(error);
    if (policy.required || ctx.job.kind === "test" || ctx.signal.aborted)
      throw error;
    ctx.log(`Optional release checks failed: ${result.error}`);
  } finally {
    result.finishedAt = new Date().toISOString();
    await writeManifest();
  }
}
