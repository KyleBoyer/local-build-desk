import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, isAbsolute, relative } from "node:path";
import { z } from "zod";
import { settingsSchema } from "../main/validation";
import { id, now } from "../core/database";
import { invariant } from "../core/errors";
import {
  configFileIn,
  isInvocationVariable,
  withCurrentNames,
} from "../core/naming";
import {
  bindRuntimeCredentials,
  type BuildInvocation,
} from "../core/runtime-context";
import type { Credential, Project } from "../core/types";
import type { Engine } from "../core/engine";
export type InvocationFlags = Record<
  string,
  string | boolean | string[] | undefined
>;
const fields: Record<string, string> = {
  "project-type": "projectType",
  "app-directory": "appDirectory",
  "ios-target": "iosTarget",
  configuration: "configuration",
  "web-build-script": "webBuildScript",
  "ios-dependency-manager": "iosDependencyManager",
  "android-module": "androidModule",
  xcode: "xcodePath",
  "ios-sdk": "iosSdk",
  "minimum-ios-sdk": "minimumIosSdk",
  "build-directory": "buildDirectory",
  "java-home": "javaHome",
  "android-sdk": "androidSdk",
  "node-path": "nodePath",
  track: "track",
  "asc-app-id": "ascAppId",
  workspace: "workspace",
  scheme: "scheme",
  "native-mode": "nativeMode",
  "android-sdk-license-accepted": "androidSdkLicenseAccepted",
  "play-auto-rollout": "playAutoRollout",
  "release-notes": "playReleaseNotes",
};
const booleanSettings = [
  "androidSdkLicenseAccepted",
  "setupAppleComplete",
  "playAutoRollout",
];
function readCredentialFile(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw Error(
      "Credential file unavailable. Check its path and permissions; secret contents are excluded.",
    );
  }
}
function bool(text: string): boolean {
  invariant(
    ["true", "false"].includes(text),
    "SETTING_BOOLEAN",
    "Boolean settings require true or false.",
  );
  return text === "true";
}
function json(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw Error(
      "Invalid invocation JSON. Check the configuration syntax; secret contents are excluded.",
    );
  }
}
function configAt(
  flags: InvocationFlags,
  source: string,
  env: NodeJS.ProcessEnv,
) {
  const file =
    flags.config ??
    env.LOCAL_BUILD_DESK_CONFIG ??
    configFileIn(resolve(source));
  invariant(
    typeof file === "string",
    "CONFIG",
    "Use a configuration file path.",
  );
  if (!existsSync(file)) {
    invariant(
      !flags.config && !env.LOCAL_BUILD_DESK_CONFIG,
      "CONFIG",
      "Invocation configuration file not found.",
    );
    return { value: {}, root: source };
  }
  const value = json(readFileSync(file, "utf8"));
  invariant(
    value && typeof value === "object" && !Array.isArray(value),
    "CONFIG",
    "Invocation configuration must be an object.",
  );
  return { value, root: dirname(resolve(file)) };
}
export function captureInvocationEnvironment(
  argv: string[],
  raw: NodeJS.ProcessEnv,
): Record<string, string> {
  const result: Record<string, string> = {};
  const env = withCurrentNames(raw);
  for (const [key, value] of Object.entries(env))
    if (isInvocationVariable(key) && value !== undefined) result[key] = value;
  const flag = (name: string) => {
    const entry = argv.find((value) => value.startsWith(`--${name}=`));
    const index = argv.indexOf(`--${name}`);
    return (
      entry?.slice(name.length + 3) ??
      (index >= 0 ? argv[index + 1] : undefined)
    );
  };
  const source = flag("source") ?? flag("project") ?? process.cwd();
  const config =
    flag("config") ??
    env.LOCAL_BUILD_DESK_CONFIG ??
    configFileIn(resolve(source));
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (
        ["env", "base64Env", "fileEnv"].includes(key) &&
        typeof item === "string" &&
        raw[item] !== undefined
      )
        result[item] = raw[item]!;
      else visit(item);
    }
  };
  if (existsSync(config)) visit(json(readFileSync(config, "utf8")));
  const creds =
    flag("credential-config") ?? env.LOCAL_BUILD_DESK_CREDENTIAL_CONFIG;
  if (creds && existsSync(creds)) visit(json(readFileSync(creds, "utf8")));
  if (env.LOCAL_BUILD_DESK_CREDENTIALS_JSON)
    visit(json(env.LOCAL_BUILD_DESK_CREDENTIALS_JSON));
  return result;
}
const internalCredential = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("apple"),
    label: z.string(),
    keyId: z.string().regex(/^[A-Za-z0-9]+$/),
    issuerId: z.string().uuid(),
    teamId: z.string().regex(/^[A-Za-z0-9]+$/),
    privateKey: z.string().includes("PRIVATE KEY"),
  }),
  z.object({
    kind: z.literal("ios"),
    label: z.string(),
    p12: z.string().min(1),
    password: z.string(),
    profiles: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("google"),
    label: z.string(),
    serviceAccount: z
      .object({
        type: z.literal("service_account"),
        client_email: z.string().email(),
        private_key: z.string().min(1),
      })
      .passthrough(),
  }),
  z.object({
    kind: z.literal("android"),
    label: z.string(),
    keystore: z.string().min(1),
    storePassword: z.string(),
    keyPassword: z.string(),
    alias: z.string().min(1),
  }),
  z.object({
    kind: z.literal("environment"),
    label: z.string(),
    values: z.record(z.string(), z.string()),
  }),
]);
export async function resolveInvocation(
  engine: Engine,
  flags: InvocationFlags,
  rawEnvironment: NodeJS.ProcessEnv = process.env,
  fallback?: Project,
): Promise<BuildInvocation> {
  const environment = withCurrentNames(rawEnvironment);
  const projects = engine.state().projects;
  const find = (key: unknown) => {
    if (typeof key !== "string") return undefined;
    const exact = projects.find((p) => p.id === key);
    if (exact) return exact;
    const matches = projects.filter((p) => p.path === resolve(key));
    const selected =
      flags["app-directory"] ??
      environment.LOCAL_BUILD_DESK_APP_DIRECTORY ??
      configAt(flags, String(flags.source ?? key), environment).value.settings
        ?.appDirectory;
    if (selected)
      return matches.find(
        (p) =>
          (p.settings.appDirectory ?? ".") ===
          (relative(resolve(key), resolve(key, String(selected))) || "."),
      );
    invariant(
      matches.length <= 1,
      "PROJECT_AMBIGUOUS",
      "More than one app is imported at this repository root. Use its project ID or --app-directory to choose the correct app and signing settings.",
    );
    return matches[0];
  };
  const template =
    find(
      flags["settings-from"] ??
        environment.LOCAL_BUILD_DESK_SETTINGS_FROM ??
        flags.project,
    ) ?? fallback;
  invariant(
    !(flags["settings-from"] ?? environment.LOCAL_BUILD_DESK_SETTINGS_FROM) ||
      template,
    "PROJECT_REQUIRED",
    "The --settings-from project must already be imported.",
  );
  const source = resolve(
    String(
      flags.source ??
        environment.LOCAL_BUILD_DESK_SOURCE ??
        template?.path ??
        flags.project ??
        process.cwd(),
    ),
  );
  const config = configAt(flags, source, environment);
  const settings: any = { ...template?.settings, ...config.value.settings };
  for (const key of Object.keys(settingsSchema.shape)) {
    const envName =
      "LOCAL_BUILD_DESK_" +
      key.replace(/[A-Z]/g, (value) => "_" + value).toUpperCase();
    if (environment[envName] !== undefined)
      settings[key] = booleanSettings.includes(key)
        ? bool(environment[envName]!)
        : key === "localProfiles"
          ? json(environment[envName]!)
          : environment[envName];
  }
  for (const [flag, key] of Object.entries(fields))
    if (flags[flag] !== undefined)
      settings[key] =
        booleanSettings.includes(key) && typeof flags[flag] === "string"
          ? bool(flags[flag] as string)
          : flags[flag];
  for (const assignment of (flags.set ?? []) as string[]) {
    const n = assignment.indexOf("=");
    invariant(n > 0, "SETTING", "Use --set settingName=value.");
    const key = assignment.slice(0, n),
      value = assignment.slice(n + 1);
    settings[key] = booleanSettings.includes(key)
      ? bool(value)
      : key === "localProfiles"
        ? json(value)
        : value;
  }
  const checked = settingsSchema.safeParse(settings);
  invariant(
    checked.success,
    "SETTINGS",
    "Invalid invocation settings. Use known ProjectSettings fields and valid SDK/track values.",
  );
  for (const key of [
    "xcodePath",
    "buildDirectory",
    "javaHome",
    "androidSdk",
    "nodePath",
  ] as const)
    if (settings[key] && (key !== "nodePath" || settings[key].includes("/")))
      settings[key] = resolve(config.root, settings[key]);
  invariant(
    !settings.buildDirectory ||
      (settings.buildDirectory !== source &&
        !settings.buildDirectory.startsWith(source + "/")),
    "BUILD_STORAGE",
    "Choose build storage outside the source checkout.",
  );
  let spec: any = { ...config.value.credentials };
  const credentialFile =
    flags["credential-config"] ??
    environment.LOCAL_BUILD_DESK_CREDENTIAL_CONFIG;
  let credentialRoot = config.root;
  if (credentialFile) {
    const path = resolve(String(credentialFile));
    spec = { ...spec, ...json(readCredentialFile(path).toString("utf8")) };
    credentialRoot = dirname(path);
  }
  if (environment.LOCAL_BUILD_DESK_CREDENTIALS_JSON)
    spec = { ...spec, ...json(environment.LOCAL_BUILD_DESK_CREDENTIALS_JSON) };
  const envRef = (prefix: string, binary = false): any =>
    !!environment[prefix + "_BASE64"]
      ? { base64Env: prefix + "_BASE64" }
      : !!environment[prefix + "_PATH"]
        ? { fileEnv: prefix + "_PATH" }
        : environment[prefix] !== undefined && environment[prefix] !== ""
          ? { env: prefix }
          : undefined;
  const assign = (kind: string, key: string, value: any) => {
    if (value !== undefined) spec[kind] = { ...spec[kind], [key]: value };
  };
  for (const [kind, key, envName] of [
    ["apple", "keyId", "ASC_KEY_ID"],
    ["apple", "issuerId", "ASC_ISSUER_ID"],
    ["apple", "teamId", "ASC_TEAM_ID"],
    ["apple", "privateKey", "ASC_KEY_P8"],
    ["ios", "p12", "IOS_P12"],
    ["ios", "password", "IOS_P12_PASSWORD"],
    ["google", "serviceAccount", "GOOGLE_JSON"],
    ["android", "keystore", "ANDROID_KEYSTORE"],
    ["android", "storePassword", "ANDROID_STORE_PASSWORD"],
    ["android", "keyPassword", "ANDROID_KEY_PASSWORD"],
    ["android", "alias", "ANDROID_KEY_ALIAS"],
  ])
    assign(kind, key, envRef("LOCAL_BUILD_DESK_" + envName));
  // An explicitly empty P12 password is valid; empty unconfigured credential
  // groups are ignored so template-only CI keeps using its stored credentials.
  if (spec.ios && environment.LOCAL_BUILD_DESK_IOS_P12_PASSWORD !== undefined)
    assign("ios", "password", { env: "LOCAL_BUILD_DESK_IOS_P12_PASSWORD" });
  if (environment.LOCAL_BUILD_DESK_IOS_PROFILES_BASE64)
    assign(
      "ios",
      "profiles",
      json(environment.LOCAL_BUILD_DESK_IOS_PROFILES_BASE64).map(
        (value: string) => ({
          base64: value,
        }),
      ),
    );
  if (environment.LOCAL_BUILD_DESK_IOS_PROFILES_PATHS)
    assign(
      "ios",
      "profiles",
      json(environment.LOCAL_BUILD_DESK_IOS_PROFILES_PATHS).map(
        (value: string) => ({
          file: value,
        }),
      ),
    );
  const read = (value: any, binary = false): string => {
    if (typeof value === "string") return value;
    invariant(
      value && typeof value === "object",
      "CREDENTIAL_VALUE",
      "A required credential value is missing.",
    );
    let data: string | Buffer;
    if (value.env) {
      invariant(
        environment[value.env] !== undefined,
        "CREDENTIAL_ENV",
        "A referenced credential environment variable is missing.",
      );
      data = environment[value.env]!;
    } else if (value.base64Env || value.base64) {
      const encoded = value.base64 ?? environment[value.base64Env];
      invariant(
        typeof encoded === "string" && /^[A-Za-z0-9+/\s]*={0,2}$/.test(encoded),
        "CREDENTIAL_BASE64",
        "A credential base64 value is missing or invalid.",
      );
      data = Buffer.from(encoded, "base64");
    } else {
      const file = value.file ?? environment[value.fileEnv];
      invariant(
        typeof file === "string",
        "CREDENTIAL_FILE",
        "A credential file path is missing.",
      );
      data = readCredentialFile(
        isAbsolute(file) ? file : resolve(credentialRoot, file),
      );
    }
    return Buffer.isBuffer(data)
      ? data.toString(binary ? "base64" : "utf8")
      : data;
  };
  const credentials: Credential[] = [];
  for (const kind of ["apple", "ios", "google", "android"] as const)
    if (spec[kind]) {
      const item = spec[kind],
        value: any = { kind, label: "CI invocation" };
      for (const key of kind === "apple"
        ? ["keyId", "issuerId", "teamId", "privateKey"]
        : kind === "ios"
          ? ["p12", "password"]
          : kind === "google"
            ? ["serviceAccount"]
            : ["keystore", "storePassword", "keyPassword", "alias"])
        value[key] = read(item[key], ["p12", "keystore"].includes(key));
      if (kind === "ios")
        value.profiles = (item.profiles ?? []).map((entry: any) =>
          read(entry, true),
        );
      if (kind === "google") value.serviceAccount = json(value.serviceAccount);
      const parsed = internalCredential.safeParse(value);
      invariant(
        parsed.success,
        "CREDENTIAL_INVALID",
        `Invalid ${kind} invocation credential. Check required values; secret contents are excluded.`,
      );
      credentials.push(parsed.data as Credential);
    }
  const buildEnv = {
    ...config.value.environment,
    ...(environment.LOCAL_BUILD_DESK_ENVIRONMENT_JSON
      ? json(environment.LOCAL_BUILD_DESK_ENVIRONMENT_JSON)
      : {}),
  };
  if (Object.keys(buildEnv).length)
    credentials.push({
      kind: "environment",
      label: "CI environment",
      values: Object.fromEntries(
        Object.entries(buildEnv).map(([key, value]) => [key, read(value)]),
      ),
    });
  const noKeychain =
    flags["use-keychain"] !== true &&
    (flags["no-keychain"] === true ||
      environment.LOCAL_BUILD_DESK_NO_KEYCHAIN === "true" ||
      credentials.length > 0);
  const bound = bindRuntimeCredentials(settings, credentials, noKeychain);
  const buildNumberValue =
    flags["build-number"] ??
    environment.LOCAL_BUILD_DESK_BUILD_NUMBER ??
    config.value.buildNumber;
  const buildNumber =
    buildNumberValue === undefined ? undefined : Number(buildNumberValue);
  invariant(
    buildNumber === undefined ||
      (Number.isSafeInteger(buildNumber) &&
        buildNumber > 0 &&
        buildNumber <= 2100000000),
    "BUILD_NUMBER",
    "Use an integer build number between 1 and 2,100,000,000.",
  );
  const concurrency: any = { ...config.value.concurrency };
  for (const platform of ["ios", "android"]) {
    const value =
      flags[platform + "-concurrency"] ??
      environment[
        "LOCAL_BUILD_DESK_" + platform.toUpperCase() + "_CONCURRENCY"
      ];
    if (value !== undefined) concurrency[platform] = Number(value);
    if (concurrency[platform] !== undefined)
      invariant(
        Number.isInteger(concurrency[platform]) &&
          concurrency[platform] >= 1 &&
          concurrency[platform] <= 8,
        "CONCURRENCY",
        "Concurrency must be 1–8 per platform.",
      );
  }
  return {
    project: {
      ...(template ?? {
        id: "invocation:" + id(),
        name: source.split("/").pop()!,
        profiles: [],
        createdAt: now(),
      }),
      path: source,
      settings: bound.settings,
    },
    context: bound.context,
    buildNumber,
    concurrency,
  };
}
