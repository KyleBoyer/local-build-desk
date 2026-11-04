import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { monetizationSchema } from "../src/core/monetization";
import {
  purchasePlan,
  storeKitConfiguration,
  addPurchaseRunner,
  bindPurchaseTarget,
} from "../src/core/purchase-tests";
import { purchaseTestingSchema } from "../src/core/purchase-test-schema";
import { createScreenshotRunner } from "../src/core/screenshot-runner";
const catalog = monetizationSchema.parse({
  apple: {
    inAppPurchases: [
      {
        productId: "com.example.unlock",
        type: "NON_CONSUMABLE",
        referenceName: "Unlock",
        price: "4.99",
        localizations: { "en-US": { name: "Unlock" } },
      },
    ],
  },
});
const config = purchaseTestingSchema.parse({
  productId: "com.example.unlock",
  scenarios: ["purchase", "refund", "failedPayment"],
  buyIdentifier: "buy",
  unlockedIdentifier: "unlocked",
  lockedIdentifier: "locked",
  failureIdentifier: "payment-error",
});
it("generates stable local catalog data and requires real app assertions", () => {
  const first = storeKitConfiguration(catalog);
  expect(first).toEqual(storeKitConfiguration(catalog));
  expect(first.products[0]).toMatchObject({
    productID: "com.example.unlock",
    displayPrice: "4.99",
    type: "NonConsumable",
  });
  expect(() =>
    purchasePlan(catalog, { ...config, scenarios: ["renewal"] }),
  ).toThrow(/auto-renewable/);
  expect(
    purchaseTestingSchema.safeParse({ ...config, scenarios: ["restore"] })
      .success,
  ).toBe(false);
  expect(
    purchaseTestingSchema.safeParse({
      ...config,
      lockedIdentifier: config.unlockedIdentifier,
    }).success,
  ).toBe(false);
});
it("binds only UI tests to the exact simulator app in both manifest formats", () => {
  for (const manifest of [
    {
      Tests: {
        IsUITestBundle: true,
        TestBundlePath: "tests.xctest",
        DependentProductPaths: ["runner.app"],
      },
    },
    {
      TestConfigurations: [
        {
          TestTargets: [
            { IsUITestBundle: true, TestBundlePath: "tests.xctest" },
            { IsUITestBundle: false, TestBundlePath: "unit.xctest" },
          ],
        },
      ],
    },
  ]) {
    expect(
      bindPurchaseTarget(manifest, "/snapshot/App.app", "com.example.app"),
    ).toBe(1);
    expect(JSON.stringify(manifest)).toContain(
      '"UITargetAppPath":"/snapshot/App.app"',
    );
    expect(JSON.stringify(manifest)).toContain(
      '"UseUITargetAppProvidedByTests":false',
    );
  }
});
it("adds a disposable StoreKit test runner without editing the source project", async () => {
  const root = await mkdtemp(join(tmpdir(), "lbd-purchase-runner-"));
  try {
    await createScreenshotRunner(root, "com.example.app", {
      captures: [],
      appearance: "light",
      language: "en",
      locale: "en_US",
    });
    await addPurchaseRunner(root, catalog, config);
    const plan = JSON.parse(await readFile(join(root, "plan.json"), "utf8"));
    expect(plan.purchases.catalogHash).toMatch(/^[a-f0-9]{64}$/);
    const source = await readFile(join(root, "Screenshots.swift"), "utf8");
    expect(source).toContain("SKTestSession(contentsOf:");
    expect(source).toContain('require("unlockedIdentifier")');
    expect(source).toContain("setSimulatedError");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
