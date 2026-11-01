import type { GoogleAPI } from "./stores";
import { invariant } from "./errors";
import type {
  GoogleProduct,
  GoogleSubscription,
  ItemKey,
  Monetization,
  StoreItem,
} from "./monetization";

type Money = { currencyCode: string; units?: string; nanos?: number };
export interface GoogleLive {
  packageName: string;
  products: any[];
  subscriptions: any[];
  /** Offers by "productId/basePlanId". */
  offers: Record<string, any[]>;
}

const toMoney = (value: string, currencyCode = "USD"): Money => {
  const [whole, fraction = ""] = value.split(".");
  return {
    currencyCode,
    units: String(Number(whole)),
    nanos: Number(fraction.padEnd(9, "0").slice(0, 9)),
  };
};
const fromMoney = (m?: Money) =>
  m ? (Number(m.units ?? 0) + (m.nanos ?? 0) / 1e9).toFixed(2) : undefined;
const same = (a?: string, b?: string) =>
  a !== undefined && b !== undefined && Number(a) === Number(b);
const money = (v?: string) =>
  v === undefined ? "none" : Number(v) === 0 ? "free" : `$${v}`;

/** Play's language codes use the same form as the file's locales. */
const listingsOf = (
  file: Record<
    string,
    { title: string; description?: string; benefits?: string[] }
  >,
  current: any[] = [],
) => {
  const merged = new Map<string, any>(current.map((l) => [l.languageCode, l]));
  for (const [languageCode, text] of Object.entries(file))
    merged.set(languageCode, {
      ...merged.get(languageCode),
      languageCode,
      title: text.title,
      ...(text.description !== undefined
        ? { description: text.description }
        : {}),
      ...(text.benefits ? { benefits: text.benefits } : {}),
    });
  return [...merged.values()];
};
function listingChanges(
  file: Record<
    string,
    { title: string; description?: string; benefits?: string[] }
  >,
  current: any[] = [],
) {
  const changes: string[] = [];
  for (const [locale, text] of Object.entries(file)) {
    const have = current.find((l) => l.languageCode === locale);
    if (!have) changes.push(`Add ${locale} title and description`);
    else if (
      have.title !== text.title ||
      (text.description !== undefined &&
        (have.description ?? "") !== text.description) ||
      (text.benefits &&
        JSON.stringify(have.benefits ?? []) !== JSON.stringify(text.benefits))
    )
      changes.push(`Update ${locale} listing`);
  }
  return changes;
}

async function listAll(api: GoogleAPI, path: string, field: string) {
  const items: any[] = [];
  let token: string | undefined;
  for (let page = 0; page < 50; page++) {
    const response = await api.request(
      `${path}${path.includes("?") ? "&" : "?"}pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`,
    );
    items.push(...(response[field] ?? []));
    token = response.nextPageToken;
    if (!token) break;
  }
  return items;
}

export async function readGoogle(
  api: GoogleAPI,
  packageName: string,
): Promise<GoogleLive> {
  const app = `/applications/${encodeURIComponent(packageName)}`;
  const [products, subscriptions] = await Promise.all([
    listAll(api, `${app}/oneTimeProducts`, "oneTimeProducts"),
    listAll(api, `${app}/subscriptions`, "subscriptions"),
  ]);
  const offers: GoogleLive["offers"] = {};
  for (const sub of subscriptions)
    for (const plan of sub.basePlans ?? [])
      offers[`${sub.productId}/${plan.basePlanId}`] = await listAll(
        api,
        `${app}/subscriptions/${encodeURIComponent(sub.productId)}/basePlans/${encodeURIComponent(plan.basePlanId)}/offers`,
        "subscriptionOffers",
      );
  return { packageName, products, subscriptions, offers };
}

const buyOption = (product: any) =>
  (product?.purchaseOptions ?? []).find((o: any) => o.buyOption);
const usPrice = (configs: any[] = []) =>
  fromMoney(configs.find((c) => c.regionCode === "US")?.price);
const active = (state?: string) => state === "ACTIVE";

