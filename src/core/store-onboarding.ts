import type { Store } from "./database";
import type {
  Artifact,
  Job,
  Project,
  StoreSetupRequest,
  StoreSetupState,
} from "./types";
import { invariant } from "./errors";
import { hashArtifact } from "./build";
import { inspectProject, inspectIOSEntitlements } from "./config";

export async function makeStoreSetup(
  store: Store,
  projectId: string,
  request: StoreSetupRequest,
): Promise<StoreSetupState> {
  const project = store.get<Project>("projects", projectId);
  const identity =
    request.provider === "apple" ? project.bundleId : project.packageName;
  invariant(
    identity,
    "STORE_IDENTITY",
    "Configure the app's bundle/package identifier first.",
  );
  invariant(
    request.mode !== "bootstrap" ||
      (request.provider === "google" && request.newApp),
    "STORE_BOOTSTRAP",
    "The console bootstrap is only for a new Google Play app. Existing apps use normal artifact upload.",
  );
  invariant(
    request.mode !== "capabilities" || request.provider === "apple",
    "STORE_CAPABILITIES",
    "Capability repair uses Apple Developer.",
  );
  invariant(
    request.provider !== "apple" || request.appName.trim().length <= 30,
    "STORE_APP_NAME",
    "Apple app names are limited to 30 characters.",
  );
  invariant(
    request.mode !== "record" ||
      request.provider !== "google" ||
      (request.appType && request.pricing),
    "STORE_CHOICES",
    "Choose the app type and pricing before preparing the Play record.",
  );
  const state: StoreSetupState = {
    ...request,
    identity,
    appName: request.appName.trim(),
    submitted: {},
    stage: "opening",
  };
  invariant(
    !request.targetBundleId || request.mode === "capabilities",
    "STORE_TARGET",
    "An embedded target can only be selected for capability assignment.",
  );
  if (request.mode === "capabilities") {
    const info = await inspectProject(project.path, project.settings);
    const target = request.targetBundleId
      ? info.iosTarget?.targets.find(
          (t) => t.bundleId === request.targetBundleId,
        )
      : undefined;
    invariant(
      !request.targetBundleId ||
        request.targetBundleId === project.bundleId ||
        target,
      "STORE_TARGET",
      "Choose an app or embedded extension from this project's selected scheme.",
    );
    if (target) state.identity = target.bundleId;
    const entitlements =
      target?.entitlements ??
      (info.native.ios
        ? (info.config.ios?.entitlements ?? {})
        : await inspectIOSEntitlements(project.path, project.settings));
    const values = [
      ...(entitlements["com.apple.developer.icloud-container-identifiers"] ??
        []),
      ...(entitlements["com.apple.developer.ubiquity-container-identifiers"] ??
        []),
      ...(entitlements["com.apple.security.application-groups"] ?? []),
    ];
    state.identifiers = [...new Set<string>(values)].filter((value) =>
      /^(?:iCloud\.|group\.)[A-Za-z0-9.-]+$/.test(value),
    );
    invariant(
      state.identifiers.length,
      "CAPABILITY_IDENTIFIERS",
      "Set explicit iCloud container or App Group identifiers in the project's entitlements before repairing assignments. Identifiers are never invented.",
    );
  }
  if (request.mode === "bootstrap") {
    invariant(
      request.artifactId,
      "STORE_ARTIFACT",
      "Choose a successful signed AAB first.",
    );
    invariant(
      !store
        .list<Job>("jobs")
        .some(
          (job) =>
            job.bundleId === identity &&
            job.platform === "android" &&
            ((job.status === "running" && job.stage === "upload") ||
              job.submission?.state === "uncertain"),
        ),
      "GOOGLE_UPLOAD_ACTIVE",
      "Finish or reconcile the existing API upload before opening the first-upload console editor.",
    );
    const artifact = await verifyBootstrapArtifact(
      store,
      project,
      request.artifactId,
    );
    state.artifact = {
      id: artifact.id,
      name: artifact.path.split("/").pop()!,
      sha256: artifact.sha256,
      size: artifact.size,
      buildNumber: artifact.buildNumber,
      version: artifact.version,
    };
    invariant(
      !store.list<Job>("jobs").some(
        (job) =>
          job.bundleId === identity &&
          // iOS and Android often share one identifier; only Play uploads count.
          job.platform === "android" &&
          job.submission &&
          ["uploaded", "accepted", "draft"].includes(job.submission.state),
      ),
      "PLAY_ALREADY_UPLOADED",
      "This app already has a recorded Play upload. Use normal upload/reconcile rather than first-upload bootstrap.",
    );
  }
  return state;
}
export async function verifyBootstrapArtifact(
  store: Store,
  project: Project,
  id: string,
) {
  const artifact = store.get<Artifact>("artifacts", id);
  const job = store.get<Job>("jobs", artifact.jobId);
  invariant(
    job.projectId === project.id &&
      job.status === "succeeded" &&
      job.storeEligible !== false &&
      artifact.platform === "android" &&
      artifact.kind === "aab" &&
      artifact.bundleId === project.packageName,
    "STORE_ARTIFACT_IDENTITY",
    "Choose a successful AAB built for this project and exact Android package.",
  );
  invariant(
    /^\d+$/.test(artifact.buildNumber) && Number(artifact.buildNumber) > 0,
    "STORE_VERSION",
    "The AAB must have a valid positive version code.",
  );
  const digest = await hashArtifact(artifact.path);
  invariant(
    digest.sha256 === artifact.sha256 && digest.size === artifact.size,
    "ARTIFACT_CHANGED",
    "This AAB changed since the successful build. Rebuild before upload.",
  );
  return artifact;
}
export { storeScope } from "./store-scope";
