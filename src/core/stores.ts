import { withLock } from "./locks";
import { importPKCS8, SignJWT } from "jose";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Credential, Submission, Artifact } from "./types";
import { DeskError, invariant } from "./errors";
import { run, type CommandOptions } from "./process";
import { secretFile } from "./vault";
import { setTimeout as delay } from "node:timers/promises";
import type { ProgressUpdate } from "./types";
import { uploadStream } from "./transfer";
export type AppleCredential = Extract<Credential, { kind: "apple" }>;
export type GoogleCredential = Extract<Credential, { kind: "google" }>;
export interface AppleRequestEvent {
  method: string;
  path: string;
  status?: number;
  durationMs: number;
  attempt?: number;
  retryInMs?: number;
}
export interface AppleRequestOptions {
  signal?: AbortSignal;
  maxReadAttempts?: number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}
/**
 * One Apple API error, with the "associated errors" Apple nests under `meta`
 * (for example, why an item can't be submitted for review).
 */
function appleErrorText(error: any): string {
  const text = error.detail ?? error.title ?? error.code;
  const associated = Object.values(error.meta?.associatedErrors ?? {})
    .flat()
    .map((e: any) => e.detail ?? e.title ?? e.code)
    .filter(Boolean);
  return associated.length ? `${text} (${associated.join("; ")})` : text;
}

