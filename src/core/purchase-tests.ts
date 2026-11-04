import { createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import plist from "plist";
import { run, type CommandOptions, type CommandResult } from "./process";
import type { Monetization } from "./monetization";
import { invariant } from "./errors";
import {
  purchaseTestingSchema,
  type PurchaseTesting,
} from "./purchase-test-schema";

const identifier = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 24).toUpperCase();
export function storeKitConfiguration(catalog: Monetization) {
  const localization = (
    values: Record<string, { name: string; description?: string }>,
  ) =>
    Object.entries(values).map(([locale, v]) => ({
      description: v.description ?? v.name,
      displayName: v.name,
      locale: locale.replaceAll("-", "_"),
    }));
  const base = (p: {
    productId: string;
    price: string;
    referenceName: string;
    familySharable?: boolean;
    localizations: Record<string, { name: string; description?: string }>;
  }) => ({
    displayPrice: p.price,
    familyShareable: p.familySharable ?? false,
    internalID: identifier(p.productId),
    localizations: localization(p.localizations),
    productID: p.productId,
    referenceName: p.referenceName,
  });
  const periods: Record<string, string> = {
    ONE_WEEK: "P1W",
    ONE_MONTH: "P1M",
    TWO_MONTHS: "P2M",
    THREE_MONTHS: "P3M",
    SIX_MONTHS: "P6M",
    ONE_YEAR: "P1Y",
  };
  return {
    identifier: identifier("Local Build Desk purchase tests"),
    products: catalog.apple.inAppPurchases
      .filter((p) => p.type !== "NON_RENEWING_SUBSCRIPTION")
      .map((p) => ({
        ...base(p),
        type: p.type === "CONSUMABLE" ? "Consumable" : "NonConsumable",
      })),
    nonRenewingSubscriptions: catalog.apple.inAppPurchases
      .filter((p) => p.type === "NON_RENEWING_SUBSCRIPTION")
      .map((p) => ({ ...base(p), type: "NonRenewingSubscription" })),
    subscriptionGroups: catalog.apple.subscriptionGroups.map((g) => ({
      id: identifier(g.referenceName),
      name: g.referenceName,
      localizations: Object.entries(g.localizations).map(([locale, v]) => ({
        description: v.name,
        displayName: v.name,
        locale: locale.replaceAll("-", "_"),
      })),
      subscriptions: g.subscriptions.map((s, index) => ({
        ...base(s),
        adHocOffers: [],
        codeOffers: [],
        winbackOffers: [],
        groupNumber: s.level ?? index + 1,
        introductoryOffer: null,
        recurringSubscriptionPeriod: periods[s.period],
        subscriptionGroupID: identifier(g.referenceName),
        type: "RecurringSubscription",
      })),
    })),
    settings: {
      _failTransactionsEnabled: false,
      _locale: "en_US",
      _storefront: "USA",
      _timeRate: 0,
    },
    version: { major: 3, minor: 0 },
  };
}
export function purchasePlan(catalog: Monetization, input: PurchaseTesting) {
  const config = purchaseTestingSchema.parse(input),
    storekit = storeKitConfiguration(catalog);
  const subscription = catalog.apple.subscriptionGroups
    .flatMap((g) => g.subscriptions)
    .some((p) => p.productId === config.productId);
  invariant(
    subscription ||
      catalog.apple.inAppPurchases.some(
        (p) => p.productId === config.productId,
      ),
    "PURCHASE_PRODUCT",
    "Import or add this Apple product to the monetization file before testing it.",
  );
  invariant(
    subscription ||
      !config.scenarios.some((s) =>
        ["renewal", "cancellation", "expiration"].includes(s),
      ),
    "PURCHASE_SUBSCRIPTION",
    "Renewal, cancellation and expiry scenarios require an auto-renewable subscription.",
  );
  return {
    ...config,
    storekit,
    catalogHash: createHash("sha256")
      .update(JSON.stringify(catalog))
      .digest("hex"),
  };
}
/** Extend the existing disposable UI runner; the user's Xcode project is never edited. */
export async function addPurchaseRunner(
  root: string,
  catalog: Monetization,
  config: PurchaseTesting,
) {
  const file = join(root, "plan.json"),
    plan = JSON.parse(await readFile(file, "utf8"));
  plan.purchases = purchasePlan(catalog, config);
  await writeFile(file, JSON.stringify(plan), { mode: 0o600 });
  await writeFile(
    join(root, "Screenshots.swift"),
    (await readFile(join(root, "Screenshots.swift"), "utf8")) + purchaseSwift,
  );
}

