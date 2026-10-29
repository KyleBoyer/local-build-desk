import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { invariant } from "./errors";
import type { AppleAPI } from "./stores";

// The App Store side of a release: listing text, screenshots, the build, and
// (only when asked) the App Review submission. `listingPlan` reads Apple and
// says what would change and what still blocks review; `applyListing` writes
// exactly that plan. Nothing here releases to the public: versions are
// created with a manual release type.

const text = (max: number) => z.string().max(max).optional();
export const listingSchema = z
  .object({
    locale: z.string().default("en-US"),
    // App info (shared by every version).
    name: z.string().min(2).max(30).optional(),
    subtitle: text(30),
    privacyPolicyUrl: z.url().optional(),
    primaryCategory: z.string().optional(),
    primarySubcategoryOne: z.string().optional(),
    secondaryCategory: z.string().optional(),
    contentRights: z
      .enum(["DOES_NOT_USE_THIRD_PARTY_CONTENT", "USES_THIRD_PARTY_CONTENT"])
      .optional(),
    // This version.
    description: text(4000),
    keywords: text(100),
    promotionalText: text(170),
    supportUrl: z.url().optional(),
    marketingUrl: z.url().optional(),
    whatsNew: text(4000),
    copyright: z.string().optional(),
    /** iPhone screenshots, in order, relative to the listing file. */
    screenshots: z.array(z.string()).max(10).optional(),
    review: z
      .object({
        contactFirstName: z.string().optional(),
        contactLastName: z.string().optional(),
        contactPhone: z.string().optional(),
        contactEmail: z.string().optional(),
        demoAccountRequired: z.boolean().optional(),
        notes: text(4000),
      })
      .optional(),
    /** In-app purchase product IDs to send to review with this version. */
    inAppPurchases: z.array(z.string()).optional(),
  })
  .loose();
export type Listing = z.infer<typeof listingSchema>;

export interface Screenshot {
  path: string;
  name: string;
  size: number;
  checksum: string;
  width: number;
  height: number;
  displayType: string;
}

/** Apple's display types by exact portrait pixel size. */
const DISPLAY_TYPES: [string, [number, number][]][] = [
  [
    "APP_IPHONE_67",
    [
      [1320, 2868],
      [1290, 2796],
      [1260, 2736],
    ],
  ],
  [
    "APP_IPHONE_65",
    [
      [1284, 2778],
      [1242, 2688],
    ],
  ],
  [
    "APP_IPHONE_61",
    [
      [1206, 2622],
      [1179, 2556],
    ],
  ],
  [
    "APP_IPHONE_58",
    [
      [1170, 2532],
      [1125, 2436],
      [1080, 2340],
    ],
  ],
  ["APP_IPHONE_55", [[1242, 2208]]],
];

export function displayTypeFor(width: number, height: number) {
  const [w, h] = width < height ? [width, height] : [height, width];
  return DISPLAY_TYPES.find(([, sizes]) =>
    sizes.some(([sw, sh]) => sw === w && sh === h),
  )?.[0];
}

function pngSize(data: Buffer) {
  invariant(
    data.length > 24 && data.toString("ascii", 1, 4) === "PNG",
    "SCREENSHOT_FORMAT",
    "Screenshots must be PNG files.",
  );
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export async function loadListing(path: string) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const parsed = listingSchema.safeParse(raw);
  invariant(
    parsed.success,
    "LISTING_INVALID",
    `Listing ${path}: ${parsed.error?.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
  );
  const listing = parsed.data;
  const screenshots: Screenshot[] = [];
  for (const file of listing.screenshots ?? []) {
    const full = resolve(dirname(path), file);
    const data = await readFile(full);
    const { width, height } = pngSize(data);
    const displayType = displayTypeFor(width, height);
    invariant(
      displayType,
      "SCREENSHOT_SIZE",
      `${file} is ${width}×${height}, which isn't an App Store iPhone screenshot size. Use 1320×2868 for 6.9-inch displays.`,
    );
    screenshots.push({
      path: full,
      name: full.split("/").pop()!,
      size: data.length,
      checksum: createHash("md5").update(data).digest("hex"),
      width,
      height,
      displayType,
    });
  }
  const types = new Set(screenshots.map((s) => s.displayType));
  invariant(
    types.size <= 1,
    "SCREENSHOT_SIZE",
    "Use one screenshot size per listing.",
  );
  return { listing, screenshots };
}

