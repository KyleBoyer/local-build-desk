import { it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/database";
import { Vault } from "../src/core/vault";
import {
  captureBackup,
  encryptBackup,
  decryptBackup,
  restorePayload,
} from "../src/core/backup";
import type { Project, Job } from "../src/core/types";
const encryption = (prefix: string) => ({
  async encrypt(value: string) {
    return Buffer.from(prefix + value);
  },
  async decrypt(bytes: Buffer) {
    if (!bytes.toString().startsWith(prefix)) throw Error("Different Mac key");
    return bytes.toString().slice(prefix.length);
  },
});
it("encrypts credentials portably and restores into a different vault without lowering counters or overwriting keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "desk-backup-")),
    a = new Store(join(root, "a")),
    b = new Store(join(root, "b"));
  try {
    const av = new Vault(a, encryption("MacA:")),
      bv = new Vault(b, encryption("MacB:"));
    const signing = await av.put({
      kind: "android",
      label: "Upload",
      keystore: "a2V5",
      storePassword: "private-password",
      alias: "upload",
      keyPassword: "private-password",
    });
    const project: Project = {
      id: "project",
      path: join(root, "source"),
      name: "Fixture",
      createdAt: "2026-10-01",
      profiles: ["production"],
      settings: {
        androidSigningId: signing.id,
        nodePath: "/source/node",
        buildDirectory: "/source/builds",
      },
    };
    a.putProject(project);
    a.seed("android:com.example.app", 39);
    a.claimNumber("android:com.example.app", "job");
    const job: Job = {
      id: "job",
      projectId: "project",
      projectName: "Fixture",
      platform: "android",
      kind: "build",
      profile: "production",
      status: "succeeded",
      stage: "complete",
      createdAt: "2026-10-01",
      autoSubmit: false,
      clean: false,
      buildNumber: "40",
      bundleId: "com.example.app",
      version: "1.0",
      artifactId: "artifact",
    };
    a.putJob(job);
    a.putArtifact({
      id: "artifact",
      jobId: "job",
      platform: "android",
      kind: "aab",
      path: join(root, "missing.aab"),
      sha256: "a".repeat(64),
      size: 12,
      bundleId: "com.example.app",
      version: "1.0",
      buildNumber: "40",
    });
    const payload = await captureBackup(a, av),
      bytes = await encryptBackup(payload, "a strong backup passphrase");
    expect(bytes.toString()).not.toContain("private-password");
    expect(bytes.toString()).not.toContain("keystore");
    const opened = await decryptBackup(bytes, "a strong backup passphrase");
    const existing = await bv.put({
      kind: "environment",
      label: "Keep me",
      values: { KEEP: "existing" },
    });
    b.seed("android:com.example.app", 99);
    await restorePayload(
      b,
      bv,
      opened,
      { project: join(root, "relocated") },
      () => {},
    );
    const restored = b.list<Project>("projects")[0];
    expect(restored.path).toBe(join(root, "relocated"));
    expect(restored.settings.nodePath).toBeUndefined();
    expect(restored.settings.buildDirectory).toBeUndefined();
    expect(restored.settings.androidSigningId).not.toBe(signing.id);
    expect(
      (await bv.get(restored.settings.androidSigningId, "android"))
        .storePassword,
    ).toBe("private-password");
    expect(await bv.get(existing.id, "environment")).toMatchObject({
      values: { KEEP: "existing" },
    });
    expect(b.counter("android:com.example.app")).toBe(99);
    expect(b.claimNumber("android:com.example.app", "next")).toBe("100");
    expect(b.get<Job>("jobs", "job").restoredFromBackup).toBe(true);
    await expect(decryptBackup(bytes, "wrong passphrase")).rejects.toThrow(
      /passphrase/,
    );
    const tampered = JSON.parse(bytes.toString());
    tampered.ciphertext =
      (tampered.ciphertext[0] === "A" ? "B" : "A") +
      tampered.ciphertext.slice(1);
    await expect(
      decryptBackup(
        Buffer.from(JSON.stringify(tampered)),
        "a strong backup passphrase",
      ),
    ).rejects.toThrow(/damaged/);
  } finally {
    a.close();
    b.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it("rolls back all imported keys, settings and counters when a history write fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "desk-backup-rollback-")),
    a = new Store(join(root, "a")),
    b = new Store(join(root, "b"));
  try {
    const av = new Vault(a, encryption("A")),
      bv = new Vault(b, encryption("B"));
    const key = await av.put({
      kind: "environment",
      label: "Env",
      values: { SECRET: "private" },
    });
    a.putProject({
      id: "project",
      path: join(root, "source"),
      name: "Fixture",
      createdAt: "now",
      profiles: ["production"],
      settings: { envCredentialId: key.id },
    });
    a.seed("ios:com.example.app", 8);
    a.putArtifact({
      id: "artifact",
      jobId: "old-job",
      platform: "ios",
      kind: "ipa",
      path: join(root, "x.ipa"),
      sha256: "b".repeat(64),
      size: 1,
      bundleId: "com.example.app",
      version: "1",
      buildNumber: "8",
    });
    const payload = await captureBackup(a, av);
    vi.spyOn(b, "putArtifact").mockImplementation(() => {
      throw Error("Disk failure");
    });
    await expect(restorePayload(b, bv, payload, {}, () => {})).rejects.toThrow(
      "Disk failure",
    );
    expect(b.credentialSummaries()).toHaveLength(0);
    expect(b.list("projects")).toHaveLength(0);
    expect(b.counter("ios:com.example.app")).toBeUndefined();
  } finally {
    a.close();
    b.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it("round-trips native project selections, local profiles and extension facts while preserving old-format records", async () => {
  const root = mkdtempSync(join(tmpdir(), "desk-backup-native-")),
    a = new Store(join(root, "a")),
    b = new Store(join(root, "b"));
  try {
    const av = new Vault(a, encryption("A")),
      bv = new Vault(b, encryption("B"));
    a.putProject({
      id: "native",
      type: "native-ios",
      platforms: ["ios"],
      usesCocoaPods: false,
      path: join(root, "source"),
      name: "Native",
      profiles: ["development"],
      createdAt: "2026-10-01",
      settings: {
        projectType: "native-ios",
        appDirectory: "apps/native",
        iosTarget: "apps/native/App.xcodeproj",
        scheme: "App",
        localProfiles: {
          development: { configuration: "Debug", simulator: true, debug: true },
        },
      },
    });
    a.putProject({
      id: "legacy",
      path: join(root, "legacy"),
      name: "Legacy Expo",
      profiles: ["production"],
      createdAt: "2026-10-01",
      settings: {},
    });
    a.putJob({
      id: "native-job",
      kind: "build",
      projectId: "native",
      projectName: "Native",
      platform: "ios",
      profile: "development",
      status: "succeeded",
      stage: "complete",
      createdAt: "2026-10-01",
      autoSubmit: false,
      clean: false,
      facts: {
        projectType: "native-ios",
        nativeTarget: "apps/native/App.xcodeproj · App",
        configuration: "Debug",
        distribution: "internal",
        developmentClient: false,
        simulator: true,
        destination: "iOS Simulator",
        targetEntitlements: {
          "com.example.app.widget": {
            "com.apple.security.application-groups": [
              "group.com.example.shared",
            ],
          },
        },
      },
    });
    const payload = await decryptBackup(
      await encryptBackup(
        await captureBackup(a, av),
        "native backup passphrase",
      ),
      "native backup passphrase",
    );
    await restorePayload(
      b,
      bv,
      payload,
      {
        native: join(root, "relocated"),
        legacy: join(root, "legacy-relocated"),
      },
      () => {},
    );
    const projects = b.list<Project>("projects");
    expect(projects.find((p) => p.name === "Native")).toMatchObject({
      type: "native-ios",
      platforms: ["ios"],
      usesCocoaPods: false,
      settings: {
        appDirectory: "apps/native",
        localProfiles: { development: { simulator: true } },
      },
    });
    expect(
      projects.find((p) => p.name === "Legacy Expo")?.type,
    ).toBeUndefined();
    expect(
      b.get<Job>("jobs", "native-job").facts?.targetEntitlements?.[
        "com.example.app.widget"
      ],
    ).toMatchObject({
      "com.apple.security.application-groups": ["group.com.example.shared"],
    });
  } finally {
    a.close();
    b.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("round-trips check policies, validation receipts and uncertain release journals", async () => {
  const { releaseChecksSchema } =
    await import("../src/core/release-check-schema");
  const root = mkdtempSync(join(tmpdir(), "desk-check-backup-"));
  const a = new Store(join(root, "a")),
    b = new Store(join(root, "b"));
  try {
    const av = new Vault(a, encryption("A:")),
      bv = new Vault(b, encryption("B:"));
    const releaseChecks = releaseChecksSchema.parse({
      runner: "command",
      command: ["npm", "test"],
    });
    a.putProject({
      id: "project",
      name: "Fixture",
      path: join(root, "source"),
      createdAt: "now",
      profiles: ["production"],
      settings: { releaseChecks },
    });
    a.putJob({
      id: "test-job",
      projectId: "project",
      projectName: "Fixture",
      platform: "ios",
      kind: "test",
      profile: "production",
      status: "running",
      stage: "testing",
      createdAt: "now",
      autoSubmit: false,
      clean: false,
      validation: {
        state: "running",
        mode: "all",
        sourceHash: "a".repeat(64),
        fingerprint: "b".repeat(64),
        policyDigest: "c".repeat(64),
        configuration: "Release",
        startedAt: "now",
        runs: [],
        screenshots: [],
      },
      checkpoints: [{ stage: "testing", state: "running", startedAt: "now" }],
      checksMode: "all",
      resumedFrom: "previous-test",
    });
    a.setPreference("release-journals", [
      {
        id: "journal",
        projectId: "project",
        appId: "app",
        bundleId: "com.example.fixture",
        version: "1.0",
        manifestHash: "d".repeat(64),
        state: "uncertain",
        stage: "POST /appStoreVersions",
        updatedAt: "now",
        completed: [],
        pending: {
          key: "operation",
          path: "/appStoreVersions",
          startedAt: "now",
          selectors: { versionString: "1.0" },
          relationships: { app: "app" },
        },
      },
    ]);
    const payload = await decryptBackup(
      await encryptBackup(
        await captureBackup(a, av),
        "check receipt backup passphrase",
      ),
      "check receipt backup passphrase",
    );
    await restorePayload(
      b,
      bv,
      payload,
      { project: join(root, "relocated") },
      () => {},
    );
    const project = b.list<Project>("projects")[0]!;
    expect(project.settings.releaseChecks).toEqual(releaseChecks);
    const restored = b.get<Job>("jobs", "test-job");
    expect(restored).toMatchObject({
      kind: "test",
      status: "interrupted",
      resumedFrom: "previous-test",
      checksMode: "all",
      validation: { state: "interrupted" },
    });
    expect(restored.checkpoints?.[0]?.state).toBe("interrupted");
    expect(b.preference<any[]>("release-journals", [])[0]).toMatchObject({
      projectId: project.id,
      state: "uncertain",
      pending: { path: "/appStoreVersions" },
    });
    // Backups predating the journal field remain readable and restorable.
    delete payload.releaseJournals;
    await expect(
      encryptBackup(payload, "legacy receipt backup passphrase"),
    ).resolves.toBeInstanceOf(Buffer);
  } finally {
    a.close();
    b.close();
    rmSync(root, { recursive: true, force: true });
  }
});
