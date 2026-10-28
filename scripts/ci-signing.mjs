import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  appendFileSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const signingSecrets = [
  "MACOS_CERTIFICATE_P12_BASE64",
  "MACOS_CERTIFICATE_PASSWORD",
  "APPLE_API_KEY_P8_BASE64",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
];
export function validateSigningEnvironment(env) {
  const missing = [
    ...signingSecrets,
    "MACOS_SIGNING_IDENTITY",
    "MACOS_TEAM_ID",
  ].filter((name) => !env[name]);
  if (missing.length)
    throw new Error(
      "Missing release credentials/settings: " + missing.join(", "),
    );
  if (!/^[A-Z0-9]{10}$/.test(env.MACOS_TEAM_ID))
    throw new Error("MACOS_TEAM_ID must be an Apple team identifier.");
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_API_KEY_ID))
    throw new Error("APPLE_API_KEY_ID must be an Apple key ID.");
  if (!/^[a-f0-9-]{36}$/i.test(env.APPLE_API_ISSUER))
    throw new Error("APPLE_API_ISSUER must be the team API issuer UUID.");
  const key = Buffer.from(env.APPLE_API_KEY_P8_BASE64, "base64").toString(
    "utf8",
  );
  if (
    !key.includes("-----BEGIN PRIVATE KEY-----") ||
    !key.includes("-----END PRIVATE KEY-----")
  )
    throw new Error(
      "The notarization secret must contain a base64-encoded .p8 key.",
    );
  const cert = Buffer.from(env.MACOS_CERTIFICATE_P12_BASE64, "base64");
  if (!cert.length) throw new Error("The signing certificate secret is empty.");
  return { key, cert };
}
function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed during signing credential setup (exit ${result.status ?? "unknown"}). Credential-bearing command arguments are omitted.`,
    );
  return result.stdout;
}
export function prepareSigning(env = process.env, execute = run) {
  const { key, cert } = validateSigningEnvironment(env);
  if (!env.RUNNER_TEMP || !env.GITHUB_ENV)
    throw new Error("CI signing requires RUNNER_TEMP and GITHUB_ENV.");
  const root = join(resolve(env.RUNNER_TEMP), "local-build-desk-signing");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const keychain = join(root, "release.keychain-db");
  const previous = [
    ...execute("security", ["list-keychains", "-d", "user"]).matchAll(
      /"([^"]+)"/g,
    ),
  ].map((m) => m[1]);
  writeFileSync(
    join(root, "previous-keychains.json"),
    JSON.stringify(previous),
    { mode: 0o600 },
  );
  const password = randomBytes(32).toString("base64url");
  execute("security", ["create-keychain", "-p", password, keychain]);
  execute("security", ["set-keychain-settings", "-lut", "21600", keychain]);
  execute("security", ["unlock-keychain", "-p", password, keychain]);
  const p12 = join(root, "certificate.p12"),
    p8 = join(root, "AuthKey.p8");
  writeFileSync(p12, cert, { mode: 0o600 });
  writeFileSync(p8, key, { mode: 0o600 });
  execute("security", [
    "import",
    p12,
    "-k",
    keychain,
    "-P",
    env.MACOS_CERTIFICATE_PASSWORD,
    "-T",
    "/usr/bin/codesign",
    "-T",
    "/usr/bin/security",
  ]);
  execute("security", [
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:,codesign:",
    "-s",
    "-k",
    password,
    keychain,
  ]);
  execute("security", [
    "list-keychains",
    "-d",
    "user",
    "-s",
    keychain,
    ...previous,
  ]);
  const identities = execute("security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
    keychain,
  ]);
  if (
    !identities.includes("Developer ID Application:") ||
    !identities.includes(`(${env.MACOS_TEAM_ID})`)
  )
    throw new Error(
      "Imported P12 does not contain a usable Developer ID Application private key for the configured Apple team.",
    );
  appendFileSync(
    env.GITHUB_ENV,
    `CSC_KEYCHAIN=${keychain}\nAPPLE_API_KEY=${p8}\n`,
  );
  rmSync(p12, { force: true });
  return { root, keychain };
}
export function cleanupSigning(env = process.env, execute = run) {
  if (!env.RUNNER_TEMP)
    throw new Error("RUNNER_TEMP is required for credential cleanup.");
  const root = join(resolve(env.RUNNER_TEMP), "local-build-desk-signing");
  if (!existsSync(root)) return;
  let failure;
  try {
    const metadata = join(root, "previous-keychains.json");
    if (existsSync(metadata)) {
      const previous = JSON.parse(readFileSync(metadata, "utf8"));
      if (previous.length)
        execute("security", [
          "list-keychains",
          "-d",
          "user",
          "-s",
          ...previous,
        ]);
    }
  } catch (error) {
    failure = error;
  }
  try {
    if (existsSync(join(root, "release.keychain-db")))
      execute("security", [
        "delete-keychain",
        join(root, "release.keychain-db"),
      ]);
  } catch (error) {
    failure ??= error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (failure) throw failure;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv[2] === "cleanup") cleanupSigning();
    else prepareSigning();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
