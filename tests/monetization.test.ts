import { it, expect, describe } from "vitest";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyMonetization,
  loadMonetization,
  monetizationProblems,
  monetizationSchema,
  saveMonetization,
  type Monetization,
} from "../src/core/monetization";
import {
  applyApple,
  compareApple,
  importApple,
  type AppleLive,
} from "../src/core/monetization-apple";
import {
  applyGoogle,
  compareGoogle,
  importGoogle,
  type GoogleLive,
} from "../src/core/monetization-google";
import { MonetizationService } from "../src/core/monetization-service";
import type { Project } from "../src/core/types";

const config = (value: unknown): Monetization =>
  monetizationSchema.parse(value);
const territories = ["USA", "CAN", "GBR"];
const liveApple = (patch: Partial<AppleLive> = {}): AppleLive => ({
  appId: "app1",
  territories,
  app: { price: "0.00", available: territories, availabilityId: "av1" },
  iaps: [],
  groups: [],
  subscriptions: [],
  ...patch,
});

/** A fake App Store Connect: records writes, answers reads from `routes`. */
function fakeApple(routes: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  let next = 0;
  const api = {
    request: async (path: string, method = "GET", body?: any) => {
      calls.push({ method, path, body });
      for (const [pattern, value] of Object.entries(routes))
        if (path.startsWith(pattern))
          return typeof value === "function"
            ? (value as any)(path, body)
            : value;
      if (method === "POST") return { data: { id: `new${++next}` } };
      return { data: [] };
    },
  };
  return { api: api as any, calls };
}

describe("monetization file", () => {
  it("fills defaults and round-trips without empty sections", async () => {
    const dir = await mkdtemp(join(tmpdir(), "monetization-"));
    const path = join(dir, "assets/store/monetization.json");
    expect(await loadMonetization(path)).toEqual(emptyMonetization());
    await saveMonetization(path, {
      apple: {
        inAppPurchases: [
          {
            productId: "com.app.coins",
            type: "CONSUMABLE",
            referenceName: "Coins",
            price: "0.99",
            localizations: { "en-US": { name: "Coins" } },
          },
        ],
      },
    });
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(saved)).toEqual(["apple"]);
    expect(Object.keys(saved.apple)).toEqual(["inAppPurchases"]);
    expect(saved.apple.inAppPurchases[0].territories).toBe("ALL");
    expect((await loadMonetization(path)).apple.inAppPurchases[0]!.price).toBe(
      "0.99",
    );
  });

  it("rejects bad prices and reports cross-item problems", async () => {
    expect(
      monetizationSchema.safeParse({
        google: {
          products: [
            {
              productId: "coins",
              price: "1",
              listings: { "en-US": { title: "Coins" } },
            },
          ],
        },
      }).success,
    ).toBe(false);
    const m = config({
      apple: {
        inAppPurchases: [
          {
            productId: "a",
            type: "CONSUMABLE",
            referenceName: "A",
            price: "0.99",
            localizations: { "en-US": { name: "Aa" } },
          },
          {
            productId: "a",
            type: "CONSUMABLE",
            referenceName: "A2",
            price: "0.99",
            localizations: { "en-US": { name: "Aa" } },
          },
        ],
        offerCodes: [{ name: "Launch", productId: "a" }],
      },
      google: {
        promoCodes: [
          {
            name: "P",
            productId: "missing",
            kind: "oneTime",
            count: 5,
            start: "2027-01-02",
            end: "2027-01-01",
          },
        ],
      },
    });
    const problems = monetizationProblems(m).join(" ");
    expect(problems).toMatch(/Apple product a is listed twice/);
    expect(problems).toMatch(/needs an offer price/);
    expect(problems).toMatch(/ends before it starts/);
    expect(problems).toMatch(/isn't in this file/);
    const dir = await mkdtemp(join(tmpdir(), "monetization-"));
    await expect(saveMonetization(join(dir, "m.json"), m)).rejects.toThrow(
      /listed twice/,
    );
  });
});

