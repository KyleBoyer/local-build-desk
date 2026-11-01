import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { invariant } from "./errors";

/**
 * A project's monetization, committed with its source: app price, in-app
 * purchases, subscriptions, offer codes and promo codes on both stores. The
 * file is the desired state. Local Build Desk only manages what it lists, so
 * products made elsewhere are shown but never changed or removed. A change
 * goes to the store right away or with the next release; either way the file
 * holds it, and whatever still differs from the store is what the next
 * release applies.
 */
export const MONETIZATION_FILE = "assets/store/monetization.json";

/** US dollars with cents, such as "0.99"; "0.00" is free. */
const usd = z
  .string()
  .regex(/^\d{1,5}\.\d\d$/, "Use dollars and cents, such as 0.99.");
const productId = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
    "Use letters, digits, dots, dashes or underscores.",
  );
/** "ALL", or Apple territory codes such as USA and GBR. */
const territories = z.union([
  z.literal("ALL"),
  z.array(z.string().regex(/^[A-Z]{3}$/)).min(1),
]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Locale → text, such as { "en-US": { name, description } }. Length limits
 * are generous: the stores enforce their own, and imports must never fail on
 * stricter local ones. */
const localized = <T extends z.ZodRawShape>(shape: T) =>
  z.record(
    z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/),
    z.object(shape).strict(),
  );

const appleOfferDuration = z.enum([
  "THREE_DAYS",
  "ONE_WEEK",
  "TWO_WEEKS",
  "ONE_MONTH",
  "TWO_MONTHS",
  "THREE_MONTHS",
  "SIX_MONTHS",
  "ONE_YEAR",
]);
const appleOfferMode = z.enum(["FREE_TRIAL", "PAY_AS_YOU_GO", "PAY_UP_FRONT"]);

/** A batch of codes. Generated batches keep the store's id; codes themselves
 * are secrets and are saved outside the repository. */
const codeBatch = z
  .object({
    kind: z.enum(["oneTime", "custom"]),
    /** One-time codes to generate, or redemptions a custom code allows. */
    count: z.number().int().min(1).max(25000),
    /** Custom code customers type, such as "LAUNCH50". */
    code: z
      .string()
      .regex(/^[A-Z0-9]{1,64}$/)
      .optional(),
    expires: date.optional(),
    sandbox: z.boolean().optional(),
    /** Set once generated: the store's id for this batch. */
    id: z.string().optional(),
    generatedAt: z.string().optional(),
  })
  .strict()
  .refine((b) => b.kind !== "custom" || b.code, "A custom batch needs a code.")
  .refine(
    (b) => b.kind !== "oneTime" || b.expires,
    "One-time codes need an expiry date.",
  );

export const appleIapSchema = z
  .object({
    productId,
    type: z.enum(["CONSUMABLE", "NON_CONSUMABLE", "NON_RENEWING_SUBSCRIPTION"]),
    /** Internal name in App Store Connect (64 characters). */
    referenceName: z.string().min(1).max(64),
    price: usd,
    territories: territories.default("ALL"),
    familySharable: z.boolean().optional(),
    reviewNote: z.string().max(4000).optional(),
    /** PNG of the purchase in the app for App Review, relative to this file. */
    reviewScreenshot: z.string().optional(),
    localizations: localized({
      name: z.string().min(2).max(200),
      description: z.string().max(1000).optional(),
    }),
  })
  .strict();

export const appleSubscriptionSchema = z
  .object({
    productId,
    referenceName: z.string().min(1).max(64),
    period: z.enum([
      "ONE_WEEK",
      "ONE_MONTH",
      "TWO_MONTHS",
      "THREE_MONTHS",
      "SIX_MONTHS",
      "ONE_YEAR",
    ]),
    /** 1 is the highest level of service in the group. */
    level: z.number().int().min(1).optional(),
    price: usd,
    territories: territories.default("ALL"),
    familySharable: z.boolean().optional(),
    reviewNote: z.string().max(4000).optional(),
    reviewScreenshot: z.string().optional(),
    /** An introductory offer for new subscribers, such as a free week. */
    introOffer: z
      .object({
        mode: appleOfferMode,
        duration: appleOfferDuration,
        periods: z.number().int().min(1).max(12).default(1),
        /** Per period (pay as you go) or in total (pay up front); not for free trials. */
        price: usd.optional(),
      })
      .strict()
      .optional(),
    localizations: localized({
      name: z.string().min(2).max(200),
      description: z.string().max(1000).optional(),
    }),
  })
  .strict();

