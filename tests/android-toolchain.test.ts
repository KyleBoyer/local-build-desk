import { it, expect } from "vitest";
import {
  installAndroidPackages,
  resolveAndroidPackagePaths,
} from "../src/core/android-toolchain";
import type { run } from "../src/core/process";
it("accepts only the approved SDK agreement for requested packages and never every repository license", async () => {
  let called = false;
  const packages = [
    "platform-tools",
    "platforms;android-37",
    "build-tools;37.0.0",
    "ndk;27.1.12297006",
  ];
  const execute: typeof run = async (_command, args, options) => {
    called = true;
    if (args.includes("--list"))
      return {
        code: 0,
        stderr: "",
        stdout: packages
          .map(
            (pkg) =>
              `${pkg.replace("android-37", "android-37.0")} | 1 | SDK package`,
          )
          .join("\n"),
      };
    expect(args).toEqual([
      "--sdk_root=/Volumes/Builds/Android/sdk",
      ...packages.map((pkg) => pkg.replace("android-37", "android-37.0")),
    ]);
    expect(args).not.toContain("--licenses");
    expect(options?.input).toBe("y\n");
    expect(options?.inputAfter?.test("Accept? (y/N):")).toBe(true);
    return { code: 0, stdout: "", stderr: "" };
  };
  await expect(
    installAndroidPackages(
      "sdkmanager",
      "/Volumes/Builds/Android/sdk",
      packages,
      false,
      {},
      execute,
    ),
  ).rejects.toThrow(/accept the Android SDK license/);
  expect(called).toBe(false);
  await installAndroidPackages(
    "sdkmanager",
    "/Volumes/Builds/Android/sdk",
    packages,
    true,
    {},
    execute,
  );
  expect(called).toBe(true);
});
it("resolves the exact base API from Google's catalog without selecting a newer minor or beta", () => {
  const catalog =
    "platforms;android-37.0 | 2 | Android SDK Platform 37.0\nplatforms;android-37.1 | 1 | Android SDK Platform 37.1\nplatforms;android-37.2-beta3 | 3 | Android SDK Platform 37.2-beta3";
  expect(resolveAndroidPackagePaths(["platforms;android-37"], catalog)).toEqual(
    ["platforms;android-37.0"],
  );
  expect(() =>
    resolveAndroidPackagePaths(["platforms;android-38"], catalog),
  ).toThrow(/does not provide platforms;android-38/);
  expect(() =>
    resolveAndroidPackagePaths(
      ["platforms;android-37"],
      catalog.replace(/^platforms;android-37\.0[^\n]+\n/, ""),
    ),
  ).toThrow(/no alternative version/);
});
