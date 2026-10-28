import { it, expect, vi, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../src/core/database";
import { Vault } from "../src/core/vault";
import { RunVault } from "../src/core/runtime-context";
import { snapshot } from "../src/core/snapshot";
import { resolveProfile } from "../src/core/config";
import * as reuse from "../src/core/reuse";
import { Engine } from "../src/core/engine";
import type { Inspection, Project, Job } from "../src/core/types";
const encryption = {
  async encrypt(value: string) {
    return Buffer.from(value);
  },
  async decrypt(bytes: Buffer) {
    return bytes.toString();
  },
};
afterEach(() => vi.restoreAllMocks());
it("frames filenames/content and can hash a source tree without copying or modifying it", async () => {
  const root = mkdtempSync(join(tmpdir(), "desk-hash-"));
  try {
    const source = join(root, "source");
    mkdirSync(source);
    writeFileSync(join(source, "a"), "");
    writeFileSync(join(source, "b"), "c");
    const first = await snapshot(
      source,
      join(root, "unused"),
      { ios: false, android: false },
      undefined,
      false,
    );
    unlinkSync(join(source, "b"));
    writeFileSync(join(source, "a"), "bc");
    const second = await snapshot(
      source,
      join(root, "unused"),
      { ios: false, android: false },
      undefined,
      false,
    );
    expect(first).not.toBe(second);
    expect(readFileSync(join(source, "a"), "utf8")).toBe("bc");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("uses secret-keyed exact inputs and Expo native compatibility only for development clients", async () => {
  const root = mkdtempSync(join(tmpdir(), "desk-reuse-key-")),
    store = new Store(join(root, "state"));
  try {
    const sdk = join(root, "node_modules/@expo/fingerprint");
    mkdirSync(sdk, { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(
      join(sdk, "package.json"),
      JSON.stringify({ main: "index.cjs" }),
    );
    writeFileSync(
      join(sdk, "index.cjs"),
      `exports.createFingerprintAsync=async(root,opts)=>{if(opts.platforms[0]!=='ios'||opts.nativeModuleSourceType!=='files')throw Error('wrong options');return {hash:'${"a".repeat(64)}'}}`,
    );
    const vault = new Vault(store, encryption),
      project: Project = {
        id: "project",
        path: root,
        name: "Fixture",
        createdAt: "now",
        profiles: ["development"],
        settings: { nodePath: process.execPath },
      };
    const inspection = {
        name: "Fixture",
        version: "1",
        profiles: ["development"],
        config: { name: "Fixture" },
        native: { ios: false, android: false },
        eas: {},
        packageManager: "npm",
        issues: [],
      } as Inspection,
      profile = resolveProfile(
        {
          build: {
            development: { developmentClient: true, distribution: "internal" },
          },
        },
        "development",
        "ios",
      );
    const first = await reuse.reuseKeys(
        project,
        inspection,
        profile,
        "ios",
        "source-1",
        [],
        vault,
        { TOKEN: "private" },
      ),
      second = await reuse.reuseKeys(
        project,
        inspection,
        profile,
        "ios",
        "source-2",
        [],
        vault,
        { TOKEN: "private" },
      );
    expect(first.reuseFingerprint).not.toBe(second.reuseFingerprint);
    expect(first.nativeReuseFingerprint).toBe(second.nativeReuseFingerprint);
    expect(first.nativeReuseFingerprint).toHaveLength(64);
    const changed = await reuse.reuseKeys(
      project,
      inspection,
      profile,
      "ios",
      "source-1",
      [],
      vault,
      { TOKEN: "changed" },
    );
    expect(changed.reuseFingerprint).not.toBe(first.reuseFingerprint);
    const isolated = new RunVault(store, vault, {
      noKeychain: true,
      credentials: {},
    });
    expect(isolated.canFingerprint).toBe(false);
    await expect(isolated.fingerprint("private")).rejects.toThrow(
      /Invocation-only/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it("reuses without reserving a number and rejects an artifact changed after discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "desk-reuse-artifact-")),
    store = new Store(root);
  try {
    const vault = new Vault(store, encryption),
      engine = new Engine(store, vault),
      path = join(root, "app.apk");
    writeFileSync(path, "APK");
    const profile = resolveProfile(
      { build: { production: {} } },
      "production",
      "android",
    );
    store.putProject({
      id: "project",
      path: root,
      name: "Fixture",
      createdAt: "now",
      profiles: ["production"],
      settings: {},
    });
    const job: Job = {
      id: "job",
      projectId: "project",
      projectName: "Fixture",
      platform: "android",
      profile: "production",
      kind: "build",
      status: "succeeded",
      stage: "complete",
      createdAt: "now",
      autoSubmit: false,
      clean: false,
      bundleId: "com.example.app",
      artifactId: "artifact",
      reuseFingerprint: "match",
    };
    store.putJob(job);
    store.putArtifact({
      id: "artifact",
      jobId: "job",
      platform: "android",
      kind: "apk",
      path,
      sha256: createHash("sha256").update("APK").digest("hex"),
      size: 3,
      bundleId: "com.example.app",
      version: "1",
      buildNumber: "8",
    });
    store.seed("android:com.example.app", 8);
    vi.spyOn(reuse, "inspectReuse").mockResolvedValue({
      profile,
      inspection: { packageName: "com.example.app" } as Inspection,
      reuseFingerprint: "match",
      nativeReuseFingerprint: undefined,
    });
    expect(
      (await engine.findReusableBuilds("project", "production", "android"))[0]
        .match,
    ).toBe("exact");
    expect(
      (
        await engine.useReusableBuild(
          "project",
          "production",
          "android",
          "artifact",
          false,
        )
      ).id,
    ).toBe("job");
    expect(store.list("jobs")).toHaveLength(1);
    expect(store.highWater("android:com.example.app")).toBe(8);
    writeFileSync(path, "tampered");
    await expect(
      engine.useReusableBuild(
        "project",
        "production",
        "android",
        "artifact",
        false,
      ),
    ).rejects.toThrow(/changed/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
