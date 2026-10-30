import { createHash } from "node:crypto";
import { z } from "zod";
import { invariant } from "./errors";
import type { AppleAPI } from "./stores";
import {
  DATA_TYPES,
  LEVEL_QUESTIONS,
  PURPOSES,
  YES_NO_QUESTIONS,
} from "./app-store-questions";
export { DATA_TYPES, LEVEL_QUESTIONS, PURPOSES, YES_NO_QUESTIONS };

// The App Store's compliance questions: age rating, App Privacy and price and
// availability. The answers live in the listing file next to the listing text,
// together with an attestation (who confirmed them, when, and a digest of the
// answers they confirmed). Nothing here is sent to Apple unless the attestation
// matches the answers exactly, so editing an answer means attesting again.
//
// Age rating and pricing use the App Store Connect API. App Privacy has no API
// for API keys; it goes through App Store Connect's web API (`/iris/v1`) in the
// person's own signed-in session, the same requests the website makes.

/** Apple's content levels. `INFREQUENT_OR_MILD`/`FREQUENT_OR_INTENSE` are the deprecated spellings. */
const level = z.enum(["NONE", "INFREQUENT", "FREQUENT"]);
export type Level = z.infer<typeof level>;

export const ageRatingSchema = z
  .object({
    ...(Object.fromEntries(
      Object.keys(LEVEL_QUESTIONS).map((k) => [k, level]),
    ) as Record<keyof typeof LEVEL_QUESTIONS, typeof level>),
    ...(Object.fromEntries(
      Object.keys(YES_NO_QUESTIONS).map((k) => [k, z.boolean()]),
    ) as Record<keyof typeof YES_NO_QUESTIONS, z.ZodBoolean>),
    /** Only for apps in the Kids category. */
    kidsAgeBand: z
      .enum(["FIVE_AND_UNDER", "SIX_TO_EIGHT", "NINE_TO_ELEVEN"])
      .optional(),
    /** Rate the app higher than its answers would. */
    ageRatingOverrideV2: z
      .enum([
        "NONE",
        "NINE_PLUS",
        "THIRTEEN_PLUS",
        "SIXTEEN_PLUS",
        "EIGHTEEN_PLUS",
        "UNRATED",
      ])
      .optional(),
  })
  .strict();
export type AgeRating = z.infer<typeof ageRatingSchema>;

