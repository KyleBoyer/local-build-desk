import { projectSettings } from "./project-discovery";
import {
  mkdtemp,
  rm,
  symlink,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { join, resolve, relative, dirname } from "node:path";
import { tmpdir } from "node:os";
import { hasFile, readJSON, toolEnvironment, inheritedProfile } from "./config";
import { snapshot } from "./snapshot";
import { run, type CommandOptions } from "./process";
import { invariant } from "./errors";
import {
  inside,
  inspectXcode,
  xcodeContainers,
  xcodegenSpecs,
  generateXcodeProjects,
} from "./xcode-project";
import { DeskError } from "./errors";
import type {
  ProjectSettings,
  ProjectType,
  Inspection,
  LocalBuildProfile,
  Profile,
  Platform,
} from "./types";
export const defaultLocalProfiles: Record<string, LocalBuildProfile> = {
  development: {
    configuration: "Debug",
    distribution: "internal",
    simulator: true,
    debug: true,
    autoIncrement: true,
    buildType: "apk",
  },
  preview: {
    configuration: "Release",
    distribution: "internal",
    autoIncrement: true,
    buildType: "apk",
  },
  production: {
    configuration: "Release",
    distribution: "store",
    autoIncrement: true,
    buildType: "app-bundle",
  },
};
export function appRoot(root: string, settings: ProjectSettings) {
  return inside(root, settings.appDirectory ?? ".");
}
export async function detectProjectType(
  root: string,
  settings: ProjectSettings = {},
): Promise<ProjectType> {
  settings = await projectSettings(root, settings);
  if (settings.projectType) return settings.projectType;
  const app = appRoot(root, settings),
    pkg = await readJSON(join(app, "package.json"), {}),
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.expo) return "expo";
  if (deps["@capacitor/core"]) return "capacitor";
  for (const ext of ["ts", "js", "json"])
    if (await hasFile(join(app, `capacitor.config.${ext}`))) return "capacitor";
  if ((await xcodeContainers(app)).length || (await xcodegenSpecs(app)).length)
    return "native-ios";
  throw new Error(
    "Choose an Expo, Capacitor, or native iOS repository containing an Xcode app project/workspace or XcodeGen project.yml. For an app in a subfolder, select its app directory in project settings.",
  );
}
export function resolveLocalProfile(
  profiles: Record<string, LocalBuildProfile>,
  name: string,
  platform: Platform,
  settings: ProjectSettings = {},
): Profile {
  const values = inheritedProfile(
    { build: profiles },
    name,
  ) as LocalBuildProfile;
  const debug = values.debug ?? values.configuration === "Debug",
    variant = values.androidVariant ?? (debug ? "Debug" : "Release");
  invariant(
    /^[A-Za-z][A-Za-z0-9]*$/.test(variant),
    "ANDROID_VARIANT",
    "Choose a Gradle variant name, such as Release or DemoDebug.",
  );
  const module = (settings.androidModule ?? ":app").replace(/^([^:])/, ":$1");
  const configuration =
    settings.configuration ??
    values.configuration ??
    (debug ? "Debug" : "Release");
  return {
    name,
    distribution: values.distribution ?? "store",
    developmentClient: false,
    debugBuild: debug,
    simulator: platform === "ios" && values.simulator === true,
    env: values.env ?? {},
    autoIncrement: values.autoIncrement ?? true,
    buildType: values.buildType ?? (debug ? "apk" : "app-bundle"),
    configuration,
    scheme: settings.scheme ?? values.scheme,
    gradleCommand: `${module}:${values.buildType === "apk" || debug ? "assemble" : "bundle"}${variant[0].toUpperCase() + variant.slice(1)}`,
    raw: { ...values, androidVariant: variant },
    issues: [],
  };
}
export async function projectTool(root: string, app: string, tool: string) {
  let current = app;
  while (true) {
    const file = join(current, "node_modules", tool);
    if (await hasFile(file)) return file;
    if (current === inside(root, ".")) break;
    const next = dirname(current);
    if (next === current || !next.startsWith(inside(root, "."))) break;
    current = next;
  }
  return join(app, "node_modules", tool);
}
export async function dependencyRoot(root: string, app: string) {
  let current = app;
  while (true) {
    for (const name of [
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
    ])
      if (await hasFile(join(current, name))) return current;
    if (current === inside(root, ".")) break;
    const next = dirname(current);
    if (next === current || !next.startsWith(inside(root, "."))) break;
    current = next;
  }
  return app;
}
export async function readCapacitor(
  root: string,
  settings: ProjectSettings,
  extraEnv: Record<string, string> = {},
  options: CommandOptions = {},
) {
  root = await realpath(root);
  const app = appRoot(root, settings),
    cli = await projectTool(root, app, "@capacitor/cli/bin/capacitor");
  invariant(
    await hasFile(cli),
    "INSTALL_DEPENDENCIES",
    "Capacitor dependencies are unavailable. Install this project's locked dependencies, or use Prepare dependencies in project setup; Local Build Desk never substitutes another Capacitor version.",
  );
  const result = await run(
    settings.nodePath ?? "node",
    [cli, "config", "--json"],
    {
      ...options,
      cwd: app,
      env: {
        ...toolEnvironment(settings),
        ...extraEnv,
        ...options.env,
        CAPACITOR_CLI_TELEMETRY_DISABLED: "1",
      },
      timeout: 60000,
      log: undefined,
    },
  );
  try {
    const value = JSON.parse(result.stdout.trim());
    return {
      config: value.app.extConfig,
      pkg: value.app.package,
      version: value.cli.package.version,
      iosPath: relative(root, value.ios.platformDirAbs),
      androidPath: relative(root, value.android.platformDirAbs),
      dependencyManager:
        value.ios.packageManager === "SPM"
          ? ("SPM" as const)
          : ("CocoaPods" as const),
    };
  } catch {
    throw new Error(
      "The project's Capacitor CLI did not return evaluated configuration. Check its version and capacitor.config file.",
    );
  }
}
export async function withInspectionSnapshot<T>(
  root: string,
  settings: ProjectSettings,
  operation: (copy: string) => Promise<T>,
  options: CommandOptions = {},
): Promise<T> {
  root = await realpath(root);
  const temp = await mkdtemp(join(tmpdir(), "desk-inspect-")),
    copy = join(temp, "source");
  try {
    const containers = await xcodeContainers(appRoot(root, settings));
    const required = containers.flatMap((c) => {
      const path = relative(root, join(appRoot(root, settings), c.path)),
        parent = dirname(path);
      return parent === "." ? [path] : [parent];
    });
    await snapshot(
      root,
      copy,
      { ios: true, android: true },
      options.signal,
      true,
      required,
    );
    const app = appRoot(root, settings),
      dest = appRoot(copy, settings);
    if (await hasFile(join(app, "node_modules")))
      await symlink(
        join(app, "node_modules"),
        join(dest, "node_modules"),
        "dir",
      );
    if (app !== resolve(root) && (await hasFile(join(root, "node_modules"))))
      await symlink(
        join(root, "node_modules"),
        join(copy, "node_modules"),
        "dir",
      );
    if (
      (await hasFile(join(dest, "package.json"))) &&
      !(await hasFile(
        await projectTool(copy, dest, "@capacitor/cli/bin/capacitor"),
      )) &&
      (await detectProjectType(root, settings)) === "capacitor"
    ) {
      const work = await dependencyRoot(copy, dest);
      const manager = await packageManager(work),
        locked = await hasFile(
          join(
            work,
            manager === "npm"
              ? "package-lock.json"
              : manager === "pnpm"
                ? "pnpm-lock.yaml"
                : manager === "yarn"
                  ? "yarn.lock"
                  : "bun.lock",
          ),
        );
      const args =
        manager === "npm"
          ? [locked ? "ci" : "install", "--no-audit", "--no-fund"]
          : manager === "pnpm"
            ? ["install", ...(locked ? ["--frozen-lockfile"] : [])]
            : manager === "yarn"
              ? ["install"]
              : ["install", ...(locked ? ["--frozen-lockfile"] : [])];
      await run(manager, args, {
        ...options,
        cwd: work,
        log: undefined,
        env: { ...toolEnvironment(settings), ...options.env },
        timeout: 300000,
      });
    }
    return await operation(await realpath(copy));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export async function inspectOtherProject(
  root: string,
  settings: ProjectSettings = {},
  extraEnv: Record<string, string> = {},
  options: CommandOptions = {},
): Promise<Inspection> {
  settings = await projectSettings(root, settings);
  const type = await detectProjectType(root, settings);
  const local = await readJSON(join(root, "ios-submit.json"), {});
  const effective = { ...local.settings, ...settings };
  const profiles = effective.localProfiles ?? defaultLocalProfiles;
  const specs = await xcodegenSpecs(appRoot(root, effective));
  return withInspectionSnapshot(
    root,
    effective,
    async (copy) => {
      const app = appRoot(copy, effective),
        issues: Inspection["issues"] = [];
      const result: Inspection = {
        type,
        platforms: ["ios"],
        name: root.split("/").at(-1)!,
        version: "",
        profiles: Object.keys(profiles),
        config: {},
        eas: { __local: true, build: profiles, settings: effective },
        packageManager: await packageManager(await dependencyRoot(copy, app)),
        native: { ios: true, android: type === "capacitor" },
        issues,
        appDirectory: effective.appDirectory ?? ".",
        usesXcodeGen: specs.length > 0 || undefined,
      };
      try {
        await generateXcodeProjects(app, specs, {
          ...options,
          env: { ...toolEnvironment(effective), ...extraEnv },
        });
      } catch (error) {
        if (!(error instanceof DeskError && error.code === "XCODEGEN_REQUIRED"))
          throw error;
        issues.push({
          severity: "error",
          code: error.code,
          message: error.message,
        });
      }
      if (type === "capacitor") {
        const cap = await readCapacitor(copy, effective, extraEnv, options),
          config = cap.config,
          deps = { ...cap.pkg.dependencies, ...cap.pkg.devDependencies };
        invariant(
          config.appId,
          "CAPACITOR_ID",
          "Set appId in capacitor.config before building.",
        );
        result.name = config.appName || cap.pkg.name;
        result.version = cap.pkg.version ?? "1.0.0";
        result.platforms = (["ios", "android"] as Platform[]).filter(
          (p) => !!deps[`@capacitor/${p}`],
        );
        result.bundleId = result.platforms.includes("ios")
          ? config.appId
          : undefined;
        result.packageName = result.platforms.includes("android")
          ? config.appId
          : undefined;
        result.sdk = cap.version;
        if (Number(cap.version.split(".")[0]) !== 8)
          issues.push({
            severity: "warning",
            code: "CAPACITOR_VERSION",
            message: `Capacitor ${cap.version} is installed. Version 8 is the validated baseline; this project's tooling is preserved and unsupported commands/plugins will be reported.`,
          });
        if (await hasFile(join(app, "eas.json")))
          issues.push({
            severity: "warning",
            code: "NON_EXPO_EAS_CONFIG",
            message:
              "This Capacitor project has eas.json. Local Build Desk uses its local profiles; EAS settings are not applied to this native build adapter.",
          });
        result.capacitor = {
          version: cap.version,
          webDir: config.webDir ?? "www",
          webBuildScript: effective.webBuildScript ?? "build",
          iosPath: cap.iosPath,
          androidPath: cap.androidPath,
          dependencyManager:
            effective.iosDependencyManager ??
            ((await hasFile(join(copy, cap.iosPath)))
              ? cap.dependencyManager
              : Number(cap.version.split(".")[0]) >= 8
                ? "SPM"
                : "CocoaPods"),
          plugins: (
            await Promise.all(
              Object.keys(deps)
                .filter(
                  (name) =>
                    ![
                      "@capacitor/core",
                      "@capacitor/cli",
                      "@capacitor/ios",
                      "@capacitor/android",
                    ].includes(name),
                )
                .map(async (name) => {
                  const metadata = await readJSON(
                    await projectTool(copy, app, name + "/package.json"),
                    {},
                  );
                  return metadata.capacitor || metadata.cordova
                    ? name
                    : undefined;
                }),
            )
          ).filter((name): name is string => !!name),
        };
        result.config = {
          ...config,
          name: result.name,
          version: result.version,
          ios: { ...config.ios, bundleIdentifier: result.bundleId },
          android: { ...config.android, package: result.packageName },
        };
        if (config.server?.url)
          issues.push({
            severity: "error",
            code: "CAPACITOR_SERVER_URL",
            message:
              "Store builds must bundle web assets. Remove server.url from the production Capacitor configuration; it currently loads a development server.",
          });
      }
      const inspected = await inspectXcode(
        copy,
        effective,
        { ...options, env: { ...toolEnvironment(effective), ...extraEnv } },
        false,
      );
      result.containers = inspected.containers;
      result.schemes = inspected.schemes;
      result.usesCocoaPods =
        type === "capacitor"
          ? result.capacitor?.dependencyManager === "CocoaPods"
          : (
              await Promise.all(
                result.containers.map((c) =>
                  hasFile(join(copy, c.path, "..", "Podfile")),
                ),
              )
            ).some(Boolean);
      if (inspected.selected) {
        const selected = inspected.selected;
        result.iosTarget = selected;
        const main = selected.targets.find(
          (t) => t.productType === "application",
        )!;
        if (type === "native-ios") result.name = main.name;
        result.bundleId = main.bundleId;
        result.version = main.version || result.version;
        result.config = {
          ...result.config,
          name: result.name,
          ios: {
            ...result.config.ios,
            bundleIdentifier: main.bundleId,
            buildNumber: main.buildNumber,
            entitlements: main.entitlements,
            targets: selected.targets,
          },
        };
      } else if (type === "native-ios" || inspected.containers.length)
        issues.push({
          severity: "warning",
          code: "XCODE_SELECTION",
          message: inspected.issue ?? "Choose an application scheme.",
        });
      if (type === "native-ios") {
        result.config.name = result.name;
        result.config.version = result.version;
      }
      return result;
    },
    { ...options, env: { ...toolEnvironment(effective), ...extraEnv } },
  );
}
export async function packageManager(
  app: string,
): Promise<Inspection["packageManager"]> {
  return (await hasFile(join(app, "pnpm-lock.yaml")))
    ? "pnpm"
    : (await hasFile(join(app, "yarn.lock")))
      ? "yarn"
      : (await hasFile(join(app, "bun.lock"))) ||
          (await hasFile(join(app, "bun.lockb")))
        ? "bun"
        : "npm";
}
