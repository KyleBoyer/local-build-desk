import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Store } from "./database";
import type { Job, Project } from "./types";
import type { Screenshot } from "./app-store-listing";
import { invariant } from "./errors";

interface Generated {
  jobId: string;
  sourceHash?: string;
  validationFingerprint: string;
  buildNumber?: string;
  version?: string;
  files: { sha256: string; name: string }[];
}

/** Screenshots written by `useScreenshots` carry the job that captured them.
 * Before any listing write, prove they still describe the build being attached:
 * same capture job, same source, same version/build, byte-identical files.
 * Hand-supplied listings without that stamp are the user's responsibility. */
export async function assertScreenshotProvenance(
  store: Store,
  project: Project,
  loaded: { listing: Record<string, unknown>; screenshots: Screenshot[] },
  buildNumber: string | undefined,
  version: string,
) {
  const generated = loaded.listing.generatedScreenshots as
    Generated | undefined;
  if (!generated) return;
  const job = store.list<Job>("jobs").find((j) => j.id === generated.jobId);
  const stale = (why: string) =>
    `The listing's automated screenshots ${why}. Capture again with a fresh build and choose "Use screenshots" before applying; nothing was sent.`;
  invariant(
    job && job.projectId === project.id && job.validation?.state === "passed",
    "SCREENSHOT_PROVENANCE",
    stale("no longer match a passing capture run for this project"),
  );
  invariant(
    job.validation.fingerprint === generated.validationFingerprint &&
      job.facts?.sourceHash === generated.sourceHash,
    "SCREENSHOT_PROVENANCE",
    stale("came from a different source or capture policy"),
  );
  invariant(
    job.version === version,
    "SCREENSHOT_PROVENANCE",
    stale(`were captured for version ${job.version}, not ${version}`),
  );
  invariant(
    buildNumber !== undefined && job.buildNumber === buildNumber,
    "SCREENSHOT_PROVENANCE",
    stale(
      `were captured from build ${job.buildNumber}, but the listing would attach ${buildNumber ? `build ${buildNumber}` : "no verified build"}`,
    ),
  );
  invariant(
    loaded.screenshots.length === generated.files.length,
    "SCREENSHOT_PROVENANCE",
    stale("were added to or removed from the listing by hand"),
  );
  for (const [i, shot] of loaded.screenshots.entries()) {
    const sha256 = createHash("sha256")
      .update(await readFile(shot.path))
      .digest("hex");
    invariant(
      sha256 === generated.files[i]!.sha256,
      "SCREENSHOT_PROVENANCE",
      stale(`changed on disk (${shot.name})`),
    );
  }
}