describe("App Store", () => {
  const coins = {
    productId: "com.app.coins",
    type: "CONSUMABLE",
    referenceName: "Coins",
    price: "1.99",
    localizations: { "en-US": { name: "Coin pack", description: "100 coins" } },
  };

  it("compares the file with the store and lists unmanaged products", () => {
    const items = compareApple(
      config({
        apple: {
          app: { price: "2.99", territories: "ALL" },
          inAppPurchases: [coins],
        },
      }),
      liveApple({
        iaps: [
          {
            id: "i1",
            productId: "com.app.coins",
            type: "CONSUMABLE",
            name: "Coins",
            state: "APPROVED",
            price: "0.99",
            available: ["USA"],
            hasScreenshot: true,
            offers: [],
            localizations: [
              {
                id: "l1",
                locale: "en-US",
                name: "Coin pack",
                description: "100 coins",
              },
            ],
          },
          {
            id: "i2",
            productId: "com.app.old",
            type: "NON_CONSUMABLE",
            name: "Old",
            state: "APPROVED",
            price: "4.99",
            hasScreenshot: true,
            offers: [],
            localizations: [],
          },
        ],
      }),
    );
    const app = items.find((i) => i.key === "apple:app")!;
    expect(app.changes).toEqual(["Price free → $2.99"]);
    const iap = items.find((i) => i.key === "apple:iap:com.app.coins")!;
    expect(iap.changes).toEqual([
      "Price $0.99 → $1.99",
      "Availability: +2 territories",
    ]);
    expect(
      items.find((i) => i.key === "apple:unmanaged:com.app.old")?.managed,
    ).toBe(false);
  });

  it("creates a purchase with localization, US price, availability and screenshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "monetization-"));
    await mkdir(join(dir, "assets/store"), { recursive: true });
    await writeFile(join(dir, "assets/store/shot.png"), "png");
    const { api, calls } = fakeApple({
      "/v2/inAppPurchases/new1/pricePoints": {
        data: [{ id: "pp199", attributes: { customerPrice: "1.99" } }],
      },
      "/inAppPurchaseAppStoreReviewScreenshots": (_p: string, body: any) =>
        body?.data?.attributes?.uploaded
          ? {}
          : { data: { id: "shot1", attributes: { uploadOperations: [] } } },
    });
    const m = config({
      apple: { inAppPurchases: [{ ...coins, reviewScreenshot: "shot.png" }] },
    });
    await applyApple(
      api,
      m,
      liveApple(),
      new Set(["apple:iap:com.app.coins"]),
      {
        baseDir: join(dir, "assets/store"),
        projectRoot: dir,
        log: () => undefined,
      },
    );
    const writes = calls
      .filter((c) => c.method !== "GET")
      .map((c) => `${c.method} ${c.path}`);
    expect(writes).toEqual([
      "POST /v2/inAppPurchases",
      "POST /inAppPurchaseLocalizations",
      "POST /inAppPurchasePriceSchedules",
      "POST /inAppPurchaseAvailabilities",
      "POST /inAppPurchaseAppStoreReviewScreenshots",
      "PATCH /inAppPurchaseAppStoreReviewScreenshots/shot1",
    ]);
    const schedule = calls.find(
      (c) => c.path === "/inAppPurchasePriceSchedules",
    )!.body;
    expect(
      schedule.included[0].relationships.inAppPurchasePricePoint.data.id,
    ).toBe("pp199");
    expect(
      calls.find((c) => c.path === "/inAppPurchaseAvailabilities")!.body.data
        .relationships.availableTerritories.data,
    ).toHaveLength(3);
  });

  it("refuses a screenshot outside the project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "monetization-"));
    const { api } = fakeApple({
      "/v2/inAppPurchases/new1/pricePoints": {
        data: [{ id: "pp199", attributes: { customerPrice: "1.99" } }],
      },
    });
    const m = config({
      apple: {
        inAppPurchases: [
          { ...coins, reviewScreenshot: "../../../etc/shot.png" },
        ],
      },
    });
    await expect(
      applyApple(api, m, liveApple(), new Set(["apple:iap:com.app.coins"]), {
        baseDir: join(dir, "a"),
        projectRoot: dir,
        log: () => undefined,
      }),
    ).rejects.toThrow(/inside the project/);
  });

  it("prices a subscription in every territory from the US point's equalizations", async () => {
    const { api, calls } = fakeApple({
      "/subscriptions/new3/pricePoints": {
        data: [{ id: "us499", attributes: { customerPrice: "4.99" } }],
      },
      "/subscriptionPricePoints/us499/equalizations": {
        data: [
          { id: "ca", relationships: { territory: { data: { id: "CAN" } } } },
          { id: "gb", relationships: { territory: { data: { id: "GBR" } } } },
        ],
      },
    });
    const m = config({
      apple: {
        subscriptionGroups: [
          {
            referenceName: "Pro",
            localizations: { "en-US": { name: "Pro" } },
            subscriptions: [
              {
                productId: "pro.monthly",
                referenceName: "Monthly",
                period: "ONE_MONTH",
                price: "4.99",
                localizations: { "en-US": { name: "Pro monthly" } },
                introOffer: { mode: "FREE_TRIAL", duration: "ONE_WEEK" },
              },
            ],
          },
        ],
      },
    });
    await applyApple(
      api,
      m,
      liveApple(),
      new Set(["apple:group:Pro", "apple:subscription:pro.monthly"]),
      {
        baseDir: "/p/assets/store",
        projectRoot: "/p",
        log: () => undefined,
      },
    );
    // Every territory's price, then every trial, each in one atomic request.
    const patches = calls.filter(
      (c) => c.method === "PATCH" && c.path === "/subscriptions/new3",
    );
    expect(patches).toHaveLength(2);
    const [prices, intro] = patches.map((c) => c.body);
    expect(
      prices.included.map((p: any) => p.relationships.territory.data.id).sort(),
    ).toEqual(["CAN", "GBR", "USA"]);
    expect(prices.data.relationships.prices.data).toHaveLength(3);
    expect(
      prices.included.every(
        (p: any) => p.attributes.preserveCurrentPrice === false,
      ),
    ).toBe(true);
    expect(intro.included).toHaveLength(3);
    expect(intro.data.relationships.introductoryOffers.data).toHaveLength(3);
    expect(
      intro.included[0].relationships.subscriptionPricePoint,
    ).toBeUndefined();
    expect(calls.some((c) => c.path === "/subscriptionPrices")).toBe(false);
    // The group exists before its subscription is created inside it.
    expect(
      calls.findIndex((c) => c.path === "/subscriptionGroups"),
    ).toBeLessThan(
      calls.findIndex(
        (c) => c.path === "/subscriptions" && c.method === "POST",
      ),
    );
  });

  it("creates an in-app purchase offer code and returns its one-time codes", async () => {
    const { api, calls } = fakeApple({
      "/inAppPurchaseOfferCodeOneTimeUseCodes/new2/values": "code\nAAA\nBBB\n",
    });
    const m = config({
      apple: {
        inAppPurchases: [coins],
        offerCodes: [
          {
            name: "Launch",
            productId: "com.app.coins",
            price: "0.00",
            batches: [{ kind: "oneTime", count: 2, expires: "2027-01-01" }],
          },
        ],
      },
    });
    const live = liveApple({
      iaps: [
        {
          id: "i1",
          productId: "com.app.coins",
          type: "CONSUMABLE",
          name: "Coins",
          state: "APPROVED",
          price: "1.99",
          available: territories,
          hasScreenshot: true,
          offers: [],
          localizations: [],
        },
      ],
    });
    const result = await applyApple(
      api,
      m,
      live,
      new Set(["apple:offer:com.app.coins:Launch"]),
      {
        baseDir: "/p/assets/store",
        projectRoot: "/p",
        log: () => undefined,
      },
    );
    const offer = calls.find(
      (c) => c.path === "/inAppPurchaseOfferCodes",
    )!.body;
    expect(offer.data.attributes.customerEligibilities).toEqual([
      "NON_SPENDER",
      "ACTIVE_SPENDER",
      "CHURNED_SPENDER",
    ]);
    expect(offer.included).toHaveLength(3);
    expect(offer.included[0].relationships.pricePoint).toBeUndefined(); // free
    expect(result.batches).toEqual([
      expect.objectContaining({
        key: "apple:offer:com.app.coins:Launch",
        index: 0,
        id: "new2",
      }),
    ]);
    expect(result.codes[0]!.csv).toContain("AAA");
  });

  it("imports store products as file entries", () => {
    const imported = importApple(
      liveApple({
        groups: [
          {
            id: "g1",
            referenceName: "Pro",
            localizations: [{ id: "x", locale: "en-US", name: "Pro" }],
          },
        ],
        subscriptions: [
          {
            id: "s1",
            groupId: "g1",
            productId: "pro.year",
            name: "Yearly",
            state: "APPROVED",
            period: "ONE_YEAR",
            price: "29.99",
            available: territories,
            hasScreenshot: true,
            offers: [],
            localizations: [{ id: "y", locale: "en-US", name: "Pro yearly" }],
          },
        ],
      }),
      ["pro.year"],
    );
    expect(imported.groups[0]!.subscriptions[0]).toMatchObject({
      productId: "pro.year",
      price: "29.99",
      territories: "ALL",
      period: "ONE_YEAR",
    });
  });
});

