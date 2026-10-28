import { withLock } from "./locks";
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
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
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
import { snapshot } from "./snapshot";
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
    profile.developmentClient
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
) {
  return [
    "-workspace",
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
  if (info.isFile())
    return {
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      size: info.size,
    };
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
  const pkg = await readJSON(join(project.path, "package.json"));
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
  if (job.platform === "android" && !profile.developmentClient)
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
      ).versions(identity);
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
  job.buildNumber = store.claimNumber(
    key,
    job.id,
    initial ??
      (job.requestedBuildNumber !== undefined
        ? job.requestedBuildNumber - 1
        : undefined),
    fixed,
  );
  job.versionReservation = "reserved";
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
  const sourceHash = await snapshot(
    project.path,
    source,
    inspection.native,
    ctx.signal,
  );
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
    cwd: source,
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
      () => run(command, args, options),
    );
    const expo = join(source, "node_modules/expo/bin/cli");
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
      await rm(join(source, file), { force: true });
    await writeFile(
      join(source, "app.json"),
      JSON.stringify({ expo: config }, null, 2),
    );
    if (!inspection.native[job.platform])
      await run(
        project.settings.nodePath ?? "node",
        [expo, "prebuild", "--no-install", "--platform", job.platform],
        options,
      );
    const cacheKey = fingerprint({
      lock: await readFile(
        join(
          source,
          inspection.packageManager === "npm"
            ? "package-lock.json"
            : inspection.packageManager === "pnpm"
              ? "pnpm-lock.yaml"
              : inspection.packageManager === "yarn"
                ? "yarn.lock"
                : (await hasFile(join(source, "bun.lock")))
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
          run("pod", ["install"], { ...options, cwd: join(source, "ios") }),
        );
        await hook("eas-build-post-install");
        await buildIOS(ctx, profile, source, output, cache, options);
      } else {
        await hook("eas-build-post-install");
        await buildAndroid(ctx, profile, source, output, cache, options);
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
async function buildIOS(
  ctx: BuildContext,
  profile: Profile,
  source: string,
  output: string,
  cache: string,
  options: CommandOptions,
) {
  const iosRoot = join(source, "ios");
  const entries = await readdir(iosRoot);
  const workspace = ctx.project.settings.workspace
    ? resolve(iosRoot, ctx.project.settings.workspace)
    : join(iosRoot, entries.find((x) => x.endsWith(".xcworkspace")) ?? "");
  invariant(
    workspace !== iosRoot && (await hasFile(workspace)),
    "WORKSPACE_MISSING",
    "No Xcode workspace found. Select one in project settings.",
  );
  const schemes = await run(
    "xcodebuild",
    ["-list", "-json", "-workspace", workspace],
    options,
  );
  const available = JSON.parse(schemes.stdout).workspace?.schemes ?? [];
  const scheme =
    ctx.project.settings.scheme ??
    profile.scheme ??
    (available.length === 1
      ? available[0]
      : available.find(
          (x: string) => x === ctx.project.name.replace(/[^A-Za-z0-9]/g, ""),
        ));
  invariant(
    scheme,
    "SCHEME_REQUIRED",
    `Choose an Xcode scheme in project settings. Available: ${available.join(", ")}`,
  );
  if (profile.simulator) {
    ctx.stage("compile");
    await run(
      "xcodebuild",
      [
        "-workspace",
        workspace,
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
      const profiles = await configureIOSSigning(
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
      await artifact(ctx, ipas[0], "ipa");
      await artifact(ctx, archive, "archive");
      const dsym = join(archive, "dSYMs");
      if (await hasFile(dsym)) await artifact(ctx, dsym, "dsym");
    }),
  );
}
async function buildAndroid(
  ctx: BuildContext,
  profile: Profile,
  source: string,
  output: string,
  cache: string,
  options: CommandOptions,
) {
  await privateDirectory(async (root) => {
    const android = join(source, "android");
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
    if (!profile.developmentClient) {
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
      `allprojects { p -> p.afterEvaluate { if (p.plugins.hasPlugin('com.android.application')) { def a = p.extensions.getByName('android'); a.defaultConfig.versionCode = ${Number(ctx.job.buildNumber)}; a.defaultConfig.versionName = ${JSON.stringify(ctx.job.version)}; ${profile.raw.ndk ? `a.ndkVersion = ${JSON.stringify(profile.raw.ndk)};` : ""} ${signing} } } }`,
    );
    await ensureAndroidPackages(
      source,
      env.ANDROID_HOME!,
      ctx.project.settings.androidSdkLicenseAccepted === true,
      { ...options, env },
      profile.raw.ndk as string | undefined,
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
      await walk(join(android, "app/build/outputs"), (p) =>
        p.endsWith(extension),
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
      await run(apksigner, ["verify", "--verbose", "--print-certs", target], {
        ...options,
        env,
      });
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
