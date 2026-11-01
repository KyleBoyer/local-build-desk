import type { AppleAPI, GoogleAPI } from "./stores";
import { DeskError, invariant } from "./errors";

/**
 * Promoting builds that are already in the stores, without uploading again:
 * a Play release moves to another track by version code, and a TestFlight
 * build joins external groups (with beta review when Apple requires it).
 * Play rollouts can also be widened, halted, resumed or completed here.
 */

// ---------- Google Play ----------

/** Play's standard tracks, in promotion order; closed tracks can be custom. */
export const PLAY_TRACK_ORDER = ["internal", "alpha", "beta", "production"];
export const playTrackName = (track: string) =>
  ({
    internal: "Internal testing",
    alpha: "Closed testing",
    beta: "Open testing",
    production: "Production",
  })[track] ?? `Closed testing · ${track}`;

export interface PlayTrackRelease {
  name?: string;
  versionCodes: string[];
  status: "draft" | "inProgress" | "halted" | "completed";
  userFraction?: number;
  releaseNotes?: { language: string; text: string }[];
}
export interface PlayTrack {
  track: string;
  releases: PlayTrackRelease[];
}
export interface PlayPromotionOptions {
  tracks: { track: string; name: string; releases: PlayTrackRelease[] }[];
}

const SEND_FOR_REVIEW =
  /changesNotSentForReview (?:to|must be set to) true|cannot be sent for review automatically/i;

/** Runs `change` inside one Play edit and commits it. Returns whether Play
 * published it or holds it until changes are sent for review in Console. */
async function inEdit<T>(
  api: GoogleAPI,
  packageName: string,
  change: (base: string) => Promise<T>,
) {
  const edit = await api.edit(packageName);
  const base = `/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(edit.id)}`;
  let committed = false;
  try {
    const value = await change(base);
    let review = false;
    try {
      await api.request(`${base}:commit`, "POST", {});
    } catch (error) {
      if (
        !(error instanceof DeskError) ||
        error.code !== "GOOGLE_400" ||
        !SEND_FOR_REVIEW.test(error.message)
      )
        throw error;
      await api.request(
        `${base}:commit?changesNotSentForReview=true`,
        "POST",
        {},
      );
      review = true;
    }
    committed = true;
    return { value, review };
  } finally {
    if (!committed) await api.request(base, "DELETE").catch(() => undefined);
  }
}

export async function playTracks(api: GoogleAPI, packageName: string) {
  const edit = await api.edit(packageName);
  const base = `/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(edit.id)}`;
  try {
    const tracks: PlayTrack[] =
      (await api.request(`${base}/tracks`)).tracks ?? [];
    const names = [
      ...PLAY_TRACK_ORDER,
      ...tracks
        .map((t) => t.track)
        .filter((t) => !PLAY_TRACK_ORDER.includes(t)),
    ];
    return {
      tracks: names.map((track) => ({
        track,
        name: playTrackName(track),
        releases: tracks.find((t) => t.track === track)?.releases ?? [],
      })),
    } satisfies PlayPromotionOptions;
  } finally {
    await api.request(base, "DELETE").catch(() => undefined);
  }
}

export interface PlayPromotion {
  versionCodes: string[];
  from: string;
  to: string;
  /** Production only: a staged rollout to this share of users (0–1, exclusive of 1). */
  fraction?: number;
  releaseNotes?: { language: string; text: string }[];
}

/**
 * Puts a release that's on `from` onto `to`, by version code: nothing is
 * uploaded. A staged production rollout keeps the current full release for
 * everyone else, as Play Console does.
 */
