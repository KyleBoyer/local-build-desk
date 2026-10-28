import {
  cp,
  mkdir,
  readdir,
  lstat,
  readlink,
  readFile,
} from "node:fs/promises";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { run } from "./process";
import { invariant } from "./errors";
import { hasFile } from "./config";
const ignored = new Set([
  "node_modules",
  ".git",
  ".expo",
  ".gradle",
  ".kotlin",
  "Pods",
  "DerivedData",
  "build",
  "dist",
  "out",
  "release",
  ".local-build-desk",
  ".DS_Store",
  ".claude",
  ".codex",
]);
export function eligible(
  path: string,
  native: { ios: boolean; android: boolean },
) {
  const parts = path.split("/");
  if (parts.some((p) => ignored.has(p))) return false;
  if (
    parts.some((p) => /^\.env(?:\.|$)/.test(p)) ||
    /(?:^|\/)(?:credentials\.json|google-services\.json|GoogleService-Info\.plist|local\.properties)$/.test(
      path,
    )
  )
    return false;
  if (/\.(p8|p12|pfx|key|pem|mobileprovision|keystore|jks)$/i.test(path))
    return false;
  if (
    ["ios", "android"].includes(parts[0]) &&
    !native[parts[0] as "ios" | "android"]
  )
    return false;
  return true;
}
export async function snapshot(
  source: string,
  destination: string,
  native: { ios: boolean; android: boolean },
  signal?: AbortSignal,
  copyFiles = true,
): Promise<string> {
  const sourceRoot = resolve(source),
    destRoot = resolve(destination);
  invariant(
    !destRoot.startsWith(sourceRoot + sep),
    "SNAPSHOT_LOCATION",
    "Build storage must be outside the project folder.",
  );
  if (copyFiles) await mkdir(destRoot, { recursive: true, mode: 0o700 });
  const git = await run(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: sourceRoot, allowFailure: true, signal },
  );
  let files: string[] = [];
  if (git.code === 0)
    files = [...new Set(git.stdout.split("\0").filter(Boolean))];
  else {
    const walk = async (dir: string) => {
      for (const entry of await readdir(join(sourceRoot, dir), {
        withFileTypes: true,
      })) {
        const name = dir ? `${dir}/${entry.name}` : entry.name;
        if (!eligible(name, native)) continue;
        if (entry.isDirectory()) await walk(name);
        else files.push(name);
      }
    };
    await walk("");
  }
  // Maintained native files can be intentionally ignored by Git; include them explicitly.
  for (const platform of ["ios", "android"] as const)
    if (native[platform] && (await hasFile(join(sourceRoot, platform)))) {
      const walk = async (dir: string) => {
        for (const entry of await readdir(join(sourceRoot, dir), {
          withFileTypes: true,
        })) {
          const name = `${dir}/${entry.name}`;
          if (!eligible(name, native)) continue;
          if (entry.isDirectory()) await walk(name);
          else files.push(name);
        }
      };
      await walk(platform);
    }
  const hash = createHash("sha256");
  for (const path of [...new Set(files)].sort()) {
    if (signal?.aborted) throw new Error("Operation cancelled.");
    if (!eligible(path, native)) continue;
    const from = resolve(sourceRoot, path),
      to = resolve(destRoot, path);
    invariant(
      from.startsWith(sourceRoot + sep) && to.startsWith(destRoot + sep),
      "SNAPSHOT_PATH",
      "A project path escapes the project root.",
    );
    if (!(await hasFile(from))) continue;
    const stat = await lstat(from);
    if (stat.isSymbolicLink()) {
      const link = await readlink(from);
      const target = resolve(join(from, ".."), link);
      invariant(
        !isAbsolute(link) && !relative(sourceRoot, target).startsWith(".."),
        "EXTERNAL_SYMLINK",
        `Symlink ${path} points outside the project. Vendor that dependency or use a self-contained project root.`,
      );
      hash
        .update(
          JSON.stringify(["link", path, stat.mode, Buffer.byteLength(link)]) +
            "\0",
        )
        .update(link)
        .update("\0");
    } else if (stat.isFile()) {
      const content = await readFile(from);
      if (
        path.endsWith(".json") &&
        /"(?:private_key|privateKey)"\s*:/.test(content.toString("utf8"))
      )
        continue;
      hash
        .update(
          JSON.stringify(["file", path, stat.mode, content.length]) + "\0",
        )
        .update(content)
        .update("\0");
    } else continue;
    if (copyFiles) {
      await mkdir(join(to, ".."), { recursive: true });
      await cp(from, to, { dereference: false, preserveTimestamps: true });
    }
  }
  return hash.digest("hex");
}
