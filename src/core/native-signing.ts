import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import xcode from "xcode";
import plist from "plist";
import {
  validateProvision,
  signingEnvironments,
  expandSigningEntitlements,
} from "./signing";
import { inside } from "./xcode-project";
import { invariant } from "./errors";
import type { IOSBuildTarget, Profile } from "./types";
import type { Provision } from "./signing";
export async function configureNativeSigning(
  root: string,
  target: IOSBuildTarget,
  signing: { identity: string; teamId: string; profiles: Provision[] },
  profile: Profile,
  log?: (s: string) => void,
) {
  const mapped: Record<string, string> = {},
    projects = new Map<string, any>();
  for (const item of target.targets) {
    const candidates = signing.profiles
      .filter((p) => {
        try {
          validateProvision(
            p,
            item.bundleId,
            signing.teamId,
            expandSigningEntitlements(
              signingEnvironments(item.entitlements, p),
              p,
              item.bundleId,
              signing.teamId,
            ),
            profile.distribution,
          );
          return true;
        } catch {
          return false;
        }
      })
      .sort(
        (a, b) =>
          new Date(b.ExpirationDate).getTime() -
          new Date(a.ExpirationDate).getTime(),
      );
    const selected = candidates[0];
    invariant(
      selected,
      "TARGET_PROFILE",
      `No valid ${profile.distribution === "store" ? "App Store" : "ad-hoc"} profile matches ${item.name} (${item.bundleId}) and its entitlements. Complete signing setup for every embedded target.`,
    );
    const projectPath = inside(root, item.project),
      file = join(projectPath, "project.pbxproj");
    let project = projects.get(file);
    if (!project) {
      project = xcode.project(file);
      project.parseSync();
      projects.set(file, project);
    }
    const objects = project.hash.project.objects,
      targets = objects.PBXNativeTarget ?? {};
    const entry = Object.entries<any>(targets).find(
      ([key, t]) =>
        !key.endsWith("_comment") &&
        String(t.name).replace(/^"|"$/g, "") === item.name,
    )?.[1];
    invariant(
      entry,
      "SIGNING_TARGET",
      `Xcode target ${item.name} was not found in ${item.project}.`,
    );
    let count = 0;
    for (const ref of objects.XCConfigurationList[entry.buildConfigurationList]
      ?.buildConfigurations ?? []) {
      const cfg = objects.XCBuildConfiguration[ref.value ?? ref];
      if (String(cfg?.name).replace(/^"|"$/g, "") !== target.configuration)
        continue;
      const s = (cfg.buildSettings ??= {});
      // Override resolved values only in the copy; all unrelated Xcode objects survive the round trip.
      s.PRODUCT_BUNDLE_IDENTIFIER = `"${item.bundleId}"`;
      s.CODE_SIGN_STYLE = "Manual";
      s.DEVELOPMENT_TEAM = signing.teamId;
      s.CODE_SIGN_IDENTITY = `"${signing.identity}"`;
      s.PROVISIONING_PROFILE_SPECIFIER = `"${selected.UUID}"`;
      delete s["PROVISIONING_PROFILE"];
      for (const key of Object.keys(s))
        if (
          /^(?:CODE_SIGN_STYLE|DEVELOPMENT_TEAM|CODE_SIGN_IDENTITY|PROVISIONING_PROFILE_SPECIFIER)\[/.test(
            key,
          )
        )
          delete s[key];
      count++;
    }
    invariant(
      count,
      "SIGNING_CONFIGURATION",
      `Configuration ${target.configuration} is missing for ${item.name}.`,
    );
    if (item.entitlementsFile) {
      const path = inside(root, item.entitlementsFile),
        entitlements = signingEnvironments(item.entitlements, selected);
      await writeFile(path, plist.build(entitlements));
    }
    mapped[item.bundleId] = selected.UUID;
    log?.(`Matched ${item.name} · ${item.bundleId} · ${selected.Name}`);
  }
  for (const [file, project] of projects)
    await writeFile(file, project.writeSync());
  return mapped;
}
export async function applyNativeVersions(
  root: string,
  target: IOSBuildTarget,
  version: string,
  number: string,
) {
  for (const item of target.targets)
    if (item.infoPlist) {
      const path = inside(root, item.infoPlist);
      // Xcode's command-line settings cover generated plists; literal plist versions need an override in the snapshot.
      const { run } = await import("./process");
      const converted = await run("plutil", [
        "-convert",
        "xml1",
        "-o",
        "-",
        path,
      ]);
      const info = plist.parse(converted.stdout) as any;
      if (info.CFBundleVersion !== undefined) info.CFBundleVersion = number;
      if (info.CFBundleShortVersionString !== undefined)
        info.CFBundleShortVersionString = version;
      await writeFile(path, plist.build(info));
    }
}
