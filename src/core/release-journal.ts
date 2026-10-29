import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./database";
import type { AppleAPI } from "./stores";
import { invariant } from "./errors";

const text = z.string().max(4096);
export const releaseJournalSchema = z
  .object({
    id: text,
    projectId: text,
    bundleId: text,
    version: text,
    manifestHash: text,
    appId: text,
    state: z.enum(["running", "interrupted", "uncertain", "complete"]),
    stage: text,
    updatedAt: text,
    reviewSubmissionId: text.optional(),
    completed: z.array(text).max(10000),
    pending: z
      .object({
        key: text,
        path: text,
        startedAt: text,
        selectors: z.record(text, z.union([text, z.number()])),
        relationships: z.record(text, text),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ReleaseJournalData = z.infer<typeof releaseJournalSchema>;
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** A write-ahead receipt for listing/review mutations. It stores identifiers and
 * hashes, never review contact details, demo passwords, tokens or form bodies. */
export class ReleaseJournal {
  data: ReleaseJournalData;
  constructor(
    private store: Store,
    context: Pick<
      ReleaseJournalData,
      "projectId" | "bundleId" | "version" | "appId" | "manifestHash"
    >,
  ) {
    const records = store.preference<ReleaseJournalData[]>(
      "release-journals",
      [],
    );
    const existing = records.find(
      (j) => j.bundleId === context.bundleId && j.version === context.version,
    );
    this.data = existing
      ? { ...existing, projectId: context.projectId }
      : {
          ...context,
          id: randomUUID(),
          state: "running",
          stage: "prepared",
          completed: [],
          updatedAt: new Date().toISOString(),
        };
    // A changed manifest cannot erase evidence of an uncertain remote mutation.
    if (!this.data.pending) this.data.manifestHash = context.manifestHash;
    this.save();
  }
  private save() {
    this.data.updatedAt = new Date().toISOString();
    const records = this.store
      .preference<ReleaseJournalData[]>("release-journals", [])
      .filter((j) => j.id !== this.data.id);
    records.push(this.data);
    this.store.setPreference("release-journals", records);
  }
  finish(submitted: boolean) {
    this.data.state = "complete";
    this.data.stage = submitted ? "submitted" : "metadata saved";
    this.save();
  }
  /** Resolve an interrupted POST from Apple's current state before any writes.
   * If existence is ambiguous, stop. A missing response is not proof of failure. */
  async reconcile(api: AppleAPI) {
    const pending = this.data.pending;
    if (!pending) return;
    const all = async (path: string) => {
      const rows: any[] = [];
      let next: string | undefined = path;
      while (next) {
        const response = await api.request(next);
        rows.push(...(response.data ?? []));
        next = response.links?.next
          ? String(response.links.next).replace(
              /^https:\/\/api\.appstoreconnect\.apple\.com\/v1/,
              "",
            )
          : undefined;
      }
      return rows;
    };
    const relations = pending.relationships,
      selectors = pending.selectors;
    let rows: any[] = [];
    if (pending.path === "/reviewSubmissions") {
      rows = (
        await all(
          `/reviewSubmissions?filter[app]=${this.data.appId}&filter[platform]=IOS&limit=50`,
        )
      ).filter(
        (r) =>
          r.attributes?.state === "READY_FOR_REVIEW" &&
          !r.attributes?.submittedDate,
      );
    } else if (
      pending.path === "/reviewSubmissionItems" &&
      relations.reviewSubmission
    ) {
      rows = (
        await all(
          `/reviewSubmissions/${relations.reviewSubmission}/items?include=appStoreVersion,inAppPurchaseVersion&limit=50`,
        )
      ).filter((r: any) =>
        Object.entries(relations)
          .filter(([k]) => k !== "reviewSubmission")
          .every(([k, v]) => r.relationships?.[k]?.data?.id === v),
      );
    } else {
      const collection: Record<string, string | undefined> = {
        "/appStoreVersions": `/apps/${this.data.appId}/appStoreVersions?filter[platform]=IOS&limit=50`,
        "/appStoreVersionLocalizations":
          relations.appStoreVersion &&
          `/appStoreVersions/${relations.appStoreVersion}/appStoreVersionLocalizations?limit=50`,
        "/betaBuildLocalizations":
          relations.build &&
          `/builds/${relations.build}/betaBuildLocalizations?limit=200`,
        "/appInfoLocalizations":
          relations.appInfo &&
          `/appInfos/${relations.appInfo}/appInfoLocalizations?limit=50`,
        "/appStoreReviewDetails":
          relations.appStoreVersion &&
          `/appStoreVersions/${relations.appStoreVersion}/appStoreReviewDetail`,
        "/appScreenshotSets":
          relations.appStoreVersionLocalization &&
          `/appStoreVersionLocalizations/${relations.appStoreVersionLocalization}/appScreenshotSets?limit=50`,
        "/appScreenshots":
          relations.appScreenshotSet &&
          `/appScreenshotSets/${relations.appScreenshotSet}/appScreenshots?limit=50`,
        "/v2/inAppPurchases": `/apps/${this.data.appId}/inAppPurchasesV2?limit=200`,
      };
      const path = collection[pending.path];
      if (path) {
        const response = await api.request(path);
        rows = (Array.isArray(response.data) ? response.data : [response.data])
          .filter(Boolean)
          .filter((r: any) =>
            Object.entries(selectors).every(
              ([key, value]) => r.attributes?.[key] === value,
            ),
          );
      }
    }
    invariant(
      rows.length === 1,
      "RELEASE_OUTCOME_UNCERTAIN",
      `An interrupted ${pending.path} request has ${rows.length} matching resources at Apple. No duplicate request was sent. Check App Store Connect and run listing again after Apple settles the request. The local release journal is preserved.`,
    );
    if (pending.path === "/reviewSubmissions")
      this.data.reviewSubmissionId = rows[0].id;
    this.data.completed.push(pending.key);
    delete this.data.pending;
    this.data.state = "running";
    this.data.stage = "reconciled";
    this.save();
  }
  wrap(api: AppleAPI): AppleAPI {
    const wrapped = Object.create(api) as AppleAPI;
    wrapped.request = async (path, method = "GET", body?: any) => {
      if (["GET", "HEAD"].includes(method))
        return api.request(path, method, body);
      invariant(
        !this.data.pending,
        "RELEASE_OUTCOME_UNCERTAIN",
        "Reconcile the previous interrupted listing request before making another change.",
      );
      const key = digest({ path, method, body });
      this.data.state = "running";
      this.data.stage = `${method} ${path}`;
      if (method === "POST") {
        this.data.pending = {
          key,
          path,
          startedAt: new Date().toISOString(),
          selectors: Object.fromEntries(
            Object.entries(body?.data?.attributes ?? {}).filter(([k]) =>
              [
                "locale",
                "versionString",
                "productId",
                "fileName",
                "fileSize",
                "screenshotDisplayType",
              ].includes(k),
            ),
          ) as Record<string, string | number>,
          relationships: Object.fromEntries(
            Object.entries(body?.data?.relationships ?? {}).flatMap(
              ([k, v]: [string, any]) => (v?.data?.id ? [[k, v.data.id]] : []),
            ),
          ),
        };
      }
      // Synchronous SQLite commit precedes the network mutation.
      this.save();
      try {
        const response = await api.request(path, method, body);
        if (method === "POST" && path === "/reviewSubmissions")
          this.data.reviewSubmissionId = response.data.id;
        delete this.data.pending;
        if (!this.data.completed.includes(key)) this.data.completed.push(key);
        this.save();
        return response;
      } catch (error) {
        // A definite 4xx rejection did not create a resource. A timeout or 5xx
        // remains uncertain even if the caller sees a generic network error.
        if (
          /^Apple (?:400|401|403|404|409|422)(?: \([^)]*\))?:/.test(
            (error as Error).message,
          )
        )
          delete this.data.pending;
        this.data.state = this.data.pending ? "uncertain" : "interrupted";
        this.save();
        throw error;
      }
    };
    return wrapped;
  }
}

export const listingFingerprint = (
  listing: unknown,
  screenshots: { checksum: string }[],
) => digest({ listing, screenshots: screenshots.map((s) => s.checksum) });