export const appleGroupSchema = z
  .object({
    referenceName: z.string().min(1).max(64),
    localizations: localized({
      name: z.string().min(2).max(200),
      customAppName: z.string().max(200).optional(),
    }).default({}),
    subscriptions: z.array(appleSubscriptionSchema).default([]),
  })
  .strict();

export const appleOfferCodeSchema = z
  .object({
    /** The offer's name in App Store Connect; unique per product. */
    name: z.string().min(1).max(64),
    /** The in-app purchase or subscription it's for. */
    productId,
    active: z.boolean().default(true),
    /** Subscriptions: NEW, EXISTING, EXPIRED. In-app purchases: NON_SPENDER,
     * ACTIVE_SPENDER, CHURNED_SPENDER. All when omitted. */
    eligibility: z.array(z.string()).optional(),
    /** Subscriptions only. */
    mode: appleOfferMode.optional(),
    duration: appleOfferDuration.optional(),
    periods: z.number().int().min(1).max(12).optional(),
    /** Subscriptions: per period or up front. In-app purchases: the offer price; "0.00" is free. */
    price: usd.optional(),
    batches: z.array(codeBatch).default([]),
  })
  .strict();

const googleListing = localized({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  benefits: z.array(z.string().max(200)).max(10).optional(),
});
/** ISO 8601 durations Play accepts, such as P1W, P1M, P3M, P1Y. */
const isoPeriod = z
  .string()
  .regex(/^P(\d+[DWMY])$/, "Use an ISO period such as P1W, P1M or P1Y.");

export const googleProductSchema = z
  .object({
    productId: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9._]{0,138}$/,
        "Google product IDs use lowercase letters, digits, dots and underscores.",
      ),
    /** USD; Play converts it for every other region. */
    price: usd,
    /** Region-specific prices in local currency, such as { "JP": "160" }. */
    regionalPrices: z
      .record(z.string().regex(/^[A-Z]{2}$/), z.string().regex(/^\d+(\.\d+)?$/))
      .optional(),
    active: z.boolean().default(true),
    listings: googleListing,
  })
  .strict();

const googlePhase = z
  .object({
    duration: isoPeriod,
    /** How many times this phase repeats. */
    recurrence: z.number().int().min(1).max(52).default(1),
    /** "free", or a USD price for each recurrence. */
    price: z.union([z.literal("free"), usd]),
  })
  .strict();

