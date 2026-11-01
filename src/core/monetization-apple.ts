import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, resolve, sep } from "node:path";
import type { AppleAPI } from "./stores";
import { pages } from "./app-store-compliance";
import { invariant } from "./errors";
import type {
  AppleIap,
  AppleGroup,
  AppleOfferCode,
  AppleSubscription,
  CodeBatch,
  ItemKey,
  Monetization,
  StoreItem,
} from "./monetization";

/** The store's side of everything the monetization page shows for Apple. */
export interface AppleLive {
  appId: string;
  territories: string[];
  app: {
    price?: string;
    available: string[];
    availabilityId?: string;
  };
  iaps: LiveIap[];
  groups: LiveGroup[];
  subscriptions: LiveSubscription[];
}
interface LiveLocalization {
  id: string;
  locale: string;
  name: string;
  description?: string;
}
interface LiveBatch {
  id: string;
  kind: "oneTime" | "custom";
  count: number;
  code?: string;
  expires?: string;
  active: boolean;
  sandbox: boolean;
}
export interface LiveOffer {
  id: string;
  name: string;
  active: boolean;
  eligibility: string[];
  mode?: string;
  duration?: string;
  periods?: number;
  batches: LiveBatch[];
}
interface LiveProduct {
  id: string;
  productId: string;
  name: string;
  state: string;
  reviewNote?: string;
  familySharable?: boolean;
  price?: string;
  available?: string[];
  localizations: LiveLocalization[];
  hasScreenshot: boolean;
  offers: LiveOffer[];
}
export interface LiveIap extends LiveProduct {
  type: AppleIap["type"];
}
export interface LiveGroup {
  id: string;
  referenceName: string;
  localizations: (LiveLocalization & { customAppName?: string })[];
}
export interface LiveSubscription extends LiveProduct {
  groupId: string;
  period?: string;
  level?: number;
  intro?: {
    ids: string[];
    mode: string;
    duration: string;
    periods: number;
    price?: string;
  };
}

const today = () => new Date().toISOString().slice(0, 10);
const same = (a?: string, b?: string) =>
  a !== undefined && b !== undefined && Number(a) === Number(b);
const money = (v?: string) =>
  v === undefined ? "none" : Number(v) === 0 ? "free" : `$${v}`;

/** Runs `work` over items, a few at a time: Apple rate-limits bursts. */
async function each<T, R>(
  items: T[],
  work: (item: T) => Promise<R>,
  limit = 4,
) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]!);
      }
    }),
  );
  return results;
}
const missing = (error: any) => /APPLE_404/.test(error?.code ?? "");
async function optional<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

/** Today's price among scheduled ones, by its point's customer price. */
function currentPrice(prices: any[], included: any[], pointKey: string) {
  const now = today();
  const active = prices
    .filter(
      (p) =>
        (!p.attributes?.startDate || p.attributes.startDate <= now) &&
        (!p.attributes?.endDate || p.attributes.endDate > now),
    )
    .sort((a, b) =>
      (b.attributes?.startDate ?? "").localeCompare(
        a.attributes?.startDate ?? "",
      ),
    )[0];
  const pointId = active?.relationships?.[pointKey]?.data?.id;
  return included.find((i) => i.id === pointId)?.attributes?.customerPrice as
    string | undefined;
}

async function readOffers(
  api: AppleAPI,
  path: string,
  kind: "iap" | "subscription",
): Promise<LiveOffer[]> {
  const offers =
    (await optional(async () => (await pages(api, path)).items)) ?? [];
  return each(offers, async (offer) => {
    const base =
      kind === "iap" ? "/inAppPurchaseOfferCodes" : "/subscriptionOfferCodes";
    const [oneTime, custom] = await Promise.all([
      pages(api, `${base}/${offer.id}/oneTimeUseCodes?limit=200`),
      pages(api, `${base}/${offer.id}/customCodes?limit=200`),
    ]);
    return {
      id: offer.id,
      name: offer.attributes.name,
      active: offer.attributes.active !== false,
      eligibility: offer.attributes.customerEligibilities ?? [],
      mode: offer.attributes.offerMode,
      duration: offer.attributes.duration,
      periods: offer.attributes.numberOfPeriods,
      batches: [
        ...oneTime.items.map((b) => ({
          id: b.id,
          kind: "oneTime" as const,
          count: b.attributes.numberOfCodes,
          expires: b.attributes.expirationDate,
          active: b.attributes.active !== false,
          sandbox: b.attributes.environment === "SANDBOX",
        })),
        ...custom.items.map((b) => ({
          id: b.id,
          kind: "custom" as const,
          count: b.attributes.numberOfCodes,
          code: b.attributes.customCode,
          expires: b.attributes.expirationDate,
          active: b.attributes.active !== false,
          sandbox: false,
        })),
      ],
    };
  });
}

/** Reads the app's price, availability, purchases, subscriptions and offer
 * codes. Every product is read in full so unmanaged ones can be imported. */