export async function promotePlay(
  api: GoogleAPI,
  packageName: string,
  promotion: PlayPromotion,
) {
  invariant(
    promotion.from !== promotion.to,
    "PROMOTE_TRACK",
    "Choose a different track to promote to.",
  );
  invariant(
    promotion.fraction === undefined ||
      (promotion.to === "production" &&
        promotion.fraction > 0 &&
        promotion.fraction < 1),
    "PROMOTE_FRACTION",
    "Staged rollouts are for production, between 0% and 100%.",
  );
  return inEdit(api, packageName, async (base) => {
    const tracks: PlayTrack[] =
      (await api.request(`${base}/tracks`)).tracks ?? [];
    const source = tracks
      .find((t) => t.track === promotion.from)
      ?.releases.find((r) =>
        promotion.versionCodes.every((code) =>
          r.versionCodes?.map(String).includes(code),
        ),
      );
    invariant(
      source,
      "PROMOTE_SOURCE",
      `Version ${promotion.versionCodes.join(", ")} isn't on ${playTrackName(promotion.from)} any more. Refresh and try again.`,
    );
    const target = tracks.find((t) => t.track === promotion.to)?.releases ?? [];
    const release: PlayTrackRelease = {
      name: source.name,
      versionCodes: promotion.versionCodes,
      status: promotion.fraction !== undefined ? "inProgress" : "completed",
      ...(promotion.fraction !== undefined
        ? { userFraction: promotion.fraction }
        : {}),
      ...((promotion.releaseNotes ?? source.releaseNotes)?.length
        ? { releaseNotes: promotion.releaseNotes ?? source.releaseNotes }
        : {}),
    };
    // A staged rollout runs beside the release everyone else still gets.
    const keep =
      promotion.fraction !== undefined
        ? target.filter((r) => r.status === "completed").slice(0, 1)
        : [];
    await api.request(
      `${base}/tracks/${encodeURIComponent(promotion.to)}`,
      "PUT",
      {
        track: promotion.to,
        releases: [release, ...keep],
      },
    );
    return release;
  });
}

export type RolloutChange =
  | { action: "fraction"; fraction: number }
  | { action: "halt" }
  | { action: "resume" }
  | { action: "complete" };

/** Changes a production (or other track's) staged rollout in place. */
export async function changePlayRollout(
  api: GoogleAPI,
  packageName: string,
  track: string,
  versionCodes: string[],
  change: RolloutChange,
) {
  return inEdit(api, packageName, async (base) => {
    const current: PlayTrack = await api.request(
      `${base}/tracks/${encodeURIComponent(track)}`,
    );
    const releases = current.releases ?? [];
    const staged = releases.find(
      (r) =>
        (r.status === "inProgress" || r.status === "halted") &&
        versionCodes.every((code) =>
          r.versionCodes?.map(String).includes(code),
        ),
    );
    invariant(
      staged,
      "ROLLOUT_MISSING",
      `There's no staged rollout of ${versionCodes.join(", ")} on ${playTrackName(track)}. Refresh and try again.`,
    );
    let next: PlayTrackRelease[];
    if (change.action === "complete")
      next = [{ ...staged, status: "completed", userFraction: undefined }];
    else {
      if (change.action === "fraction")
        invariant(
          change.fraction > (staged.userFraction ?? 0) && change.fraction < 1,
          "ROLLOUT_FRACTION",
          "A rollout can only widen; use Complete for 100%.",
        );
      const updated: PlayTrackRelease =
        change.action === "halt"
          ? { ...staged, status: "halted" }
          : change.action === "resume"
            ? { ...staged, status: "inProgress" }
            : {
                ...staged,
                status: "inProgress",
                userFraction: change.fraction,
              };
      next = releases.map((r) => (r === staged ? updated : r));
    }
    await api.request(`${base}/tracks/${encodeURIComponent(track)}`, "PUT", {
      track,
      releases: next.map((r) =>
        Object.fromEntries(
          Object.entries(r).filter(([, v]) => v !== undefined),
        ),
      ),
    });
    return next[0]!;
  });
}

// ---------- TestFlight ----------

export interface TestFlightGroup {
  id: string;
  name: string;
  internal: boolean;
  hasBuild: boolean;
  publicLinkEnabled: boolean;
  publicLink?: string;
  publicLinkLimit?: number;
}
export interface TestFlightPromotionOptions {
  buildId: string;
  externalState?: string;
  betaReviewState?: string;
  groups: TestFlightGroup[];
  /** Beta App Review needs a contact; missing fields block external testing. */
  reviewDetail: {
    id?: string;
    contactFirstName?: string;
    contactLastName?: string;
    contactEmail?: string;
    contactPhone?: string;
    demoAccountRequired?: boolean;
    notes?: string;
  };
  missingContact: string[];
}