export const googleSubscriptionSchema = z
  .object({
    productId: z.string().regex(/^[a-z0-9][a-z0-9._]{0,138}$/),
    listings: googleListing,
    basePlans: z
      .array(
        z
          .object({
            basePlanId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
            period: isoPeriod,
            /** False for prepaid plans, which don't renew. */
            autoRenewing: z.boolean().default(true),
            price: usd,
            regionalPrices: z
              .record(
                z.string().regex(/^[A-Z]{2}$/),
                z.string().regex(/^\d+(\.\d+)?$/),
              )
              .optional(),
            gracePeriod: z
              .enum(["P0D", "P3D", "P7D", "P14D", "P30D"])
              .optional(),
            active: z.boolean().default(true),
            offers: z
              .array(
                z
                  .object({
                    offerId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
                    /** "new" for first-time subscribers; "developer" when the app chooses who sees it. */
                    eligibility: z.enum(["new", "developer"]).default("new"),
                    phases: z.array(googlePhase).min(1).max(2),
                    active: z.boolean().default(true),
                  })
                  .strict(),
              )
              .default([]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** Play Console promo codes: no API exists, so Local Build Desk creates them
 * in its signed-in Play Console window. */
export const googlePromoSchema = z
  .object({
    name: z.string().min(1).max(50),
    /** A one-time product or subscription ID. */
    productId: z.string(),
    kind: z.enum(["oneTime", "custom"]),
    count: z.number().int().min(1).max(500),
    code: z
      .string()
      .regex(/^[A-Z0-9]{6,20}$/)
      .optional(),
    start: date,
    end: date,
    generatedAt: z.string().optional(),
  })
  .strict()
  .refine(
    (p) => p.kind !== "custom" || p.code,
    "A custom promotion needs a code.",
  );

export const monetizationSchema = z
  .object({
    apple: z
      .object({
        /** The app's own price and where it's sold. */
        app: z.object({ price: usd, territories }).strict().optional(),
        inAppPurchases: z.array(appleIapSchema).default([]),
        subscriptionGroups: z.array(appleGroupSchema).default([]),
        offerCodes: z.array(appleOfferCodeSchema).default([]),
      })
      .strict()
      .default({ inAppPurchases: [], subscriptionGroups: [], offerCodes: [] }),
    google: z
      .object({
        /** A paid app's price in USD. Play Console only; applied there. */
        appPrice: usd.optional(),
        products: z.array(googleProductSchema).default([]),
        subscriptions: z.array(googleSubscriptionSchema).default([]),
        promoCodes: z.array(googlePromoSchema).default([]),
      })
      .strict()
      .default({ products: [], subscriptions: [], promoCodes: [] }),
  })
  .strict();
export type Monetization = z.infer<typeof monetizationSchema>;
export type MonetizationInput = z.input<typeof monetizationSchema>;
export type AppleIap = z.infer<typeof appleIapSchema>;
export type AppleGroup = z.infer<typeof appleGroupSchema>;
export type AppleSubscription = z.infer<typeof appleSubscriptionSchema>;
export type AppleOfferCode = z.infer<typeof appleOfferCodeSchema>;
export type GoogleProduct = z.infer<typeof googleProductSchema>;
export type GoogleSubscription = z.infer<typeof googleSubscriptionSchema>;
export type GooglePromo = z.infer<typeof googlePromoSchema>;
export type CodeBatch = z.infer<typeof codeBatch>;

export const emptyMonetization = (): Monetization =>
  monetizationSchema.parse({});

/** Stable keys naming one managed item, for "apply now" and change lists. */
export type ItemKey =
  | "apple:app"
  | `apple:iap:${string}`
  | `apple:group:${string}`
  | `apple:subscription:${string}`
  | `apple:offer:${string}:${string}`
  | "google:appPrice"
  | `google:product:${string}`
  | `google:subscription:${string}`
  | `google:promo:${string}`;

export function itemKeys(m: Monetization): ItemKey[] {
  return [
    ...(m.apple.app ? (["apple:app"] as const) : []),
    ...m.apple.inAppPurchases.map((p) => `apple:iap:${p.productId}` as const),
    ...m.apple.subscriptionGroups.flatMap((g) => [
      `apple:group:${g.referenceName}` as const,
      ...g.subscriptions.map(
        (s) => `apple:subscription:${s.productId}` as const,
      ),
    ]),
    ...m.apple.offerCodes.map(
      (o) => `apple:offer:${o.productId}:${o.name}` as const,
    ),
    ...(m.google.appPrice !== undefined ? (["google:appPrice"] as const) : []),
    ...m.google.products.map((p) => `google:product:${p.productId}` as const),
    ...m.google.subscriptions.map(
      (s) => `google:subscription:${s.productId}` as const,
    ),
    ...m.google.promoCodes.map((p) => `google:promo:${p.name}` as const),
  ];
}

/** Problems a schema can't express: duplicates and dangling references. */
export function monetizationProblems(m: Monetization) {
  const problems: string[] = [];
  const dupes = (label: string, values: string[]) => {
    const seen = new Set<string>();
    for (const v of values) {
      if (seen.has(v)) problems.push(`${label} ${v} is listed twice.`);
      seen.add(v);
    }
  };
  const appleProducts = [
    ...m.apple.inAppPurchases.map((p) => p.productId),
    ...m.apple.subscriptionGroups.flatMap((g) =>
      g.subscriptions.map((s) => s.productId),
    ),
  ];
  dupes("Apple product", appleProducts);
  dupes(
    "Subscription group",
    m.apple.subscriptionGroups.map((g) => g.referenceName),
  );
  dupes(
    "Offer code",
    m.apple.offerCodes.map((o) => `${o.productId}/${o.name}`),
  );
  const subscriptions = new Set(
    m.apple.subscriptionGroups.flatMap((g) =>
      g.subscriptions.map((s) => s.productId),
    ),
  );
  for (const offer of m.apple.offerCodes) {
    if (subscriptions.has(offer.productId)) {
      if (!offer.mode || !offer.duration)
        problems.push(
          `Offer code ${offer.name} needs a mode and duration for subscription ${offer.productId}.`,
        );
      if (offer.mode && offer.mode !== "FREE_TRIAL" && !offer.price)
        problems.push(`Offer code ${offer.name} needs a price.`);
    } else if (offer.price === undefined)
      problems.push(
        `Offer code ${offer.name} needs an offer price ("0.00" for free).`,
      );
    dupes(
      `Custom code in ${offer.name}:`,
      offer.batches.flatMap((b) => (b.code ? [b.code] : [])),
    );
  }
  for (const group of m.apple.subscriptionGroups)
    for (const s of group.subscriptions)
      if (
        s.introOffer &&
        s.introOffer.mode !== "FREE_TRIAL" &&
        !s.introOffer.price
      )
        problems.push(
          `The introductory offer on ${s.productId} needs a price.`,
        );
  dupes("Google product", [
    ...m.google.products.map((p) => p.productId),
    ...m.google.subscriptions.map((s) => s.productId),
  ]);
  dupes(
    "Promotion",
    m.google.promoCodes.map((p) => p.name),
  );
  for (const s of m.google.subscriptions) {
    dupes(
      `Base plan in ${s.productId}:`,
      s.basePlans.map((b) => b.basePlanId),
    );
    for (const plan of s.basePlans)
      dupes(
        `Offer in ${s.productId}/${plan.basePlanId}:`,
        plan.offers.map((o) => o.offerId),
      );
  }
  const googleIds = new Set([
    ...m.google.products.map((p) => p.productId),
    ...m.google.subscriptions.map((s) => s.productId),
  ]);
  for (const promo of m.google.promoCodes) {
    if (promo.end < promo.start)
      problems.push(`Promotion ${promo.name} ends before it starts.`);
    if (!googleIds.has(promo.productId))
      problems.push(
        `Promotion ${promo.name} is for ${promo.productId}, which isn't in this file.`,
      );
  }
  return problems;
}

/** One product, price or code set, compared between the file and the store. */
export interface StoreItem {
  key: ItemKey | `${"apple" | "google"}:unmanaged:${string}`;
  store: "apple" | "google";
  kind:
    | "app"
    | "iap"
    | "group"
    | "subscription"
    | "offer"
    | "product"
    | "promo"
    | "appPrice";
  label: string;
  /** Listed in the monetization file. */
  managed: boolean;
  /** The store has it. */
  exists: boolean;
  /** The store's own state, such as READY_TO_SUBMIT or ACTIVE. */
  state?: string;
  /** What applying would change: empty when the store matches the file. */
  changes: string[];
  /** Differences that can't be applied, such as fields stores lock after creation. */
  warnings: string[];
  /** The store's current price, in USD where it has one. */
  price?: string;
  /** Something the store reviews before it goes live, such as a new purchase. */
  needsReview?: boolean;
  /** The store wasn't read, so nothing is known about this item there. */
  unknown?: boolean;
}

export async function loadMonetization(path: string): Promise<Monetization> {
  const text = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return emptyMonetization();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    invariant(
      false,
      "MONETIZATION_JSON",
      `${path} isn't valid JSON. Fix its syntax first.`,
    );
  }
  const parsed = monetizationSchema.safeParse(raw);
  invariant(
    parsed.success,
    "MONETIZATION_FILE",
    `${path}: ${parsed.error?.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "file"}: ${i.message}`)
      .join("; ")}`,
  );
  return parsed.data;
}

/** Writes the file atomically, dropping empty sections so diffs stay small. */
export async function saveMonetization(path: string, value: MonetizationInput) {
  const parsed = monetizationSchema.parse(value);
  const problems = monetizationProblems(parsed);
  invariant(!problems.length, "MONETIZATION_INVALID", problems.join(" "));
  const prune = (section: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(section).filter(
        ([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0),
      ),
    );
  const apple = prune(parsed.apple),
    google = prune(parsed.google);
  const output = {
    ...(Object.keys(apple).length ? { apple } : {}),
    ...(Object.keys(google).length ? { google } : {}),
  };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(output, null, 2) + "\n");
  await rename(temporary, path);
  return parsed;
}
