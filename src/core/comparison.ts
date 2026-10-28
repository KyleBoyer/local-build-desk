import type { Artifact, BuildComparison, Job } from "./types";
const stable = (value: any): any =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
const format = (value: unknown): string =>
  value === undefined
    ? "Not recorded"
    : typeof value === "object"
      ? JSON.stringify(stable(value), null, 2)
      : String(value);
export function compareBuilds(
  job: Job,
  jobs: Job[],
  artifacts: Artifact[],
): BuildComparison {
  const baseline = jobs
    .filter(
      (other) =>
        other.id !== job.id &&
        other.kind === "build" &&
        other.status === "succeeded" &&
        other.platform === job.platform &&
        other.bundleId === job.bundleId &&
        (other.projectId === job.projectId || !!job.bundleId) &&
        other.createdAt < job.createdAt,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!baseline)
    return {
      fields: [],
      note: "No earlier successful build for this app and platform yet.",
    };
  const facts = (item: Job) => ({
    "Project type":
      item.facts?.projectType ?? item.projectSnapshot?.type ?? "expo",
    "Native target": item.facts?.nativeTarget,
    "App identity": item.bundleId,
    "App version": item.version,
    "Build number": item.buildNumber,
    Profile: item.profile,
    Configuration: item.facts?.configuration,
    Distribution: item.facts?.distribution,
    "Development client": item.facts?.developmentClient,
    Simulator: item.facts?.simulator,
    "Signing identity": item.facts?.signing,
    Entitlements: item.facts?.entitlements,
    "Target entitlements": item.facts?.targetEntitlements,
    Destination: item.facts?.destination ?? item.submission?.destination,
    Xcode: item.toolchain?.xcodeVersion,
    "iOS SDK": item.toolchain?.iosSdk,
    "Source fingerprint": item.facts?.sourceHash,
    "Source commit": item.facts?.sourceCommit,
    "Native tools": item.facts?.toolVersions,
    "Artifact size (bytes)": artifacts.find((a) => a.id === item.artifactId)
      ?.size,
  });
  const before = facts(baseline),
    after = facts(job);
  return {
    baselineId: baseline.id,
    baselineLabel: `${baseline.platform} #${baseline.buildNumber ?? baseline.id.slice(0, 8)} · ${baseline.profile}`,
    fields: Object.keys(after).map((field) => ({
      field,
      before: format(before[field as keyof typeof before]),
      after: format(after[field as keyof typeof after]),
      changed:
        format(before[field as keyof typeof before]) !==
        format(after[field as keyof typeof after]),
    })),
    ...(!baseline.facts
      ? {
          note: "This older build predates detailed comparison capture; missing values are shown explicitly.",
        }
      : {}),
  };
}
