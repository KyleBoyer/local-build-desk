import { settingsSchema } from "./settings-schema";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ProjectSettings, ProjectType } from "./types";
export interface ProjectApplication {
  directory: string;
  type: ProjectType;
  name: string;
}
export async function projectApplications(
  root: string,
): Promise<ProjectApplication[]> {
  root = await realpath(root);
  const found: ProjectApplication[] = [];
  const ignored = new Set([
    "node_modules",
    ".git",
    "Pods",
    ".build",
    "build",
    "dist",
    "out",
    "DerivedData",
    ".local-build-data",
    "release",
    ".gradle",
    ".expo",
  ]);
  async function visit(dir: string, depth: number) {
    if (depth > 5) return;
    const entries = await readdir(dir, { withFileTypes: true });
    const pkg = await readFile(join(dir, "package.json"), "utf8")
      .then(JSON.parse)
      .catch(() => ({}));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const type: ProjectType | undefined = deps.expo
      ? "expo"
      : deps["@capacitor/core"] ||
          entries.some((e) => /^capacitor\.config\.(ts|js|json)$/.test(e.name))
        ? "capacitor"
        : entries.some(
              (e) =>
                e.isDirectory() && /\.(xcodeproj|xcworkspace)$/.test(e.name),
            )
          ? "native-ios"
          : undefined;
    if (type) {
      found.push({
        directory: relative(root, dir) || ".",
        type,
        name: pkg.name ?? dir.split("/").at(-1)!,
      });
      return;
    }
    for (const entry of entries)
      if (
        entry.isDirectory() &&
        !ignored.has(entry.name) &&
        !entry.name.startsWith(".")
      )
        await visit(join(dir, entry.name), depth + 1);
  }
  await visit(root, 0);
  return found.sort((a, b) => a.directory.localeCompare(b.directory));
}
export async function projectSettings(
  root: string,
  settings: ProjectSettings = {},
): Promise<ProjectSettings> {
  const content = await readFile(join(root, "ios-submit.json"), "utf8").catch(
    (error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  let portable: any = {};
  if (content !== undefined) {
    try {
      portable = JSON.parse(content);
    } catch {
      throw new Error(
        "Invalid ios-submit.json. Fix its JSON syntax before importing or building.",
      );
    }
  }
  const result = settingsSchema.parse({ ...portable.settings, ...settings });
  if (result.appDirectory) return result;
  const applications = await projectApplications(root);
  if (applications.length === 1)
    return {
      ...result,
      appDirectory: applications[0].directory,
      projectType: result.projectType ?? applications[0].type,
    };
  if (applications.length > 1)
    throw new Error(
      `Choose the app directory before importing this repository: ${applications.map((a) => a.directory).join(", ")}. The CLI accepts --app-directory.`,
    );
  return result;
}
