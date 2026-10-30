import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  cp,
  realpath,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import { join, resolve, basename, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
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
  screenshotPlanSchema,
  type ReleaseCheckPolicy,
  type ScreenshotPlan,
  type SimulatorDestination,
} from "./release-check-schema";
import { createScreenshotRunner } from "./screenshot-runner";
import { captureAndroid, withEmulator } from "./android-capture";
import { frameScreenshot, playCanvas } from "./screenshot-frame";
import { admitHeavyStep } from "./memory";
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
        // xcresulttool appends _<index>_<attachment-id>.png. Comparing the
        // original name keeps "home" distinct from "home-detail"/"home_0".
        a.suggestedHumanReadableName
          .replace(/_\d+_[^_]+\.png$/, "")
          .replace(/\.png$/, "") === `store-${name}` &&
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
    shots.push(
      await describeScreenshot(
        join(folder, selected.exportedFileName),
        name,
        device,
        runtime,
      ),
    );
  }
  return shots;
}

/** A captured PNG's identity and size; App Store display types for iOS. */
export async function describeScreenshot(
  path: string,
  name: string,
  device: string,
  runtime: string,
  apple = true,
): Promise<CapturedScreenshot> {
  const bytes = await readFile(path);
  invariant(
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "SCREENSHOT_FORMAT",
    "The capture is not a PNG.",
  );
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  return {
    name,
    path,
    width,
    height,
    ...(apple ? { displayType: displayTypeFor(width, height) } : {}),
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    device,
    runtime,
  };
}

/** Builds an installable APK of the snapshot for captures, signed with a
 * throwaway key, and reads what the emulator needs to launch it. */
async function captureApk(
  dir: string,
  task: string,
  root: string,
  options: CommandOptions,
) {
  const sdk = options.env!.ANDROID_HOME!;
  // Only the emulator's CPU type: React Native otherwise compiles every native
  // library four times. Other projects ignore the property.
  const abi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
  await run(
    join(dir, "gradlew"),
    [
      task,
      `-PreactNativeArchitectures=${abi}`,
      "--no-daemon",
      "--console=plain",
      "--no-configuration-cache",
    ],
    { ...options, cwd: dir },
  );
  const moduleDir = join(dir, task.split(":").slice(1, -1).join("/") || "app");
  const apks: { path: string; mtime: number }[] = [];
  for (const entry of await readdir(join(moduleDir, "build/outputs/apk"), {
    recursive: true,
  }))
    if (entry.endsWith(".apk") && !entry.includes("androidTest")) {
      const path = join(moduleDir, "build/outputs/apk", entry);
      apks.push({ path, mtime: (await stat(path)).mtimeMs });
    }
  invariant(
    apks.length,
    "CAPTURE_APK",
    `${task} did not produce an APK. Choose an assemble task for the Android capture build.`,
  );
  const built = apks.sort((a, b) => b.mtime - a.mtime)[0]!.path;
  const tools = join(
    sdk,
    "build-tools",
    (await readdir(join(sdk, "build-tools")))
      .filter((v) => /^\d/.test(v))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1)!,
  );
  const keystore = join(root, "capture.keystore"),
    apk = join(root, "capture.apk");
  await rm(keystore, { force: true });
  await run(
    "keytool",
    [
      "-genkeypair",
      "-keystore",
      keystore,
      "-storepass",
      "capture",
      "-keypass",
      "capture",
      "-alias",
      "capture",
      "-keyalg",
      "RSA",
      "-keysize",
      "2048",
      "-validity",
      "2",
      "-dname",
      "CN=Local Build Desk capture",
      "-noprompt",
    ],
    { ...options, log: undefined },
  );
  await run(
    join(tools, "apksigner"),
    [
      "sign",
      "--ks",
      keystore,
      "--ks-pass",
      "pass:capture",
      "--out",
      apk,
      built,
    ],
    { ...options, log: undefined },
  );
  const badging = (
    await run(join(tools, "aapt2"), ["dump", "badging", apk], {
      ...options,
      log: undefined,
    })
  ).stdout;
  const pkg = badging.match(/package: name='([^']+)'/)?.[1],
    activity = badging.match(/launchable-activity: name='([^']+)'/)?.[1];
  invariant(
    pkg && activity,
    "CAPTURE_APK",
    "The capture APK has no launcher activity.",
  );
  return {
    apk,
    pkg,
    activity: `${pkg}/${activity}`,
    debuggable: /application-debuggable/.test(badging),
  };
}

