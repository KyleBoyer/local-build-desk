import { readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Each architecture is signed on its own runner, so neither electron-builder
// run can describe both ZIPs. electron-updater's MacUpdater picks the file
// whose name contains "arm64" on Apple silicon and any other ZIP on Intel.
export function updateManifest(directory, tag, releaseDate = new Date()) {
  const version = tag.replace(/^v/, "");
  const files = ["arm64", "x64"].map((arch) => {
    const url = `Local-Build-Desk-${version}-${arch}.zip`;
    const path = join(directory, url);
    return {
      url,
      sha512: createHash("sha512").update(readFileSync(path)).digest("base64"),
      size: statSync(path).size,
    };
  });
  // Legacy single-file fields point at the Intel build, which also runs on
  // Apple silicon through Rosetta.
  const fallback = files[1];
  return [
    `version: ${version}`,
    "files:",
    ...files.flatMap((file) => [
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`,
    ]),
    `path: ${fallback.url}`,
    `sha512: ${fallback.sha512}`,
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
