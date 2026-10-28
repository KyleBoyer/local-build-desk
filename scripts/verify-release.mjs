import { spawnSync } from "node:child_process";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import plist from "plist";
function run(command, args) {
  const r = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 35 * 60 * 1000,
  });
  if (r.error || r.status !== 0)
    throw new Error(
      `${command} ${args[0]} failed (${r.status}): ${(r.stderr + r.stdout).trim() || r.error?.message}`,
    );
  return r.stdout + r.stderr;
}
// stapler fetches tickets from Apple's CloudKit service, whose connections
// from hosted runners sometimes drop mid-request.
function stapler(action, path) {
  for (let attempt = 1; ; attempt++)
    try {
      return run("xcrun", ["stapler", action, path]);
    } catch (error) {
      if (attempt === 6) throw error;
      console.warn(
        `${error.message}\nRetrying stapler ${action} in 30 seconds.`,
      );
      spawnSync("sleep", ["30"]);
    }
}
const team = process.env.MACOS_TEAM_ID;
if (!/^[A-Z0-9]{10}$/.test(team ?? ""))
  throw new Error("Expected Apple team is required.");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const root = resolve("release-signed"),
  app = join(root, "mac-universal", "Local Build Desk.app");
function verifyApp(path) {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", path]);
  const signature = run("codesign", ["--display", "--verbose=4", path]);
  if (
    !signature.includes(`TeamIdentifier=${team}`) ||
    !signature.includes("Developer ID Application:") ||
    !signature.includes("(runtime)") ||
    !signature.includes("Timestamp=")
  )
    throw new Error(
      "App does not have the expected timestamped Developer ID signature and hardened runtime.",
    );
  if (
    !readFileSync(join(path, "Contents", "Resources", "app-update.yml"), "utf8")
      .split("\n")
      .includes("provider: github")
  )
    throw new Error("App is missing its GitHub update feed configuration.");
  const info = plist.parse(
    readFileSync(join(path, "Contents", "Info.plist"), "utf8"),
  );
  if (
    info.CFBundleIdentifier !== manifest.build.appId ||
    info.CFBundleShortVersionString !== manifest.version
  )
    throw new Error("Signed app identity/version does not match this release.");
  const actual = run("lipo", [
    "-archs",
    join(path, "Contents", "MacOS", info.CFBundleExecutable),
  ]).trim();
  if (actual.split(/\s+/).sort().join(" ") !== "arm64 x86_64")
    throw new Error("App is not a universal arm64 and x86_64 build.");
  stapler("validate", path);
  run("spctl", ["--assess", "--type", "execute", "--verbose=2", path]);
}
verifyApp(app);
const base = `Local-Build-Desk-${manifest.version}-universal`;
const dmg = join(root, base + ".dmg"),
  zip = join(root, base + ".zip");
const auth = [
  "--key",
  process.env.APPLE_API_KEY,
  "--key-id",
  process.env.APPLE_API_KEY_ID,
  "--issuer",
  process.env.APPLE_API_ISSUER,
];
if (auth.some((value) => !value))
  throw new Error(
    "Notarization credentials are required to verify release containers.",
  );
const submitted = JSON.parse(
  run("xcrun", [
    "notarytool",
    "submit",
    dmg,
    ...auth,
    "--wait",
    "--timeout",
    "30m",
    "--output-format",
    "json",
  ]),
);
if (submitted.status !== "Accepted")
  throw new Error(
    `Apple did not accept the DMG (request ${submitted.id ?? "unknown"}). No release will be published.`,
  );
stapler("staple", dmg);
stapler("validate", dmg);
const dmgSignature = run("codesign", ["--display", "--verbose=4", dmg]);
if (!dmgSignature.includes(`TeamIdentifier=${team}`))
  throw new Error("DMG was not signed by the configured team.");
run("spctl", [
  "--assess",
  "--type",
  "open",
  "--context",
  "context:primary-signature",
  "--verbose=2",
  dmg,
]);
const unpack = mkdtempSync(
  join(process.env.RUNNER_TEMP || tmpdir(), "desk-verify-zip-"),
);
try {
  run("ditto", ["-x", "-k", zip, unpack]);
  verifyApp(join(unpack, "Local Build Desk.app"));
} finally {
  rmSync(unpack, { recursive: true, force: true });
}
const hashes = [dmg, zip].map(
  (path) =>
    `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${path.split("/").pop()}`,
);
writeFileSync(join(root, base + ".sha256"), hashes.join("\n") + "\n");
console.log(
  `Verified signed and notarized universal app, DMG, ZIP, identity, architecture, version, and SHA-256 checksums.`,
);
