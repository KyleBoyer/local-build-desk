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
import { setTimeout as sleep } from "node:timers/promises";
import { transferVersionCounter } from "../core/versions";
export const CLI_EXIT = { success: 0, failure: 1, processing: 2 } as const;
export interface CLIRuntime {
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  onJobs?: (ids: string[]) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
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

  ios-submit doctor [--project PATH] [--platform ios|android|all]
  ios-submit inspect --project PATH [--profile production] [--platform ios] [--store]
  ios-submit signing-info --project PATH
  ios-submit toolchain --project PATH [--minimum-ios-sdk 27.2] [--xcode PATH] [--ios-sdk VERSION]
    [--xcode-archive PATH] [--accept-xcode-license]
  ios-submit versions --project PATH [--platform ios|android|all] [--handoff-eas | --resume-local]
  ios-submit connect-google --project PATH --key SERVICE_ACCOUNT_JSON
  ios-submit install-tool --project PATH --tool android|ios-platform|node|cocoapods|xcodegen|gcloud [--accept-android-license]
  ios-submit build --project PATH --platform ios|android|all --profile production [--auto-submit] [--clean]
    [--build-directory PATH] stores snapshots and native caches on another disk
  ios-submit submit --artifact ARTIFACT_ID [--wait] [--timeout 1800]
  ios-submit status [--job JOB_ID] [--wait] [--timeout 1800]
  ios-submit logs --job JOB_ID
  ios-submit cancel --job JOB_ID
  ios-submit reconcile --job JOB_ID
  ios-submit listing --project PATH --listing FILE [--version X.Y] [--build-number N] [--apply] [--submit-for-review]
    shows what the App Store listing would change; --apply writes text, screenshots and the build;
    --submit-for-review also sends the version (and its in-app purchases) to App Review
  ios-submit migrate --project PATH [--credentials FILE] [--env FILE] [--ios-last-used N] [--android-last-used N]

Project selection: --project-type expo|capacitor|native-ios (omit for auto-detection), --app-directory PATH,
--ios-target PATH --scheme NAME --configuration NAME, --web-build-script SCRIPT.

CI: --settings-from PROJECT_ID --source CHECKOUT uses a saved settings template without importing the checkout.
--config FILE (default SOURCE/ios-submit.json), --set field=value, and IOS_SUBMIT_* env override stored settings.
--credential-config FILE or IOS_SUBMIT_CREDENTIALS_JSON supplies ephemeral credentials; Keychain is disabled by default.
--build-number N overrides the next local number. --ios-concurrency N / --android-concurrency N configure 1–8 slots each.

Use the desktop Signing and Connections screens to import credentials and assign them to a project.
Build & Upload sends to App Store Connect, or rolls Google Play internal-track uploads out to internal testers
(--play-auto-rollout=false or IOS_SUBMIT_PLAY_AUTO_ROLLOUT=false keeps drafts). Other tracks get drafts; it does not release to production.
--release-notes TEXT (or IOS_SUBMIT_PLAY_RELEASE_NOTES) sets Google Play "What's new" text, up to 500 characters.
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
        wait: { type: "boolean" },
        timeout: { type: "string" },
        listing: { type: "string" },
        version: { type: "string" },
        apply: { type: "boolean" },
        "submit-for-review": { type: "boolean" },
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
    let project: Project | undefined;
    let invocation: BuildInvocation | undefined;
    const invocationCommand = [
      "build",
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
      Object.keys(env).some((key) => key.startsWith("IOS_SUBMIT_"));
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
      invariant(
        v.listing,
        "LISTING_REQUIRED",
        "Pass --listing with the App Store listing JSON.",
      );
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
      const loaded = await loadListing(v.listing);
      const plan = await listingPlan(
        api,
        bundleId,
        version,
        loaded,
        v["build-number"],
      );
      if (!v.apply && !v["submit-for-review"]) {
        output({ dryRun: true, ...plan });
        return plan.blockers.length ? CLI_EXIT.failure : CLI_EXIT.success;
      }
      const result = await applyListing(api, plan, loaded, {
        submit: v["submit-for-review"],
        log: (line) => write(line + "\n"),
      });
      const after = await listingPlan(
        api,
        bundleId,
        version,
        loaded,
        v["build-number"],
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
    if (command === "build") {
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
          autoSubmit: v["auto-submit"],
          clean: v.clean,
        },
        invocation,
      );
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
