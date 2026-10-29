import { readinessReport } from "./readiness";
import { loadListing, listingPlan, displayTypeFor } from "./app-store-listing";
import { snapshot } from "./snapshot";
import { validateProvision } from "./signing";
import { assertUploadChecks, simulatorCatalog } from "./release-validation";
import { checkpoint, finishCheckpoint } from "./checkpoints";
import { inside, forgetDerivedData } from "./xcode-project";
import { projectApplications, projectSettings } from "./project-discovery";
import { settingsSchema } from "./settings-schema";
import { defaultLocalProfiles } from "./project-adapters";
import { withLock } from "./locks";
import {
  captureBackup,
  writeBackup,
  readBackup,
  restorePayload,
  type BackupPayload,
} from "./backup";
import { compareBuilds } from "./comparison";
import { inspectReuse } from "./reuse";
import { listInstallTargets, installAndLaunch } from "./devices";
import type { ReusableBuild, ToolName } from "./types";
import {
  releaseContext,
  contextFingerprint,
  previewRelease,
  applyRelease,
} from "./release-assistant";
import type { ReleaseDraft, ReleasePreview } from "./types";
import { makeStoreSetup, verifyBootstrapArtifact } from "./store-onboarding";
import {
  internalTeamUsers,
  configureInternalTesting,
} from "./testflight-setup";
import type { StoreSetupRequest, StoreSetupState } from "./types";
import { EventEmitter } from "node:events";
import {
  realpath,
  readFile,
  mkdir,
  readdir,
  cp,
  writeFile,
} from "node:fs/promises";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync as requireMkdir,
} from "node:fs";
import { resolve, join, dirname, extname, relative, sep } from "node:path";
import {
  readListingCompliance,
  saveListingCompliance,
  type Compliance,
} from "./app-store-compliance";
import type { ComplianceView } from "./types";
import { createHash, randomBytes } from "node:crypto";
import { Store, id, now } from "./database";
import { Vault, importCredential, privateDirectory } from "./vault";
import {
  inspectProject,
  resolveProfile,
  parseEnv,
  hasFile,
  readJSON,
  toolEnvironment,
} from "./config";
import { Redactor, run } from "./process";
import { DeskError, invariant, messageOf } from "./errors";
import { buildLocal, hashArtifact } from "./build";
import {
  AppleAPI,
  GoogleAPI,
  uploadApple,
  appleBuildState,
  googleRollout,
} from "./stores";
import {
  createDistributionCertificate,
  certificateId,
  decodeProfile,
} from "./signing";
import {
  prepareApple,
  prepareAndroid,
  installTool,
  createGoogleServiceAccount,
} from "./setup";
import { doctor } from "./doctor";
import { discoverXcodes, installXcodeArchive } from "./xcode-toolchain";
import type {
  Artifact,
  BuildRequest,
  CredentialSummary,
  DeskEvent,
  DeskState,
  Job,
  LogEntry,
  Platform,
  Project,
  ProjectSettings,
  Stage,
  SetupRequest,
  ProgressUpdate,
} from "./types";
import {
  RunVault,
  invocationStore,
  credentialSecrets,
  type BuildInvocation,
  type RuntimeContext,
} from "./runtime-context";
export class Engine extends EventEmitter {
  private releaseOperations = new Map<
    string,
    { controller: AbortController; operation: Promise<unknown> }
  >();
  private releaseOperation<T>(
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    invariant(
      !this.closing,
      "DESK_CLOSING",
      "Local Build Desk is shutting down. Reopen it to continue.",
    );
    const key = id(),
      controller = new AbortController();
    const operation = Promise.resolve()
      .then(() => fn(controller.signal))
      .finally(() => this.releaseOperations.delete(key));
    this.releaseOperations.set(key, { controller, operation });
    return operation;
  }
  readRelease(jobId: string, draft: ReleaseDraft) {
    return this.releaseOperation((signal) =>
      this.readReleaseMetadata(jobId, draft, signal),
    );
  }
  private async readReleaseMetadata(
    jobId: string,
    draft: ReleaseDraft,
    signal: AbortSignal,
  ) {
    const job = this.store.get<Job>("jobs", jobId),
      project = this.store.get<Project>("projects", job.projectId);
    invariant(
      job.storeEligible,
      "RELEASE_BUILD",
      "Choose a store build first.",
    );
    const context = await releaseContext(
      new AppleAPI(
        await this.vaultFor(job).get(
          project.settings.appleConnectionId,
          "apple",
        ),
        fetch,
        undefined,
        { signal },
      ),
      job,
      draft,
    );
    return context.current;
  }
  async relinkArtifact(artifactId: string, path: string) {
    invariant(
      !this.deviceOperations.has(artifactId) &&
        !this.store
          .list<Job>("jobs")
          .some(
            (j) =>
              j.artifactId === artifactId &&
              ["queued", "running"].includes(j.status),
          ),
      "ARTIFACT_BUSY",
      "Wait for this artifact’s upload or installation to finish before relocating it.",
    );
    const artifact = this.store.get<Artifact>("artifacts", artifactId),
      resolved = await realpath(resolve(path)),
      digest = await hashArtifact(resolved);
    invariant(
      digest.sha256 === artifact.sha256 && digest.size === artifact.size,
      "ARTIFACT_CHANGED",
      "Choose the original, unmodified artifact. Its checksum and size must match the recorded build.",
    );
    artifact.path = resolved;
    this.store.putArtifact(artifact);
    this.changed();
    return artifact;
  }
  private deviceOperations = new Map<
    string,
    { controller: AbortController; operation: Promise<void> }
  >();
  isBusy() {
    return (
      !!this.controllers.size ||
      !!this.toolchainOperations.size ||
      !!this.toolInstalls.size ||
      !!this.deviceOperations.size ||
      !!this.releaseOperations.size ||
      !!this.reconciliations.size ||
      this.store
        .list<Job>("jobs")
        .some((j) => ["queued", "running"].includes(j.status))
    );
  }
  private installProject(artifactId: string) {
    const artifact = this.store.get<Artifact>("artifacts", artifactId),
      job = this.store.get<Job>("jobs", artifact.jobId);
    return {
      artifact,
      project:
        this.store
          .list<Project>("projects")
          .find((p) => p.id === job.projectId) ?? this.projectFor(job),
    };
  }
  async installTargets(artifactId: string) {
    const { artifact, project } = this.installProject(artifactId);
    return listInstallTargets(project.settings, artifact.kind);
  }
  installArtifact(artifactId: string, targetId: string): Promise<void> {
    const existing = this.deviceOperations.get(artifactId);
    if (existing) return existing.operation;
    const controller = new AbortController();
    const startedAt = now();
    const progress = (label: string) =>
      this.emit("event", {
        type: "operation-progress",
        operationId: artifactId,
        progress: { kind: "work", label, startedAt, updatedAt: now() },
      } satisfies DeskEvent);
    const operation = (async () => {
      const { artifact, project } = this.installProject(artifactId);
      progress("Verifying build checksum");
      const digest = await hashArtifact(artifact.path);
      invariant(
        digest.sha256 === artifact.sha256 && digest.size === artifact.size,
        "ARTIFACT_CHANGED",
        "This artifact is missing or changed. Restore the original build files or build again.",
      );
      const target = (
        await listInstallTargets(project.settings, artifact.kind)
      ).targets.find((t) => t.id === targetId);
      invariant(
        target?.available,
        "INSTALL_TARGET",
        "Refresh devices and select an available compatible target.",
      );
      await installAndLaunch(
        artifact,
        target,
        project.settings,
        controller.signal,
        progress,
      );
      progress("Installed and launched");
    })().finally(() => this.deviceOperations.delete(artifactId));
    this.deviceOperations.set(artifactId, { controller, operation });
    return operation;
  }
  cancelInstall(artifactId: string) {
    this.deviceOperations.get(artifactId)?.controller.abort();
  }
  async findReusableBuilds(
    projectId: string,
    profile: string,
    platform: Platform,
  ): Promise<ReusableBuild[]> {
    const project = this.store.get<Project>("projects", projectId),
      jobs = this.store.list<Job>("jobs");
    if (
      !jobs.some(
        (j) =>
          j.projectId === projectId &&
          j.profile === profile &&
          j.platform === platform &&
          j.reuseFingerprint,
      )
    )
      return [];
    const keys = await inspectReuse(project, profile, platform, this.vault),
      identity =
        platform === "ios"
          ? keys.inspection.bundleId
          : keys.inspection.packageName;
    const result: ReusableBuild[] = [];
    for (const job of jobs
      .filter(
        (j) =>
          j.projectId === projectId &&
          j.kind === "build" &&
          j.profile === profile &&
          j.platform === platform &&
          j.bundleId === identity &&
          j.artifactId &&
          ["succeeded", "needs-attention"].includes(j.status),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const exact =
        !!keys.reuseFingerprint &&
        job.reuseFingerprint === keys.reuseFingerprint;
      const native =
        keys.profile.developmentClient &&
        !!keys.nativeReuseFingerprint &&
        job.nativeReuseFingerprint === keys.nativeReuseFingerprint;
      if (!exact && !native) continue;
      let artifact: Artifact;
      try {
        artifact = this.store.get<Artifact>("artifacts", job.artifactId!);
        const digest = await hashArtifact(artifact.path);
        if (digest.sha256 !== artifact.sha256 || digest.size !== artifact.size)
          continue;
      } catch {
        continue;
      }
      result.push({
        job,
        artifact,
        match: exact ? "exact" : "native-development",
        alreadySubmitted: jobs.some(
          (j) =>
            j.artifactId === artifact.id &&
            (!!j.submission ||
              (j.kind === "submit" &&
                ["queued", "running"].includes(j.status))),
        ),
      });
      if (result.length === 5) break;
    }
    return result;
  }
  async useReusableBuild(
    projectId: string,
    profile: string,
    platform: Platform,
    artifactId: string,
    upload: boolean,
  ) {
    const candidate = (
      await this.findReusableBuilds(projectId, profile, platform)
    ).find((c) => c.artifact.id === artifactId);
    invariant(
      candidate,
      "REUSE_CHANGED",
      "The source, toolchain, credentials, or artifact changed. Check for reuse again or build fresh.",
    );
    if (upload) {
      invariant(
        candidate.match === "exact" && !candidate.alreadySubmitted,
        "REUSE_UPLOAD",
        "This artifact cannot be uploaded again. Open its existing build or build a new version.",
      );
      return this.submit(artifactId);
    }
    return candidate.job;
  }
  private restorePreview?: {
    token: string;
    payload: BackupPayload;
    expires: number;
  };
  assertBackupIdle() {
    invariant(
      !this.isBusy(),
      "BACKUP_BUSY",
      "Wait for builds and tool/device operations to finish before backing up or restoring.",
    );
  }
  async exportBackupFile(path: string, password: string) {
    this.assertBackupIdle();
    await writeBackup(
      path,
      await captureBackup(this.store, this.vault),
      password,
    );
    return path;
  }
  async previewBackupFile(path: string, password: string) {
    const payload = await readBackup(path, password),
      token = id();
    this.restorePreview = { token, payload, expires: Date.now() + 600000 };
    const pending = this.restorePreview;
    const timer = setTimeout(() => {
      if (this.restorePreview === pending) this.restorePreview = undefined;
    }, 600000);
    timer.unref();
    return {
      token,
      createdAt: payload.createdAt,
      projects: payload.projects.map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
      })),
      credentials: payload.credentials.length,
      jobs: payload.jobs.length,
      counters: payload.counters.length,
    };
  }
  async restoreBackup(
    token: string,
    mappings: Record<string, string>,
    resetMachinePaths = true,
  ) {
    const preview = this.restorePreview;
    invariant(
      preview && preview.token === token && preview.expires > Date.now(),
      "BACKUP_PREVIEW",
      "Choose and preview the encrypted backup again before restoring.",
    );
    this.restorePreview = undefined;
    const result = await restorePayload(
      this.store,
      this.vault,
      preview.payload,
      mappings,
      () => this.assertBackupIdle(),
      resetMachinePaths,
    );
    this.changed();
    return result;
  }
  private releasePreviews = new Map<
    string,
    {
      job: Job;
      draft: ReleaseDraft;
      fingerprint: string;
      connectionId: string;
      revision: string;
      expires: number;
    }
  >();
  prepareRelease(jobId: string, draft: ReleaseDraft): Promise<ReleasePreview> {
    return this.releaseOperation((signal) =>
      this.prepareReleaseMetadata(jobId, draft, signal),
    );
  }
  private async prepareReleaseMetadata(
    jobId: string,
    draft: ReleaseDraft,
    signal: AbortSignal,
  ): Promise<ReleasePreview> {
    const job = this.store.get<Job>("jobs", jobId),
      project = this.store.get<Project>("projects", job.projectId);
    const connectionId = project.settings.appleConnectionId;
    invariant(
      connectionId && job.storeEligible && job.artifactId,
      "RELEASE_BUILD",
      "Choose a store build and connect its Apple team first.",
    );
    const api = new AppleAPI(
      await this.vaultFor(job).get(connectionId, "apple"),
      fetch,
      undefined,
      { signal },
    );
    const context = await releaseContext(api, job, draft),
      preview = previewRelease(job, draft, context);
    for (const [token, value] of this.releasePreviews)
      if (value.expires < Date.now()) this.releasePreviews.delete(token);
    invariant(
      this.releasePreviews.size < 50,
      "RELEASE_PREVIEWS",
      "Close older previews and try again shortly.",
    );
    this.releasePreviews.set(preview.token, {
      job: structuredClone(job),
      draft: structuredClone(draft),
      fingerprint: contextFingerprint(context),
      connectionId,
      revision:
        this.store.credentialSummaries().find((c) => c.id === connectionId)
          ?.createdAt ?? "",
      expires: Date.now() + 600000,
    });
    return preview;
  }
  applyRelease(token: string) {
    return this.releaseOperation((signal) =>
      this.applyReleaseMetadata(token, signal),
    );
  }
  private async applyReleaseMetadata(token: string, signal: AbortSignal) {
    const preview = this.releasePreviews.get(token);
    invariant(
      preview && preview.expires > Date.now(),
      "RELEASE_PREVIEW",
      "Preview the proposed release changes again before applying.",
    );
    this.releasePreviews.delete(token);
    try {
      return await withLock(
        `release:${preview.job.bundleId}:${preview.draft.destination}:${preview.draft.locale}`,
        signal,
        async () => {
          const project = this.store.get<Project>(
            "projects",
            preview.job.projectId,
          );
          invariant(
            project.settings.appleConnectionId === preview.connectionId &&
              this.store
                .credentialSummaries()
                .find((c) => c.id === preview.connectionId)?.createdAt ===
                preview.revision,
            "RELEASE_CONNECTION",
            "The Apple connection changed. Preview again before applying.",
          );
          return applyRelease(
            new AppleAPI(
              await this.vaultFor(preview.job).get(
                preview.connectionId,
                "apple",
              ),
              fetch,
              undefined,
              { signal },
            ),
            preview.job,
            preview.draft,
            preview.fingerprint,
          );
        },
      );
    } catch (error) {
      throw new DeskError(
        "RELEASE_APPLY",
        messageOf(error) +
          " Refresh the preview before retrying; a preceding store change may already have succeeded.",
      );
    }
  }
  /** The listing file holding a project's App Store compliance answers. */
  private async listingFile(project: Project, listing: string) {
    // Compare real paths: the project is stored resolved, and a chosen file
    // may come through a symlink (such as /var → /private/var).
    const path = await realpath(resolve(project.path, listing)).catch(() =>
      resolve(project.path, listing),
    );
    invariant(
      (path.startsWith(project.path + sep) || path === project.path) &&
        path.endsWith(".json"),
      "LISTING_PATH",
      "Choose a .json listing file inside the project.",
    );
    return { path, relative: relative(project.path, path) };
  }
  async checkTargets(projectId: string) {
    const project = this.store.get<Project>("projects", projectId);
    const options = { env: toolEnvironment(project.settings) };
    const catalog = await simulatorCatalog(options);
    const inspection = await inspectProject(project.path, project.settings);
    let testPlans: string[] = [];
    if (inspection.iosTarget) {
      const target = inspection.iosTarget;
      const { containerArguments } = await import("./xcode-project");
      const result = await run(
        "xcodebuild",
        [
          ...containerArguments(target.container, project.path),
          "-scheme",
          project.settings.releaseChecks?.scheme ?? target.scheme,
          "-showTestPlans",
          "-json",
        ],
        { ...options, allowFailure: true, timeout: 60000 },
      );
      try {
        const parsed = JSON.parse(result.stdout);
        testPlans = (parsed.testPlans ?? [])
          .map((p: any) => (typeof p === "string" ? p : p.name))
          .filter(Boolean);
      } catch {}
    }
    return {
      devices: catalog.devices
        .filter((d) => /iPhone|iPad/.test(d.name))
        .map((d) => ({ id: d.identifier, name: d.name })),
      runtimes: catalog.runtimes.map((r) => ({
        id: r.identifier,
        name: r.name,
        version: r.version,
      })),
      schemes: inspection.schemes ?? [],
      testPlans,
    };
  }
  runChecks(
    projectId: string,
    profile: string,
    mode: "all" | "tests" | "screenshots" = "all",
  ) {
    return this.build({
      projectId,
      profile,
      platform: "ios",
      autoSubmit: false,
      validationOnly: true,
      checksMode: mode,
    });
  }
  async screenshotPreview(jobId: string, index: number) {
    const job = this.store.get<Job>("jobs", jobId),
      shot = job.validation?.screenshots[index];
    invariant(shot, "SCREENSHOT_MISSING", "This capture is not available.");
    const bytes = await readFile(shot.path);
    invariant(
      bytes.length <= 20 * 1024 * 1024 &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        createHash("sha256").update(bytes).digest("hex") === shot.sha256,
      "SCREENSHOT_CHANGED",
      "The capture is missing, invalid, or changed.",
    );
    return `data:image/png;base64,${bytes.toString("base64")}`;
  }
  async useScreenshots(jobId: string) {
    const job = this.store.get<Job>("jobs", jobId),
      project = this.store.get<Project>("projects", job.projectId);
    invariant(
      job.kind === "build" &&
        job.validation?.state === "passed" &&
        job.validation.screenshots.length,
      "SCREENSHOTS_NOT_READY",
      "Capture screenshots during a successful production build before associating them with its store listing.",
    );
    assertUploadChecks(job, {
      ...project.settings,
      releaseChecks: {
        ...project.settings.releaseChecks!,
        enabled: true,
        required: true,
      },
    });
    invariant(
      project.settings.appStoreListing,
      "LISTING_REQUIRED",
      "Choose the source listing JSON on the App Store screen first.",
    );
    const original = await this.listingFile(
      project,
      project.settings.appStoreListing,
    );
    const listing = JSON.parse(await readFile(original.path, "utf8"));
    const root = inside(project.path, ".local-build-desk/store");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const files: string[] = [];
    for (const [i, shot] of job.validation.screenshots.entries()) {
      invariant(
        shot.displayType &&
          displayTypeFor(shot.width, shot.height) === shot.displayType,
        "SCREENSHOT_SIZE",
        "A captured device is not a supported store screenshot size. Choose an App Store-sized iPhone/iPad in Tests.",
      );
      const digest = await hashArtifact(shot.path);
      invariant(
        digest.sha256 === shot.sha256 && digest.size === shot.size,
        "SCREENSHOT_CHANGED",
        "A captured screenshot changed. Run the capture plan again.",
      );
      const name = `${job.validation.fingerprint.slice(0, 16)}-${i}-${shot.name}.png`;
      await cp(shot.path, join(root, name));
      files.push(name);
    }
    // Keep generated store files out of the app snapshot and reuse fingerprint.
    // Rebase other user-supplied relative files when making the local overlay.
    for (const key of ["inAppPurchases"] as const)
      if (Array.isArray(listing[key]))
        listing[key] = listing[key].map((p: string) =>
          p.endsWith(".json")
            ? relative(root, resolve(dirname(original.path), p))
            : p,
        );
    listing.screenshots = files;
    listing.generatedScreenshots = {
      jobId: job.id,
      sourceHash: job.facts?.sourceHash,
      validationFingerprint: job.validation.fingerprint,
      buildNumber: job.buildNumber,
      version: job.version,
      files: job.validation.screenshots.map((s) => ({
        sha256: s.sha256,
        name: s.name,
      })),
    };
    const file = join(root, "listing.json");
    await writeFile(file, JSON.stringify(listing, null, 2) + "\n", {
      mode: 0o600,
    });
    this.saveSettings(project.id, {
      ...project.settings,
      appStoreListing: relative(project.path, file),
    });
    return file;
  }
  async readStoreStatus(projectId: string) {
    const project = this.store.get<Project>("projects", projectId);
    const api = new AppleAPI(
      await this.vault.get(project.settings.appleConnectionId, "apple"),
    );
    const app = await api.app(project.bundleId!);
    invariant(
      app,
      "APPLE_APP",
      "The app record is not available. Complete Guided setup.",
    );
    const versions = (
      await api.request(
        `/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=50`,
      )
    ).data;
    const version =
      versions.find(
        (v: any) => v.attributes.versionString === project.version,
      ) ?? versions[0];
    invariant(
      version,
      "APPLE_VERSION",
      "No App Store version has been prepared yet.",
    );
    const state = version.attributes.appStoreState ?? version.attributes.state;
    return {
      version: version.attributes.versionString,
      state,
      editable: [
        "PREPARE_FOR_SUBMISSION",
        "DEVELOPER_REJECTED",
        "REJECTED",
        "METADATA_REJECTED",
      ].includes(state),
    };
  }
  async readiness(
    projectId: string,
    destination: "testflight" | "appstore" = "testflight",
  ) {
    const project = this.store.get<Project>("projects", projectId);
    const report = readinessReport(
      project,
      this.store.list<Job>("jobs"),
      this.store.list<Artifact>("artifacts"),
      await this.doctor(projectId),
      destination,
    );
    const item = (id: string) => report.items.find((i) => i.id === id)!;
    try {
      const inspection = await inspectProject(project.path, project.settings);
      const signing = await this.vault.get(
        project.settings.iosSigningId,
        "ios",
      );
      const apple = await this.vault.get(
        project.settings.appleConnectionId,
        "apple",
      );
      await privateDirectory(async (root) => {
        const profiles = await Promise.all(
          signing.profiles.map((p) => decodeProfile(p, root)),
        );
        const targets = inspection.iosTarget?.targets ?? [
          { bundleId: project.bundleId!, entitlements: {} },
        ];
        for (const target of targets) {
          const valid = profiles.some((profile) => {
            try {
              validateProvision(
                profile,
                target.bundleId,
                apple.teamId,
                target.entitlements,
                "store",
              );
              return true;
            } catch {
              return false;
            }
          });
          invariant(
            valid,
            "PROFILE_NOT_READY",
            `No valid App Store profile covers ${target.bundleId} and its entitlements. Renew signing in Guided setup.`,
          );
        }
        invariant(
          signing.p12.length > 0,
          "PRIVATE_KEY",
          "The distribution certificate/private-key container is missing.",
        );
        item("signing").status = "ready";
        item("signing").detail =
          `${targets.length} application/extension target(s) have matching, unexpired store profiles. Archive signing verifies the private key.`;
      });
      const api = new AppleAPI(apple);
      await api.validate();
      item("connection").status = "ready";
      item("connection").detail =
        "The Apple API key authenticated successfully.";
      if (report.jobId) {
        const job = this.store.get<Job>("jobs", report.jobId);
        const currentHash = await snapshot(
          project.path,
          join(this.store.root, "readiness-snapshot"),
          inspection.native,
          undefined,
          false,
          (inspection.containers ?? []).flatMap((c) =>
            dirname(c.path) === "." ? [c.path] : [dirname(c.path)],
          ),
        );
        if (job.facts?.sourceHash !== currentHash)
          report.items.push({
            id: "source",
            title: "Current source",
            status: "blocked",
            detail:
              "The working tree changed after this artifact was built. Build fresh to test, capture and release the current source.",
          });
      }
      if (destination === "appstore") {
        const status = await this.readStoreStatus(projectId).catch(
          () => undefined,
        );
        if (status && !status.editable) {
          report.delivery.review = status.state;
          report.items.push({
            id: "review",
            title: "App Review",
            status: "ready",
            detail: `${status.version}: ${status.state.replaceAll("_", " ").toLowerCase()}. This is a normal submitted release state.`,
          });
        } else if (project.settings.appStoreListing) {
          const file = await this.listingFile(
            project,
            project.settings.appStoreListing,
          );
          const plan = await listingPlan(
            api,
            project.bundleId!,
            project.version!,
            await loadListing(file.path),
          );
          report.items.push({
            id: "listing",
            title: "Store listing & compliance",
            status: plan.blockers.length ? "blocked" : "ready",
            detail:
              plan.blockers.join(" ") ||
              "Listing, screenshots, compliance and selected build are ready.",
          });
        } else
          report.items.push({
            id: "listing",
            title: "Store listing",
            status: "blocked",
            detail: "Choose the listing file on the App Store screen.",
          });
      }
    } catch (e) {
      const signing = item("signing");
      if (signing.status === "pending") {
        signing.status = "blocked";
        signing.detail = messageOf(e);
      } else
        report.items.push({
          id: "remote",
          title: "Store access",
          status: "blocked",
          detail: messageOf(e),
        });
    }
    report.canUpload = !report.items.some((i) => i.status === "blocked");
    return report;
  }
  async resume(jobId: string): Promise<Job[]> {
    const job = this.store.get<Job>("jobs", jobId);
    invariant(
      !["queued", "running"].includes(job.status),
      "RESUME_ACTIVE",
      "This operation is already active.",
    );
    if (
      job.submission &&
      ["uploading", "uncertain", "processing", "uploaded"].includes(
        job.submission.state,
      )
    ) {
      await this.reconcile(jobId);
      return [this.store.get<Job>("jobs", jobId)];
    }
    invariant(
      !job.submission || job.submission.state !== "accepted",
      "ALREADY_SUBMITTED",
      "This artifact is already available in the store. It will not be uploaded twice.",
    );
    if (job.artifactId && !job.submission)
      return [await this.submit(job.artifactId)];
    const project = this.projectFor(job);
    if (job.facts?.sourceHash) {
      const inspection = await inspectProject(project.path, project.settings);
      const current = await snapshot(
        project.path,
        join(this.store.root, "resume-check"),
        inspection.native,
        undefined,
        false,
        (inspection.containers ?? []).flatMap((c) =>
          dirname(c.path) === "." ? [c.path] : [dirname(c.path)],
        ),
      );
      invariant(
        current === job.facts.sourceHash,
        "RESUME_SOURCE_CHANGED",
        "The working tree changed. Start a new build; an interrupted build cannot approve different source.",
      );
    }
    const jobs = await this.build({
      projectId: job.projectId,
      platform: job.platform,
      profile: job.profile,
      autoSubmit: job.autoSubmit,
      clean: false,
      validationOnly: job.kind === "test",
      checksMode: job.checksMode,
    });
    for (const next of jobs) {
      next.resumedFrom = jobId;
      this.saveJob(next);
    }
    return jobs;
  }
  async readCompliance(
    projectId: string,
    listing?: string,
  ): Promise<ComplianceView> {
    const project = this.store.get<Project>("projects", projectId);
    const chosen = listing ?? project.settings.appStoreListing;
    if (!chosen) return {};
    const { path, relative } = await this.listingFile(project, chosen);
    if (listing && project.settings.appStoreListing !== relative)
      this.saveSettings(projectId, {
        ...project.settings,
        appStoreListing: relative,
      });
    return { listing: relative, ...(await readListingCompliance(path)) };
  }
  async saveCompliance(
    projectId: string,
    listing: string,
    answers: Omit<Compliance, "attestation">,
    attestBy?: string,
  ): Promise<ComplianceView> {
    const project = this.store.get<Project>("projects", projectId);
    const file = await this.listingFile(project, listing);
    if (project.settings.appStoreListing !== file.relative)
      this.saveSettings(projectId, {
        ...project.settings,
        appStoreListing: file.relative,
      });
    const saved = await saveListingCompliance(
      file.path,
      answers,
      attestBy
        ? { name: attestBy, date: new Date().toISOString().slice(0, 10) }
        : undefined,
    );
    return { listing: file.relative, ...saved };
  }
  savePlayNotes(projectId: string, text: string, locale: string) {
    const project = this.store.get<Project>("projects", projectId);
    this.saveSettings(projectId, {
      ...project.settings,
      playReleaseNotes: text,
      playReleaseNotesLanguage: locale,
    });
  }
  async releaseNoteDraft(jobId: string) {
    const job = this.store.get<Job>("jobs", jobId),
      project = this.projectFor(job);
    const previous = this.store
      .list<Job>("jobs")
      .filter(
        (j) =>
          j.id !== job.id &&
          j.bundleId === job.bundleId &&
          j.platform === job.platform &&
          j.submission?.state === "accepted" &&
          j.createdAt < job.createdAt &&
          j.facts?.sourceCommit,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const commit = job.facts?.sourceCommit;
    invariant(
      commit && /^[a-f0-9]{40}$/.test(commit),
      "RELEASE_COMMITS",
      "This older build has no recorded source commit. Write release notes manually.",
    );
    const result = await run(
      "git",
      [
        "log",
        "--format=%s",
        "--max-count=30",
        previous?.facts?.sourceCommit
          ? `${previous.facts.sourceCommit}..${commit}`
          : commit,
        "--",
      ],
      { cwd: project.path, timeout: 10000 },
    );
    return {
      text: result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((s) => "• " + s)
        .join("\n"),
      note: previous
        ? "Commit subjects since the previous accepted build. Review before publishing."
        : "Recent commit subjects; no previous accepted source commit was recorded. Review before publishing.",
    };
  }
  private contexts = new Map<string, RuntimeContext>();
  projectFor(job: Job): Project {
    return (
      job.projectSnapshot ?? this.store.get<Project>("projects", job.projectId)
    );
  }
  vaultFor(job: Job): Vault {
    const context = this.contexts.get(job.id);
    invariant(
      !job.requiresInvocationCredentials || context,
      "CI_CREDENTIALS_REQUIRED",
      "Reprovide invocation credentials for this job after restarting; no Keychain access was attempted.",
    );
    return context ? new RunVault(this.store, this.vault, context) : this.vault;
  }
  attachInvocation(jobId: string, invocation: BuildInvocation) {
    const job = this.store.get<Job>("jobs", jobId);
    const original = this.projectFor(job);
    job.projectSnapshot = {
      ...original,
      settings: invocation.project.settings,
    };
    job.requiresInvocationCredentials =
      invocation.context.noKeychain ||
      Object.keys(invocation.context.credentials).length > 0;
    this.contexts.set(jobId, invocation.context);
    this.saveJob(job);
  }
  private pumping = false;
  private closing = false;
  private polling = false;
  private pollTimer?: NodeJS.Timeout;
  private pollErrors = new Map<string, string>();
  private reconciliations = new Map<string, Promise<void>>();
  private reconciliationControllers = new Map<string, AbortController>();
  private controllers = new Map<string, AbortController>();
  private toolchainControllers = new Map<string, AbortController>();
  private toolchainOperations = new Map<
    string,
    Promise<import("./xcode-toolchain").XcodeInstallResult>
  >();
  private toolInstalls = new Map<string, Promise<void>>();
  constructor(
    public store: Store,
    public vault: Vault,
  ) {
    super();
  }
  start() {
    this.store.recover();
    void this.pump();
    this.pollTimer = setInterval(() => void this.pollProcessing(), 30000);
    this.pollTimer.unref();
  }
  state(): DeskState {
    return {
      projects: this.store.list<Project>("projects"),
      jobs: this.store
        .list<Job>("jobs")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      artifacts: this.store.list<Artifact>("artifacts"),
      credentials: this.store.credentialSummaries(),
      dataPath: this.store.root,
      concurrency: { ...this.limits },
    };
  }
  compareBuild(jobId: string) {
    return compareBuilds(
      this.store.get<Job>("jobs", jobId),
      this.store.list<Job>("jobs"),
      this.store.list<Artifact>("artifacts"),
    );
  }
  changed() {
    this.emit("event", { type: "state" } satisfies DeskEvent);
  }
  projectApplications(path: string) {
    return projectApplications(path);
  }
  async importProject(path: string, settings: ProjectSettings = {}) {
    path = await realpath(resolve(path));
    settings = await projectSettings(path, settings);
    settings.appDirectory =
      relative(path, inside(path, settings.appDirectory ?? ".")) || ".";
    const existing = this.store
      .list<Project>("projects")
      .find(
        (p) =>
          p.path === path &&
          (p.settings.appDirectory ?? ".") === settings.appDirectory,
      );
    if (existing) return existing;
    const info = await inspectProject(path, settings);
    const project: Project = {
      id: id(),
      path,
      name: info.name,
      bundleId: info.bundleId,
      packageName: info.packageName,
      version: info.version,
      sdk: info.sdk,
      usesCocoaPods: info.usesCocoaPods,
      usesXcodeGen: info.usesXcodeGen,
      type: info.type,
      platforms: info.platforms,
      profiles: info.profiles,
      createdAt: now(),
      settings: { track: "internal", ...settings },
    };
    this.store.putProject(project);
    this.changed();
    return project;
  }
  async inspect(
    projectId: string,
    profile?: string,
    platform: Platform = "ios",
  ) {
    const project = this.store.get<Project>("projects", projectId);
    let env: Record<string, string> = {};
    if (project.settings.envCredentialId)
      env = (
        await this.vault.get(project.settings.envCredentialId, "environment")
      ).values;
    let inspection = await inspectProject(project.path, project.settings, env);
    const resolved = profile
      ? resolveProfile(inspection.eas, profile, platform)
      : undefined;
    if (resolved)
      inspection = await inspectProject(
        project.path,
        {
          ...project.settings,
          configuration: resolved.configuration,
          scheme: project.settings.scheme ?? resolved.scheme,
        },
        {
          ...env,
          ...resolved.env,
        },
      );
    project.usesCocoaPods = inspection.usesCocoaPods;
    project.usesXcodeGen = inspection.usesXcodeGen;
    project.type = inspection.type;
    project.platforms = inspection.platforms;
    project.name = inspection.name;
    project.bundleId = inspection.bundleId;
    project.packageName = inspection.packageName;
    project.version = inspection.version;
    project.sdk = inspection.sdk;
    project.profiles = inspection.profiles;
    this.store.putProject(project);
    return { inspection, profile: resolved };
  }
  private portableKeys = [
    "projectType",
    "appDirectory",
    "iosTarget",
    "scheme",
    "configuration",
    "webBuildScript",
    "iosDependencyManager",
    "androidModule",
    "localProfiles",
    "minimumIosSdk",
    "iosSdk",
  ] as const;
  portableBuildSettings(projectId: string) {
    const project = this.store.get<Project>("projects", projectId);
    const settings = {
      ...project.settings,
      projectType: project.type ?? "expo",
      localProfiles:
        project.settings.localProfiles ??
        ((project.type ?? "expo") === "expo"
          ? undefined
          : defaultLocalProfiles),
    };
    return (
      JSON.stringify(
        {
          settings: Object.fromEntries(
            this.portableKeys
              .filter((key) => settings[key] !== undefined)
              .map((key) => [key, settings[key]]),
          ),
        },
        null,
        2,
      ) + "\n"
    );
  }
  loadBuildSettings(projectId: string, text: string) {
    const value = JSON.parse(text),
      settings = settingsSchema.parse(value.settings);
    invariant(
      Object.keys(settings).every((key) =>
        this.portableKeys.includes(key as any),
      ),
      "BUILD_SETTINGS",
      "Import only portable build settings. Use the encrypted backup for credentials and machine-specific settings.",
    );
    const project = this.store.get<Project>("projects", projectId);
    this.saveSettings(projectId, { ...project.settings, ...settings });
  }
  saveSettings(projectId: string, settings: ProjectSettings) {
    const project = this.store.get<Project>("projects", projectId);
    if (settings.appDirectory)
      settings = {
        ...settings,
        appDirectory:
          relative(project.path, inside(project.path, settings.appDirectory)) ||
          ".",
      };
    invariant(
      !this.store
        .list<Project>("projects")
        .some(
          (p) =>
            p.id !== projectId &&
            p.path === project.path &&
            (p.settings.appDirectory ?? ".") === (settings.appDirectory ?? "."),
        ),
      "PROJECT_EXISTS",
      "This app is already imported. Select its existing project instead.",
    );
    if (settings.buildDirectory) {
      settings.buildDirectory = resolve(settings.buildDirectory);
      invariant(
        settings.buildDirectory !== resolve(project.path) &&
          !settings.buildDirectory.startsWith(resolve(project.path) + "/"),
        "BUILD_STORAGE",
        "Choose build storage outside the imported project so snapshots cannot include generated builds.",
      );
    }
    if (
      ["projectType", "appDirectory", "iosTarget"].some(
        (key) => (project.settings as any)[key] !== (settings as any)[key],
      )
    )
      settings = {
        ...settings,
        setupAppleComplete: false,
        ascAppId: undefined,
        testFlightGroupId: undefined,
        testFlightGroupName: undefined,
      };
    if (
      settings.localProfiles &&
      (settings.projectType ?? project.type ?? "expo") !== "expo"
    )
      project.profiles = Object.keys(settings.localProfiles);
    project.settings = settings;
    this.store.putProject(project);
    this.changed();
  }
  doctor(projectId?: string) {
    const project = projectId
      ? this.store.get<Project>("projects", projectId)
      : undefined;
    return doctor(
      project?.settings ?? {},
      project?.platforms?.length === 1 ? project.platforms[0] : "all",
      false,
      project?.type ?? project?.settings.projectType,
      project?.usesCocoaPods,
      project?.usesXcodeGen,
    );
  }
  xcodeInstallations(projectId: string) {
    return discoverXcodes(
      this.store.get<Project>("projects", projectId).settings,
    );
  }
  installXcode(projectId: string, archive: string, acceptLicense = false) {
    const existing = this.toolchainOperations.get(projectId);
    if (existing) return existing;
    const controller = new AbortController();
    this.toolchainControllers.set(projectId, controller);
    const operation = this.installXcodeOperation(
      projectId,
      archive,
      acceptLicense,
      controller.signal,
    ).finally(() => {
      this.toolchainControllers.delete(projectId);
      this.toolchainOperations.delete(projectId);
    });
    this.toolchainOperations.set(projectId, operation);
    return operation;
  }
  private async installXcodeOperation(
    projectId: string,
    archive: string,
    acceptLicense: boolean,
    signal: AbortSignal,
  ) {
    const project = this.store.get<Project>("projects", projectId);
    const result = await installXcodeArchive(
      archive,
      project.settings,
      acceptLicense,
      {
        log: this.setupLogger(projectId),
        signal,
        onPrepared: (installation) => {
          const latest = this.store.get<Project>("projects", projectId);
          this.saveSettings(projectId, {
            ...latest.settings,
            pendingXcodePath: installation.developerDirectory,
          });
        },
      },
    );
    if (!result.requiresLicense) {
      this.saveSettings(projectId, {
        ...this.store.get<Project>("projects", projectId).settings,
        xcodePath: result.installation.developerDirectory,
        pendingXcodePath: undefined,
        iosSdk: result.installation.iosSdks
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .at(-1),
      });
    }
    return result;
  }
  async build(
    request: BuildRequest,
    invocation?: BuildInvocation,
  ): Promise<Job[]> {
    const project =
      invocation?.project ??
      this.store.get<Project>("projects", request.projectId);
    if (invocation?.concurrency)
      this.configureConcurrency(invocation.concurrency);
    const jobs: Job[] = [];
    const effectiveType = project.settings.projectType ?? project.type;
    const supported =
      (project.settings.projectType &&
      project.type &&
      project.settings.projectType !== project.type
        ? undefined
        : project.platforms) ??
      (effectiveType === "native-ios"
        ? (["ios"] as Platform[])
        : project.id.startsWith("invocation:")
          ? ((await inspectProject(project.path, project.settings))
              .platforms ?? ["ios", "android"])
          : ["ios", "android"]);
    invariant(
      supported.length > 0,
      "PLATFORM_UNAVAILABLE",
      "This project declares no native platform. Add @capacitor/ios or @capacitor/android to the project before building.",
    );
    invariant(
      request.platform === "all" || supported.includes(request.platform),
      "PLATFORM_UNAVAILABLE",
      "This project does not declare the selected platform.",
    );
    for (const platform of request.platform === "all"
      ? supported
      : [request.platform]) {
      const job: Job = {
        id: id(),
        projectId: project.id,
        projectName: project.name,
        platform,
        profile: request.profile,
        status: "queued",
        stage: "queued",
        createdAt: now(),
        autoSubmit: request.autoSubmit ?? false,
        clean: request.clean ?? false,
        kind: request.validationOnly ? "test" : "build",
        checksMode: request.checksMode,
        projectSnapshot: invocation ? structuredClone(project) : undefined,
        requiresInvocationCredentials: invocation
          ? invocation.context.noKeychain ||
            Object.keys(invocation.context.credentials).length > 0
          : undefined,
        requestedBuildNumber: invocation?.buildNumber,
      };
      if (invocation) this.contexts.set(job.id, invocation.context);
      this.store.putJob(job);
      jobs.push(job);
    }
    this.changed();
    void this.pump();
    return jobs;
  }
  private limits: Record<Platform, number> = { ios: 1, android: 1 };
  configureConcurrency(limits: Partial<Record<Platform, number>>) {
    for (const platform of ["ios", "android"] as const) {
      const value = limits[platform];
      if (value !== undefined) {
        invariant(
          Number.isInteger(value) && value >= 1 && value <= 8,
          "CONCURRENCY",
          "Concurrency must be an integer between 1 and 8 per platform.",
        );
        this.limits[platform] = value;
      }
    }
    void this.pump();
    return { ...this.limits };
  }
  async pump() {
    if (this.pumping || this.closing) return;
    this.pumping = true;
    try {
      const jobs = this.store.list<Job>("jobs");
      const counts = { ios: 0, android: 0 };
      for (const job of jobs)
        if (this.controllers.has(job.id)) counts[job.platform]++;
      for (const job of jobs
        .filter((item) => item.status === "queued")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (this.closing || counts[job.platform] >= this.limits[job.platform])
          continue;
        counts[job.platform]++;
        void this.runJob(job)
          .catch((error) => {
            job.status = "failed";
            job.error = messageOf(error);
            job.finishedAt = now();
            this.controllers.delete(job.id);
            this.saveJob(job);
            this.emit("settled");
          })
          .finally(() => {
            void this.pump();
          });
      }
    } finally {
      this.pumping = false;
    }
  }
  private async runJob(job: Job) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.status = "running";
    job.startedAt = now();
    job.stageStartedAt = now();
    this.saveJob(job);
    const project = this.projectFor(job);
    await mkdir(join(this.store.root, "jobs", job.id), { recursive: true });
    const redactor = new Redactor();
    redactor.add(
      ...credentialSecrets(this.contexts.get(job.id)?.credentials ?? {}),
    );
    const log = (text: string) => this.log(job, redactor.redact(text));
    const stage = (stage: Stage) => {
      if (controller.signal.aborted)
        throw new DeskError("CANCELLED", "Operation cancelled.");
      if (
        stage === "upload" &&
        job.versionReservation &&
        job.bundleId &&
        job.buildNumber
      ) {
        this.store.commitNumber(
          `${job.platform}:${job.bundleId}`,
          job.parentJobId ?? job.id,
          Number(job.buildNumber),
        );
        job.versionReservation = "committed";
      }
      checkpoint(job, stage);
      job.stage = stage;
      job.stageStartedAt = now();
      job.progress = undefined;
      this.saveJob(job);
      log(`→ ${stage}`);
    };
    try {
      const vault = this.vaultFor(job);
      const store =
        vault instanceof RunVault
          ? invocationStore(this.store, vault, project, (value) => {
              job.projectSnapshot = value;
              this.saveJob(job);
            })
          : this.store;
      let googleEmail: string | undefined;
      if (job.platform === "android" && project.settings.googleConnectionId) {
        const email = (
          await vault.get(project.settings.googleConnectionId, "google")
        ).serviceAccount.client_email;
        googleEmail = email;
        job.connectionFingerprint = createHash("sha256")
          .update(email)
          .digest("hex");
        this.saveJob(job);
        this.assertGoogleIdle(email, job.id);
      }
      if (project.settings.envCredentialId)
        redactor.add(
          ...Object.values(
            (await vault.get(project.settings.envCredentialId, "environment"))
              .values,
          ),
        );
      const eas = await readJSON(join(project.path, "eas.json"), {
        build: { production: {} },
      });
      if (eas.build?.[job.profile])
        redactor.add(
          ...Object.values(resolveProfile(eas, job.profile, job.platform).env),
        );
      if (job.kind === "build" || job.kind === "test")
        await buildLocal({
          store,
          vault,
          job,
          project,
          signal: controller.signal,
          log,
          stage,
          save: () => this.saveJob(job),
          progress: (update) => this.recordProgress(job, update),
          googleGuard: () => {
            if (googleEmail) this.assertGoogleIdle(googleEmail, job.id);
          },
        });
      if (controller.signal.aborted)
        throw new DeskError("CANCELLED", "Operation cancelled.");
      if (job.autoSubmit || job.kind === "submit")
        await this.upload(job, project, controller.signal, log, stage);
      job.status =
        job.submission?.state === "rejected"
          ? "failed"
          : job.submission?.state === "processing" ||
              job.submission?.state === "uncertain"
            ? "needs-attention"
            : "succeeded";
      if (job.submission?.state === "rejected")
        job.error =
          job.submission.message ??
          "Apple rejected this build during processing.";
      if (job.submission?.state === "processing") {
        job.stage = "processing";
        job.stageStartedAt = now();
        job.progress = undefined;
        log(
          "Apple processing is pending. Status is checked automatically while the app runs.",
        );
      } else {
        job.stage = "complete";
      }
    } catch (error) {
      const uncertain =
        job.submission &&
        ["uploading", "processing"].includes(job.submission.state);
      if (uncertain) {
        job.submission!.state = "uncertain";
        job.status = "needs-attention";
      } else job.status = controller.signal.aborted ? "cancelled" : "failed";
      job.error = redactor.redact(messageOf(error));
      log(`ERROR: ${job.error}`);
    } finally {
      if (
        job.kind === "build" &&
        ["failed", "cancelled", "interrupted"].includes(job.status) &&
        this.store.releaseNumber(job.id)
      )
        job.versionReservation = "released";
      finishCheckpoint(
        job,
        job.status === "needs-attention"
          ? "interrupted"
          : job.status === "succeeded",
      );
      if (job.kind !== "submit")
        await forgetDerivedData(
          join(
            resolve(project.settings.buildDirectory ?? this.store.root),
            "jobs",
            job.id,
            "source",
          ),
        ).catch(() => undefined);
      job.finishedAt = now();
      this.saveJob(job);
      this.controllers.delete(job.id);
      this.emit("settled");
    }
  }
  private saveJob(job: Job) {
    this.store.putJob(job);
    this.changed();
  }
  private log(job: Job, text: string) {
    const entry: LogEntry = { time: now(), stage: job.stage, text };
    const folder = join(this.store.root, "jobs", job.id);
    if (!existsSync(folder)) return;
    appendFileSync(join(folder, "logs.jsonl"), JSON.stringify(entry) + "\n", {
      mode: 0o600,
    });
    this.emit("event", {
      type: "log",
      jobId: job.id,
      entry,
    } satisfies DeskEvent);
  }
  logs(jobId: string): LogEntry[] {
    this.store.get<Job>("jobs", jobId);
    const path = join(this.store.root, "jobs", jobId, "logs.jsonl");
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          })
      : [];
  }
  cancel(jobId: string) {
    const job = this.store.get<Job>("jobs", jobId);
    if (job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = now();
      this.saveJob(job);
      this.contexts.delete(jobId);
    }
    this.controllers.get(jobId)?.abort();
  }
  async retry(jobId: string) {
    const job = this.store.get<Job>("jobs", jobId);
    invariant(
      ["failed", "cancelled", "interrupted"].includes(job.status),
      "RETRY_STATE",
      "Only failed, cancelled, or interrupted jobs can be retried. Reconcile uncertain uploads first.",
    );
    invariant(
      !job.submission || ["rejected"].includes(job.submission.state),
      "UPLOAD_RETRY",
      "This artifact may already be uploaded. Check store status before retrying.",
    );
    if (job.requiresInvocationCredentials) this.vaultFor(job);
    if (job.kind === "submit") return [await this.submit(job.artifactId!)];
    return this.build(
      {
        projectId: job.projectId,
        platform: job.platform,
        profile: job.profile,
        autoSubmit: job.autoSubmit,
        clean: job.clean,
      },
      job.projectSnapshot
        ? {
            project: this.projectFor(job),
            context: this.contexts.get(job.id) ?? {
              credentials: {},
              noKeychain: false,
            },
            buildNumber: job.requestedBuildNumber,
          }
        : undefined,
    );
  }
  async submit(artifactId: string, invocation?: BuildInvocation): Promise<Job> {
    const artifact = this.store.get<Artifact>("artifacts", artifactId);
    const source = this.store.get<Job>("jobs", artifact.jobId);
    invariant(
      ["ipa", "aab"].includes(artifact.kind) && source.storeEligible,
      "ARTIFACT_TYPE",
      "Only artifacts built with a store distribution profile can be uploaded.",
    );
    const other = this.store
      .list<Job>("jobs")
      .find(
        (j) =>
          j.artifactId === artifactId &&
          (j.submission || j.kind === "submit") &&
          !["failed", "cancelled"].includes(j.status),
      );
    invariant(
      !other,
      "ALREADY_SUBMITTED",
      "This artifact has an existing submission. Check its store status rather than uploading it again.",
    );
    const job: Job = {
      ...source,
      id: id(),
      kind: "submit",
      parentJobId: source.id,
      status: "queued",
      stage: "queued",
      createdAt: now(),
      startedAt: undefined,
      stageStartedAt: undefined,
      progress: undefined,
      finishedAt: undefined,
      error: undefined,
      autoSubmit: true,
      submission: undefined,
    };
    if (invocation) {
      job.projectSnapshot = {
        ...this.projectFor(source),
        settings: invocation.project.settings,
      };
      job.requiresInvocationCredentials =
        invocation.context.noKeychain ||
        Object.keys(invocation.context.credentials).length > 0;
      this.contexts.set(job.id, invocation.context);
    } else if (this.contexts.has(source.id))
      this.contexts.set(job.id, this.contexts.get(source.id)!);
    this.store.putJob(job);
    this.changed();
    void this.pump();
    return job;
  }
  private async upload(
    job: Job,
    project: Project,
    signal: AbortSignal,
    log: (line: string) => void,
    stage: (stage: Stage) => void,
  ) {
    invariant(
      job.artifactId,
      "NO_ARTIFACT",
      "No successful build artifact is available.",
    );
    const artifact = this.store.get<Artifact>("artifacts", job.artifactId);
    stage("verify");
    const digest = await hashArtifact(artifact.path);
    invariant(
      digest.sha256 === artifact.sha256,
      "ARTIFACT_CHANGED",
      "The artifact changed since it was built. Rebuild before uploading.",
    );
    invariant(
      ["ipa", "aab"].includes(artifact.kind),
      "ARTIFACT_TYPE",
      "Only store IPA/AAB artifacts can be uploaded.",
    );
    const current =
      !job.requiresInvocationCredentials &&
      !project.id.startsWith("invocation:")
        ? this.store.list<Project>("projects").find((p) => p.id === project.id)
        : undefined;
    assertUploadChecks(job, current?.settings ?? project.settings);
    const redactor = new Redactor();
    stage("upload");
    if (job.platform === "ios") {
      const credential = await this.vaultFor(job).get(
        project.settings.appleConnectionId,
        "apple",
      );
      redactor.add(credential.privateKey, credential.keyId);
      const api = new AppleAPI(credential);
      const existing = await api.build(
        artifact.bundleId,
        artifact.buildNumber,
        artifact.version,
      );
      invariant(
        !existing.length,
        "APPLE_DUPLICATE",
        "Apple already has this build number. Reconcile that build or build a new version.",
      );
      job.submission = {
        state: "uploading",
        destination: "App Store Connect / TestFlight",
      };
      this.saveJob(job);
      job.submission = await privateDirectory((root) =>
        uploadApple(credential, artifact, root, {
          signal,
          env: toolEnvironment(project.settings),
          log: (line) => log(redactor.redact(line)),
          secrets: redactor,
          progress: (update) => this.recordProgress(job, update),
        }),
      );
      this.saveJob(job);
      const result = await api
        .build(artifact.bundleId, artifact.buildNumber, artifact.version)
        .catch(() => []);
      job.submission =
        appleBuildState(result, artifact.version) ?? job.submission;
      await this.finishTestFlight(job, project, signal);
      this.saveJob(job);
    } else {
      const credential = await this.vaultFor(job).get(
        project.settings.googleConnectionId,
        "google",
      );
      const api = new GoogleAPI(credential, fetch, signal, () =>
        this.assertGoogleIdle(credential.serviceAccount.client_email, job.id),
      );
      this.assertGoogleIdle(credential.serviceAccount.client_email, job.id);
      const versions = await api.versions(artifact.bundleId);
      invariant(
        !versions.includes(Number(artifact.buildNumber)),
        "GOOGLE_DUPLICATE",
        "Google Play already has this version code. Reconcile before uploading.",
      );
      const track = project.settings.track ?? "internal";
      const rollout = googleRollout(project.settings, track);
      if (
        rollout &&
        project.settings.playAutoRollout === undefined &&
        !this.store
          .list<Job>("jobs")
          .some(
            (other) =>
              other.id !== job.id &&
              other.projectId === job.projectId &&
              other.submission?.rollout !== undefined,
          )
      )
        log(
          "Internal-track uploads now roll out to testers automatically. Set playAutoRollout=false to keep uploading drafts.",
        );
      job.submission = {
        state: "uploading",
        destination: `Google Play · ${track} · ${rollout ? "rollout" : "draft"}`,
        rollout,
      };
      this.saveJob(job);
      const uploaded = new Set(
        this.store
          .list<Job>("jobs")
          .filter((other) => other.artifactId && other.submission)
          .map((other) => other.artifactId!),
      );
      job.submission = {
        ...(await api
          .upload(
            artifact,
            track,
            (editId, baselineReleases, supersededVersionCodes) => {
              job.submission!.externalId = editId;
              if (baselineReleases)
                job.submission!.baselineReleases = baselineReleases;
              if (supersededVersionCodes)
                job.submission!.supersededVersionCodes = supersededVersionCodes;
              this.saveJob(job);
            },
            signal,
            (update) => this.recordProgress(job, update),
            {
              rollout,
              log,
              releaseNotes: project.settings.playReleaseNotes?.trim()
                ? [
                    {
                      language:
                        project.settings.playReleaseNotesLanguage ?? "en-US",
                      text: project.settings.playReleaseNotes.trim(),
                    },
                  ]
                : undefined,
              uploadedByDesk: (versionCode) =>
                this.store
                  .list<Artifact>("artifacts")
                  .some(
                    (item) =>
                      item.platform === "android" &&
                      item.bundleId === artifact.bundleId &&
                      item.buildNumber === versionCode &&
                      uploaded.has(item.id),
                  ),
            },
          )
          .catch((error) => {
            if (error?.code === "GOOGLE_DRAFT_EXISTS")
              job.submission = undefined;
            throw error;
          })),
        rollout,
        supersededVersionCodes: job.submission.supersededVersionCodes,
      };
      this.saveJob(job);
    }
  }
  reconcile(jobId: string): Promise<void> {
    const existing = this.reconciliations.get(jobId);
    if (existing) return existing;
    invariant(
      !this.closing,
      "DESK_CLOSING",
      "Local Build Desk is shutting down. Reopen it to continue.",
    );
    const controller = new AbortController();
    this.reconciliationControllers.set(jobId, controller);
    const pending = this.reconcileJob(jobId, controller.signal).finally(() => {
      this.reconciliations.delete(jobId);
      this.reconciliationControllers.delete(jobId);
    });
    this.reconciliations.set(jobId, pending);
    return pending;
  }
  private async reconcileJob(jobId: string, signal: AbortSignal) {
    const job = this.store.get<Job>("jobs", jobId);
    invariant(
      job.status !== "running",
      "UPLOAD_ACTIVE",
      "This upload is still active. Wait for it to finish or cancel before reconciling its store state.",
    );
    invariant(
      job.artifactId && job.submission,
      "NO_SUBMISSION",
      "No submission to reconcile.",
    );
    const artifact = this.store.get<Artifact>("artifacts", job.artifactId);
    const project = this.projectFor(job);
    const googleCredential =
      job.platform === "android"
        ? await this.vaultFor(job).get(
            project.settings.googleConnectionId,
            "google",
          )
        : undefined;
    if (googleCredential)
      this.assertGoogleIdle(
        googleCredential.serviceAccount.client_email,
        job.id,
      );
    if (job.platform === "ios") {
      const api = new AppleAPI(
        await this.vaultFor(job).get(
          project.settings.appleConnectionId,
          "apple",
        ),
        fetch,
        undefined,
        { signal },
      );
      const builds = await api.build(
        artifact.bundleId,
        artifact.buildNumber,
        artifact.version,
      );
      const state = appleBuildState(builds, artifact.version);
      if (!state && job.submission!.state === "processing") {
        job.submission!.lastCheckedAt = now();
        job.submission!.message =
          "Upload accepted; Apple has not exposed this build in its processing API yet. Check status again or use --wait; do not upload it again.";
        this.saveJob(job);
        return;
      }
      invariant(
        state,
        "APPLE_PROCESSING",
        "This build is not visible yet. Apple may still be processing it. Check again later; do not upload it again.",
      );
      job.submission = { ...job.submission, ...state, lastCheckedAt: now() };
    } else
      job.submission = {
        ...(await new GoogleAPI(googleCredential!, fetch, signal, () =>
          this.assertGoogleIdle(
            googleCredential!.serviceAccount.client_email,
            job.id,
          ),
        ).reconcile(
          artifact,
          project.settings.track ?? "internal",
          job.submission.externalId,
          job.submission.baselineReleases,
          {
            rollout: job.submission.rollout,
            supersededVersionCodes: job.submission.supersededVersionCodes,
          },
        )),
        rollout: job.submission.rollout,
        supersededVersionCodes: job.submission.supersededVersionCodes,
        lastCheckedAt: now(),
      };
    await this.finishTestFlight(job, project, signal);
    job.restoredFromBackup = false;
    job.status =
      job.submission.state === "rejected"
        ? "failed"
        : ["accepted", "draft"].includes(job.submission.state)
          ? "succeeded"
          : "needs-attention";
    job.stage = job.status === "succeeded" ? "complete" : "processing";
    job.error = undefined;
    this.saveJob(job);
  }
  private async finishTestFlight(
    job: Job,
    project: Project,
    signal?: AbortSignal,
  ) {
    if (
      job.platform !== "ios" ||
      job.submission?.state !== "accepted" ||
      !project.settings.testFlightGroupId ||
      !job.submission.externalId
    )
      return;
    const api = new AppleAPI(
      await this.vaultFor(job).get(project.settings.appleConnectionId, "apple"),
      fetch,
      undefined,
      { signal },
    );
    const group = (
      await api.request(`/betaGroups/${project.settings.testFlightGroupId}`)
    ).data;
    invariant(
      group.attributes.isInternalGroup,
      "INTERNAL_GROUP_REQUIRED",
      "Automatic distribution supports internal TestFlight groups only.",
    );
    await api.request(`/betaGroups/${group.id}/relationships/builds`, "POST", {
      data: [{ type: "builds", id: job.submission.externalId }],
    });
    job.submission.message = `Processed by Apple and available to internal group ${group.attributes.name}.`;
  }
  private async pollProcessing() {
    if (this.polling || this.closing) return;
    this.polling = true;
    try {
      for (const job of this.store
        .list<Job>("jobs")
        .filter(
          (j) =>
            j.submission?.state === "processing" &&
            j.status !== "running" &&
            !j.restoredFromBackup,
        )) {
        try {
          await this.reconcile(job.id);
          this.pollErrors.delete(job.id);
        } catch (error) {
          const message = messageOf(error);
          if (this.pollErrors.get(job.id) !== message) {
            this.log(job, "Waiting for Apple: " + message);
            this.pollErrors.set(job.id, message);
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }
  async saveCredential(input: Record<string, unknown>) {
    const credential = await importCredential(input);
    const value = await this.vault.put(credential);
    this.changed();
    return value;
  }
  async importGoogleConnection(projectId: string, keyPath: string) {
    const project = this.store.get<Project>("projects", projectId);
    const credential = await importCredential({
      kind: "google",
      label: `${project.name} · Google Play`,
      keyPath,
    });
    invariant(
      credential.kind === "google",
      "CONNECTION_TYPE",
      "Choose a Google service-account key.",
    );
    this.assertGoogleIdle(credential.serviceAccount.client_email);
    const validation = await new GoogleAPI(credential, fetch, undefined, () =>
      this.assertGoogleIdle(credential.serviceAccount.client_email),
    ).validate(project.packageName);
    const saved = await this.vault.put(credential);
    this.saveSettings(projectId, {
      ...this.store.get<Project>("projects", projectId).settings,
      googleConnectionId: saved.id,
    });
    return {
      connectionId: saved.id,
      validation,
      packageName: project.packageName,
    };
  }
  /** The saved Apple ID or Google sign-in, for filling in its sign-in page. */
  async savedLogin(provider: "apple" | "google") {
    for (const summary of this.store.credentialSummaries()) {
      if (summary.kind !== "login") continue;
      const login = await this.vault.get(summary.id, "login");
      if (login.provider === provider) return login;
    }
    return undefined;
  }
  removeCredential(id: string) {
    for (const p of this.store.list<Project>("projects"))
      invariant(
        !Object.values(p.settings).includes(id),
        "CREDENTIAL_IN_USE",
        `Remove this credential from ${p.name} settings first.`,
      );
    this.vault.remove(id);
    this.changed();
  }
  async validateConnection(id: string, projectId?: string) {
    const credential = await this.vault.get(id);
    if (credential.kind === "apple") return new AppleAPI(credential).validate();
    if (credential.kind === "google") {
      this.assertGoogleIdle(credential.serviceAccount.client_email);
      const p = projectId
        ? this.store.get<Project>("projects", projectId)
        : this.store
            .list<Project>("projects")
            .find((p) => p.settings.googleConnectionId === id);
      invariant(
        !projectId || p?.packageName,
        "ANDROID_PACKAGE",
        "Set android.package before verifying this app’s Google Play permissions.",
      );
      return new GoogleAPI(credential, fetch, undefined, () =>
        this.assertGoogleIdle(credential.serviceAccount.client_email),
      ).validate(p?.packageName);
    }
    throw new DeskError(
      "CONNECTION_TYPE",
      "Choose an Apple or Google connection.",
    );
  }
  async seedCounter(projectId: string, platform: Platform, lastUsed: number) {
    const project = this.store.get<Project>("projects", projectId);
    const identity =
      platform === "ios" ? project.bundleId : project.packageName;
    invariant(identity, "APP_ID_REQUIRED", "Configure the app identity first.");
    this.store.seed(`${platform}:${identity}`, lastUsed);
    this.changed();
  }
  async migrate(
    projectId: string,
    input: {
      credentialsPath?: string;
      environmentPaths?: string[];
      iosBuildNumber?: number;
      androidBuildNumber?: number;
    },
  ) {
    const project = this.store.get<Project>("projects", projectId);
    const results: string[] = [];
    if (input.credentialsPath) {
      const file = resolve(input.credentialsPath);
      const config = JSON.parse(await readFile(file, "utf8"));
      const base = dirname(file);
      if (config.ios) {
        const targets = config.ios.distributionCertificate
          ? [config.ios]
          : Object.values<any>(config.ios);
        const first = targets[0];
        invariant(
          first?.distributionCertificate,
          "EAS_CREDENTIALS",
          "No iOS distribution certificate in credentials.json.",
        );
        const cert = await readFile(
          resolve(base, first.distributionCertificate.path),
        );
        for (const target of targets) {
          const other = await readFile(
            resolve(base, target.distributionCertificate.path),
          );
          invariant(
            cert.equals(other),
            "MULTIPLE_CERTIFICATES",
            "All targets must use the same imported signing certificate.",
          );
        }
        const profiles = await Promise.all(
          targets.map(async (t) =>
            (await readFile(resolve(base, t.provisioningProfilePath))).toString(
              "base64",
            ),
          ),
        );
        const saved = await this.vault.put({
          kind: "ios",
          label: `${project.name} · imported iOS`,
          p12: cert.toString("base64"),
          password: first.distributionCertificate.password,
          profiles,
        });
        project.settings.iosSigningId = saved.id;
        results.push("Imported iOS certificate and profiles.");
      }
      if (config.android?.keystore) {
        const k = config.android.keystore;
        const saved = await this.vault.put({
          kind: "android",
          label: `${project.name} · upload key`,
          keystore: (await readFile(resolve(base, k.keystorePath))).toString(
            "base64",
          ),
          storePassword: k.keystorePassword,
          alias: k.keyAlias,
          keyPassword: k.keyPassword,
        });
        project.settings.androidSigningId = saved.id;
        results.push("Imported the existing Android upload key.");
      }
    }
    if (input.environmentPaths?.length) {
      let values: Record<string, string> = {};
      if (project.settings.envCredentialId)
        values = (
          await this.vault.get(project.settings.envCredentialId, "environment")
        ).values;
      for (const path of input.environmentPaths) {
        const content = await readFile(path, "utf8");
        Object.assign(
          values,
          extname(path) === ".json" ? JSON.parse(content) : parseEnv(content),
        );
      }
      invariant(
        Object.values(values).every((v) => typeof v === "string"),
        "ENV_VALUES",
        "Environment values must be strings.",
      );
      const saved = await this.vault.put(
        { kind: "environment", label: `${project.name} · environment`, values },
        project.settings.envCredentialId,
      );
      project.settings.envCredentialId = saved.id;
      results.push(
        `Imported ${Object.keys(values).length} environment values.`,
      );
    }
    if (input.iosBuildNumber !== undefined) {
      await this.seedCounter(projectId, "ios", input.iosBuildNumber);
      results.push("Seeded iOS counter.");
    }
    if (input.androidBuildNumber !== undefined) {
      await this.seedCounter(projectId, "android", input.androidBuildNumber);
      results.push("Seeded Android counter.");
    }
    this.store.putProject(project);
    this.changed();
    return results;
  }
  async createCertificate(connectionId: string, label: string) {
    const credential = await this.vault.get(connectionId, "apple");
    const result = await privateDirectory((root) =>
      createDistributionCertificate(credential, label, root),
    );
    const saved = await this.vault.put(result);
    this.changed();
    return saved;
  }
  async registerDevice(connectionId: string, name: string, udid: string) {
    const api = new AppleAPI(await this.vault.get(connectionId, "apple"));
    const device = await api.request("/devices", "POST", {
      data: { type: "devices", attributes: { name, udid, platform: "IOS" } },
    });
    return `Registered ${device.data.attributes.name}. Regenerate ad hoc/development profiles to include it.`;
  }
  async createProfile(
    connectionId: string,
    signingId: string,
    bundleId: string,
    type: "IOS_APP_STORE" | "IOS_APP_ADHOC" | "IOS_APP_DEVELOPMENT",
  ) {
    const api = new AppleAPI(await this.vault.get(connectionId, "apple"));
    const signing = await this.vault.get(signingId, "ios");
    return privateDirectory(async (root) => {
      const certId = await certificateId(api, signing, root);
      const profile = await api.profile(
        bundleId,
        `Local Build Desk ${bundleId} ${Date.now()}`,
        type,
        certId,
      );
      const content = profile.attributes.profileContent;
      const decoded = await decodeProfile(content, root);
      const old = await Promise.all(
        signing.profiles.map((p) => decodeProfile(p, root)),
      );
      signing.profiles = signing.profiles.filter(
        (_, i) =>
          old[i].Entitlements["application-identifier"] !==
            decoded.Entitlements["application-identifier"] ||
          Boolean(old[i].ProvisionedDevices) !==
            Boolean(decoded.ProvisionedDevices),
      );
      signing.profiles.push(content);
      await this.vault.put(signing, signingId);
      this.changed();
      return `Created ${decoded.Name}.`;
    });
  }
  async generateKeystore(
    projectId: string,
    label: string,
    alias: string,
    password: string,
  ) {
    const project = this.store.get<Project>("projects", projectId);
    invariant(
      !project.settings.androidSigningId,
      "KEY_EXISTS",
      "This project already has an Android signing key.",
    );
    invariant(
      password.length >= 6,
      "KEY_PASSWORD",
      "Use a password of at least six characters.",
    );
    const saved = await privateDirectory(async (root) => {
      const key = join(root, "upload.jks");
      await run(
        "keytool",
        [
          "-genkeypair",
          "-keystore",
          key,
          "-storetype",
          "JKS",
          "-alias",
          alias,
          "-keyalg",
          "RSA",
          "-keysize",
          "2048",
          "-validity",
          "10000",
          "-dname",
          "CN=Local Build Desk",
          "-storepass:env",
          "DESK_PASSWORD",
          "-keypass:env",
          "DESK_PASSWORD",
        ],
        {
          env: {
            ...toolEnvironment(project.settings),
            DESK_PASSWORD: password,
          },
        },
      );
      return this.vault.put({
        kind: "android",
        label,
        keystore: (await readFile(key)).toString("base64"),
        alias,
        storePassword: password,
        keyPassword: password,
      });
    });
    project.settings.androidSigningId = saved.id;
    this.store.putProject(project);
    this.changed();
    return saved;
  }
  private setupLogger(projectId: string) {
    const folder = join(this.store.root, "setup");
    if (!existsSync(folder)) requireMkdir(folder);
    return (text: string) => {
      const entry: LogEntry = { time: now(), stage: "configure", text };
      appendFileSync(
        join(folder, projectId + ".jsonl"),
        JSON.stringify(entry) + "\n",
        { mode: 0o600 },
      );
      this.emit("event", {
        type: "log",
        jobId: "setup:" + projectId,
        entry,
      } satisfies DeskEvent);
    };
  }
  private recordProgress(job: Job, update: ProgressUpdate) {
    const time = now();
    job.progress = {
      ...update,
      startedAt:
        job.progress?.label === update.label ? job.progress.startedAt : time,
      updatedAt: time,
    };
    this.saveJob(job);
  }
  private assertGoogleIdle(email: string, exceptJobId?: string) {
    const connections = new Set(
      this.store
        .credentialSummaries()
        .filter((item) => item.kind === "google" && item.detail === email)
        .map((item) => item.id),
    );
    const projects = new Set(
      this.store
        .list<Project>("projects")
        .filter((item) =>
          connections.has(item.settings.googleConnectionId ?? ""),
        )
        .map((item) => item.id),
    );
    const accountRoot = join(this.store.root, "accounts");
    if (existsSync(accountRoot)) {
      for (const entry of readdirSync(accountRoot) as string[]) {
        if (!entry.endsWith("-google-store-bootstrap.json")) continue;
        let state: StoreSetupState | undefined;
        try {
          state = JSON.parse(
            readFileSync(join(accountRoot, entry), "utf8"),
          ).storeSetup;
        } catch {
          continue;
        }
        if (
          (state?.submitted.upload || state?.consoleEditActive) &&
          !["verifying", "complete"].includes(state.stage)
        )
          invariant(
            !connections.has(state!.connectionId ?? "") &&
              !this.store
                .list<Project>("projects")
                .some(
                  (p) =>
                    projects.has(p.id) && p.packageName === state!.identity,
                ),
            "GOOGLE_CONSOLE_BUSY",
            "A first-upload console session has a staged or uncertain AAB. Resume it and save the draft before opening an API edit.",
          );
      }
    }

    const pending = this.store
      .list<Job>("jobs")
      .find(
        (item) =>
          item.id !== exceptJobId &&
          (projects.has(item.projectId) ||
            item.connectionFingerprint ===
              createHash("sha256").update(email).digest("hex")) &&
          item.platform === "android" &&
          ((item.status === "running" && item.stage === "upload") ||
            item.submission?.state === "uncertain"),
      );
    invariant(
      !pending,
      "GOOGLE_EDIT_BUSY",
      `Finish or reconcile Google upload ${pending?.id} before checking this connection or opening another edit. This preserves its staged AAB.`,
    );
  }
  setupLogs(projectId: string): LogEntry[] {
    this.store.get<Project>("projects", projectId);
    const path = join(this.store.root, "setup", projectId + ".jsonl");
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  }
  async prepareProject(projectId: string, request: SetupRequest) {
    const project = this.store.get<Project>("projects", projectId);
    const log = this.setupLogger(projectId);
    if (request.platform === "android" && project.settings.googleConnectionId)
      this.assertGoogleIdle(
        (await this.vault.get(project.settings.googleConnectionId, "google"))
          .serviceAccount.client_email,
      );
    try {
      const result = await (
        request.platform === "ios" ? prepareApple : prepareAndroid
      )(this.store, this.vault, project, request, log);
      this.changed();
      return result;
    } catch (error) {
      log("Setup paused: " + messageOf(error));
      this.changed();
      throw error;
    }
  }
  installTool(
    projectId: string,
    tool: ToolName,
    acceptAndroidLicense: boolean,
  ) {
    const key = `${projectId}:${tool}`;
    const existing = this.toolInstalls.get(key);
    if (existing) return existing;
    const controller = new AbortController();
    this.toolchainControllers.set(key, controller);
    const operation = this.installToolOperation(
      projectId,
      tool,
      acceptAndroidLicense,
      controller.signal,
    ).finally(() => {
      this.toolchainControllers.delete(key);
      this.toolInstalls.delete(key);
    });
    this.toolInstalls.set(key, operation);
    return operation;
  }
  private async installToolOperation(
    projectId: string,
    tool: ToolName,
    acceptAndroidLicense: boolean,
    signal: AbortSignal,
  ) {
    const project = this.store.get<Project>("projects", projectId);
    const settings = await installTool(
      tool,
      acceptAndroidLicense,
      this.setupLogger(projectId),
      project.path,
      project.settings,
      signal,
    );
    project.settings = {
      ...this.store.get<Project>("projects", projectId).settings,
      ...settings,
    };
    this.store.putProject(project);
    this.changed();
  }
  async googleCredentialDetails(id: string, verifyToken = true) {
    const credential = await this.vault.get(id, "google");
    if (verifyToken) await new GoogleAPI(credential).token();
    return {
      email: credential.serviceAccount.client_email as string,
      cloudProject: credential.serviceAccount.project_id as string,
    };
  }
  async googleLogin(projectId: string) {
    await run("gcloud", ["auth", "login", "--quiet"], {
      env: toolEnvironment(),
      log: this.setupLogger(projectId),
    });
  }
  async createGoogleConnection(projectId: string, cloudProject: string) {
    const project = this.store.get<Project>("projects", projectId);
    const result = await createGoogleServiceAccount(
      this.vault,
      cloudProject,
      this.setupLogger(projectId),
    );
    let ready = false;
    let message: string | undefined;
    try {
      await this.validateConnection(result.credential.id, project.id);
      const latest = this.store.get<Project>("projects", project.id);
      this.saveSettings(project.id, {
        ...latest.settings,
        googleConnectionId: result.credential.id,
      });
      ready = true;
    } catch (error) {
      message = messageOf(error);
    }
    this.changed();
    return {
      email: result.email,
      connectionId: result.credential.id,
      ready,
      message,
    };
  }
  async storeSetupContext(projectId: string, request: StoreSetupRequest) {
    const state = await makeStoreSetup(this.store, projectId, request);
    const project = this.store.get<Project>("projects", projectId);
    if (request.provider === "apple" && project.settings.appleConnectionId) {
      const api = new AppleAPI(
        await this.vault.get(project.settings.appleConnectionId, "apple"),
      );
      if (request.mode === "record") {
        const existing = await api.apps(state.identity);
        if (existing.length) {
          state.appId = existing[0].id;
          state.stage = "complete";
          this.saveSettings(projectId, {
            ...project.settings,
            ascAppId: state.appId,
          });
        }
      } else if (request.mode === "capabilities") {
        const bundles = (
          await api.request(
            `/bundleIds?filter[identifier]=${encodeURIComponent(state.identity)}&limit=200`,
          )
        ).data;
        invariant(
          bundles.length === 1,
          "STORE_BUNDLE",
          "Run signing setup to register this exact bundle ID before assigning capabilities.",
        );
        state.appId = bundles[0].id;
      }
    }
    if (request.provider === "google") {
      try {
        const previous = JSON.parse(
          readFileSync(
            join(this.store.root, "accounts", `${projectId}-google.json`),
            "utf8",
          ),
        );
        state.developerId = previous.google?.developerId;
        if (request.mode === "bootstrap")
          state.connectionId = previous.google?.pendingCredentialId;
      } catch {}
      if (request.mode === "bootstrap") {
        state.connectionId ||= project.settings.googleConnectionId;
        invariant(
          state.connectionId,
          "GOOGLE_CONNECTION",
          "Set up a Google service-account key and prepare app permissions before the first console upload. A pending encrypted key is supported.",
        );
        await this.googleCredentialDetails(state.connectionId);
        try {
          const previous = JSON.parse(
            readFileSync(
              join(
                this.store.root,
                "accounts",
                `${projectId}-google-store-record.json`,
              ),
              "utf8",
            ),
          );
          if (previous.storeSetup?.identity === state.identity) {
            state.appId = previous.storeSetup.appId;
            state.developerId =
              previous.storeSetup.developerId || state.developerId;
          }
        } catch {}
      }
    }
    return state;
  }
  async bootstrapFile(projectId: string, artifactId: string) {
    const project = this.store.get<Project>("projects", projectId);
    const artifact = await verifyBootstrapArtifact(
      this.store,
      project,
      artifactId,
    );
    const job = this.store.get<Job>("jobs", artifact.jobId);
    this.store.commitNumber(
      `android:${artifact.bundleId}`,
      job.parentJobId ?? job.id,
      Number(artifact.buildNumber),
    );
    job.versionReservation = "committed";
    this.store.putJob(job);
    return artifact.path;
  }
  async finishStoreSetup(projectId: string, state: StoreSetupState) {
    const project = this.store.get<Project>("projects", projectId);
    if (state.mode === "record" && state.provider === "apple") {
      const api = new AppleAPI(
        await this.vault.get(project.settings.appleConnectionId, "apple"),
      );
      const apps = await api.apps(state.identity);
      invariant(
        apps.length === 1,
        "STORE_APP_PENDING",
        "Apple has not exposed this bundle ID's app record yet. Retry verification; another app record will not be created.",
      );
      this.saveSettings(projectId, {
        ...project.settings,
        ascAppId: apps[0].id,
      });
      return "Apple app record verified for " + state.identity;
    }
    if (state.mode === "capabilities") {
      invariant(
        project.settings.iosSigningId,
        "IOS_SIGNING",
        "Run signing setup before repairing capability assignments.",
      );
      const api = new AppleAPI(
        await this.vault.get(project.settings.appleConnectionId, "apple"),
      );
      const signing = await this.vault.get(
        project.settings.iosSigningId,
        "ios",
      );
      await privateDirectory((root) => certificateId(api, signing, root, true));
      const report = await this.prepareProject(projectId, {
        platform: "ios",
        newApp: false,
        renewProfiles: false,
      });
      invariant(
        report.ready,
        "CAPABILITY_REPAIR",
        report.handoffs.map((item) => item.detail).join("\n") ||
          "Signing still needs attention.",
      );
      return "Capabilities and regenerated provisioning profiles verified.";
    }
    if (state.mode === "bootstrap") {
      const artifact = await verifyBootstrapArtifact(
        this.store,
        project,
        state.artifactId!,
      );
      const credential = await this.vault.get(
        state.connectionId || project.settings.googleConnectionId,
        "google",
      );
      this.assertGoogleIdle(credential.serviceAccount.client_email);
      await new GoogleAPI(credential).verifySavedBundle(artifact, "internal");
      const job = this.store.get<Job>("jobs", artifact.jobId);
      job.submission = {
        state: "draft",
        destination: "Google Play · internal",
        message:
          "First console upload verified as the exact selected AAB in an internal draft.",
        uploadedAt: now(),
      };
      this.store.putJob(job);
      if (state.connectionId)
        this.saveSettings(projectId, {
          ...this.store.get<Project>("projects", projectId).settings,
          googleConnectionId: state.connectionId,
        });
      this.changed();
      return "Exact AAB verified in the internal draft. API uploads are ready.";
    }
    return state.newApp
      ? "Google Play app record is ready. Continue with signing and the first AAB upload."
      : "Existing Google Play app record associated. Continue with normal build and upload.";
  }
  async testFlightUsers(projectId: string) {
    const project = this.store.get<Project>("projects", projectId);
    const api = new AppleAPI(
      await this.vault.get(project.settings.appleConnectionId, "apple"),
    );
    const app = await api.app(project.bundleId!);
    return internalTeamUsers(api, app.id);
  }
  async configureTestFlight(
    projectId: string,
    request: { name: string; userIds: string[] },
  ) {
    const project = this.store.get<Project>("projects", projectId);
    const api = new AppleAPI(
      await this.vault.get(project.settings.appleConnectionId, "apple"),
    );
    const app = await api.app(project.bundleId!);
    const journalPath = join(this.store.root, "testflight-requests.json");
    const group = await withLock(journalPath, undefined, async () => {
      let requests: Record<string, boolean> = {};
      if (existsSync(journalPath))
        requests = JSON.parse(readFileSync(journalPath, "utf8"));
      const key = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      return configureInternalTesting(
        api,
        app.id,
        request.name,
        request.userIds,
        {
          has: (value) => !!requests[key(value)],
          mark: (value) => {
            requests[key(value)] = true;
            writeFileSync(journalPath, JSON.stringify(requests), {
              mode: 0o600,
            });
          },
        },
      );
    });
    this.saveSettings(projectId, {
      ...this.store.get<Project>("projects", projectId).settings,
      testFlightGroupId: group.id,
      testFlightGroupName: group.name,
    });
    // Builds Apple already processed before the group existed join it now.
    const updated = this.store.get<Project>("projects", projectId);
    for (const job of this.store
      .list<Job>("jobs")
      .filter(
        (j) =>
          j.projectId === projectId &&
          j.platform === "ios" &&
          j.submission?.state === "accepted" &&
          !j.submission.message?.includes(`internal group ${group.name}`),
      )) {
      // Best effort: the group itself is set up; the job keeps its old message.
      try {
        await this.finishTestFlight(job, updated);
        this.saveJob(job);
      } catch {}
    }
    return group;
  }
  async testFlightGroups(projectId: string) {
    const project = this.store.get<Project>("projects", projectId);
    const api = new AppleAPI(
      await this.vault.get(project.settings.appleConnectionId, "apple"),
    );
    const app = await api.app(project.bundleId!);
    const groups = (
      await api.request(`/betaGroups?filter[app]=${app.id}&limit=200`)
    ).data;
    return groups
      .filter((g: any) => g.attributes.isInternalGroup)
      .map((g: any) => ({ id: g.id, name: g.attributes.name }));
  }
  async idle() {
    if (
      !this.store
        .list<Job>("jobs")
        .some((job) => ["queued", "running"].includes(job.status))
    )
      return;
    await new Promise<void>((resolve) => {
      const check = () => {
        if (
          !this.store
            .list<Job>("jobs")
            .some((job) => ["queued", "running"].includes(job.status))
        ) {
          this.off("event", check);
          resolve();
        }
      };
      this.on("event", check);
      check();
    });
  }
  async shutdown() {
    this.closing = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const item of [
      ...this.deviceOperations.values(),
      ...this.releaseOperations.values(),
    ])
      item.controller.abort();
    for (const controller of this.reconciliationControllers.values())
      controller.abort();
    await Promise.allSettled([
      ...[
        ...this.deviceOperations.values(),
        ...this.releaseOperations.values(),
      ].map((item) => item.operation),
      ...this.reconciliations.values(),
    ]);
    this.restorePreview = undefined;
    this.releasePreviews.clear();
    this.closing = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const controller of this.toolchainControllers.values())
      controller.abort();
    await Promise.allSettled([
      ...this.toolchainOperations.values(),
      ...this.toolInstalls.values(),
    ]);
    for (const controller of this.controllers.values()) controller.abort();
    if (this.controllers.size)
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!this.controllers.size) {
            this.off("settled", check);
            clearTimeout(timeout);
            resolve();
          }
        };
        const timeout = setTimeout(() => {
          this.off("settled", check);
          resolve();
        }, 10000);
        this.on("settled", check);
        check();
      });
    this.contexts.clear();
  }
}
