import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Store } from "../src/core/database";
import { Vault, privateDirectory, secretFile } from "../src/core/vault";
import type { Job } from "../src/core/types";
let dir: string, store: Store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "desk-state-test-"));
  store = new Store(dir);
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});
describe("persistent state and counters", () => {
  it("requires explicit migration and never reuses reserved versions", () => {
    expect(() => store.reserve("ios:app")).toThrow(/initialized/);
    store.seed("ios:app", 20);
    expect(store.reserve("ios:app")).toBe("21");
    store.seed("ios:app", 3);
    expect(store.reserve("ios:app")).toBe("22");
    expect(() => store.reserve("ios:app", undefined, 21)).toThrow(/reserved/);
    expect(store.reserve("android:app", 0)).toBe("1");
  });
  it("shares reservations across independent database connections", () => {
    store.seed("ios:shared", 4);
    const second = new Store(dir);
    try {
      expect(store.reserve("ios:shared")).toBe("5");
      expect(second.reserve("ios:shared")).toBe("6");
      expect(store.counter("ios:shared")).toBe(6);
    } finally {
      second.close();
    }
  });
  it("recovers interrupted builds and uncertain uploads without resubmitting", () => {
    store.putJob({ id: "build", status: "running" } as Job);
    store.putJob({
      id: "upload",
      status: "running",
      submission: { state: "uploading" },
    } as Job);
    store.recover();
    expect(store.get<Job>("jobs", "build").status).toBe("interrupted");
    expect(store.get<Job>("jobs", "upload").submission?.state).toBe(
      "uncertain",
    );
    expect(store.get<Job>("jobs", "upload").status).toBe("needs-attention");
  });
  it("encrypts credential material before it reaches SQLite", async () => {
    const key = randomBytes(32),
      iv = randomBytes(12);
    const vault = new Vault(store, {
      async encrypt(value) {
        const c = createCipheriv("aes-256-gcm", key, iv);
        return Buffer.concat([
          c.update(value, "utf8"),
          c.final(),
          c.getAuthTag(),
        ]);
      },
      async decrypt(value) {
        const d = createDecipheriv("aes-256-gcm", key, iv);
        d.setAuthTag(value.subarray(-16));
        return Buffer.concat([
          d.update(value.subarray(0, -16)),
          d.final(),
        ]).toString();
      },
    });
    const saved = await vault.put({
      kind: "environment",
      label: "Test",
      values: { SECRET: "never-plaintext-in-sqlite" },
    });
    expect((await vault.get(saved.id, "environment")).values.SECRET).toBe(
      "never-plaintext-in-sqlite",
    );
    const row = store.db
      .prepare("SELECT encrypted FROM credentials")
      .get() as any;
    expect(Buffer.from(row.encrypted).toString()).not.toContain(
      "never-plaintext",
    );
    expect(JSON.stringify(store.credentialSummaries())).not.toContain(
      "never-plaintext",
    );
  });
  it("removes decrypted temporary files even when an operation fails", async () => {
    let path = "";
    await expect(
      privateDirectory(async (root) => {
        path = await secretFile(root, "key", "secret");
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(readFile(path)).rejects.toThrow();
  });
});