async function all(api: AppleAPI, path: string) {
  const rows: any[] = [];
  for (let page = 0; path && page < 20; page++) {
    const response = await api.request(path);
    rows.push(...(response.data ?? []));
    const next = response.links?.next as string | undefined;
    if (!next) break;
    const url = new URL(next);
    invariant(
      url.origin === "https://api.appstoreconnect.apple.com",
      "APPLE_PAGE",
      "Invalid Apple pagination link.",
    );
    path = url.pathname.replace(/^\/v1/, "") + url.search;
  }
  return rows;
}

export async function testFlightOptions(
  api: AppleAPI,
  bundleId: string,
  buildId: string,
): Promise<TestFlightPromotionOptions> {
  const app = await api.app(bundleId);
  invariant(app, "APPLE_APP", "The App Store Connect app isn't available.");
  const [groups, detail, beta, review] = await Promise.all([
    all(api, `/apps/${app.id}/betaGroups?limit=200`),
    api
      .request(`/apps/${app.id}/betaAppReviewDetail`)
      .then((r) => r.data)
      .catch(() => undefined),
    api
      .request(`/builds/${buildId}/buildBetaDetail`)
      .then((r) => r.data)
      .catch(() => undefined),
    api
      .request(`/builds/${buildId}/betaAppReviewSubmission`)
      .then((r) => r.data)
      .catch(() => undefined),
  ]);
  // Apple lists builds per group, not groups per build.
  const withBuild = new Set(
    (
      await Promise.all(
        groups
          .filter((g) => !g.attributes.isInternalGroup)
          .map(async (g) =>
            (await all(api, `/betaGroups/${g.id}/builds?limit=200`)).some(
              (b) => b.id === buildId,
            )
              ? g.id
              : undefined,
          ),
      )
    ).filter(Boolean) as string[],
  );
  const contact = detail?.attributes ?? {};
  return {
    buildId,
    externalState: beta?.attributes?.externalBuildState,
    betaReviewState: review?.attributes?.betaReviewState,
    groups: groups.map((g) => ({
      id: g.id,
      name: g.attributes.name,
      internal: !!g.attributes.isInternalGroup,
      hasBuild:
        withBuild.has(g.id) ||
        (!!g.attributes.isInternalGroup && !!g.attributes.hasAccessToAllBuilds),
      publicLinkEnabled: !!g.attributes.publicLinkEnabled,
      publicLink: g.attributes.publicLink ?? undefined,
      publicLinkLimit: g.attributes.publicLinkLimitEnabled
        ? g.attributes.publicLinkLimit
        : undefined,
    })),
    reviewDetail: {
      id: detail?.id,
      contactFirstName: contact.contactFirstName ?? undefined,
      contactLastName: contact.contactLastName ?? undefined,
      contactEmail: contact.contactEmail ?? undefined,
      contactPhone: contact.contactPhone ?? undefined,
      demoAccountRequired: contact.demoAccountRequired ?? undefined,
      notes: contact.notes ?? undefined,
    },
    missingContact: (
      [
        "contactFirstName",
        "contactLastName",
        "contactEmail",
        "contactPhone",
      ] as const
    ).filter((k) => !contact[k]),
  };
}

export interface TestFlightPromotion {
  buildId: string;
  /** External groups to add the build to. */
  groupIds: string[];
  /** A new external group to create and add the build to. */
  newGroup?: { name: string; publicLink: boolean; publicLinkLimit?: number };
  /** Public link changes for existing external groups. */
  publicLinks?: { groupId: string; enabled: boolean; limit?: number }[];
  /** Fills Beta App Review's contact when it's missing. */
  contact?: {
    contactFirstName?: string;
    contactLastName?: string;
    contactEmail?: string;
    contactPhone?: string;
  };
}

/**
 * Adds a TestFlight build to external groups and submits it for Beta App
 * Review when Apple requires that before external testers get it. Nothing
 * is uploaded.
 */