function phaseMatches(
  file: GoogleSubscription["basePlans"][number]["offers"][number]["phases"][number],
  live: any,
) {
  if (
    !live ||
    live.duration !== file.duration ||
    (live.recurrenceCount ?? 1) !== file.recurrence
  )
    return false;
  const us = (live.regionalConfigs ?? []).find(
    (c: any) => c.regionCode === "US",
  );
  return file.price === "free"
    ? !!us?.free
    : same(fromMoney(us?.price), file.price);
}

export function compareGoogle(m: Monetization, live: GoogleLive): StoreItem[] {
  const items: StoreItem[] = [];
  const g = m.google;
  if (g.appPrice !== undefined)
    items.push({
      key: "google:appPrice",
      store: "google",
      kind: "appPrice",
      label: "Paid app price",
      managed: true,
      exists: true,
      changes: [],
      warnings: [
        `Google has no API for a paid app's price. Set ${money(g.appPrice)} in Play Console → Monetize → App pricing; Local Build Desk opens the page for you.`,
      ],
    });
  for (const product of g.products) {
    const found = live.products.find((p) => p.productId === product.productId);
    const option = buyOption(found);
    const changes: string[] = [];
    if (!found) changes.push(`Create at ${money(product.price)}`);
    else {
      changes.push(...listingChanges(product.listings, found.listings));
      const price = usPrice(option?.regionalPricingAndAvailabilityConfigs);
      if (!same(price, product.price))
        changes.push(`Price ${money(price)} → ${money(product.price)}`);
      for (const [region, value] of Object.entries(
        product.regionalPrices ?? {},
      )) {
        const have = (option?.regionalPricingAndAvailabilityConfigs ?? []).find(
          (c: any) => c.regionCode === region,
        );
        if (!have || Number(fromMoney(have.price)) !== Number(value))
          changes.push(`${region} price → ${value}`);
      }
    }
    if (active(option?.state) !== product.active)
      changes.push(product.active ? "Activate" : "Deactivate");
    items.push({
      key: `google:product:${product.productId}`,
      store: "google",
      kind: "product",
      label: product.listings["en-US"]?.title ?? product.productId,
      managed: true,
      exists: !!found,
      state: option?.state,
      changes,
      warnings: [],
      price: usPrice(option?.regionalPricingAndAvailabilityConfigs),
    });
  }
  for (const sub of g.subscriptions) {
    const found = live.subscriptions.find((s) => s.productId === sub.productId);
    const changes: string[] = [],
      warnings: string[] = [];
    if (!found) changes.push("Create the subscription");
    else changes.push(...listingChanges(sub.listings, found.listings));
    for (const plan of sub.basePlans) {
      const have = (found?.basePlans ?? []).find(
        (b: any) => b.basePlanId === plan.basePlanId,
      );
      const label = `Base plan ${plan.basePlanId}`;
      if (!have)
        changes.push(
          `${label}: create at ${money(plan.price)} every ${plan.period}`,
        );
      else {
        const period = (
          have.autoRenewingBasePlanType ?? have.prepaidBasePlanType
        )?.billingPeriodDuration;
        if (period !== plan.period)
          warnings.push(
            `${label} bills every ${period} in Play; a base plan's period can't change. Add a new base plan.`,
          );
        if (!!have.autoRenewingBasePlanType !== plan.autoRenewing)
          warnings.push(
            `${label} is ${have.autoRenewingBasePlanType ? "auto-renewing" : "prepaid"} in Play, which can't change.`,
          );
        const price = usPrice(have.regionalConfigs);
        if (!same(price, plan.price))
          changes.push(
            `${label}: price ${money(price)} → ${money(plan.price)} for new subscribers`,
          );
      }
      if (active(have?.state) !== plan.active)
        changes.push(`${label}: ${plan.active ? "activate" : "deactivate"}`);
      for (const offer of plan.offers) {
        const live_ = (
          live.offers[`${sub.productId}/${plan.basePlanId}`] ?? []
        ).find((o) => o.offerId === offer.offerId);
        const name = `Offer ${offer.offerId}`;
        if (!live_) changes.push(`${name}: create`);
        else if (
          live_.phases?.length !== offer.phases.length ||
          offer.phases.some((p, i) => !phaseMatches(p, live_.phases[i])) ||
          (offer.eligibility === "new") !== !!live_.targeting?.acquisitionRule
        )
          changes.push(`${name}: update phases or eligibility`);
        if (active(live_?.state) !== offer.active)
          changes.push(`${name}: ${offer.active ? "activate" : "deactivate"}`);
      }
    }
    items.push({
      key: `google:subscription:${sub.productId}`,
      store: "google",
      kind: "subscription",
      label: sub.listings["en-US"]?.title ?? sub.productId,
      managed: true,
      exists: !!found,
      state: found
        ? (found.basePlans ?? []).some((b: any) => active(b.state))
          ? "ACTIVE"
          : "INACTIVE"
        : undefined,
      changes,
      warnings,
      price: usPrice(found?.basePlans?.[0]?.regionalConfigs),
    });
  }
  for (const promo of g.promoCodes)
    items.push({
      key: `google:promo:${promo.name}`,
      store: "google",
      kind: "promo",
      label: `${promo.name} (${promo.productId})`,
      managed: true,
      exists: !!promo.generatedAt,
      state: promo.generatedAt ? "CREATED" : undefined,
      changes: promo.generatedAt
        ? []
        : [
            promo.kind === "custom"
              ? `Create custom code ${promo.code} for ${promo.count} redemptions in Play Console`
              : `Create ${promo.count} one-time codes in Play Console`,
          ],
      warnings: promo.generatedAt
        ? ["Play Console doesn't let a promotion change after it's created."]
        : [],
    });
  const managed = new Set([
    ...g.products.map((p) => p.productId),
    ...g.subscriptions.map((s) => s.productId),
  ]);
  for (const p of live.products.filter((p) => !managed.has(p.productId)))
    items.push({
      key: `google:unmanaged:${p.productId}`,
      store: "google",
      kind: "product",
      label: p.listings?.[0]?.title ?? p.productId,
      managed: false,
      exists: true,
      state: buyOption(p)?.state,
      changes: [],
      warnings: [],
      price: usPrice(buyOption(p)?.regionalPricingAndAvailabilityConfigs),
    });
  for (const s of live.subscriptions.filter((s) => !managed.has(s.productId)))
    items.push({
      key: `google:unmanaged:${s.productId}`,
      store: "google",
      kind: "subscription",
      label: s.listings?.[0]?.title ?? s.productId,
      managed: false,
      exists: true,
      state: s.archived ? "ARCHIVED" : undefined,
      changes: [],
      warnings: [],
      price: usPrice(s.basePlans?.[0]?.regionalConfigs),
    });
  return items;
}

