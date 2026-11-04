import { z } from "zod";
import type { AppleAPI } from "./stores";
import { invariant } from "./errors";
import type { StoreActionPlan } from "./store-actions";

const id = z.string().min(1).max(200);
export const publishActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("release") }).strict(),
  z
    .object({
      kind: z.literal("schedule"),
      releaseType: z.enum(["MANUAL", "AFTER_APPROVAL", "SCHEDULED"]),
      earliestReleaseDate: z.iso.datetime({ offset: true }).optional(),
    })
    .strict()
    .refine(
      (v) => v.releaseType !== "SCHEDULED" || !!v.earliestReleaseDate,
      "Choose a release date and time.",
    ),
  z.object({ kind: z.literal("withdraw") }).strict(),
  z.object({ kind: z.literal("replaceBuild"), buildId: id }).strict(),
  z.object({ kind: z.literal("submit") }).strict(),
]);
export type PublishAction = z.infer<typeof publishActionSchema>;
export const EDITABLE_VERSION_STATES = [
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
];
const relation = (row: any, name: string) =>
  row?.relationships?.[name]?.data?.id;
const link = (type: string, id: string) => ({ data: { type, id } });
const state = (row: any) =>
  row.attributes?.appStoreState ?? row.attributes?.appVersionState;

export async function publishingState(
  api: AppleAPI,
  appId: string,
  versionId: string,
) {
  const response = await api.request(
    `/appStoreVersions/${encodeURIComponent(versionId)}?include=app,build`,
  );
  invariant(
    relation(response.data, "app") === appId,
    "PUBLISH_APP",
    "This App Store version belongs to a different app.",
  );
  const reviews = await api.request(
    `/reviewSubmissions?filter[app]=${encodeURIComponent(appId)}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES,CANCELING,COMPLETING&include=appStoreVersionForReview,items&limit=200`,
  );
  const own = (reviews.data ?? []).filter(
    (r: any) => relation(r, "appStoreVersionForReview") === versionId,
  );
  const version = response.data;
  const build = (response.included ?? []).find(
    (r: any) => r.type === "builds" && r.id === relation(version, "build"),
  );
  return {
    versionId,
    version: String(version.attributes.versionString),
    state: state(version),
    releaseType: version.attributes.releaseType,
    earliestReleaseDate: version.attributes.earliestReleaseDate,
    buildId: build?.id,
    buildNumber: build?.attributes.version,
    buildReady:
      build?.attributes.processingState === "VALID" &&
      !build?.attributes.expired,
    reviews: own.map((r: any) => ({
      id: r.id,
      state: r.attributes.state,
      items: (r.relationships?.items?.data ?? []).map((i: any) => i.id),
    })),
    draftIds: (reviews.data ?? [])
      .filter(
        (r: any) =>
          r.attributes.state === "READY_FOR_REVIEW" &&
          !relation(r, "appStoreVersionForReview") &&
          !r.relationships?.items?.data?.length,
      )
      .map((r: any) => r.id),
  };
}
export type PublishingState = Awaited<ReturnType<typeof publishingState>>;

export async function publishBuilds(
  api: AppleAPI,
  appId: string,
  version: string,
) {
  const response = await api.request(
    `/builds?filter[app]=${encodeURIComponent(appId)}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&filter[processingState]=VALID&filter[expired]=false&sort=-uploadedDate&limit=100`,
  );
  return (response.data ?? []).map((r: any) => ({
    id: r.id as string,
    number: String(r.attributes.version),
    uploadedAt: r.attributes.uploadedDate as string,
  }));
}