/** Bind the disposable UI runner to the exact app being checked. Without a
 * target app, StoreKitTest treats the runner itself as the purchase client. */
export function bindPurchaseTarget(
  value: any,
  appPath: string,
  bundleId: string,
): number {
  let bound = 0;
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.TestBundlePath && node.IsUITestBundle) {
      node.UITargetAppPath = appPath;
      node.UITargetAppBundleIdentifier = bundleId;
      node.UseUITargetAppProvidedByTests = false;
      node.DependentProductPaths = [
        ...new Set([...(node.DependentProductPaths ?? []), appPath]),
      ];
      bound++;
    }
    for (const child of Object.values(node))
      if (typeof child === "object") visit(child);
  };
  visit(value);
  return bound;
}
export async function runPurchaseRunner(
  input: {
    root: string;
    appPath: string;
    bundleId: string;
    deviceId: string;
    derived: string;
    resultBundle: string;
  },
  options: CommandOptions,
): Promise<CommandResult> {
  const built = await run(
    "xcodebuild",
    [
      "-project",
      join(input.root, "DeskScreenshots.xcodeproj"),
      "-scheme",
      "DeskScreenshots",
      "-configuration",
      "Debug",
      "-destination",
      `id=${input.deviceId}`,
      "-derivedDataPath",
      input.derived,
      "-parallel-testing-enabled",
      "NO",
      "CODE_SIGNING_ALLOWED=NO",
      "ONLY_ACTIVE_ARCH=YES",
      "build-for-testing",
    ],
    options,
  );
  if (built.code !== 0) return built;
  const products = join(input.derived, "Build/Products");
  const files = (await readdir(products)).filter(
    (p) => p.startsWith("DeskScreenshots_") && p.endsWith(".xctestrun"),
  );
  invariant(
    files.length === 1,
    "PURCHASE_RUNNER",
    "Expected one disposable purchase test manifest. Inspect the build logs before retrying.",
  );
  const path = join(products, files[0]),
    converted = await run("plutil", ["-convert", "json", "-o", "-", path], {
      ...options,
      log: undefined,
      allowFailure: false,
    });
  const manifest = JSON.parse(converted.stdout);
  invariant(
    bindPurchaseTarget(manifest, input.appPath, input.bundleId) > 0,
    "PURCHASE_TARGET",
    "The purchase runner did not declare a UI-test target. No purchase was attempted.",
  );
  await writeFile(path, plist.build(manifest), { mode: 0o600 });
  return run(
    "xcodebuild",
    [
      "test-without-building",
      "-xctestrun",
      path,
      "-destination",
      `id=${input.deviceId}`,
      "-resultBundlePath",
      input.resultBundle,
      "-parallel-testing-enabled",
      "NO",
    ],
    options,
  );
}

