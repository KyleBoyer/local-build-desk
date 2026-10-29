import { it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plist from "plist";
import {
  xcodeContainers,
  resolvedTargets,
  expandBuildSetting,
  inside,
} from "../src/core/xcode-project";
it("discovers nested Capacitor and native containers without internal workspaces or Pods", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-xcode-list-"));
  try {
    for (const path of [
      "ios/App/App.xcodeproj/project.xcworkspace",
      "ios/App/App.xcworkspace",
      "ios/App/Pods/Pods.xcodeproj",
      "Native/Other.xcodeproj",
    ])
      await mkdir(join(root, path), { recursive: true });
    expect((await xcodeContainers(root)).map((c) => c.path)).toEqual(
      [
        "ios/App/App.xcodeproj",
        "ios/App/App.xcworkspace",
        "Native/Other.xcodeproj",
      ].sort((a, b) => a.localeCompare(b)),
    );
    expect(() => inside(root, "../secret")).toThrow(/inside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("uses resolved identities and entitlements for app and extensions while excluding frameworks and tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-xcode-targets-"));
  try {
    await writeFile(
      join(root, "App.entitlements"),
      plist.build({
        "com.apple.security.application-groups": ["group.com.example.fixture"],
      }),
    );
    const settings = {
      SRCROOT: root,
      PROJECT_FILE_PATH: join(root, "Fixture.xcodeproj"),
      BASE_ID: "com.example.fixture",
      PRODUCT_BUNDLE_IDENTIFIER: "$(BASE_ID)",
      MARKETING_VERSION: "1.2.3",
      CURRENT_PROJECT_VERSION: "42",
      SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
      SDKROOT: "iphoneos",
    };
    const rows = [
      {
        target: "App",
        buildSettings: {
          ...settings,
          PRODUCT_TYPE: "com.apple.product-type.application",
          CODE_SIGN_ENTITLEMENTS: "$(SRCROOT)/App.entitlements",
          GENERATE_INFOPLIST_FILE: "YES",
        },
      },
      {
        target: "Widget",
        buildSettings: {
          ...settings,
          PRODUCT_TYPE: "com.apple.product-type.app-extension",
          PRODUCT_BUNDLE_IDENTIFIER: "$(BASE_ID).widget",
        },
      },
      {
        target: "Library",
        buildSettings: {
          ...settings,
          PRODUCT_TYPE: "com.apple.product-type.framework",
        },
      },
      {
        target: "Tests",
        buildSettings: {
          ...settings,
          PRODUCT_TYPE: "com.apple.product-type.bundle.unit-test",
        },
      },
    ];
    const targets = await resolvedTargets(root, rows, "Release");
    expect(targets.map((t) => t.bundleId)).toEqual([
      "com.example.fixture",
      "com.example.fixture.widget",
    ]);
    expect(
      targets[0].entitlements["com.apple.security.application-groups"],
    ).toEqual(["group.com.example.fixture"]);
    expect(targets[0]).toMatchObject({
      version: "1.2.3",
      buildNumber: "42",
      project: "Fixture.xcodeproj",
    });
    await expect(
      resolvedTargets(root, [...rows, rows[0]], "Release"),
    ).rejects.toThrow(/exactly one/);
    expect(() => expandBuildSetting("$(UNKNOWN)", {})).toThrow(/resolve/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("resolves an embedded extension in another project even when template UUIDs overlap", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-xcode-cross-project-"));
  try {
    const { createNativeFixture } = await import("./fixtures/native/create");
    const xcode = (await import("xcode")).default;
    const commands = await import("../src/core/process");
    await createNativeFixture(join(root, "apps/a"));
    await createNativeFixture(join(root, "apps/b"));
    const file = join(root, "apps/a/DeskApp.xcodeproj/project.pbxproj"),
      parsed = xcode.project(file);
    parsed.parseSync();
    const objects = parsed.hash.project.objects as any;
    const entries = Object.entries<any>(objects.PBXNativeTarget).filter(
      ([id]) => !id.endsWith("_comment"),
    );
    const app = entries.find(([, v]) => v.name === "DeskFixture")!,
      widget = entries.find(([, v]) => v.name === "DeskWidget")!;
    const projectRef = "F00000000000000000000001",
      targetProxy = "F00000000000000000000002",
      productProxy = "F00000000000000000000003",
      dependency = "F00000000000000000000004",
      reference = "F00000000000000000000005";
    objects.PBXFileReference[projectRef] = {
      isa: "PBXFileReference",
      lastKnownFileType: '"wrapper.pb-project"',
      path: '"../b/DeskApp.xcodeproj"',
      sourceTree: "SOURCE_ROOT",
    };
    objects.PBXContainerItemProxy[targetProxy] = {
      isa: "PBXContainerItemProxy",
      containerPortal: projectRef,
      proxyType: 1,
      remoteGlobalIDString: widget[0],
      remoteInfo: "DeskWidget",
    };
    objects.PBXContainerItemProxy[productProxy] = {
      isa: "PBXContainerItemProxy",
      containerPortal: projectRef,
      proxyType: 2,
      remoteGlobalIDString: widget[1].productReference,
      remoteInfo: "DeskWidget",
    };
    objects.PBXReferenceProxy = {
      [reference]: {
        isa: "PBXReferenceProxy",
        fileType: '"wrapper.app-extension"',
        path: "DeskWidget.appex",
        remoteRef: productProxy,
        sourceTree: "BUILT_PRODUCTS_DIR",
      },
    };
    objects.PBXTargetDependency[dependency] = {
      isa: "PBXTargetDependency",
      targetProxy,
    };
    app[1].dependencies = [{ value: dependency }];
    for (const [id, build] of Object.entries<any>(objects.PBXBuildFile))
      if (
        !id.endsWith("_comment") &&
        build.fileRef === widget[1].productReference
      )
        build.fileRef = reference;
    await writeFile(file, parsed.writeSync());
    const run = vi
      .spyOn(commands, "run")
      .mockImplementation(async (_command, args) => {
        if (args.includes("-list"))
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              project: { schemes: ["DeskFixture", "DeskWidget"] },
            }),
          };
        const external = args.includes("-target"),
          project = join(
            root,
            external ? "apps/b/DeskApp.xcodeproj" : "apps/a/DeskApp.xcodeproj",
          );
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify([
            {
              target: external ? "DeskWidget" : "DeskFixture",
              buildSettings: {
                PROJECT_FILE_PATH: project,
                SRCROOT: join(root, external ? "apps/b" : "apps/a"),
                PRODUCT_TYPE: external
                  ? "com.apple.product-type.app-extension"
                  : "com.apple.product-type.application",
                PRODUCT_BUNDLE_IDENTIFIER: external
                  ? "com.example.external.widget"
                  : "com.example.app",
                MARKETING_VERSION: "1.2.3",
                CURRENT_PROJECT_VERSION: "7",
                SUPPORTED_PLATFORMS: "iphoneos iphonesimulator",
                SDKROOT: "iphoneos",
              },
            },
          ]),
        };
      });
    const { inspectXcode } = await import("../src/core/xcode-project");
    const result = await inspectXcode(
      root,
      { appDirectory: "apps/a" },
      {},
      true,
    );
    expect(
      result.selected?.targets.map((t) => [t.bundleId, t.project]),
    ).toEqual([
      ["com.example.app", "apps/a/DeskApp.xcodeproj"],
      ["com.example.external.widget", "apps/b/DeskApp.xcodeproj"],
    ]);
    run.mockRestore();
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
it("generates XcodeGen projects only where no .xcodeproj is committed", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-xcodegen-specs-"));
  try {
    const { run } = await import("../src/core/process");
    const { xcodegenSpecs } = await import("../src/core/xcode-project");
    for (const dir of [
      "Generated",
      "Ignored/App.xcodeproj",
      "Committed/App.xcodeproj",
    ])
      await mkdir(join(root, dir), { recursive: true });
    for (const dir of ["Generated", "Ignored", "Committed"])
      await writeFile(join(root, dir, "project.yml"), "name: App\n");
    await writeFile(join(root, "Ignored/App.xcodeproj/project.pbxproj"), "{}");
    await writeFile(
      join(root, "Committed/App.xcodeproj/project.pbxproj"),
      "{}",
    );
    await writeFile(join(root, ".gitignore"), "Ignored/*.xcodeproj\n");
    await run("git", ["init", "-q"], { cwd: root });
    await run("git", ["add", "."], { cwd: root });
    expect(await xcodegenSpecs(root)).toEqual([
      "Generated/project.yml",
      "Ignored/project.yml",
    ]);
    await rm(join(root, ".git"), { recursive: true, force: true });
    expect(await xcodegenSpecs(root)).toEqual(["Generated/project.yml"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("removes only the default DerivedData folders a snapshot's containers created", async () => {
  const { readdir } = await import("node:fs/promises");
  const { defaultDerivedDataName, forgetDerivedData } =
    await import("../src/core/xcode-project");
  // Recorded from Xcode 27.2: `xcodebuild -project <path> -list` created this folder.
  expect(
    defaultDerivedDataName(
      "/tmp/claude-501/-Volumes-Workspace-NVME-git-ios-submit/34edf0f9-952e-410b-8295-1fa32be74231/scratchpad/ddhash/ShortKit.xcodeproj",
    ),
  ).toBe("ShortKit-aajjpghblqtysocvfdyuqwrruwhv");
  const home = await mkdtemp(join(tmpdir(), "dd-home-"));
  const root = await mkdtemp(join(tmpdir(), "dd-snapshot-"));
  await mkdir(join(root, "ios/App.xcworkspace"), { recursive: true });
  const { realpathSync } = await import("node:fs");
  const real = realpathSync(root);
  const base = join(home, "Library/Developer/Xcode/DerivedData");
  const mine = defaultDerivedDataName(
    join(real, "ios/App.xcworkspace").replace(
      /^\/private(?=\/(?:tmp|var)\/)/,
      "",
    ),
  );
  await mkdir(join(base, mine), { recursive: true });
  await mkdir(join(base, "App-someoneelsesprojectxxxxxxxxxx"), {
    recursive: true,
  });
  await forgetDerivedData(root, home);
  expect(await readdir(base)).toEqual(["App-someoneelsesprojectxxxxxxxxxx"]);
  await forgetDerivedData(join(root, "missing"), home);
});
