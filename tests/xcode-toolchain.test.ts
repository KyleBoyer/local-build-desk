import { it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  sdkAtLeast,
  supportsIosSdk,
  installIosPlatform,
  xcodeFirstLaunchCommand,
} from "../src/core/xcode-toolchain";
import { run } from "../src/core/process";
import { startXcodeDownload } from "../src/main/xcode-automation";
it("compares SDK versions numerically and rejects an older or invalid SDK", () => {
  expect(sdkAtLeast("27.2", "27.2")).toBe(true);
  expect(sdkAtLeast("27.1", "27.2")).toBe(false);
  expect(sdkAtLeast("26.5", "27.2")).toBe(false);
  expect(sdkAtLeast("27.10", "27.2")).toBe(true);
  expect(sdkAtLeast("27.2.0", "27.2")).toBe(true);
  expect(sdkAtLeast("unknown", "27.2")).toBe(false);
});
it("pins the requested runtime and verifies that installation made it available", async () => {
  const calls: { command: string; args: string[] }[] = [];
  let available = false,
    finishInstall = true;
  const execute: typeof run = async (command, args) => {
    calls.push({ command, args });
    if (command === "xcodebuild" && finishInstall) available = true;
    return {
      code: 0,
      stderr: "",
      stdout:
        command === "xcrun"
          ? JSON.stringify({
              runtimes: [
                {
                  identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-2",
                  version: "27.2",
                  isAvailable: available,
                },
                {
                  identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
                  version: "26.5",
                  isAvailable: true,
                },
              ],
            })
          : "",
    };
  };
  await installIosPlatform("27.2", {}, execute);
  expect(calls[1]).toEqual({
    command: "xcodebuild",
    args: [
      "-downloadPlatform",
      "iOS",
      "-buildVersion",
      "27.2",
      "-architectureVariant",
      process.arch === "arm64" ? "arm64" : "universal",
    ],
  });
  calls.length = 0;
  await installIosPlatform("27.2", {}, execute);
  expect(calls.map((call) => call.command)).toEqual(["xcrun"]);
  available = false;
  finishInstall = false;
  await expect(installIosPlatform("27.2", {}, execute)).rejects.toThrow(
    /27.2 platform is unavailable/,
  );
  await expect(
    installIosPlatform("27.2", {}, async () => {
      throw new Error("network interrupted");
    }),
  ).rejects.toThrow(/network interrupted/);
});
it("quotes verified Xcode paths as a single shell value and rejects newlines", async () => {
  const path = "/tmp/O'Brien $(echo unsafe)`echo unsafe`/Contents/Developer";
  const command = xcodeFirstLaunchCommand(path);
  const probe = command
    .split(" && ")[0]
    .replace(
      "/usr/bin/xcodebuild -license accept",
      "/usr/bin/printenv DEVELOPER_DIR",
    );
  expect((await run("/bin/sh", ["-c", probe])).stdout.trim()).toBe(path);
  expect(() => xcodeFirstLaunchCommand("/tmp/Xcode\n.app")).toThrow(
    /unsupported characters/,
  );
});
it("automates the requested Apple Xcode archive download and ignores older versions and other hosts", () => {
  const dom = new JSDOM(
    '<a id="old" href="https://download.developer.apple.com/Developer_Tools/Xcode_26.6/Xcode_26.6.xip">Download</a><a id="unsafe" href="https://example.com/Xcode_27.2.xip">Download</a><a id="target" href="https://developer.apple.com/services-account/download?path=/Developer_Tools/Xcode_27.2_Release_Candidate/Xcode_27.2_Release_Candidate.xip">Download Xcode 27.2 RC</a>',
    {
      url: "https://developer.apple.com/download/applications/",
      runScripts: "outside-only",
    },
  );
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
    get: () => 100,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
  });
  const clicked: string[] = [];
  for (const anchor of dom.window.document.querySelectorAll("a"))
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      clicked.push(anchor.id);
    });
  const result = dom.window.eval(
    `(${startXcodeDownload.toString()})("27.2")`,
  ) as ReturnType<typeof startXcodeDownload>;
  expect(result.done).toBe(true);
  expect(clicked).toEqual(["target"]);
});

it("uses installed SDKs without an implicit minimum and respects project requirements", () => {
  expect(supportsIosSdk({ iosSdks: ["18.0"] })).toBe(true);
  expect(supportsIosSdk({ iosSdks: [] })).toBe(false);
  expect(supportsIosSdk({ iosSdks: ["18.0"] }, "18.1")).toBe(false);
  expect(supportsIosSdk({ iosSdks: ["18.2"] }, "18.1")).toBe(true);
});
