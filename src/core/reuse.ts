import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Vault } from "./vault";
import { run } from "./process";
import { snapshot } from "./snapshot";
import { inspectProject, resolveProfile, toolEnvironment } from "./config";
import { doctor } from "./doctor";
import type { Check, Inspection, Platform, Profile, Project } from "./types";
function canonical(value: any): any {
  return Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
}
export async function reuseKeys(
  project: Project,
  inspection: Inspection,
  profile: Profile,
  platform: Platform,
  sourceHash: string,
  checks: Check[],
  vault: Vault,
  importedEnv: Record<string, string>,
) {
  if (!vault.canFingerprint) return {};
  const credentials = [];
  for (const key of [
    "iosSigningId",
    "androidSigningId",
    "envCredentialId",
  ] as const)
    if (project.settings[key])
      credentials.push(await vault.get(project.settings[key]));
  const tools = checks
    .filter((c) =>
      [
        "Node.js",
        "Xcode",
        "iOS SDK",
        "CocoaPods",
        "Java",
        "Android SDK",
        "Android NDK",
      ].includes(c.name),
    )
    .map((c) => [c.name, c.detail]);
  const ambient = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !["_", "PWD", "OLDPWD", "SHLVL", "TMPDIR", "XPC_SERVICE_NAME"].includes(
          key,
        ),
    ),
  );
  const shared = {
    version: 1,
    platform,
    profile: profile.raw,
    settings: project.settings,
    tools,
    credentials,
    ambient,
  };
  const reuseFingerprint = await vault.fingerprint(
    JSON.stringify(
      canonical({
        ...shared,
        sourceHash,
        config: inspection.config,
        environment: importedEnv,
      }),
    ),
  );
  let nativeReuseFingerprint: string | undefined;
  if (profile.developmentClient) {
    const script = `const {createRequire}=require('node:module');const req=createRequire(process.argv[1]+'/package.json');const sdk=req('@expo/fingerprint');sdk.createFingerprintAsync(process.argv[1],{platforms:[process.argv[2]],hashAlgorithm:'sha256',nativeModuleSourceType:'files',sourceSkips:0,silent:true}).then(v=>console.log('LBD_NATIVE:'+v.hash)).catch(()=>process.exitCode=1)`;
    const result = await run(
      project.settings.nodePath ?? "node",
      ["-e", script, project.path, platform],
      {
        cwd: project.path,
        env: {
          ...toolEnvironment(project.settings),
          ...importedEnv,
          ...profile.env,
          EAS_BUILD: "true",
          EAS_BUILD_PROFILE: profile.name,
        },
        allowFailure: true,
        timeout: 90000,
      },
    ).catch(() => undefined);
    const native =
      result?.code === 0
        ? result.stdout.match(/LBD_NATIVE:([a-f0-9]{40,64})\s*$/)?.[1]
        : undefined;
    if (native)
      nativeReuseFingerprint = await vault.fingerprint(
        JSON.stringify(canonical({ ...shared, native })),
      );
  }
  return { reuseFingerprint, nativeReuseFingerprint };
}
export async function inspectReuse(
  project: Project,
  profileName: string,
  platform: Platform,
  vault: Vault,
) {
  const imported = project.settings.envCredentialId
    ? (await vault.get(project.settings.envCredentialId, "environment")).values
    : {};
  let inspection = await inspectProject(
    project.path,
    project.settings,
    imported,
  );
  const profile = resolveProfile(inspection.eas, profileName, platform);
  inspection = await inspectProject(project.path, project.settings, {
    ...imported,
    ...profile.env,
  });
  const sourceHash = await snapshot(
    project.path,
    join(tmpdir(), "desk-hash-" + randomUUID()),
    inspection.native,
    undefined,
    false,
  );
  const checks = await doctor(project.settings, platform, false);
  return {
    inspection,
    profile,
    ...(await reuseKeys(
      project,
      inspection,
      profile,
      platform,
      sourceHash,
      checks,
      vault,
      imported,
    )),
  };
}
