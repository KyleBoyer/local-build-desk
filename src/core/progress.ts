import type { Stage, WorkProgress } from "./types";
export const stageGuidance: Record<Stage, string> = {
  queued: "Waiting for this Mac’s native compiler.",
  preflight:
    "Checking configuration, signing and store prerequisites. This can take a minute.",
  snapshot:
    "Copying the project into an isolated workspace. Large projects can take a few minutes.",
  install:
    "Installing dependencies. First-time downloads can take several minutes.",
  configure:
    "Preparing native projects and tools. Component downloads can take several minutes.",
  testing:
    "Running required checks in the build snapshot. First simulator boot and test compilation can take a few minutes.",
  screenshots:
    "Opening the capture plan and exporting screenshots. Progress and test diagnostics are retained.",
  signing: "Preparing signing credentials and native tools.",
  compile:
    "Compiling native code. This can take several minutes, especially on a first build.",
  export: "Exporting the signed archive. This can take a few minutes.",
  verify: "Checking the artifact’s identity, signature and version.",
  upload:
    "Transfer and store validation can take a few minutes. Upload completion is confirmed separately.",
  processing:
    "Upload is complete. Apple processing can take several minutes; status is checked automatically.",
  complete: "Complete.",
};
export function toolProgress(
  text: string,
  previous?: WorkProgress,
  time = new Date().toISOString(),
): WorkProgress | undefined {
  let label: string | undefined,
    kind: WorkProgress["kind"] = "work";
  if (/Verifying Xcode/i.test(text)) label = "Verifying Xcode";
  else if (/Expanding.*Xcode/i.test(text)) label = "Expanding Xcode";
  else if (/first.launch/i.test(text)) label = "Installing Xcode components";
  else if (/Downloading.*(?:iOS|Simulator|platform)/i.test(text)) {
    label = "Downloading iOS components";
    kind = "download";
  } else if (
    /Installing.*(?:iOS|Simulator|platform)|(?:iOS|Simulator).*Installing/i.test(
      text,
    )
  )
    label = "Installing iOS components";
  else if (/Downloading/i.test(text)) {
    label = "Downloading dependencies";
    kind = "download";
  } else if (/Pouring|Installing|Preparing.*Install/i.test(text))
    label = "Installing tools";
  const percent = [...text.matchAll(/(?:^|[\s:(])(\d{1,3}(?:\.\d+)?)%/g)].at(
    -1,
  )?.[1];
  if (!label && percent && previous) {
    label = previous.label;
    kind = previous.kind;
  }
  if (!label) return;
  const same = previous?.label === label;
  return {
    kind,
    label,
    startedAt: same ? previous!.startedAt : time,
    updatedAt: time,
    ...(percent && +percent <= 100 ? { percent: +percent } : {}),
    detail: text.slice(-300),
  };
}
export function elapsedLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
    : seconds >= 60
      ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
      : `${seconds}s`;
}
