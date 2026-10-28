import { it, expect, vi } from "vitest";
import plist from "plist";
import {
  parseADB,
  listInstallTargets,
  installAndLaunch,
} from "../src/core/devices";
import type { Artifact, InstallTarget } from "../src/core/types";
const artifact: Artifact = {
  id: "artifact",
  jobId: "job",
  platform: "ios",
  kind: "app",
  path: "/fixture/App.app",
  sha256: "a".repeat(64),
  size: 10,
  bundleId: "com.example.fixture",
  version: "1.0",
  buildNumber: "1",
};
const target: InstallTarget = {
  id: "sim:AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  kind: "ios-simulator",
  name: "Fixture iPhone",
  detail: "Shutdown",
  available: true,
};
it("boots the exact simulator, installs a verified compatible app and launches its bundle", async () => {
  const commands: any[] = [];
  const execute = vi.fn(async (cmd: string, args: string[]) => {
    commands.push([cmd, ...args]);
    return {
      code: 0,
      stderr: "",
      stdout:
        cmd === "plutil"
          ? plist.build({
              CFBundleIdentifier: artifact.bundleId,
              CFBundleVersion: "1",
              CFBundleShortVersionString: "1.0",
              CFBundleSupportedPlatforms: ["iPhoneSimulator"],
            })
          : args[1] === "launch"
            ? `${artifact.bundleId}: 4242\n`
            : cmd === "/bin/ps"
              ? "4242\n"
              : "",
    };
  });
  await installAndLaunch(
    artifact,
    target,
    { xcodePath: "/Fixture/Xcode.app/Contents/Developer" },
    new AbortController().signal,
    () => {},
    execute,
  );
  expect(commands.filter((c) => c[0] === "xcrun").map((c) => c[2])).toEqual([
    "boot",
    "bootstatus",
    "install",
    "launch",
  ]);
  expect(commands.find((c) => c.includes("launch"))).toContain(
    artifact.bundleId,
  );
  expect(commands.at(-1)).toContain(
    "/Fixture/Xcode.app/Contents/Developer/Applications/Simulator.app",
  );
  expect(commands.every((c) => !c.includes("booted"))).toBe(true);
});
it("reports an app that exits right after the simulator launches it", async () => {
  const commands: string[][] = [];
  const execute = vi.fn(async (cmd: string, args: string[]) => {
    commands.push([cmd, ...args]);
    if (cmd === "plutil")
      return {
        code: 0,
        stderr: "",
        stdout: plist.build({
          CFBundleIdentifier: artifact.bundleId,
          CFBundleVersion: "1",
          CFBundleShortVersionString: "1.0",
          CFBundleSupportedPlatforms: ["iPhoneSimulator"],
        }),
      };
    if (cmd === "/bin/ps") return { code: 1, stderr: "", stdout: "" };
    return {
      code: 0,
      stderr: "",
      stdout: args[1] === "launch" ? `${artifact.bundleId}: 4242\n` : "",
    };
  });
  await expect(
    installAndLaunch(
      artifact,
      target,
      { xcodePath: "/Fixture/Xcode.app/Contents/Developer" },
      new AbortController().signal,
      () => {},
      execute,
    ),
  ).rejects.toMatchObject({ code: "APP_LAUNCH" });
  expect(commands.some((c) => c[0] === "/usr/bin/open")).toBe(false);
});
it("rejects a physical-device binary before booting or installing it", async () => {
  const execute = vi.fn(async () => ({
    code: 0,
    stderr: "",
    stdout: plist.build({
      CFBundleIdentifier: artifact.bundleId,
      CFBundleVersion: "1",
      CFBundleShortVersionString: "1.0",
      CFBundleSupportedPlatforms: ["iPhoneOS"],
    }),
  }));
  await expect(
    installAndLaunch(
      artifact,
      target,
      {},
      new AbortController().signal,
      () => {},
      execute,
    ),
  ).rejects.toThrow(/not the expected/);
  expect(execute).toHaveBeenCalledTimes(1);
});
it("keeps unauthorized Android devices visible with a specific handoff", () => {
  expect(
    parseADB(
      "List of devices attached\nphone unauthorized model:Pixel_9\nemulator-5554 device model:Pixel\n",
    )[0],
  ).toMatchObject({
    available: false,
    detail: expect.stringContaining("allow USB debugging"),
  });
});
it("does not erase an app with a different Android signing key", async () => {
  const commands: any[] = [];
  const execute = vi.fn(async (cmd: string, args: string[]) => {
    commands.push(args);
    return {
      code: args.includes("install") ? 1 : 0,
      stderr: args.includes("install")
        ? "INSTALL_FAILED_UPDATE_INCOMPATIBLE"
        : "",
      stdout: args.includes("getprop") ? "1" : "Success",
    };
  });
  await expect(
    installAndLaunch(
      {
        ...artifact,
        kind: "apk",
        platform: "android",
        path: "/fixture/app.apk",
      },
      {
        id: "adb:phone",
        kind: "android-device",
        name: "Phone",
        available: true,
        detail: "",
      },
      { androidSdk: "/SDK" },
      new AbortController().signal,
      () => {},
      execute,
    ),
  ).rejects.toThrow(/different signing key/);
  expect(
    commands.some((c) => c.includes("uninstall") || c.includes("-d")),
  ).toBe(false);
});
for (const [running, outcome] of [
  [true, "keeps"],
  [false, "reports"],
] as const)
  it(`${outcome} an Android app ${running ? "that stays running" : "that exits right after launching"}`, async () => {
    const commands: string[][] = [];
    const execute = vi.fn(async (_cmd: string, args: string[]) => {
      commands.push(args);
      return {
        code: args.includes("pidof") && !running ? 1 : 0,
        stderr: "",
        stdout: args.includes("getprop")
          ? "1"
          : args.includes("pidof")
            ? running
              ? "4242\n"
              : ""
            : args.includes("resolve-activity")
              ? "priority=0 preferredOrder=0\ncom.example.fixture/.MainActivity\n"
              : args.includes("start")
                ? "Status: ok\nLaunchState: COLD\n"
                : "Success",
      };
    });
    const launch = installAndLaunch(
      {
        ...artifact,
        kind: "apk",
        platform: "android",
        path: "/fixture/app.apk",
      },
      {
        id: "adb:phone",
        kind: "android-device",
        name: "Phone",
        available: true,
        detail: "",
      },
      { androidSdk: "/SDK" },
      new AbortController().signal,
      () => {},
      execute,
    );
    if (running) await launch;
    else await expect(launch).rejects.toMatchObject({ code: "APP_LAUNCH" });
    expect(commands).toContainEqual([
      "-s",
      "phone",
      "shell",
      "am",
      "start",
      "-W",
      "-n",
      "com.example.fixture/.MainActivity",
    ]);
    expect(commands.at(-1)).toEqual([
      "-s",
      "phone",
      "shell",
      "pidof",
      artifact.bundleId,
    ]);
  });
it("surfaces missing tools and routes store-only artifacts to their distribution channel", async () => {
  expect((await listInstallTargets({}, "aab")).notes[0]).toContain(
    "Google Play",
  );
  const execute = vi.fn(async () => {
    throw Error("missing");
  });
  expect((await listInstallTargets({}, "app", execute)).notes[0]).toContain(
    "Xcode",
  );
});