/** File entries for Play products the file doesn't list yet. */
export function importGoogle(live: GoogleLive, productIds: string[]) {
  const wanted = new Set(productIds);
  const listings = (l: any[] = []) =>
    Object.fromEntries(
      l.map((x) => [
        x.languageCode,
        {
          title: x.title,
          ...(x.description ? { description: x.description } : {}),
          ...(x.benefits?.length ? { benefits: x.benefits } : {}),
        },
      ]),
    );
  const products: GoogleProduct[] = live.products
    .filter((p) => wanted.has(p.productId))
    .map((p) => ({
      productId: p.productId,
      price:
        usPrice(buyOption(p)?.regionalPricingAndAvailabilityConfigs) ?? "0.99",
      active: active(buyOption(p)?.state),
      listings: listings(p.listings),
    }));
  const subscriptions: GoogleSubscription[] = live.subscriptions
    .filter((s) => wanted.has(s.productId) && (s.basePlans ?? []).length)
    .map((s) => ({
      productId: s.productId,
      listings: listings(s.listings),
      basePlans: s.basePlans.map((b: any) => ({
        basePlanId: b.basePlanId,
        period:
          (b.autoRenewingBasePlanType ?? b.prepaidBasePlanType)
            ?.billingPeriodDuration ?? "P1M",
        autoRenewing: !!b.autoRenewingBasePlanType,
        price: usPrice(b.regionalConfigs) ?? "0.99",
        ...(b.autoRenewingBasePlanType?.gracePeriodDuration
          ? { gracePeriod: b.autoRenewingBasePlanType.gracePeriodDuration }
          : {}),
        active: active(b.state),
        offers: (live.offers[`${s.productId}/${b.basePlanId}`] ?? []).map(
          (o) => ({
            offerId: o.offerId,
            eligibility: o.targeting?.acquisitionRule
              ? ("new" as const)
              : ("developer" as const),
            active: active(o.state),
            phases: (o.phases ?? []).map((p: any) => {
              const us = (p.regionalConfigs ?? []).find(
                (c: any) => c.regionCode === "US",
              );
              return {
                duration: p.duration,
                recurrence: p.recurrenceCount ?? 1,
                price: us?.free
                  ? ("free" as const)
                  : (fromMoney(us?.price) ?? "0.00"),
              };
            }),
          }),
        ),
      })),
    }));
  return { products, subscriptions };
}