export async function readApple(
  api: AppleAPI,
  bundleId: string,
): Promise<AppleLive> {
  const app = await api.app(bundleId);
  invariant(
    app,
    "APPLE_APP",
    `No App Store Connect app has bundle ID ${bundleId}. Complete Guided setup first.`,
  );
  const appId = app.id as string;
  const territories = (await pages(api, "/territories?limit=200")).items.map(
    (t) => t.id as string,
  );

  const live: AppleLive = {
    appId,
    territories,
    app: { available: [] },
    iaps: [],
    groups: [],
    subscriptions: [],
  };
  const schedule = await optional(
    async () => (await api.request(`/apps/${appId}/appPriceSchedule`)).data,
  );
  if (schedule) {
    for (const kind of ["manualPrices", "automaticPrices"]) {
      const { items, included } = await pages(
        api,
        `/appPriceSchedules/${schedule.id}/${kind}?include=appPricePoint&filter[territory]=USA&limit=50`,
      );
      live.app.price = currentPrice(items, included, "appPricePoint");
      if (live.app.price !== undefined) break;
    }
  }
  const availability = await optional(
    async () => (await api.request(`/apps/${appId}/appAvailabilityV2`)).data,
  );
  if (availability) {
    live.app.availabilityId = availability.id;
    const { items } = await pages(
      api,
      `/v2/appAvailabilities/${availability.id}/territoryAvailabilities?include=territory&limit=200`,
    );
    live.app.available = items
      .filter((t) => t.attributes?.available)
      .map((t) => t.relationships?.territory?.data?.id);
  }

  const iaps = (
    await pages(api, `/apps/${appId}/inAppPurchasesV2?limit=200`)
  ).items.filter((i) => i.attributes.state !== "DELETED");
  live.iaps = await each(iaps, async (iap): Promise<LiveIap> => {
    const [localizations, priceSchedule, availability, screenshot, offers] =
      await Promise.all([
        pages(
          api,
          `/v2/inAppPurchases/${iap.id}/inAppPurchaseLocalizations?limit=50`,
        ),
        optional(
          async () =>
            (await api.request(`/v2/inAppPurchases/${iap.id}/iapPriceSchedule`))
              .data,
        ),
        optional(
          async () =>
            (
              await api.request(
                `/v2/inAppPurchases/${iap.id}/inAppPurchaseAvailability`,
              )
            ).data,
        ),
        optional(
          async () =>
            (
              await api.request(
                `/v2/inAppPurchases/${iap.id}/appStoreReviewScreenshot`,
              )
            ).data,
        ),
        readOffers(
          api,
          `/v2/inAppPurchases/${iap.id}/offerCodes?limit=50`,
          "iap",
        ),
      ]);
    let price: string | undefined;
    if (priceSchedule)
      for (const kind of ["manualPrices", "automaticPrices"]) {
        const { items, included } = await pages(
          api,
          `/inAppPurchasePriceSchedules/${priceSchedule.id}/${kind}?include=inAppPurchasePricePoint&filter[territory]=USA&limit=50`,
        );
        price = currentPrice(items, included, "inAppPurchasePricePoint");
        if (price !== undefined) break;
      }
    const available = availability
      ? (
          await pages(
            api,
            `/inAppPurchaseAvailabilities/${availability.id}/availableTerritories?limit=200`,
          )
        ).items.map((t) => t.id as string)
      : undefined;
    return {
      id: iap.id,
      productId: iap.attributes.productId,
      name: iap.attributes.name,
      type: iap.attributes.inAppPurchaseType,
      state: iap.attributes.state,
      reviewNote: iap.attributes.reviewNote ?? undefined,
      familySharable: iap.attributes.familySharable,
      price,
      available,
      hasScreenshot: !!screenshot,
      localizations: localizations.items.map((l) => ({
        id: l.id,
        locale: l.attributes.locale,
        name: l.attributes.name,
        description: l.attributes.description ?? undefined,
      })),
      offers,
    };
  });

  const groups = (
    await pages(api, `/apps/${appId}/subscriptionGroups?limit=200`)
  ).items;
  const nested = await each(groups, async (group) => {
    const [localizations, subscriptions] = await Promise.all([
      pages(
        api,
        `/subscriptionGroups/${group.id}/subscriptionGroupLocalizations?limit=50`,
      ),
      pages(api, `/subscriptionGroups/${group.id}/subscriptions?limit=200`),
    ]);
    const liveGroup: LiveGroup = {
      id: group.id,
      referenceName: group.attributes.referenceName,
      localizations: localizations.items.map((l) => ({
        id: l.id,
        locale: l.attributes.locale,
        name: l.attributes.name,
        customAppName: l.attributes.customAppName ?? undefined,
      })),
    };
    const subs = await each(
      subscriptions.items,
      async (sub): Promise<LiveSubscription> => {
        const [locs, prices, availability, screenshot, intro, offers] =
          await Promise.all([
            pages(
              api,
              `/subscriptions/${sub.id}/subscriptionLocalizations?limit=50`,
            ),
            pages(
              api,
              `/subscriptions/${sub.id}/prices?include=subscriptionPricePoint&filter[territory]=USA&limit=50`,
            ),
            optional(
              async () =>
                (
                  await api.request(
                    `/subscriptions/${sub.id}/subscriptionAvailability`,
                  )
                ).data,
            ),
            optional(
              async () =>
                (
                  await api.request(
                    `/subscriptions/${sub.id}/appStoreReviewScreenshot`,
                  )
                ).data,
            ),
            pages(
              api,
              `/subscriptions/${sub.id}/introductoryOffers?include=territory,subscriptionPricePoint&limit=200`,
            ),
            readOffers(
              api,
              `/subscriptions/${sub.id}/offerCodes?limit=50`,
              "subscription",
            ),
          ]);
        const available = availability
          ? (
              await pages(
                api,
                `/subscriptionAvailabilities/${availability.id}/availableTerritories?limit=200`,
              )
            ).items.map((t) => t.id as string)
          : undefined;
        const usIntro =
          intro.items.find(
            (o) => o.relationships?.territory?.data?.id === "USA",
          ) ?? intro.items[0];
        return {
          id: sub.id,
          groupId: group.id,
          productId: sub.attributes.productId,
          name: sub.attributes.name,
          state: sub.attributes.state,
          period: sub.attributes.subscriptionPeriod,
          level: sub.attributes.groupLevel,
          reviewNote: sub.attributes.reviewNote ?? undefined,
          familySharable: sub.attributes.familySharable,
          price: currentPrice(
            prices.items,
            prices.included,
            "subscriptionPricePoint",
          ),
          available,
          hasScreenshot: !!screenshot,
          localizations: locs.items.map((l) => ({
            id: l.id,
            locale: l.attributes.locale,
            name: l.attributes.name,
            description: l.attributes.description ?? undefined,
          })),
          intro: usIntro && {
            ids: intro.items.map((o) => o.id),
            mode: usIntro.attributes.offerMode,
            duration: usIntro.attributes.duration,
            periods: usIntro.attributes.numberOfPeriods,
            price: intro.included.find(
              (i) =>
                i.id ===
                usIntro.relationships?.subscriptionPricePoint?.data?.id,
            )?.attributes?.customerPrice,
          },
          offers,
        };
      },
    );
    return { group: liveGroup, subs };
  });
  live.groups = nested.map((n) => n.group);
  live.subscriptions = nested.flatMap((n) => n.subs);
  return live;
}

const wantedTerritories = (live: AppleLive, t: "ALL" | string[]) =>
  t === "ALL" ? live.territories : t;
function territoryChange(
  live: AppleLive,
  wanted: "ALL" | string[],
  current?: string[],
) {
  const want = new Set(wantedTerritories(live, wanted));
  const have = new Set(current ?? []);
  const added = [...want].filter((t) => !have.has(t)).length,
    removed = [...have].filter((t) => !want.has(t)).length;
  if (!current) return `Make available in ${want.size} territories`;
  if (!added && !removed) return undefined;
  return `Availability: ${[added && `+${added}`, removed && `−${removed}`].filter(Boolean).join(" ")} territories`;
}
function localizationChanges(
  wanted: Record<string, { name: string; description?: string }>,
  current: LiveLocalization[],
) {
  const changes: string[] = [];
  for (const [locale, text] of Object.entries(wanted)) {
    const have = current.find((l) => l.locale === locale);
    if (!have) changes.push(`Add ${locale} name and description`);
    else if (
      have.name !== text.name ||
      (text.description !== undefined && have.description !== text.description)
    )
      changes.push(`Update ${locale} name or description`);
  }
  return changes;
}
const reviewStates = new Set([
  "MISSING_METADATA",
  "READY_TO_SUBMIT",
  "DEVELOPER_ACTION_NEEDED",
  "REJECTED",
]);