describe("Google Play", () => {
  const live = (patch: Partial<GoogleLive> = {}): GoogleLive => ({
    packageName: "com.app",
    products: [],
    subscriptions: [],
    offers: {},
    ...patch,
  });
  function fakeGoogle() {
    const calls: { method: string; path: string; body?: any }[] = [];
    const api = {
      request: async (path: string, method = "GET", body?: any) => {
        calls.push({ method, path, body });
        if (path.includes("pricing:convertRegionPrices"))
          return {
            regionVersion: { version: "2025/03" },
            convertedRegionPrices: {
              US: {
                regionCode: "US",
                price: {
                  currencyCode: "USD",
                  units: String(Math.floor(Number(body.price.units))),
                  nanos: body.price.nanos,
                },
              },
              JP: {
                regionCode: "JP",
                price: { currencyCode: "JPY", units: "300" },
              },
            },
            convertedOtherRegionsPrice: {
              usdPrice: body.price,
              eurPrice: { currencyCode: "EUR", units: "2" },
            },
          };
        if (method === "PATCH" && path.includes("/onetimeproducts/"))
          return {
            ...body,
            purchaseOptions: body.purchaseOptions.map((o: any) => ({
              ...o,
              state: "DRAFT",
            })),
          };
        if (method === "POST" && path.includes("/subscriptions?"))
          return {
            ...body,
            basePlans: body.basePlans.map((b: any) => ({
              ...b,
              state: "DRAFT",
            })),
          };
        return {};
      },
    };
    return { api: api as any, calls };
  }
  const product = {
    productId: "coins",
    price: "1.99",
    listings: { "en-US": { title: "Coins" } },
    regionalPrices: { JP: "250" },
  };

  it("creates a one-time product priced in every region and activates it", async () => {
    const { api, calls } = fakeGoogle();
    await applyGoogle(
      api,
      config({ google: { products: [product] } }),
      live(),
      new Set(["google:product:coins"]),
      () => undefined,
    );
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe(
      "/applications/com.app/onetimeproducts/coins?allowMissing=true&updateMask=listings,purchaseOptions&regionsVersion.version=2025%2F03",
    );
    const regions =
      patch.body.purchaseOptions[0].regionalPricingAndAvailabilityConfigs;
    expect(regions.find((r: any) => r.regionCode === "US").price).toEqual({
      currencyCode: "USD",
      units: "1",
      nanos: 990000000,
    });
    expect(regions.find((r: any) => r.regionCode === "JP").price).toEqual({
      currencyCode: "JPY",
      units: "250",
      nanos: 0,
    });
    const activate = calls.find((c) =>
      c.path.endsWith("purchaseOptions:batchUpdateStates"),
    )!;
    expect(
      activate.body.requests[0].activatePurchaseOptionRequest.purchaseOptionId,
    ).toBe("buy");
  });

  it("creates a subscription, activates its base plan and adds a free trial", async () => {
    const { api, calls } = fakeGoogle();
    const sub = {
      productId: "pro",
      listings: { "en-US": { title: "Pro" } },
      basePlans: [
        {
          basePlanId: "monthly",
          period: "P1M",
          price: "4.99",
          offers: [
            { offerId: "trial", phases: [{ duration: "P1W", price: "free" }] },
          ],
        },
      ],
    };
    await applyGoogle(
      api,
      config({ google: { subscriptions: [sub] } }),
      live(),
      new Set(["google:subscription:pro"]),
      () => undefined,
    );
    const paths = calls
      .filter(
        (c) => c.method !== "GET" && !c.path.includes("convertRegionPrices"),
      )
      .map((c) => `${c.method} ${c.path.split("?")[0]}`);
    expect(paths).toEqual([
      "POST /applications/com.app/subscriptions",
      "POST /applications/com.app/subscriptions/pro/basePlans/monthly:activate",
      "POST /applications/com.app/subscriptions/pro/basePlans/monthly/offers",
      "POST /applications/com.app/subscriptions/pro/basePlans/monthly/offers/trial:activate",
    ]);
    const offer = calls.find((c) =>
      c.path.includes("/offers?offerId=trial"),
    )!.body;
    expect(offer.phases[0].regionalConfigs).toEqual([
      { regionCode: "US", free: {} },
      { regionCode: "JP", free: {} },
    ]);
    expect(offer.targeting.acquisitionRule.scope.thisSubscription).toEqual({});
  });

  it("flags price and listing drift and promotions waiting for Play Console", () => {
    const items = compareGoogle(
      config({
        google: {
          products: [product],
          promoCodes: [
            {
              name: "Spring",
              productId: "coins",
              kind: "oneTime",
              count: 10,
              start: "2027-03-01",
              end: "2027-03-31",
            },
          ],
        },
      }),
      live({
        products: [
          {
            productId: "coins",
            listings: [{ languageCode: "en-US", title: "Old coins" }],
            purchaseOptions: [
              {
                purchaseOptionId: "buy",
                buyOption: {},
                state: "ACTIVE",
                regionalPricingAndAvailabilityConfigs: [
                  {
                    regionCode: "US",
                    price: {
                      currencyCode: "USD",
                      units: "0",
                      nanos: 990000000,
                    },
                  },
                ],
              },
            ],
          },
          {
            productId: "gems",
            listings: [{ languageCode: "en-US", title: "Gems" }],
            purchaseOptions: [],
          },
        ],
      }),
    );
    expect(
      items.find((i) => i.key === "google:product:coins")!.changes,
    ).toEqual([
      "Update en-US listing",
      "Price $0.99 → $1.99",
      "JP price → 250",
    ]);
    expect(
      items.find((i) => i.key === "google:promo:Spring")!.changes[0],
    ).toMatch(/Play Console/);
    expect(
      importGoogle(
        live({
          products: [
            {
              productId: "gems",
              listings: [{ languageCode: "en-US", title: "Gems" }],
              purchaseOptions: [],
            },
          ],
        }),
        ["gems"],
      ).products[0]!.productId,
    ).toBe("gems");
  });
});