/** Play's price for every region from one USD price, with overrides. */
async function convert(
  api: GoogleAPI,
  packageName: string,
  usd: string,
  overrides: Record<string, string> = {},
) {
  const response = await api.request(
    `/applications/${encodeURIComponent(packageName)}/pricing:convertRegionPrices`,
    "POST",
    { price: toMoney(usd) },
  );
  const version = response.regionVersion?.version as string | undefined;
  invariant(
    version,
    "GOOGLE_PRICE",
    "Google Play didn't return its region list for price conversion.",
  );
  const regions = Object.values<any>(response.convertedRegionPrices ?? {}).map(
    (r) => ({
      regionCode: r.regionCode as string,
      price: overrides[r.regionCode]
        ? toMoney(overrides[r.regionCode]!, r.price.currencyCode)
        : (r.price as Money),
    }),
  );
  return {
    version,
    regions,
    other: {
      usdPrice: response.convertedOtherRegionsPrice?.usdPrice ?? toMoney(usd),
      eurPrice:
        response.convertedOtherRegionsPrice?.eurPrice ?? toMoney(usd, "EUR"),
    },
  };
}

async function applyProduct(
  api: GoogleAPI,
  live: GoogleLive,
  product: GoogleProduct,
  log: (l: string) => void,
) {
  const pkg = live.packageName,
    base = `/applications/${encodeURIComponent(pkg)}`;
  const found = live.products.find((p) => p.productId === product.productId);
  const prices = await convert(api, pkg, product.price, product.regionalPrices);
  const existing = buyOption(found);
  const optionId = existing?.purchaseOptionId ?? "buy";
  const option = {
    ...existing,
    purchaseOptionId: optionId,
    buyOption: existing?.buyOption ?? { legacyCompatible: true },
    regionalPricingAndAvailabilityConfigs: prices.regions.map((r) => ({
      regionCode: r.regionCode,
      price: r.price,
      availability: "AVAILABLE",
    })),
    newRegionsConfig: { ...prices.other, availability: "AVAILABLE" },
  };
  delete (option as any).state;
  const body = {
    packageName: pkg,
    productId: product.productId,
    listings: listingsOf(product.listings, found?.listings),
    purchaseOptions: [
      ...(found?.purchaseOptions ?? [])
        .filter((o: any) => o.purchaseOptionId !== optionId)
        .map(({ state: _state, ...o }: any) => o),
      option,
    ],
  };
  const saved = await api.request(
    `${base}/onetimeproducts/${encodeURIComponent(product.productId)}?allowMissing=true&updateMask=listings,purchaseOptions&regionsVersion.version=${encodeURIComponent(prices.version)}`,
    "PATCH",
    body,
  );
  log(
    `${found ? "Updated" : "Created"} ${product.productId} at ${money(product.price)} in ${prices.regions.length} regions`,
  );
  const state = buyOption(saved)?.state ?? existing?.state;
  if (active(state) !== product.active) {
    const request = {
      packageName: pkg,
      productId: product.productId,
      purchaseOptionId: optionId,
    };
    await api.request(
      `${base}/oneTimeProducts/${encodeURIComponent(product.productId)}/purchaseOptions:batchUpdateStates`,
      "POST",
      {
        requests: [
          product.active
            ? { activatePurchaseOptionRequest: request }
            : { deactivatePurchaseOptionRequest: request },
        ],
      },
    );
    log(
      `${product.productId}: ${product.active ? "activated" : "deactivated"}`,
    );
  }
}

