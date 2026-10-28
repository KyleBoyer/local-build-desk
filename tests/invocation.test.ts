import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/database";
import { Engine } from "../src/core/engine";
import { Vault } from "../src/core/vault";
import {
  resolveInvocation,
  captureInvocationEnvironment,
} from "../src/cli/invocation";
import {
  RunVault,
  invocationStore,
  credentialSecrets,
} from "../src/core/runtime-context";
import { Redactor } from "../src/core/process";
import { runCLI } from "../src/cli/commands";
import type { Project, Job } from "../src/core/types";
let root: string, store: Store, engine: Engine;
const encrypt = vi.fn(async () => {
  throw Error("Keychain must not be touched");
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desk-ci-"));
  store = new Store(join(root, "data"));
  engine = new Engine(store, new Vault(store, { encrypt, decrypt: encrypt }));
  store.putProject({
    id: "template",
    name: "Fixture",
    path: join(root, "desktop"),
    profiles: ["production"],
    createdAt: "today",
    settings: {
      iosSdk: "26.5",
      track: "internal",
      appleConnectionId: "stored-key",
      iosSigningId: "stored-p12",
    },
  });
});
afterEach(async () => {
  await engine.shutdown();
  store.close();
  await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
it("uses flags > environment > config > template without registering or updating a checkout", async () => {
  const source = join(root, "checkout");
  await mkdir(source);
  await writeFile(
    join(source, "ios-submit.json"),
    JSON.stringify({
      settings: { iosSdk: "27.0", minimumIosSdk: "27.0", track: "alpha" },
    }),
  );
  const invocation = await resolveInvocation(
    engine,
    {
      "settings-from": "template",
      source,
      "ios-sdk": "27.2",
      set: ["scheme=Release"],
    },
    { IOS_SUBMIT_IOS_SDK: "27.1", IOS_SUBMIT_TRACK: "beta" },
  );
  expect(invocation.project.path).toBe(source);
  expect(invocation.project.settings).toMatchObject({
    iosSdk: "27.2",
    minimumIosSdk: "27.0",
    track: "beta",
    scheme: "Release",
  });
  expect(store.list<Project>("projects")).toHaveLength(1);
  expect(store.get<Project>("projects", "template").settings.iosSdk).toBe(
    "26.5",
  );
  const independent = await resolveInvocation(engine, { source }, {});
  expect(independent.project.id).toMatch(/^invocation:/);
  expect(store.list("projects")).toHaveLength(1);
});
it("keeps binary, password, key ID, and environment credentials in memory with no Keychain access", async () => {
  const source = join(root, "checkout");
  await mkdir(source);
  await writeFile(
    join(source, "ios-submit.json"),
    JSON.stringify({
      credentials: {
        apple: {
          keyId: { env: "APPLE_ID" },
          issuerId: "11111111-2222-4333-8444-555555555555",
          teamId: "TEAM123",
          privateKey: { env: "APPLE_P8" },
        },
        ios: {
          p12: { base64Env: "P12" },
          password: { env: "P12_PASS" },
          profiles: [],
        },
      },
      environment: { SECRET: { env: "BUILD_SECRET" } },
    }),
  );
  const env = {
    APPLE_ID: "SECRETKEYID",
    APPLE_P8:
      "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----",
    P12: Buffer.from("binary-p12").toString("base64"),
    P12_PASS: "private-password",
    BUILD_SECRET: "build-env-secret",
    UNRELATED: "never-forward",
  };
  const forwarded = captureInvocationEnvironment(
    ["build", "--source", source],
    env,
  );
  expect(forwarded).not.toHaveProperty("UNRELATED");
  expect(forwarded.APPLE_ID).toBe(env.APPLE_ID);
  const invocation = await resolveInvocation(
    engine,
    { "settings-from": "template", source },
    forwarded,
  );
  expect(invocation.context.noKeychain).toBe(true);
  const vault = new RunVault(store, engine.vault, invocation.context);
  expect(
    (await vault.get(invocation.project.settings.iosSigningId, "ios")).p12,
  ).toBe(env.P12);
  await expect(vault.get("stored-key", "apple")).rejects.toThrow(/No Keychain/);
  const project = invocation.project;
  const scoped = invocationStore(store, vault, project, () => {});
  const saved = await vault.put({
    kind: "environment",
    label: "new",
    values: { TOKEN: "memory-only" },
  });
  scoped.putProject({
    ...project,
    settings: { ...project.settings, envCredentialId: saved.id },
  });
  expect(scoped.credentialSummaries()).toHaveLength(4);
  expect(store.credentialSummaries()).toHaveLength(0);
  expect(encrypt).not.toHaveBeenCalled();
  const redactor = new Redactor();
  redactor.add(...credentialSecrets(invocation.context.credentials));
  const output = redactor.redact(Object.values(env).join("\n"));
  expect(output).not.toContain(env.APPLE_ID);
  expect(output).not.toContain(env.P12_PASS);
  expect(output).not.toContain(env.BUILD_SECRET);
  expect(JSON.stringify(store.list("projects"))).not.toContain("memory-only");
});
it("supports Google JSON and Android binary temp files, and rejects malformed secrets without echoing them", async () => {
  const keyFile = join(root, "upload.jks");
  await writeFile(keyFile, Buffer.from([0, 2, 255, 4]));
  const invocation = await resolveInvocation(
    engine,
    { source: root },
    {
      IOS_SUBMIT_GOOGLE_JSON: JSON.stringify({
        type: "service_account",
        client_email: "ci@example.com",
        private_key: "test-private-key",
      }),
      IOS_SUBMIT_ANDROID_KEYSTORE_PATH: keyFile,
      IOS_SUBMIT_ANDROID_STORE_PASSWORD: "secret-store",
      IOS_SUBMIT_ANDROID_KEY_PASSWORD: "secret-key",
      IOS_SUBMIT_ANDROID_KEY_ALIAS: "upload",
    },
  );
  const vault = new RunVault(store, engine.vault, invocation.context);
  expect(
    (await vault.get(invocation.project.settings.androidSigningId, "android"))
      .keystore,
  ).toBe(Buffer.from([0, 2, 255, 4]).toString("base64"));
  expect(
    (await vault.get(invocation.project.settings.googleConnectionId, "google"))
      .serviceAccount.client_email,
  ).toBe("ci@example.com");
  await expect(
    resolveInvocation(
      engine,
      { source: root },
      { IOS_SUBMIT_GOOGLE_JSON: "SECRET-BROKEN-JSON" },
    ),
  ).rejects.toThrow("secret contents are excluded");
  expect(encrypt).not.toHaveBeenCalled();
});
it("does not auto-import a source for inspect and reports a platform-specific doctor exit code", async () => {
  const source = join(root, "checkout");
  await mkdir(join(source, "node_modules/expo/bin"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ dependencies: { expo: "58" } }),
  );
  await writeFile(
    join(source, "eas.json"),
    JSON.stringify({ build: { production: {} } }),
  );
  await writeFile(
    join(source, "node_modules/expo/bin/cli"),
    "console.log(JSON.stringify({name:'Fixture',slug:'fixture',version:'1.0',ios:{bundleIdentifier:'com.example'}}));",
  );
  let output = "";
  expect(
    await runCLI(
      engine,
      ["inspect", "--source", source],
      (text) => (output += text),
      { environment: {} },
    ),
  ).toBe(0);
  expect(JSON.parse(output).project.path).toBe(source);
  expect(store.list("projects")).toHaveLength(1);
});
it("requires re-provided ephemeral credentials after restart without falling back to the vault", async () => {
  const job = {
    id: "old",
    requiresInvocationCredentials: true,
    projectSnapshot: store.get<Project>("projects", "template"),
  } as Job;
  expect(() => engine.vaultFor(job)).toThrow(/Reprovide/);
  expect(encrypt).not.toHaveBeenCalled();
});

it("redacts JSON string values without corrupting boolean fields that match a secret", async () => {
  store.putJob({
    id: "status-job",
    projectId: "template",
    platform: "ios",
    status: "failed",
    stage: "compile",
    error: "private-token",
    createdAt: "today",
  } as Job);
  let output = "";
  expect(
    await runCLI(
      engine,
      ["status", "--job", "status-job", "--no-keychain"],
      (text) => (output += text),
      {
        environment: {
          IOS_SUBMIT_ENVIRONMENT_JSON: JSON.stringify({
            FLAG: "true",
            TOKEN: "private-token",
          }),
        },
      },
    ),
  ).toBe(1);
  const result = JSON.parse(output);
  expect(result.requiresInvocationCredentials).toBe(true);
  expect(result.error).toBe("[REDACTED]");
});