async function all(api: AppleAPI, path: string) {
  const items: any[] = [];
  for (let page = 0; path && page < 20; page++) {
    const response = await api.request(path);
    items.push(...response.data);
    const next = response.links?.next as string | undefined;
    if (!next) break;
    const url = new URL(next);
    invariant(
      url.origin === "https://api.appstoreconnect.apple.com" &&
        url.pathname.startsWith("/v1/"),
      "APPLE_PAGE",
      "Invalid Apple pagination link.",
    );
    path = url.pathname.slice(3) + url.search;
  }
  return items;
}

const EDITABLE = [
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
];
const stateOf = (x: any) =>
  x?.attributes?.appVersionState ?? x?.attributes?.appStoreState;

export interface FieldChange {
  scope: "app" | "version" | "review";
  field: string;
  before: string;
  after: string;
}

export interface ListingPlan {
  appId: string;
  version: string;
  versionId?: string;
  versionState?: string;
  appInfoId: string;
  appInfoLocalizationId?: string;
  versionLocalizationId?: string;
  reviewDetailId?: string;
  locale: string;
  changes: FieldChange[];
  categories: Record<string, string>;
  contentRights?: string;
  screenshots: {
    displayType?: string;
    keep: boolean;
    current: number;
    upload: string[];
  };
  build?: { id: string; number: string; attached: boolean };
  inAppPurchases: { productId: string; id?: string; state?: string }[];
  /** Things App Review will refuse; an API key can't fix some of them. */
  blockers: string[];
  /** Things to check by hand in App Store Connect. */
  manual: string[];
}