export const purchaseSwift = `
import StoreKitTest

final class DeskPurchaseTests: XCTestCase {
  @MainActor func testPurchaseScenarios() async throws {
    let planURL = Bundle(for: Self.self).url(forResource: "plan", withExtension: "json")!
    let plan = try JSONSerialization.jsonObject(with: Data(contentsOf: planURL)) as! [String: Any]
    let config = plan["purchases"] as! [String: Any]
    let configuration = FileManager.default.temporaryDirectory.appendingPathComponent("DeskPurchases.storekit")
    try JSONSerialization.data(withJSONObject: config["storekit"]!).write(to: configuration)
    let session = try SKTestSession(contentsOf: configuration)
    session.resetToDefaultState()
    session.disableDialogs = true
    // Prove the local test environment accepts overrides before launching an
    // app or tapping Buy. A broken runtime must never fall through to real billing.
    try await session.setSimulatedError(.purchase(.purchaseNotAllowed), forAPI: .purchase)
    guard await session.simulatedError(forAPI: .purchase) == .purchase(.purchaseNotAllowed) else {
      throw NSError(domain: "LocalBuildDesk.Purchases", code: 2, userInfo: [NSLocalizedDescriptionKey: "StoreKit Test is unavailable in this Xcode/simulator combination. Use a compatible runtime (iOS 26.6 or newer); no purchase was attempted."])
    }
    try await session.setSimulatedError(nil, forAPI: .purchase)
    let product = config["productId"] as! String
    let probe = try await session.buyProduct(identifier: product, options: [])
    guard probe.appBundleID == plan["bundleId"] as! String else {
      session.clearTransactions()
      throw NSError(domain: "LocalBuildDesk.Purchases", code: 3, userInfo: [NSLocalizedDescriptionKey: "StoreKit Test targeted the runner instead of this app. No app purchase was attempted. Rebuild the disposable runner with the selected app target."])
    }
    session.clearTransactions()
    let app = XCUIApplication(bundleIdentifier: plan["bundleId"] as! String)
    app.launchArguments = config["launchArguments"] as? [String] ?? []
    var scenarioName = "preparation"
    func element(_ key: String) -> XCUIElement {
      app.descendants(matching: .any).matching(identifier: config[key] as? String ?? "MISSING_PURCHASE_TEST_IDENTIFIER").firstMatch
    }
    func require(_ key: String) throws {
      guard element(key).waitForExistence(timeout: 15) else {
        XCTFail("Purchase scenario \\(scenarioName) did not reach app UI: \\(key). Check the app’s entitlement handling and accessibility mapping.")
        throw NSError(domain: "LocalBuildDesk.Purchases", code: 1)
      }
    }
    defer { app.terminate(); session.clearTransactions(); session.resetToDefaultState() }
    for scenario in config["scenarios"] as! [String] {
      scenarioName = scenario
      print("Local Build Desk purchase scenario: \\(scenario)")
      session.clearTransactions()
      session.resetToDefaultState()
      try await session.setSimulatedError(nil, forAPI: .purchase)
      session.disableDialogs = true
      app.terminate(); app.launch()
      try require("lockedIdentifier")
      if scenario == "failedPayment" {
        try await session.setSimulatedError(.purchase(.purchaseNotAllowed), forAPI: .purchase)
        try require("buyIdentifier"); element("buyIdentifier").tap()
        try require("failureIdentifier"); try require("lockedIdentifier")
        XCTAssertFalse(element("unlockedIdentifier").exists, "A failed payment must not unlock the app")
        continue
      }
      if scenario == "purchase" {
        try require("buyIdentifier"); element("buyIdentifier").tap()
      } else { _ = try await session.buyProduct(identifier: product, options: []) }
      try require("unlockedIdentifier")
      if scenario == "restore" {
        app.terminate(); app.launch()
        try require("restoreIdentifier"); element("restoreIdentifier").tap()
        try require("unlockedIdentifier")
      } else if scenario == "refund" {
        let transaction = try XCTUnwrap(session.allTransactions().last)
        try session.refundTransaction(identifier: transaction.identifier)
        try require("lockedIdentifier")
      } else if scenario == "renewal" {
        try session.forceRenewalOfSubscription(productIdentifier: product)
        try require("unlockedIdentifier")
        XCTAssertGreaterThanOrEqual(session.allTransactions().count, 2)
      } else if scenario == "cancellation" {
        let transaction = try XCTUnwrap(session.allTransactions().last)
        try session.disableAutoRenewForTransaction(identifier: transaction.identifier)
        XCTAssertFalse(try XCTUnwrap(session.allTransactions().last).autoRenewingEnabled, "The test environment must confirm renewal is disabled")
        try require("unlockedIdentifier")
      } else if scenario == "expiration" {
        try session.expireSubscription(productIdentifier: product)
        XCTAssertLessThanOrEqual(try XCTUnwrap(session.allTransactions().last?.expirationDate), Date().addingTimeInterval(1), "The test environment must expire the subscription before checking the app")
        try require("lockedIdentifier")
      }
    }
  }
}
`;