export class AppleAPI {
  constructor(
    private credential: AppleCredential,
    private fetcher: typeof fetch = fetch,
    private observe?: (event: AppleRequestEvent) => void,
    private options: AppleRequestOptions = {},
  ) {}
  async token() {
    const key = await importPKCS8(this.credential.privateKey, "ES256");
    return new SignJWT({})
      .setProtectedHeader({
        alg: "ES256",
        kid: this.credential.keyId,
        typ: "JWT",
      })
      .setIssuer(this.credential.issuerId)
      .setAudience("appstoreconnect-v1")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(key);
  }
  async request(path: string, method = "GET", body?: unknown): Promise<any> {
    invariant(
      path.startsWith("/") && !path.startsWith("//"),
      "API_PATH",
      "Invalid Apple API path.",
    );
    const token = await this.token();
    const maxAttempts = ["GET", "HEAD"].includes(method.toUpperCase())
      ? (this.options.maxReadAttempts ?? 4)
      : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.options.signal?.throwIfAborted();
      const started = Date.now();
      let response: Response | undefined;
      let networkError: unknown;
      try {
        response = await this.fetcher(
          // Most resources are v1; a few (in-app purchases) live under /v2/.
          `https://api.appstoreconnect.apple.com${path.startsWith("/v2/") ? "" : "/v1"}${path}`,
          {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: this.options.signal
              ? AbortSignal.any([
                  this.options.signal,
                  AbortSignal.timeout(45000),
                ])
              : AbortSignal.timeout(45000),
          },
        );
      } catch (error) {
        networkError = error;
      }
      this.options.signal?.throwIfAborted();
      const transientNetwork =
        networkError instanceof TypeError ||
        (networkError as any)?.name === "TimeoutError" ||
        /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)$/.test(
          (networkError as any)?.code ?? "",
        );
      const retry =
        attempt < maxAttempts &&
        (transientNetwork ||
          (!!response &&
            [408, 429, 500, 502, 503, 504].includes(response.status)));
      const retryAfter = response?.headers.get("retry-after");
      const serverDelay = retryAfter
        ? /^\d+(?:\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Math.max(0, Date.parse(retryAfter) - Date.now())
        : 0;
      const retryInMs = retry
        ? Math.min(
            30000,
            Math.max(
              500 * 2 ** (attempt - 1) +
                Math.floor((this.options.random ?? Math.random)() * 250),
              Number.isFinite(serverDelay) ? serverDelay : 0,
            ),
          )
        : undefined;
      // Metadata only: API bodies, query values and authentication headers must
      // never enter setup logs, including when the request fails.
      this.observe?.({
        method,
        path: path.split("?")[0],
        status: response?.status,
        durationMs: Date.now() - started,
        ...(attempt > 1 || retry ? { attempt } : {}),
        ...(retryInMs !== undefined ? { retryInMs } : {}),
      });
      if (retryInMs !== undefined) {
        await response?.body?.cancel();
        if (this.options.wait)
          await this.options.wait(retryInMs, this.options.signal);
        else await delay(retryInMs, undefined, { signal: this.options.signal });
        continue;
      }
      if (networkError) throw networkError;
      invariant(response, "APPLE_RESPONSE", "Apple did not return a response.");
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new DeskError(
          `APPLE_${response.status}`,
          `Apple ${response.status} (${method} ${path.split("?")[0]}): ${data.errors?.map(appleErrorText).join("; ") ?? response.statusText}`,
        );
      }
      if (response.status === 204) return {};
      return response.json();
    }
    throw new DeskError("APPLE_RETRIES", "Apple request retry limit reached.");
  }
  async apps(bundleId?: string) {
    return (
      await this.request(
        `/apps?limit=200${bundleId ? `&filter[bundleId]=${encodeURIComponent(bundleId)}` : ""}`,
      )
    ).data;
  }
  async validate() {
    const apps = await this.apps();
    await this.request("/certificates?limit=1");
    return `Connected. ${apps.length} app(s) accessible; provisioning endpoints available.`;
  }
  async app(bundleId: string) {
    const apps = await this.apps(bundleId);
    invariant(
      apps.length === 1,
      "APPLE_APP_MISSING",
      `Create the App Store Connect record for ${bundleId}, or grant this key access to it.`,
    );
    return apps[0];
  }
  async latestBuild(bundleId: string): Promise<number | undefined> {
    const app = await this.app(bundleId);
    const result = await this.request(
      `/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=200`,
    );
    const versions = result.data
      .map((x: any) => Number(x.attributes.version))
      .filter(Number.isSafeInteger);
    return versions.length ? Math.max(...versions) : undefined;
  }
  async build(bundleId: string, number: string, version?: string) {
    const app = await this.app(bundleId);
    const result = await this.request(
      `/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(number)}&include=preReleaseVersion&limit=200`,
    );
    const releases = new Map(
      (result.included ?? [])
        .filter((r: any) => r.type === "preReleaseVersions")
        .map((r: any) => [r.id, r.attributes.version]),
    );
    return result.data.filter(
      (build: any) =>
        !version ||
        releases.get(build.relationships?.preReleaseVersion?.data?.id) ===
          version,
    );
  }
  async profile(
    bundleId: string,
    name: string,
    type: string,
    certificateId: string,
  ) {
    const bundles = (
      await this.request(
        `/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&limit=200`,
      )
    ).data;
    invariant(
      bundles.length === 1,
      "BUNDLE_ID_MISSING",
      `Register ${bundleId} and its required capabilities in Apple Developer first.`,
    );
    const relationships: any = {
      bundleId: { data: { type: "bundleIds", id: bundles[0].id } },
      certificates: { data: [{ type: "certificates", id: certificateId }] },
    };
    if (type !== "IOS_APP_STORE") {
      const devices = (
        await this.request("/devices?filter[platform]=IOS&limit=200")
      ).data.filter((d: any) => d.attributes.status === "ENABLED");
      invariant(
        devices.length,
        "NO_DEVICES",
        "Register at least one device before creating a development or ad hoc profile.",
      );
      relationships.devices = {
        data: devices.map((d: any) => ({ type: "devices", id: d.id })),
      };
    }
    return (
      await this.request("/profiles", "POST", {
        data: {
          type: "profiles",
          attributes: { name, profileType: type },
          relationships,
        },
      })
    ).data;
  }
}
export interface GoogleUploadOptions {
  /** Commit a completed release instead of a draft. Internal track only. */
  rollout?: boolean;
  /** Whether ios-submit uploaded this version code for the same app. */
  uploadedByDesk?: (versionCode: string) => boolean;
  /** "What's new" text for the new release, per language. */
  releaseNotes?: { language: string; text: string }[];
  log?: (line: string) => void;
}
export interface GoogleReconcileOptions {
  rollout?: boolean;
  supersededVersionCodes?: string[];
}
/** Auto rollout applies only to the internal track and is on unless disabled. */
export function googleRollout(
  settings: { playAutoRollout?: boolean },
  track: string,
) {
  return settings.playAutoRollout !== false && track === "internal";
}
const DRAFT_APP =
  /only releases with status draft may be created on draft app/i;
