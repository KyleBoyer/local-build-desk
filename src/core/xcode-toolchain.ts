import { readdir, mkdir, mkdtemp, rename, rm, statfs } from "node:fs/promises";
import { join, basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { run, type CommandOptions } from "./process";
import { hasFile, toolEnvironment } from "./config";
import { invariant } from "./errors";
import type { ProjectSettings } from "./types";

export interface XcodeInstallation {
  developerDirectory: string;
  version: string;
  build: string;
  iosSdks: string[];
  selected: boolean;
}
export interface XcodeInstallResult {
  installation: XcodeInstallation;
  requiresLicense: boolean;
  licenseText?: string;
}
export function sdkAtLeast(actual: string, minimum: string) {
  const left = actual.split(".").map(Number),
    right = minimum.split(".").map(Number);
  if (
    !/^\d+(?:\.\d+){0,2}$/.test(actual) ||
    !/^\d+(?:\.\d+){0,2}$/.test(minimum)
  )
    return false;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0))
      return (left[i] ?? 0) > (right[i] ?? 0);
  }
  return true;
}
export async function inspectXcode(
  developerDirectory: string,
): Promise<XcodeInstallation> {
  const metadata = await run("plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    join(developerDirectory, "../version.plist"),
  ]);
  const version = JSON.parse(metadata.stdout);
  const sdks = await readdir(
    join(developerDirectory, "Platforms/iPhoneOS.platform/Developer/SDKs"),
  );
  return {
    developerDirectory,
    version: version.CFBundleShortVersionString,
    build: version.ProductBuildVersion,
    iosSdks: sdks.flatMap(
      (name) => name.match(/^iPhoneOS([\d.]+)\.sdk$/)?.slice(1) ?? [],
    ),
    selected: false,
  };
}
export async function discoverXcodes(settings: ProjectSettings = {}) {
  const candidates = new Set<string>();
  const scan = async (root: string, depth: number): Promise<void> => {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = join(root, entry.name);
      if (
        entry.name.endsWith(".app") &&
        (await hasFile(join(path, "Contents/Developer/usr/bin/xcodebuild")))
      )
        candidates.add(join(path, "Contents/Developer"));
      else if (depth > 0 && !entry.name.endsWith(".app"))
        await scan(path, depth - 1);
    }
  };
  await Promise.all([
    scan("/Applications", 0),
    scan(join(homedir(), "Applications"), 0),
    ...(settings.buildDirectory
      ? [scan(join(settings.buildDirectory, "toolchains"), 2)]
      : []),
  ]);
  const active = await run("xcode-select", ["-p"], { allowFailure: true });
  if (active.stdout.trim()) candidates.add(active.stdout.trim());
  if (settings.xcodePath) candidates.add(settings.xcodePath);
  const results = await Promise.allSettled([...candidates].map(inspectXcode));
  return results
    .flatMap((result) =>
      result.status === "fulfilled"
        ? [
            {
              ...result.value,
              selected:
                resolve(result.value.developerDirectory) ===
                resolve(settings.xcodePath ?? active.stdout.trim()),
            },
          ]
        : [],
    )
    .sort(
      (a, b) =>
        a.version.localeCompare(b.version, undefined, { numeric: true }) * -1,
    );
}
export function supportsIosSdk(
  installation: Pick<XcodeInstallation, "iosSdks">,
  minimum?: string,
) {
  return installation.iosSdks.some((sdk) => sdkAtLeast(sdk, minimum || "0"));
}
export async function installXcodeArchive(
  path: string,
  settings: ProjectSettings,
  acceptLicense: boolean,
  options: CommandOptions & {
    onPrepared?: (installation: XcodeInstallation) => void;
  } = {},
): Promise<XcodeInstallResult> {
  invariant(
    settings.buildDirectory,
    "XCODE_STORAGE",
    "Choose a build storage folder with enough space for Xcode in Toolchain first.",
  );
  const root = join(settings.buildDirectory, "toolchains");
  await mkdir(root, { recursive: true, mode: 0o700 });
  let app = path;
  if (path.toLowerCase().endsWith(".xip")) {
    const free = await statfs(root);
    invariant(
      free.bavail * free.bsize >= 15 * 1024 ** 3,
      "XCODE_SPACE",
      "Allow at least 15 GB free for Xcode expansion, in addition to the downloaded archive.",
    );
    const stage = await mkdtemp(join(root, "extract-"));
    try {
      options.log?.(
        "Expanding the signed Xcode archive. Apple-origin verification follows before any Xcode executable runs…",
      );
      await run("/usr/bin/xip", ["--expand", resolve(path)], {
        ...options,
        cwd: stage,
      });
      const name = (await readdir(stage)).find((name) =>
        /^Xcode.*\.app$/.test(name),
      );
      invariant(
        name,
        "XCODE_ARCHIVE",
        "The archive did not contain an Xcode application.",
      );
      app = join(stage, name);
      await verifyAppleXcode(app, options);
      const installation = await inspectXcode(join(app, "Contents/Developer"));
      const target = join(
        root,
        `Xcode-${installation.version}-${installation.build}.app`,
      );
      if (await hasFile(target)) {
        await verifyAppleXcode(target, options);
        app = target;
      } else {
        await rename(app, target);
        app = target;
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  } else {
    invariant(
      basename(app).endsWith(".app"),
      "XCODE_ARCHIVE",
      "Choose an Apple Xcode .xip archive or application.",
    );
    await verifyAppleXcode(app, options);
  }
  const developerDirectory = join(app, "Contents/Developer");
  let installation = await inspectXcode(developerDirectory);
  invariant(
    supportsIosSdk(installation, settings.minimumIosSdk),
    "XCODE_SDK",
    `Xcode ${installation.version} does not include ${settings.minimumIosSdk ? `the required iOS ${settings.minimumIosSdk}+ SDK` : "an iOS device SDK"}.`,
  );
  const env = {
    ...toolEnvironment(settings),
    DEVELOPER_DIR: developerDirectory,
  };
  options.onPrepared?.(installation);
  const firstLaunch = await run("xcodebuild", ["-checkFirstLaunchStatus"], {
    env,
    allowFailure: true,
  });
  if (firstLaunch.code !== 0 && !acceptLicense) {
    let file = join(app, "Contents/Resources/en.lproj/License.rtf");
    if (!(await hasFile(file)))
      file = join(app, "Contents/Resources/English.lproj/License.rtf");
    const license = await run(
      "textutil",
      ["-convert", "txt", "-stdout", file],
      { allowFailure: true },
    );
    return {
      installation,
      requiresLicense: true,
      licenseText:
        license.stdout ||
        "Review the Xcode and Apple SDKs Agreement in Xcode before accepting.",
    };
  }
  if (firstLaunch.code !== 0) {
    options.log?.(
      "Completing Xcode first launch using the license approval you provided…",
    );
    await completeXcodeFirstLaunch(developerDirectory, options);
  }
  const sdk = [...installation.iosSdks]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1)!;
  await installIosPlatform(sdk, { ...options, env });
  installation = await inspectXcode(developerDirectory);
  return { installation, requiresLicense: false };
}
export async function installIosPlatform(
  sdk: string,
  options: CommandOptions,
  execute: typeof run = run,
) {
  invariant(
    /^\d+(?:\.\d+){0,2}$/.test(sdk),
    "XCODE_SDK",
    "Select a valid iOS SDK before installing its platform.",
  );
  const available = async () => {
    const result = await execute(
      "xcrun",
      ["simctl", "list", "runtimes", "--json"],
      { ...options, log: undefined },
    );
    return (JSON.parse(result.stdout).runtimes ?? []).some(
      (runtime: {
        identifier: string;
        version: string;
        isAvailable: boolean;
      }) =>
        runtime.isAvailable &&
        runtime.identifier.includes("iOS") &&
        runtime.version.split(".").slice(0, 2).join(".") ===
          sdk.split(".").slice(0, 2).join("."),
    );
  };
  if (await available()) {
    options.log?.(`iOS ${sdk} platform is already available; reusing it.`);
    return;
  }
  options.log?.(`Downloading and installing the matching iOS ${sdk} platform…`);
  await execute(
    "xcodebuild",
    [
      "-downloadPlatform",
      "iOS",
      "-buildVersion",
      sdk,
      "-architectureVariant",
      process.arch === "arm64" ? "arm64" : "universal",
    ],
    options,
  );
  invariant(
    await available(),
    "XCODE_PLATFORM",
    `Xcode finished downloading, but the iOS ${sdk} platform is unavailable. Check the component installation log and retry; the project SDK selection has not changed.`,
  );
  options.log?.(`Verified available iOS ${sdk} platform runtime.`);
}

export function xcodeFirstLaunchCommand(developerDirectory: string) {
  invariant(
    !/[\r\n\0]/.test(developerDirectory),
    "XCODE_PATH",
    "The Xcode path contains unsupported characters.",
  );
  const quoted = "'" + developerDirectory.replace(/'/g, "'\\''") + "'";
  const tool = `/usr/bin/env DEVELOPER_DIR=${quoted} /usr/bin/xcodebuild`;
  return `${tool} -license accept && ${tool} -runFirstLaunch`;
}
async function completeXcodeFirstLaunch(
  developerDirectory: string,
  options: CommandOptions,
) {
  const command = xcodeFirstLaunchCommand(developerDirectory);
  const cached = await run("/usr/bin/sudo", ["-n", "/bin/sh", "-c", command], {
    ...options,
    allowFailure: true,
  });
  if (cached.code === 0) return;
  invariant(
    /password.*required|terminal.*required|no tty|not allowed|superuser/i.test(
      cached.stderr,
    ),
    "XCODE_FIRST_LAUNCH",
    `Xcode first launch failed: ${cached.stderr.slice(-3000)}`,
  );
  options.log?.(
    "macOS administrator authentication is required to accept the approved Xcode license and install Apple’s first-launch components. Enter it in the native macOS dialog.",
  );
  await run(
    "/usr/bin/osascript",
    [
      "-e",
      `do shell script ${JSON.stringify(command)} with administrator privileges with prompt "Local Build Desk needs to finish the verified Xcode installation."`,
    ],
    options,
  );
}
async function verifyAppleXcode(app: string, options: CommandOptions) {
  options.log?.("Verifying Xcode’s code signature and Apple origin…");
  await run(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", app],
    options,
  );
  await run(
    "/usr/bin/codesign",
    [
      "--verify",
      "-R",
      '=identifier "com.apple.dt.Xcode" and (anchor apple or (anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.9]) or (anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "59GAB85EFG"))',
      app,
    ],
    options,
  );
}