function basePlanBody(
  plan: GoogleSubscription["basePlans"][number],
  prices: Awaited<ReturnType<typeof convert>>,
  current?: any,
) {
  const { state: _state, ...rest } = current ?? {};
  return {
    ...rest,
    basePlanId: plan.basePlanId,
    ...(current
      ? {}
      : plan.autoRenewing
        ? {
            autoRenewingBasePlanType: {
              billingPeriodDuration: plan.period,
              resubscribeState: "RESUBSCRIBE_STATE_ACTIVE",
              prorationMode:
                "SUBSCRIPTION_PRORATION_MODE_CHARGE_ON_NEXT_BILLING_DATE",
              ...(plan.gracePeriod
                ? { gracePeriodDuration: plan.gracePeriod }
                : {}),
            },
          }
        : {
            prepaidBasePlanType: {
              billingPeriodDuration: plan.period,
              timeExtension: "TIME_EXTENSION_ACTIVE",
            },
          }),
    ...(current?.autoRenewingBasePlanType && plan.gracePeriod
      ? {
          autoRenewingBasePlanType: {
            ...current.autoRenewingBasePlanType,
            gracePeriodDuration: plan.gracePeriod,
          },
        }
      : {}),
    regionalConfigs: prices.regions.map((r) => ({
      regionCode: r.regionCode,
      price: r.price,
      newSubscriberAvailability: true,
    })),
    otherRegionsConfig: { ...prices.other, newSubscriberAvailability: true },
  };
}

async function offerBody(
  api: GoogleAPI,
  pkg: string,
  productId: string,
  basePlanId: string,
  offer: GoogleSubscription["basePlans"][number]["offers"][number],
  regions: string[],
) {
  const phases = [];
  for (const phase of offer.phases) {
    if (phase.price === "free") {
      phases.push({
        duration: phase.duration,
        recurrenceCount: phase.recurrence,
        regionalConfigs: regions.map((regionCode) => ({
          regionCode,
          free: {},
        })),
        otherRegionsConfig: { free: {} },
      });
      continue;
    }
    const prices = await convert(api, pkg, phase.price);
    const byRegion = new Map(
      prices.regions.map((r) => [r.regionCode, r.price]),
    );
    phases.push({
      duration: phase.duration,
      recurrenceCount: phase.recurrence,
      regionalConfigs: regions.flatMap((regionCode) =>
        byRegion.has(regionCode)
          ? [{ regionCode, price: byRegion.get(regionCode) }]
          : [],
      ),
      otherRegionsConfig: { otherRegionsPrices: prices.other },
    });
  }
  return {
    packageName: pkg,
    productId,
    basePlanId,
    offerId: offer.offerId,
    phases,
    regionalConfigs: regions.map((regionCode) => ({
      regionCode,
      newSubscriberAvailability: true,
    })),
    otherRegionsConfig: { otherRegionsNewSubscriberAvailability: true },
    ...(offer.eligibility === "new"
      ? { targeting: { acquisitionRule: { scope: { thisSubscription: {} } } } }
      : {}),
  };
}

