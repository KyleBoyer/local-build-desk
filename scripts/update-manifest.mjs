import { readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// electron-builder's own latest-mac.yml also hashes the DMG, which changes
// when verification staples it, so the feed is written from the final ZIP.
// The arm64 name lets electron-updater select the Apple silicon package.
export function updateManifest(directory, tag, releaseDate = new Date()) {
  const version = tag.replace(/^v/, "");
  const url = `Local-Build-Desk-${version}-arm64.zip`;
  const path = join(directory, url);
  const sha512 = createHash("sha512")
    .update(readFileSync(path))
    .digest("base64");
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${url}`,
    `    sha512: ${sha512}`,
    `    size: ${statSync(path).size}`,
    `path: ${url}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate.toISOString()}'`,
    "",
  ].join("\n");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [directory, tag] = process.argv.slice(2);
  if (!directory || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? ""))
    throw new Error("Usage: update-manifest.mjs <directory> <vX.Y.Z>");
  writeFileSync(
    join(directory, "latest-mac.yml"),
    updateManifest(directory, tag),
  );
  console.log(`Wrote latest-mac.yml for ${tag}.`);
}
