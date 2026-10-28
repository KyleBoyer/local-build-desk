import { it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const metadata = await import(
  new URL("../scripts/release-meta.mjs", import.meta.url).href
);
const signing = await import(
  new URL("../scripts/ci-signing.mjs", import.meta.url).href
);
const manifest = await import(
  new URL("../scripts/update-manifest.mjs", import.meta.url).href
);
const fake = {
  MACOS_CERTIFICATE_P12_BASE64: Buffer.from(
    "synthetic PKCS12 fixture",
  ).toString("base64"),
  MACOS_CERTIFICATE_PASSWORD: "fixture-password",
  APPLE_API_KEY_P8_BASE64: Buffer.from(
    [
      "-----BEGIN PRIVATE KEY-----",
      "TEST-ONLY-NOT-A-KEY",
      "-----END PRIVATE KEY-----",
    ].join("\n"),
  ).toString("base64"),
  APPLE_API_KEY_ID: "KEY1234567",
  APPLE_API_ISSUER: "00000000-0000-4000-8000-000000000000",
  MACOS_TEAM_ID: "TEAM123456",
  MACOS_SIGNING_IDENTITY: "Example Developer (TEAM123456)",
};
afterEach(() => {
  vi.unstubAllEnvs();
  delete require.cache[require.resolve("../electron-builder.release.cjs")];
});
it("requires matching versions and trusted tag/main release events", () => {
  expect(
    metadata.validateRelease("v0.1.0", "0.1.0", "refs/tags/v0.1.0", "push").tag,
  ).toBe("v0.1.0");
  expect(
    metadata.validateRelease(
      "v0.1.0-beta.1",
      "0.1.0-beta.1",
      "refs/heads/main",
      "workflow_dispatch",
    ).prerelease,
  ).toBe(true);
  for (const [tag, version, ref, event] of [
    ["v0.2.0", "0.1.0", "refs/heads/main", "workflow_dispatch"],
    ["v0.1.0;echo unsafe", "0.1.0", "refs/heads/main", "workflow_dispatch"],
    ["v0.1.0", "0.1.0", "refs/heads/fork", "workflow_dispatch"],
    ["v0.1.0", "0.1.0", "refs/pull/1/merge", "pull_request"],
  ])
    expect(() => metadata.validateRelease(tag, version, ref, event)).toThrow();
});
it("release config fails closed without credentials and requires hardened signing/notarization", () => {
  vi.stubEnv("MACOS_SIGNING_IDENTITY", "");
  expect(() => require("../electron-builder.release.cjs")).toThrow(
    /MACOS_SIGNING_IDENTITY/,
  );
  delete require.cache[require.resolve("../electron-builder.release.cjs")];
  for (const [key, value] of Object.entries(fake)) vi.stubEnv(key, value);
  vi.stubEnv("APPLE_API_KEY", "/fixture/key.p8");
  const config = require("../electron-builder.release.cjs");
  expect(config.forceCodeSigning).toBe(true);
  expect(config.mac).toMatchObject({
    identity: fake.MACOS_SIGNING_IDENTITY,
    notarize: true,
    hardenedRuntime: true,
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ],
  });
  expect(config.dmg.sign).toBe(true);
  // Targets named on the command line would replace the ARM64 targets.
  expect(require("../package.json").scripts["release:mac"]).toMatch(
    /--mac --publish never$/,
  );
  expect(config.publish).toEqual([
    expect.objectContaining({
      provider: "github",
      owner: "KyleBoyer",
      repo: "local-build-desk",
    }),
  ]);
  expect(config.files.some((value: string) => value === "out/**/*")).toBe(
    false,
  );
});
it("credential setup uses private temporary files, omits raw secrets from exported environment, and restores keychains", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-release-test-"));
  const env = {
    ...fake,
    RUNNER_TEMP: root,
    GITHUB_ENV: join(root, "github-env"),
  };
  const calls: { command: string; args: string[] }[] = [];
  const execute = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (args[0] === "list-keychains" && args.length === 3)
      return '"/fixture/login.keychain-db"\n';
    if (args[0] === "find-identity")
      return "Developer ID Application: Example Developer (TEAM123456)";
    return "";
  };
  try {
    const prepared = signing.prepareSigning(env, execute);
    const exported = await readFile(env.GITHUB_ENV, "utf8");
    expect(exported).not.toContain(fake.MACOS_CERTIFICATE_PASSWORD);
    expect(exported).not.toContain(fake.APPLE_API_KEY_P8_BASE64);
    expect(exported).not.toContain("BEGIN PRIVATE KEY");
    expect((await stat(join(prepared.root, "AuthKey.p8"))).mode & 0o077).toBe(
      0,
    );
    expect((await stat(prepared.root)).mode & 0o077).toBe(0);
    await expect(
      stat(join(prepared.root, "certificate.p12")),
    ).rejects.toThrow();
    signing.cleanupSigning(env, execute);
    await expect(stat(prepared.root)).rejects.toThrow();
    expect(
      calls.some(
        (call) =>
          JSON.stringify(call.args) ===
          JSON.stringify([
            "list-keychains",
            "-d",
            "user",
            "-s",
            "/fixture/login.keychain-db",
          ]),
      ),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("missing or malformed signing inputs fail before writing credentials or invoking security", () => {
  expect(() => signing.validateSigningEnvironment({})).toThrow(
    /Missing release credentials/,
  );
  expect(() =>
    signing.validateSigningEnvironment({ ...fake, MACOS_TEAM_ID: "bad" }),
  ).toThrow(/team identifier/);
  expect(() =>
    signing.validateSigningEnvironment({
      ...fake,
      APPLE_API_KEY_P8_BASE64: Buffer.from("invalid").toString("base64"),
    }),
  ).toThrow(/p8/);
});
it("release workflow isolates signing from PRs and publishes only the verified ARM64 artifacts", async () => {
  const yaml = require("js-yaml");
  const workflow = yaml.load(
    await readFile(resolve(".github/workflows/release.yml"), "utf8"),
  );
  expect(workflow.on.pull_request).toBeUndefined();
  expect(workflow.on.push.tags).toEqual(["v*"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.jobs.sign.environment).toBe("release");
  expect(workflow.jobs.sign.needs).toBe("validate");
  expect(workflow.jobs.test.needs).toBe("validate");
  expect(workflow.jobs.test.environment).toBeUndefined();
  expect(workflow.jobs.sign.strategy).toBeUndefined();
  expect(
    workflow.jobs.sign.steps.find(
      (step: any) => step.name === "Build, sign and notarize app",
    ).run,
  ).toBe("npm run release:mac");
  expect(
    workflow.jobs.sign.steps.find(
      (step: any) => step.name === "Remove credentials and temporary keychain",
    ).if,
  ).toBe("always()");
  expect(workflow.jobs.publish.needs).toEqual(["validate", "test", "sign"]);
  expect(workflow.jobs.publish.permissions).toEqual({ contents: "write" });
  const publish = workflow.jobs.publish.steps.at(-1).run;
  expect(publish).toContain('update-manifest.mjs . "$RELEASE_TAG"');
  expect(publish).toMatch(
    /gh release create .*\*\.zip\.blockmap .*latest-mac\.yml/,
  );
  for (const job of Object.values(workflow.jobs) as any[])
    for (const step of job.steps)
      if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
});

it("update manifest describes the ARM64 ZIP for electron-updater", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-update-manifest-"));
  try {
    const zip = "Local-Build-Desk-1.2.3-arm64.zip";
    await writeFile(join(root, zip), "ARM64");
    const sha512 = createHash("sha512").update("ARM64").digest("base64");
    const yaml = require("js-yaml");
    expect(
      yaml.load(manifest.updateManifest(root, "v1.2.3", new Date(0))),
    ).toEqual({
      version: "1.2.3",
      files: [{ url: zip, sha512, size: 5 }],
      path: zip,
      sha512,
      releaseDate: "1970-01-01T00:00:00.000Z",
    });
    await rm(join(root, zip));
    expect(() => manifest.updateManifest(root, "v1.2.3")).toThrow(/ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