it("writes generated batch ids back to the file and keeps code values private", async () => {
  const root = await mkdtemp(join(tmpdir(), "monetization-project-"));
  const codes = await mkdtemp(join(tmpdir(), "monetization-codes-"));
  const project = {
    id: "p1",
    path: root,
    name: "App",
    bundleId: "com.app",
    profiles: [],
    createdAt: "",
    settings: {},
  } as Project;
  const file = join(root, "assets/store/monetization.json");
  await saveMonetization(file, {
    apple: {
      inAppPurchases: [
        {
          productId: "com.app.coins",
          type: "CONSUMABLE",
          referenceName: "Coins",
          price: "1.99",
          localizations: { "en-US": { name: "Coin pack" } },
        },
      ],
      offerCodes: [
        {
          name: "Launch",
          productId: "com.app.coins",
          price: "0.00",
          batches: [{ kind: "oneTime", count: 2, expires: "2027-01-01" }],
        },
      ],
    },
  });
  const { api } = fakeApple({
    "/apps?": { data: [{ id: "app1", attributes: { bundleId: "com.app" } }] },
    "/territories": { data: territories.map((id) => ({ id })) },
    "/apps/app1/inAppPurchasesV2": {
      data: [
        {
          id: "i1",
          attributes: {
            productId: "com.app.coins",
            inAppPurchaseType: "CONSUMABLE",
            name: "Coins",
            state: "APPROVED",
          },
        },
      ],
    },
    "/inAppPurchaseOfferCodeOneTimeUseCodes/new2/values": "code\nAAA\nBBB\n",
  });
  api.app = async () => ({ id: "app1" });
  const service = new MonetizationService(
    project,
    { apple: async () => api },
    codes,
  );
  await service.apply(["apple:offer:com.app.coins:Launch"], () => undefined);
  const saved = await loadMonetization(file);
  expect(saved.apple.offerCodes[0]!.batches[0]).toMatchObject({
    id: "new2",
    generatedAt: expect.any(String),
  });
  expect(await readFile(file, "utf8")).not.toContain("AAA");
  const [csv] = await readdir(join(codes, "p1"));
  expect(await readFile(join(codes, "p1", csv!), "utf8")).toContain("BBB");
  expect((await service.savedCodes())[0]).toMatchObject({
    key: "apple:offer:com.app.coins:Launch",
    count: 2,
  });
});

it("accepts store text longer than older local limits", () => {
  // DuoDuo's real purchase description is longer than the 45 characters an
  // earlier schema allowed; imports must take what the store already has.
  expect(
    monetizationSchema.safeParse({
      apple: {
        inAppPurchases: [
          {
            productId: "com.app.book",
            type: "NON_CONSUMABLE",
            referenceName: "Book",
            price: "4.99",
            localizations: {
              "en-US": { name: "Full book", description: "x".repeat(55) },
            },
          },
        ],
      },
    }).success,
  ).toBe(true);
});
