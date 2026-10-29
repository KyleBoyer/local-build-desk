import { it, expect, vi } from "vitest";
import * as processTools from "../src/core/process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { iosPlatformCheck, doctor } from "../src/core/doctor";

// Keep this platform-filter test independent of the host's available disk space.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  statfs: vi.fn(async () => ({ bavail: 100 * 1024 ** 2, bsize: 1024 })),
}));

it("distinguishes an installed SDK from an available matching iOS platform", () => {
  expect(iosPlatformCheck(undefined, []).status).toBe("error");
  expect(iosPlatformCheck("26.5", []).status).toBe("warning");
  expect(
    iosPlatformCheck("26.5", [
      {
        identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
        version: "26.4",
        isAvailable: true,
      },
    ]).status,
  ).toBe("warning");
  expect(
    iosPlatformCheck("26.5", [
      {
        identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
        version: "26.5",
        isAvailable: false,
      },
    ]).status,
  ).toBe("warning");
  expect(
    iosPlatformCheck("26.5", [
      {
        identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
        version: "26.5",
        isAvailable: true,
      },
    ]).status,
  ).toBe("ok");
});

it("filters unrelated platform errors and does not inspect the Keychain for vault-free CI", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-doctor-"));
  await mkdir(join(root, "platforms"));
  await mkdir(join(root, "build-tools"));
  const exists = vi
    .spyOn(processTools, "existsCommand")
    .mockImplementation(async (command) =>
      command === "xcodebuild" || command === "pod" || command === "xcrun"
        ? undefined
        : command === "java"
          ? 'openjdk version "17"'
          : "v26",
    );
  const run = vi.spyOn(processTools, "run");
  try {
    const android = await doctor({ androidSdk: root }, "android", true);
    expect(android.some((check) => check.status === "error")).toBe(false);
    expect(android.map((check) => check.name)).not.toContain("Xcode");
    const ios = await doctor({ androidSdk: root }, "ios", true);
    expect(ios.find((check) => check.name === "Xcode")?.status).toBe("error");
    expect(ios.map((check) => check.name)).not.toContain("Java");
    expect(run).not.toHaveBeenCalled();
  } finally {
    exists.mockRestore();
    run.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
