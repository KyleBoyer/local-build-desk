import { projectSettings } from "./project-discovery";
import {
  detectProjectType,
  inspectOtherProject,
  resolveLocalProfile,
  appRoot,
  projectTool,
  dependencyRoot,
  packageManager as projectPackageManager,
} from "./project-adapters";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { run, type CommandOptions } from "./process";
import { DeskError, invariant } from "./errors";
import type {
  Inspection,
  Issue,
  Platform,
  Profile,
  ProjectSettings,
} from "./types";
export const hasFile = async (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
export const readJSON = async (p: string, fallback?: any) => {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT" && fallback !== undefined) return fallback;
    throw e;
  }
};
const plain = (value: any) =>
  value && typeof value === "object" && !Array.isArray(value);
export function merge(base: any, next: any): any {
  const out = { ...base };
  for (const [key, value] of Object.entries(next))
    out[key] =
      plain(value) && plain(base[key]) ? merge(base[key], value) : value;
  return out;
}
export function inheritedProfile(
  eas: any,
  name: string,
  seen: string[] = [],
): any {
  invariant(
    !seen.includes(name),
    "PROFILE_CYCLE",
    `Profile inheritance cycle: ${[...seen, name].join(" → ")}`,
  );
  const profile = eas.build?.[name];
  invariant(
    plain(profile),
    "PROFILE_MISSING",
    `Build profile "${name}" does not exist.`,
  );
  const parent = profile.extends
    ? inheritedProfile(eas, profile.extends, [...seen, name])
    : {};
  return merge(parent, profile);
}
const sharedFields = new Set([
  "extends",
  "env",
  "distribution",
  "developmentClient",
  "autoIncrement",
  "credentialsSource",
  "environment",
  "node",
  "yarn",
  "pnpm",
  "bun",
  "ios",
  "android",
  "cache",
  "resourceClass",
]);
const iosFields = new Set([
  "env",
  "distribution",
  "developmentClient",
  "autoIncrement",
  "credentialsSource",
  "simulator",
  "buildConfiguration",
  "scheme",
  "resourceClass",
  "image",
  "cocoapods",
  "node",
  "yarn",
  "pnpm",
  "bun",
]);
const androidFields = new Set([
  "env",
  "distribution",
  "developmentClient",
  "autoIncrement",
  "credentialsSource",
  "buildType",
  "gradleCommand",
  "resourceClass",
  "image",
  "ndk",
  "node",
  "yarn",
  "pnpm",
  "bun",
]);
export function resolveProfile(
  eas: any,
  name: string,
  platform: Platform,
): Profile {
  if (eas.__local)
    return resolveLocalProfile(eas.build, name, platform, eas.settings);
  const raw = inheritedProfile(eas, name);
  const values = merge(raw, raw[platform] ?? {});
  const issues: Issue[] = [];
  for (const key of Object.keys(raw))
    if (!sharedFields.has(key))
      issues.push({
        severity: "error",
        code: "UNSUPPORTED_FIELD",
        field: key,
        message: `Unsupported EAS build field: ${key}. Remove it in a local override before building.`,
      });
  for (const key of Object.keys(raw[platform] ?? {}))
    if (!(platform === "ios" ? iosFields : androidFields).has(key))
      issues.push({
        severity: "error",
        code: "UNSUPPORTED_FIELD",
        field: `${platform}.${key}`,
        message: `Unsupported EAS field: ${platform}.${key}.`,
      });
  for (const key of ["image", "resourceClass", "cache"])
    if (values[key] !== undefined)
      issues.push({
        severity: "warning",
        code: "CLOUD_FIELD",
        field: key,
        message: `${key} describes EAS cloud infrastructure. This Mac uses its configured local toolchain and cache.`,
      });
  for (const key of ["node", "yarn", "pnpm", "bun", "cocoapods", "ndk"])
    if (values[key] !== undefined)
      issues.push({
        severity: "info",
        code: "TOOL_VERSION",
        field: key,
        message: `Requested ${key} ${values[key]}; preflight will check the local version.`,
      });
  if (values.environment)
    issues.push({
      severity: "warning",
      code: "LOCAL_ENV_REQUIRED",
      message: `EAS environment "${values.environment}" is not downloaded automatically. Import its values in Migration.`,
    });
  if (
    values.autoIncrement &&
    ![true, "buildNumber", "versionCode", "version"].includes(
      values.autoIncrement,
    )
  )
    issues.push({
      severity: "error",
      code: "INCREMENT_UNSUPPORTED",
      message: "Unsupported autoIncrement value.",
    });
  if (values.autoIncrement === "version")
    issues.push({
      severity: "error",
      code: "MARKETING_INCREMENT",
      message:
        "Marketing-version autoIncrement is not supported. Set the app version explicitly; local counters increment buildNumber/versionCode.",
    });
  if (
    values.distribution &&
    !["internal", "store"].includes(values.distribution)
  )
    issues.push({
      severity: "error",
      code: "DISTRIBUTION",
      message: `Unsupported distribution ${values.distribution}.`,
    });
  return {
    name,
    distribution: values.distribution ?? "store",
    developmentClient: values.developmentClient === true,
    simulator: platform === "ios" && values.simulator === true,
    env: values.env ?? {},
    autoIncrement: values.autoIncrement ?? false,
    buildType:
      values.buildType ??
      (values.distribution === "internal" || values.developmentClient
        ? "apk"
        : "app-bundle"),
    configuration:
      values.buildConfiguration ??
      (values.developmentClient ? "Debug" : "Release"),
    scheme: values.scheme,
    gradleCommand: values.gradleCommand,
    raw: values,
    issues,
  };
}
export function toolEnvironment(
  settings: ProjectSettings = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    EXPO_NO_TELEMETRY: "1",
    CI: "1",
    EXPO_NO_DOTENV: "1",
  };
  if (settings.androidSdk) {
    env.ANDROID_HOME = settings.androidSdk;
    env.ANDROID_SDK_ROOT = settings.androidSdk;
  }
  if (settings.javaHome) env.JAVA_HOME = settings.javaHome;
  if (settings.xcodePath) env.DEVELOPER_DIR = settings.xcodePath;
  const prefix = [
    settings.nodePath?.replace(/\/[^/]+$/, ""),
    settings.javaHome && join(settings.javaHome, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter(Boolean);
  env.PATH = [...prefix, process.env.PATH ?? ""].join(":");
  return env;
}
export async function inspectProject(
  root: string,
  settings: ProjectSettings = {},
  extraEnv: Record<string, string> = {},
  options: CommandOptions = {},
): Promise<Inspection> {
  settings = await projectSettings(root, settings);
  const kind = await detectProjectType(root, settings);
  if (kind !== "expo")
    return inspectOtherProject(root, settings, extraEnv, options);
  const repository = root;
  root = appRoot(root, settings);
  const pkg = await readJSON(join(root, "package.json"));
  invariant(
    pkg.dependencies?.expo || pkg.devDependencies?.expo,
    "NOT_EXPO",
    "Choose an Expo project containing package.json and the expo dependency.",
  );
  const eas = await readJSON(join(root, "eas.json"), {
    build: { production: {} },
  });
  const cli = await projectTool(repository, root, "expo/bin/cli");
  invariant(
    await hasFile(cli),
    "INSTALL_DEPENDENCIES",
    "Project dependencies are missing. Install them in the project before importing it.",
  );
  const result = await run(
    settings.nodePath ?? "node",
    [cli, "config", "--json", "--type", "prebuild"],
    {
      ...options,
      cwd: root,
      log: undefined,
      env: { ...toolEnvironment(settings), ...extraEnv },
      timeout: 60000,
    },
  );
  let config: any;
  try {
    config = JSON.parse(result.stdout.trim());
  } catch {
    throw new DeskError(
      "EXPO_CONFIG",
      "Expo did not return valid JSON. Check config evaluation and dependencies.",
    );
  }
  const packageManager = await projectPackageManager(
    await dependencyRoot(repository, root),
  );
  const native = { ios: false, android: false };
  const tracked = await run("git", ["ls-files", "--", "ios", "android"], {
    cwd: root,
    allowFailure: true,
  });
  for (const platform of ["ios", "android"] as const)
    native[platform] =
      settings.nativeMode === "maintained" ||
      (settings.nativeMode !== "generated" &&
        (tracked.stdout.split("\n").some((x) => x.startsWith(`${platform}/`)) ||
          (tracked.code !== 0 && (await hasFile(join(root, platform))))));
  const issues: Issue[] = [];
  if (eas.cli?.appVersionSource === "remote")
    issues.push({
      severity: "warning",
      code: "REMOTE_COUNTER",
      message:
        "This project uses EAS remote versions. Seed local build counters in Migration before production builds.",
    });
  if (!config.ios?.bundleIdentifier)
    issues.push({
      severity: "warning",
      code: "IOS_ID",
      message: "Missing ios.bundleIdentifier.",
    });
  if (!config.android?.package)
    issues.push({
      severity: "warning",
      code: "ANDROID_ID",
      message: "Missing android.package.",
    });
  return {
    type: "expo",
    platforms: ["ios", "android"],
    name: config.name ?? pkg.name,
    version: config.version ?? "1.0.0",
    bundleId: config.ios?.bundleIdentifier,
    packageName: config.android?.package,
    sdk: pkg.dependencies?.expo ?? pkg.devDependencies?.expo,
    profiles: Object.keys(eas.build ?? {}),
    config,
    eas,
    packageManager,
    native,
    issues,
  };
}
export async function inspectIOSEntitlements(
  root: string,
  settings: ProjectSettings = {},
  extraEnv: Record<string, string> = {},
) {
  if ((await detectProjectType(root, settings)) !== "expo")
    return (
      (await inspectOtherProject(root, settings, extraEnv)).config.ios
        ?.entitlements ?? {}
    );
  const repository = root;
  root = appRoot(root, settings);
  const result = await run(
    settings.nodePath ?? "node",
    [
      await projectTool(repository, root, "expo/bin/cli"),
      "config",
      "--json",
      "--type",
      "introspect",
    ],
    {
      cwd: root,
      env: { ...toolEnvironment(settings), ...extraEnv },
      timeout: 60000,
    },
  );
  const config = JSON.parse(result.stdout.trim());
  return (
    config._internal?.modResults?.ios?.entitlements ??
    config.ios?.entitlements ??
    {}
  );
}
export function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/,
    );
    if (!match)
      throw new DeskError(
        "ENV_FORMAT",
        "Environment files must contain KEY=value lines. Export complex or multiline values as a JSON object.",
      );
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    else if (value.startsWith("'") && value.endsWith("'"))
      value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    values[match[1]] = value;
  }
  return values;
}