function offerItems(
  offers: AppleOfferCode[],
  liveOffers: LiveOffer[],
  productId: string,
  productLive: boolean,
): StoreItem[] {
  return offers
    .filter((o) => o.productId === productId)
    .map((offer) => {
      const found = liveOffers.find((o) => o.name === offer.name);
      const changes: string[] = [],
        warnings: string[] = [];
      if (!found)
        changes.push(
          productLive
            ? "Create the offer"
            : "Create the offer once the product exists",
        );
      else {
        if (found.active !== offer.active)
          changes.push(
            offer.active ? "Turn the offer on" : "Turn the offer off",
          );
        if (offer.mode && found.mode && found.mode !== offer.mode)
          warnings.push(
            `The store has mode ${found.mode}; Apple doesn't allow changing an offer after it's created. Make a new offer instead.`,
          );
        if (
          offer.duration &&
          found.duration &&
          found.duration !== offer.duration
        )
          warnings.push(
            `The store has duration ${found.duration}, which can't be changed.`,
          );
      }
      const pending = offer.batches.filter((b) => !b.id);
      if (pending.length)
        changes.push(
          `Generate ${pending
            .map((b) =>
              b.kind === "custom"
                ? `custom code ${b.code}`
                : `${b.count} one-time code${b.count === 1 ? "" : "s"}`,
            )
            .join(", ")}`,
        );
      for (const batch of offer.batches.filter((b) => b.id))
        if (found && !found.batches.some((b) => b.id === batch.id))
          warnings.push(
            `Batch ${batch.id} isn't in App Store Connect any more.`,
          );
      return {
        key: `apple:offer:${productId}:${offer.name}` as ItemKey,
        store: "apple" as const,
        kind: "offer" as const,
        label: `${offer.name} (${productId})`,
        managed: true,
        exists: !!found,
        state: found ? (found.active ? "ACTIVE" : "INACTIVE") : undefined,
        changes,
        warnings,
        price: offer.price,
      };
    });
}

/** Compares the file with the store, item by item. Store items the file
 * doesn't list come back unmanaged, so they can be imported. */
export function compareApple(m: Monetization, live: AppleLive): StoreItem[] {
  const items: StoreItem[] = [];
  const config = m.apple;
  if (config.app) {
    const changes: string[] = [];
    if (!same(live.app.price, config.app.price))
      changes.push(
        `Price ${money(live.app.price)} → ${money(config.app.price)}`,
      );
    const t = territoryChange(live, config.app.territories, live.app.available);
    if (t) changes.push(t);
    items.push({
      key: "apple:app",
      store: "apple",
      kind: "app",
      label: "App price and availability",
      managed: true,
      exists: live.app.price !== undefined,
      changes,
      warnings: [],
      price: live.app.price,
    });
  }
  for (const iap of config.inAppPurchases) {
    const found = live.iaps.find((p) => p.productId === iap.productId);
    const changes: string[] = [],
      warnings: string[] = [];
    if (!found)
      changes.push(
        `Create ${iap.type.toLowerCase().replaceAll("_", "-")} at ${money(iap.price)}`,
      );
    else {
      if (found.type !== iap.type)
        warnings.push(
          `The store has type ${found.type}, which can't be changed.`,
        );
      if (found.name !== iap.referenceName)
        changes.push("Rename reference name");
      if (
        (iap.reviewNote ?? "") !== (found.reviewNote ?? "") &&
        iap.reviewNote !== undefined
      )
        changes.push("Update review note");
      if (
        iap.familySharable !== undefined &&
        !!found.familySharable !== iap.familySharable
      ) {
        if (found.familySharable)
          warnings.push("Family Sharing can't be turned off once on.");
        else changes.push("Turn on Family Sharing");
      }
      if (!same(found.price, iap.price))
        changes.push(`Price ${money(found.price)} → ${money(iap.price)}`);
      const t = territoryChange(live, iap.territories, found.available);
      if (t) changes.push(t);
      changes.push(
        ...localizationChanges(iap.localizations, found.localizations),
      );
    }
    if (iap.reviewScreenshot && !found?.hasScreenshot)
      changes.push("Upload the review screenshot");
    if (
      !iap.reviewScreenshot &&
      found &&
      !found.hasScreenshot &&
      reviewStates.has(found.state)
    )
      warnings.push("App Review needs a review screenshot (reviewScreenshot).");
    items.push({
      key: `apple:iap:${iap.productId}`,
      store: "apple",
      kind: "iap",
      label: iap.localizations["en-US"]?.name ?? iap.referenceName,
      managed: true,
      exists: !!found,
      state: found?.state,
      changes,
      warnings,
      price: found?.price,
      needsReview: !found || reviewStates.has(found.state),
    });
    items.push(
      ...offerItems(
        config.offerCodes,
        found?.offers ?? [],
        iap.productId,
        !!found,
      ),
    );
  }
  for (const group of config.subscriptionGroups) {
    const found = live.groups.find(
      (g) => g.referenceName === group.referenceName,
    );
    const changes: string[] = [];
    if (!found) changes.push("Create the subscription group");
    for (const [locale, text] of Object.entries(group.localizations)) {
      const have = found?.localizations.find((l) => l.locale === locale);
      if (!have) changes.push(`Add ${locale} group name`);
      else if (
        have.name !== text.name ||
        (text.customAppName ?? "") !== (have.customAppName ?? "")
      )
        changes.push(`Update ${locale} group name`);
    }
    items.push({
      key: `apple:group:${group.referenceName}`,
      store: "apple",
      kind: "group",
      label: group.referenceName,
      managed: true,
      exists: !!found,
      changes,
      warnings: [],
    });
    for (const sub of group.subscriptions) {
      const live_ = live.subscriptions.find(
        (s) => s.productId === sub.productId,
      );
      const changes: string[] = [],
        warnings: string[] = [];
      if (!live_)
        changes.push(
          `Create ${sub.period.toLowerCase().replaceAll("_", " ")} subscription at ${money(sub.price)}`,
        );
      else {
        if (found && live_.groupId !== found.id)
          warnings.push(
            "It's in a different group in App Store Connect; subscriptions can't move groups.",
          );
        if (live_.name !== sub.referenceName)
          changes.push("Rename reference name");
        if (live_.period !== sub.period)
          changes.push(`Period ${live_.period} → ${sub.period}`);
        if (sub.level !== undefined && live_.level !== sub.level)
          changes.push(`Level ${live_.level} → ${sub.level}`);
        if (
          sub.reviewNote !== undefined &&
          (live_.reviewNote ?? "") !== sub.reviewNote
        )
          changes.push("Update review note");
        if (
          sub.familySharable !== undefined &&
          !!live_.familySharable !== sub.familySharable
        ) {
          if (live_.familySharable)
            warnings.push("Family Sharing can't be turned off once on.");
          else changes.push("Turn on Family Sharing");
        }
        if (!same(live_.price, sub.price))
          changes.push(
            `Price ${money(live_.price)} → ${money(sub.price)}${live_.price ? " for new subscribers; current subscribers keep theirs" : ""}`,
          );
        const t = territoryChange(live, sub.territories, live_.available);
        if (t) changes.push(t);
        changes.push(
          ...localizationChanges(sub.localizations, live_.localizations),
        );
      }
      const intro = sub.introOffer,
        have = live_?.intro;
      if (
        intro &&
        (!have ||
          have.mode !== intro.mode ||
          have.duration !== intro.duration ||
          have.periods !== intro.periods ||
          have.ids.length < wantedTerritories(live, sub.territories).length ||
          (intro.price && !same(have.price, intro.price)))
      )
        changes.push(
          `${have ? "Replace" : "Add"} introductory offer: ${intro.mode.toLowerCase().replaceAll("_", " ")}, ${intro.periods} × ${intro.duration.toLowerCase().replaceAll("_", " ")}`,
        );
      if (!intro && have)
        warnings.push(
          "App Store Connect has an introductory offer the file doesn't list; it's left as is.",
        );
      if (sub.reviewScreenshot && !live_?.hasScreenshot)
        changes.push("Upload the review screenshot");
      if (
        !sub.reviewScreenshot &&
        live_ &&
        !live_.hasScreenshot &&
        reviewStates.has(live_.state)
      )
        warnings.push(
          "App Review needs a review screenshot (reviewScreenshot).",
        );
      items.push({
        key: `apple:subscription:${sub.productId}`,
        store: "apple",
        kind: "subscription",
        label: sub.localizations["en-US"]?.name ?? sub.referenceName,
        managed: true,
        exists: !!live_,
        state: live_?.state,
        changes,
        warnings,
        price: live_?.price,
        needsReview: !live_ || reviewStates.has(live_.state),
      });
      items.push(
        ...offerItems(
          config.offerCodes,
          live_?.offers ?? [],
          sub.productId,
          !!live_,
        ),
      );
    }
  }
  const managed = new Set([
    ...config.inAppPurchases.map((p) => p.productId),
    ...config.subscriptionGroups.flatMap((g) =>
      g.subscriptions.map((s) => s.productId),
    ),
  ]);
  for (const iap of live.iaps.filter((p) => !managed.has(p.productId)))
    items.push({
      key: `apple:unmanaged:${iap.productId}`,
      store: "apple",
      kind: "iap",
      label: iap.localizations[0]?.name ?? iap.name,
      managed: false,
      exists: true,
      state: iap.state,
      changes: [],
      warnings: [],
      price: iap.price,
    });
  for (const sub of live.subscriptions.filter((s) => !managed.has(s.productId)))
    items.push({
      key: `apple:unmanaged:${sub.productId}`,
      store: "apple",
      kind: "subscription",
      label: sub.localizations[0]?.name ?? sub.name,
      managed: false,
      exists: true,
      state: sub.state,
      changes: [],
      warnings: [],
      price: sub.price,
    });
  return items;
}