async function captureOnEmulators(
  ctx: BuildContext,
  policy: ReleaseCheckPolicy,
  capturePlan: ScreenshotPlan,
  root: string,
  result: ValidationResult,
  options: CommandOptions & {
    dir: string;
    writeManifest: () => Promise<void>;
  },
) {
  invariant(
    policy.androidDevices.length,
    "ANDROID_DEVICES",
    "Add an Android emulator in Check settings to capture Android screenshots.",
  );
  ctx.stage("screenshots");
  await admitHeavyStep(3, "The Android capture build", ctx);
  ctx.log(`Building the capture APK with ${policy.androidCaptureTask}…`);
  const app = await captureApk(
    options.dir,
    policy.androidCaptureTask,
    root,
    options,
  );
  await withLock("desk-emulator-validation", ctx.signal, async () => {
    for (const [index, destination] of policy.androidDevices.entries()) {
      const plan = capturesFor(capturePlan, destination.device);
      if (!plan.captures.length) {
        ctx.log(`No captures are assigned to ${destination.device}.`);
        continue;
      }
      const folder = join(root, `android-${index}`);
      await admitHeavyStep(4, `The ${destination.device} emulator`, ctx);
      await withEmulator(
        {
          sdks: [
            options.env!.ANDROID_HOME,
            process.env.ANDROID_HOME,
            join(homedir(), "Library/Android/sdk"),
          ],
          home: join(root, "avd"),
          name: `lbd_${ctx.job.id.slice(0, 8)}_${index}`,
          destination,
          env: options.env!,
          log: ctx.log,
          signal: ctx.signal,
          appearance: plan.appearance,
        },
        async (device, image) => {
          const runtime = image.split(";")[1]!.replace("android-", "Android ");
          ctx.log(
            `Capturing ${plan.captures.length} screens on ${destination.device}…`,
          );
          try {
            await device.adbCommand("install", "-r", "-g", app.apk);
            await device.shell(
              `cmd locale set-app-locales ${app.pkg} --locales ${plan.language}`,
              true,
            );
            const shots = await captureAndroid(
              {
                device,
                pkg: app.pkg,
                activity: app.activity,
                debuggable: app.debuggable,
                folder,
                log: ctx.log,
                signal: ctx.signal,
              },
              plan,
            );
            result.runs.push({
              device: destination.device,
              runtime,
              attachments: folder,
              status: "passed",
            });
            for (const shot of shots)
              result.screenshots.push(
                await describeScreenshot(
                  shot.path,
                  shot.name,
                  destination.device,
                  runtime,
                  false,
                ),
              );
            await options.writeManifest();
          } catch (error) {
            result.runs.push({
              device: destination.device,
              runtime,
              attachments: folder,
              status: "failed",
              detail: messageOf(error).slice(0, 4000),
            });
            await options.writeManifest();
            throw error;
          }
        },
      );
    }
  });
}

export const SIMULATOR_LOCAL_SIGNING = [
  "CODE_SIGNING_ALLOWED=YES",
  "CODE_SIGNING_REQUIRED=NO",
  "CODE_SIGN_IDENTITY=-",
  "CODE_SIGN_STYLE=Manual",
  "DEVELOPMENT_TEAM=",
  "PROVISIONING_PROFILE_SPECIFIER=",
];

/** The run's capture plan: inline in the policy, or the project's
 * checked-in file read from this snapshot. */