/** Reads App Store Connect and works out what applying `listing` would do. */
export async function listingPlan(
  api: AppleAPI,
  bundleId: string,
  version: string,
  { listing, screenshots }: Awaited<ReturnType<typeof loadListing>>,
  buildNumber?: string,
): Promise<ListingPlan> {
  const app = await api.app(bundleId);
  const locale = listing.locale;
  const changes: FieldChange[] = [];
  const diff = (
    scope: FieldChange["scope"],
    current: Record<string, any> | undefined,
    wanted: Record<string, any>,
  ) => {
    for (const [field, after] of Object.entries(wanted)) {
      if (after === undefined) continue;
      const before = current?.[field] ?? "";
      if (String(before) !== String(after))
        changes.push({
          scope,
          field,
          before: String(before),
          after: String(after),
        });
    }
  };

  // App info: the one still editable (there's a live one too once released).
  const infos = await all(api, `/apps/${app.id}/appInfos?limit=10`);
  const info =
    infos.find((i) =>
      EDITABLE.includes(i.attributes.appStoreState ?? i.attributes.state),
    ) ??
    infos.find(
      (i) =>
        !["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"].includes(
          i.attributes.appStoreState ?? i.attributes.state,
        ),
    ) ??
    infos[0];
  invariant(info, "APPLE_APP_INFO", "Apple returned no app info for this app.");
  const infoLocalization = (
    await all(api, `/appInfos/${info.id}/appInfoLocalizations?limit=50`)
  ).find((l) => l.attributes.locale === locale);
  diff("app", infoLocalization?.attributes, {
    name: listing.name,
    subtitle: listing.subtitle,
    privacyPolicyUrl: listing.privacyPolicyUrl,
  });
  const categories: Record<string, string> = {};
  for (const key of [
    "primaryCategory",
    "primarySubcategoryOne",
    "secondaryCategory",
  ] as const) {
    const wanted = listing[key];
    if (!wanted) continue;
    const current = await api
      .request(`/appInfos/${info.id}/${key}`)
      .then((r) => r.data?.id ?? "")
      .catch(() => "");
    if (current !== wanted) {
      categories[key] = wanted;
      changes.push({
        scope: "app",
        field: key,
        before: current,
        after: wanted,
      });
    }
  }
  const contentRights =
    listing.contentRights &&
    listing.contentRights !== app.attributes.contentRightsDeclaration
      ? listing.contentRights
      : undefined;
  if (contentRights)
    changes.push({
      scope: "app",
      field: "contentRightsDeclaration",
      before: app.attributes.contentRightsDeclaration ?? "",
      after: contentRights,
    });

  // The version.
  const versions = await all(
    api,
    `/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=50`,
  );
  const existing = versions.find((v) => v.attributes.versionString === version);
  const draft = versions.find((v) => EDITABLE.includes(stateOf(v)));
  invariant(
    !existing || EDITABLE.includes(stateOf(existing)),
    "VERSION_NOT_EDITABLE",
    `Version ${version} is ${stateOf(existing)}. Bump the app version, or manage this one in App Store Connect.`,
  );
  // Apple keeps one draft per platform; a draft under another number gets renamed.
  const target = existing ?? draft;
  const live = versions.some((v) =>
    ["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"].includes(stateOf(v)),
  );
  if (target && target.attributes.versionString !== version)
    changes.push({
      scope: "version",
      field: "versionString",
      before: target.attributes.versionString,
      after: version,
    });
  let versionLocalization: any;
  let reviewDetail: any;
  let attachedBuild: string | undefined;
  let currentShots: any[] = [];
  if (target) {
    versionLocalization = (
      await all(
        api,
        `/appStoreVersions/${target.id}/appStoreVersionLocalizations?limit=50`,
      )
    ).find((l) => l.attributes.locale === locale);
    reviewDetail = await api
      .request(`/appStoreVersions/${target.id}/appStoreReviewDetail`)
      .then((r) => r.data ?? undefined)
      .catch(() => undefined);
    attachedBuild = await api
      .request(`/appStoreVersions/${target.id}/build`)
      .then((r) => r.data?.id)
      .catch(() => undefined);
  }
  diff(
    "version",
    {
      ...versionLocalization?.attributes,
      copyright: target?.attributes.copyright,
    },
    {
      description: listing.description,
      keywords: listing.keywords,
      promotionalText: listing.promotionalText,
      supportUrl: listing.supportUrl,
      marketingUrl: listing.marketingUrl,
      // Apple refuses "What's New" on an app's first version.
      whatsNew: live ? listing.whatsNew : undefined,
      copyright: listing.copyright,
    },
  );
  if (listing.review) {
    const { notes, ...contact } = listing.review;
    diff("review", reviewDetail?.attributes, { ...contact, notes });
  }

  // Screenshots: replaced as a set, and only if anything differs.
  const displayType = screenshots[0]?.displayType;
  if (versionLocalization && displayType) {
    const set = (
      await all(
        api,
        `/appStoreVersionLocalizations/${versionLocalization.id}/appScreenshotSets?limit=50`,
      )
    ).find((s) => s.attributes.screenshotDisplayType === displayType);
    if (set)
      currentShots = await all(
        api,
        `/appScreenshotSets/${set.id}/appScreenshots?limit=50`,
      );
  }
  const keep =
    currentShots.length === screenshots.length &&
    currentShots.every(
      (s, i) =>
        s.attributes.sourceFileChecksum === screenshots[i]!.checksum &&
        s.attributes.assetDeliveryState?.state === "COMPLETE",
    );

  // The build: the one asked for, or the newest processed build of this version.
  let build: ListingPlan["build"];
  const builds = (
    await api.request(
      `/builds?filter[app]=${app.id}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&filter[processingState]=VALID&filter[expired]=false&sort=-uploadedDate&limit=50`,
    )
  ).data as any[];
  const chosen = buildNumber
    ? builds.find((b) => b.attributes.version === buildNumber)
    : builds[0];
  if (chosen)
    build = {
      id: chosen.id,
      number: chosen.attributes.version,
      attached: chosen.id === attachedBuild,
    };

  // In-app purchases to review alongside.
  const iaps = listing.inAppPurchases?.length
    ? await all(api, `/apps/${app.id}/inAppPurchasesV2?limit=200`)
    : [];
  const inAppPurchases = (listing.inAppPurchases ?? []).map((productId) => {
    const found = iaps.find((p) => p.attributes.productId === productId);
    return { productId, id: found?.id, state: found?.attributes.state };
  });

  const blockers: string[] = [];
  if (!build)
    blockers.push(
      buildNumber
        ? `Build ${buildNumber} of ${version} isn't processed in App Store Connect.`
        : `No processed build of ${version} in App Store Connect yet.`,
    );
  if (!screenshots.length && !currentShots.length)
    blockers.push("No iPhone screenshots.");
  const after = (scope: string, field: string, current: any) =>
    changes.find((c) => c.scope === scope && c.field === field)?.after ??
    current;
  if (
    !after(
      "app",
      "privacyPolicyUrl",
      infoLocalization?.attributes.privacyPolicyUrl,
    )
  )
    blockers.push("No privacy policy URL.");
  if (
    !after("version", "supportUrl", versionLocalization?.attributes.supportUrl)
  )
    blockers.push("No support URL.");
  if (
    !after(
      "version",
      "description",
      versionLocalization?.attributes.description,
    )
  )
    blockers.push("No description.");
  if (
    !after(
      "app",
      "contentRightsDeclaration",
      app.attributes.contentRightsDeclaration,
    )
  )
    blockers.push("Content rights aren't declared (set contentRights).");
  const review = { ...reviewDetail?.attributes, ...listing.review };
  if (!review.contactEmail || !review.contactPhone)
    blockers.push(
      "App Review contact details are incomplete (review.contactEmail, review.contactPhone).",
    );
  for (const iap of inAppPurchases) {
    if (!iap.id)
      blockers.push(
        `In-app purchase ${iap.productId} doesn't exist in App Store Connect.`,
      );
    else if (
      ![
        "READY_TO_SUBMIT",
        "WAITING_FOR_REVIEW",
        "IN_REVIEW",
        "APPROVED",
      ].includes(iap.state ?? "")
    )
      blockers.push(
        `In-app purchase ${iap.productId} is ${iap.state}: it needs a price, a localization and a review screenshot.`,
      );
  }

  return {
    appId: app.id,
    version,
    versionId: target?.id,
    versionState: stateOf(target),
    appInfoId: info.id,
    appInfoLocalizationId: infoLocalization?.id,
    versionLocalizationId: versionLocalization?.id,
    reviewDetailId: reviewDetail?.id,
    locale,
    changes,
    categories,
    contentRights,
    screenshots: {
      displayType,
      keep: keep || !screenshots.length,
      current: currentShots.length,
      upload: keep ? [] : screenshots.map((s) => s.name),
    },
    build,
    inAppPurchases,
    blockers,
    // The API can't read or set these; App Review checks them.
    manual: [
      "App Privacy answers (App Store Connect → App Privacy)",
      "Age rating questionnaire",
      "Price and availability",
    ],
  };
}