/** File entries for store products the file doesn't list yet. */
export function importApple(live: AppleLive, productIds: string[]) {
  const wanted = new Set(productIds);
  const locs = (l: LiveLocalization[]) =>
    Object.fromEntries(
      l.map((x) => [
        x.locale,
        {
          name: x.name,
          ...(x.description ? { description: x.description } : {}),
        },
      ]),
    );
  const territories = (available?: string[]) =>
    !available || available.length >= live.territories.length
      ? ("ALL" as const)
      : available;
  const inAppPurchases: AppleIap[] = live.iaps
    .filter((p) => wanted.has(p.productId))
    .map((p) => ({
      productId: p.productId,
      type: p.type,
      referenceName: p.name,
      price: Number(p.price ?? 0).toFixed(2),
      territories: territories(p.available),
      ...(p.familySharable ? { familySharable: true } : {}),
      ...(p.reviewNote ? { reviewNote: p.reviewNote } : {}),
      localizations: locs(p.localizations),
    }));
  const groups: AppleGroup[] = [];
  for (const sub of live.subscriptions.filter((s) => wanted.has(s.productId))) {
    const g = live.groups.find((x) => x.id === sub.groupId)!;
    let group = groups.find((x) => x.referenceName === g.referenceName);
    if (!group) {
      group = {
        referenceName: g.referenceName,
        localizations: Object.fromEntries(
          g.localizations.map((l) => [
            l.locale,
            {
              name: l.name,
              ...(l.customAppName ? { customAppName: l.customAppName } : {}),
            },
          ]),
        ),
        subscriptions: [],
      };
      groups.push(group);
    }
    group.subscriptions.push({
      productId: sub.productId,
      referenceName: sub.name,
      period: (sub.period ?? "ONE_MONTH") as AppleSubscription["period"],
      ...(sub.level ? { level: sub.level } : {}),
      price: Number(sub.price ?? 0).toFixed(2),
      territories: territories(sub.available),
      ...(sub.familySharable ? { familySharable: true } : {}),
      ...(sub.reviewNote ? { reviewNote: sub.reviewNote } : {}),
      ...(sub.intro
        ? {
            introOffer: {
              mode: sub.intro.mode as any,
              duration: sub.intro.duration as any,
              periods: sub.intro.periods,
              ...(sub.intro.price && Number(sub.intro.price) > 0
                ? { price: Number(sub.intro.price).toFixed(2) }
                : {}),
            },
          }
        : {}),
      localizations: locs(sub.localizations),
    });
  }
  const offerCodes: AppleOfferCode[] = [...live.iaps, ...live.subscriptions]
    .filter((p) => wanted.has(p.productId))
    .flatMap((p) =>
      p.offers.map((o) => ({
        name: o.name,
        productId: p.productId,
        active: o.active,
        eligibility: o.eligibility,
        ...(o.mode
          ? {
              mode: o.mode as any,
              duration: o.duration as any,
              periods: o.periods,
            }
          : {}),
        batches: o.batches.map((b) => ({
          kind: b.kind,
          count: b.count,
          ...(b.code ? { code: b.code } : {}),
          ...(b.expires ? { expires: b.expires } : {}),
          ...(b.sandbox ? { sandbox: true } : {}),
          id: b.id,
        })),
      })),
    );
  return { inAppPurchases, groups, offerCodes };
}

