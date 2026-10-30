import type { MobileMonitor } from "../mobile/server";
import type { Updater } from "../main/updater";
import { isInvocationVariable, withCurrentNames } from "../core/naming";
import { detectProjectType, appRoot } from "../core/project-adapters";
import { xcodeContainers, xcodegenSpecs } from "../core/xcode-project";
import { hasFile } from "../core/config";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveInvocation } from "./invocation";
import {
  RunVault,
  credentialSecrets,
  type BuildInvocation,
} from "../core/runtime-context";
import { Redactor } from "../core/process";
import { doctor } from "../core/doctor";
import { inspectProject, resolveProfile } from "../core/config";
import { resolve } from "node:path";
import { Engine } from "../core/engine";
import { invariant, messageOf } from "../core/errors";
import type { Job, Platform, Project, ToolName } from "../core/types";
import { privateDirectory } from "../core/vault";
import { decodeProfile } from "../core/signing";
import { AppleAPI } from "../core/stores";
import {
  applyListing,
  listingPlan,
  loadListing,
} from "../core/app-store-listing";
import {
  readListingCompliance,
  saveListingCompliance,
  type AppleWebSession,
} from "../core/app-store-compliance";
import { setTimeout as sleep } from "node:timers/promises";
import { ReleaseJournal, listingFingerprint } from "../core/release-journal";
import { assertScreenshotProvenance } from "../core/screenshot-provenance";
import { transferVersionCounter } from "../core/versions";
export const CLI_EXIT = { success: 0, failure: 1, processing: 2 } as const;
export interface CLIRuntime {
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  onJobs?: (ids: string[]) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  /** App Store Connect's web API in the desk's signed-in session (desktop owner only). */
  appleWeb?: AppleWebSession;
  monitor?: MobileMonitor;
  /** Self-update through the owner's signed-release updater. */
  updates?: {
    updater: Pick<Updater, "status" | "check" | "prepare">;
    /** Applies a staged update once this command has replied. */
    apply(): "restart" | "exit" | "quit";
  };
}
function pendingProcessing(job: Job) {
  return job.submission?.state === "processing";
}
function pendingJob(job: Job) {
  return pendingProcessing(job) || ["queued", "running"].includes(job.status);
}
function resultCode(jobs: Job[]) {
  if (
    jobs.some(
      (job) =>
        job.status === "failed" ||
        job.status === "cancelled" ||
        job.status === "interrupted" ||
        job.submission?.state === "uncertain" ||
        job.submission?.state === "rejected",
    )
  )
    return CLI_EXIT.failure;
  if (jobs.some(pendingJob)) return CLI_EXIT.processing;
  return jobs.every((job) => job.status === "succeeded")
    ? CLI_EXIT.success
    : CLI_EXIT.failure;
}
async function refreshProcessing(
  engine: Engine,
  jobs: Job[],
  wait: boolean,
  timeoutMs: number,
  runtime: CLIRuntime,
) {
  const now = runtime.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const errors = new Map<string, { message: string; code?: string }>();
  for (;;) {
    for (const job of jobs.filter(pendingProcessing)) {
      try {
        await engine.reconcile(job.id);
        errors.delete(job.id);
      } catch (error) {
        errors.set(job.id, {
          message: messageOf(error),
          code: (error as any)?.code,
        });
      }
    }
    jobs = jobs.map((job) => engine.store.get<Job>("jobs", job.id));
    if (
      !wait ||
      !jobs.some(pendingJob) ||
      now() >= deadline ||
      [...errors.values()].some((error) =>
        /APPLE_(400|401|403|404)$/.test(error.code ?? ""),
      )
    )
      return {
        jobs,
        refreshErrors: [...errors].map(([jobId, error]) => ({
          jobId,
          ...error,
        })),
      };
    await (runtime.sleep ?? ((ms) => sleep(ms)))(
      Math.min(runtime.pollIntervalMs ?? 30000, Math.max(0, deadline - now())),
    );
  }
}
export const help = `Local Build Desk — compile and upload from this Mac

  local-build-desk monitor [--start] [--listen PRIVATE_IP] [--port 43178] [--ssl self-signed|custom|off] [--cert PEM --key PEM] [--origin HTTPS_URL] [--pair] [--stop]
  local-build-desk doctor [--project PATH] [--platform ios|android|all]
  local-build-desk inspect --project PATH [--profile production] [--platform ios] [--store]
  local-build-desk signing-info --project PATH
  local-build-desk toolchain --project PATH [--minimum-ios-sdk 27.2] [--xcode PATH] [--ios-sdk VERSION]
    [--xcode-archive PATH] [--accept-xcode-license]
  local-build-desk versions --project PATH [--platform ios|android|all] [--handoff-eas | --resume-local]
  local-build-desk connect-google --project PATH --key SERVICE_ACCOUNT_JSON
  local-build-desk install-tool --project PATH --tool android|ios-platform|node|cocoapods|xcodegen|gcloud [--accept-android-license]
  local-build-desk build --project PATH --platform ios|android|all --profile production [--auto-submit] [--clean]
    [--build-directory PATH] stores snapshots and native caches on another disk
  local-build-desk test --project PATH [--profile production] [--platform ios|android]
  local-build-desk screenshots --project PATH [--profile production]
  local-build-desk test-targets --project PATH
  local-build-desk readiness --project PATH [--destination testflight|appstore]
  local-build-desk resume --job JOB_ID
  local-build-desk store-status --project PATH
  local-build-desk store-releases --project PATH [--refresh]
  local-build-desk store-release --project PATH --release-id ID [--locale en-US] [--refresh]
  local-build-desk use-screenshots --job JOB_ID
  local-build-desk submit --artifact ARTIFACT_ID [--wait] [--timeout 1800]
  local-build-desk status [--job JOB_ID] [--wait] [--timeout 1800]
  local-build-desk logs --job JOB_ID
  local-build-desk cancel --job JOB_ID
  local-build-desk reconcile --job JOB_ID
  local-build-desk listing --project PATH [--listing FILE] [--version X.Y] [--build-number N] [--attest NAME] [--apply] [--submit-for-review]
    shows what the App Store listing would change; --apply writes text, screenshots and the build;
    --submit-for-review also sends the version (and its in-app purchases) to App Review;
    --attest NAME confirms the listing's age rating, App Privacy and pricing answers so they can be applied
  local-build-desk migrate --project PATH [--credentials FILE] [--env FILE] [--ios-last-used N] [--android-last-used N]
  local-build-desk update [--check] [--timeout 1800]
    installs the latest signed release of the app and CLI; --check only reports it

Project selection: --project-type expo|capacitor|native-ios (omit for auto-detection), --app-directory PATH,
--ios-target PATH --scheme NAME --configuration NAME, --web-build-script SCRIPT.

CI: --settings-from PROJECT_ID --source CHECKOUT uses a saved settings template without importing the checkout.
--config FILE (default SOURCE/local-build-desk.json), --set field=value, and LOCAL_BUILD_DESK_* env override stored settings.
The former ios-submit names (ios-submit command, ios-submit.json, IOS_SUBMIT_*) are still accepted.
--credential-config FILE or LOCAL_BUILD_DESK_CREDENTIALS_JSON supplies ephemeral credentials; Keychain is disabled by default.
--build-number N overrides the next local number. --ios-concurrency N / --android-concurrency N configure 1–8 slots each.

Use the desktop Signing and Connections screens to import credentials and assign them to a project.
Build & Upload sends to App Store Connect, or rolls Google Play internal-track uploads out to internal testers
(--play-auto-rollout=false or LOCAL_BUILD_DESK_PLAY_AUTO_ROLLOUT=false keeps drafts). Other tracks get drafts; it does not release to production.
--release-notes TEXT (or LOCAL_BUILD_DESK_PLAY_RELEASE_NOTES) sets Google Play "What's new" text, up to 500 characters.
Build, submit, and status exit 2 while Apple processing is pending, 1 on failure, and 0 on success. Add --wait to build/submit/status to wait for Apple; --timeout is in seconds.
`;
export async function runCLI(
  engine: Engine,
  argv: string[],
  write: (text: string) => void,
  runtime: CLIRuntime = {},
): Promise<number> {
  const secrets = new Redactor();
  const rawWrite = write;
  write = (text) => rawWrite(secrets.redact(text));
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        listen: { type: "string" },
        port: { type: "string" },
        ssl: { type: "string" },
        cert: { type: "string" },
        origin: { type: "string" },
        pair: { type: "boolean" },
        refresh: { type: "boolean" },
        stop: { type: "boolean" },
        start: { type: "boolean" },
        "release-id": { type: "string" },
        locale: { type: "string" },
        destination: { type: "string" },
        project: { type: "string" },
        source: { type: "string" },
        "settings-from": { type: "string" },
        config: { type: "string" },
        "credential-config": { type: "string" },
        "no-keychain": { type: "boolean" },
        "use-keychain": { type: "boolean" },
        set: { type: "string", multiple: true },
        "build-number": { type: "string" },
        "ios-concurrency": { type: "string" },
        "android-concurrency": { type: "string" },
        "java-home": { type: "string" },
        "android-sdk": { type: "string" },
        "android-sdk-license-accepted": { type: "boolean" },
        "node-path": { type: "string" },
        track: { type: "string" },
        "play-auto-rollout": { type: "string" },
        "release-notes": { type: "string" },
        "asc-app-id": { type: "string" },
        "project-type": { type: "string" },
        "app-directory": { type: "string" },
        "ios-target": { type: "string" },
        configuration: { type: "string" },
        "web-build-script": { type: "string" },
        "ios-dependency-manager": { type: "string" },
        "android-module": { type: "string" },
        workspace: { type: "string" },
        scheme: { type: "string" },
        "native-mode": { type: "string" },

        platform: { type: "string" },
        profile: { type: "string" },
        artifact: { type: "string" },
        job: { type: "string" },
        "auto-submit": { type: "boolean" },
        clean: { type: "boolean" },
        "build-directory": { type: "string" },
        "minimum-ios-sdk": { type: "string" },
        "ios-sdk": { type: "string" },
        xcode: { type: "string" },
        "xcode-archive": { type: "string" },
        "accept-xcode-license": { type: "boolean" },
        "accept-android-license": { type: "boolean" },
        tool: { type: "string" },
        key: { type: "string" },
        "handoff-eas": { type: "boolean" },
        "resume-local": { type: "boolean" },
        store: { type: "boolean" },
        credentials: { type: "string" },
        env: { type: "string", multiple: true },
        "ios-last-used": { type: "string" },
        "android-last-used": { type: "string" },
        help: { type: "boolean" },
        check: { type: "boolean" },
        wait: { type: "boolean" },
        timeout: { type: "string" },
        listing: { type: "string" },
        version: { type: "string" },
        apply: { type: "boolean" },
        "submit-for-review": { type: "boolean" },
        attest: { type: "string" },
      },
    });
    const command = parsed.positionals[0],
      v = parsed.values;
    const cwd = runtime.cwd ?? process.cwd();
    for (const key of [
      "source",
      "config",
      "credential-config",
      "build-directory",
      "xcode",
      "xcode-archive",
      "java-home",
      "android-sdk",
      "key",
      "credentials",
      "listing",
      "cert",
    ] as const)
      if (v[key]) v[key] = resolve(cwd, v[key]!);
    for (const key of ["project", "settings-from"] as const)
      if (
        v[key] &&
        !engine.state().projects.some((project) => project.id === v[key])
      )
        v[key] = resolve(cwd, v[key]!);
    const timeoutSeconds = v.timeout === undefined ? 1800 : Number(v.timeout);
    invariant(
      Number.isFinite(timeoutSeconds) &&
        timeoutSeconds > 0 &&
        timeoutSeconds <= 86400,
      "WAIT_TIMEOUT",
      "--timeout must be a positive number of seconds up to 86400.",
    );
    if (!command || v.help || command === "help") {
      write(help);
      return 0;
    }
    const redactValue = (value: any): any =>
      typeof value === "string"
        ? secrets.redact(value)
        : Array.isArray(value)
          ? value.map(redactValue)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                  key,
                  redactValue(item),
                ]),
              )
            : value;
    const output = (value: unknown) =>
      rawWrite(JSON.stringify(redactValue(value), null, 2) + "\n");
    if (command === "update") {
      const updater = runtime.updates?.updater;
      if (!updater || updater.status().state === "disabled") {
        output({
          state: "disabled",
          currentVersion: updater?.status().currentVersion,
          message:
            "Self-update needs the signed Local Build Desk app. In a source checkout, run git pull, npm install, and npm run build.",
        });
        return CLI_EXIT.failure;
      }
      const status = v.check
        ? await updater.check()
        : await updater.prepare(timeoutSeconds * 1000);
      if (status.state !== "ready" || v.check) {
        output({
          ...status,
          message:
            status.state === "current"
              ? `Local Build Desk ${status.currentVersion} is up to date.`
              : status.state === "available"
                ? `Local Build Desk ${status.version} is available. Run local-build-desk update to install it.`
                : status.state === "downloading" || status.state === "ready"
                  ? `Local Build Desk is downloading ${status.version}. Run local-build-desk update to install it.`
                  : `Could not update: ${status.error ?? status.state}`,
        });
        return status.state === "error" ? CLI_EXIT.failure : CLI_EXIT.success;
      }
      const install = runtime.updates!.apply();
      output({
        ...status,
        install,
        message:
          install === "restart"
            ? `Local Build Desk is restarting to install ${status.version}.`
            : install === "exit"
              ? `Local Build Desk ${status.version} installs when this command exits. The CLI and desktop use it from their next launch.`
              : `Local Build Desk ${status.version} is downloaded and installs when the app quits. Builds or setup tasks are still running.`,
      });
      return CLI_EXIT.success;
    }
    if (command === "monitor") {
      invariant(
        runtime.monitor,
        "MONITOR_OWNER",
        "Update Local Build Desk to configure mobile monitoring.",
      );
      if (v.stop)
        output(
          await runtime.monitor.configure({
            ...runtime.monitor.status().config,
            enabled: false,
          }),
        );
      else if (v.start || v.listen || v.port || v.ssl || v.origin || v.cert) {
        const current = runtime.monitor.status().config;
        const next = {
          ...current,
          enabled: true,
          host: v.listen ?? current.host,
          port: v.port === undefined ? current.port : Number(v.port),
          tls: (v.ssl ?? current.tls) as typeof current.tls,
          publicOrigin: v.origin ?? current.publicOrigin,
        };
        invariant(
          !!v.cert === !!v.key,
          "MONITOR_CERT",
          "Pass --key with the PEM private-key file when importing --cert.",
        );
        output(
          await runtime.monitor.configure(
            next,
            v.cert ? { certificatePath: v.cert, keyPath: v.key! } : undefined,
          ),
        );
      } else output(runtime.monitor.status());
      if (v.pair) output(await runtime.monitor.pairing());
      return runtime.monitor.status().error ? 1 : 0;
    }
    let project: Project | undefined;
    let invocation: BuildInvocation | undefined;
    const invocationCommand = [
      "build",
      "test",
      "screenshots",
      "doctor",
      "inspect",
      "submit",
      "status",
      "reconcile",
    ].includes(command);
    const env = runtime.environment ?? process.env;
    const hasInvocation =
      v.project ||
      v.source ||
      v["settings-from"] ||
      v.config ||
      v["credential-config"] ||
      v["no-keychain"] ||
      Object.keys(withCurrentNames(env)).some(isInvocationVariable);
    if (
      invocationCommand &&
      (hasInvocation || command === "build" || command === "doctor")
    ) {
      let fallback: Project | undefined;
      if (v.job)
        fallback = engine.projectFor(engine.store.get<Job>("jobs", v.job));
      if (v.artifact) {
        const artifact = engine.store.get<any>("artifacts", v.artifact);
        fallback = engine.projectFor(
          engine.store.get<Job>("jobs", artifact.jobId),
        );
      }
      invocation = await resolveInvocation(engine, v, env, fallback);
      project = invocation.project;
      secrets.add(...credentialSecrets(invocation.context.credentials));
      if (invocation.concurrency && Object.keys(invocation.concurrency).length)
        engine.configureConcurrency(invocation.concurrency);
      if (v.job && ["status", "reconcile"].includes(command))
        engine.attachInvocation(v.job, invocation);
    } else if (v.project) {
      project =
        engine
          .state()
          .projects.find(
            (p) => p.id === v.project || p.path === resolve(v.project!),
          ) ?? (await engine.importProject(v.project));
    }
    const projectId = () => {
      invariant(
        project,
        "PROJECT_REQUIRED",
        "Pass --project with an Expo, Capacitor, or native iOS folder or imported project ID.",
      );
      return project.id;
    };
    if (command === "test-targets") {
      output(await engine.checkTargets(projectId()));
      return 0;
    }
    if (command === "readiness") {
      invariant(
        !v.destination || ["testflight", "appstore"].includes(v.destination),
        "DESTINATION",
        "Use --destination testflight or appstore.",
      );
      output(
        await engine.readiness(
          projectId(),
          v.destination as "testflight" | "appstore" | undefined,
        ),
      );
      return 0;
    }
    if (command === "store-releases") {
      output(await engine.storeReleases(projectId(), v.refresh));
      return 0;
    }
    if (command === "store-release") {
      invariant(
        v["release-id"],
        "RELEASE_REQUIRED",
        "Pass --release-id from store-releases.",
      );
      output(
        await engine.storeReleaseDetails(
          projectId(),
          v["release-id"],
          v.locale,
          v.refresh,
        ),
      );
      return 0;
    }
    if (command === "store-status") {
      output(await engine.readStoreStatus(projectId()));
      return 0;
    }
    if (command === "use-screenshots") {
      invariant(v.job, "JOB_REQUIRED", "Pass --job.");
      output({ listing: await engine.useScreenshots(v.job) });
      return 0;
    }
    if (command === "connect-google") {
      invariant(
        v.key,
        "GOOGLE_KEY",
        "Pass --key with the existing service-account JSON file.",
      );
      output(await engine.importGoogleConnection(projectId(), resolve(v.key)));
      return 0;
    }
    if (command === "install-tool") {
      invariant(
        [
          "android",
          "ios-platform",
          "node",
          "cocoapods",
          "xcodegen",
          "gcloud",
        ].includes(v.tool ?? ""),
        "TOOL",
        "Choose android, ios-platform, node, cocoapods, xcodegen, or gcloud.",
      );
      await engine.installTool(
        projectId(),
        v.tool as ToolName,
        v["accept-android-license"] === true,
      );
      output({ installed: v.tool, checks: await engine.doctor(projectId()) });
      return 0;
    }
    if (command === "toolchain") {
      projectId();
      const settings = { ...project!.settings };
      for (const [flag, key] of [
        ["minimum-ios-sdk", "minimumIosSdk"],
        ["ios-sdk", "iosSdk"],
      ] as const)
        if (v[flag] !== undefined) {
          invariant(
            /^\d+(?:\.\d+){0,2}$/.test(v[flag]!),
            "SDK_VERSION",
            "Use an iOS SDK version such as 27.2.",
          );
          settings[key] = v[flag];
        }
      if (v.xcode) settings.xcodePath = resolve(v.xcode);
      if (v["build-directory"])
        settings.buildDirectory = resolve(v["build-directory"]);
      engine.saveSettings(projectId(), settings);
      if (v["xcode-archive"])
        output(
          await engine.installXcode(
            projectId(),
            resolve(v["xcode-archive"]),
            v["accept-xcode-license"] === true,
          ),
        );
      else
        output({
          settings,
          installed: await engine.xcodeInstallations(projectId()),
        });
      return 0;
    }
    if (command === "versions") {
      projectId();
      invariant(
        !(v["handoff-eas"] && v["resume-local"]),
        "COUNTER_MODE",
        "Choose one counter transfer direction.",
      );
      invariant(
        ["ios", "android", "all"].includes(v.platform ?? "all"),
        "PLATFORM",
        "Use --platform ios, android, or all.",
      );
      const platforms = (
        v.platform && v.platform !== "all" ? [v.platform] : ["ios", "android"]
      ) as Platform[];
      const results = [];
      for (const platform of platforms) {
        const inspected = await engine.inspect(
          projectId(),
          v.profile ?? "production",
          platform,
        );
        const identity =
          platform === "ios"
            ? inspected.inspection.bundleId
            : inspected.inspection.packageName;
        if (!identity) continue;
        const lastReserved = engine.store.highWater(`${platform}:${identity}`);
        if (v["handoff-eas"] || v["resume-local"]) {
          invariant(
            inspected.inspection.eas.cli?.appVersionSource === "remote",
            "EAS_VERSION_SOURCE",
            "The EAS project must already use remote versioning. Source configuration is preserved; configure EAS deliberately before handing its counter over.",
          );
          results.push(
            await transferVersionCounter(
              engine.store,
              project!,
              platform,
              v.profile ?? "production",
              identity,
              !!inspected.profile?.autoIncrement,
              v["handoff-eas"] ? "handoff" : "resume",
            ),
          );
        } else
          results.push({
            platform,
            identity,
            authority: engine.store.authority(`${platform}:${identity}`),
            lastReserved: lastReserved ?? null,
            lastCommitted:
              engine.store.counter(`${platform}:${identity}`) ?? null,
            nextMinimum: lastReserved !== undefined ? lastReserved + 1 : null,
            message:
              "Local and EAS counters are independent. Use versions --handoff-eas before building through EAS, and --resume-local after EAS builds finish. Normal local builds do not contact EAS.",
          });
      }
      output(results);
      return 0;
    }
    if (command === "signing-info") {
      projectId();
      const signing = await engine.vault.get(
        project!.settings.iosSigningId,
        "ios",
      );
      const profiles = await privateDirectory(async (root) =>
        Promise.all(
          signing.profiles.map(async (encoded) => {
            const profile = await decodeProfile(encoded, root);
            return {
              name: profile.Name,
              uuid: profile.UUID,
              team: profile.TeamIdentifier,
              expires: profile.ExpirationDate,
              entitlements: profile.Entitlements,
            };
          }),
        ),
      );
      let capabilities;
      if (project!.settings.appleConnectionId) {
        const connection = await engine.vault.get(
          project!.settings.appleConnectionId,
          "apple",
        );
        const api = new AppleAPI(connection);
        const bundles = await api.request(
          `/bundleIds?filter[identifier]=${encodeURIComponent(project!.bundleId!)}&limit=200`,
        );
        if (bundles.data[0])
          capabilities = (
            await api.request(
              `/bundleIds/${bundles.data[0].id}/bundleIdCapabilities`,
            )
          ).data.map((item: any) => item.attributes);
      }
      output({ profiles, capabilities });
      return 0;
    }
    if (command === "doctor") {
      const platform = v.platform ?? "all";
      invariant(
        ["ios", "android", "all"].includes(platform),
        "PLATFORM",
        "Use --platform ios, android, or all.",
      );
      const kind = project
        ? await detectProjectType(project.path, project.settings).catch(
            () => project?.type ?? project?.settings.projectType,
          )
        : undefined;
      const pods =
        project?.usesCocoaPods ??
        (kind === undefined ||
          kind === "expo" ||
          (project &&
            (
              await Promise.all(
                (
                  await xcodeContainers(appRoot(project.path, project.settings))
                ).map((c) =>
                  hasFile(
                    join(
                      appRoot(project.path, project.settings),
                      c.path,
                      "..",
                      "Podfile",
                    ),
                  ),
                ),
              )
            ).some(Boolean)));
      const checks = await doctor(
        project?.settings ?? {},
        (kind === "native-ios" && !v.platform ? "ios" : platform) as
          Platform | "all",
        invocation?.context.noKeychain,
        kind,
        !!pods,
        project?.usesXcodeGen ??
          (!!project &&
            kind !== "expo" &&
            (await xcodegenSpecs(appRoot(project.path, project.settings)))
              .length > 0),
      );
      output(checks);
      return checks.some((c) => c.status === "error") ? 1 : 0;
    }
    if (command === "listing") {
      projectId();
      const listingPath =
        v.listing ??
        (project!.settings.appStoreListing
          ? resolve(project!.path, project!.settings.appStoreListing)
          : undefined);
      invariant(
        listingPath,
        "LISTING_REQUIRED",
        "Pass --listing with the App Store listing JSON, or choose it in Local Build Desk's App Store compliance page.",
      );
      if (v.attest) {
        // Attesting records the person's confirmation of exactly these answers.
        const { compliance } = await readListingCompliance(listingPath);
        const attested = await saveListingCompliance(listingPath, compliance, {
          name: v.attest,
          date: new Date().toISOString().slice(0, 10),
        });
        write(
          `${v.attest} attests that these answers are accurate and complete:\n` +
            attested.statements.map((line) => `  • ${line}`).join("\n") +
            "\n",
        );
      }
      invariant(
        project!.settings.appleConnectionId,
        "APPLE_CONNECTION",
        "Connect an App Store Connect API key to this project first.",
      );
      const connection = await engine.vault.get(
        project!.settings.appleConnectionId,
        "apple",
      );
      const api = new AppleAPI(connection);
      let version = v.version;
      let bundleId = project!.bundleId;
      if (!version || !bundleId) {
        const inspection = await inspectProject(
          project!.path,
          project!.settings,
          {},
        );
        version ??= inspection.version;
        bundleId ??= inspection.bundleId;
      }
      invariant(
        bundleId && version,
        "APP_IDENTITY",
        "Couldn't read the bundle ID and version; pass --version.",
      );
      const loaded = await loadListing(listingPath);
      const writing = !!(v.apply || v["submit-for-review"]);
      const app = writing ? await api.app(bundleId) : undefined;
      const journal = writing
        ? new ReleaseJournal(engine.store, {
            projectId: project!.id,
            bundleId,
            version,
            appId: app.id,
            manifestHash: listingFingerprint(
              loaded.listing,
              loaded.screenshots,
            ),
          })
        : undefined;
      if (journal) await journal.reconcile(api);
      const plan = await listingPlan(
        api,
        bundleId,
        version,
        loaded,
        v["build-number"],
        runtime.appleWeb,
      );
      if (!v.apply && !v["submit-for-review"]) {
        output({ dryRun: true, ...plan });
        return plan.blockers.length ? CLI_EXIT.failure : CLI_EXIT.success;
      }
      if (!plan.readOnly)
        await assertScreenshotProvenance(
          engine.store,
          project!,
          loaded,
          v["build-number"] ?? plan.build?.number,
          version,
        );
      const result = await applyListing(journal!.wrap(api), plan, loaded, {
        web: runtime.appleWeb,
        submit: v["submit-for-review"],
        log: (line) => write(line + "\n"),
      });
      journal!.finish(result.submitted);
      // A submitted version is no longer editable, so there's nothing left to check.
      if (result.submitted) {
        output(result);
        return 0;
      }
      const after = await listingPlan(
        api,
        bundleId,
        version,
        loaded,
        v["build-number"],
        runtime.appleWeb,
      );
      output({
        ...result,
        remaining: after.changes,
        blockers: after.blockers,
        manual: after.manual,
      });
      return 0;
    }
    if (command === "inspect") {
      const platform = v.platform ?? "ios";
      invariant(
        ["ios", "android"].includes(platform),
        "PLATFORM",
        "Use --platform ios or android.",
      );
      projectId();
      const vault = invocation
        ? new RunVault(engine.store, engine.vault, invocation.context)
        : engine.vault;
      const env = project!.settings.envCredentialId
        ? (await vault.get(project!.settings.envCredentialId, "environment"))
            .values
        : {};
      let inspection = await inspectProject(
        project!.path,
        project!.settings,
        env,
      );
      const profile = resolveProfile(
        inspection.eas,
        v.profile ?? "production",
        platform as Platform,
      );
      inspection = await inspectProject(
        project!.path,
        {
          ...project!.settings,
          configuration: profile.configuration,
          scheme: project!.settings.scheme ?? profile.scheme,
        },
        {
          ...env,
          ...profile.env,
        },
      );
      const result = { inspection, profile };
      Object.assign(project!, {
        name: inspection.name,
        bundleId: inspection.bundleId,
        packageName: inspection.packageName,
      });
      let storeBuilds;
      if (v.store) {
        const current = project!;
        const connection = await vault.get(
          current.settings.appleConnectionId,
          "apple",
        );
        const api = new AppleAPI(connection);
        const app = await api.app(current.bundleId!);
        const builds = await api.request(
          `/builds?filter[app]=${app.id}&sort=-uploadedDate&include=preReleaseVersion&limit=10`,
        );
        storeBuilds = { builds: builds.data, versions: builds.included };
      }
      output({
        storeBuilds,
        project,
        profiles: result.inspection.profiles,
        native: result.inspection.native,
        issues: [
          ...result.inspection.issues,
          ...(result.profile?.issues ?? []),
        ],
        profile: result.profile
          ? {
              ...result.profile,
              env: Object.fromEntries(
                Object.keys(result.profile.env).map((k) => [k, "[REDACTED]"]),
              ),
              raw: undefined,
            }
          : undefined,
      });
      return 0;
    }
    if (command === "status") {
      const jobs = v.job
        ? [engine.store.get<Job>("jobs", v.job)]
        : engine.state().jobs;
      const refreshed = await refreshProcessing(
        engine,
        jobs,
        v.wait === true,
        timeoutSeconds * 1000,
        runtime,
      );
      const statusRefresh = {
        checkedAt: new Date().toISOString(),
        errors: refreshed.refreshErrors,
        ...(refreshed.jobs.some(pendingJob)
          ? {
              nextAction: `Use status${v.job ? ` --job ${v.job}` : ""} --wait or reconcile --job JOB_ID. Exit code 2 means Apple processing is still pending; do not upload again.`,
            }
          : {}),
      };
      output(
        v.job
          ? { ...refreshed.jobs[0], statusRefresh }
          : { ...engine.state(), credentials: undefined, statusRefresh },
      );
      if (
        refreshed.refreshErrors.some((error) =>
          /APPLE_(400|401|403|404)$/.test(error.code ?? ""),
        )
      )
        return CLI_EXIT.failure;
      return v.job
        ? resultCode(refreshed.jobs)
        : refreshed.jobs.some(pendingJob)
          ? CLI_EXIT.processing
          : CLI_EXIT.success;
    }
    if (command === "logs") {
      invariant(v.job, "JOB_REQUIRED", "Pass --job.");
      for (const entry of engine.logs(v.job))
        write(`${entry.time} [${entry.stage}] ${entry.text}\n`);
      return 0;
    }
    if (command === "cancel") {
      invariant(v.job, "JOB_REQUIRED", "Pass --job.");
      engine.cancel(v.job);
      output({ jobId: v.job, cancellationRequested: true });
      return 0;
    }
    if (command === "reconcile") {
      invariant(v.job, "JOB_REQUIRED", "Pass --job.");
      await engine.reconcile(v.job);
      const job = engine.store.get<Job>("jobs", v.job);
      output(job);
      return resultCode([job]);
    }
    if (command === "migrate") {
      const number = (text?: string) => {
        if (text === undefined) return;
        const n = Number(text);
        invariant(
          Number.isSafeInteger(n) && n >= 0,
          "COUNTER_INVALID",
          "Counters must be nonnegative integers.",
        );
        return n;
      };
      output(
        await engine.migrate(projectId(), {
          credentialsPath: v.credentials,
          environmentPaths: v.env,
          iosBuildNumber: number(v["ios-last-used"]),
          androidBuildNumber: number(v["android-last-used"]),
        }),
      );
      return 0;
    }
    let jobs: Job[];
    if (["build", "test", "screenshots"].includes(command)) {
      const platform = v.platform ?? "all";
      invariant(
        ["ios", "android", "all"].includes(platform),
        "PLATFORM",
        "Use --platform ios, android, or all.",
      );
      jobs = await engine.build(
        {
          projectId: projectId(),
          platform: platform as Platform | "all",
          profile: v.profile ?? "production",
          validationOnly: command !== "build",
          checksMode: command === "screenshots" ? "screenshots" : "all",
          autoSubmit: command === "build" && v["auto-submit"],
          clean: v.clean,
        },
        invocation,
      );
    } else if (command === "resume") {
      invariant(v.job, "JOB_REQUIRED", "Pass --job.");
      jobs = await engine.resume(v.job);
    } else if (command === "submit") {
      invariant(
        v.artifact,
        "ARTIFACT_REQUIRED",
        "Pass --artifact with an artifact ID from status.",
      );
      jobs = [await engine.submit(v.artifact, invocation)];
    } else throw new Error(`Unknown command: ${command}. Use --help.`);
    runtime.onJobs?.(jobs.map((job) => job.id));
    const ids = new Set(jobs.map((j) => j.id));
    const listener = (event: any) => {
      if (event.type === "log" && ids.has(event.jobId))
        write(
          `[${event.jobId.slice(0, 8)} · ${event.entry.stage}] ${event.entry.text}\n`,
        );
    };
    engine.on("event", listener);
    await new Promise<void>((resolve) => {
      const check = () => {
        const current = jobs.map((j) => engine.store.get<Job>("jobs", j.id));
        if (current.every((j) => !["queued", "running"].includes(j.status))) {
          engine.off("event", check);
          resolve();
        }
      };
      engine.on("event", check);
      check();
    });
    engine.off("event", listener);
    const refreshed = await refreshProcessing(
      engine,
      jobs.map((j) => engine.store.get<Job>("jobs", j.id)),
      v.wait === true,
      timeoutSeconds * 1000,
      runtime,
    );
    if (refreshed.jobs.some(pendingProcessing))
      write(
        "Apple processing is pending (exit 2). Use --wait, status --wait, or reconcile; do not upload again.\n",
      );
    if (refreshed.refreshErrors.length)
      write(
        `Store refresh could not finish: ${refreshed.refreshErrors.map((error) => error.message).join("; ")}\n`,
      );
    output(refreshed.jobs);
    if (
      refreshed.refreshErrors.some((error) =>
        /APPLE_(400|401|403|404)$/.test(error.code ?? ""),
      )
    )
      return CLI_EXIT.failure;
    return resultCode(refreshed.jobs);
  } catch (error) {
    write(`Error: ${messageOf(error)}\n`);
    return 1;
  }
}