/** Writes a plan from `listingPlan`. Submits for review only when asked. */
export async function applyListing(
  api: AppleAPI,
  plan: ListingPlan,
  { screenshots }: Awaited<ReturnType<typeof loadListing>>,
  options: {
    submit?: boolean;
    fetcher?: typeof fetch;
    log?: (line: string) => void;
    wait?: (ms: number) => Promise<void>;
  } = {},
) {
  const log = options.log ?? (() => undefined);
  const fetcher = options.fetcher ?? fetch;
  const wait =
    options.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pick = (scope: string) =>
    Object.fromEntries(
      plan.changes
        .filter((c) => c.scope === scope)
        .map((c) => [c.field, c.after]),
    );

  // App info.
  const appFields = pick("app");
  const {
    contentRightsDeclaration,
    primaryCategory,
    primarySubcategoryOne,
    secondaryCategory,
    ...infoFields
  } = appFields;
  if (Object.keys(infoFields).length) {
    if (plan.appInfoLocalizationId)
      await api.request(
        `/appInfoLocalizations/${plan.appInfoLocalizationId}`,
        "PATCH",
        {
          data: {
            type: "appInfoLocalizations",
            id: plan.appInfoLocalizationId,
            attributes: infoFields,
          },
        },
      );
    else
      await api.request("/appInfoLocalizations", "POST", {
        data: {
          type: "appInfoLocalizations",
          attributes: { ...infoFields, locale: plan.locale },
          relationships: {
            appInfo: { data: { type: "appInfos", id: plan.appInfoId } },
          },
        },
      });
    log(`App info: ${Object.keys(infoFields).join(", ")}`);
  }
  if (Object.keys(plan.categories).length) {
    await api.request(`/appInfos/${plan.appInfoId}`, "PATCH", {
      data: {
        type: "appInfos",
        id: plan.appInfoId,
        relationships: Object.fromEntries(
          Object.entries(plan.categories).map(([key, id]) => [
            key,
            { data: { type: "appCategories", id } },
          ]),
        ),
      },
    });
    log(`Categories: ${Object.values(plan.categories).join(", ")}`);
  }
  if (plan.contentRights) {
    await api.request(`/apps/${plan.appId}`, "PATCH", {
      data: {
        type: "apps",
        id: plan.appId,
        attributes: { contentRightsDeclaration: plan.contentRights },
      },
    });
    log("Content rights declared");
  }

  // The version and its localization.
  let versionId = plan.versionId;
  const { copyright, versionString, ...localized } = pick("version");
  if (!versionId) {
    versionId = (
      await api.request("/appStoreVersions", "POST", {
        data: {
          type: "appStoreVersions",
          attributes: {
            platform: "IOS",
            versionString: plan.version,
            releaseType: "MANUAL",
            ...(copyright ? { copyright } : {}),
          },
          relationships: { app: { data: { type: "apps", id: plan.appId } } },
        },
      })
    ).data.id;
    log(`Created version ${plan.version}`);
  } else if (copyright || versionString) {
    await api.request(`/appStoreVersions/${versionId}`, "PATCH", {
      data: {
        type: "appStoreVersions",
        id: versionId,
        attributes: {
          ...(copyright ? { copyright } : {}),
          ...(versionString ? { versionString } : {}),
        },
      },
    });
  }
  let localizationId = plan.versionLocalizationId;
  if (!localizationId) {
    const existing = (
      await all(
        api,
        `/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=50`,
      )
    ).find((l) => l.attributes.locale === plan.locale);
    localizationId = existing?.id;
  }
  if (localizationId && Object.keys(localized).length)
    await api.request(
      `/appStoreVersionLocalizations/${localizationId}`,
      "PATCH",
      {
        data: {
          type: "appStoreVersionLocalizations",
          id: localizationId,
          attributes: localized,
        },
      },
    );
  else if (!localizationId)
    localizationId = (
      await api.request("/appStoreVersionLocalizations", "POST", {
        data: {
          type: "appStoreVersionLocalizations",
          attributes: { ...localized, locale: plan.locale },
          relationships: {
            appStoreVersion: {
              data: { type: "appStoreVersions", id: versionId },
            },
          },
        },
      })
    ).data.id;
  if (Object.keys(localized).length)
    log(`Version text: ${Object.keys(localized).join(", ")}`);

  // App Review contact and notes.
  const review = pick("review");
  if (Object.keys(review).length) {
    const attributes = {
      ...review,
      ...(review.demoAccountRequired !== undefined
        ? { demoAccountRequired: review.demoAccountRequired === "true" }
        : {}),
    };
    if (plan.reviewDetailId)
      await api.request(
        `/appStoreReviewDetails/${plan.reviewDetailId}`,
        "PATCH",
        {
          data: {
            type: "appStoreReviewDetails",
            id: plan.reviewDetailId,
            attributes,
          },
        },
      );
    else
      await api.request("/appStoreReviewDetails", "POST", {
        data: {
          type: "appStoreReviewDetails",
          attributes,
          relationships: {
            appStoreVersion: {
              data: { type: "appStoreVersions", id: versionId },
            },
          },
        },
      });
    log(`Review details: ${Object.keys(review).join(", ")}`);
  }

  // Screenshots.
  if (!plan.screenshots.keep && screenshots.length) {
    const displayType = plan.screenshots.displayType!;
    let set = (
      await all(
        api,
        `/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?limit=50`,
      )
    ).find((s) => s.attributes.screenshotDisplayType === displayType);
    if (set)
      for (const old of await all(
        api,
        `/appScreenshotSets/${set.id}/appScreenshots?limit=50`,
      ))
        await api.request(`/appScreenshots/${old.id}`, "DELETE");
    else
      set = (
        await api.request("/appScreenshotSets", "POST", {
          data: {
            type: "appScreenshotSets",
            attributes: { screenshotDisplayType: displayType },
            relationships: {
              appStoreVersionLocalization: {
                data: {
                  type: "appStoreVersionLocalizations",
                  id: localizationId,
                },
              },
            },
          },
        })
      ).data;
    for (const shot of screenshots) {
      const reserved = (
        await api.request("/appScreenshots", "POST", {
          data: {
            type: "appScreenshots",
            attributes: { fileName: shot.name, fileSize: shot.size },
            relationships: {
              appScreenshotSet: {
                data: { type: "appScreenshotSets", id: set.id },
              },
            },
          },
        })
      ).data;
      const data = await readFile(shot.path);
      for (const op of reserved.attributes.uploadOperations ?? []) {
        const response = await fetcher(op.url, {
          method: op.method,
          headers: Object.fromEntries(
            (op.requestHeaders ?? []).map((h: any) => [h.name, h.value]),
          ),
          body: data.subarray(op.offset, op.offset + op.length),
        });
        invariant(
          response.ok,
          "SCREENSHOT_UPLOAD",
          `Uploading ${shot.name} failed (${response.status}).`,
        );
      }
      await api.request(`/appScreenshots/${reserved.id}`, "PATCH", {
        data: {
          type: "appScreenshots",
          id: reserved.id,
          attributes: { uploaded: true, sourceFileChecksum: shot.checksum },
        },
      });
      log(`Screenshot ${shot.name}`);
    }
    // Apple processes uploads asynchronously; review needs them complete.
    for (let tries = 0; ; tries++) {
      const states = (
        await all(api, `/appScreenshotSets/${set.id}/appScreenshots?limit=50`)
      ).map((s) => s.attributes.assetDeliveryState?.state);
      invariant(
        !states.includes("FAILED"),
        "SCREENSHOT_PROCESSING",
        "Apple couldn't process a screenshot.",
      );
      if (states.every((s) => s === "COMPLETE")) break;
      invariant(
        tries < 60,
        "SCREENSHOT_PROCESSING",
        "Screenshots are still processing at Apple. Run again shortly.",
      );
      await wait(3000);
    }
  }

  // The build.
  if (plan.build && !plan.build.attached) {
    await api.request(
      `/appStoreVersions/${versionId}/relationships/build`,
      "PATCH",
      {
        data: { type: "builds", id: plan.build.id },
      },
    );
    log(`Build ${plan.build.number} attached`);
  }

  if (!options.submit) return { versionId, submitted: false };

  invariant(
    !plan.blockers.length,
    "LISTING_BLOCKED",
    `Not submitting for review: ${plan.blockers.join(" ")}`,
  );
  // In-app purchases ride along with the version's submission.
  for (const iap of plan.inAppPurchases) {
    if (iap.state !== "READY_TO_SUBMIT") continue;
    await api.request("/inAppPurchaseSubmissions", "POST", {
      data: {
        type: "inAppPurchaseSubmissions",
        relationships: {
          inAppPurchaseV2: { data: { type: "inAppPurchases", id: iap.id } },
        },
      },
    });
    log(`In-app purchase ${iap.productId} added to review`);
  }
  const open = (
    await all(
      api,
      `/reviewSubmissions?filter[app]=${plan.appId}&filter[platform]=IOS&limit=50`,
    )
  ).find((s) => s.attributes.state === "READY_FOR_REVIEW");
  const submission =
    open ??
    (
      await api.request("/reviewSubmissions", "POST", {
        data: {
          type: "reviewSubmissions",
          attributes: { platform: "IOS" },
          relationships: { app: { data: { type: "apps", id: plan.appId } } },
        },
      })
    ).data;
  const items = open
    ? await all(api, `/reviewSubmissions/${submission.id}/items?limit=50`)
    : [];
  if (
    !items.some((i) => i.relationships?.appStoreVersion?.data?.id === versionId)
  )
    await api.request("/reviewSubmissionItems", "POST", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: {
            data: { type: "reviewSubmissions", id: submission.id },
          },
          appStoreVersion: {
            data: { type: "appStoreVersions", id: versionId },
          },
        },
      },
    });
  await api.request(`/reviewSubmissions/${submission.id}`, "PATCH", {
    data: {
      type: "reviewSubmissions",
      id: submission.id,
      attributes: { submitted: true },
    },
  });
  log(`Submitted ${plan.version} for App Review`);
  return { versionId, submitted: true };
}
