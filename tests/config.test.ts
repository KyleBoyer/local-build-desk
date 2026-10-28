import { describe, it, expect } from "vitest";
import { inheritedProfile, resolveProfile, parseEnv } from "../src/core/config";
import { gradleTasks, archiveArguments } from "../src/core/build";
describe("EAS profile compatibility", () => {
  const eas = {
    build: {
      base: {
        env: { BASE: "one", OVERRIDE: "old" },
        distribution: "internal",
        android: { buildType: "apk" },
      },
      production: {
        extends: "base",
        env: { OVERRIDE: "new" },
        distribution: "store",
        autoIncrement: true,
        ios: { buildConfiguration: "Release" },
        android: { buildType: "app-bundle" },
      },
    },
  };
  it("resolves inheritance, environment and platform overrides", () => {
    const p = resolveProfile(eas, "production", "android");
    expect(p.env).toEqual({ BASE: "one", OVERRIDE: "new" });
    expect(p.distribution).toBe("store");
    expect(p.buildType).toBe("app-bundle");
    expect(p.issues).toEqual([]);
    expect(gradleTasks(p)).toEqual([":app:bundleRelease"]);
  });
  it("detects inheritance cycles and missing parents", () => {
    expect(() =>
      inheritedProfile(
        { build: { a: { extends: "b" }, b: { extends: "a" } } },
        "a",
      ),
    ).toThrow(/cycle/);
    expect(() => inheritedProfile(eas, "missing")).toThrow(/does not exist/);
  });
  it("never silently ignores unsupported or cloud-only fields", () => {
    const p = resolveProfile(
      {
        build: {
          production: {
            resourceClass: "large",
            cache: { paths: ["x"] },
            environment: "production",
            ios: { image: "latest", unknown: true },
          },
        },
      },
      "production",
      "ios",
    );
    expect(
      p.issues.some((i) => i.severity === "error" && i.field === "ios.unknown"),
    ).toBe(true);
    expect(p.issues.filter((i) => i.code === "CLOUD_FIELD")).toHaveLength(3);
    expect(p.issues.some((i) => i.code === "LOCAL_ENV_REQUIRED")).toBe(true);
  });
  it("supports development, preview, and production profiles", () => {
    for (const name of ["development", "preview", "production"]) {
      const p = resolveProfile(
        {
          build: {
            development: { developmentClient: true, distribution: "internal" },
            preview: { distribution: "internal" },
            production: { autoIncrement: true },
          },
        },
        name,
        "ios",
      );
      expect(p.issues).toEqual([]);
    }
  });
  it("parses environment exports without evaluating shell expressions", () => {
    expect(
      parseEnv(
        'export TOKEN="one two"\nLITERAL=$(echo nope)\n# comment\nRAW=yes # trailing',
      ),
    ).toEqual({ TOKEN: "one two", LITERAL: "$(echo nope)", RAW: "yes" });
    expect(() => parseEnv("broken value")).toThrow(/KEY=value/);
  });
  it("uses argument arrays for paths containing spaces", () => {
    const p = resolveProfile(eas, "production", "ios");
    const args = archiveArguments(
      "/My App/App.xcworkspace",
      "App",
      "/Build Outputs/App.xcarchive",
      "/Cache Data",
      p,
      "8",
      "1.2.3",
      "/Secret Keys/keychain",
    );
    expect(args).toContain("/My App/App.xcworkspace");
    expect(args).toContain(
      "OTHER_CODE_SIGN_FLAGS=--keychain /Secret Keys/keychain",
    );
    expect(args.at(-1)).toBe("archive");
  });
});

import { androidPackages } from "../src/core/android-toolchain";
it("detects project SDK/NDK versions and honors generated Expo overrides", () => {
  expect(
    androidPackages(
      'compileSdk = "37"\nbuildTools = "37.0.0"\nndkVersion = "27.1.12297006"',
      "",
    ),
  ).toEqual([
    "platform-tools",
    "platforms;android-37",
    "build-tools;37.0.0",
    "ndk;27.1.12297006",
  ]);
  expect(
    androidPackages(
      'compileSdk = "37"',
      "android.compileSdkVersion=36\nandroid.buildToolsVersion=36.0.1",
      "28.0.1",
    ),
  ).toContain("build-tools;36.0.1");
});