const dataTypeIds = Object.values(DATA_TYPES).flatMap((g) => Object.keys(g));
export const appPrivacySchema = z.discriminatedUnion("collected", [
  z.object({ collected: z.literal(false) }).strict(),
  z
    .object({
      collected: z.literal(true),
      data: z
        .array(
          z
            .object({
              type: z.string().refine((t) => dataTypeIds.includes(t), {
                message: "isn't one of Apple's data types",
              }),
              purposes: z
                .array(
                  z.enum(
                    Object.keys(PURPOSES) as [keyof typeof PURPOSES, ...[]],
                  ),
                )
                .min(1),
              /** Collected data tied to the user's identity. */
              linkedToUser: z.boolean(),
              /** Used to track the user across other companies' apps or websites. */
              usedForTracking: z.boolean(),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
]);
export type AppPrivacy = z.infer<typeof appPrivacySchema>;

export const pricingSchema = z
  .object({
    /** US price in dollars; "0.00" is free. Other territories follow Apple's equalization. */
    price: z.string().regex(/^\d+\.\d\d$/),
    /** "ALL", or Apple territory codes such as USA and GBR. */
    territories: z.union([
      z.literal("ALL"),
      z.array(z.string().regex(/^[A-Z]{3}$/)).min(1),
    ]),
  })
  .strict();
export type Pricing = z.infer<typeof pricingSchema>;

export const attestationSchema = z
  .object({
    name: z.string().min(2),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** sha256 of the answers attested to. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type Attestation = z.infer<typeof attestationSchema>;

export interface Compliance {
  ageRating?: AgeRating;
  appPrivacy?: AppPrivacy;
  pricing?: Pricing;
  attestation?: Attestation;
}

/** What the attestation covers: the answers, in a stable order. */
export function complianceDigest(c: Compliance) {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, stable((value as any)[k])]),
          )
        : value;
  return createHash("sha256")
    .update(
      JSON.stringify(
        stable({
          ageRating: c.ageRating ?? null,
          appPrivacy: c.appPrivacy ?? null,
          pricing: c.pricing ?? null,
        }),
      ),
    )
    .digest("hex");
}

export const hasAnswers = (c: Compliance) =>
  !!(c.ageRating || c.appPrivacy || c.pricing);

export const isAttested = (c: Compliance) =>
  !!c.attestation && c.attestation.digest === complianceDigest(c);

export function attest(c: Compliance, name: string, date: string) {
  return { ...c, attestation: { name, date, digest: complianceDigest(c) } };
}

const levelText = {
  NONE: "none",
  INFREQUENT: "infrequent",
  FREQUENT: "frequent",
};

/** The answers as plain statements, for the dry run and the desktop review. */
export function complianceStatements(c: Compliance, appName: string): string[] {
  const out: string[] = [];
  if (c.ageRating) {
    const r = c.ageRating;
    const present = (
      Object.keys(LEVEL_QUESTIONS) as (keyof typeof LEVEL_QUESTIONS)[]
    )
      .filter((k) => r[k] !== "NONE")
      .map((k) => `${LEVEL_QUESTIONS[k].toLowerCase()} (${levelText[r[k]]})`);
    const yes = (
      Object.keys(YES_NO_QUESTIONS) as (keyof typeof YES_NO_QUESTIONS)[]
    )
      .filter((k) => r[k])
      .map((k) => YES_NO_QUESTIONS[k].toLowerCase());
    out.push(
      present.length
        ? `${appName} contains: ${present.join(", ")}.`
        : `${appName} contains none of Apple's age-rating content types (violence, weapons, profanity, horror, mature or sexual themes, drugs, medical information, gambling or contests).`,
    );
    out.push(
      yes.length
        ? `${appName} has: ${yes.join(", ")}.`
        : `${appName} has no real-money gambling, loot boxes, ads, user-generated content, messaging, social media, unrestricted web access, health topics, parental controls or age assurance.`,
    );
    if (r.ageRatingOverrideV2 && r.ageRatingOverrideV2 !== "NONE")
      out.push(
        `Rate it at least ${r.ageRatingOverrideV2.replace(/_/g, " ").toLowerCase()}.`,
      );
    if (r.kidsAgeBand)
      out.push(
        `Made for kids: ${r.kidsAgeBand.replace(/_/g, " ").toLowerCase()}.`,
      );
  }
  if (c.appPrivacy) {
    if (!c.appPrivacy.collected)
      out.push(
        `Neither ${appName} nor any third-party code in it collects data from it (App Privacy: Data Not Collected).`,
      );
    else
      for (const d of c.appPrivacy.data) {
        const name = Object.values(DATA_TYPES).find((g) => d.type in g)![
          d.type
        ];
        out.push(
          `${appName} collects ${name!.toLowerCase()} for ${d.purposes.map((p) => PURPOSES[p].toLowerCase()).join(", ")}; ${d.linkedToUser ? "linked to the user" : "not linked to the user"}; ${d.usedForTracking ? "used for tracking" : "not used for tracking"}.`,
        );
      }
  }
  if (c.pricing)
    out.push(
      `${Number(c.pricing.price) === 0 ? "Free" : `US price $${c.pricing.price}`}, available in ${c.pricing.territories === "ALL" ? "every territory" : c.pricing.territories.join(", ")}.`,
    );
  return out;
}

/** App Store Connect's web API, in the person's own signed-in session. */
export interface AppleWebSession {
  /** `path` is relative to /iris/v1. `interactive` may ask the person to sign in. */
  request(
    path: string,
    options?: { method?: string; body?: unknown; interactive?: boolean },
  ): Promise<any>;
}

async function pages(api: AppleAPI, path: string) {
  const items: any[] = [];
  let included: any[] = [];
  for (let page = 0; path && page < 30; page++) {
    const response = await api.request(path);
    items.push(...(response.data ?? []));
    included = included.concat(response.included ?? []);
    const next = response.links?.next as string | undefined;
    if (!next) break;
    const url = new URL(next);
    invariant(
      url.origin === "https://api.appstoreconnect.apple.com" &&
        /^\/v[1-3]\//.test(url.pathname),
      "APPLE_PAGE",
      "Invalid Apple pagination link.",
    );
    path = url.pathname.startsWith("/v1/")
      ? url.pathname.slice(3) + url.search
      : url.pathname + url.search;
  }
  return { items, included };
}

const normalLevel = (v: unknown) =>
  v === "INFREQUENT_OR_MILD"
    ? "INFREQUENT"
    : v === "FREQUENT_OR_INTENSE"
      ? "FREQUENT"
      : v;

export interface ComplianceChange {
  field: string;
  before: string;
  after: string;
}

export interface CompliancePlan {
  attested: boolean;
  statements: string[];
  ageRating?: { id: string; changes: ComplianceChange[]; rating?: string };
  pricing?: {
    currentPrice?: string;
    price: string;
    priceChange: boolean;
    /** Territories to make available (all of them when none are set yet). */
    unavailable: string[];
    availabilityId?: string;
  };
  appPrivacy?: {
    /** Unknown when the web session isn't signed in yet. */
    current?: string[];
    wanted: string[];
    published?: boolean;
    change: boolean;
  };
  blockers: string[];
}

/** The App Privacy answers as Apple stores them: one row per type, purpose and protection. */
export function privacyRows(p: AppPrivacy) {
  if (!p.collected) return ["||DATA_NOT_COLLECTED"];
  return p.data
    .flatMap((d) =>
      d.purposes.flatMap((purpose) =>
        [
          d.linkedToUser ? "DATA_LINKED_TO_YOU" : "DATA_NOT_LINKED_TO_YOU",
          ...(d.usedForTracking ? ["DATA_USED_TO_TRACK_YOU"] : []),
        ].map((protection) => `${d.type}|${purpose}|${protection}`),
      ),
    )
    .sort();
}

async function currentPrivacy(
  web: AppleWebSession,
  appId: string,
  interactive: boolean,
) {
  const usages = await web.request(
    `/apps/${appId}/dataUsages?include=category,purpose,dataProtection&limit=500`,
    { interactive },
  );
  const rows = (usages.data ?? [])
    .map(
      (u: any) =>
        `${u.relationships?.category?.data?.id ?? ""}|${u.relationships?.purpose?.data?.id ?? ""}|${u.relationships?.dataProtection?.data?.id ?? ""}`,
    )
    .sort();
  const state = await web.request(`/apps/${appId}/dataUsagePublishState`, {
    interactive,
  });
  return {
    usages: (usages.data ?? []) as any[],
    rows: rows as string[],
    state: state.data as { id: string; attributes: { published: boolean } },
  };
}

export async function compliancePlan(
  api: AppleAPI,
  web: AppleWebSession | undefined,
  appId: string,
  appInfoId: string,
  c: Compliance,
  appName: string,
): Promise<CompliancePlan> {
  const plan: CompliancePlan = {
    attested: isAttested(c),
    statements: complianceStatements(c, appName),
    blockers: [],
  };
  if (!hasAnswers(c)) return plan;
  if (!plan.attested)
    plan.blockers.push(
      c.attestation
        ? "The compliance answers changed since they were attested. Review and attest them again."
        : "The compliance answers aren't attested yet. Review them and attest (local-build-desk listing --attest NAME, or in Local Build Desk).",
    );

  if (c.ageRating) {
    const current = (
      await api.request(`/appInfos/${appInfoId}/ageRatingDeclaration`)
    ).data;
    const changes: ComplianceChange[] = [];
    for (const [field, after] of Object.entries(c.ageRating)) {
      const before = normalLevel(current?.attributes?.[field]);
      if (before !== after)
        changes.push({
          field,
          before: String(before ?? ""),
          after: String(after),
        });
    }
    const info = (await api.request(`/appInfos/${appInfoId}`)).data;
    plan.ageRating = {
      id: current.id,
      changes,
      rating: info?.attributes?.appStoreAgeRating,
    };
  }

  if (c.pricing) {
    let currentPrice: string | undefined;
    try {
      const schedule = (await api.request(`/apps/${appId}/appPriceSchedule`))
        .data;
      if (schedule) {
        const { included } = await pages(
          api,
          `/appPriceSchedules/${schedule.id}/manualPrices?include=appPricePoint&filter[territory]=USA&limit=50`,
        );
        currentPrice = included.find((x) => x.type === "appPricePoints")
          ?.attributes?.customerPrice;
      }
    } catch (error: any) {
      if (!/APPLE_404/.test(error?.code ?? "")) throw error;
    }
    const territories = (await pages(api, "/territories?limit=200")).items.map(
      (t) => t.id as string,
    );
    const wanted =
      c.pricing.territories === "ALL" ? territories : c.pricing.territories;
    let availabilityId: string | undefined;
    let available = new Set<string>();
    try {
      const availability = (
        await api.request(`/apps/${appId}/appAvailabilityV2`)
      ).data;
      if (availability) {
        availabilityId = availability.id;
        const { items } = await pages(
          api,
          `/v2/appAvailabilities/${availability.id}/territoryAvailabilities?include=territory&limit=200`,
        );
        available = new Set(
          items
            .filter((t) => t.attributes?.available)
            .map((t) => t.relationships?.territory?.data?.id),
        );
      }
    } catch (error: any) {
      if (!/APPLE_404/.test(error?.code ?? "")) throw error;
    }
    plan.pricing = {
      currentPrice,
      price: c.pricing.price,
      priceChange:
        currentPrice === undefined ||
        Number(currentPrice) !== Number(c.pricing.price),
      unavailable: wanted.filter((t) => !available.has(t)),
      availabilityId,
    };
  }

  if (c.appPrivacy) {
    const wanted = privacyRows(c.appPrivacy);
    if (!web)
      plan.blockers.push(
        "App Privacy needs Local Build Desk's App Store Connect sign-in.",
      );
    let current: Awaited<ReturnType<typeof currentPrivacy>> | undefined;
    if (web)
      current = await currentPrivacy(web, appId, false).catch((error) => {
        if ((error as any)?.code === "APPLE_WEB_SIGN_IN") return undefined;
        throw error;
      });
    plan.appPrivacy = {
      current: current?.rows,
      wanted,
      published: current?.state.attributes.published,
      change:
        !current ||
        current.rows.join(",") !== wanted.join(",") ||
        !current.state.attributes.published,
    };
  }
  return plan;
}

/** Applies an attested compliance plan. */
export async function applyCompliance(
  api: AppleAPI,
  web: AppleWebSession | undefined,
  appId: string,
  plan: CompliancePlan,
  c: Compliance,
  log: (line: string) => void,
) {
  if (!hasAnswers(c)) return;
  invariant(
    isAttested(c),
    "COMPLIANCE_NOT_ATTESTED",
    "The compliance answers aren't attested; nothing was sent to Apple.",
  );

  if (plan.ageRating?.changes.length) {
    await api.request(`/ageRatingDeclarations/${plan.ageRating.id}`, "PATCH", {
      data: {
        type: "ageRatingDeclarations",
        id: plan.ageRating.id,
        attributes: Object.fromEntries(
          plan.ageRating.changes.map((x) => [
            x.field,
            (c.ageRating as any)[x.field],
          ]),
        ),
      },
    });
    log(`Age rating: ${plan.ageRating.changes.length} answer(s) set`);
  }

  if (plan.pricing?.priceChange) {
    const { items } = await pages(
      api,
      `/apps/${appId}/appPricePoints?filter[territory]=USA&limit=200`,
    );
    const point = items.find(
      (p) => Number(p.attributes.customerPrice) === Number(plan.pricing!.price),
    );
    invariant(
      point,
      "APP_PRICE",
      `Apple has no US price point of $${plan.pricing.price}.`,
    );
    await api.request("/appPriceSchedules", "POST", {
      data: {
        type: "appPriceSchedules",
        relationships: {
          app: { data: { type: "apps", id: appId } },
          baseTerritory: { data: { type: "territories", id: "USA" } },
          manualPrices: { data: [{ type: "appPrices", id: "${price}" }] },
        },
      },
      included: [
        {
          type: "appPrices",
          id: "${price}",
          attributes: { startDate: null },
          relationships: {
            appPricePoint: { data: { type: "appPricePoints", id: point.id } },
          },
        },
      ],
    });
    log(
      `Price: ${Number(plan.pricing.price) === 0 ? "free" : `$${plan.pricing.price}`}`,
    );
  }
  if (plan.pricing?.unavailable.length) {
    if (!plan.pricing.availabilityId) {
      await api.request("/v2/appAvailabilities", "POST", {
        data: {
          type: "appAvailabilities",
          attributes: {
            availableInNewTerritories: c.pricing!.territories === "ALL",
          },
          relationships: {
            app: { data: { type: "apps", id: appId } },
            territoryAvailabilities: {
              data: plan.pricing.unavailable.map((t) => ({
                type: "territoryAvailabilities",
                id: `\${${t}}`,
              })),
            },
          },
        },
        included: plan.pricing.unavailable.map((t) => ({
          type: "territoryAvailabilities",
          id: `\${${t}}`,
          attributes: { available: true },
          relationships: {
            territory: { data: { type: "territories", id: t } },
          },
        })),
      });
    } else {
      const { items } = await pages(
        api,
        `/v2/appAvailabilities/${plan.pricing.availabilityId}/territoryAvailabilities?include=territory&limit=200`,
      );
      for (const t of items) {
        if (
          !plan.pricing.unavailable.includes(
            t.relationships?.territory?.data?.id,
          )
        )
          continue;
        await api.request(`/territoryAvailabilities/${t.id}`, "PATCH", {
          data: {
            type: "territoryAvailabilities",
            id: t.id,
            attributes: { available: true },
          },
        });
      }
    }
    log(
      `Availability: ${plan.pricing.unavailable.length} territor${plan.pricing.unavailable.length === 1 ? "y" : "ies"} added`,
    );
  }

  if (plan.appPrivacy?.change && c.appPrivacy) {
    invariant(
      web,
      "APPLE_WEB_SIGN_IN",
      "App Privacy needs Local Build Desk's App Store Connect sign-in.",
    );
    const current = await currentPrivacy(web, appId, true);
    const wanted = privacyRows(c.appPrivacy);
    if (current.rows.join(",") !== wanted.join(",")) {
      for (const usage of current.usages)
        await web.request(`/appDataUsages/${usage.id}`, { method: "DELETE" });
      for (const row of wanted) {
        const [category, purpose, protection] = row.split("|");
        await web.request("/appDataUsages", {
          method: "POST",
          body: {
            data: {
              type: "appDataUsages",
              relationships: {
                app: { data: { type: "apps", id: appId } },
                ...(category
                  ? {
                      category: {
                        data: { type: "appDataUsageCategories", id: category },
                      },
                    }
                  : {}),
                ...(purpose
                  ? {
                      purpose: {
                        data: { type: "appDataUsagePurposes", id: purpose },
                      },
                    }
                  : {}),
                dataProtection: {
                  data: { type: "appDataUsageDataProtections", id: protection },
                },
              },
            },
          },
        });
      }
      log(
        `App Privacy: ${c.appPrivacy.collected ? `${wanted.length} answer(s)` : "Data Not Collected"}`,
      );
    }
    const state = (await web.request(`/apps/${appId}/dataUsagePublishState`))
      .data;
    if (
      !state.attributes.published ||
      current.rows.join(",") !== wanted.join(",")
    ) {
      await web.request(`/appDataUsagesPublishState/${state.id}`, {
        method: "PATCH",
        body: {
          data: {
            type: "appDataUsagesPublishState",
            id: state.id,
            attributes: { published: true },
          },
        },
      });
      log("App Privacy published");
    }
  }
}

const complianceFileSchema = z
  .object({
    name: z.string().optional(),
    ageRating: ageRatingSchema.optional(),
    appPrivacy: appPrivacySchema.optional(),
    pricing: pricingSchema.optional(),
    attestation: attestationSchema.optional(),
  })
  .loose();

/** The compliance answers in a listing file, and whether they're attested. */
export async function readListingCompliance(path: string) {
  const { readFile } = await import("node:fs/promises");
  const parsed = complianceFileSchema.safeParse(
    JSON.parse(await readFile(path, "utf8")),
  );
  invariant(
    parsed.success,
    "LISTING_INVALID",
    `Listing ${path}: ${parsed.error?.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
  );
  const { ageRating, appPrivacy, pricing, attestation, name } = parsed.data;
  const compliance: Compliance = {
    ageRating,
    appPrivacy,
    pricing,
    attestation,
  };
  return {
    compliance,
    attested: isAttested(compliance),
    statements: complianceStatements(compliance, name ?? "The app"),
  };
}

/**
 * Writes compliance answers into a listing file, keeping everything else in
 * it. With `attestBy`, also records the attestation for exactly these answers;
 * without it, an attestation that no longer matches is dropped.
 */
export async function saveListingCompliance(
  path: string,
  answers: Omit<Compliance, "attestation">,
  attestBy?: { name: string; date: string },
) {
  const { readFile, writeFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(path, "utf8"));
  const compliance: Compliance = {
    ageRating: answers.ageRating && ageRatingSchema.parse(answers.ageRating),
    appPrivacy:
      answers.appPrivacy && appPrivacySchema.parse(answers.appPrivacy),
    pricing: answers.pricing && pricingSchema.parse(answers.pricing),
    attestation: raw.attestation,
  };
  const next = attestBy
    ? attest(compliance, attestBy.name, attestBy.date)
    : compliance;
  const out = { ...raw };
  for (const key of [
    "ageRating",
    "appPrivacy",
    "pricing",
    "attestation",
  ] as const) {
    if (next[key] === undefined) delete out[key];
    else out[key] = next[key];
  }
  if (!attestBy && out.attestation && !isAttested(next)) delete out.attestation;
  await writeFile(path, JSON.stringify(out, null, 2) + "\n");
  return readListingCompliance(path);
}