export interface ApplyContext {
  /** Folder holding the monetization file; screenshot paths resolve from it. */
  baseDir: string;
  /** The project; files the monetization file names must stay inside it. */
  projectRoot: string;
  log: (line: string) => void;
  fetcher?: typeof fetch;
  /**
   * Called as soon as Apple creates a code batch, and again with its codes,
   * so the batch is recorded even if a later step fails. Without the record
   * the next apply would generate the batch again.
   */
  generated?: (
    batch: { key: ItemKey; index: number; id: string; generatedAt: string },
    csv?: string,
  ) => Promise<void>;
}
/** What applying produced that belongs back in the file, or with the user. */
export interface AppleApplyResult {
  batches: { key: ItemKey; index: number; id: string; generatedAt: string }[];
  /** One-time code values, as Apple's CSV, keyed by batch id. Secret: never committed. */
  codes: { key: ItemKey; batchId: string; csv: string }[];
}

async function uploadScreenshot(
  api: AppleAPI,
  ctx: ApplyContext,
  file: string,
  resource:
    | "inAppPurchaseAppStoreReviewScreenshots"
    | "subscriptionAppStoreReviewScreenshots",
  relationship: Record<string, unknown>,
) {
  const path = resolve(ctx.baseDir, file);
  invariant(
    path.startsWith(resolve(ctx.projectRoot) + sep),
    "MONETIZATION_PATH",
    "Keep review screenshots inside the project.",
  );
  const data = await readFile(path);
  const reserved = (
    await api.request(`/${resource}`, "POST", {
      data: {
        type: resource,
        attributes: { fileName: basename(path), fileSize: data.length },
        relationships: relationship,
      },
    })
  ).data;
  const fetcher = ctx.fetcher ?? fetch;
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
      `Uploading ${basename(path)} failed (${response.status}).`,
    );
  }
  await api.request(`/${resource}/${reserved.id}`, "PATCH", {
    data: {
      type: resource,
      id: reserved.id,
      attributes: {
        uploaded: true,
        sourceFileChecksum: createHash("md5").update(data).digest("hex"),
      },
    },
  });
}

async function syncLocalizations(
  api: AppleAPI,
  wanted: Record<string, { name: string; description?: string }>,
  current: LiveLocalization[],
  resource: "inAppPurchaseLocalizations" | "subscriptionLocalizations",
  relationship: Record<string, unknown>,
) {
  for (const [locale, text] of Object.entries(wanted)) {
    const have = current.find((l) => l.locale === locale);
    const attributes = {
      name: text.name,
      ...(text.description !== undefined
        ? { description: text.description }
        : {}),
    };
    if (!have)
      await api.request(`/${resource}`, "POST", {
        data: {
          type: resource,
          attributes: { locale, ...attributes },
          relationships: relationship,
        },
      });
    else if (
      have.name !== text.name ||
      (text.description !== undefined && have.description !== text.description)
    )
      await api.request(`/${resource}/${have.id}`, "PATCH", {
        data: { type: resource, id: have.id, attributes },
      });
  }
}

/** Price points with the given US price, one per wanted territory. */
async function equalizedPoints(
  api: AppleAPI,
  pointsPath: string,
  equalizationsPath: (id: string) => string,
  price: string,
  territories: string[],
  label: string,
) {
  const us = (
    await pages(
      api,
      `${pointsPath}${pointsPath.includes("?") ? "&" : "?"}filter[territory]=USA&limit=200`,
    )
  ).items.find((p) => Number(p.attributes.customerPrice) === Number(price));
  invariant(
    us,
    "APPLE_PRICE",
    `Apple has no US price point of $${price} for ${label}. Choose one of Apple's price tiers.`,
  );
  const wanted = new Set(territories);
  const points = new Map<string, string>();
  if (wanted.has("USA")) points.set("USA", us.id);
  const { items } = await pages(
    api,
    `${equalizationsPath(us.id)}?include=territory&limit=200`,
  );
  for (const p of items) {
    const territory = p.relationships?.territory?.data?.id;
    if (territory && wanted.has(territory)) points.set(territory, p.id);
  }
  return { usPoint: us.id as string, points };
}

async function setAvailability(
  api: AppleAPI,
  resource: "inAppPurchaseAvailabilities" | "subscriptionAvailabilities",
  relationship: Record<string, unknown>,
  territories: string[],
  newTerritories: boolean,
) {
  await api.request(`/${resource}`, "POST", {
    data: {
      type: resource,
      attributes: { availableInNewTerritories: newTerritories },
      relationships: {
        ...relationship,
        availableTerritories: {
          data: territories.map((id) => ({ type: "territories", id })),
        },
      },
    },
  });
}

