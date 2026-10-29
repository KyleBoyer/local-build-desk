import { sdkAtLeast } from "./xcode-toolchain";
import { withLock } from "./locks";
import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join, resolve, relative, dirname } from "node:path";
import {
  buildIOS,
  buildAndroid,
  installCommand,
  type BuildContext,
} from "./build";
import {
  inspectProject,
  resolveProfile,
  toolEnvironment,
  hasFile,
  fingerprint,
} from "./config";
import {
  appRoot,
  readCapacitor,
  packageManager,
  projectTool,
  dependencyRoot,
} from "./project-adapters";
import {
  inspectXcode,
  inside,
  resolveSwiftPackages,
  xcodegenSpecs,
  generateXcodeProjects,
} from "./xcode-project";
import { snapshot } from "./snapshot";
import { run, Redactor, type CommandOptions } from "./process";
import { invariant } from "./errors";
import { doctor } from "./doctor";
import { prepareApple } from "./setup";
import {
  ensureAndroidPackages,
  androidModelPackages,
} from "./android-toolchain";
import { toolProgress } from "./progress";
import { AppleAPI, GoogleAPI } from "./stores";
import { reuseKeys } from "./reuse";
import type { Profile, Project, IOSBuildTarget } from "./types";
export async function installProjectDependencies(
  app: string,
  manager: Awaited<ReturnType<typeof packageManager>>,
  options: CommandOptions,
) {
  let [command, args] = installCommand(manager);
  if (command === "npm" && !(await hasFile(join(app, "package-lock.json"))))
    args = ["install", "--no-audit", "--no-fund"];
  if (
    command === "yarn" &&
    (await run("yarn", ["--version"], options)).stdout.startsWith("1.")
  )
    args = ["install", "--frozen-lockfile"];
  await run(command, args, { ...options, cwd: app });
}
export function validateCapacitorSync(output: string) {
  const incompatible = output
    .split(/\r?\n/)
    .filter((line) =>
      /not compatible with SPM|does not have a Package\.swift|not supported.*SPM.*ignored|custom \.framework files are not supported|Found \d+ incompatible.*plugins/i.test(
        line,
      ),
    );
  invariant(
    !incompatible.length,
    "CAPACITOR_PLUGIN_INCOMPATIBLE",
    `Capacitor reported unsupported native plugins: ${incompatible.join(" ")}. Use compatible plugins or migrate the native dependency manager. Existing native projects are preserved.`,
  );
}
async function androidIdentity(
  root: string,
  profile: Profile,
  options: CommandOptions,
  module = ":app",
) {
  const script = join(root, ".desk-inspect.gradle"),
    variant = String(profile.raw.androidVariant ?? "Release");
  await writeFile(
    script,
    `import groovy.json.JsonOutput\nallprojects { p -> p.plugins.withId('com.android.application') { def variants = []; p.extensions.getByName('androidComponents').onVariants(p.extensions.getByName('androidComponents').selector().all()) { v -> variants.add(v) }; p.tasks.register('deskInspect') { doLast { def v = variants.find { it.name.equalsIgnoreCase(${JSON.stringify(variant)}) }; if (v == null) throw new GradleException('Unknown Local Build Desk variant: ${variant}'); println('LBD_ANDROID:' + JsonOutput.toJson([packageName:v.applicationId.get(),version:v.outputs.first().versionName.get(),buildNumber:v.outputs.first().versionCode.get(),compileSdk:p.extensions.getByName('android').compileSdk,buildTools:p.extensions.getByName('android').buildToolsVersion,javaVersion:p.extensions.getByName('android').compileOptions.sourceCompatibility.majorVersion,ndk:(p.extensions.getByName('android').externalNativeBuild.cmake.path || p.extensions.getByName('android').externalNativeBuild.ndkBuild.path) ? p.extensions.getByName('android').ndkVersion : null])) } } } }`,
  );
  const result = await run(
    join(root, "gradlew"),
    [
      `${module.replace(/^([^:])/, ":$1")}:deskInspect`,
      "--init-script",
      script,
      "--console=plain",
      "--no-daemon",
      "--no-configuration-cache",
    ],
    { ...options, cwd: root, log: undefined },
  );
  const value = result.stdout.match(/^LBD_ANDROID:(.+)$/m)?.[1];
  invariant(
    value,
    "ANDROID_VARIANT",
    "Gradle did not report the selected application's identity and version. Check its app module and variant.",
  );
  return JSON.parse(value) as {
    packageName: string;
    version: string;
    buildNumber: number;
    compileSdk: string | number;
    buildTools: string;
    javaVersion: string;
    ndk?: string;
  };
}
export async function buildNonExpo(ctx: BuildContext) {
  const { job, project, store, vault } = ctx;
  const imported = project.settings.envCredentialId
    ? (await vault.get(project.settings.envCredentialId, "environment")).values
    : {};
  const preflightSecrets = new Redactor();
  preflightSecrets.add(...Object.values(imported));
  ctx.stage("preflight");
  ctx.log(
    "Inspecting project configuration. First-time dependency resolution can take a few minutes…",
  );
  let inspection = await inspectProject(
    project.path,
    project.settings,
    imported,
    { signal: ctx.signal, secrets: preflightSecrets },
  );
  const profile = resolveProfile(inspection.eas, job.profile, job.platform);
  if (job.kind === "test") {
    profile.simulator = job.platform === "ios";
    profile.distribution = "internal";
    profile.debugBuild = true;
    profile.developmentClient = false;
  }
  preflightSecrets.add(...Object.values(profile.env));
  inspection = await inspectProject(
    project.path,
    {
      ...project.settings,
      configuration: profile.configuration,
      scheme: project.settings.scheme ?? profile.scheme,
    },
    { ...imported, ...profile.env },
    { signal: ctx.signal, secrets: preflightSecrets },
  );
  invariant(
    inspection.platforms?.includes(job.platform),
    "PLATFORM_UNAVAILABLE",
    `This ${inspection.type} project does not declare ${job.platform}. Add the platform dependency to the project before selecting it.`,
  );
  invariant(
    !(
      profile.distribution === "store" &&
      inspection.issues.some((i) => i.code === "CAPACITOR_SERVER_URL")
    ),
    "CAPACITOR_SERVER_URL",
    "Store builds cannot use server.url. Build and bundle production web assets in the selected profile.",
  );
  const checks = await doctor(
    project.settings,
    job.platform,
    vault.ephemeral,
    inspection.type,
    inspection.usesCocoaPods,
    inspection.usesXcodeGen,
  );
  const required =
    job.platform === "ios"
      ? ["Xcode", "iOS SDK", "Build storage"]
      : ["Java", "Android SDK", "Build storage"];
  if (inspection.type === "capacitor") required.push("Node.js");
  if (job.platform === "ios" && inspection.usesCocoaPods)
    required.push("CocoaPods");
  if (job.platform === "ios" && inspection.usesXcodeGen)
    required.push("XcodeGen");
  const failures = checks.filter(
    (c) => required.includes(c.name) && c.status === "error",
  );
  invariant(
    !failures.length,
    "TOOLCHAIN",
    failures.map((f) => `${f.name}: ${f.detail}. ${f.action ?? ""}`).join("\n"),
  );
  const storage = project.settings.buildDirectory ?? store.root,
    root = join(storage, "jobs", job.id),
    source = join(root, "source"),
    output = join(root, "artifacts");
  await mkdir(output, { recursive: true });
  ctx.stage("snapshot");
  const sourceHash = await snapshot(
    project.path,
    source,
    { ios: true, android: true },
    ctx.signal,
    true,
    inspection.capacitor
      ? [inspection.capacitor.iosPath, inspection.capacitor.androidPath]
      : (inspection.containers ?? []).flatMap((c) =>
          dirname(c.path) === "." ? [c.path] : [dirname(c.path)],
        ),
  );
  const app = appRoot(source, project.settings),
    redactor = new Redactor();
  redactor.add(...Object.values(imported), ...Object.values(profile.env));
  const options: CommandOptions = {
    cwd: app,
    env: {
      ...toolEnvironment(project.settings),
      ...imported,
      ...profile.env,
      CAPACITOR_CLI_TELEMETRY_DISABLED: "1",
      ...(job.platform === "android"
        ? {
            ANDROID_HOME:
              project.settings.androidSdk ??
              process.env.ANDROID_HOME ??
              process.env.ANDROID_SDK_ROOT ??
              join((await import("node:os")).homedir(), "Library/Android/sdk"),
          }
        : {}),
    },
    signal: ctx.signal,
    secrets: redactor,
    log: (line) => {
      ctx.log(line);
      const update = toolProgress(line, job.progress);
      if (update) ctx.progress?.(update);
    },
  };
  let iosTarget: IOSBuildTarget | undefined,
    androidPath = "android",
    generated = false;
  const initialVersion = inspection.version;
  if (job.platform === "ios")
    await generateXcodeProjects(
      app,
      await xcodegenSpecs(appRoot(project.path, project.settings)),
      options,
    );
  if (inspection.type === "capacitor") {
    ctx.stage("install");
    ctx.log("Installing the project's locked web and Capacitor dependencies…");
    const work = await dependencyRoot(source, app),
      manager = await packageManager(work);
    await withLock(`dependency-cache:${manager}:${storage}`, ctx.signal, () =>
      installProjectDependencies(work, manager, options),
    );
    ctx.stage("configure");
    const cap = await readCapacitor(
        source,
        project.settings,
        { ...imported, ...profile.env },
        options,
      ),
      script = project.settings.webBuildScript ?? "build";
    invariant(
      cap.pkg.scripts?.[script],
      "WEB_BUILD_SCRIPT",
      `Choose a package script that builds web assets. Script '${script}' is missing.`,
    );
    invariant(
      !(profile.distribution === "store" && cap.config.server?.url),
      "CAPACITOR_SERVER_URL",
      "Remove server.url from the production Capacitor configuration and bundle web assets before uploading.",
    );
    ctx.log(`Building web assets with ${manager} run ${script}…`);
    await run(manager, ["run", script], options);
    const web = inside(app, cap.config.webDir ?? "www");
    invariant(
      await hasFile(join(web, "index.html")),
      "WEB_ASSETS",
      `The web build did not produce ${cap.config.webDir ?? "www"}/index.html. Correct webDir or the selected web-build script.`,
    );
    const nativePath = inside(
        source,
        job.platform === "ios" ? cap.iosPath : cap.androidPath,
      ),
      cli = await projectTool(source, app, "@capacitor/cli/bin/capacitor");
    if (!(await hasFile(nativePath))) {
      generated = true;
      ctx.log(
        `Generating ${job.platform} inside the isolated snapshot; original source remains intact.`,
      );
      await run(
        project.settings.nodePath ?? "node",
        [
          cli,
          "add",
          job.platform,
          ...(job.platform === "ios"
            ? [
                "--packagemanager",
                project.settings.iosDependencyManager ??
                  (Number(cap.version.split(".")[0]) >= 8
                    ? "SPM"
                    : "CocoaPods"),
              ]
            : []),
        ],
        options,
      );
    }
    ctx.log(
      `Syncing Capacitor web assets and native plugins for ${job.platform}…`,
    );
    const synced = await run(
      project.settings.nodePath ?? "node",
      [
        cli,
        "sync",
        job.platform,
        ...(job.platform === "ios" &&
        (await hasFile(join(nativePath, "App/Podfile.lock")))
          ? ["--deployment"]
          : []),
      ],
      options,
    );
    validateCapacitorSync(
      redactor.redact(synced.stdout + "\n" + synced.stderr),
    );
    androidPath = cap.androidPath;
    inspection = await inspectProject(
      source,
      project.settings,
      {
        ...imported,
        ...profile.env,
      },
      options,
    );
  } else {
    ctx.stage("install");
    for (const container of inspection.containers ?? []) {
      const pod = join(source, container.path, "..", "Podfile");
      if (await hasFile(pod)) {
        ctx.log("Installing native CocoaPods dependencies in the snapshot…");
        await run(
          "pod",
          [
            "install",
            ...((await hasFile(join(pod, "..", "Podfile.lock")))
              ? ["--deployment"]
              : []),
          ],
          { ...options, cwd: resolve(pod, "..") },
        );
        break;
      }
    }
  }
  if (job.platform === "ios") {
    ctx.stage("configure");
    const selected = await inspectXcode(
      source,
      {
        ...project.settings,
        configuration: profile.configuration,
        iosTarget:
          project.settings.iosTarget ?? inspection.iosTarget?.container.path,
        scheme:
          project.settings.scheme ??
          profile.scheme ??
          inspection.iosTarget?.scheme,
      },
      options,
      true,
    );
    invariant(
      selected.selected,
      "XCODE_SELECTION",
      selected.issue ?? "Choose an Xcode application container and scheme.",
    );
    iosTarget = selected.selected;
    ctx.log("Resolving the selected scheme's Swift packages…");
    await resolveSwiftPackages(source, iosTarget, options);
    const main = iosTarget.targets.find(
      (t) => t.productType === "application",
    )!;
    job.bundleId = main.bundleId;
    job.version = generated
      ? initialVersion
      : main.version || inspection.version;
    inspection.config.ios = {
      ...inspection.config.ios,
      bundleIdentifier: main.bundleId,
      buildNumber: main.buildNumber,
      entitlements: main.entitlements,
      targets: iosTarget.targets,
    };
    inspection.iosTarget = iosTarget;
    const sdk = await run(
      "xcrun",
      [
        "--sdk",
        `iphoneos${project.settings.iosSdk ?? ""}`,
        "--show-sdk-version",
      ],
      options,
    );
    const developer =
      project.settings.xcodePath ??
      (await run("xcode-select", ["-p"], options)).stdout.trim();
    for (const target of iosTarget.targets)
      if (target.deploymentTarget)
        invariant(
          sdkAtLeast(sdk.stdout.trim(), target.deploymentTarget),
          "IOS_SDK_TOO_OLD",
          `${target.name} requires iOS ${target.deploymentTarget}, but the selected SDK is ${sdk.stdout.trim()}. Acquire a matching Xcode in Toolchain.`,
        );
    job.toolchain = {
      developerDirectory: developer,
      xcodeVersion: checks.find((c) => c.name === "Xcode")!.detail,
      iosSdk: sdk.stdout.trim(),
    };
  } else {
    const android = inside(source, androidPath);
    await ensureAndroidPackages(
      app,
      options.env!.ANDROID_HOME!,
      project.settings.androidSdkLicenseAccepted === true,
      options,
      undefined,
      android,
    );
    const info = await androidIdentity(
      android,
      profile,
      options,
      project.settings.androidModule,
    );
    await ensureAndroidPackages(
      app,
      options.env!.ANDROID_HOME!,
      project.settings.androidSdkLicenseAccepted === true,
      options,
      undefined,
      android,
      androidModelPackages(info),
    );
    const java = await run("java", ["-version"], {
      ...options,
      log: undefined,
    });
    const javaMajor = Number(
      (java.stdout + java.stderr).match(/(?:version |openjdk )"?(\d+)/)?.[1],
    );
    invariant(
      javaMajor >= Number(info.javaVersion),
      "JAVA_VERSION",
      `The selected Android variant requires JDK ${info.javaVersion}; the selected Java reports ${javaMajor || "unknown"}. Install Android tools through Guided setup or choose a compatible JAVA_HOME.`,
    );
    job.bundleId = info.packageName;
    job.version = generated
      ? initialVersion
      : info.version || inspection.version;
    inspection.config.android = {
      ...inspection.config.android,
      package: info.packageName,
      versionCode: info.buildNumber,
    };
  }
  invariant(
    job.bundleId && job.version,
    "APP_METADATA",
    "The selected native target must have an app identity and marketing version before building.",
  );
  job.projectName = inspection.name;
  job.storeEligible =
    profile.distribution === "store" &&
    !profile.simulator &&
    !profile.debugBuild;
  project.type = inspection.type;
  project.platforms = inspection.platforms;
  job.facts = {
    projectType: inspection.type,
    nativeTarget: iosTarget
      ? `${iosTarget.container.path} · ${iosTarget.scheme}`
      : String(profile.raw.androidVariant),
    configuration: profile.configuration,
    distribution: profile.distribution,
    developmentClient: false,
    simulator: profile.simulator,
    sourceHash,
    destination: profile.simulator
      ? "iOS Simulator"
      : job.storeEligible
        ? job.platform === "ios"
          ? "App Store Connect / TestFlight"
          : "Google Play"
        : "Direct installation",
    toolVersions: Object.fromEntries(
      checks.filter((c) => c.status === "ok").map((c) => [c.name, c.detail]),
    ),
  };
  const commit = await run("git", ["rev-parse", "HEAD"], {
    cwd: project.path,
    allowFailure: true,
  });
  if (/^[a-f0-9]{40}$/.test(commit.stdout.trim()))
    job.facts.sourceCommit = commit.stdout.trim();
  if (
    job.platform === "ios" &&
    !profile.simulator &&
    project.settings.appleConnectionId
  ) {
    ctx.stage("signing");
    const copyProject = { ...project, path: source };
    const scoped = new Proxy(store, {
      get(target, key) {
        if (key === "putProject")
          return (p: Project) => {
            project.settings = p.settings;
            target.putProject(project);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const report = await prepareApple(
      scoped,
      vault,
      copyProject,
      { platform: "ios", newApp: false },
      ctx.log,
      ctx.signal,
      { ...imported, ...profile.env },
      undefined,
      profile.distribution,
    );
    invariant(
      report.ready,
      "APPLE_SETUP_REQUIRED",
      report.handoffs.map((h) => `${h.title}: ${h.detail}`).join("\n"),
    );
  }
  const key = `${job.platform}:${job.bundleId}`;
  if (
    job.storeEligible &&
    job.platform === "ios" &&
    project.settings.appleConnectionId
  ) {
    const latest = await new AppleAPI(
      await vault.get(project.settings.appleConnectionId, "apple"),
      fetch,
      undefined,
      { signal: ctx.signal },
    ).latestBuild(job.bundleId);
    if (latest !== undefined) store.seed(key, latest);
  }
  if (
    job.storeEligible &&
    job.platform === "android" &&
    project.settings.googleConnectionId
  ) {
    const versions = await new GoogleAPI(
      await vault.get(project.settings.googleConnectionId, "google"),
      fetch,
      ctx.signal,
      ctx.googleGuard,
    ).existingVersions(job.bundleId);
    if (versions.length) store.seed(key, Math.max(...versions));
  }
  const configured =
    job.platform === "ios"
      ? inspection.config.ios?.buildNumber
      : inspection.config.android?.versionCode;
  invariant(
    job.kind === "test" ||
      generated ||
      /^\d+$/.test(String(configured)) ||
      job.requestedBuildNumber !== undefined ||
      store.counter(key) !== undefined,
    "BUILD_NUMBER_REQUIRED",
    "Set an explicit integer starting build number in Migration or --build-number before building this existing app.",
  );
  const initial = /^\d+$/.test(String(configured))
    ? Math.max(0, Number(configured) - 1)
    : 0;
  job.buildNumber =
    job.kind === "test"
      ? String(/^\d+$/.test(String(configured)) ? configured : 1)
      : store.claimNumber(
          key,
          job.id,
          initial,
          job.requestedBuildNumber ??
            (!profile.autoIncrement && /^\d+$/.test(String(configured))
              ? Number(configured)
              : undefined),
        );
  if (job.kind !== "test") job.versionReservation = "reserved";
  ctx.save();
  const cache = join(
    storage,
    "cache",
    fingerprint({
      type: inspection.type,
      target: iosTarget,
      profile: profile.raw,
      tools: job.facts.toolVersions,
      source: sourceHash,
    }),
  );
  await mkdir(cache, { recursive: true });
  try {
    Object.assign(
      job,
      await reuseKeys(
        project,
        await inspectProject(project.path, project.settings, {
          ...imported,
          ...profile.env,
        }),
        profile,
        job.platform,
        sourceHash,
        checks,
        vault,
        imported,
      ),
    );
  } catch {
    ctx.log(
      "Build reuse is unavailable for these inputs; continuing with a fresh build.",
    );
  }
  ctx.save();
  await withLock(`native-cache:${cache}`, ctx.signal, async () => {
    if (job.clean) await rm(cache, { recursive: true, force: true });
    await mkdir(cache, { recursive: true });
    if (job.platform === "ios")
      await buildIOS(ctx, profile, source, output, cache, options, iosTarget);
    else
      await buildAndroid(
        ctx,
        profile,
        source,
        output,
        cache,
        options,
        androidPath,
      );
  });
}