const SEND_FOR_REVIEW =
  /changesNotSentForReview (?:to|must be set to) true|cannot be sent for review automatically/i;
const DRAFT_APP_MESSAGE =
  "This app has no published release yet, so Google only allows drafts. Publish the first release in Play Console; later uploads will roll out automatically.";
const REVIEW_MESSAGE =
  "The internal release was committed, but Google requires these changes to be sent for review. Open Publishing overview in Play Console and choose Send for review; testers receive the build after that.";
export class GoogleAPI {
  private withEdit<T>(operation: () => Promise<T>) {
    return withLock(
      `google-edit:${this.credential.serviceAccount.client_email}`,
      this.signal,
      async () => {
        this.beforeEdit?.();
        return operation();
      },
    );
  }
  private accessToken?: { token: string; expires: number };
  constructor(
    private credential: GoogleCredential,
    private fetcher: typeof fetch = fetch,
    private signal?: AbortSignal,
    private beforeEdit?: () => void,
  ) {}
  async token() {
    if (this.accessToken && this.accessToken.expires > Date.now() + 60000)
      return this.accessToken.token;
    const account = this.credential.serviceAccount;
    const assertion = await new SignJWT({
      scope: "https://www.googleapis.com/auth/androidpublisher",
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(account.client_email)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(await importPKCS8(account.private_key, "RS256"));
    const response = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(45000),
    });
    const data: any = await response.json();
    invariant(
      response.ok && data.access_token,
      "GOOGLE_AUTH",
      `Google authentication failed: ${data.error_description ?? data.error ?? response.status}`,
    );
    this.accessToken = {
      token: data.access_token,
      expires: Date.now() + Number(data.expires_in) * 1000,
    };
    return data.access_token as string;
  }
  async request(path: string, method = "GET", body?: unknown): Promise<any> {
    const response = await this.fetcher(
      `https://androidpublisher.googleapis.com/androidpublisher/v3${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(60000)])
          : AbortSignal.timeout(60000),
      },
    );
    const data: any = await response.json().catch(() => ({}));
    invariant(
      response.ok,
      `GOOGLE_${response.status}`,
      `Google Play ${response.status}: ${data.error?.message ?? response.statusText}`,
    );
    return data;
  }
  async edit(packageName: string) {
    return this.request(
      `/applications/${encodeURIComponent(packageName)}/edits`,
      "POST",
      {},
    );
  }
  async validate(packageName?: string) {
    return this.withEdit(() => this.validateInEdit(packageName));
  }
  private async validateInEdit(packageName?: string) {
    await this.token();
    if (packageName) {
      const edit = await this.edit(packageName);
      await this.request(
        `/applications/${packageName}/edits/${edit.id}`,
        "DELETE",
      );
    }
    return (
      "Service account authenticated" +
      (packageName
        ? `; access to ${packageName} verified.`
        : ". Select a project to verify app permissions.")
    );
  }
  async verifySavedBundle(artifact: Artifact, track: string) {
    return this.withEdit(async () => {
      const edit = await this.edit(artifact.bundleId);
      const base = `/applications/${encodeURIComponent(artifact.bundleId)}/edits/${edit.id}`;
      try {
        const bundles = await this.request(base + "/bundles");
        const release = await this.request(
          base + "/tracks/" + encodeURIComponent(track),
        );
        const bundle = bundles.bundles?.find(
          (item: any) => String(item.versionCode) === artifact.buildNumber,
        );
        invariant(
          bundle?.sha256?.toLowerCase() === artifact.sha256.toLowerCase(),
          "GOOGLE_BOOTSTRAP_CHECKSUM",
          "Google has not confirmed this exact AAB checksum. No second upload was attempted.",
        );
        invariant(
          release.releases?.some(
            (item: any) =>
              item.status === "draft" &&
              item.versionCodes?.map(String).includes(artifact.buildNumber),
          ),
          "GOOGLE_BOOTSTRAP_DRAFT",
          "This version is not yet saved as an internal draft. Return to the console and save it without rollout.",
        );
      } finally {
        await this.request(base, "DELETE").catch(() => {});
      }
    });
  }
  async versions(packageName: string) {
    return this.withEdit(() => this.versionsInEdit(packageName));
  }
  /** A disposable, uncommitted read view. Serialized with uploads using this
   * service account; beforeEdit prevents replacing an unresolved local edit. */
  async releaseSnapshot(
    packageName: string,
    includeImages = false,
    preferredLocale?: string,
  ) {
    return this.withEdit(async () => {
      const edit = await this.edit(packageName);
      const base = `/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(edit.id)}`;
      const notes: string[] = [];
      try {
        const tracks = await this.request(`${base}/tracks`);
        const listings = await this.request(`${base}/listings`).catch(
          (error) => {
            notes.push(
              `Listing text could not be read: ${(error as Error).message}`,
            );
            return { listings: [] };
          },
        );
        const locales: string[] = (listings.listings ?? []).map(
          (l: any) => l.language,
        );
        const locale =
          preferredLocale && locales.includes(preferredLocale)
            ? preferredLocale
            : (locales.find((l) => l === "en-US") ?? locales[0]);
        const images: {
          name: string;
          locale: string;
          displayType: string;
          url?: string;
          origin: "store";
        }[] = [];
        if (includeImages && locale) {
          const types = [
            "icon",
            "featureGraphic",
            "phoneScreenshots",
            "sevenInchScreenshots",
            "tenInchScreenshots",
          ];
          const results = await Promise.allSettled(
            types.map((type) =>
              this.request(
                `${base}/listings/${encodeURIComponent(locale)}/${type}`,
              ),
            ),
          );
          for (const [i, result] of results.entries()) {
            if (result.status === "rejected") {
              notes.push(
                `${types[i]} could not be read: ${String(result.reason?.message ?? result.reason)}`,
              );
              continue;
            }
            for (const [index, image] of (result.value.images ?? []).entries())
              images.push({
                name: `${types[i]} ${index + 1}`,
                locale,
                displayType: types[i]!,
                url: image.url,
                origin: "store",
              });
          }
        }
        return {
          tracks: tracks.tracks ?? [],
          listings: listings.listings ?? [],
          images,
          locale,
          notes,
        };
      } finally {
        await this.request(base, "DELETE").catch(() => {});
      }
    });
  }
  /** Version codes for a build's floor; a package Play has never seen has none. */
  async existingVersions(packageName: string) {
    try {
      return await this.versions(packageName);
    } catch (error) {
      if (
        /Google Play 404\b.*Package not found/i.test(
          String((error as Error)?.message),
        )
      )
        return [];
      throw error;
    }
  }
  private async versionsInEdit(packageName: string) {
    const edit = await this.edit(packageName);
    const path = `/applications/${packageName}/edits/${edit.id}`;
    try {
      const [tracks, bundles] = await Promise.all([
        this.request(`${path}/tracks`),
        this.request(`${path}/bundles`),
      ]);
      return [
        ...(bundles.bundles ?? []).map((b: any) => Number(b.versionCode)),
        ...(tracks.tracks ?? []).flatMap((t: any) =>
          (t.releases ?? []).flatMap((r: any) =>
            (r.versionCodes ?? []).map(Number),
          ),
        ),
      ].filter(Number.isSafeInteger);
    } finally {
      await this.request(path, "DELETE").catch(() => {});
    }
  }
  async upload(
    artifact: Artifact,
    track: string,
    onEdit: (
      id: string,
      baselineReleases?: unknown[],
      supersededVersionCodes?: string[],
    ) => void,
    signal?: AbortSignal,
    progress?: (update: ProgressUpdate) => void,
    options: GoogleUploadOptions = {},
  ): Promise<Submission> {
    return this.withEdit(() =>
      this.uploadInEdit(artifact, track, onEdit, signal, progress, options),
    );
  }
  private async uploadInEdit(
    artifact: Artifact,
    track: string,
    onEdit: (
      id: string,
      baselineReleases?: unknown[],
      supersededVersionCodes?: string[],
    ) => void,
    signal?: AbortSignal,
    progress?: (update: ProgressUpdate) => void,
    options: GoogleUploadOptions = {},
  ): Promise<Submission> {
    const rollout = options.rollout === true && track === "internal";
    const edit = await this.edit(artifact.bundleId);
    onEdit(edit.id);
    const base = `/applications/${artifact.bundleId}/edits/${edit.id}`;
    const trackPath = `${base}/tracks/${encodeURIComponent(track)}`;
    const current = await this.request(trackPath);
    const existing = current.releases ?? [];
    const otherDrafts = existing.filter(
      (release: any) =>
        release.status === "draft" &&
        !release.versionCodes?.map(String).includes(artifact.buildNumber),
    );
    // A rollout supersedes only drafts ios-submit itself uploaded for older
    // version codes. A draft a person made in Play Console is never discarded.
    const stale = (release: any) => {
      const codes: string[] = (release.versionCodes ?? []).map(String);
      return (
        codes.length > 0 &&
        codes.every(
          (code) =>
            Number(code) < Number(artifact.buildNumber) &&
            options.uploadedByDesk?.(code) === true,
        )
      );
    };
    const superseded =
      rollout && otherDrafts.every(stale)
        ? otherDrafts.flatMap((release: any) =>
            release.versionCodes.map(String),
          )
        : [];
    onEdit(edit.id, existing, superseded.length ? superseded : undefined);
    if (otherDrafts.length && !superseded.length) {
      await this.request(base, "DELETE").catch(() => {});
      invariant(
        false,
        "GOOGLE_DRAFT_EXISTS",
        `Google Play already has another draft on ${track}. Resolve that draft in Play Console or choose a different track before uploading. Existing releases were preserved.`,
      );
    }
    if (superseded.length)
      options.log?.(
        `Superseding earlier ios-submit draft${superseded.length > 1 ? "s" : ""} ${superseded.join(", ")} on ${track} with this release.`,
      );
    const total = (await stat(artifact.path)).size;
    invariant(
      artifact.size === undefined || artifact.size === total,
      "ARTIFACT_SIZE",
      "The artifact size changed before upload.",
    );
    const transfer = uploadStream(
      artifact.path,
      total,
      (completedBytes) => {
        progress?.({
          kind: "upload",
          label:
            completedBytes === total
              ? "Waiting for Google to confirm the bundle"
              : "Uploading AAB to Google Play",
          completedBytes,
          totalBytes: total,
          detail:
            completedBytes === total
              ? "All bytes have been sent from this Mac. Google may take a few minutes to validate the bundle."
              : "Google confirms acceptance after the transfer finishes.",
        });
      },
      signal,
    );
    let response: Response;
    try {
      response = await this.fetcher(
        `https://androidpublisher.googleapis.com/upload/androidpublisher/v3${base}/bundles?uploadType=media`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await this.token()}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(total),
          },
          body: transfer.body,
          duplex: "half",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)])
            : AbortSignal.timeout(30 * 60 * 1000),
        } as RequestInit,
      );
    } finally {
      transfer.dispose();
    }
    const bundle: any = await response.json().catch(() => ({}));
    invariant(
      response.ok,
      "GOOGLE_UPLOAD",
      `Google Play upload failed: ${bundle.error?.message ?? response.status}`,
    );
    invariant(
      String(bundle.versionCode) === artifact.buildNumber,
      "GOOGLE_VERSION",
      "Google returned a different version code.",
    );
    if (bundle.sha256)
      invariant(
        bundle.sha256.toLowerCase() === artifact.sha256.toLowerCase(),
        "GOOGLE_CHECKSUM",
        "Google returned a different artifact checksum.",
      );
    const release = (status: "draft" | "completed") => ({
      name: `${artifact.version} (${artifact.buildNumber})`,
      versionCodes: [artifact.buildNumber],
      status,
      ...(options.releaseNotes?.length
        ? { releaseNotes: options.releaseNotes }
        : {}),
    });
    const putDraft = () =>
      this.request(trackPath, "PUT", {
        track,
        releases: [
          ...existing.filter((item: any) => item.status !== "draft"),
          release("draft"),
        ],
      });
    if (rollout) {
      let draftApp = false;
      try {
        // The completed release replaces the previous internal release.
        await this.request(trackPath, "PUT", {
          track,
          releases: [release("completed")],
        });
      } catch (error) {
        if (
          !(error instanceof DeskError) ||
          error.code !== "GOOGLE_400" ||
          !DRAFT_APP.test(error.message)
        )
          throw error;
        // The staged bundle is still in this edit; stage it as a draft.
        draftApp = true;
        options.log?.(DRAFT_APP_MESSAGE);
        await putDraft();
      }
      if (!draftApp) {
        progress?.({
          kind: "work",
          label: "Validating the internal release",
          detail:
            "The binary was accepted. Google is checking the release; this can take a few minutes.",
        });
        await this.request(`${base}:validate`, "POST", {});
        progress?.({
          kind: "work",
          label: "Rolling out to internal testers",
          detail: "Waiting for Google Play to confirm the commit.",
        });
        if ((await this.commitRollout(base)) === "review")
          return {
            state: "draft",
            destination: `Google Play · ${track} · waiting for review`,
            externalId: edit.id,
            uploadedAt: new Date().toISOString(),
            message: REVIEW_MESSAGE,
          };
        return {
          state: "accepted",
          destination: `Google Play · ${track} · rolled out`,
          externalId: edit.id,
          uploadedAt: new Date().toISOString(),
          message: await this.rolloutMessage(artifact, track),
        };
      }
      progress?.({
        kind: "work",
        label: "Saving the internal draft",
        detail: "Google only accepts drafts until the app is published.",
      });
      await this.request(`${base}:validate`, "POST", {});
      await this.commitDraft(base);
      return {
        state: "draft",
        destination: `Google Play · ${track} · draft`,
        externalId: edit.id,
        uploadedAt: new Date().toISOString(),
        message: DRAFT_APP_MESSAGE,
      };
    }
    await putDraft();
    progress?.({
      kind: "work",
      label: "Validating the Google Play draft",
      detail:
        "The binary was accepted. Google is checking the draft; this can take a few minutes.",
    });
    await this.request(`${base}:validate`, "POST", {});
    progress?.({
      kind: "work",
      label: "Saving the internal draft",
      detail:
        "Waiting for Google Play to confirm the draft commit. Existing releases are preserved.",
    });
    await this.commitDraft(base);
    return {
      state: "draft",
      destination: `Google Play · ${track} · draft`,
      externalId: edit.id,
      uploadedAt: new Date().toISOString(),
      message:
        "Draft committed. Complete review and rollout in Google Play Console.",
    };
  }
  private async commitDraft(base: string) {
    try {
      await this.request(
        `${base}:commit?changesNotSentForReview=true`,
        "POST",
        {},
      );
    } catch (error) {
      if (
        !(error instanceof DeskError) ||
        error.code !== "GOOGLE_400" ||
        !/changesNotSentForReview must not be set/i.test(error.message)
      )
        throw error;
      // This explicit 400 confirms the edit was not committed. Some Play
      // accounts require the default commit mode, even for an inert draft.
      await this.request(`${base}:commit`, "POST", {});
    }
  }
  private async commitRollout(base: string): Promise<"published" | "review"> {
    try {
      await this.request(`${base}:commit`, "POST", {});
      return "published";
    } catch (error) {
      if (
        !(error instanceof DeskError) ||
        error.code !== "GOOGLE_400" ||
        !SEND_FOR_REVIEW.test(error.message)
      )
        throw error;
      // This explicit 400 confirms the edit was not committed. These accounts
      // must send changes for review from Play Console.
      await this.request(
        `${base}:commit?changesNotSentForReview=true`,
        "POST",
        {},
      );
      return "review";
    }
  }
  // Managed publishing can hold a committed release until "Publish changes",
  // and the edits API does not expose that setting. Re-reading the track is
  // the best available confirmation.
  private async rolloutMessage(artifact: Artifact, track: string) {
    const managed =
      " If managed publishing is on for this app, choose Publish changes in Play Console.";
    try {
      const edit = await this.edit(artifact.bundleId);
      const base = `/applications/${artifact.bundleId}/edits/${edit.id}`;
      try {
        const live = await this.request(
          `${base}/tracks/${encodeURIComponent(track)}`,
        );
        const release = live.releases?.find((item: any) =>
          item.versionCodes?.map(String).includes(artifact.buildNumber),
        );
        return release?.status === "completed"
          ? `Rolled out to ${track} testers.${managed}`
          : `Committed for ${track} testers; Google does not list it as completed yet.${managed}`;
      } finally {
        await this.request(base, "DELETE").catch(() => {});
      }
    } catch {
      return `Rolled out to ${track} testers.${managed}`;
    }
  }
  async reconcile(
    artifact: Artifact,
    track: string,
    originalEditId?: string,
    baselineReleases?: unknown[],
    options: GoogleReconcileOptions = {},
  ): Promise<Submission> {
    return this.withEdit(() =>
      this.reconcileInEdit(
        artifact,
        track,
        originalEditId,
        baselineReleases,
        options,
      ),
    );
  }
  private async reconcileInEdit(
    artifact: Artifact,
    track: string,
    originalEditId?: string,
    baselineReleases?: unknown[],
    options: GoogleReconcileOptions = {},
  ): Promise<Submission> {
    // Google permits one open edit per account/app. Inspect the existing edit
    // BEFORE creating a read edit, which would invalidate the staged binary.
    if (originalEditId) {
      const original = `/applications/${artifact.bundleId}/edits/${encodeURIComponent(originalEditId)}`;
      let staged: { bundles: any; track: any } | undefined;
      try {
        staged = {
          bundles: await this.request(`${original}/bundles`),
          track: await this.request(
            `${original}/tracks/${encodeURIComponent(track)}`,
          ),
        };
      } catch (error) {
        if (
          !(error instanceof DeskError) ||
          !/^GOOGLE_(400|404)$/.test(error.code) ||
          !/deleted|expired|not found|invalid/i.test(error.message)
        )
          throw error;
      }
      if (staged) {
        const bundle = staged.bundles.bundles?.find(
          (item: any) => String(item.versionCode) === artifact.buildNumber,
        );
        if (!bundle) {
          await this.request(original, "DELETE");
          return {
            state: "rejected",
            destination: `Google Play · ${track}`,
            message:
              "The original edit contains no copy of this AAB. It is safe to upload this existing artifact again without rebuilding.",
          };
        }
        invariant(
          bundle.sha256?.toLowerCase() === artifact.sha256.toLowerCase(),
          "GOOGLE_EDIT_CHECKSUM",
          "The original edit does not contain this exact AAB. No commit or second upload was attempted.",
        );
        const rollout = options.rollout === true && track === "internal";
        const draft = staged.track.releases?.find(
          (item: any) =>
            (item.status === "draft" ||
              (rollout && item.status === "completed")) &&
            item.versionCodes?.map(String).includes(artifact.buildNumber),
        );
        invariant(
          draft,
          "GOOGLE_EDIT_DRAFT",
          "The original edit does not contain the intended draft. Review it before retrying.",
        );
        invariant(
          baselineReleases,
          "GOOGLE_EDIT_BASELINE",
          "This older upload has no saved track snapshot. Its staged AAB was preserved; review the edit before committing.",
        );
        const canonical = (value: any): any =>
          Array.isArray(value)
            ? value.map(canonical)
            : value && typeof value === "object"
              ? Object.fromEntries(
                  Object.keys(value)
                    .sort()
                    .map((key) => [key, canonical(value[key])]),
                )
              : value;
        // A rollout drops superseded ios-submit drafts; a completed release
        // also replaces every other release on the internal track.
        const superseded = new Set(options.supersededVersionCodes ?? []);
        const isOwn = (item: any) =>
          item.versionCodes?.map(String).includes(artifact.buildNumber);
        invariant(
          !rollout ||
            baselineReleases.every(
              (item: any) =>
                item.status !== "draft" ||
                isOwn(item) ||
                item.versionCodes?.every((code: unknown) =>
                  superseded.has(String(code)),
                ),
            ),
          "GOOGLE_TRACK_CHANGED",
          "The staged edit removes a draft ios-submit did not supersede. No commit or second upload was attempted.",
        );
        const expected = !rollout
          ? baselineReleases
          : draft.status === "completed"
            ? []
            : baselineReleases.filter((item: any) => item.status !== "draft");
        invariant(
          JSON.stringify(
            canonical(
              staged.track.releases.filter((item: any) => item !== draft),
            ),
          ) === JSON.stringify(canonical(expected)),
          "GOOGLE_TRACK_CHANGED",
          "The staged edit changes existing releases. No commit or second upload was attempted.",
        );
        await this.request(`${original}:validate`, "POST", {});
        if (draft.status === "completed") {
          if ((await this.commitRollout(original)) === "review")
            return {
              state: "draft",
              destination: `Google Play · ${track} · waiting for review`,
              externalId: originalEditId,
              message: REVIEW_MESSAGE,
            };
          return {
            state: "accepted",
            destination: `Google Play · ${track} · rolled out`,
            externalId: originalEditId,
            message:
              "Recovered the exact staged AAB and rolled it out. No binary was uploaded again. " +
              (await this.rolloutMessage(artifact, track)),
          };
        }
        await this.commitDraft(original);
        return {
          state: "draft",
          destination: `Google Play · ${track} · draft`,
          externalId: originalEditId,
          message:
            "Recovered the exact staged AAB as a draft. No binary was uploaded again.",
        };
      }
    }
    const edit = await this.edit(artifact.bundleId);
    const base = `/applications/${artifact.bundleId}/edits/${edit.id}`;
    try {
      const result = await this.request(
        `${base}/tracks/${encodeURIComponent(track)}`,
      );
      const release = result.releases?.find((item: any) =>
        item.versionCodes?.map(String).includes(artifact.buildNumber),
      );
      if (release)
        return {
          state: release.status === "draft" ? "draft" : "accepted",
          destination: `Google Play · ${track}`,
          message: `Store release status: ${release.status}`,
        };
      const bundles = await this.request(`${base}/bundles`);
      invariant(
        !bundles.bundles?.some(
          (item: any) => String(item.versionCode) === artifact.buildNumber,
        ),
        "UPLOAD_UNRESOLVED",
        "Google has this version but it is not on the selected track. Review it before retrying; do not upload again.",
      );
      invariant(
        originalEditId,
        "UPLOAD_UNRESOLVED",
        "No committed release or original edit was found. Check Play Console before uploading again.",
      );
      return {
        state: "rejected",
        destination: `Google Play · ${track}`,
        message:
          "Google discarded the uncommitted edit. This version is absent from bundles and the selected track. Upload the existing artifact again; no rebuild is needed.",
      };
    } finally {
      await this.request(base, "DELETE").catch(() => {});
    }
  }
}
export async function uploadApple(
  credential: AppleCredential,
  artifact: Artifact,
  root: string,
  options: CommandOptions & { progress?: (update: ProgressUpdate) => void },
): Promise<Submission> {
  await secretFile(
    root,
    `AuthKey_${credential.keyId}.p8`,
    credential.privateKey,
  );
  await run(
    "xcrun",
    [
      "altool",
      "--validate-app",
      "-f",
      artifact.path,
      "-t",
      "ios",
      "--api-key",
      credential.keyId,
      "--api-issuer",
      credential.issuerId,
    ],
    { ...options, env: { ...options.env, API_PRIVATE_KEYS_DIR: root } },
  );
  options.progress?.({
    kind: "upload",
    label: "Uploading IPA to Apple",
    detail:
      "Xcode is transferring and validating the IPA. This can take a few minutes.",
  });
  await run(
    "xcrun",
    [
      "altool",
      "--upload-app",
      "--show-progress",
      "-f",
      artifact.path,
      "-t",
      "ios",
      "--api-key",
      credential.keyId,
      "--api-issuer",
      credential.issuerId,
    ],
    {
      ...options,
      env: { ...options.env, API_PRIVATE_KEYS_DIR: root },
      log: (line) => {
        options.log?.(line);
        const percent = [...line.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)].at(
          -1,
        )?.[1];
        if (percent && +percent <= 100)
          options.progress?.({
            kind: "upload",
            label: "Uploading IPA to Apple",
            percent: +percent,
            detail:
              "Progress reported by Xcode. Apple processing follows upload completion.",
          });
      },
    },
  );
  return {
    state: "processing",
    destination: "App Store Connect / TestFlight",
    uploadedAt: new Date().toISOString(),
    message: "Upload finished. Apple processing is pending.",
  };
}
export function appleBuildState(
  builds: any[],
  version: string,
): Submission | undefined {
  const build = builds[0];
  if (!build) return;
  const status = build.attributes.processingState;
  return {
    state:
      status === "VALID"
        ? "accepted"
        : status === "FAILED" || status === "INVALID"
          ? "rejected"
          : "processing",
    destination: "App Store Connect / TestFlight",
    externalId: build.id,
    message: `Apple processing: ${status}`,
  };
}
