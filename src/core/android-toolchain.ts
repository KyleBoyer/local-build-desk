import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hasFile } from "./config";
import { run, type CommandOptions } from "./process";
import { invariant } from "./errors";
export function androidPackages(
  catalog: string,
  properties: string,
  ndkOverride?: string,
): string[] {
  const get = (name: string) =>
    catalog.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
  const prop = (name: string) =>
    properties
      .match(new RegExp(`^android\\.${name}\\s*=\\s*([^\\r\\n]+)`, "m"))?.[1]
      .trim();
  const compile = prop("compileSdkVersion") ?? get("compileSdk") ?? "36";
  const tools =
    prop("buildToolsVersion") ?? get("buildTools") ?? `${compile}.0.0`;
  const ndk = ndkOverride ?? prop("ndkVersion") ?? get("ndkVersion");
  invariant(
    /^\d+(?:\.\d+)?$/.test(compile) &&
      /^\d+(?:\.\d+){1,2}$/.test(tools) &&
      (!ndk || /^\d+(?:\.\d+){1,2}$/.test(ndk)),
    "ANDROID_VERSIONS",
    "The Android toolchain contains an invalid SDK/NDK version.",
  );
  return [
    "platform-tools",
    `platforms;android-${compile}`,
    `build-tools;${tools}`,
    ...(ndk ? [`ndk;${ndk}`] : []),
  ];
}
export async function projectAndroidPackages(
  root: string,
  ndkOverride?: string,
  androidRoot = join(root, "android"),
) {
  const catalog = await readFile(
    join(root, "node_modules/react-native/gradle/libs.versions.toml"),
    "utf8",
  ).catch(() => "");
  const properties = await readFile(
    join(androidRoot, "gradle.properties"),
    "utf8",
  ).catch(() => "");
  const variables = await readFile(
    join(androidRoot, "variables.gradle"),
    "utf8",
  ).catch(() => "");
  const application = (
    await Promise.all(
      [
        "build.gradle",
        "build.gradle.kts",
        "app/build.gradle",
        "app/build.gradle.kts",
      ].map((p) => readFile(join(androidRoot, p), "utf8").catch(() => "")),
    )
  ).join("\n");
  const versionCatalog = await readFile(
    join(androidRoot, "gradle/libs.versions.toml"),
    "utf8",
  ).catch(() => "");
  const native =
    variables + "\n" + application + "\n" + properties + "\n" + versionCatalog;
  const number = (name: string) =>
    native.match(
      new RegExp(`\\b${name}\\s*(?:=|\\s)\\s*["']?(\\d+(?:\\.\\d+)*)`),
    )?.[1];
  const compile = number("compileSdkVersion") ?? number("compileSdk");
  if (compile)
    return [
      "platform-tools",
      `platforms;android-${compile}`,
      `build-tools;${number("buildToolsVersion") ?? compile + ".0.0"}`,
      ...(ndkOverride ||
      (/externalNativeBuild|cmake|ndkBuild/.test(native) &&
        number("ndkVersion"))
        ? [`ndk;${ndkOverride ?? number("ndkVersion")}`]
        : []),
    ];
  const pkg = await readFile(join(root, "package.json"), "utf8")
    .then(JSON.parse)
    .catch(() => ({}));
  if (
    pkg.dependencies?.["@capacitor/core"] ||
    pkg.devDependencies?.["@capacitor/core"]
  )
    return ["platform-tools"];
  return androidPackages(catalog, properties, ndkOverride);
}
export async function ensureAndroidPackages(
  root: string,
  sdk: string,
  accepted: boolean,
  options: CommandOptions,
  ndkOverride?: string,
  androidRoot?: string,
  requestedPackages?: string[],
) {
  const packages =
    requestedPackages ??
    (await projectAndroidPackages(root, ndkOverride, androidRoot));
  const missing: string[] = [];
  for (const pkg of packages)
    if (
      !(await hasFile(join(sdk, ...pkg.split(";")))) &&
      !(
        /^platforms;android-\d+$/.test(pkg) &&
        (await hasFile(join(sdk, ...`${pkg}.0`.split(";"))))
      )
    )
      missing.push(pkg);
  if (!missing.length) return;
  invariant(
    accepted,
    "ANDROID_PACKAGES",
    `Missing Android packages: ${missing.join(", ")}. Review and accept the SDK license in Guided setup to allow automatic installation, or install these in SDK Manager.`,
  );
  const local = join(sdk, "cmdline-tools/latest/bin/sdkmanager");
  const manager = (await hasFile(local)) ? local : "sdkmanager";
  options.log?.(`Installing project Android packages: ${missing.join(", ")}`);
  await installAndroidPackages(manager, sdk, missing, accepted, options);
}
export async function installAndroidPackages(
  manager: string,
  sdk: string,
  packages: string[],
  accepted: boolean,
  options: CommandOptions,
  execute: typeof run = run,
) {
  invariant(
    accepted,
    "ANDROID_LICENSE",
    "Review and accept the Android SDK license before installing packages.",
  );
  const catalog = await execute(manager, [`--sdk_root=${sdk}`, "--list"], {
    ...options,
    log: undefined,
  });
  const resolved = resolveAndroidPackagePaths(packages, catalog.stdout);
  resolved.forEach((pkg, index) => {
    if (pkg !== packages[index])
      options.log?.(
        `Resolved ${packages[index]} to Google's base API package ${pkg}.`,
      );
  });
  // Accept only the agreement presented for these requested packages. Never
  // accept every unrelated repository license through sdkmanager --licenses.
  await execute(manager, [`--sdk_root=${sdk}`, ...resolved], {
    ...options,
    input: "y\n",
    inputAfter: /Accept\?\s*\(y\/N\):/i,
  });
}
export function resolveAndroidPackagePaths(
  packages: string[],
  catalog: string,
) {
  const available = new Set(
    [...catalog.matchAll(/^\s*([^|\r\n]+?)\s*\|/gm)].map((match) =>
      match[1].trim(),
    ),
  );
  return packages.map((pkg) => {
    if (available.has(pkg)) return pkg;
    // New platform releases use a major.minor directory. API N is exactly N.0,
    // never N.1, a preview codename, or the newest SDK in the repository.
    if (/^platforms;android-\d+$/.test(pkg) && available.has(`${pkg}.0`))
      return `${pkg}.0`;
    invariant(
      false,
      "ANDROID_PACKAGE_UNAVAILABLE",
      `Google's SDK catalog does not provide ${pkg}. Check the project's requested SDK/NDK version; no alternative version was installed.`,
    );
  });
}

