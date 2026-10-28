import { realpathSync } from "node:fs";
import xcode from "xcode";
import { readdir, readFile, rm } from "node:fs/promises";
import {
  resolve,
  relative,
  dirname,
  basename,
  isAbsolute,
  sep,
  join,
} from "node:path";
import plist from "plist";
import { run, existsCommand, type CommandOptions } from "./process";
import { invariant } from "./errors";
import type {
  XcodeContainer,
  IOSBuildTarget,
  IOSTarget,
  ProjectSettings,
} from "./types";
export function inside(root: string, path: string) {
  const original = resolve(root),
    base = realpathSync(original);
  let result = resolve(original, path);
  if (result === original || result.startsWith(original + sep))
    result = resolve(base, relative(original, result));
  let parent = result;
  while (true) {
    try {
      result = resolve(realpathSync(parent), relative(parent, result));
      break;
    } catch {
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  root = base;
  invariant(
    result === resolve(root) || result.startsWith(resolve(root) + sep),
    "PROJECT_PATH",
    "Select a path inside the imported repository root. Include local dependencies by importing their common parent folder.",
  );
  return result;
}
const skippedDirectories = new Set([
  "node_modules",
  ".git",
  "Pods",
  ".build",
  "DerivedData",
  "build",
  "dist",
  "out",
  ".local-build-data",
  ".gradle",
]);
async function walkDirectories(
  root: string,
  visit: (dir: string, names: string[]) => boolean,
) {
  async function walk(dir: string, depth: number) {
    if (depth > 10) return;
    const entries = await readdir(dir, { withFileTypes: true });
    if (
      !visit(
        dir,
        entries.map((e) => e.name),
      )
    )
      return;
    for (const entry of entries)
      if (
        entry.isDirectory() &&
        !skippedDirectories.has(entry.name) &&
        !/\.(xcodeproj|xcworkspace)$/.test(entry.name)
      )
        await walk(join(dir, entry.name), depth + 1);
  }
  await walk(root, 0);
}
export async function xcodeContainers(root: string): Promise<XcodeContainer[]> {
  const found: XcodeContainer[] = [];
  await walkDirectories(root, (dir, names) => {
    for (const name of names)
      if (/\.(xcodeproj|xcworkspace)$/.test(name))
        found.push({
          path: relative(root, join(dir, name)),
          kind: name.endsWith(".xcworkspace") ? "workspace" : "project",
        });
    return true;
  });
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
// XcodeGen specs whose Xcode project is not committed. A tracked .xcodeproj next to
// the spec wins; otherwise the project is generated inside each disposable snapshot.
export async function xcodegenSpecs(root: string): Promise<string[]> {
  const specs: string[] = [];
  await walkDirectories(root, (dir, names) => {
    const spec = ["project.yml", "project.yaml"].find((n) => names.includes(n));
    if (spec) specs.push(relative(root, join(dir, spec)));
    return true;
  });
  if (!specs.length) return [];
  const git = await run("git", ["ls-files", "-z", "--", "."], {
    cwd: root,
    allowFailure: true,
  });
  const tracked =
    git.code === 0
      ? git.stdout
          .split("\0")
          .filter((f) => /\.xcodeproj\/project\.pbxproj$/.test(f))
          .map((f) => dirname(dirname(f)))
      : undefined;
  const pending: string[] = [];
  for (const spec of specs.sort()) {
    const dir = dirname(spec);
    const committed = tracked
      ? tracked.includes(dir)
      : (await readdir(join(root, dir))).some((n) => n.endsWith(".xcodeproj"));
    if (!committed) pending.push(spec);
  }
  return pending;
}
export async function generateXcodeProjects(
  root: string,
  specs: string[],
  options: CommandOptions = {},
) {
  if (!specs.length) return;
  invariant(
    await existsCommand("xcodegen", ["--version"], options.env),
    "XCODEGEN_REQUIRED",
    "This project generates its Xcode project with XcodeGen. Install XcodeGen in Guided setup (brew install xcodegen).",
  );
  for (const spec of specs) {
    const dir = dirname(inside(root, spec));
    // Locally generated (ignored) projects can be stale; always regenerate from the spec.
    for (const name of await readdir(dir))
      if (name.endsWith(".xcodeproj"))
        await rm(join(dir, name), { recursive: true, force: true });
    options.log?.(`Generating the Xcode project from ${spec} with XcodeGen…`);
    await run("xcodegen", ["generate", "--spec", basename(spec), "--quiet"], {
      ...options,
      cwd: dir,
    });
  }
}
export function containerArguments(container: XcodeContainer, root: string) {
  return [
    container.kind === "workspace" ? "-workspace" : "-project",
    inside(root, container.path),
  ];
}
export function expandBuildSetting(
  value: unknown,
  settings: Record<string, string>,
) {
  let text = String(value ?? "");
  for (let i = 0; i < 12 && /\$[({]/.test(text); i++) {
    const next = text.replace(
      /\$\(([^):]+)(?::[^)]*)?\)|\$\{([^}]+)\}/g,
      (original, a, b) =>
        (a ?? b) === "inherited" ? "" : (settings[a ?? b] ?? original),
    );
    if (next === text) break;
    text = next;
  }
  invariant(
    !/\$[({]/.test(text),
    "XCODE_SETTING",
    `Xcode could not resolve build setting ${text}. Check the selected scheme, configuration and xcconfig files.`,
  );
  return text.replace(/^"|"$/g, "");
}
export async function resolvedTargets(
  root: string,
  rows: any[],
  configuration: string,
): Promise<IOSTarget[]> {
  root = realpathSync(root);
  const targets: IOSTarget[] = [];
  for (const row of rows) {
    const s = row.buildSettings ?? {};
    const product = s.PRODUCT_TYPE;
    const app =
      product === "com.apple.product-type.application" ||
      (!product && s.WRAPPER_EXTENSION === "app");
    const extension =
      [
        "com.apple.product-type.app-extension",
        "com.apple.product-type.extensionkit-extension",
      ].includes(product) ||
      (!product && s.WRAPPER_EXTENSION === "appex");
    if (
      (!app && !extension) ||
      /watch|appletv|macos|xros/.test(String(s.SDKROOT ?? "")) ||
      (s.SUPPORTED_PLATFORMS && !/iphone/.test(s.SUPPORTED_PLATFORMS))
    )
      continue;
    const expand = (v: unknown) => expandBuildSetting(v, s);
    const sourceRoot = inside(root, expand(s.SRCROOT ?? "."));
    const file = (value: string) =>
      inside(root, isAbsolute(value) ? value : resolve(sourceRoot, value));
    const entitlementsFile = s.CODE_SIGN_ENTITLEMENTS
      ? file(expand(s.CODE_SIGN_ENTITLEMENTS))
      : undefined;
    const infoPlist = s.INFOPLIST_FILE
      ? file(expand(s.INFOPLIST_FILE))
      : undefined;
    let info: Record<string, any> = {};
    if (infoPlist) {
      const converted = await run(
        "plutil",
        ["-convert", "xml1", "-o", "-", infoPlist],
        { allowFailure: true },
      );
      if (!converted.code) info = plist.parse(converted.stdout) as any;
    }
    const bundleId = expand(
      s.PRODUCT_BUNDLE_IDENTIFIER ?? info.CFBundleIdentifier,
    );
    invariant(
      /^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(bundleId),
      "BUNDLE_ID_REQUIRED",
      `Target ${row.target} has no resolved bundle identifier. Select its configuration and configure PRODUCT_BUNDLE_IDENTIFIER.`,
    );
    targets.push({
      name: row.target,
      project: relative(root, file(expand(s.PROJECT_FILE_PATH))),
      configuration,
      bundleId,
      version: expand(
        s.MARKETING_VERSION ||
          s.INFOPLIST_KEY_CFBundleShortVersionString ||
          info.CFBundleShortVersionString,
      ),
      buildNumber: expand(
        s.CURRENT_PROJECT_VERSION ||
          s.INFOPLIST_KEY_CFBundleVersion ||
          info.CFBundleVersion,
      ),
      productType: app ? "application" : "extension",
      entitlements: entitlementsFile
        ? (plist.parse(await readFile(entitlementsFile, "utf8")) as any)
        : {},
      entitlementsFile: entitlementsFile && relative(root, entitlementsFile),
      infoPlist: infoPlist && relative(root, infoPlist),
      deploymentTarget: s.IPHONEOS_DEPLOYMENT_TARGET,
    });
  }
  invariant(
    targets.filter((t) => t.productType === "application").length === 1,
    "XCODE_APP_TARGET",
    "Select a scheme that builds exactly one iOS application. Embedded widgets and share extensions are supported; test/framework targets do not need provisioning profiles.",
  );
  return targets;
}
async function embeddedSettings(
  root: string,
  rows: any[],
  configuration: string,
  options: CommandOptions,
) {
  const cache = new Map<string, any>(),
    pending: { project: string; id: string }[] = [],
    visited = new Set<string>(),
    extra: any[] = [];
  const unquote = (v: any) => String(v ?? "").replace(/^"|"$/g, "");
  const ref = (v: any) => unquote(v?.value ?? v);
  const load = (path: string) => {
    const project = relative(root, inside(root, path));
    if (!cache.has(project)) {
      const parsed = xcode.project(join(root, project, "project.pbxproj"));
      parsed.parseSync();
      cache.set(project, parsed.hash.project.objects);
    }
    return { project, objects: cache.get(project) };
  };
  const referencePath = (
    objects: any,
    project: string,
    id: string,
    seen = new Set<string>(),
  ): string => {
    invariant(
      !seen.has(id),
      "XCODE_REFERENCE",
      "A cyclic Xcode project reference cannot be resolved.",
    );
    seen.add(id);
    const object =
      objects.PBXFileReference?.[id] ??
      objects.PBXGroup?.[id] ??
      objects.PBXVariantGroup?.[id];
    invariant(
      object,
      "XCODE_REFERENCE",
      "An embedded target references a missing Xcode project file.",
    );
    let base = dirname(inside(root, project));
    const tree = unquote(object.sourceTree || "<group>");
    if (tree === "<group>") {
      const parent = Object.entries<any>({
        ...objects.PBXGroup,
        ...objects.PBXVariantGroup,
      }).find(
        ([key, value]) =>
          !key.endsWith("_comment") &&
          (value.children ?? []).some((child: any) => ref(child) === id),
      );
      if (parent) base = referencePath(objects, project, parent[0], seen);
    } else if (tree === "<absolute>") base = "/";
    else
      invariant(
        tree === "SOURCE_ROOT",
        "XCODE_REFERENCE",
        `Project reference source tree ${tree} is unsupported. Keep native projects inside the imported root.`,
      );
    const path = unquote(
      object.path ?? (object.isa === "PBXFileReference" ? object.name : ""),
    ).replace(/\$\((?:SRCROOT|SOURCE_ROOT)\)/g, dirname(inside(root, project)));
    return inside(root, resolve(base, path));
  };
  const enqueueProxy = (objects: any, project: string, proxy: any) => {
    invariant(
      proxy,
      "XCODE_REFERENCE",
      "An embedded target's project reference is missing.",
    );
    const portal = ref(proxy.containerPortal);
    const other = objects.PBXFileReference?.[portal]
      ? referencePath(objects, project, portal)
      : project;
    const loaded = load(other),
      remote = ref(proxy.remoteGlobalIDString);
    const target =
      (loaded.objects.PBXNativeTarget?.[remote] ??
      loaded.objects.PBXAggregateTarget?.[remote] ??
      loaded.objects.PBXLegacyTarget?.[remote])
        ? remote
        : Object.entries<any>(loaded.objects.PBXNativeTarget ?? {}).find(
            ([key, value]) =>
              !key.endsWith("_comment") &&
              ref(value.productReference) === remote,
          )?.[0];
    invariant(
      target,
      "XCODE_REFERENCE",
      "Xcode could not resolve an embedded target in its referenced project.",
    );
    pending.push({ project: loaded.project, id: target });
  };
  for (const row of rows)
    if (row.buildSettings?.PROJECT_FILE_PATH) {
      const loaded = load(row.buildSettings.PROJECT_FILE_PATH);
      const target = Object.entries<any>(
        loaded.objects.PBXNativeTarget ?? {},
      ).find(
        ([key, value]) =>
          !key.endsWith("_comment") && unquote(value.name) === row.target,
      );
      if (target) pending.push({ project: loaded.project, id: target[0] });
    }
  while (pending.length) {
    const item = pending.pop()!,
      key = JSON.stringify(item);
    if (visited.has(key)) continue;
    visited.add(key);
    const { objects } = load(item.project),
      target =
        objects.PBXNativeTarget[item.id] ??
        objects.PBXAggregateTarget?.[item.id] ??
        objects.PBXLegacyTarget?.[item.id],
      name = unquote(target.name),
      product = unquote(target.productType);
    invariant(
      !/watch|appletv|on-demand-install|vision/i.test(product),
      "UNSUPPORTED_EMBEDDED_TARGET",
      `Embedded target ${name} (${product}) is outside the supported iOS app/widget/share-extension workflow. Choose a scheme without that target.`,
    );
    for (const value of target.dependencies ?? []) {
      const dep = objects.PBXTargetDependency?.[ref(value)];
      if (dep?.target)
        pending.push({ project: item.project, id: ref(dep.target) });
      else if (dep?.targetProxy)
        enqueueProxy(
          objects,
          item.project,
          objects.PBXContainerItemProxy?.[ref(dep.targetProxy)],
        );
    }
    for (const phase of target.buildPhases ?? [])
      for (const value of objects.PBXCopyFilesBuildPhase?.[ref(phase)]?.files ??
        []) {
        const file = objects.PBXBuildFile?.[ref(value)],
          fileId = ref(file?.fileRef);
        const local = Object.entries<any>(objects.PBXNativeTarget ?? {}).find(
          ([id, t]) =>
            !id.endsWith("_comment") && ref(t.productReference) === fileId,
        );
        if (local) pending.push({ project: item.project, id: local[0] });
        else if (objects.PBXReferenceProxy?.[fileId])
          enqueueProxy(
            objects,
            item.project,
            objects.PBXContainerItemProxy?.[
              ref(objects.PBXReferenceProxy[fileId].remoteRef)
            ],
          );
      }
    if (
      ![
        "com.apple.product-type.app-extension",
        "com.apple.product-type.extensionkit-extension",
      ].includes(product) ||
      rows.some(
        (r) =>
          r.target === name &&
          r.buildSettings?.PROJECT_FILE_PATH &&
          inside(root, r.buildSettings.PROJECT_FILE_PATH) ===
            inside(root, item.project),
      )
    )
      continue;
    const result = await run(
      "xcodebuild",
      [
        "-project",
        inside(root, item.project),
        "-target",
        name,
        "-configuration",
        configuration,
        "-sdk",
        "iphoneos",
        "-showBuildSettings",
        "-json",
        "-disableAutomaticPackageResolution",
      ],
      options,
    );
    extra.push(...JSON.parse(result.stdout));
  }
  return [...rows, ...extra];
}
export async function inspectXcode(
  root: string,
  settings: ProjectSettings,
  options: CommandOptions = {},
  strict = false,
): Promise<{
  containers: XcodeContainer[];
  schemes: string[];
  selected?: IOSBuildTarget;
  issue?: string;
}> {
  root = realpathSync(root);
  const scope = inside(root, settings.appDirectory ?? ".");
  const containers = (await xcodeContainers(scope)).map((c) => ({
    ...c,
    path: relative(root, join(scope, c.path)),
  }));
  try {
    const explicit =
      settings.iosTarget ??
      (settings.workspace
        ? relative(root, resolve(scope, "ios", settings.workspace))
        : undefined);
    const candidates = containers.filter(
      (c) =>
        c.kind === "workspace" ||
        !containers.some(
          (w) => w.kind === "workspace" && dirname(w.path) === dirname(c.path),
        ),
    );
    const container = explicit
      ? containers.find((c) => resolve(root, c.path) === inside(root, explicit))
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    invariant(
      container,
      "XCODE_CONTAINER",
      containers.length
        ? "Choose an Xcode project/workspace in project settings; more than one app container was found."
        : "No Xcode project/workspace found. Add an iOS application target in Xcode first.",
    );
    const packageFlags = (await hasResolved(root, {
      container,
      scheme: settings.scheme ?? "",
      configuration: settings.configuration ?? "Release",
      targets: [],
    }))
      ? ["-onlyUsePackageVersionsFromResolvedFile"]
      : [];
    const args = containerArguments(container, root),
      opts = { ...options, cwd: root, timeout: 120000, log: undefined };
    const listed = JSON.parse(
      (
        await run(
          "xcodebuild",
          [...args, "-list", "-json", ...packageFlags],
          opts,
        )
      ).stdout,
    );
    const schemes: string[] = [
      ...new Set<string>((listed.workspace ?? listed.project)?.schemes ?? []),
    ];
    const applicationNames = new Set<string>();
    for (const entry of containers.filter((c) => c.kind === "project")) {
      try {
        const parsed = xcode.project(join(root, entry.path, "project.pbxproj"));
        parsed.parseSync();
        for (const [key, value] of Object.entries<any>(
          parsed.hash.project.objects.PBXNativeTarget ?? {},
        ))
          if (
            !key.endsWith("_comment") &&
            String(value.productType).replace(/^"|"$/g, "") ===
              "com.apple.product-type.application"
          )
            applicationNames.add(String(value.name).replace(/^"|"$/g, ""));
      } catch {
        /* The target picker remains available for project formats the parser cannot inspect. */
      }
    }
    const appSchemes = schemes.filter((s) => applicationNames.has(s));
    const scheme =
      settings.scheme ??
      (appSchemes.length === 1
        ? appSchemes[0]
        : schemes.length === 1
          ? schemes[0]
          : undefined);
    if (!scheme)
      return {
        containers,
        schemes,
        issue: "Choose the application scheme in project settings.",
      };
    invariant(
      schemes.includes(scheme),
      "SCHEME_REQUIRED",
      `Scheme ${scheme} is unavailable. Choose one of: ${schemes.join(", ")}`,
    );
    const configuration = settings.configuration ?? "Release";
    const rows = JSON.parse(
      (
        await run(
          "xcodebuild",
          [
            ...args,
            "-scheme",
            scheme,
            "-configuration",
            configuration,
            "-sdk",
            "iphoneos",
            "-showBuildSettings",
            "-json",
            ...packageFlags,
          ],
          opts,
        )
      ).stdout,
    );
    return {
      containers,
      schemes,
      selected: {
        container,
        scheme,
        configuration,
        targets: await resolvedTargets(
          root,
          await embeddedSettings(root, rows, configuration, opts),
          configuration,
        ),
      },
    };
  } catch (error) {
    if (strict) throw error;
    return { containers, schemes: [], issue: (error as Error).message };
  }
}
export async function resolveSwiftPackages(
  root: string,
  target: IOSBuildTarget,
  options: CommandOptions,
) {
  await run(
    "xcodebuild",
    [
      ...containerArguments(target.container, root),
      "-scheme",
      target.scheme,
      "-resolvePackageDependencies",
      ...((await hasResolved(root, target))
        ? ["-onlyUsePackageVersionsFromResolvedFile"]
        : []),
    ],
    { ...options, cwd: root },
  );
}
async function hasResolved(root: string, target: IOSBuildTarget) {
  for (const path of [
    join(target.container.path, "xcshareddata/swiftpm/Package.resolved"),
    join(
      target.container.path,
      "project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
    ),
  ])
    try {
      await readFile(join(root, path));
      return true;
    } catch {}
  return false;
}
