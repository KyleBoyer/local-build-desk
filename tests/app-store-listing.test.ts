import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyListing,
  displayTypeFor,
  listingPlan,
  loadListing,
} from "../src/core/app-store-listing";
import type { AppleAPI } from "../src/core/stores";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "listing-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A PNG header with the given size; the rest doesn't matter to Apple's fake. */
function png(name: string, width: number, height: number, fill = 0) {
  const data = Buffer.alloc(64, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  writeFileSync(join(dir, name), data);
  return createHash("md5").update(data).digest("hex");
}

function listing(extra: Record<string, unknown> = {}) {
  const path = join(dir, "listing.json");
  writeFileSync(
    path,
    JSON.stringify({
      name: "Fixture",
      description: "A game.",
      keywords: "puzzle",
      supportUrl: "https://example.com/support",
      privacyPolicyUrl: "https://example.com/privacy",
      contentRights: "DOES_NOT_USE_THIRD_PARTY_CONTENT",
      whatsNew: "Fixes",
      screenshots: ["a.png", "b.png"],
      ...extra,
    }),
  );
  return path;
}

/** An in-memory App Store Connect with a first version in draft. */
function apple(options: { screenshots?: string[]; contact?: boolean } = {}) {
  const writes: { method: string; path: string; body?: any }[] = [];
  const shots = (options.screenshots ?? []).map((checksum, i) => ({
    id: `shot${i}`,
    attributes: {
      sourceFileChecksum: checksum,
      assetDeliveryState: { state: "COMPLETE" },
    },
  }));
  let uploaded: any[] = [];
  const request = vi.fn(
    async (path: string, method = "GET", body?: any): Promise<any> => {
      if (method !== "GET") {
        writes.push({ method, path, body });
        if (path === "/appScreenshots" && method === "POST")
          return {
            data: {
              id: `new${uploaded.length}`,
              attributes: {
                uploadOperations: [
                  {
                    url: "https://upload.example/x",
                    method: "PUT",
                    offset: 0,
                    length: 64,
                    requestHeaders: [
                      { name: "Content-Type", value: "image/png" },
                    ],
                  },
                ],
              },
            },
          };
        if (path.startsWith("/appScreenshots/new") && method === "PATCH") {
          uploaded.push({
            id: path.split("/").pop(),
            attributes: {
              ...body.data.attributes,
              assetDeliveryState: { state: "COMPLETE" },
            },
          });
          return { data: {} };
        }
        if (path === "/reviewSubmissions")
          return { data: { id: "submission" } };
        return { data: { id: "created" } };
      }
      const route = path.split("?")[0];
      if (route === "/apps") return { data: [{ id: "app", attributes: {} }] };
      if (route === "/apps/app/appInfos")
        return {
          data: [
            {
              id: "info",
              attributes: { appStoreState: "PREPARE_FOR_SUBMISSION" },
            },
          ],
        };
      if (route === "/appInfos/info/appInfoLocalizations")
        return {
          data: [
            { id: "infoLoc", attributes: { locale: "en-US", name: "Fixture" } },
          ],
        };
      if (route === "/apps/app/appStoreVersions")
        return {
          data: [
            {
              id: "version",
              attributes: {
                versionString: "1.0",
                appStoreState: "PREPARE_FOR_SUBMISSION",
              },
            },
          ],
        };
      if (route === "/appStoreVersions/version/appStoreVersionLocalizations")
        return {
          data: [
            { id: "loc", attributes: { locale: "en-US", description: "Old" } },
          ],
        };
      if (route === "/appStoreVersions/version/appStoreReviewDetail")
        return {
          data: options.contact
            ? {
                id: "review",
                attributes: {
                  contactEmail: "a@example.com",
                  contactPhone: "+1 555 0100",
                },
              }
            : null,
        };
      if (route === "/appStoreVersions/version/build") return { data: null };
      if (route === "/appStoreVersionLocalizations/loc/appScreenshotSets")
        return {
          data: [
            {
              id: "set",
              attributes: { screenshotDisplayType: "APP_IPHONE_67" },
            },
          ],
        };
      if (route === "/appScreenshotSets/set/appScreenshots")
        return {
          data: writes.some((w) => w.path === "/appScreenshots")
            ? uploaded
            : shots,
        };
      if (route === "/builds")
        return { data: [{ id: "build7", attributes: { version: "7" } }] };
      if (route === "/reviewSubmissions") return { data: [] };
      if (route === "/apps/app/inAppPurchasesV2")
        return {
          data: [
            {
              id: "iap",
              attributes: {
                productId: "com.example.full",
                state: "READY_TO_SUBMIT",
              },
            },
          ],
        };
      if (route.startsWith("/appInfos/info/")) return { data: null };
      throw new Error(`unexpected ${path}`);
    },
  );
  const api = {
    request,
    app: async () => ({ id: "app", attributes: {} }),
  } as unknown as AppleAPI;
  return { api, writes, request };
}

it("maps screenshot sizes to Apple display types", () => {
  expect(displayTypeFor(1320, 2868)).toBe("APP_IPHONE_67");
  expect(displayTypeFor(2868, 1320)).toBe("APP_IPHONE_67");
  expect(displayTypeFor(1284, 2778)).toBe("APP_IPHONE_65");
  expect(displayTypeFor(1080, 1920)).toBeUndefined();
});

it("rejects screenshots that aren't an App Store size", async () => {
  png("a.png", 1080, 1920);
  png("b.png", 1080, 1920);
  await expect(loadListing(listing())).rejects.toThrow(/1080×1920/);
});

it("plans text and screenshot changes, and says what blocks review", async () => {
  png("a.png", 1320, 2868, 1);
  png("b.png", 1320, 2868, 2);
  const { api } = apple();
  const plan = await listingPlan(
    api,
    "com.example.app",
    "1.0",
    await loadListing(listing()),
  );
  expect(plan.changes.map((c) => `${c.scope}.${c.field}`)).toEqual([
    "app.privacyPolicyUrl",
    "app.contentRightsDeclaration",
    "version.description",
    "version.keywords",
    "version.supportUrl",
  ]);
  // A first version takes no "What's New".
  expect(plan.changes.some((c) => c.field === "whatsNew")).toBe(false);
  expect(plan.screenshots).toMatchObject({
    displayType: "APP_IPHONE_67",
    keep: false,
    upload: ["a.png", "b.png"],
  });
  expect(plan.build).toEqual({ id: "build7", number: "7", attached: false });
  expect(plan.blockers).toEqual([expect.stringMatching(/contact/)]);
});

it("keeps screenshots that already match", async () => {
  const a = png("a.png", 1320, 2868, 1);
  const b = png("b.png", 1320, 2868, 2);
  const { api } = apple({ screenshots: [a, b] });
  const plan = await listingPlan(
    api,
    "com.example.app",
    "1.0",
    await loadListing(listing()),
  );
  expect(plan.screenshots.keep).toBe(true);
  expect(plan.screenshots.upload).toEqual([]);
});

it("applies text, replaces screenshots and attaches the build without submitting", async () => {
  png("a.png", 1320, 2868, 1);
  png("b.png", 1320, 2868, 2);
  const { api, writes } = apple({ screenshots: ["old"] });
  const loaded = await loadListing(listing());
  const plan = await listingPlan(api, "com.example.app", "1.0", loaded);
  const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
  const result = await applyListing(api, plan, loaded, {
    fetcher: fetcher as any,
    wait: async () => undefined,
  });
  expect(result.submitted).toBe(false);
  const calls = writes.map((w) => `${w.method} ${w.path}`);
  expect(calls).toContain("PATCH /appInfoLocalizations/infoLoc");
  expect(calls).toContain("PATCH /appStoreVersionLocalizations/loc");
  expect(calls).toContain("DELETE /appScreenshots/shot0");
  expect(calls.filter((c) => c === "POST /appScreenshots")).toHaveLength(2);
  expect(calls).toContain(
    "PATCH /appStoreVersions/version/relationships/build",
  );
  expect(calls.some((c) => c.includes("reviewSubmission"))).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const commit = writes.find((w) => w.path === "/appScreenshots/new0")!;
  expect(commit.body.data.attributes).toMatchObject({ uploaded: true });
});

it("refuses to submit while something blocks review", async () => {
  png("a.png", 1320, 2868, 1);
  png("b.png", 1320, 2868, 2);
  const { api, writes } = apple();
  const loaded = await loadListing(listing());
  const plan = await listingPlan(api, "com.example.app", "1.0", loaded);
  await expect(
    applyListing(api, plan, loaded, {
      submit: true,
      fetcher: (async () => new Response(null)) as any,
      wait: async () => undefined,
    }),
  ).rejects.toThrow(/Not submitting/);
  expect(writes.some((w) => w.path.includes("reviewSubmission"))).toBe(false);
});

it("submits the version and its in-app purchases for review", async () => {
  const a = png("a.png", 1320, 2868, 1);
  const b = png("b.png", 1320, 2868, 2);
  const { api, writes } = apple({ screenshots: [a, b], contact: true });
  const loaded = await loadListing(
    listing({ inAppPurchases: ["com.example.full"] }),
  );
  const plan = await listingPlan(api, "com.example.app", "1.0", loaded);
  expect(plan.blockers).toEqual([]);
  const result = await applyListing(api, plan, loaded, {
    submit: true,
    wait: async () => undefined,
  });
  expect(result.submitted).toBe(true);
  const calls = writes.map((w) => `${w.method} ${w.path}`);
  expect(calls.slice(-4)).toEqual([
    "POST /inAppPurchaseSubmissions",
    "POST /reviewSubmissions",
    "POST /reviewSubmissionItems",
    "PATCH /reviewSubmissions/submission",
  ]);
  expect(writes.at(-1)!.body.data.attributes).toEqual({ submitted: true });
});