async function applyApp(
  api: AppleAPI,
  live: AppleLive,
  app: NonNullable<Monetization["apple"]["app"]>,
  ctx: ApplyContext,
) {
  if (!same(live.app.price, app.price)) {
    const point = (
      await pages(
        api,
        `/apps/${live.appId}/appPricePoints?filter[territory]=USA&limit=200`,
      )
    ).items.find(
      (p) => Number(p.attributes.customerPrice) === Number(app.price),
    );
    invariant(
      point,
      "APP_PRICE",
      `Apple has no US app price point of $${app.price}.`,
    );
    await api.request("/appPriceSchedules", "POST", {
      data: {
        type: "appPriceSchedules",
        relationships: {
          app: { data: { type: "apps", id: live.appId } },
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
    ctx.log(`App price: ${money(app.price)}`);
  }
  const want = new Set(wantedTerritories(live, app.territories));
  if (!territoryChange(live, app.territories, live.app.available)) return;
  if (!live.app.availabilityId) {
    await api.request("/v2/appAvailabilities", "POST", {
      data: {
        type: "appAvailabilities",
        attributes: { availableInNewTerritories: app.territories === "ALL" },
        relationships: {
          app: { data: { type: "apps", id: live.appId } },
          territoryAvailabilities: {
            data: live.territories.map((t) => ({
              type: "territoryAvailabilities",
              id: `\${${t}}`,
            })),
          },
        },
      },
      included: live.territories.map((t) => ({
        type: "territoryAvailabilities",
        id: `\${${t}}`,
        attributes: { available: want.has(t) },
        relationships: { territory: { data: { type: "territories", id: t } } },
      })),
    });
  } else {
    const { items } = await pages(
      api,
      `/v2/appAvailabilities/${live.app.availabilityId}/territoryAvailabilities?include=territory&limit=200`,
    );
    await each(items, async (t) => {
      const available = want.has(t.relationships?.territory?.data?.id);
      if (!!t.attributes?.available === available) return;
      await api.request(`/territoryAvailabilities/${t.id}`, "PATCH", {
        data: {
          type: "territoryAvailabilities",
          id: t.id,
          attributes: { available },
        },
      });
    });
  }
  ctx.log(`App availability: ${want.size} territories`);
}

async function applyIap(
  api: AppleAPI,
  live: AppleLive,
  iap: AppleIap,
  ctx: ApplyContext,
) {
  let found = live.iaps.find((p) => p.productId === iap.productId);
  let id = found?.id;
  if (!id) {
    id = (
      await api.request("/v2/inAppPurchases", "POST", {
        data: {
          type: "inAppPurchases",
          attributes: {
            name: iap.referenceName,
            productId: iap.productId,
            inAppPurchaseType: iap.type,
            ...(iap.reviewNote ? { reviewNote: iap.reviewNote } : {}),
            familySharable: iap.familySharable ?? false,
          },
          relationships: { app: { data: { type: "apps", id: live.appId } } },
        },
      })
    ).data.id as string;
    ctx.log(`Created in-app purchase ${iap.productId}`);
  } else {
    const attributes: Record<string, unknown> = {};
    if (found!.name !== iap.referenceName) attributes.name = iap.referenceName;
    if (
      iap.reviewNote !== undefined &&
      (found!.reviewNote ?? "") !== iap.reviewNote
    )
      attributes.reviewNote = iap.reviewNote;
    if (iap.familySharable && !found!.familySharable)
      attributes.familySharable = true;
    if (Object.keys(attributes).length)
      await api.request(`/v2/inAppPurchases/${id}`, "PATCH", {
        data: { type: "inAppPurchases", id, attributes },
      });
  }
  const relationship = {
    inAppPurchaseV2: { data: { type: "inAppPurchases", id } },
  };
  await syncLocalizations(
    api,
    iap.localizations,
    found?.localizations ?? [],
    "inAppPurchaseLocalizations",
    relationship,
  );
  if (!same(found?.price, iap.price)) {
    const point = (
      await pages(
        api,
        `/v2/inAppPurchases/${id}/pricePoints?filter[territory]=USA&limit=200`,
      )
    ).items.find(
      (p) => Number(p.attributes.customerPrice) === Number(iap.price),
    );
    invariant(
      point,
      "IAP_PRICE",
      `Apple has no US price point of $${iap.price} for ${iap.productId}.`,
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
    ctx.log(`${iap.productId}: price ${money(iap.price)}`);
  }
  if (territoryChange(live, iap.territories, found?.available))
    await setAvailability(
      api,
      "inAppPurchaseAvailabilities",
      { inAppPurchase: { data: { type: "inAppPurchases", id } } },
      wantedTerritories(live, iap.territories),
      iap.territories === "ALL",
    );
  if (iap.reviewScreenshot && !found?.hasScreenshot)
    await uploadScreenshot(
      api,
      ctx,
      iap.reviewScreenshot,
      "inAppPurchaseAppStoreReviewScreenshots",
      relationship,
    );
  if (!found) {
    found = { id, productId: iap.productId, offers: [] } as unknown as LiveIap;
    live.iaps.push(found);
  }
  return id;
}

async function applyGroup(api: AppleAPI, live: AppleLive, group: AppleGroup) {
  let found = live.groups.find((g) => g.referenceName === group.referenceName);
  if (!found) {
    const id = (
      await api.request("/subscriptionGroups", "POST", {
        data: {
          type: "subscriptionGroups",
          attributes: { referenceName: group.referenceName },
          relationships: { app: { data: { type: "apps", id: live.appId } } },
        },
      })
    ).data.id as string;
    found = { id, referenceName: group.referenceName, localizations: [] };
    live.groups.push(found);
  }
  for (const [locale, text] of Object.entries(group.localizations)) {
    const have = found.localizations.find((l) => l.locale === locale);
    const attributes = {
      name: text.name,
      ...(text.customAppName !== undefined
        ? { customAppName: text.customAppName }
        : {}),
    };
    // The snapshot is kept current: a group is applied again for each of
    // its subscriptions in the same run.
    if (!have) {
      const created = await api.request(
        "/subscriptionGroupLocalizations",
        "POST",
        {
          data: {
            type: "subscriptionGroupLocalizations",
            attributes: { locale, ...attributes },
            relationships: {
              subscriptionGroup: {
                data: { type: "subscriptionGroups", id: found.id },
              },
            },
          },
        },
      );
      found.localizations.push({ id: created.data?.id, locale, ...attributes });
    } else if (
      have.name !== text.name ||
      (text.customAppName ?? "") !== (have.customAppName ?? "")
    ) {
      await api.request(`/subscriptionGroupLocalizations/${have.id}`, "PATCH", {
        data: {
          type: "subscriptionGroupLocalizations",
          id: have.id,
          attributes,
        },
      });
      Object.assign(have, attributes);
    }
  }
  return found.id;
}

async function applySubscription(
  api: AppleAPI,
  live: AppleLive,
  group: AppleGroup,
  sub: AppleSubscription,
  ctx: ApplyContext,
) {
  const groupId = await applyGroup(api, live, group);
  let found = live.subscriptions.find((s) => s.productId === sub.productId);
  let id = found?.id;
  if (!id) {
    id = (
      await api.request("/subscriptions", "POST", {
        data: {
          type: "subscriptions",
          attributes: {
            name: sub.referenceName,
            productId: sub.productId,
            subscriptionPeriod: sub.period,
            familySharable: sub.familySharable ?? false,
            ...(sub.level ? { groupLevel: sub.level } : {}),
            ...(sub.reviewNote ? { reviewNote: sub.reviewNote } : {}),
          },
          relationships: {
            group: { data: { type: "subscriptionGroups", id: groupId } },
          },
        },
      })
    ).data.id as string;
    ctx.log(`Created subscription ${sub.productId}`);
  } else {
    const attributes: Record<string, unknown> = {};
    if (found!.name !== sub.referenceName) attributes.name = sub.referenceName;
    if (found!.period !== sub.period)
      attributes.subscriptionPeriod = sub.period;
    if (sub.level !== undefined && found!.level !== sub.level)
      attributes.groupLevel = sub.level;
    if (
      sub.reviewNote !== undefined &&
      (found!.reviewNote ?? "") !== sub.reviewNote
    )
      attributes.reviewNote = sub.reviewNote;
    if (sub.familySharable && !found!.familySharable)
      attributes.familySharable = true;
    if (Object.keys(attributes).length)
      await api.request(`/subscriptions/${id}`, "PATCH", {
        data: { type: "subscriptions", id, attributes },
      });
  }
  const relationship = {
    subscription: { data: { type: "subscriptions", id } },
  };
  await syncLocalizations(
    api,
    sub.localizations,
    found?.localizations ?? [],
    "subscriptionLocalizations",
    relationship,
  );
  const territories = wantedTerritories(live, sub.territories);
  if (territoryChange(live, sub.territories, found?.available))
    await setAvailability(
      api,
      "subscriptionAvailabilities",
      relationship,
      territories,
      sub.territories === "ALL",
    );
  if (!same(found?.price, sub.price)) {
    // Apple has no equalized schedule for subscriptions: each territory gets
    // its own price, from the US point's equalizations. Current subscribers
    // keep what they pay; Apple's price-increase consent rules don't apply.
    const { points } = await equalizedPoints(
      api,
      `/subscriptions/${id}/pricePoints`,
      (point) => `/subscriptionPricePoints/${point}/equalizations`,
      sub.price,
      territories,
      sub.productId,
    );
    // One request for every territory: Apple applies it all or nothing, and
    // a request per territory runs into its rate limit.
    const prices = [...points].map(([territory, point], index) => ({
      type: "subscriptionPrices",
      id: `\${price${index}}`,
      attributes: { startDate: null, preserveCurrentPrice: !!found?.price },
      relationships: {
        subscription: { data: { type: "subscriptions", id } },
        territory: { data: { type: "territories", id: territory } },
        subscriptionPricePoint: {
          data: { type: "subscriptionPricePoints", id: point },
        },
      },
    }));
    await api.request(`/subscriptions/${id}`, "PATCH", {
      data: {
        type: "subscriptions",
        id,
        relationships: {
          prices: {
            data: prices.map((p) => ({ type: p.type, id: p.id })),
          },
        },
      },
      included: prices,
    });
    ctx.log(
      `${sub.productId}: price ${money(sub.price)} in ${points.size} territories`,
    );
  }
  const intro = sub.introOffer,
    have = found?.intro;
  if (
    intro &&
    (!have ||
      have.mode !== intro.mode ||
      have.duration !== intro.duration ||
      have.periods !== intro.periods ||
      have.ids.length < territories.length ||
      (intro.price && !same(have.price, intro.price)))
  ) {
    for (const old of have?.ids ?? [])
      await api.request(`/subscriptionIntroductoryOffers/${old}`, "DELETE");
    const points =
      intro.mode === "FREE_TRIAL"
        ? new Map(territories.map((t) => [t, undefined as string | undefined]))
        : (
            await equalizedPoints(
              api,
              `/subscriptions/${id}/pricePoints`,
              (point) => `/subscriptionPricePoints/${point}/equalizations`,
              intro.price!,
              territories,
              `${sub.productId}'s introductory offer`,
            )
          ).points;
    const offers = [...points].map(([territory, point], index) => ({
      type: "subscriptionIntroductoryOffers",
      id: `\${intro${index}}`,
      attributes: {
        duration: intro.duration,
        offerMode: intro.mode,
        numberOfPeriods: intro.periods,
      },
      relationships: {
        subscription: { data: { type: "subscriptions", id } },
        territory: { data: { type: "territories", id: territory } },
        ...(point
          ? {
              subscriptionPricePoint: {
                data: { type: "subscriptionPricePoints", id: point },
              },
            }
          : {}),
      },
    }));
    await api.request(`/subscriptions/${id}`, "PATCH", {
      data: {
        type: "subscriptions",
        id,
        relationships: {
          introductoryOffers: {
            data: offers.map((o) => ({ type: o.type, id: o.id })),
          },
        },
      },
      included: offers,
    });
    ctx.log(
      `${sub.productId}: introductory offer in ${points.size} territories`,
    );
  }
  if (sub.reviewScreenshot && !found?.hasScreenshot)
    await uploadScreenshot(
      api,
      ctx,
      sub.reviewScreenshot,
      "subscriptionAppStoreReviewScreenshots",
      relationship,
    );
  if (!found) {
    found = {
      id,
      groupId,
      productId: sub.productId,
      offers: [],
    } as unknown as LiveSubscription;
    live.subscriptions.push(found);
  }
  return id;
}

const ALL_IAP_ELIGIBILITY = [
  "NON_SPENDER",
  "ACTIVE_SPENDER",
  "CHURNED_SPENDER",
];
const ALL_SUB_ELIGIBILITY = ["NEW", "EXISTING", "EXPIRED"];

async function applyOffer(
  api: AppleAPI,
  live: AppleLive,
  m: Monetization,
  offer: AppleOfferCode,
  key: ItemKey,
  ctx: ApplyContext,
  result: AppleApplyResult,
) {
  const sub = live.subscriptions.find((s) => s.productId === offer.productId);
  const iap = live.iaps.find((p) => p.productId === offer.productId);
  const product = sub ?? iap;
  invariant(
    product?.id,
    "OFFER_PRODUCT",
    `Offer ${offer.name}: ${offer.productId} isn't in App Store Connect yet. Apply the product first.`,
  );
  const territoriesFor = () => {
    const config =
      m.apple.inAppPurchases.find((p) => p.productId === offer.productId)
        ?.territories ??
      m.apple.subscriptionGroups
        .flatMap((g) => g.subscriptions)
        .find((s) => s.productId === offer.productId)?.territories ??
      "ALL";
    return wantedTerritories(live, config);
  };
  const base = sub ? "subscriptionOfferCodes" : "inAppPurchaseOfferCodes";
  let found = product.offers.find((o) => o.name === offer.name);
  if (!found) {
    const territories = territoriesFor();
    const free = sub ? offer.mode === "FREE_TRIAL" : Number(offer.price) === 0;
    const points = free
      ? new Map(territories.map((t) => [t, undefined as string | undefined]))
      : (
          await equalizedPoints(
            api,
            sub
              ? `/subscriptions/${product.id}/pricePoints`
              : `/v2/inAppPurchases/${product.id}/pricePoints`,
            (point) =>
              sub
                ? `/subscriptionPricePoints/${point}/equalizations`
                : `/inAppPurchasePricePoints/${point}/equalizations`,
            offer.price!,
            territories,
            `offer ${offer.name}`,
          )
        ).points;
    const priceType = sub
      ? "subscriptionOfferCodePrices"
      : "inAppPurchaseOfferPrices";
    const pointType = sub
      ? "subscriptionPricePoints"
      : "inAppPurchasePricePoints";
    const pointKey = sub ? "subscriptionPricePoint" : "pricePoint";
    const included = [...points].map(([territory, point], index) => ({
      type: priceType,
      id: `\${p${index}}`,
      relationships: {
        territory: { data: { type: "territories", id: territory } },
        ...(point
          ? { [pointKey]: { data: { type: pointType, id: point } } }
          : {}),
      },
    }));
    const id = (
      await api.request(`/${base}`, "POST", {
        data: {
          type: base,
          attributes: sub
            ? {
                name: offer.name,
                customerEligibilities: offer.eligibility ?? ALL_SUB_ELIGIBILITY,
                offerEligibility: "STACK_WITH_INTRO_OFFERS",
                offerMode: offer.mode,
                duration: offer.duration,
                numberOfPeriods: offer.periods ?? 1,
              }
            : {
                name: offer.name,
                customerEligibilities: offer.eligibility ?? ALL_IAP_ELIGIBILITY,
              },
          relationships: {
            [sub ? "subscription" : "inAppPurchase"]: {
              data: {
                type: sub ? "subscriptions" : "inAppPurchases",
                id: product.id,
              },
            },
            prices: {
              data: included.map((p) => ({ type: priceType, id: p.id })),
            },
          },
        },
        included,
      })
    ).data.id as string;
    found = {
      id,
      name: offer.name,
      active: true,
      eligibility: [],
      batches: [],
    };
    product.offers.push(found);
    ctx.log(`Created offer ${offer.name} for ${offer.productId}`);
  }
  if (found.active !== offer.active) {
    await api.request(`/${base}/${found.id}`, "PATCH", {
      data: { type: base, id: found.id, attributes: { active: offer.active } },
    });
    found.active = offer.active;
  }
  for (const [index, batch] of offer.batches.entries()) {
    if (batch.id) continue;
    const id = await createBatch(
      api,
      sub ? "subscription" : "iap",
      found.id,
      batch,
    );
    const generatedAt = new Date().toISOString();
    const record = { key, index, id, generatedAt };
    result.batches.push(record);
    batch.id = id;
    await ctx.generated?.(record);
    if (batch.kind === "oneTime") {
      const csv = await oneTimeCodes(api, sub ? "subscription" : "iap", id);
      result.codes.push({ key, batchId: id, csv });
      await ctx.generated?.(record, csv);
      ctx.log(
        `${offer.name}: generated ${batch.count} one-time code${batch.count === 1 ? "" : "s"}`,
      );
    } else ctx.log(`${offer.name}: custom code ${batch.code} is live`);
  }
}

async function createBatch(
  api: AppleAPI,
  kind: "subscription" | "iap",
  offerId: string,
  batch: CodeBatch,
) {
  const prefix =
    kind === "subscription"
      ? "subscriptionOfferCode"
      : "inAppPurchaseOfferCode";
  const offerType =
    kind === "subscription"
      ? "subscriptionOfferCodes"
      : "inAppPurchaseOfferCodes";
  const type =
    batch.kind === "oneTime"
      ? `${prefix}OneTimeUseCodes`
      : `${prefix}CustomCodes`;
  return (
    await api.request(`/${type}`, "POST", {
      data: {
        type,
        attributes:
          batch.kind === "oneTime"
            ? {
                numberOfCodes: batch.count,
                expirationDate: batch.expires,
                ...(batch.sandbox ? { environment: "SANDBOX" } : {}),
              }
            : {
                customCode: batch.code,
                numberOfCodes: batch.count,
                ...(batch.expires ? { expirationDate: batch.expires } : {}),
              },
        relationships: {
          offerCode: { data: { type: offerType, id: offerId } },
        },
      },
    })
  ).data.id as string;
}

/** One-time code values, as Apple's CSV. Apple fills a new batch shortly
 * after creating it, so an empty answer is retried briefly. */
export async function oneTimeCodes(
  api: AppleAPI,
  kind: "subscription" | "iap",
  batchId: string,
) {
  const type =
    kind === "subscription"
      ? "subscriptionOfferCodeOneTimeUseCodes"
      : "inAppPurchaseOfferCodeOneTimeUseCodes";
  for (let attempt = 0; ; attempt++) {
    const csv = String(await api.request(`/${type}/${batchId}/values`));
    if (csv.trim().split("\n").length > 1 || attempt >= 5) return csv;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
}

/** Applies the listed items, in dependency order: groups before their
 * subscriptions, products before their offers. */
export async function applyApple(
  api: AppleAPI,
  m: Monetization,
  live: AppleLive,
  keys: Set<string>,
  ctx: ApplyContext,
): Promise<AppleApplyResult> {
  const result: AppleApplyResult = { batches: [], codes: [] };
  if (keys.has("apple:app") && m.apple.app)
    await applyApp(api, live, m.apple.app, ctx);
  for (const iap of m.apple.inAppPurchases)
    if (keys.has(`apple:iap:${iap.productId}`))
      await applyIap(api, live, iap, ctx);
  for (const group of m.apple.subscriptionGroups) {
    if (keys.has(`apple:group:${group.referenceName}`))
      await applyGroup(api, live, group);
    for (const sub of group.subscriptions)
      if (keys.has(`apple:subscription:${sub.productId}`))
        await applySubscription(api, live, group, sub, ctx);
  }
  for (const offer of m.apple.offerCodes) {
    const key = `apple:offer:${offer.productId}:${offer.name}` as ItemKey;
    if (keys.has(key)) await applyOffer(api, live, m, offer, key, ctx, result);
  }
  return result;
}

/** Subscriptions waiting for their first review: they go into the same
 * review submission as the next version, as App Store Connect does. */
export async function subscriptionReviewItems(
  api: AppleAPI,
  live: AppleLive,
  productIds: string[],
) {
  const items: Record<string, unknown>[] = [];
  for (const sub of live.subscriptions.filter((s) =>
    productIds.includes(s.productId),
  )) {
    if (sub.state !== "READY_TO_SUBMIT") continue;
    const versions =
      (await optional(
        async () =>
          (await pages(api, `/subscriptions/${sub.id}/versions?limit=50`))
            .items,
      )) ?? [];
    const version = versions.find((v) =>
      ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED"].includes(
        v.attributes?.state,
      ),
    );
    if (version)
      items.push({
        subscriptionVersion: {
          data: { type: "subscriptionVersions", id: version.id },
        },
      });
  }
  const groups = new Set(
    live.subscriptions
      .filter((s) => productIds.includes(s.productId))
      .map((s) => s.groupId),
  );
  for (const groupId of groups) {
    const versions =
      (await optional(
        async () =>
          (await pages(api, `/subscriptionGroups/${groupId}/versions?limit=50`))
            .items,
      )) ?? [];
    const version = versions.find((v) =>
      ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED"].includes(
        v.attributes?.state,
      ),
    );
    if (version)
      items.push({
        subscriptionGroupVersion: {
          data: { type: "subscriptionGroupVersions", id: version.id },
        },
      });
  }
  return items;
}
