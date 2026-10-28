import { it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import xcode from "xcode";
import { createNativeFixture } from "./fixtures/native/create";
import { configureNativeSigning } from "../src/core/native-signing";
import {
  resolveLocalProfile,
  defaultLocalProfiles,
} from "../src/core/project-adapters";
import type { IOSBuildTarget } from "../src/core/types";
import type { Provision } from "../src/core/signing";
function fixtureTarget(): IOSBuildTarget {
  return {
    container: { kind: "project", path: "DeskApp.xcodeproj" },
    scheme: "DeskFixture",
    configuration: "Release",
    targets: [
      {
        name: "DeskFixture",
        bundleId: "com.example.app",
        productType: "application",
        entitlementsFile: "App/App.entitlements",
      },
      {
        name: "DeskWidget",
        bundleId: "com.example.app.widget",
        productType: "extension",
        entitlementsFile: "Widget/Widget.entitlements",
      },
    ].map((t) => ({
      ...t,
      project: "DeskApp.xcodeproj",
      configuration: "Release",
      version: "1.2.3",
      buildNumber: "7",
      entitlements: {
        "com.apple.security.application-groups": ["group.com.example.shared"],
      },
    })) as IOSBuildTarget["targets"],
  };
}
function profile(bundle: string, uuid: string): Provision {
  return {
    UUID: uuid,
    Name: bundle,
    TeamIdentifier: ["TEAM123"],
    ExpirationDate: new Date("2099-01-01"),
    DeveloperCertificates: [],
    Entitlements: {
      "application-identifier": "TEAM123." + bundle,
      "com.apple.security.application-groups": ["group.com.example.shared"],
    },
  };
}
it("maps app and widget profiles independently, preserves Debug and modern Xcode objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-sign-targets-"));
  try {
    await createNativeFixture(root);
    const file = join(root, "DeskApp.xcodeproj/project.pbxproj"),
      parsed = xcode.project(file);
    parsed.parseSync();
    (parsed.hash.project.objects as any).PBXFileSystemSynchronizedRootGroup = {
      ABCDEF1234567890ABCDEF12: {
        isa: "PBXFileSystemSynchronizedRootGroup",
        path: "App",
        sourceTree: '"<group>"',
        explicitFileTypes: {},
        explicitFolders: [],
      },
    };
    await writeFile(file, parsed.writeSync());
    const result = await configureNativeSigning(
      root,
      fixtureTarget(),
      {
        teamId: "TEAM123",
        identity: "CERTIFICATE",
        profiles: [
          profile("com.example.app", "APP-UUID"),
          profile("com.example.app.widget", "WIDGET-UUID"),
        ],
      },
      resolveLocalProfile(defaultLocalProfiles, "production", "ios"),
    );
    expect(result).toEqual({
      "com.example.app": "APP-UUID",
      "com.example.app.widget": "WIDGET-UUID",
    });
    const after = xcode.project(file);
    after.parseSync();
    const objects = after.hash.project.objects as any;
    expect(
      objects.PBXFileSystemSynchronizedRootGroup.ABCDEF1234567890ABCDEF12.path,
    ).toBe("App");
    const configs = Object.entries<any>(objects.XCBuildConfiguration)
      .filter(([key]) => !key.endsWith("_comment"))
      .map(([, v]) => v);
    expect(
      configs
        .filter((c) => c.name === "Debug")
        .every((c) => !c.buildSettings.PROVISIONING_PROFILE_SPECIFIER),
    ).toBe(true);
    expect(
      configs
        .filter((c) => c.name === "Release")
        .map((c) => c.buildSettings.PROVISIONING_PROFILE_SPECIFIER),
    ).toEqual(expect.arrayContaining(['"APP-UUID"', '"WIDGET-UUID"']));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects missing, expired and entitlement-mismatched extension profiles before rewriting the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-sign-target-errors-"));
  try {
    await createNativeFixture(root);
    const path = join(root, "DeskApp.xcodeproj/project.pbxproj"),
      before = await readFile(path, "utf8");
    const app = profile("com.example.app", "APP-UUID"),
      widget = profile("com.example.app.widget", "WIDGET-UUID");
    for (const profiles of [
      [app],
      [app, { ...widget, ExpirationDate: new Date("2000-01-01") }],
      [
        app,
        {
          ...widget,
          Entitlements: {
            "application-identifier": "TEAM123.com.example.app.widget",
          },
        },
      ],
    ]) {
      await expect(
        configureNativeSigning(
          root,
          fixtureTarget(),
          { teamId: "TEAM123", identity: "CERTIFICATE", profiles },
          resolveLocalProfile(defaultLocalProfiles, "production", "ios"),
        ),
      ).rejects.toThrow(/DeskWidget/);
      expect(await readFile(path, "utf8")).toBe(before);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
