import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectProjectType,
  inspectOtherProject,
  defaultLocalProfiles,
  resolveLocalProfile,
} from "../src/core/project-adapters";
import { settingsSchema } from "../src/core/settings-schema";
import { snapshot } from "../src/core/snapshot";
import {
  projectAndroidPackages,
  requiredAndroidJava,
} from "../src/core/android-toolchain";
it("detects a native iOS project without JavaScript files and does not mistake a standalone Swift package for an app", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-detect-"));
  try {
    await writeFile(join(root, "Package.swift"), "// swift-tools-version: 6.0");
    await expect(detectProjectType(root)).rejects.toThrow(/Xcode/);
    await mkdir(join(root, "App/App.xcodeproj"), { recursive: true });
    expect(await detectProjectType(root)).toBe("native-ios");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { expo: "58" } }),
    );
    expect(await detectProjectType(root)).toBe("expo");
    expect(await detectProjectType(root, { projectType: "native-ios" })).toBe(
      "native-ios",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("reads the project's evaluated Capacitor config in a copy, preserves iOS-only availability and reports store live-reload configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-cap-config-"));
  try {
    await mkdir(join(root, "node_modules/@capacitor/cli/bin"), {
      recursive: true,
    });
    const pkg = {
      name: "web-fixture",
      version: "1.2.3",
      dependencies: { "@capacitor/core": "8.6.0", "@capacitor/ios": "8.6.0" },
      devDependencies: { "@capacitor/cli": "8.6.0" },
      scripts: { build: "vite build" },
    };
    await writeFile(join(root, "package.json"), JSON.stringify(pkg));
    await writeFile(
      join(root, "capacitor.config.ts"),
      "// evaluated by installed project tooling",
    );
    await writeFile(
      join(root, "node_modules/@capacitor/cli/bin/capacitor"),
      `const path=require('path');const cwd=process.cwd();console.log(JSON.stringify({app:{package:${JSON.stringify(pkg)},extConfig:{appId:'com.example.cap',appName:'Web Fixture',webDir:'custom-dist',server:{url:'http://localhost:5173'}}},cli:{package:{version:'8.6.0'}},ios:{platformDirAbs:path.join(cwd,'native/ios'),packageManager:'SPM'},android:{platformDirAbs:path.join(cwd,'native/android')}}));`,
    );
    const before = await snapshot(
      root,
      join(tmpdir(), "desk-detect-hash"),
      { ios: true, android: true },
      undefined,
      false,
    );
    const result = await inspectOtherProject(root);
    expect(result.type).toBe("capacitor");
    expect(result.platforms).toEqual(["ios"]);
    expect(result.bundleId).toBe("com.example.cap");
    expect(result.packageName).toBeUndefined();
    expect(result.capacitor).toMatchObject({
      webDir: "custom-dist",
      iosPath: "native/ios",
      dependencyManager: "SPM",
    });
    expect(result.issues.some((i) => i.code === "CAPACITOR_SERVER_URL")).toBe(
      true,
    );
    expect(
      await snapshot(
        root,
        join(tmpdir(), "desk-detect-hash2"),
        { ios: true, android: true },
        undefined,
        false,
      ),
    ).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("separates ordinary development builds from Expo clients and resolves native variants and local profile inheritance", () => {
  const ios = resolveLocalProfile(defaultLocalProfiles, "development", "ios");
  expect(ios).toMatchObject({
    developmentClient: false,
    debugBuild: true,
    simulator: true,
    configuration: "Debug",
  });
  const android = resolveLocalProfile(
    {
      ...defaultLocalProfiles,
      demo: {
        extends: "development",
        androidVariant: "demoDebug",
        env: { APP_ENV: "test" },
      },
    },
    "demo",
    "android",
    { androidModule: ":mobile" },
  );
  expect(android.gradleCommand).toBe(":mobile:assembleDemoDebug");
  expect(android.env.APP_ENV).toBe("test");
  expect(() =>
    resolveLocalProfile(
      { a: { extends: "b" }, b: { extends: "a" } },
      "a",
      "ios",
    ),
  ).toThrow(/cycle/);
  expect(
    settingsSchema.safeParse({
      localProfiles: { production: { androidVariant: "Release; rm -rf" } },
    }).success,
  ).toBe(false);
});
it("detects Capacitor SDK and Java requirements without falling back to React Native SDK/NDK defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-cap-tools-"));
  try {
    await mkdir(join(root, "platforms/android/app"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "@capacitor/core": "^8.6.0" } }),
    );
    await writeFile(
      join(root, "platforms/android/variables.gradle"),
      "ext { compileSdkVersion = 37; minSdkVersion = 24 }",
    );
    await writeFile(
      join(root, "platforms/android/app/build.gradle"),
      "android { compileOptions { sourceCompatibility JavaVersion.VERSION_21 } }",
    );
    expect(
      await projectAndroidPackages(
        root,
        undefined,
        join(root, "platforms/android"),
      ),
    ).toEqual(["platform-tools", "platforms;android-37", "build-tools;37.0.0"]);
    expect(await requiredAndroidJava(root)).toBe(21);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("can inspect generated snapshots inside a parent repository's ignored storage without dropping configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-ignored-snapshot-"));
  try {
    const { run } = await import("../src/core/process");
    await run("git", ["init", "--quiet", root]);
    await writeFile(join(root, ".gitignore"), "storage/\n");
    const source = join(root, "storage/source"),
      destination = join(root, "copy");
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "capacitor.config.json"),
      JSON.stringify({ appId: "com.example.fixture" }),
    );
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ name: "fixture" }),
    );
    await mkdir(join(source, ".browser-info"));
    await writeFile(
      join(source, ".browser-info/.p"),
      "fixture-private-password",
    );
    await snapshot(source, destination, { ios: true, android: true });
    expect(
      JSON.parse(
        await readFile(join(destination, "capacitor.config.json"), "utf8"),
      ).appId,
    ).toBe("com.example.fixture");
    await expect(
      readFile(join(destination, ".browser-info/.p")),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("imports an XcodeGen-only repository and reports a missing XcodeGen install instead of failing", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-xcodegen-missing-"));
  const { createXcodeGenFixture } = await import("./fixtures/native/create");
  const process = await import("../src/core/process");
  const original = process.existsCommand;
  const { vi } = await import("vitest");
  const spy = vi
    .spyOn(process, "existsCommand")
    .mockImplementation((command, ...rest) =>
      command === "xcodegen"
        ? Promise.resolve(undefined)
        : original(command, ...rest),
    );
  try {
    await createXcodeGenFixture(root);
    expect(await detectProjectType(root)).toBe("native-ios");
    const inspection = await inspectOtherProject(root);
    expect(inspection.usesXcodeGen).toBe(true);
    expect(inspection.issues.map((i) => i.code)).toContain("XCODEGEN_REQUIRED");
    expect(inspection.iosTarget).toBeUndefined();
  } finally {
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
