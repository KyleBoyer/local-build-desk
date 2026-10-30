import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appleReleases,
  appleReleaseDetail,
  appleImageUrl,
  trustedStoreImage,
  fetchStoreImage,
} from "../src/core/store-releases";
import { AppleAPI, GoogleAPI } from "../src/core/stores";
import { Store } from "../src/core/database";
import { Vault } from "../src/core/vault";
import { Engine } from "../src/core/engine";
import type { StoreRelease } from "../src/core/store-release-types";
const google = {
  kind: "google" as const,
  label: "Fixture",
  serviceAccount: {
    client_email: "fixture@example.com",
    private_key: "unused",
  },
};
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.alloc(32),
]);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("reads App Review's attached build separately from a newer TestFlight upload", async () => {
  const api = {
    app: vi.fn(async () => ({ id: "app" })),
    request: vi.fn(async (path: string) =>
      path.startsWith("/apps/")
        ? {
            data: [
              {
                id: "version",
                attributes: {
                  versionString: "1.0",
                  appStoreState: "WAITING_FOR_REVIEW",
                },
                relationships: {
                  build: { data: { type: "builds", id: "build3" } },
                },
              },
            ],
            included: [
              { type: "builds", id: "build3", attributes: { version: "3" } },
            ],
          }
        : {
            data: [
              {
                id: "build4",
                attributes: {
                  version: "4",
                  processingState: "VALID",
                  uploadedDate: "2026-10-29",
                  expirationDate: "2027-01-27",
                },
                relationships: {
                  preReleaseVersion: {
                    data: { type: "preReleaseVersions", id: "pre" },
                  },
                  buildBetaDetail: {
                    data: { type: "buildBetaDetails", id: "beta" },
                  },
                  betaAppReviewSubmission: {
                    data: { type: "betaAppReviewSubmissions", id: "review" },
                  },
                },
              },
            ],
            included: [
              {
                type: "preReleaseVersions",
                id: "pre",
                attributes: { version: "1.0" },
              },
              {
                type: "buildBetaDetails",
                id: "beta",
                attributes: {
                  internalBuildState: "IN_BETA_TESTING",
                  externalBuildState: "READY_FOR_BETA_SUBMISSION",
                },
              },
              {
                type: "betaAppReviewSubmissions",
                id: "review",
                attributes: { betaReviewState: "WAITING_FOR_REVIEW" },
              },
            ],
          },
    ),
  } as unknown as AppleAPI;
  const result = await appleReleases(api, "com.example.fixture");
  expect(result.releases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "appstore:version",
        version: "1.0",
        buildNumbers: ["3"],
        status: "WAITING_FOR_REVIEW",
      }),
      expect.objectContaining({
        id: "testflight:build4",
        version: "1.0",
        buildNumbers: ["4"],
        status: "IN_BETA_TESTING",
        betaReviewState: "WAITING_FOR_REVIEW",
        externalState: "READY_FOR_BETA_SUBMISSION",
      }),
    ]),
  );
  expect(api.request).toHaveBeenCalledTimes(2);
});
it("keeps App Review history available when TestFlight read permission fails", async () => {
  const api = {
    app: async () => ({ id: "app" }),
    request: vi.fn(async (path: string) => {
      if (path.startsWith("/builds")) throw Error("Apple 403");
      return {
        data: [
          {
            id: "v",
            attributes: { versionString: "1.0", appStoreState: "IN_REVIEW" },
          },
        ],
      };
    }),
  } as unknown as AppleAPI;
  const result = await appleReleases(api, "com.example.fixture");
  expect(result.releases).toHaveLength(1);
  expect(result.builds.status).toBe("rejected");
});
it("loads screenshots attached to the selected Apple version and selected locale only", async () => {
  const request = vi.fn(async (path: string) => {
    if (
      path ===
      "/appStoreVersions/selected/appStoreVersionLocalizations?limit=200"
    )
      return {
        data: [
          {
            id: "en",
            attributes: {
              locale: "en-US",
              description: "Submitted description",
            },
          },
          {
            id: "fr",
            attributes: {
              locale: "fr-FR",
              description: "Description française",
            },
          },
        ],
      };
    if (path === "/appStoreVersionLocalizations/fr/appScreenshotSets?limit=200")
      return {
        data: [
          { id: "set", attributes: { screenshotDisplayType: "APP_IPHONE_67" } },
        ],
      };
    if (path === "/appScreenshotSets/set/appScreenshots?limit=200")
      return {
        data: [
          {
            id: "shot",
            attributes: {
              fileName: "fr-home.png",
              assetDeliveryState: { state: "COMPLETE" },
              imageAsset: {
                width: 1320,
                height: 2868,
                templateUrl:
                  "https://is1-ssl.mzstatic.com/image/thumb/asset/{w}x{h}{c}.{f}",
              },
            },
          },
        ],
      };
    throw Error("Unexpected path " + path);
  });
  const result = await appleReleaseDetail(
    { request } as unknown as AppleAPI,
    { resourceId: "selected", channel: "appstore" } as StoreRelease,
    "fr-FR",
  );
  expect(result.listings).toHaveLength(2);
  expect(result.images).toEqual([
    expect.objectContaining({
      name: "fr-home.png",
      locale: "fr-FR",
      displayType: "APP_IPHONE_67",
      url: "https://is1-ssl.mzstatic.com/image/thumb/asset/480x1043bb.png",
      origin: "store",
    }),
  ]);
  expect(
    request.mock.calls.some(([path]) => path.includes("Localizations/en/")),
  ).toBe(false);
});
it("does not invent store screenshots for TestFlight builds", async () => {
  const request = vi.fn(async (path: string) =>
    path.includes("betaGroups")
      ? {
          data: [
            {
              id: "g",
              attributes: { name: "Internal", isInternalGroup: true },
            },
          ],
        }
      : {
          data: [
            {
              id: "text",
              attributes: { locale: "en-US", whatsNew: "Try the new action" },
            },
          ],
        },
  );
  const result = await appleReleaseDetail(
    { request } as unknown as AppleAPI,
    { resourceId: "build", channel: "testflight" } as StoreRelease,
  );
  expect(result.images).toEqual([]);
  expect(result.groups).toEqual(["Internal (internal)"]);
  expect(result.listings[0]?.whatsNew).toBe("Try the new action");
  expect(result.notes.join(" ")).toContain("no store screenshots attached");
});
it("reads Google tracks and current listing images in a disposable edit without writing or committing", async () => {
  const api = new GoogleAPI(google);
  const calls: any[] = [];
  vi.spyOn(api, "request").mockImplementation(async (path, method = "GET") => {
    calls.push({ path, method });
    if (method === "POST") return { id: "read-edit" };
    if (path.endsWith("/tracks"))
      return {
        tracks: [
          {
            track: "internal",
            releases: [
              {
                status: "completed",
                versionCodes: ["4"],
                releaseNotes: [{ language: "en-US", text: "Fixes" }],
              },
            ],
          },
        ],
      };
    if (path.endsWith("/listings"))
      return {
        listings: [
          { language: "en-US", title: "Fixture" },
          { language: "fr-FR", title: "Exemple" },
        ],
      };
    if (path.endsWith("/phoneScreenshots"))
      return {
        images: [
          { id: "shot", url: "https://play-lh.googleusercontent.com/asset" },
        ],
      };
    return {};
  });
  const result = await api.releaseSnapshot(
    "com.example.fixture",
    true,
    "fr-FR",
  );
  expect(result.tracks[0].releases[0].status).toBe("completed");
  expect(result.locale).toBe("fr-FR");
  expect(result.images).toEqual([
    expect.objectContaining({
      locale: "fr-FR",
      displayType: "phoneScreenshots",
      origin: "store",
    }),
  ]);
  expect(calls.filter((c) => c.method !== "GET")).toEqual([
    { path: "/applications/com.example.fixture/edits", method: "POST" },
    {
      path: "/applications/com.example.fixture/edits/read-edit",
      method: "DELETE",
    },
  ]);
  expect(calls.some((c) => /commit|PATCH|PUT/.test(c.path + c.method))).toBe(
    false,
  );
});
it("deletes a Google status edit on failure and refuses to replace an unresolved upload edit", async () => {
  const api = new GoogleAPI(google);
  const request = vi
    .spyOn(api, "request")
    .mockImplementation(async (path, method = "GET") => {
      if (method === "POST") return { id: "e" };
      if (method === "DELETE") return {};
      throw Error("Google Play 403");
    });
  await expect(api.releaseSnapshot("com.example.fixture")).rejects.toThrow(
    "403",
  );
  expect(request).toHaveBeenLastCalledWith(
    "/applications/com.example.fixture/edits/e",
    "DELETE",
  );
  const guarded = new GoogleAPI(google, fetch, undefined, () => {
    throw Error("Uncertain existing upload");
  });
  const never = vi.spyOn(guarded, "request");
  await expect(guarded.releaseSnapshot("com.example.fixture")).rejects.toThrow(
    "Uncertain existing upload",
  );
  expect(never).not.toHaveBeenCalled();
});
it("allows only known HTTPS image CDNs, without credentials or off-host redirects", async () => {
  expect(
    trustedStoreImage("https://play-lh.googleusercontent.com/asset"),
  ).toContain("googleusercontent.com");
  for (const url of [
    "http://is1.mzstatic.com/a",
    "https://mzstatic.com.evil.example/a",
    "https://127.0.0.1/a",
    "https://user:password@is1.mzstatic.com/a",
    "https://is1.mzstatic.com:444/a",
  ])
    expect(() => trustedStoreImage(url)).toThrow();
  const fetcher = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      }),
  );
  await expect(
    fetchStoreImage("https://is1.mzstatic.com/a", fetcher as any),
  ).rejects.toThrow(/unsupported image host/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("previews bounded raster bytes and rejects HTML even with an image content-type", async () => {
  const fetcher = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(png, { headers: { "content-type": "image/png" } }),
  );
  expect(
    await fetchStoreImage("https://is1.mzstatic.com/a", fetcher as any),
  ).toBe(`data:image/png;base64,${png.toString("base64")}`);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  await expect(
    fetchStoreImage(
      "https://is1.mzstatic.com/a",
      vi.fn(
        async () =>
          new Response("<script>bad</script>", {
            headers: { "content-type": "image/png" },
          }),
      ) as any,
    ),
  ).rejects.toThrow(/supported PNG/);
  await expect(
    fetchStoreImage(
      "https://is1.mzstatic.com/a",
      vi.fn(
        async () =>
          new Response("too big", {
            headers: { "content-length": String(13 * 1024 * 1024) },
          }),
      ) as any,
    ),
  ).rejects.toThrow(/12 MB/);
  expect(appleImageUrl(null)).toBeUndefined();
});
it("binds store images and release selection to the imported project's current connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-store-history-")),
    store = new Store(root);
  const vault = new Vault(store, {
      async encrypt(v) {
        return Buffer.from(v);
      },
      async decrypt(v) {
        return v.toString();
      },
    }),
    engine = new Engine(store, vault);
  try {
    const credential = await vault.put({
      kind: "apple",
      label: "Fixture",
      teamId: "TEAM",
      keyId: "KEY",
      issuerId: "issuer",
      privateKey: "never-used",
    });
    store.putProject({
      id: "project",
      path: join(root, "app"),
      name: "Fixture",
      bundleId: "com.example.fixture",
      profiles: ["production"],
      createdAt: "now",
      settings: { appleConnectionId: credential.id },
    });
    vi.spyOn(AppleAPI.prototype, "app").mockResolvedValue({ id: "app" });
    vi.spyOn(AppleAPI.prototype, "request").mockImplementation(async (path) => {
      if (path.includes("appStoreVersions?"))
        return {
          data: [
            {
              id: "v",
              attributes: {
                versionString: "1.0",
                appStoreState: "WAITING_FOR_REVIEW",
              },
            },
          ],
        };
      if (path.startsWith("/builds?")) return { data: [] };
      if (path.includes("appStoreVersionLocalizations?"))
        return { data: [{ id: "l", attributes: { locale: "en-US" } }] };
      if (path.includes("appScreenshotSets?"))
        return {
          data: [
            { id: "s", attributes: { screenshotDisplayType: "APP_IPHONE_67" } },
          ],
        };
      if (path.includes("appScreenshots?"))
        return {
          data: [
            {
              id: "image",
              attributes: {
                fileName: "home.png",
                imageAsset: {
                  width: 1320,
                  height: 2868,
                  templateUrl: "https://is1.mzstatic.com/home.png",
                },
              },
            },
          ],
        };
      throw Error("Unexpected path " + path);
    });
    const snapshot = await engine.storeReleases("project");
    expect(snapshot.releases[0]?.status).toBe("WAITING_FOR_REVIEW");
    const reads = vi.mocked(AppleAPI.prototype.request).mock.calls.length;
    expect((await engine.storeReleases("project")).cache?.source).toBe("cache");
    expect(vi.mocked(AppleAPI.prototype.request).mock.calls.length).toBe(reads);
    await expect(
      engine.storeReleaseDetails("project", "appstore:foreign-app"),
    ).rejects.toThrow(/no longer/);
    const detail = await engine.storeReleaseDetails("project", "appstore:v");
    expect(detail.images[0]?.available).toBe(true);
    // Another desktop/phone details request must reuse provider metadata.
    const detailReads = vi.mocked(AppleAPI.prototype.request).mock.calls.length;
    expect(
      (await engine.storeReleaseDetails("project", "appstore:v")).cache?.source,
    ).toBe("cache");
    expect(vi.mocked(AppleAPI.prototype.request).mock.calls.length).toBe(
      detailReads,
    );
    const fetcher = vi.fn(async () => new Response(png));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      engine.storeImagePreview("project", detail.images[0]!.id),
    ).resolves.toContain("data:image/png");
    await expect(
      engine.storeImagePreview("project", detail.images[0]!.id),
    ).resolves.toContain("data:image/png");
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The disk cache and opaque image handles survive an owner restart.
    const reopened = new Engine(store, vault);
    try {
      const cached = await reopened.storeReleases("project");
      expect(cached.cache?.source).toBe("cache");
      const restored = await reopened.storeReleaseDetails(
        "project",
        "appstore:v",
      );
      expect(restored.images[0]!.id).toBe(detail.images[0]!.id);
      await expect(
        reopened.storeImagePreview("project", restored.images[0]!.id),
      ).resolves.toContain("data:image/png");
      expect(fetcher).toHaveBeenCalledTimes(1);
      const before = vi.mocked(AppleAPI.prototype.request).mock.calls.length;
      await reopened.storeReleases("project", true);
      expect(
        vi.mocked(AppleAPI.prototype.request).mock.calls.length,
      ).toBeGreaterThan(before);
      // A partial provider error keeps previously fetched channel rows and age.
      vi.mocked(AppleAPI.prototype.request).mockRejectedValueOnce(
        Error("Apple temporarily unavailable"),
      );
      const partial = await reopened.storeReleases("project", true);
      expect(partial.channels.appstore.error).toContain(
        "temporarily unavailable",
      );
      expect(partial.channels.appstore.cached).toBe(true);
      expect(partial.releases.some((r) => r.id === "appstore:v")).toBe(true);
    } finally {
      await reopened.shutdown();
    }
    engine.saveSettings("project", {});
    await expect(
      engine.storeImagePreview("project", detail.images[0]!.id),
    ).rejects.toThrow(/expired/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(detail)).not.toContain("mzstatic.com");
    expect(JSON.stringify(snapshot)).not.toContain("never-used");
  } finally {
    await engine.shutdown();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
