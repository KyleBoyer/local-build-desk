import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import plist from "plist";
import { run, type CommandOptions } from "./process";
import { toolEnvironment } from "./config";
import { invariant } from "./errors";
import { withLock } from "./locks";
import type { Artifact, InstallTarget, ProjectSettings } from "./types";
export type Executor = typeof run;
const sdkRoot = (settings: ProjectSettings) =>
  settings.androidSdk ??
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  join(homedir(), "Library/Android/sdk");
export function parseADB(output: string): InstallTarget[] {
  return output
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const match = line
        .trim()
        .match(/^(\S+)\s+(device|offline|unauthorized)\b(.*)$/);
      if (!match) return [];
      return [
        {
          id: "adb:" + match[1],
          kind: "android-device" as const,
          name: (match[3].match(/model:(\S+)/)?.[1] ?? match[1]).replaceAll(
            "_",
            " ",
          ),
          available: match[2] === "device",
          detail:
            match[2] === "unauthorized"
              ? "Unlock the device and allow USB debugging for this Mac."
              : match[2] === "offline"
                ? "Reconnect this device."
                : "Connected · Android",
        },
      ];
    });
}
export async function listInstallTargets(
  settings: ProjectSettings,
  kind: Artifact["kind"],
  execute: Executor = run,
) {
  const targets: InstallTarget[] = [],
    notes: string[] = [];
  const options = { env: toolEnvironment(settings), timeout: 20000 };
  if (kind === "app") {
    try {
      const result = await execute(
        "xcrun",
        ["simctl", "list", "devices", "available", "--json"],
        options,
      );
      const devices = JSON.parse(result.stdout).devices ?? {};
      for (const [runtime, items] of Object.entries(devices))
        if (runtime.includes(".iOS-"))
          for (const item of items as any[])
            if (item.isAvailable)
              targets.push({
                id: "sim:" + item.udid,
                kind: "ios-simulator",
                name: item.name,
                available: true,
                detail:
                  runtime.split(".").at(-1)!.replaceAll("-", " ") +
                  " · " +
                  item.state,
              });
      if (!targets.length)
        notes.push(
          "Install an iOS simulator runtime in Toolchain or Xcode Components.",
        );
    } catch {
      notes.push(
        "iOS simulators are unavailable. Check the selected Xcode and its first-launch components.",
      );
    }
  } else if (kind === "apk") {
    try {
      targets.push(
        ...parseADB(
          (
            await execute(
              join(sdkRoot(settings), "platform-tools/adb"),
              ["devices", "-l"],
              options,
            )
          ).stdout,
        ),
      );
    } catch {
      notes.push(
        "Android Platform Tools are missing. Install Android tools through Guided setup.",
      );
    }
    try {
      const result = await execute(
        join(sdkRoot(settings), "emulator/emulator"),
        ["-list-avds"],
        options,
      );
      for (const name of result.stdout.trim().split("\n").filter(Boolean))
        if (/^[A-Za-z0-9_.-]+$/.test(name))
          targets.push({
            id: "avd:" + name,
            kind: "android-avd",
            name,
            available: true,
            detail: "Start or reuse this Android emulator",
          });
    } catch {
      notes.push(
        "No Android emulator tool is available. Connect a device with USB debugging, or configure an emulator in Android Studio.",
      );
    }
    if (!targets.length)
      notes.push(
        "Connect and authorize an Android device, or create an Android virtual device in Android Studio.",
      );
  } else
    notes.push(
      kind === "ipa"
        ? "Store IPAs install through TestFlight. Build an iOS Simulator profile for one-click local testing."
        : "AABs install through Google Play. Build an internal APK for one-click local testing.",
    );
  return { targets, notes };
}
async function detached(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: "ignore",
      detached: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
export async function installAndLaunch(
  artifact: Artifact,
  target: InstallTarget,
  settings: ProjectSettings,
  signal: AbortSignal,
  progress: (label: string) => void,
  execute: Executor = run,
  launchEmulator = detached,
) {
  const options: CommandOptions = {
    env: toolEnvironment(settings),
    signal,
    timeout: 180000,
  };
  if (target.kind === "ios-simulator") {
    invariant(
      artifact.kind === "app" && /^sim:[a-f0-9-]{16,64}$/i.test(target.id),
      "INSTALL_TARGET",
      "Choose a simulator application and a valid iOS simulator.",
    );
    const info = plist.parse(
      (
        await execute(
          "plutil",
          ["-convert", "xml1", "-o", "-", join(artifact.path, "Info.plist")],
          options,
        )
      ).stdout,
    ) as any;
    invariant(
      info.CFBundleIdentifier === artifact.bundleId &&
        String(info.CFBundleVersion) === artifact.buildNumber &&
        info.CFBundleShortVersionString === artifact.version &&
        (info.CFBundleSupportedPlatforms?.includes("iPhoneSimulator") ||
          info.DTPlatformName === "iphonesimulator"),
      "INSTALL_IDENTITY",
      "This application is not the expected iOS Simulator build.",
    );
    const id = target.id.slice(4);
    progress("Starting iOS simulator · first boot may take a minute");
    const boot = await execute("xcrun", ["simctl", "boot", id], {
      ...options,
      allowFailure: true,
    });
    invariant(
      boot.code === 0 ||
        /booted|current state: Booted/i.test(boot.stderr + boot.stdout),
      "SIMULATOR_BOOT",
      "The simulator could not start. Check Xcode Components and retry.",
    );
    await execute("xcrun", ["simctl", "bootstatus", id, "-b"], options);
    progress("Installing simulator app");
    await execute("xcrun", ["simctl", "install", id, artifact.path], options);
    progress("Launching app");
    const launch = await execute(
      "xcrun",
      [
        "simctl",
        "launch",
        "--terminate-running-process",
        id,
        artifact.bundleId,
      ],
      options,
    );
    // simctl reports success even when the app crashes during startup.
    const pid = /:\s*(\d+)\s*$/.exec(launch.stdout.trim())?.[1];
    invariant(
      pid,
      "APP_LAUNCH",
      "The simulator did not report a running app. Open it in Simulator and inspect its logs.",
    );
    await wait(2500, undefined, { signal });
    const alive = await execute("/bin/ps", ["-p", pid, "-o", "pid="], {
      ...options,
      allowFailure: true,
    });
    invariant(
      alive.code === 0 && alive.stdout.trim() === pid,
      "APP_LAUNCH",
      "The app exited right after launching. Check its crash log in Console, or start the development server first if this is a development build.",
    );
    const developerDirectory =
      settings.xcodePath ??
      (await execute("/usr/bin/xcode-select", ["-p"], options)).stdout.trim();
    if (developerDirectory)
      await execute(
        "/usr/bin/open",
        ["-a", join(developerDirectory, "Applications/Simulator.app")],
        { ...options, allowFailure: true },
      );
    return;
  }
  invariant(
    artifact.kind === "apk" &&
      /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(artifact.bundleId),
    "INSTALL_ARTIFACT",
    "Choose an APK with a valid Android package.",
  );
  const sdk = sdkRoot(settings),
    adb = join(sdk, "platform-tools/adb");
  let serial = target.id.slice(4);
  if (target.kind === "android-avd") {
    invariant(
      /^[A-Za-z0-9_.-]+$/.test(serial),
      "INSTALL_TARGET",
      "Invalid Android virtual device name.",
    );
    const avd = serial;
    serial = await withLock("android-emulator-ports", signal, async () => {
      const connected = parseADB(
        (await execute(adb, ["devices", "-l"], options)).stdout,
      );
      for (const device of connected.filter(
        (d) => d.available && d.id.startsWith("adb:emulator-"),
      )) {
        const id = device.id.slice(4),
          result = await execute(adb, ["-s", id, "emu", "avd", "name"], {
            ...options,
            allowFailure: true,
            timeout: 5000,
          });
        if (
          result.stdout
            .split("\n")
            .map((v) => v.trim())
            .includes(avd)
        )
          return id;
      }
      const used = new Set(connected.map((d) => d.id.slice(4)));
      let port = 5554;
      while (used.has("emulator-" + port)) port += 2;
      invariant(
        port <= 5584,
        "EMULATOR_PORT",
        "All standard emulator ports are busy. Close an unused emulator and retry.",
      );
      progress("Starting Android emulator · first boot may take a minute");
      await launchEmulator(
        join(sdk, "emulator/emulator"),
        ["-avd", avd, "-port", String(port)],
        options.env!,
      );
      const deadline = Date.now() + 60000;
      while (
        !parseADB(
          (
            await execute(adb, ["devices", "-l"], {
              ...options,
              timeout: 10000,
            })
          ).stdout,
        ).some((device) => device.id === "adb:emulator-" + port)
      ) {
        invariant(
          Date.now() < deadline,
          "EMULATOR_START",
          "The emulator did not connect to ADB. Refresh devices after it finishes starting.",
        );
        await wait(1000, undefined, { signal });
      }
      return "emulator-" + port;
    });
  }
  invariant(
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(serial),
    "INSTALL_TARGET",
    "Invalid Android device identifier.",
  );
  progress("Waiting for Android device");
  const deadline = Date.now() + 180000;
  while (true) {
    signal.throwIfAborted();
    const response = await execute(
      adb,
      ["-s", serial, "shell", "getprop", "sys.boot_completed"],
      { ...options, allowFailure: true, timeout: 10000 },
    );
    if (response.stdout.trim() === "1") break;
    invariant(
      !/unauthorized/.test(response.stderr),
      "DEVICE_AUTH",
      "Unlock the phone and approve USB debugging for this Mac.",
    );
    invariant(
      Date.now() < deadline,
      "DEVICE_BOOT",
      "The Android device did not become ready. Unlock it and retry.",
    );
    await wait(1000, undefined, { signal });
  }
  progress("Installing APK · existing app data is preserved");
  const install = await execute(
    adb,
    ["-s", serial, "install", "-r", artifact.path],
    { ...options, allowFailure: true },
  );
  invariant(
    install.code === 0 && /Success/.test(install.stdout),
    "APK_INSTALL",
    /UPDATE_INCOMPATIBLE/.test(install.stderr + install.stdout)
      ? "The installed app uses a different signing key. Use a matching APK; the app will not uninstall or erase it automatically."
      : `APK installation failed. ${install.stderr || install.stdout}`,
  );
  progress("Launching Android app");
  // Implicit starts require CATEGORY_DEFAULT, which launcher activities
  // (including Expo's MainActivity) usually omit, so resolve the component.
  const resolved = await execute(
    adb,
    [
      "-s",
      serial,
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-a",
      "android.intent.action.MAIN",
      "-c",
      "android.intent.category.LAUNCHER",
      artifact.bundleId,
    ],
    { ...options, allowFailure: true, timeout: 10000 },
  );
  const component = resolved.stdout.trim().split("\n").at(-1)?.trim() ?? "";
  invariant(
    resolved.code === 0 &&
      component.startsWith(artifact.bundleId + "/") &&
      /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(component),
    "APP_LAUNCH",
    "The APK installed but has no launcher activity. Open it on the device and inspect its manifest.",
  );
  const launch = await execute(
    adb,
    ["-s", serial, "shell", "am", "start", "-W", "-n", component],
    { ...options, allowFailure: true },
  );
  invariant(
    launch.code === 0 && !/\bError:/.test(launch.stdout + launch.stderr),
    "APP_LAUNCH",
    "The APK installed but its launcher activity could not start. Open it on the device and inspect its logs.",
  );
  // am start -W reports success even when the app crashes right after starting.
  await wait(2500, undefined, { signal });
  const alive = await execute(
    adb,
    ["-s", serial, "shell", "pidof", artifact.bundleId],
    { ...options, allowFailure: true, timeout: 10000 },
  );
  invariant(
    /^\d+/.test(alive.stdout.trim()),
    "APP_LAUNCH",
    "The app exited right after launching. Check its crash in logcat, or start the development server first if this is a development build.",
  );
}
