import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { readdir, statfs } from "node:fs/promises";
import { existsCommand, run } from "./process";
import { hasFile, toolEnvironment } from "./config";
import type { Check, ProjectSettings } from "./types";
import { sdkAtLeast } from "./xcode-toolchain";
export function iosPlatformCheck(
  sdk: string | undefined,
  runtimes: { version: string; identifier: string; isAvailable: boolean }[],
): Check {
  const matching =
    sdk &&
    runtimes.some(
      (runtime) =>
        runtime.isAvailable &&
        runtime.identifier.includes("iOS") &&
        runtime.version.split(".").slice(0, 2).join(".") ===
          sdk.split(".").slice(0, 2).join("."),
    );
  return {
    name: "iOS platform",
    status: !sdk ? "error" : matching ? "ok" : "warning",
    detail: !sdk
      ? "iOS SDK not found"
      : matching
        ? `iOS ${sdk} SDK and matching platform runtime available`
        : `iOS ${sdk} SDK is present, but its matching platform runtime is missing`,
    action: matching
      ? undefined
      : "Install the current iOS platform in Guided setup or Xcode Settings → Components. Xcode can reject generic iOS archive destinations without it.",
  };
}
export async function doctor(
  settings: ProjectSettings = {},
  platform: "ios" | "android" | "all" = "all",
  noKeychain = false,
): Promise<Check[]> {
  const env = toolEnvironment(settings);
  const sdk =
    settings.androidSdk ??
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    join(homedir(), "Library/Android/sdk");
  const results = await Promise.allSettled([
    existsCommand(settings.nodePath ?? "node", ["--version"], env),
    existsCommand("xcodebuild", ["-version"], env),
    existsCommand("pod", ["--version"], env),
    existsCommand("java", ["-version"], env),
    existsCommand("npm", ["--version"], env),
    existsCommand("git", ["--version"], env),
    existsCommand(
      "xcrun",
      ["--sdk", `iphoneos${settings.iosSdk ?? ""}`, "--show-sdk-version"],
      env,
    ),
    existsCommand("xcrun", ["simctl", "list", "runtimes", "--json"], env),
  ]);
  const value = (i: number) =>
    results[i].status === "fulfilled"
      ? (results[i] as PromiseFulfilledResult<string | undefined>).value
      : undefined;
  const check = (
    name: string,
    detail: string | undefined,
    action: string,
  ): Check => ({
    name,
    status: detail ? "ok" : "error",
    detail: detail?.split("\n").slice(0, 2).join(" · ") ?? "Not found",
    action: detail ? undefined : action,
  });
  const checks: Check[] = [
    check(
      "Node.js",
      value(0),
      "Install a Node LTS version supported by the project, then select its executable in Toolchain.",
    ),
    check(
      "Xcode",
      value(1),
      "Install Xcode, open it once, accept its license, and select its developer directory.",
    ),
    check("CocoaPods", value(2), "Install CocoaPods: brew install cocoapods"),
    check(
      "Java",
      value(3),
      "Install a JDK supported by the project Gradle version (commonly JDK 17). Select JAVA_HOME in Toolchain.",
    ),
    check("npm", value(4), "Install npm alongside the selected Node version."),
    check("Git", value(5), "Install Xcode command-line tools."),
  ];
  let runtimes = [];
  try {
    runtimes = JSON.parse(value(7) ?? "{}").runtimes ?? [];
  } catch {}
  checks.push(iosPlatformCheck(value(6), runtimes));
  const sdkVersion = value(6);
  const sdkMatches =
    !!sdkVersion &&
    (!settings.minimumIosSdk || sdkAtLeast(sdkVersion, settings.minimumIosSdk));
  checks.push({
    name: "iOS SDK",
    status: sdkMatches ? "ok" : "error",
    detail: sdkVersion
      ? `Selected iOS ${sdkVersion} SDK${settings.minimumIosSdk ? `; required ${settings.minimumIosSdk}+` : ""}`
      : "Selected iOS SDK is unavailable",
    action: sdkMatches
      ? undefined
      : "Acquire a matching Xcode in Toolchain, then select it for this project. Downloading a simulator runtime does not replace Xcode’s bundled SDK.",
  });
  let storage = resolve(
    settings.buildDirectory ??
      join(homedir(), "Library/Application Support/Local Build Desk"),
  );
  while (!(await hasFile(storage)) && storage !== dirname(storage))
    storage = dirname(storage);
  try {
    const fs = await statfs(storage);
    const availableGB = (fs.bavail * fs.bsize) / 1024 ** 3;
    checks.push({
      name: "Build storage",
      status: availableGB < 5 ? "error" : availableGB < 20 ? "warning" : "ok",
      detail: `${availableGB.toFixed(1)} GB available on ${storage}`,
      action:
        availableGB < 20
          ? "Allow at least 20 GB for source snapshots, dependencies, archives and caches. Choose a build storage folder on another disk in Toolchain."
          : undefined,
    });
  } catch {
    checks.push({
      name: "Build storage",
      status: "error",
      detail: "Build storage is unavailable",
      action: "Choose an accessible build storage folder in Toolchain.",
    });
  }
  const major = value(3)?.match(/(?:version |openjdk )"?(\d+)/)?.[1];
  if (major && +major > 21) {
    checks[3].status = "warning";
    checks[3].action =
      "Java newer than 21 may be incompatible with this project’s Gradle. Select a supported JDK; compilation will verify compatibility.";
  }
  const hasSDK =
    (await hasFile(join(sdk, "platforms"))) &&
    (await hasFile(join(sdk, "build-tools")));
  checks.push({
    name: "Android SDK",
    status: hasSDK ? "ok" : "error",
    detail: hasSDK ? sdk : "No Android platforms/build-tools found",
    action: hasSDK
      ? undefined
      : "Install Android Studio or command-line SDK tools, accept SDK licenses, and select the SDK folder.",
  });
  const ndks = await readdir(join(sdk, "ndk")).catch(() => []);
  checks.push({
    name: "Android NDK",
    status: ndks.length ? "ok" : "warning",
    detail: ndks.length ? ndks.join(", ") : "Not installed",
    action: ndks.length
      ? undefined
      : "Install the NDK version requested by the generated Android project using SDK Manager.",
  });
  if (platform !== "android" && !noKeychain)
    try {
      const identities = await run("security", [
        "find-identity",
        "-v",
        "-p",
        "codesigning",
      ]);
      const count = identities.stdout.match(
        /(\d+) valid identities found/,
      )?.[1];
      checks.push({
        name: "Apple signing",
        status: count && +count > 0 ? "ok" : "warning",
        detail: `${count ?? 0} valid identities in the default keychains`,
        action:
          "Import a distribution certificate in Signing. Builds use a private app-managed signing keychain.",
      });
    } catch {
      checks.push({
        name: "Apple signing",
        status: "warning",
        detail: "Keychain unavailable",
      });
    }
  return checks.filter(
    (check) =>
      platform === "all" ||
      !(
        platform === "ios"
          ? ["Java", "Android SDK", "Android NDK"]
          : ["Xcode", "CocoaPods", "iOS SDK", "iOS platform", "Apple signing"]
      ).includes(check.name),
  );
}
