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
    /**
     * In-app purchases to send to review with this version: product IDs, or
     * product JSON files (relative to the listing) that can create them.
     */
    inAppPurchases: z.array(z.string()).optional(),
  })
  .loose();
export type Listing = z.infer<typeof listingSchema>;

/** An in-app purchase definition, enough to create it in App Store Connect. */
export const productSchema = z
  .object({
    productId: z.string(),
    type: z.enum(["CONSUMABLE", "NON_CONSUMABLE"]),
    appleReferenceName: z.string().max(64),
    displayName: z.string().max(30),
    appleDescription: z.string().max(45),
    appleReviewNotes: text(4000),
    /** US price in dollars, such as "0.99"; other territories follow Apple's equalization. */
    applePrice: z.string().regex(/^\d+\.\d\d$/),
    /** PNG of the purchase in the app, for App Review (relative to the product file). */
    appleReviewScreenshot: z.string(),
    familySharable: z.boolean().optional(),
  })
  .loose();
export type Product = z.infer<typeof productSchema> & {
  screenshot: { path: string; name: string; size: number; checksum: string };
};

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
  const products: Product[] = [];
  const productIds: string[] = [];
  for (const entry of listing.inAppPurchases ?? []) {
    if (!entry.endsWith(".json")) {
      productIds.push(entry);
      continue;
    }
    const file = resolve(dirname(path), entry);
    const parsed = productSchema.safeParse(
      JSON.parse(await readFile(file, "utf8")),
    );
    invariant(
      parsed.success,
      "PRODUCT_INVALID",
      `Product ${entry}: ${parsed.error?.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
    const shot = resolve(dirname(file), parsed.data.appleReviewScreenshot);
    const data = await readFile(shot);
    pngSize(data);
    products.push({
      ...parsed.data,
      screenshot: {
        path: shot,
        name: shot.split("/").pop()!,
        size: data.length,
        checksum: createHash("md5").update(data).digest("hex"),
      },
    });
    productIds.push(parsed.data.productId);
  }
  return { listing, screenshots, products, productIds };
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
        /^\/v[12]\//.test(url.pathname),
      "APPLE_PAGE",
      "Invalid Apple pagination link.",
    );
    // AppleAPI adds /v1 itself; /v2/ paths are passed whole.
    path = url.pathname.startsWith("/v1/")
      ? url.pathname.slice(3) + url.search
      : url.pathname + url.search;
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
    setId?: string;
    /** Uploaded and matching, but Apple hasn't finished processing them. */
    processing: boolean;
    keep: boolean;
    current: number;
    upload: string[];
  };
  build?: { id: string; number: string; attached: boolean };
  inAppPurchases: {
    productId: string;
    id?: string;
    state?: string;
    /** Missing, and the listing defines it: `--apply` creates it. */
    create?: boolean;
  }[];
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
  {
    listing,
    screenshots,
    products,
    productIds,
  }: Awaited<ReturnType<typeof loadListing>>,
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
  let setId: string | undefined;
  if (versionLocalization && displayType) {
    const set = (
      await all(
        api,
        `/appStoreVersionLocalizations/${versionLocalization.id}/appScreenshotSets?limit=50`,
      )
    ).find((s) => s.attributes.screenshotDisplayType === displayType);
    setId = set?.id;
    if (set)
      currentShots = await all(
        api,
        `/appScreenshotSets/${set.id}/appScreenshots?limit=50`,
      );
  }
  const shotState = (s: any) => s.attributes.assetDeliveryState?.state;
  // Matching uploads still being processed count as done; a rerun shouldn't resend them.
  const keep =
    currentShots.length === screenshots.length &&
    currentShots.every(
      (s, i) =>
        s.attributes.sourceFileChecksum === screenshots[i]!.checksum &&
        shotState(s) !== "FAILED",
    );
  const processing =
    keep && currentShots.some((s) => shotState(s) !== "COMPLETE");

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
  const iaps = productIds.length
    ? await all(api, `/apps/${app.id}/inAppPurchasesV2?limit=200`)
    : [];
  const inAppPurchases = productIds.map((productId) => {
    const found = iaps.find((p) => p.attributes.productId === productId);
    if (!found)
      return {
        productId,
        create: products.some((p) => p.productId === productId),
      };
    return { productId, id: found.id, state: found.attributes.state };
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
  if (processing) blockers.push("Apple is still processing the screenshots.");
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
    if (iap.create) continue;
    if (!iap.id)
      blockers.push(
        `In-app purchase ${iap.productId} doesn't exist in App Store Connect; add a product JSON to create it.`,
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
      setId,
      processing,
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

/** Sends a file to the upload operations Apple handed back for a reserved asset. */
async function uploadParts(
  fetcher: typeof fetch,
  operations: any[] | undefined,
  file: { path: string; name: string },
) {
  const data = await readFile(file.path);
  for (const op of operations ?? []) {
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
      `Uploading ${file.name} failed (${response.status}).`,
    );
  }
}

/**
 * Creates an in-app purchase with everything App Review needs: a localization,
 * a US price (other territories equalized by Apple), availability everywhere
 * the app is, and the review screenshot.
 */
export async function createInAppPurchase(
  api: AppleAPI,
  appId: string,
  product: Product,
  locale: string,
  fetcher: typeof fetch = fetch,
) {
  const id = (
    await api.request("/v2/inAppPurchases", "POST", {
      data: {
        type: "inAppPurchases",
        attributes: {
          name: product.appleReferenceName,
          productId: product.productId,
          inAppPurchaseType: product.type,
          reviewNote: product.appleReviewNotes,
          familySharable: product.familySharable ?? false,
        },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    })
  ).data.id as string;
  await api.request("/inAppPurchaseLocalizations", "POST", {
    data: {
      type: "inAppPurchaseLocalizations",
      attributes: {
        locale,
        name: product.displayName,
        description: product.appleDescription,
      },
      relationships: {
        inAppPurchaseV2: { data: { type: "inAppPurchases", id } },
      },
    },
  });
  const point = (
    await all(
      api,
      `/v2/inAppPurchases/${id}/pricePoints?filter[territory]=USA&limit=200`,
    )
  ).find((p) => p.attributes.customerPrice === product.applePrice);
  invariant(
    point,
    "IAP_PRICE",
    `Apple has no US price point of $${product.applePrice} for ${product.productId}.`,
  );
  await api.request("/inAppPurchasePriceSchedules", "POST", {
    data: {
      type: "inAppPurchasePriceSchedules",
      relationships: {
        inAppPurchase: { data: { type: "inAppPurchases", id } },
        baseTerritory: { data: { type: "territories", id: "USA" } },
        manualPrices: {
          data: [{ type: "inAppPurchasePrices", id: "${price}" }],
        },
      },
    },
    included: [
      {
        type: "inAppPurchasePrices",
        id: "${price}",
        attributes: { startDate: null },
        relationships: {
          inAppPurchasePricePoint: {
            data: { type: "inAppPurchasePricePoints", id: point.id },
          },
        },
      },
    ],
  });
  const territories = await all(api, "/territories?limit=200");
  await api.request("/inAppPurchaseAvailabilities", "POST", {
    data: {
      type: "inAppPurchaseAvailabilities",
      attributes: { availableInNewTerritories: true },
      relationships: {
        inAppPurchase: { data: { type: "inAppPurchases", id } },
        availableTerritories: {
          data: territories.map((t) => ({ type: "territories", id: t.id })),
        },
      },
    },
  });
  const reserved = (
    await api.request("/inAppPurchaseAppStoreReviewScreenshots", "POST", {
      data: {
        type: "inAppPurchaseAppStoreReviewScreenshots",
        attributes: {
          fileName: product.screenshot.name,
          fileSize: product.screenshot.size,
        },
        relationships: {
          inAppPurchaseV2: { data: { type: "inAppPurchases", id } },
        },
      },
    })
  ).data;
  await uploadParts(
    fetcher,
    reserved.attributes.uploadOperations,
    product.screenshot,
  );
  await api.request(
    `/inAppPurchaseAppStoreReviewScreenshots/${reserved.id}`,
    "PATCH",
    {
      data: {
        type: "inAppPurchaseAppStoreReviewScreenshots",
        id: reserved.id,
        attributes: {
          uploaded: true,
          sourceFileChecksum: product.screenshot.checksum,
        },
      },
    },
  );
  return id;
}

/** Writes a plan from `listingPlan`. Submits for review only when asked. */
export async function applyListing(
  api: AppleAPI,
  plan: ListingPlan,
  { screenshots, products }: Awaited<ReturnType<typeof loadListing>>,
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
  let setId = plan.screenshots.processing ? plan.screenshots.setId : undefined;
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
      await uploadParts(fetcher, reserved.attributes.uploadOperations, shot);
      await api.request(`/appScreenshots/${reserved.id}`, "PATCH", {
        data: {
          type: "appScreenshots",
          id: reserved.id,
          attributes: { uploaded: true, sourceFileChecksum: shot.checksum },
        },
      });
      log(`Screenshot ${shot.name}`);
    }
    setId = set.id;
  }

  // Apple processes uploads asynchronously; review needs them complete.
  let processed = !setId;
  for (let tries = 0; setId && tries < 100; tries++) {
    const states = (
      await all(api, `/appScreenshotSets/${setId}/appScreenshots?limit=50`)
    ).map((s) => s.attributes.assetDeliveryState?.state);
    invariant(
      !states.includes("FAILED"),
      "SCREENSHOT_PROCESSING",
      "Apple couldn't process a screenshot.",
    );
    if ((processed = states.every((s) => s === "COMPLETE"))) break;
    await wait(3000);
  }
  if (!processed)
    log("Apple is still processing the screenshots; run again to finish.");

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

  // In-app purchases the listing defines but Apple doesn't have yet.
  for (const iap of plan.inAppPurchases) {
    if (!iap.create) continue;
    const product = products.find((p) => p.productId === iap.productId)!;
    await createInAppPurchase(api, plan.appId, product, plan.locale, fetcher);
    log(`Created in-app purchase ${iap.productId} at $${product.applePrice}`);
  }

  if (!options.submit) return { versionId, submitted: false };

  invariant(
    processed,
    "SCREENSHOT_PROCESSING",
    "Not submitting for review: Apple is still processing the screenshots. Run again shortly.",
  );
  const blockers = plan.blockers.filter(
    (b) => !b.includes("processing the screenshots"),
  );
  invariant(
    !blockers.length,
    "LISTING_BLOCKED",
    `Not submitting for review: ${blockers.join(" ")}`,
  );
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
  // In-app purchases join the draft submission once the version is in it:
  // Apple reviews an app's first purchases together with a version. Ones
  // created just now need a fresh look at their state.
  const iaps = plan.inAppPurchases.length
    ? await all(api, `/apps/${plan.appId}/inAppPurchasesV2?limit=200`)
    : [];
  for (const { productId } of plan.inAppPurchases) {
    const iap = iaps.find((p) => p.attributes.productId === productId);
    invariant(
      iap,
      "IAP_MISSING",
      `In-app purchase ${productId} isn't in App Store Connect.`,
    );
    const state = iap.attributes.state;
    if (state !== "READY_TO_SUBMIT") {
      invariant(
        ["WAITING_FOR_REVIEW", "IN_REVIEW", "APPROVED"].includes(state),
        "IAP_NOT_READY",
        `Not submitting for review: in-app purchase ${productId} is ${state}.`,
      );
      continue;
    }
    await api.request("/inAppPurchaseSubmissions", "POST", {
      data: {
        type: "inAppPurchaseSubmissions",
        relationships: {
          inAppPurchaseV2: { data: { type: "inAppPurchases", id: iap.id } },
        },
      },
    });
    log(`In-app purchase ${productId} added to review`);
  }
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
