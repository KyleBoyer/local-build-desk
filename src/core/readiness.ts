import type {
  Artifact,
  Check,
  Job,
  Project,
  ReadinessItem,
  ReleaseReadiness,
} from "./types";
import { policyDigest } from "./release-validation";
export function readinessReport(
  project: Project,
  jobs: Job[],
  artifacts: Artifact[],
  checks: Check[],
  destination: "testflight" | "appstore" = "testflight",
): ReleaseReadiness {
  const items: ReadinessItem[] = [];
  const builds = jobs
    .filter(
      (j) =>
        j.projectId === project.id &&
        j.kind === "build" &&
        j.platform === "ios",
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const job =
    builds.find(
      (j) =>
        j.storeEligible &&
        artifacts.some((a) => a.id === j.artifactId && a.kind === "ipa"),
    ) ?? builds[0];
  const artifact =
    job && artifacts.find((a) => a.id === job.artifactId && a.kind === "ipa");
  const add = (
    id: string,
    title: string,
    status: ReadinessItem["status"],
    detail: string,
    action?: string,
  ) => items.push({ id, title, status, detail, action });
  for (const name of ["Xcode", "iOS SDK", "Build storage"]) {
    const check = checks.find((c) => c.name === name);
    add(
      name,
      name,
      !check || check.status === "error"
        ? "blocked"
        : check.status === "warning"
          ? "warning"
          : "ready",
      check?.detail ?? "Not checked",
      check?.action,
    );
  }
  add(
    "connection",
    "Apple connection",
    project.settings.appleConnectionId ? "ready" : "blocked",
    project.settings.appleConnectionId
      ? "An Apple connection is selected; access is verified below."
      : "Connect the team API key in Guided setup.",
  );
  add(
    "signing",
    "Signing",
    project.settings.iosSigningId ? "pending" : "blocked",
    project.settings.iosSigningId
      ? "Checking the private-key container and matching profiles for each target…"
      : "Set up signing in Guided setup.",
  );
  add(
    "artifact",
    "Verified production IPA",
    artifact && job?.storeEligible ? "ready" : "blocked",
    artifact
      ? `Version ${artifact.version} (${artifact.buildNumber}) · SHA-256 ${artifact.sha256.slice(0, 16)}…`
      : "Build a production IPA to continue.",
  );
  const policy = project.settings.releaseChecks;
  if (policy?.enabled) {
    const proof = job?.validation;
    const valid =
      proof?.state === "passed" &&
      proof.mode === "all" &&
      proof.policyDigest === policyDigest(project.settings) &&
      proof.sourceHash === job?.facts?.sourceHash;
    add(
      "tests",
      "Required release checks",
      valid ? "ready" : policy.required ? "blocked" : "warning",
      valid
        ? `${proof.runs.length} test/capture run(s) passed for this artifact's source and policy.`
        : "This artifact has no passing results for the selected check policy. Run a fresh build.",
    );
    add(
      "screenshots",
      "Automated screenshots",
      !policy.screenshots
        ? "warning"
        : proof?.screenshots.length && valid
          ? "ready"
          : "pending",
      !policy.screenshots
        ? "No capture plan configured."
        : `${proof?.screenshots.length ?? 0} verified capture(s). Use screenshots to prepare the local listing overlay.`,
    );
  } else
    add(
      "tests",
      "Release checks",
      "warning",
      "Tests are not configured. Enable required checks on the Tests screen to gate uploads.",
    );
  // Independent submission has its own job. The build's validation proof stays
  // on the build; delivery belongs to the latest submission of that exact IPA.
  const deliveryJob =
    job &&
    jobs
      .filter(
        (j) =>
          j.projectId === project.id &&
          j.artifactId &&
          j.artifactId === job.artifactId &&
          (j.submission ||
            (j.kind === "submit" && ["queued", "running"].includes(j.status))),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const submission = deliveryJob?.submission;
  const uploaded =
    !!submission &&
    ["uploaded", "processing", "accepted", "draft"].includes(submission.state);
  const processed = submission?.state === "accepted";
  // Accepted is not proof of a physical TestFlight installation.
  const assigned =
    processed &&
    !!project.settings.testFlightGroupId &&
    /available to internal group/i.test(submission?.message ?? "");
  add(
    "testflight-group",
    "Internal TestFlight group",
    project.settings.testFlightGroupId ? "ready" : "warning",
    project.settings.testFlightGroupName ??
      "Choose an internal testing group in Guided setup.",
  );
  add(
    "delivery",
    "TestFlight delivery",
    assigned
      ? "ready"
      : submission?.state === "uncertain"
        ? "blocked"
        : "pending",
    submission?.message ??
      "Build, upload, Apple processing and group assignment are tracked separately.",
  );
  add(
    "device-check",
    "Physical-device check",
    "warning",
    "Simulator tests do not prove NFC, physical fold behavior, permissions on a real device, or TestFlight installation. Keep a device smoke check in your release process.",
  );
  return {
    projectId: project.id,
    jobId: job?.id,
    destination,
    checkedAt: new Date().toISOString(),
    items,
    canUpload:
      !uploaded &&
      !(
        deliveryJob?.kind === "submit" &&
        ["queued", "running"].includes(deliveryJob.status)
      ) &&
      !items.some(
        (i) =>
          i.status === "blocked" ||
          (i.id === "signing" && i.status === "pending"),
      ),
    delivery: { built: !!artifact, uploaded, processed, assigned },
  };
}