export async function screenshotPlanFor(
  policy: ReleaseCheckPolicy,
  source: string,
): Promise<ScreenshotPlan | undefined> {
  if (policy.screenshots) return policy.screenshots;
  const file = policy.screenshotPlanFile;
  if (!file) return undefined;
  const root = await realpath(source);
  let path: string, raw: unknown;
  try {
    path = await realpath(resolve(root, file));
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw Object.assign(
      new Error(`Could not read the capture plan ${file}: ${messageOf(error)}`),
      { code: "SCREENSHOT_PLAN" },
    );
  }
  invariant(
    path.startsWith(root + sep),
    "SCREENSHOT_PLAN",
    "The capture plan file must stay inside the project.",
  );
  const parsed = screenshotPlanSchema.safeParse(raw);
  invariant(
    parsed.success,
    "SCREENSHOT_PLAN",
    `${file}: ${parsed.error?.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ` : "") + i.message)
      .join(" ")}`,
  );
  return parsed.data;
}

/** The captures that belong on this simulator, by device type or name. */
export function capturesFor(
  plan: ScreenshotPlan,
  ...names: string[]
): ScreenshotPlan {
  return {
    ...plan,
    captures: plan.captures.filter(
      (capture) =>
        !capture.devices ||
        capture.devices.some((device) => names.includes(device)),
    ),
  };
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
  /** The Android project and Gradle environment, for capture builds. */
  android?: { dir: string; env: NodeJS.ProcessEnv; module?: string },
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
      policy.runner === "command" ||
      policy.screenshots ||
      policy.screenshotPlanFile,
    "TEST_PLATFORM",
    "Android checks use a project-owned test command or a capture plan; Xcode tests run on iOS.",
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
    // Read inside the try so a broken plan file is recorded as a failed run.
    const capturePlan =
      mode === "tests" ? undefined : await screenshotPlanFor(policy, source);
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
      (policy.runner === "xcode" || capturePlan)
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
          if (instance) {
            const deleted = await run("xcrun", ["simctl", "delete", lease.id], {
              ...options,
              signal: undefined,
              allowFailure: true,
              timeout: 60000,
            }).catch(() => ({ code: 1 }));
            // CoreSimulator may still be tearing down a crashed runner. Keep
            // the lease so the next run can clean up rather than forgetting it.
            if (deleted.code) continue;
          }
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
          await admitHeavyStep(3, `The ${device.name} simulator`, ctx);
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
            const plan =
              capturePlan &&
              capturesFor(
                capturePlan,
                choice.deviceType,
                device.name,
                device.identifier,
              );
            if (plan && !plan.captures.length)
              ctx.log(`No captures are assigned to ${device.name}.`);
            if (plan?.captures.length) {
              ctx.stage("screenshots");
              ctx.log(
                `Capturing ${plan.captures.length} screens on ${device.name}…`,
              );
              await run(
                "xcrun",
                ["simctl", "ui", deviceId, "appearance", plan.appearance],
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
                  // Sign to run locally: an unsigned simulator app has no
                  // entitlements, so Keychain-backed storage fails at launch.
                  ...SIMULATOR_LOCAL_SIGNING,
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
              await createScreenshotRunner(harness, ctx.job.bundleId!, plan);
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
                  plan.captures.map((c) => c.name),
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
    if (ctx.job.platform === "android" && capturePlan)
      await captureOnEmulators(ctx, policy, capturePlan, root, result, {
        ...options,
        ...android!,
        writeManifest,
      });
    if (capturePlan?.frame && result.screenshots.length) {
      ctx.log(
        `Framing ${result.screenshots.length} screenshots for the store…`,
      );
      for (const shot of result.screenshots)
        shot.framed = await frameScreenshot(
          shot.path,
          shot.path.replace(/\.png$/, "") + "-framed.png",
          capturePlan.frame,
          capturePlan.captures.find((c) => c.name === shot.name)?.headline,
          ctx.job.platform === "android" ? playCanvas : undefined,
        );
      await writeManifest();
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