export async function planPublishing(
  api: AppleAPI,
  appId: string,
  bundleId: string,
  versionId: string,
  input: PublishAction,
): Promise<StoreActionPlan> {
  const action = publishActionSchema.parse(input),
    current = await publishingState(api, appId, versionId);
  const path = `/appStoreVersions/${encodeURIComponent(versionId)}`;
  const scope = `apple-publish:${appId}:${versionId}`,
    changes: string[] = [],
    warnings: string[] = [];
  const recovery = { kind: "publish", appId, bundleId, versionId, action };
  let title = "",
    execute: () => Promise<void>,
    satisfied: () => Promise<boolean>;
  const read = () => publishingState(api, appId, versionId);
  if (action.kind === "release") {
    invariant(
      current.state === "PENDING_DEVELOPER_RELEASE",
      "PUBLISH_NOT_APPROVED",
      "Apple must approve this version and show Pending Developer Release before it can be released.",
    );
    title = "Release approved version";
    changes.push(
      `Publish version ${current.version}, build ${current.buildNumber ?? "not attached"}, to its configured App Store territories.`,
    );
    warnings.push(
      "This makes the approved version available to customers. Apple may take up to 24 hours to finish distribution.",
    );
    execute = async () => {
      await api.request("/appStoreVersionReleaseRequests", "POST", {
        data: {
          type: "appStoreVersionReleaseRequests",
          relationships: {
            appStoreVersion: link("appStoreVersions", versionId),
          },
        },
      });
    };
    satisfied = async () =>
      [
        "PENDING_APPLE_RELEASE",
        "PROCESSING_FOR_DISTRIBUTION",
        "READY_FOR_SALE",
        "READY_FOR_DISTRIBUTION",
      ].includes((await read()).state);
  } else if (action.kind === "schedule") {
    invariant(
      [...EDITABLE_VERSION_STATES, "WAITING_FOR_REVIEW", "IN_REVIEW"].includes(
        current.state,
      ),
      "PUBLISH_TIMING_STATE",
      "Release timing can be edited before approval. For an approved version, use Release approved version.",
    );
    invariant(
      action.releaseType !== "SCHEDULED" ||
        Date.parse(action.earliestReleaseDate!) > Date.now() + 60000,
      "PUBLISH_DATE",
      "Choose a release time at least one minute in the future.",
    );
    title = "Set release timing";
    warnings.push(
      "This changes the selected store version. The committed listing file’s defaults for future releases are unchanged; keep that file in sync if you want to reuse this timing.",
    );
    changes.push(
      `${current.releaseType ?? "Unspecified"} → ${action.releaseType}${action.releaseType === "SCHEDULED" ? `, no earlier than ${action.earliestReleaseDate}` : ""}`,
    );
    if (action.releaseType !== "MANUAL")
      warnings.push(
        "The version will publish automatically after Apple approves it and any scheduled time is reached.",
      );
    const attrs = {
      releaseType: action.releaseType,
      earliestReleaseDate:
        action.releaseType === "SCHEDULED" ? action.earliestReleaseDate : null,
    };
    execute = async () => {
      await api.request(path, "PATCH", {
        data: { type: "appStoreVersions", id: versionId, attributes: attrs },
      });
    };
    satisfied = async () => {
      const v = await read();
      return (
        v.releaseType === action.releaseType &&
        (action.releaseType !== "SCHEDULED" ||
          Date.parse(v.earliestReleaseDate) ===
            Date.parse(action.earliestReleaseDate!))
      );
    };
  } else if (action.kind === "withdraw") {
    const active = current.reviews.filter((r: any) =>
      ["WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES"].includes(
        r.state,
      ),
    );
    invariant(
      active.length === 1,
      "PUBLISH_REVIEW",
      "Select a version with exactly one active review submission. Refresh App Store status.",
    );
    const review = active[0];
    title = "Withdraw review submission";
    changes.push(
      `Cancel review submission ${review.id} for version ${current.version}.`,
    );
    warnings.push(
      `All ${review.items.length} item(s) in that submission are withdrawn, including any purchases or other items submitted with the app. A later submission starts review again.`,
    );
    execute = async () => {
      await api.request(
        `/reviewSubmissions/${encodeURIComponent(review.id)}`,
        "PATCH",
        {
          data: {
            type: "reviewSubmissions",
            id: review.id,
            attributes: { canceled: true },
          },
        },
      );
    };
    satisfied = async () => {
      const v = await read();
      return (
        v.state === "DEVELOPER_REJECTED" ||
        v.reviews.some(
          (r: any) =>
            r.id === review.id && ["CANCELING", "COMPLETE"].includes(r.state),
        )
      );
    };
  } else if (action.kind === "replaceBuild") {
    invariant(
      EDITABLE_VERSION_STATES.includes(current.state),
      "PUBLISH_EDITABLE",
      "Withdraw this version from review and wait for Developer Rejected before replacing its build.",
    );
    const response = await api.request(
        `/builds/${encodeURIComponent(action.buildId)}?include=app,preReleaseVersion`,
      ),
      build = response.data;
    const pre = (response.included ?? []).find(
      (r: any) =>
        r.id === relation(build, "preReleaseVersion") &&
        r.type === "preReleaseVersions",
    );
    invariant(
      relation(build, "app") === appId &&
        pre?.attributes?.version === current.version &&
        build.attributes.processingState === "VALID" &&
        !build.attributes.expired,
      "PUBLISH_BUILD",
      "Choose a processed, unexpired build of this app and this marketing version.",
    );
    title = "Replace review build";
    changes.push(
      `Build ${current.buildNumber ?? "none"} → ${build.attributes.version}.`,
    );
    warnings.push(
      "Listing text, screenshots and release timing are retained. This does not submit the version for review.",
    );
    execute = async () => {
      await api.request(
        `${path}/relationships/build`,
        "PATCH",
        link("builds", action.buildId),
      );
    };
    satisfied = async () => (await read()).buildId === action.buildId;
    return {
      scope,
      recovery,
      snapshot: {
        current,
        action,
        build: {
          id: build.id,
          attributes: build.attributes,
          pre: pre.attributes,
        },
      },
      title,
      identity: `${bundleId} · ${current.version}`,
      changes,
      warnings,
      execute,
      satisfied,
    };
  } else {
    invariant(
      EDITABLE_VERSION_STATES.includes(current.state) && current.buildReady,
      "PUBLISH_SUBMIT",
      "Attach a processed, unexpired build to an editable version before submitting for review.",
    );
    invariant(
      !current.reviews.some((r: any) =>
        ["WAITING_FOR_REVIEW", "IN_REVIEW", "CANCELING"].includes(r.state),
      ),
      "PUBLISH_REVIEW",
      "The previous review is still active or being cancelled. Refresh after Apple finishes.",
    );
    const drafts = current.reviews.filter(
      (r: any) => r.state === "READY_FOR_REVIEW",
    );
    invariant(
      drafts.length + current.draftIds.length <= 1,
      "PUBLISH_DRAFT",
      "Apple has multiple review drafts. Resolve them in App Store Connect before submitting.",
    );
    title = "Submit version for App Review";
    changes.push(
      `Submit version ${current.version}, build ${current.buildNumber}, with the listing and review information already saved in App Store Connect.`,
    );
    warnings.push(
      "Apple validates all review prerequisites. Existing prepared submission items are retained. New purchases/subscriptions must already be included in the submission or submitted with the listing workflow.",
    );
    execute = async () => {
      let draft = drafts[0]?.id ?? current.draftIds[0];
      if (!draft)
        draft = (
          await api.request("/reviewSubmissions", "POST", {
            data: {
              type: "reviewSubmissions",
              attributes: { platform: "IOS" },
              relationships: { app: link("apps", appId) },
            },
          })
        ).data.id;
      if (!drafts.length)
        await api.request("/reviewSubmissionItems", "POST", {
          data: {
            type: "reviewSubmissionItems",
            relationships: {
              reviewSubmission: link("reviewSubmissions", draft),
              appStoreVersion: link("appStoreVersions", versionId),
            },
          },
        });
      await api.request(
        `/reviewSubmissions/${encodeURIComponent(draft)}`,
        "PATCH",
        {
          data: {
            type: "reviewSubmissions",
            id: draft,
            attributes: { submitted: true },
          },
        },
      );
    };
    satisfied = async () =>
      (await read()).reviews.some((r: any) =>
        ["WAITING_FOR_REVIEW", "IN_REVIEW"].includes(r.state),
      );
  }
  return {
    scope,
    recovery,
    snapshot: { current, action },
    title,
    identity: `${bundleId} · ${current.version} · build ${current.buildNumber ?? "none"}`,
    changes,
    warnings,
    execute,
    satisfied,
  };
}

export async function publishingSatisfied(
  api: AppleAPI,
  appId: string,
  versionId: string,
  input: unknown,
) {
  const action = publishActionSchema.parse(input),
    v = await publishingState(api, appId, versionId);
  if (action.kind === "release")
    return [
      "PENDING_APPLE_RELEASE",
      "PROCESSING_FOR_DISTRIBUTION",
      "READY_FOR_SALE",
      "READY_FOR_DISTRIBUTION",
    ].includes(v.state);
  if (action.kind === "schedule")
    return (
      v.releaseType === action.releaseType &&
      (action.releaseType !== "SCHEDULED" ||
        Date.parse(v.earliestReleaseDate) ===
          Date.parse(action.earliestReleaseDate!))
    );
  if (action.kind === "withdraw") return v.state === "DEVELOPER_REJECTED";
  if (action.kind === "replaceBuild") return v.buildId === action.buildId;
  return v.reviews.some((r: any) =>
    ["WAITING_FOR_REVIEW", "IN_REVIEW"].includes(r.state),
  );
}