export async function promoteTestFlight(
  api: AppleAPI,
  bundleId: string,
  promotion: TestFlightPromotion,
  log: (line: string) => void,
) {
  const app = await api.app(bundleId);
  invariant(app, "APPLE_APP", "The App Store Connect app isn't available.");
  const options = await testFlightOptions(api, bundleId, promotion.buildId);
  const external = new Map(
    options.groups.filter((g) => !g.internal).map((g) => [g.id, g]),
  );
  for (const id of promotion.groupIds)
    invariant(
      external.has(id),
      "TESTFLIGHT_GROUP",
      "Choose external TestFlight groups; internal groups get builds automatically.",
    );

  if (promotion.contact && Object.values(promotion.contact).some(Boolean)) {
    const attributes = Object.fromEntries(
      Object.entries(promotion.contact).filter(([, v]) => v),
    );
    invariant(
      options.reviewDetail.id,
      "BETA_REVIEW_DETAIL",
      "Apple didn't return Beta App Review details for this app.",
    );
    await api.request(
      `/betaAppReviewDetails/${options.reviewDetail.id}`,
      "PATCH",
      {
        data: {
          type: "betaAppReviewDetails",
          id: options.reviewDetail.id,
          attributes,
        },
      },
    );
    log("Saved Beta App Review contact");
  }
  const groupIds = [...promotion.groupIds];
  if (promotion.newGroup) {
    const name = promotion.newGroup.name.trim();
    invariant(name, "TESTFLIGHT_GROUP", "Name the new group.");
    const created = (
      await api.request("/betaGroups", "POST", {
        data: {
          type: "betaGroups",
          attributes: {
            name,
            publicLinkEnabled: promotion.newGroup.publicLink,
            ...(promotion.newGroup.publicLinkLimit
              ? {
                  publicLinkLimitEnabled: true,
                  publicLinkLimit: promotion.newGroup.publicLinkLimit,
                }
              : {}),
            feedbackEnabled: true,
          },
          relationships: { app: { data: { type: "apps", id: app.id } } },
        },
      })
    ).data;
    groupIds.push(created.id);
    log(`Created external group ${name}`);
  }
  for (const link of promotion.publicLinks ?? []) {
    invariant(
      external.has(link.groupId),
      "TESTFLIGHT_GROUP",
      "Public links are for external groups.",
    );
    await api.request(`/betaGroups/${link.groupId}`, "PATCH", {
      data: {
        type: "betaGroups",
        id: link.groupId,
        attributes: {
          publicLinkEnabled: link.enabled,
          ...(link.enabled
            ? link.limit
              ? { publicLinkLimitEnabled: true, publicLinkLimit: link.limit }
              : { publicLinkLimitEnabled: false }
            : {}),
        },
      },
    });
    log(
      `${external.get(link.groupId)!.name}: public link ${link.enabled ? "on" : "off"}`,
    );
  }
  const adding = groupIds.filter((id) => !external.get(id)?.hasBuild);
  if (adding.length) {
    await api.request(
      `/builds/${promotion.buildId}/relationships/betaGroups`,
      "POST",
      {
        data: adding.map((id) => ({ type: "betaGroups", id })),
      },
    );
    log(
      `Added the build to ${adding.length} group${adding.length === 1 ? "" : "s"}`,
    );
  }
  // External testers only get a build Beta App Review approved. A build
  // whose version Apple already approved goes straight to testers.
  let submitted = false;
  const state = options.externalState;
  if (groupIds.length && state === "READY_FOR_BETA_SUBMISSION") {
    const missing = promotion.contact
      ? options.missingContact.filter(
          (k) => !promotion.contact?.[k as keyof typeof promotion.contact],
        )
      : options.missingContact;
    invariant(
      !missing.length,
      "BETA_REVIEW_CONTACT",
      "Beta App Review needs a contact name, email and phone before external testers get this build.",
    );
    await api.request("/betaAppReviewSubmissions", "POST", {
      data: {
        type: "betaAppReviewSubmissions",
        relationships: {
          build: { data: { type: "builds", id: promotion.buildId } },
        },
      },
    });
    submitted = true;
    log("Submitted the build for Beta App Review");
  }
  return { submitted, groupIds };
}
