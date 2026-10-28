import { spawnSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
export function validateRelease(tag, version, ref, event) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? ""))
    throw new Error(
      "Release tag must be vMAJOR.MINOR.PATCH (optionally a prerelease).",
    );
  if (tag !== `v${version}`)
    throw new Error("Release tag must match package.json version.");
  if (event === "workflow_dispatch" && ref !== "refs/heads/main")
    throw new Error("Manual signing releases must run from main.");
  if (event === "push" && ref !== `refs/tags/${tag}`)
    throw new Error("Signing releases require the matching version tag.");
  if (!["push", "workflow_dispatch"].includes(event))
    throw new Error("Pull requests cannot run signing releases.");
  return { tag, version, prerelease: tag.includes("-") };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const result = validateRelease(
    process.env.RELEASE_TAG,
    manifest.version,
    process.env.GITHUB_REF,
    process.env.GITHUB_EVENT_NAME,
  );
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (commit.status !== 0 || !/^[a-f0-9]{40}$/.test(commit.stdout.trim()))
    throw new Error("Cannot determine the release source commit.");
  const source = commit.stdout.trim();
  const remote = spawnSync(
    "git",
    [
      "ls-remote",
      "--tags",
      "origin",
      `refs/tags/${result.tag}`,
      `refs/tags/${result.tag}^{}`,
    ],
    { encoding: "utf8" },
  );
  if (remote.status !== 0)
    throw new Error("Cannot verify the release tag on origin.");
  const lines = remote.stdout.trim().split("\n").filter(Boolean);
  const peeled = lines.find((line) => line.endsWith("^{}")) || lines[0];
  if (peeled && peeled.split(/\s+/)[0] !== source)
    throw new Error(
      "Existing release tag points to a different commit. No binaries were signed or published.",
    );
  result.sha = source;
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(result)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
  );
  console.log(`Preparing signed release ${result.tag}.`);
}