export async function requiredAndroidJava(root: string) {
  const pkg = await readFile(join(root, "package.json"), "utf8")
    .then(JSON.parse)
    .catch(() => ({}));
  const cap =
    pkg.dependencies?.["@capacitor/core"] ??
    pkg.devDependencies?.["@capacitor/core"];
  const native = await Promise.all(
    [
      "android/app/build.gradle",
      "android/app/build.gradle.kts",
      "android/build.gradle",
      "android/build.gradle.kts",
      "node_modules/@capacitor/android/capacitor/build.gradle",
    ].map((p) => readFile(join(root, p), "utf8").catch(() => "")),
  );
  const versions = [
    ...native
      .join("\n")
      .matchAll(
        /(?:JavaVersion\.VERSION_|JavaLanguageVersion\.of\(|jvmTarget\s*=\s*["'])(\d+)/g,
      ),
  ].map((m) => Number(m[1]));
  return versions.length
    ? Math.max(17, ...versions)
    : cap && Number(String(cap).match(/\d+/)?.[0]) >= 8
      ? 21
      : 17;
}

export function androidModelPackages(model: {
  compileSdk: string | number;
  buildTools: string;
  ndk?: string;
}) {
  const sdk = String(model.compileSdk).replace(/^android-/, "");
  invariant(
    /^\d+$/.test(sdk) &&
      /^\d+(?:\.\d+){1,2}$/.test(model.buildTools) &&
      (!model.ndk || /^\d+(?:\.\d+){1,2}$/.test(model.ndk)),
    "ANDROID_MODEL",
    "Gradle did not report valid compile SDK/build tools requirements. Check the selected application module and variant.",
  );
  return [
    "platform-tools",
    `platforms;android-${sdk}`,
    `build-tools;${model.buildTools}`,
    ...(model.ndk ? [`ndk;${model.ndk}`] : []),
  ];
}