async function applySubscription(
  api: GoogleAPI,
  live: GoogleLive,
  sub: GoogleSubscription,
  log: (l: string) => void,
) {
  const pkg = live.packageName,
    base = `/applications/${encodeURIComponent(pkg)}/subscriptions`,
    id = encodeURIComponent(sub.productId);
  const found = live.subscriptions.find((s) => s.productId === sub.productId);
  const converted = new Map<string, Awaited<ReturnType<typeof convert>>>();
  for (const plan of sub.basePlans)
    converted.set(
      plan.basePlanId,
      await convert(api, pkg, plan.price, plan.regionalPrices),
    );
  const version = [...converted.values()][0]!.version;
  const managed = new Set(sub.basePlans.map((b) => b.basePlanId));
  const basePlans = [
    ...(found?.basePlans ?? [])
      .filter((b: any) => !managed.has(b.basePlanId))
      .map(({ state: _s, ...b }: any) => b),
    ...sub.basePlans.map((plan) =>
      basePlanBody(
        plan,
        converted.get(plan.basePlanId)!,
        (found?.basePlans ?? []).find(
          (b: any) => b.basePlanId === plan.basePlanId,
        ),
      ),
    ),
  ];
  const body = {
    packageName: pkg,
    productId: sub.productId,
    listings: listingsOf(sub.listings, found?.listings),
    basePlans,
  };
  const saved = found
    ? await api.request(
        `${base}/${id}?updateMask=listings,basePlans&regionsVersion.version=${encodeURIComponent(version)}`,
        "PATCH",
        body,
      )
    : await api.request(
        `${base}?productId=${id}&regionsVersion.version=${encodeURIComponent(version)}`,
        "POST",
        body,
      );
  log(`${found ? "Updated" : "Created"} subscription ${sub.productId}`);
  for (const plan of sub.basePlans) {
    const state = (saved.basePlans ?? []).find(
      (b: any) => b.basePlanId === plan.basePlanId,
    )?.state;
    const planPath = `${base}/${id}/basePlans/${encodeURIComponent(plan.basePlanId)}`;
    if (active(state) !== plan.active) {
      await api.request(
        `${planPath}:${plan.active ? "activate" : "deactivate"}`,
        "POST",
        {
          packageName: pkg,
          productId: sub.productId,
          basePlanId: plan.basePlanId,
        },
      );
      log(
        `${sub.productId}/${plan.basePlanId}: ${plan.active ? "activated" : "deactivated"}`,
      );
    }
    const regions = converted
      .get(plan.basePlanId)!
      .regions.map((r) => r.regionCode);
    const existing = live.offers[`${sub.productId}/${plan.basePlanId}`] ?? [];
    for (const offer of plan.offers) {
      const current = existing.find((o) => o.offerId === offer.offerId);
      const payload = await offerBody(
        api,
        pkg,
        sub.productId,
        plan.basePlanId,
        offer,
        regions,
      );
      const offerPath = `${planPath}/offers`;
      let state = current?.state;
      if (!current) {
        state = (
          await api.request(
            `${offerPath}?offerId=${encodeURIComponent(offer.offerId)}&regionsVersion.version=${encodeURIComponent(version)}`,
            "POST",
            payload,
          )
        ).state;
        log(
          `Created offer ${offer.offerId} on ${sub.productId}/${plan.basePlanId}`,
        );
      } else if (
        current.phases?.length !== offer.phases.length ||
        offer.phases.some((p, i) => !phaseMatches(p, current.phases[i])) ||
        (offer.eligibility === "new") !== !!current.targeting?.acquisitionRule
      ) {
        await api.request(
          `${offerPath}/${encodeURIComponent(offer.offerId)}?updateMask=phases,targeting,regionalConfigs,otherRegionsConfig&regionsVersion.version=${encodeURIComponent(version)}`,
          "PATCH",
          payload,
        );
        log(`Updated offer ${offer.offerId}`);
      }
      if (active(state) !== offer.active) {
        await api.request(
          `${offerPath}/${encodeURIComponent(offer.offerId)}:${offer.active ? "activate" : "deactivate"}`,
          "POST",
          {
            packageName: pkg,
            productId: sub.productId,
            basePlanId: plan.basePlanId,
            offerId: offer.offerId,
          },
        );
        log(
          `Offer ${offer.offerId}: ${offer.active ? "activated" : "deactivated"}`,
        );
      }
    }
  }
}

/** Applies API-backed Google items. Promo codes and the paid app price go
 * through Play Console instead (see the desktop automation). */
export async function applyGoogle(
  api: GoogleAPI,
  m: Monetization,
  live: GoogleLive,
  keys: Set<string>,
  log: (line: string) => void,
) {
  for (const product of m.google.products)
    if (keys.has(`google:product:${product.productId}` satisfies ItemKey))
      await applyProduct(api, live, product, log);
  for (const sub of m.google.subscriptions)
    if (keys.has(`google:subscription:${sub.productId}` satisfies ItemKey))
      await applySubscription(api, live, sub, log);
}
