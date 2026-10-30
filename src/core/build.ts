import { runReleaseChecks } from "./release-validation";
import {
  detectProjectType,
  appRoot,
  dependencyRoot,
  projectTool,
} from "./project-adapters";
import { buildNonExpo } from "./build-adapters";
import {
  inspectXcode,
  containerArguments,
  xcodeContainers,
} from "./xcode-project";
import { configureNativeSigning, applyNativeVersions } from "./native-signing";
import type { IOSBuildTarget } from "./types";
import { withLock } from "./locks";
import { reuseKeys } from "./reuse";
import { toolProgress } from "./progress";
import {
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  cp,
  stat,
  symlink,
} from "node:fs/promises";
import { join, basename, resolve, dirname, relative } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import plist from "plist";
import { prepareApple } from "./setup";
import { AppleAPI, GoogleAPI } from "./stores";
import { ensureAndroidPackages } from "./android-toolchain";
import { readBundleManifest } from "./android-manifest";
import { Store, id } from "./database";
import { Vault, privateDirectory, secretFile } from "./vault";
import {
  inspectProject,
  resolveProfile,
  toolEnvironment,
  fingerprint,
  hasFile,
  readJSON,
} from "./config";
import { snapshot, snapshotInputs } from "./snapshot";
import { run, Redactor, type CommandOptions } from "./process";
import { invariant } from "./errors";
import { doctor } from "./doctor";
import { configureIOSSigning, withIOSSigning } from "./signing";
import type {
  Job,
  Project,
  Profile,
  Inspection,
  Stage,
  Artifact,
  ProgressUpdate,
} from "./types";
export interface BuildContext {
  googleGuard?: () => void;
  store: Store;
  vault: Vault;
  job: Job;
  project: Project;
  signal: AbortSignal;
  log(line: string): void;
  stage(stage: Stage): void;
  save(): void;
  progress?(update: ProgressUpdate): void;
}
export function installCommand(
  manager: Inspection["packageManager"],
): [string, string[]] {
  return manager === "npm"
    ? ["npm", ["ci", "--no-audit", "--no-fund"]]
    : manager === "pnpm"
      ? ["pnpm", ["install", "--frozen-lockfile"]]
      : manager === "yarn"
        ? ["yarn", ["install", "--immutable"]]
        : ["bun", ["install", "--frozen-lockfile"]];
}
export function gradleTasks(profile: Profile) {
  if (profile.gradleCommand) {
    invariant(
      /^[\w: -]+$/.test(profile.gradleCommand),
      "GRADLE_COMMAND",
      "gradleCommand must contain Gradle task names only.",
    );
    return profile.gradleCommand.trim().split(/\s+/);
  }
  return [
    profile.developmentClient || profile.debugBuild
      ? ":app:assembleDebug"
      : profile.buildType === "apk"
        ? ":app:assembleRelease"
        : ":app:bundleRelease",
  ];
}
export function archiveArguments(
  workspace: string,
  scheme: string,
  archive: string,
  derived: string,
  profile: Profile,
  number: string,
  version: string,
  keychain: string,
  sdk?: string,
  containerKind: "workspace" | "project" = "workspace",
) {
  return [
    containerKind === "project" ? "-project" : "-workspace",
    workspace,
    "-scheme",
    scheme,
    "-configuration",
    profile.configuration,
    ...(sdk ? ["-sdk", `iphoneos${sdk}`] : []),
    "-destination",
    "generic/platform=iOS",
    "-archivePath",
    archive,
    "-derivedDataPath",
    derived,
    `CURRENT_PROJECT_VERSION=${number}`,
    `MARKETING_VERSION=${version}`,
    `OTHER_CODE_SIGN_FLAGS=--keychain ${keychain}`,
    "archive",
  ];
}
async function walk(
  root: string,
  predicate: (path: string) => boolean,
): Promise<string[]> {
  const found: string[] = [];
  if (!(await hasFile(root))) return found;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (predicate(path)) found.push(path);
    else if (entry.isDirectory()) found.push(...(await walk(path, predicate)));
  }
  return found;
}
async function digest(path: string): Promise<{ sha256: string; size: number }> {
  const info = await stat(path);
  if (info.isFile()) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return { sha256: hash.digest("hex"), size: info.size };
  }
  const hash = createHash("sha256");
  let size = 0;
  const add = async (root: string) => {
    for (const entry of (await readdir(root, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const f = join(root, entry.name);
      if (entry.isDirectory()) await add(f);
      else if (entry.isFile()) {
        const b = await readFile(f);
        hash.update(f.slice(path.length)).update(b);
        size += b.length;
      }
    }
  };
  await add(path);
  return { sha256: hash.digest("hex"), size };
}
export async function hashArtifact(path: string) {
  return digest(path);
}
async function artifact(
  ctx: BuildContext,
  path: string,
  kind: Artifact["kind"],
) {
  const value: Artifact = {
    id: id(),
    jobId: ctx.job.id,
    platform: ctx.job.platform,
    kind,
    path,
    ...(await digest(path)),
    bundleId: ctx.job.bundleId!,
    version: ctx.job.version!,
    buildNumber: ctx.job.buildNumber!,
    ...(ctx.job.toolchain ? { iosSdk: ctx.job.toolchain.iosSdk } : {}),
  };
  ctx.store.putArtifact(value);
  if (["ipa", "apk", "aab", "app"].includes(kind))
    ctx.job.artifactId = value.id;
  ctx.save();
  return value;
}
export async function buildLocal(ctx: BuildContext) {
  if (
    (await detectProjectType(ctx.project.path, ctx.project.settings)) !== "expo"
  )
    return buildNonExpo(ctx);
  const { job, project, store, vault } = ctx;
  const redactor = new Redactor();
  let importedEnv: Record<string, string> = {};
  if (project.settings.envCredentialId)
    importedEnv = (
      await vault.get(project.settings.envCredentialId, "environment")
    ).values;
  redactor.add(...Object.values(importedEnv));
  ctx.stage("preflight");
  let inspection = await inspectProject(
    project.path,
    project.settings,
    importedEnv,
  );
  const profile = resolveProfile(inspection.eas, job.profile, job.platform);
  if (job.kind === "test") {
    profile.simulator = job.platform === "ios";
    profile.distribution = "internal";
    profile.developmentClient = false;
    profile.debugBuild = true;
  }
  job.facts = {
    projectType: "expo",
    configuration: profile.configuration,
    distribution: profile.distribution,
    developmentClient: profile.developmentClient,
    simulator: profile.simulator,
    destination: profile.simulator
      ? "iOS Simulator"
      : profile.distribution === "internal" || profile.developmentClient
        ? "Direct installation"
        : job.platform === "ios"
          ? "App Store Connect / TestFlight"
          : `Google Play · ${project.settings.track ?? "internal"}`,
  };
  job.storeEligible =
    profile.distribution === "store" &&
    !profile.simulator &&
    !profile.developmentClient;
  redactor.add(...Object.values(profile.env));
  // Re-evaluate dynamic config with profile variables before creating the snapshot.
  inspection = await inspectProject(project.path, project.settings, {
    ...importedEnv,
    ...profile.env,
  });
  Object.assign(project, {
    name: inspection.name,
    bundleId: inspection.bundleId,
    packageName: inspection.packageName,
    version: inspection.version,
    sdk: inspection.sdk,
    profiles: inspection.profiles,
  });
  job.projectName = inspection.name;
  const identity =
    job.platform === "ios" ? inspection.bundleId : inspection.packageName;
  for (const issue of [...inspection.issues, ...profile.issues]) {
    if (
      issue.code === "REMOTE_COUNTER" &&
      store.counter(`${job.platform}:${identity}`) !== undefined
    ) {
      ctx.log(
        `Using the local build counter for ${identity}; EAS version services are not required.`,
      );
      continue;
    }
    ctx.log(`${issue.severity.toUpperCase()}: ${issue.message}`);
  }
  invariant(
    !profile.issues.some((i) => i.severity === "error"),
    "PROFILE_UNSUPPORTED",
    "Resolve the profile compatibility errors before building.",
  );
  const pkg = await readJSON(
    join(appRoot(project.path, project.settings), "package.json"),
  );
  invariant(
    !profile.developmentClient ||
      pkg.dependencies?.["expo-dev-client"] ||
      pkg.devDependencies?.["expo-dev-client"],
    "DEV_CLIENT_MISSING",
    "This profile requires expo-dev-client. Install it in your app with npx expo install expo-dev-client.",
  );
  invariant(
    identity,
    "APP_ID_REQUIRED",
    `Set ${job.platform === "ios" ? "ios.bundleIdentifier" : "android.package"} in Expo config.`,
  );
  const checks = await doctor(project.settings, job.platform, vault.ephemeral);
  job.facts.toolVersions = Object.fromEntries(
    checks
      .filter((c) =>
        [
          "Node.js",
          "Xcode",
          "iOS SDK",
          "CocoaPods",
          "Java",
          "Android SDK",
          "Android NDK",
        ].includes(c.name),
      )
      .map((c) => [c.name, c.detail]),
  );
  ctx.save();
  const required =
    job.platform === "ios"
      ? [
          "Node.js",
          "Xcode",
          "iOS SDK",
          "iOS platform",
          "CocoaPods",
          "Git",
          "Build storage",
        ]
      : ["Node.js", "Java", "Android SDK", "Git", "Build storage"];
  const failures = checks.filter(
    (c) => required.includes(c.name) && c.status === "error",
  );
  if (
    job.platform === "ios" &&
    checks.find((check) => check.name === "Xcode")?.status === "ok"
  ) {
    const env = toolEnvironment(project.settings);
    const [sdk, developer] = await Promise.all([
      run(
        "xcrun",
        [
          "--sdk",
          `iphoneos${project.settings.iosSdk ?? ""}`,
          "--show-sdk-version",
        ],
        { env, allowFailure: true },
      ),
      project.settings.xcodePath
        ? Promise.resolve({ stdout: project.settings.xcodePath })
        : run("xcode-select", ["-p"], { env, allowFailure: true }),
    ]);
    if (sdk.code === 0)
      job.toolchain = {
        developerDirectory: developer.stdout.trim(),
        xcodeVersion: checks.find((check) => check.name === "Xcode")!.detail,
        iosSdk: sdk.stdout.trim(),
      };
    ctx.save();
  }
  invariant(
    !failures.length,
    "TOOLCHAIN",
    failures.map((c) => `${c.name}: ${c.detail}. ${c.action ?? ""}`).join("\n"),
  );
  if (
    job.platform === "ios" &&
    job.storeEligible &&
    project.settings.appleConnectionId
  ) {
    if (vault.ephemeral) await vault.get(project.settings.iosSigningId, "ios");
    const setup = await prepareApple(
      store,
      vault,
      project,
      { platform: "ios", newApp: false },
      ctx.log,
      ctx.signal,
      { ...importedEnv, ...profile.env },
    );
    invariant(
      setup.ready,
      "APPLE_SETUP_REQUIRED",
      setup.handoffs.map((h) => `${h.title}: ${h.detail}`).join("\n") ||
        "Complete Guided setup before building.",
    );
  }
  if (job.platform === "ios" && !profile.simulator)
    await vault.get(project.settings.iosSigningId, "ios");
  if (
    job.platform === "android" &&
    !profile.developmentClient &&
    job.kind !== "test"
  )
    await vault.get(project.settings.androidSigningId, "android");
  if (job.autoSubmit) {
    invariant(
      profile.distribution === "store" &&
        !profile.simulator &&
        !profile.developmentClient,
      "NOT_STORE_BUILD",
      "Only production store artifacts can be uploaded.",
    );
    await vault.get(
      job.platform === "ios"
        ? project.settings.appleConnectionId
        : project.settings.googleConnectionId,
      job.platform === "ios" ? "apple" : "google",
    );
  }
  const key = `${job.platform}:${identity}`;
  if (job.storeEligible) {
    // Merge known store high-water marks without ever lowering a local/EAS migration counter.
    if (job.platform === "ios" && project.settings.appleConnectionId) {
      const latest = await new AppleAPI(
        await vault.get(project.settings.appleConnectionId, "apple"),
      ).latestBuild(identity);
      if (latest !== undefined) store.seed(key, latest);
    } else if (
      job.platform === "android" &&
      project.settings.googleConnectionId
    ) {
      const versions = await new GoogleAPI(
        await vault.get(project.settings.googleConnectionId, "google"),
        fetch,
        ctx.signal,
        ctx.googleGuard,
      ).existingVersions(identity);
      if (versions.length) store.seed(key, Math.max(...versions));
    }
  }
  const configured =
    job.platform === "ios"
      ? inspection.config.ios?.buildNumber
      : inspection.config.android?.versionCode;
  const parsed = configured !== undefined ? Number(configured) : undefined;
  if (parsed !== undefined)
    invariant(
      Number.isSafeInteger(parsed) && parsed > 0,
      "BUILD_NUMBER_FORMAT",
      "Local build numbers must be positive integers. Set an explicit integer migration counter for legacy dotted iOS build numbers.",
    );
  const initial =
    inspection.eas.cli?.appVersionSource === "remote"
      ? undefined
      : parsed !== undefined
        ? parsed - 1
        : 0;
  const fixed =
    job.requestedBuildNumber ??
    (!profile.autoIncrement && parsed !== undefined ? parsed : undefined);
  job.buildNumber =
    job.kind === "test"
      ? String(parsed ?? 1)
      : store.claimNumber(
          key,
          job.id,
          initial ??
            (job.requestedBuildNumber !== undefined
              ? job.requestedBuildNumber - 1
              : undefined),
          fixed,
        );
  if (job.kind !== "test") job.versionReservation = "reserved";
  job.version = inspection.version;
  job.bundleId = identity;
  ctx.save();
  const buildStorage = project.settings.buildDirectory
    ? resolve(project.settings.buildDirectory)
    : store.root;
  const root = join(buildStorage, "jobs", job.id),
    source = join(root, "source"),
    output = join(root, "artifacts");
  await mkdir(output, { recursive: true });
  ctx.stage("snapshot");
  const inputs = snapshotInputs(inspection, project.settings);
  const sourceHash = await snapshot(
    project.path,
    source,
    inputs.native,
    ctx.signal,
    true,
    inputs.requiredPaths,
  );
  const sourceApp = appRoot(source, project.settings),
    installRoot = await dependencyRoot(source, sourceApp);
  job.facts.sourceHash = sourceHash;
  if (vault.canFingerprint) {
    try {
      Object.assign(
        job,
        await reuseKeys(
          project,
          inspection,
          profile,
          job.platform,
          sourceHash,
          checks,
          vault,
          importedEnv,
        ),
      );
    } catch {
      ctx.log(
        "Build reuse fingerprint is unavailable; continuing with a fresh build.",
      );
    }
  }
  const sourceCommit = await run("git", ["rev-parse", "HEAD"], {
    ...optionsForCommit(project),
    allowFailure: true,
  });
  if (/^[a-f0-9]{40}$/.test(sourceCommit.stdout.trim()))
    job.facts.sourceCommit = sourceCommit.stdout.trim();
  ctx.save();
  const env: NodeJS.ProcessEnv = {
    ...toolEnvironment(project.settings),
    ...importedEnv,
    ...profile.env,
    EAS_BUILD: "true",
    EAS_BUILD_PLATFORM: job.platform,
    EAS_BUILD_PROFILE: job.profile,
    EAS_BUILD_ID: job.id,
    EAS_BUILD_RUNNER: "local-build-desk",
    EXPO_NO_TELEMETRY: "1",
  };
  if (job.platform === "android" && !env.ANDROID_HOME) {
    env.ANDROID_HOME =
      process.env.ANDROID_HOME ??
      process.env.ANDROID_SDK_ROOT ??
      join(homedir(), "Library/Android/sdk");
    env.ANDROID_SDK_ROOT = env.ANDROID_HOME;
  }
  const options: CommandOptions = {
    cwd: sourceApp,
    env,
    signal: ctx.signal,
    secrets: redactor,
    log: (line) => {
      ctx.log(line);
      const update = toolProgress(line, ctx.job.progress);
      if (update) ctx.progress?.(update);
    },
  };
  for (const [field, cmd, args] of [
    ["node", project.settings.nodePath ?? "node", ["--version"]],
    ["cocoapods", "pod", ["--version"]],
    ...["yarn", "pnpm", "bun"].map((m) => [m, m, ["--version"]]),
  ] as [string, string, string[]][])
    if (profile.raw[field]) {
      const result = await run(cmd, args, options);
      const actual = result.stdout.trim().replace(/^v/, "");
      invariant(
        actual === String(profile.raw[field]).replace(/^v/, ""),
        "TOOL_VERSION",
        `${field} ${profile.raw[field]} requested, but local version is ${actual}. Choose a matching toolchain.`,
      );
    }
  const hook = async (name: string) => {
    if (pkg.scripts?.[name]) {
      ctx.log(`Running ${name}`);
      await run(inspection.packageManager, ["run", name], options);
    }
  };
  try {
    ctx.stage("install");
    await hook("eas-build-pre-install");
    let [command, args] = installCommand(inspection.packageManager);
    if (command === "npm")
      args.push("--cache", join(buildStorage, "cache/npm"));
    if (command === "yarn") {
      const version = await run("yarn", ["--version"], options);
      if (version.stdout.startsWith("1."))
        args = ["install", "--frozen-lockfile"];
    }
    await withLock(
      `dependency-cache:${inspection.packageManager}:${buildStorage}`,
      ctx.signal,
      () => run(command, args, { ...options, cwd: installRoot }),
    );
    const expo = await projectTool(source, sourceApp, "expo/bin/cli");
    ctx.stage("configure");
    // Evaluate config using the copied project and its newly installed dependencies.
    const cfgResult = await run(
      project.settings.nodePath ?? "node",
      [expo, "config", "--json", "--type", "prebuild"],
      options,
    );
    const config = JSON.parse(cfgResult.stdout);
    delete config._internal;
    delete config.mods;
    delete config.sdkVersion;
    invariant(
      (job.platform === "ios"
        ? config.ios?.bundleIdentifier
        : config.android?.package) === identity,
      "CONFIG_CHANGED",
      "App identity changed between preflight and the isolated snapshot. Retry with stable configuration.",
    );
    config.version = job.version;
    config.ios = { ...config.ios, buildNumber: job.buildNumber };
    config.android = {
      ...config.android,
      versionCode: Number(job.buildNumber),
    };
    for (const file of [
      "app.config.js",
      "app.config.ts",
      "app.config.mjs",
      "app.config.cjs",
    ])
      await rm(join(sourceApp, file), { force: true });
    await writeFile(
      join(sourceApp, "app.json"),
      JSON.stringify({ expo: config }, null, 2),
    );
    if (!inspection.native[job.platform]) {
      await rm(join(sourceApp, job.platform), { recursive: true, force: true });
      await run(
        project.settings.nodePath ?? "node",
        [expo, "prebuild", "--no-install", "--platform", job.platform],
        options,
      );
    }
    const cacheKey = fingerprint({
      lock: await readFile(
        join(
          installRoot,
          inspection.packageManager === "npm"
            ? "package-lock.json"
            : inspection.packageManager === "pnpm"
              ? "pnpm-lock.yaml"
              : inspection.packageManager === "yarn"
                ? "yarn.lock"
                : (await hasFile(join(installRoot, "bun.lock")))
                  ? "bun.lock"
                  : "bun.lockb",
        ),
        "utf8",
      ),
      config: inspection.config,
      profile: profile.raw,
      toolchain: checks.filter((c) =>
        [
          "Node.js",
          "Xcode",
          "iOS SDK",
          "CocoaPods",
          "Java",
          "Android SDK",
          "Android NDK",
        ].includes(c.name),
      ),
      platform: job.platform,
    });
    job.fingerprint = fingerprint({ sourceHash, cacheKey });
    ctx.save();
    const cache = join(buildStorage, "cache", cacheKey);
    await withLock(`native-cache:${cache}`, ctx.signal, async () => {
      if (job.clean) await rm(cache, { recursive: true, force: true });
      await mkdir(cache, { recursive: true });
      if (job.platform === "ios") {
        await withLock("cocoapods-downloads", ctx.signal, () =>
          run("pod", ["install"], { ...options, cwd: join(sourceApp, "ios") }),
        );
        await hook("eas-build-post-install");
        await buildIOS(ctx, profile, source, output, cache, options);
      } else {
        await hook("eas-build-post-install");
        await buildAndroid(
          ctx,
          profile,
          source,
          output,
          cache,
          options,
          relative(source, join(sourceApp, "android")),
        );
      }
    });
    await hook("eas-build-on-success");
  } catch (error) {
    await hook("eas-build-on-error").catch((e) =>
      ctx.log(`Error hook failed: ${redactor.redact(String(e))}`),
    );
    throw error;
  } finally {
    await hook("eas-build-on-complete").catch((e) =>
      ctx.log(`Completion hook failed: ${redactor.redact(String(e))}`),
    );
  }
}
function optionsForCommit(project: Project) {
  return { cwd: project.path, timeout: 5000 };
}
export async function buildIOS(
  ctx: BuildContext,
  profile: Profile,
  source: string,
  output: string,
  cache: string,
  options: CommandOptions,
  nativeTarget?: IOSBuildTarget,
) {
  const iosRoot = join(appRoot(source, ctx.project.settings), "ios");
  const hosts = nativeTarget
    ? []
    : (await xcodeContainers(iosRoot)).filter(
        (c) => c.kind === "workspace" && dirname(c.path) === ".",
      );
  const generatedHost =
    hosts.length === 1 && !ctx.project.settings.workspace
      ? relative(source, join(iosRoot, hosts[0].path))
      : undefined;
  const selected =
    nativeTarget ??
    (
      await inspectXcode(
        source,
        {
          ...ctx.project.settings,
          configuration: profile.configuration,
          scheme: ctx.project.settings.scheme ?? profile.scheme,
        },
        options,
        true,
      )
    ).selected;
  invariant(
    selected,
    "SCHEME_REQUIRED",
    "Choose the application's Xcode container and scheme in project settings.",
  );
  const workspace = resolve(source, selected.container.path),
    scheme = selected.scheme;
  const selectionArguments = containerArguments(selected.container, source);
  if (nativeTarget)
    await applyNativeVersions(
      source,
      selected,
      ctx.job.version!,
      ctx.job.buildNumber!,
    );
  await runReleaseChecks(ctx, selected, profile, source, output, options);
  if (ctx.job.kind === "test") return;
  if (profile.simulator) {
    ctx.stage("compile");
    await run(
      "xcodebuild",
      [
        ...selectionArguments,
        "-scheme",
        scheme,
        "-configuration",
        profile.configuration,
        "-sdk",
        `iphonesimulator${ctx.job.toolchain?.iosSdk ?? ""}`,
        "-destination",
        "generic/platform=iOS Simulator",
        "-derivedDataPath",
        join(cache, "DerivedData"),
        "CODE_SIGNING_ALLOWED=NO",
        `CURRENT_PROJECT_VERSION=${ctx.job.buildNumber}`,
        `MARKETING_VERSION=${ctx.job.version}`,
        "build",
      ],
      options,
    );
    const apps = await walk(
      join(
        cache,
        "DerivedData/Build/Products",
        `${profile.configuration}-iphonesimulator`,
      ),
      (p) => p.endsWith(".app"),
    );
    invariant(
      apps.length === 1,
      "SIMULATOR_ARTIFACT",
      "Expected one simulator application.",
    );
    const path = join(output, basename(apps[0]));
    await cp(apps[0], path, { recursive: true });
    if (nativeTarget) {
      ctx.job.facts!.targetEntitlements = Object.fromEntries(
        selected.targets.map((t) => [t.bundleId, t.entitlements]),
      );
      ctx.save();
      const bundles = [
        path,
        ...(await walk(path, (p) => p.endsWith(".appex"))),
      ];
      const infos = await Promise.all(
        bundles.map(
          async (p) =>
            plist.parse(
              (
                await run(
                  "plutil",
                  ["-convert", "xml1", "-o", "-", join(p, "Info.plist")],
                  { ...options, log: undefined },
                )
              ).stdout,
            ) as any,
        ),
      );
      for (const item of selected.targets)
        invariant(
          infos.some(
            (info) =>
              info.CFBundleIdentifier === item.bundleId &&
              String(info.CFBundleVersion) === ctx.job.buildNumber &&
              info.CFBundleShortVersionString === ctx.job.version,
          ),
          "SIMULATOR_TARGET",
          `Simulator build is missing ${item.name} or its identity/version differs from the job.`,
        );
    }
    await artifact(ctx, path, "app");
    return;
  }
  const credential = await ctx.vault.get(
    ctx.project.settings.iosSigningId,
    "ios",
  );
  ctx.stage("signing");
  await privateDirectory((root) =>
    withIOSSigning(credential, root, options, async (signing) => {
      ctx.job.facts!.signing = `${signing.identity} · ${signing.teamId}`;
      ctx.save();
      const profiles = nativeTarget
        ? await configureNativeSigning(
            source,
            selected,
            signing,
            profile,
            ctx.log,
          )
        : await configureIOSSigning(
            iosRoot,
            signing,
            profile,
            ctx.job.bundleId!,
            ctx.log,
          );
      const archive = join(output, "App.xcarchive");
      ctx.stage("compile");
      await run(
        "xcodebuild",
        archiveArguments(
          workspace,
          scheme,
          archive,
          join(cache, "DerivedData"),
          profile,
          ctx.job.buildNumber!,
          ctx.job.version!,
          signing.keychain,
          ctx.job.toolchain?.iosSdk,
          selected.container.kind,
        ),
        options,
      );
      const exportOptions = await secretFile(
        root,
        "ExportOptions.plist",
        plist.build({
          method: profile.developmentClient
            ? "debugging"
            : profile.distribution === "internal"
              ? "release-testing"
              : "app-store-connect",
          signingStyle: "manual",
          teamID: signing.teamId,
          signingCertificate: signing.identity,
          provisioningProfiles: profiles,
          manageAppVersionAndBuildNumber: false,
          uploadSymbols: false,
        }),
      );
      ctx.stage("export");
      await run(
        "xcodebuild",
        [
          "-exportArchive",
          "-archivePath",
          archive,
          "-exportPath",
          output,
          "-exportOptionsPlist",
          exportOptions,
          `OTHER_CODE_SIGN_FLAGS=--keychain ${signing.keychain}`,
        ],
        options,
      );
      const ipas = await walk(output, (p) => p.endsWith(".ipa"));
      invariant(
        ipas.length === 1,
        "IPA_MISSING",
        "Xcode did not export exactly one IPA.",
      );
      ctx.stage("verify");
      const extracted = join(root, "verify");
      await mkdir(extracted);
      await run("/usr/bin/ditto", ["-xk", ipas[0], extracted], options);
      const app = (await readdir(join(extracted, "Payload"))).find((x) =>
        x.endsWith(".app"),
      );
      invariant(app, "IPA_INVALID", "No app in IPA payload.");
      const appPath = join(extracted, "Payload", app);
      const signedEntitlements = await run(
        "codesign",
        ["-d", "--entitlements", ":-", appPath],
        { ...options, log: undefined },
      );
      const xml = signedEntitlements.stdout.slice(
        signedEntitlements.stdout.indexOf("<?xml"),
      );
      if (xml.startsWith("<?xml"))
        ctx.job.facts!.entitlements = plist.parse(xml) as Record<
          string,
          unknown
        >;
      ctx.save();
      await run(
        "codesign",
        ["--verify", "--deep", "--strict", appPath],
        options,
      );
      const info = plist.parse(
        (
          await run(
            "plutil",
            ["-convert", "xml1", "-o", "-", join(appPath, "Info.plist")],
            options,
          )
        ).stdout,
      ) as any;
      invariant(
        info.CFBundleIdentifier === ctx.job.bundleId &&
          String(info.CFBundleVersion) === ctx.job.buildNumber &&
          info.CFBundleShortVersionString === ctx.job.version,
        "IPA_IDENTITY",
        "Exported IPA identity or version does not match this job.",
      );
      if (ctx.job.toolchain) {
        const sdk = String(info.DTSDKName ?? "").replace(/^iphoneos/, "");
        invariant(
          sdk === ctx.job.toolchain.iosSdk ||
            sdk.replace(/(?:\.0)+$/, "") ===
              ctx.job.toolchain.iosSdk.replace(/(?:\.0)+$/, ""),
          "IPA_SDK",
          `The IPA reports SDK ${info.DTSDKName ?? "unknown"}; selected iOS ${ctx.job.toolchain.iosSdk} was required.`,
        );
      }
      if (nativeTarget) {
        const bundles = [
          appPath,
          ...(await walk(appPath, (p) => p.endsWith(".appex"))),
        ];
        for (const item of selected.targets) {
          let found = false;
          for (const path of bundles) {
            const details = plist.parse(
              (
                await run(
                  "plutil",
                  ["-convert", "xml1", "-o", "-", join(path, "Info.plist")],
                  options,
                )
              ).stdout,
            ) as any;
            if (details.CFBundleIdentifier !== item.bundleId) continue;
            invariant(
              String(details.CFBundleVersion) === ctx.job.buildNumber &&
                details.CFBundleShortVersionString === ctx.job.version,
              "EXTENSION_VERSION",
              `Exported target ${item.bundleId} has a different version/build number.`,
            );
            const { decodeProfile, validateProvision } =
              await import("./signing");
            const profileData = await decodeProfile(
              (await readFile(join(path, "embedded.mobileprovision"))).toString(
                "base64",
              ),
              root,
            );
            const signed = await run(
              "codesign",
              ["-d", "--entitlements", ":-", path],
              { ...options, log: undefined },
            );
            const ent = plist.parse(
              signed.stdout.slice(signed.stdout.indexOf("<?xml")),
            ) as any;
            (ctx.job.facts!.targetEntitlements ??= {})[item.bundleId] = ent;
            validateProvision(
              profileData,
              item.bundleId,
              signing.teamId,
              ent,
              profile.distribution,
            );
            found = true;
            break;
          }
          invariant(
            found,
            "EXTENSION_MISSING",
            `Exported application is missing embedded target ${item.name} (${item.bundleId}).`,
          );
        }
      }
      await artifact(ctx, ipas[0], "ipa");
      await artifact(ctx, archive, "archive");
      const dsym = join(archive, "dSYMs");
      if (await hasFile(dsym)) await artifact(ctx, dsym, "dsym");
    }),
  );
}
export async function buildAndroid(
  ctx: BuildContext,
  profile: Profile,
  source: string,
  output: string,
  cache: string,
  options: CommandOptions,
  androidPath = "android",
) {
  await runReleaseChecks(ctx, undefined, profile, source, output, options);
  if (ctx.job.kind === "test") return;
  await privateDirectory(async (root) => {
    const android = resolve(source, androidPath);
    for (const [local, cached] of [
      [join(android, "build"), join(cache, "root-build")],
      [join(android, "app/build"), join(cache, "app-build")],
      [join(android, ".gradle"), join(cache, "gradle-project")],
    ]) {
      await mkdir(cached, { recursive: true });
      if (!(await hasFile(local))) await symlink(cached, local, "dir");
    }
    const env: NodeJS.ProcessEnv = {
      ...options.env,
      GRADLE_USER_HOME: join(
        ctx.project.settings.buildDirectory ?? ctx.store.root,
        "cache/gradle",
      ),
    };
    let signing = "";
    if (!profile.developmentClient && !profile.debugBuild) {
      ctx.stage("signing");
      const credential = await ctx.vault.get(
        ctx.project.settings.androidSigningId,
        "android",
      );
      options.secrets?.add(
        credential.storePassword,
        credential.keyPassword,
        credential.keystore,
      );
      const key = await secretFile(
        root,
        "upload.keystore",
        Buffer.from(credential.keystore, "base64"),
      );
      env.DESK_KEYSTORE = key;
      env.DESK_STORE_PASSWORD = credential.storePassword;
      env.DESK_KEY_ALIAS = credential.alias;
      env.DESK_KEY_PASSWORD = credential.keyPassword;
      await run(
        "keytool",
        [
          "-list",
          "-keystore",
          key,
          "-alias",
          credential.alias,
          "-storepass:env",
          "DESK_STORE_PASSWORD",
        ],
        { ...options, env },
      );
      signing = `def s = a.signingConfigs.create('localBuildDesk'); s.storeFile = new File(System.getenv('DESK_KEYSTORE')); s.storePassword = System.getenv('DESK_STORE_PASSWORD'); s.keyAlias = System.getenv('DESK_KEY_ALIAS'); s.keyPassword = System.getenv('DESK_KEY_PASSWORD'); a.buildTypes.each { it.signingConfig = s }`;
    }
    const init = await secretFile(
      root,
      "local-build-desk.gradle",
      ctx.project.type === "capacitor"
        ? `allprojects { p -> p.plugins.withId('com.android.application') { if (p.path == ${JSON.stringify((ctx.project.settings.androidModule ?? ":app").replace(/^([^:])/, ":$1"))}) { def ac = p.extensions.getByName('androidComponents'); ac.onVariants(ac.selector().all()) { v -> if (v.name.equalsIgnoreCase(${JSON.stringify(profile.raw.androidVariant)})) { v.outputs.each { o -> o.versionCode.set(${Number(ctx.job.buildNumber)}); o.versionName.set(${JSON.stringify(ctx.job.version)}) } } }; ac.finalizeDsl { a -> ${signing} } } } }`
        : `allprojects { p -> p.afterEvaluate { if (p.plugins.hasPlugin('com.android.application')) { def a = p.extensions.getByName('android'); a.defaultConfig.versionCode = ${Number(ctx.job.buildNumber)}; a.defaultConfig.versionName = ${JSON.stringify(ctx.job.version)}; ${profile.raw.ndk ? `a.ndkVersion = ${JSON.stringify(profile.raw.ndk)};` : ""} ${signing} } } }`,
    );
    await ensureAndroidPackages(
      appRoot(source, ctx.project.settings),
      env.ANDROID_HOME!,
      ctx.project.settings.androidSdkLicenseAccepted === true,
      { ...options, env },
      profile.raw.ndk as string | undefined,
      android,
    );
    // Gradle determines exact Java compatibility; print it before the expensive build.
    await run(join(android, "gradlew"), ["--version"], {
      ...options,
      cwd: android,
      env,
    });
    ctx.stage("compile");
    await run(
      join(android, "gradlew"),
      [
        ...gradleTasks(profile),
        "--no-daemon",
        "--console=plain",
        "--no-configuration-cache",
        "--init-script",
        init,
      ],
      { ...options, cwd: android, env },
    );
    const extension =
      profile.developmentClient || profile.buildType === "apk"
        ? ".apk"
        : ".aab";
    const candidates = (
      await walk(
        join(
          android,
          (ctx.project.settings.androidModule ?? "app")
            .replace(/^:/, "")
            .replaceAll(":", "/"),
          "build/outputs",
        ),
        (p) => p.endsWith(extension),
      )
    ).filter((p) => !p.includes("androidTest"));
    invariant(
      candidates.length === 1,
      "ANDROID_ARTIFACT",
      `Expected one ${extension} artifact; found ${candidates.length}. Configure a single Gradle variant.`,
    );
    const target = join(output, basename(candidates[0]));
    await cp(candidates[0], target);
    ctx.stage("verify");
    if (extension === ".aab") {
      const result = await run("jarsigner", ["-verify", target], {
        ...options,
        env,
      });
      invariant(
        /jar verified/i.test(result.stdout),
        "AAB_UNSIGNED",
        "The bundle signature could not be verified.",
      );
      const metadata = await readBundleManifest(target, ctx.signal);
      invariant(
        metadata.packageName === ctx.job.bundleId &&
          metadata.versionCode === ctx.job.buildNumber &&
          metadata.versionName === ctx.job.version,
        "AAB_IDENTITY",
        "The AAB package or version does not match the job.",
      );
      const local = await run(
        "keytool",
        [
          "-exportcert",
          "-rfc",
          "-keystore",
          env.DESK_KEYSTORE!,
          "-alias",
          env.DESK_KEY_ALIAS!,
          "-storepass:env",
          "DESK_STORE_PASSWORD",
        ],
        { ...options, env },
      );
      const signed = await run(
        "keytool",
        ["-printcert", "-rfc", "-jarfile", target],
        { ...options, env },
      );
      const extract = (value: string) =>
        value
          .match(
            /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/,
          )?.[1]
          .replace(/\s/g, "");
      invariant(
        extract(local.stdout) &&
          extract(local.stdout) === extract(signed.stdout),
        "AAB_CERTIFICATE",
        "The AAB is signed with a different certificate than the selected upload key.",
      );
      ctx.job.facts!.signing = createHash("sha256")
        .update(Buffer.from(extract(local.stdout)!, "base64"))
        .digest("hex");
      ctx.save();
    } else {
      const tools = await readdir(join(env.ANDROID_HOME!, "build-tools"));
      const tool = tools
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .at(-1)!;
      const apksigner = join(
        env.ANDROID_HOME!,
        "build-tools",
        tool,
        "apksigner",
      );
      const apkSignature = await run(
        apksigner,
        ["verify", "--verbose", "--print-certs", target],
        {
          ...options,
          env,
        },
      );
      ctx.job.facts!.signing = apkSignature.stdout.match(
        /certificate SHA-256 digest:\s*(\S+)/,
      )?.[1];
      if (env.DESK_KEYSTORE) {
        const local = await run(
          "keytool",
          [
            "-exportcert",
            "-rfc",
            "-keystore",
            env.DESK_KEYSTORE,
            "-alias",
            env.DESK_KEY_ALIAS!,
            "-storepass:env",
            "DESK_STORE_PASSWORD",
          ],
          { ...options, env, log: undefined },
        );
        const cert = local.stdout
          .match(
            /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/,
          )?.[1]
          .replace(/\s/g, "");
        const expected =
          cert &&
          createHash("sha256")
            .update(Buffer.from(cert, "base64"))
            .digest("hex");
        invariant(
          expected &&
            ctx.job.facts!.signing?.replaceAll(":", "").toLowerCase() ===
              expected,
          "APK_CERTIFICATE",
          "The APK is signed with a different certificate than the selected upload key.",
        );
      }
      ctx.save();
      const aapt = join(env.ANDROID_HOME!, "build-tools", tool, "aapt");
      const info = await run(aapt, ["dump", "badging", target], {
        ...options,
        env,
      });
      invariant(
        info.stdout.includes(`name='${ctx.job.bundleId}'`) &&
          info.stdout.includes(`versionCode='${ctx.job.buildNumber}'`) &&
          info.stdout.includes(`versionName='${ctx.job.version}'`),
        "APK_IDENTITY",
        "The APK package or version does not match the job.",
      );
    }
    await artifact(ctx, target, extension === ".apk" ? "apk" : "aab");
  });
}
