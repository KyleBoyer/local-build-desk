import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/database";
import { Engine } from "../src/core/engine";
import { Vault, importCredential } from "../src/core/vault";
import {
  bindRuntimeCredentials,
  credentialSecrets,
} from "../src/core/runtime-context";

let root: string, store: Store, engine: Engine;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "saved-login-"));
  store = new Store(root);
  engine = new Engine(
    store,
    new Vault(store, {
      async encrypt(v) {
        return Buffer.from(v);
      },
      async decrypt(v) {
        return v.toString();
      },
    }),
  );
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it("keeps a sign-in in the vault, showing only the account", async () => {
  const summary = await engine.saveCredential({
    kind: "login",
    label: "Apple ID sign-in",
    provider: "apple",
    username: " dev@example.com ",
    password: "correct horse",
  });
  expect(summary).toMatchObject({
    kind: "login",
    detail: "Apple ID · dev@example.com",
  });
  expect(JSON.stringify(engine.state().credentials)).not.toContain(
    "correct horse",
  );
  expect(await engine.savedLogin("apple")).toMatchObject({
    username: "dev@example.com",
    password: "correct horse",
  });
  expect(await engine.savedLogin("google")).toBeUndefined();
});

it("refuses an incomplete sign-in", async () => {
  await expect(
    importCredential({
      kind: "login",
      label: "x",
      provider: "apple",
      username: "a@b.c",
      password: "",
    }),
  ).rejects.toThrow(/email and password/);
  await expect(
    importCredential({
      kind: "login",
      label: "x",
      provider: "yahoo",
      username: "a@b.c",
      password: "p",
    }),
  ).rejects.toThrow();
});

it("redacts saved passwords from logs and keeps them out of build credentials", () => {
  const login = {
    kind: "login" as const,
    label: "Google sign-in",
    provider: "google" as const,
    username: "dev@example.com",
    password: "hunter2-but-longer",
  };
  expect(credentialSecrets({ a: login })).toEqual(["hunter2-but-longer"]);
  const { settings, context } = bindRuntimeCredentials({}, [login], false);
  expect(settings).toEqual({});
  expect(context.credentials).toEqual({});
});
