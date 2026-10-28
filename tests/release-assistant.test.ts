import { it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppleAPI } from "../src/core/stores";
import { Engine } from "../src/core/engine";
import { Store } from "../src/core/database";
import { Vault } from "../src/core/vault";
import {
  releaseContext,
  previewRelease,
  applyRelease,
  contextFingerprint,
} from "../src/core/release-assistant";
import type { Job, ReleaseDraft } from "../src/core/types";
const job: Job = {
  id: "job",
  projectId: "project",
  projectName: "Fixture",
  bundleId: "com.example.app",
  version: "1.2",
  buildNumber: "10",
  platform: "ios",
  profile: "production",
  kind: "build",
  status: "succeeded",
  stage: "complete",
  createdAt: "now",
  clean: false,
  autoSubmit: false,
  artifactId: "artifact",
  storeEligible: true,
};
function server() {
  let whatsNew = "Before",
    version: any;
  const writes: any[] = [];
  let failAfterWrite = false;
  const request = vi.fn(
    async (path: string, method = "GET", body?: any): Promise<any> => {
      if (method !== "GET") {
        writes.push({ path, method, body });
        if (path === "/appStoreVersions") {
          version = {
            id: "version",
            attributes: {
              versionString: "1.2",
              appStoreState: "PREPARE_FOR_SUBMISSION",
            },
          };
          return { data: version };
        }
        whatsNew = body.data.attributes.whatsNew;
        if (failAfterWrite) throw Error("Connection reset after applying");
        return { data: { id: "locale" } };
      }
      if (path.includes("/appStoreVersions?"))
        return { data: version ? [version] : [] };
      if (path.includes("Localizations"))
        return {
          data: [{ id: "locale", attributes: { locale: "en-US", whatsNew } }],
        };
      throw Error("Unexpected endpoint " + path);
    },
  );
  const api = {
    app: vi.fn(async () => ({ id: "app" })),
    build: vi.fn(async () => [{ id: "build", attributes: { expired: false } }]),
    request,
  } as unknown as AppleAPI;
  return {
    api,
    writes,
    setNotes: (value: string) => (whatsNew = value),
    fail: () => (failAfterWrite = true),
  };
}
afterEach(() => vi.restoreAllMocks());
it("previews and applies TestFlight notes to the exact app/version/build without a release", async () => {
  const s = server(),
    draft: ReleaseDraft = {
      destination: "testflight",
      locale: "en-US",
      fields: { whatsNew: "New tests" },
    };
  const context = await releaseContext(s.api, job, draft),
    preview = previewRelease(job, draft, context);
  expect(s.writes).toHaveLength(0);
  expect(preview.changes[0]).toMatchObject({
    before: "Before",
    after: "New tests",
  });
  await applyRelease(s.api, job, draft, contextFingerprint(context));
  expect(s.api.build).toHaveBeenCalledWith("com.example.app", "10", "1.2");
  expect(s.writes).toHaveLength(1);
  expect(s.writes[0].path).toBe("/betaBuildLocalizations/locale");
  expect(s.writes[0].body.data.attributes).toEqual({ whatsNew: "New tests" });
});
it("rejects a stale preview before writing metadata", async () => {
  const s = server(),
    draft: ReleaseDraft = {
      destination: "testflight",
      locale: "en-US",
      fields: { whatsNew: "New tests" },
    };
  const current = await releaseContext(s.api, job, draft);
  s.setNotes("Changed in console");
  await expect(
    applyRelease(s.api, job, draft, contextFingerprint(current)),
  ).rejects.toThrow(/changed after/);
  expect(s.writes).toHaveLength(0);
});
it("creates only an explicitly requested manual-release App Store draft", async () => {
  const s = server(),
    draft: ReleaseDraft = {
      destination: "appstore",
      locale: "en-US",
      fields: { whatsNew: "Release changes" },
    };
  await expect(releaseContext(s.api, job, draft)).rejects.toThrow(
    /Create draft/,
  );
  draft.createVersion = true;
  const context = await releaseContext(s.api, job, draft);
  expect(s.writes).toHaveLength(0);
  await applyRelease(s.api, job, draft, contextFingerprint(context));
  expect(s.writes[0].body.data.attributes.releaseType).toBe("MANUAL");
  expect(
    s.writes.every((w) => !/reviewSubmissions|releaseRequest/.test(w.path)),
  ).toBe(true);
});
it("consumes approval before an ambiguous write and requires a new preview", async () => {
  const root = mkdtempSync(join(tmpdir(), "desk-release-")),
    store = new Store(root);
  try {
    const vault = new Vault(store, {
      async encrypt(s) {
        return Buffer.from(s);
      },
      async decrypt(b) {
        return b.toString();
      },
    });
    const key = await vault.put({
      kind: "apple",
      label: "Fixture",
      keyId: "KEY1234567",
      issuerId: "00000000-0000-4000-8000-000000000000",
      teamId: "TEAM123456",
      privateKey: "test-only-key",
    });
    store.putProject({
      id: "project",
      path: root,
      name: "Fixture",
      createdAt: "now",
      profiles: ["production"],
      settings: { appleConnectionId: key.id },
    });
    store.putJob(job);
    const s = server();
    vi.spyOn(AppleAPI.prototype, "app").mockImplementation(s.api.app);
    vi.spyOn(AppleAPI.prototype, "build").mockImplementation(s.api.build);
    vi.spyOn(AppleAPI.prototype, "request").mockImplementation(s.api.request);
    const engine = new Engine(store, vault),
      preview = await engine.prepareRelease("job", {
        destination: "testflight",
        locale: "en-US",
        fields: { whatsNew: "New tests" },
      });
    s.fail();
    await expect(engine.applyRelease(preview.token)).rejects.toThrow(
      /may already have succeeded/,
    );
    await expect(engine.applyRelease(preview.token)).rejects.toThrow(/Preview/);
    expect(s.writes).toHaveLength(1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it("keeps release requests busy and aborts them before shutdown closes storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "desk-release-shutdown-")),
    store = new Store(root);
  try {
    const vault = new Vault(store, {
      encrypt: async (s) => Buffer.from(s),
      decrypt: async (b) => b.toString(),
    });
    const key = await vault.put({
      kind: "apple",
      label: "Fixture",
      keyId: "KEY1234567",
      issuerId: "00000000-0000-4000-8000-000000000000",
      teamId: "TEAM123456",
      privateKey: "test-only-key",
    });
    store.putProject({
      id: "project",
      path: root,
      name: "Fixture",
      createdAt: "now",
      profiles: ["production"],
      settings: { appleConnectionId: key.id },
    });
    store.putJob(job);
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    vi.spyOn(AppleAPI.prototype, "app").mockImplementation(function (
      this: any,
    ) {
      started();
      return new Promise((_resolve, reject) =>
        this.options.signal.addEventListener(
          "abort",
          () => reject(Error("Request aborted")),
          { once: true },
        ),
      );
    });
    const engine = new Engine(store, vault);
    const result = engine
      .prepareRelease("job", {
        destination: "testflight",
        locale: "en-US",
        fields: { whatsNew: "Changes" },
      })
      .catch((error) => error);
    await ready;
    expect(engine.isBusy()).toBe(true);
    expect(() => engine.assertBackupIdle()).toThrow(/Wait for/);
    await engine.shutdown();
    expect((await result).message).toContain("aborted");
    expect(engine.isBusy()).toBe(false);
    expect(() =>
      engine.prepareRelease("job", {
        destination: "testflight",
        locale: "en-US",
        fields: {},
      }),
    ).toThrow(/shutting down/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
