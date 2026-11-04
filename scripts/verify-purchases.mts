// Optional live simulator acceptance. Uses only a disposable fixture, test
// transactions and a simulator created by this script. No store credentials.
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNativeFixture } from "../tests/fixtures/native/create.ts";
import { createScreenshotRunner } from "../src/core/screenshot-runner.ts";
import {
  addPurchaseRunner,
  runPurchaseRunner,
} from "../src/core/purchase-tests.ts";
import { monetizationSchema } from "../src/core/monetization.ts";
import { run } from "../src/core/process.ts";
import { SIMULATOR_LOCAL_SIGNING } from "../src/core/release-validation.ts";
const root = await mkdtemp(join(tmpdir(), "lbd-purchase-acceptance-"));
const logPath = join(root, "acceptance.log");
let deviceId: string | undefined;
const execute = (command: string, args: string[], timeout = 180000) =>
  run(command, args, {
    timeout,
    log: (line) => {
      void appendFile(logPath, line + "\n");
    },
  });
try {
  await createNativeFixture(root, false);
  await writeFile(
    join(root, "App/Main.swift"),
    `import SwiftUI
import StoreKit
@MainActor final class Shop: ObservableObject {
  let productID = ProcessInfo.processInfo.arguments.contains("--subscription") ? "com.example.monthly" : "com.example.unlock"
  @Published var unlocked = false
  @Published var failed = false
  init() {
    Task { await refresh() }
    Task { for await result in Transaction.updates { if case .verified(let t) = result { await t.finish(); await refresh() } } }
    Task { for await _ in Product.SubscriptionInfo.Status.updates { await refresh() } }
    // The fixture also refreshes while visible, so a test-time clock change
    // can be observed even when the simulator emits no transaction update.
    Task { while !Task.isCancelled { await refresh(); try? await Task.sleep(nanoseconds: 500_000_000) } }
  }
  func refresh() async {
    var access = false
    for await result in Transaction.currentEntitlements { if case .verified(let t) = result, t.productID == productID, t.revocationDate == nil, t.expirationDate == nil || t.expirationDate! > Date() { access = true } }
    if productID == "com.example.monthly", let p = try? await Product.products(for: [productID]).first, let statuses = try? await p.subscription?.status { access = statuses.contains { $0.state == .subscribed || $0.state == .inGracePeriod } }
    unlocked = access
  }
  func buy() async {
    do { guard let p = try await Product.products(for: [productID]).first else { failed = true; return }; let r = try await p.purchase(); if case .success(.verified(let t)) = r { await t.finish(); await refresh() } }
    catch { failed = true }
  }
  func restore() async { do { try await AppStore.sync(); await refresh() } catch { failed = true } }
}
@main struct PurchaseFixture: App {
  @StateObject var shop = Shop()
  var body: some Scene { WindowGroup { VStack(spacing: 20) {
    if shop.unlocked { Text("Unlocked").accessibilityIdentifier("unlocked") } else { Text("Locked").accessibilityIdentifier("locked") }
    Button("Buy") { Task { await shop.buy() } }.accessibilityIdentifier("buy")
    Button("Restore") { Task { await shop.restore() } }.accessibilityIdentifier("restore")
    if shop.failed { Text("Payment failed").accessibilityIdentifier("payment-error") }
  }.padding() } }
}
`,
  );
  const listing = JSON.parse(
    (await execute("xcrun", ["simctl", "list", "devices", "available", "-j"]))
      .stdout,
  );
  const sdkVersion = (
    await execute("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-version"])
  ).stdout.trim();
  const runtime = Object.keys(listing.devices)
    .filter((id) => /iOS-/.test(id) && !/iPhone\d/.test(id))
    .sort()
    .find((id) => id.endsWith(`iOS-${sdkVersion.replaceAll(".", "-")}`))!;
  const chosen = listing.devices[runtime]?.find((d: any) =>
    d.name.startsWith("iPhone"),
  );
  const types = JSON.parse(
    (await execute("xcrun", ["simctl", "list", "devicetypes", "-j"])).stdout,
  ).devicetypes;
  const deviceType =
    chosen?.deviceTypeIdentifier ??
    types.find((d: any) => d.name === chosen?.name)?.identifier;
  if (!runtime || !deviceType)
    throw Error(
      "Install an iOS simulator runtime and iPhone device type before this optional acceptance test.",
    );
  deviceId = (
    await execute("xcrun", [
      "simctl",
      "create",
      "Local Build Desk purchase acceptance",
      deviceType,
      runtime,
    ])
  ).stdout.trim();
  console.log(`Created disposable simulator; diagnostic log: ${logPath}`);
  await execute("xcrun", ["simctl", "boot", deviceId]);
  await execute("xcrun", ["simctl", "bootstatus", deviceId, "-b"]);
  console.log("Building the fixture app…");
  await execute(
    "xcodebuild",
    [
      "-project",
      join(root, "DeskApp.xcodeproj"),
      "-scheme",
      "DeskFixture",
      "-sdk",
      "iphonesimulator",
      "-configuration",
      "Debug",
      "-destination",
      `id=${deviceId}`,
      "-derivedDataPath",
      join(root, "derived"),
      ...SIMULATOR_LOCAL_SIGNING,
      "build",
    ],
    240000,
  );
  const app = join(
    root,
    "derived/Build/Products/Debug-iphonesimulator/DeskFixture.app",
  );
  await execute("xcrun", ["simctl", "install", deviceId, app]);
  for (const subscription of process.argv.includes("--subscriptions-only")
    ? [true]
    : [false, true]) {
    const runner = join(root, subscription ? "subscription-runner" : "runner");
    await createScreenshotRunner(
      runner,
      "com.example.localbuilddesk.nativefixture",
      { captures: [], appearance: "light", language: "en", locale: "en_US" },
    );
    await addPurchaseRunner(
      runner,
      monetizationSchema.parse({
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
          subscriptionGroups: [
            {
              referenceName: "Monthly access",
              localizations: { "en-US": { name: "Monthly access" } },
              subscriptions: [
                {
                  productId: "com.example.monthly",
                  referenceName: "Monthly",
                  price: "2.99",
                  period: "ONE_MONTH",
                  localizations: { "en-US": { name: "Monthly access" } },
                },
              ],
            },
          ],
        },
      }),
      {
        productId: subscription ? "com.example.monthly" : "com.example.unlock",
        scenarios: subscription
          ? ["renewal", "cancellation", "expiration"]
          : ["purchase", "restore", "refund", "failedPayment"],
        buyIdentifier: "buy",
        unlockedIdentifier: "unlocked",
        lockedIdentifier: "locked",
        restoreIdentifier: "restore",
        failureIdentifier: "payment-error",
        launchArguments: subscription ? ["--subscription"] : [],
      },
    );
    console.log(
      subscription
        ? "Running subscription renewal, cancellation and expiration assertions…"
        : "Running purchase, restore, refund and payment-failure assertions…",
    );
    await runPurchaseRunner(
      {
        root: runner,
        appPath: app,
        bundleId: "com.example.localbuilddesk.nativefixture",
        deviceId,
        derived: join(root, "test-derived"),
        resultBundle: join(
          root,
          subscription ? "subscriptions.xcresult" : "purchases.xcresult",
        ),
      },
      {
        timeout: 240000,
        log: (line) => {
          void appendFile(logPath, line + "\n");
        },
      },
    );
  }
  console.log(`Live purchase acceptance passed. Results: ${root}`);
} finally {
  if (deviceId) {
    await execute("xcrun", ["simctl", "shutdown", deviceId]).catch(() => {});
    await execute("xcrun", ["simctl", "delete", deviceId]).catch(() => {});
  }
  // Retain the diagnostic bundle for inspection; it contains only fixture data.
}
