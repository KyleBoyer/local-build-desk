import { beforeAll, it, expect, vi } from "vitest";
import { generateKeyPair, exportPKCS8, jwtVerify } from "jose";
import { AppleAPI, GoogleAPI, appleBuildState } from "../src/core/stores";
import type { Artifact, Credential } from "../src/core/types";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
let apple: Extract<Credential, { kind: "apple" }>,
  google: Extract<Credential, { kind: "google" }>;
beforeAll(async () => {
  const a = await generateKeyPair("ES256", { extractable: true });
  apple = {
    kind: "apple",
    label: "Test",
    privateKey: await exportPKCS8(a.privateKey),
    issuerId: "issuer",
    keyId: "key",
    teamId: "team",
  };
  const g = await generateKeyPair("RS256", { extractable: true });
  google = {
    kind: "google",
    label: "Test",
    serviceAccount: {
      client_email: "test@example.com",
      private_key: await exportPKCS8(g.privateKey),
    },
  };
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
it("retries transient Apple reads with backoff but never repeats a create request", async () => {
  const waits: number[] = [];
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ errors: [{ detail: "temporary" }] }, 500))
    .mockResolvedValueOnce(json({}, 503))
    .mockResolvedValueOnce(json({ data: [] }));
  const events: unknown[] = [];
  const api = new AppleAPI(
    apple,
    fetcher as any,
    (event) => events.push(event),
    {
      wait: async (ms) => {
        waits.push(ms);
      },
      random: () => 0,
    },
  );
  await expect(api.request("/certificates")).resolves.toEqual({ data: [] });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(waits).toEqual([500, 1000]);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ status: 500, attempt: 1, retryInMs: 500 }),
    ]),
  );
  const create = vi.fn(async () => json({}, 500));
  await expect(
    new AppleAPI(apple, create as any).request("/certificates", "POST", {
      data: {},
    }),
  ).rejects.toThrow(/Apple 500/);
  expect(create).toHaveBeenCalledTimes(1);
});
it("honors Apple rate-limit delays, retries network failures, and stops on authorization errors or cancellation", async () => {
  const waits: number[] = [];
  const rateLimit = vi
    .fn()
    .mockResolvedValueOnce(
      new Response("{}", { status: 429, headers: { "Retry-After": "2" } }),
    )
    .mockResolvedValueOnce(json({ data: [] }));
  await new AppleAPI(apple, rateLimit as any, undefined, {
    wait: async (ms) => {
      waits.push(ms);
    },
    random: () => 0,
  }).request("/apps");
  expect(waits).toEqual([2000]);
  const network = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValueOnce(json({ data: [] }));
  await new AppleAPI(apple, network as any, undefined, {
    wait: async () => {},
  }).request("/apps");
  expect(network).toHaveBeenCalledTimes(2);
  const denied = vi.fn(async () => json({}, 401));
  await expect(
    new AppleAPI(apple, denied as any).request("/apps"),
  ).rejects.toThrow(/Apple 401/);
  expect(denied).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  const aborted = vi.fn(async () => json({}, 500));
  await expect(
    new AppleAPI(apple, aborted as any, undefined, {
      signal: controller.signal,
      wait: async () => {
        controller.abort();
      },
    }).request("/apps"),
  ).rejects.toThrow();
  expect(aborted).toHaveBeenCalledTimes(1);
});
it("uses Apple JWT authentication and verifies provisioning permissions", async () => {
  const calls: string[] = [];
  const f = vi.fn(async (url: any, options: any) => {
    calls.push(String(url));
    expect(options.headers.Authorization).toMatch(/^Bearer /);
    return json({ data: [] });
  });
  await expect(new AppleAPI(apple, f as any).validate()).resolves.toContain(
    "provisioning",
  );
  expect(calls.some((u) => u.includes("/certificates"))).toBe(true);
  expect(
    calls.every((u) => new URL(u).hostname === "api.appstoreconnect.apple.com"),
  ).toBe(true);
});
it("reports Apple permission failures with actionable API details", async () => {
  await expect(
    new AppleAPI(apple, (async () =>
      json(
        { errors: [{ detail: "Provisioning access denied" }] },
        403,
      )) as any).validate(),
  ).rejects.toThrow(/Provisioning access denied/);
});
it("retains API request failure metadata without query values or authentication material", async () => {
  const events: unknown[] = [];
  const api = new AppleAPI(
    apple,
    (async () =>
      json(
        { errors: [{ detail: "Unsupported relationship parameter" }] },
        400,
      )) as any,
    (event) => events.push(event),
  );
  await expect(
    api.request(
      "/bundleIds/example/bundleIdCapabilities?limit=200&private=HIDDEN_QUERY_VALUE",
    ),
  ).rejects.toThrow(/GET \/bundleIds\/example\/bundleIdCapabilities/);
  expect(events).toEqual([
    {
      method: "GET",
      path: "/bundleIds/example/bundleIdCapabilities",
      status: 400,
      durationMs: expect.any(Number),
    },
  ]);
  expect(JSON.stringify(events)).not.toMatch(
    /HIDDEN_QUERY_VALUE|Bearer|PRIVATE KEY|issuer/,
  );
});
it("matches Apple builds to marketing version, not only build number", async () => {
  const f = async (url: any) =>
    String(url).includes("/apps?")
      ? json({ data: [{ id: "app" }] })
      : json({
          data: [
            {
              id: "old",
              attributes: { processingState: "VALID" },
              relationships: { preReleaseVersion: { data: { id: "v1" } } },
            },
            {
              id: "new",
              attributes: { processingState: "PROCESSING" },
              relationships: { preReleaseVersion: { data: { id: "v2" } } },
            },
          ],
          included: [
            {
              type: "preReleaseVersions",
              id: "v1",
              attributes: { version: "1.0.0" },
            },
            {
              type: "preReleaseVersions",
              id: "v2",
              attributes: { version: "2.0.0" },
            },
          ],
        });
  const builds = await new AppleAPI(apple, f as any).build(
    "com.app",
    "1",
    "2.0.0",
  );
  expect(builds).toHaveLength(1);
  expect(appleBuildState(builds, "2.0.0")?.state).toBe("processing");
});
it("commits Google uploads as drafts with exact version and checksum", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desk-google-test-"));
  const path = join(dir, "app.aab");
  const contents = Buffer.from("fixture-bundle");
  await writeFile(path, contents);
  const calls: { url: string; body: any; method?: string }[] = [];
  const checksum = createHash("sha256").update(contents).digest("hex");
  const f = async (url: any, options: any = {}) => {
    const u = String(url);
    calls.push({ url: u, body: options.body, method: options.method });
    if (u.includes("oauth2.googleapis.com"))
      return json({ access_token: "access", expires_in: 3600 });
    if (u.includes("uploadType=media")) {
      expect(
        createHash("sha256")
          .update(Buffer.from(await new Response(options.body).arrayBuffer()))
          .digest("hex"),
      ).toBe(checksum);
      return json({ versionCode: 42, sha256: checksum });
    }
    if (u.endsWith("/edits")) return json({ id: "edit" });
    if (u.endsWith("/tracks/internal") && options.method === "GET")
      return json({
        releases: [
          {
            status: "completed",
            versionCodes: ["39"],
            releaseNotes: [{ language: "en-US", text: "Existing notes" }],
          },
        ],
      });
    return json({});
  };
  try {
    const artifact = {
      path,
      bundleId: "com.app",
      buildNumber: "42",
      version: "1.2.3",
      sha256: checksum,
    } as Artifact;
    const result = await new GoogleAPI(google, f as any).upload(
      artifact,
      "internal",
      () => {},
    );
    expect(result.state).toBe("draft");
    const track = calls.find(
      (c) => c.url.includes("/tracks/internal") && c.method === "PUT",
    )!;
    expect(JSON.parse(track.body).releases).toEqual([
      {
        status: "completed",
        versionCodes: ["39"],
        releaseNotes: [{ language: "en-US", text: "Existing notes" }],
      },
      { name: "1.2.3 (42)", status: "draft", versionCodes: ["42"] },
    ]);
    expect(
      calls.some((c) => c.url.includes(":commit?changesNotSentForReview=true")),
    ).toBe(true);
    expect(calls.some((c) => c.url.includes("expo"))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("does not commit a Google edit when the binary response is ambiguous", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desk-google-failure-"));
  const path = join(dir, "app.aab");
  await writeFile(path, "fixture");
  const calls: string[] = [];
  const f = async (url: any) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("oauth2"))
      return json({ access_token: "token", expires_in: 3600 });
    if (u.includes("uploadType"))
      throw new TypeError("connection lost after sending bytes");
    return json({ id: "edit" });
  };
  try {
    await expect(
      new GoogleAPI(google, f as any).upload(
        { path, bundleId: "com.app" } as Artifact,
        "internal",
        () => {},
      ),
    ).rejects.toThrow(/connection lost/);
    expect(calls.some((c) => c.includes(":commit"))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("reconciles Google draft status without uploading again", async () => {
  const calls: string[] = [];
  const f = async (url: any) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("oauth2"))
      return json({ access_token: "token", expires_in: 3600 });
    if (u.includes("/tracks/"))
      return json({ releases: [{ versionCodes: ["42"], status: "draft" }] });
    return json({ id: "check" });
  };
  const result = await new GoogleAPI(google, f as any).reconcile(
    { bundleId: "com.app", buildNumber: "42" } as Artifact,
    "internal",
  );
  expect(result.state).toBe("draft");
  expect(calls.some((c) => c.includes("/upload/"))).toBe(false);
});
it("preserves an unrelated Google draft and stops before sending binary bytes", async () => {
  const calls: { url: string; method?: string }[] = [];
  const fetcher = async (url: any, options: any = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method });
    if (u.includes("oauth2"))
      return json({ access_token: "token", expires_in: 3600 });
    if (u.endsWith("/tracks/internal"))
      return json({ releases: [{ status: "draft", versionCodes: ["41"] }] });
    return json({ id: "edit" });
  };
  await expect(
    new GoogleAPI(google, fetcher as any).upload(
      { bundleId: "com.app", buildNumber: "42" } as Artifact,
      "internal",
      () => {},
    ),
  ).rejects.toThrow(/already has another draft/);
  expect(calls.some((call) => call.url.includes("/bundles?uploadType="))).toBe(
    false,
  );
  expect(
    calls.some(
      (call) => call.method === "DELETE" && call.url.endsWith("/edits/edit"),
    ),
  ).toBe(true);
  expect(calls.some((call) => call.method === "PUT")).toBe(false);
});
it("recovers the exact staged Google AAB after a rejected review-control flag without uploading again", async () => {
  const calls: { url: string; method?: string }[] = [];
  const live = { status: "completed", versionCodes: ["39"] };
  let checksum = "abc";
  const fetcher = async (url: any, options: any = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method });
    if (u.includes("oauth2"))
      return json({ access_token: "token", expires_in: 3600 });
    if (u.endsWith("/edits")) return json({ id: "read-only" });
    if (u.endsWith("/edits/original/bundles"))
      return json({ bundles: [{ versionCode: 44, sha256: checksum }] });
    if (u.endsWith("/edits/original/tracks/internal"))
      return json({
        releases: [live, { status: "draft", versionCodes: ["44"] }],
      });
    if (u.endsWith("/edits/read-only/tracks/internal"))
      return json({ releases: [live] });
    if (u.includes("changesNotSentForReview"))
      return json(
        {
          error: {
            message:
              "Changes are sent for review automatically. The query parameter changesNotSentForReview must not be set.",
          },
        },
        400,
      );
    return json({});
  };
  const artifact = {
    bundleId: "com.app",
    version: "1.0",
    buildNumber: "44",
    sha256: "abc",
  } as Artifact;
  const result = await new GoogleAPI(google, fetcher as any).reconcile(
    artifact,
    "internal",
    "original",
    [live],
  );
  expect(result.state).toBe("draft");
  expect(
    calls.some((call) => call.url.endsWith("/edits/original:commit")),
  ).toBe(true);
  expect(calls.some((call) => call.url.includes("uploadType="))).toBe(false);
  expect(
    calls.some((call) => call.url.endsWith("/edits") && call.method === "POST"),
  ).toBe(false);
  calls.length = 0;
  checksum = "different";
  await expect(
    new GoogleAPI(google, fetcher as any).reconcile(
      artifact,
      "internal",
      "original",
      [live],
    ),
  ).rejects.toThrow(/exact AAB/);
  expect(calls.some((call) => call.url.includes(":commit"))).toBe(false);
});
it("checks a deleted original edit before opening a new one and proves the version absent before allowing a resend", async () => {
  const calls: { url: string; method?: string }[] = [];
  const f = async (url: any, options: any = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method });
    if (u.includes("oauth2"))
      return json({ access_token: "token", expires_in: 3600 });
    if (u.includes("/original/"))
      return json({ error: { message: "This Edit has been deleted." } }, 400);
    if (u.endsWith("/edits")) return json({ id: "read" });
    if (u.endsWith("/bundles")) return json({ bundles: [] });
    if (u.endsWith("/tracks/internal"))
      return json({
        releases: [{ status: "completed", versionCodes: ["39"] }],
      });
    return json({});
  };
  const result = await new GoogleAPI(google, f as any).reconcile(
    { bundleId: "com.app", buildNumber: "44", sha256: "hash" } as Artifact,
    "internal",
    "original",
  );
  expect(result.state).toBe("rejected");
  expect(result.message).toContain("Upload the existing artifact");
  expect(
    calls.findIndex((call) => call.url.includes("/original/")),
  ).toBeLessThan(calls.findIndex((call) => call.url.endsWith("/edits")));
  expect(calls.some((call) => call.url.includes("uploadType="))).toBe(false);
});
it("serializes edit-based calls across connections using the same Google account", async () => {
  let active = 0,
    maximum = 0;
  const fetcher = async (url: any, options: any = {}) => {
    const u = String(url);
    if (u.includes("oauth2"))
      return json({ access_token: "token", expires_in: 3600 });
    if (u.endsWith("/edits")) {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return json({ id: "edit" });
    }
    if (options.method === "DELETE") {
      active--;
      return json({});
    }
    if (u.endsWith("/tracks")) return json({ tracks: [] });
    return json({ bundles: [] });
  };
  await Promise.all([
    new GoogleAPI(google, fetcher as any).versions("com.app"),
    new GoogleAPI(google, fetcher as any).versions("com.app"),
  ]);
  expect(maximum).toBe(1);
  expect(active).toBe(0);
});

it("rechecks Google edit safety after waiting for another account operation", async () => {
  const { withLock } = await import("../src/core/locks");
  let release!: () => void;
  const owner = withLock(
    `google-edit:${google.serviceAccount.client_email}`,
    undefined,
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  await Promise.resolve();
  let uncertain = false;
  const fetcher = vi.fn<typeof fetch>();
  const api = new GoogleAPI(google, fetcher, undefined, () => {
    if (uncertain) throw Error("Reconcile the existing staged edit first");
  });
  const pending = api.versions("com.example");
  uncertain = true;
  release();
  await owner;
  await expect(pending).rejects.toThrow(/Reconcile/);
  expect(fetcher).not.toHaveBeenCalled();
});
it("verifies a console bootstrap's exact checksum and internal draft without uploading or committing", async () => {
  const artifact = {
    bundleId: "com.example.fixture",
    buildNumber: "11",
    sha256: "a".repeat(64),
  } as Artifact;
  const calls: { url: string; method?: string }[] = [];
  let checksum = artifact.sha256;
  const f = async (url: any, options: any = {}) => {
    calls.push({ url: String(url), method: options.method });
    if (String(url).includes("oauth2.googleapis.com"))
      return json({ access_token: "token", expires_in: 3600 });
    if (String(url).endsWith("/edits")) return json({ id: "read-edit" });
    if (String(url).endsWith("/bundles"))
      return json({ bundles: [{ versionCode: 11, sha256: checksum }] });
    if (String(url).endsWith("/tracks/internal"))
      return json({ releases: [{ status: "draft", versionCodes: ["11"] }] });
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    throw Error("Unexpected operation");
  };
  await new GoogleAPI(google, f as any).verifySavedBundle(artifact, "internal");
  checksum = "b".repeat(64);
  await expect(
    new GoogleAPI(google, f as any).verifySavedBundle(artifact, "internal"),
  ).rejects.toThrow(/checksum/);
  expect(
    calls.some(
      (call) => call.url.includes("/upload/") || call.url.includes(":commit"),
    ),
  ).toBe(false);
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
});
it("includes Apple's associated errors, and routes /v2/ paths", async () => {
  const fetcher = vi.fn(async () =>
    json(
      {
        errors: [
          {
            detail:
              "This in-app purchase cannot be reviewed, please check associated errors.",
            meta: {
              associatedErrors: {
                "/v2/inAppPurchases/1": [
                  {
                    detail:
                      "The first in-app purchase must be submitted with a new app version.",
                  },
                ],
              },
            },
          },
        ],
      },
      409,
    ),
  );
  await expect(
    new AppleAPI(apple, fetcher as any).request("/v2/inAppPurchases", "POST", {
      data: {},
    }),
  ).rejects.toThrow(
    /cannot be reviewed, please check associated errors\. \(The first in-app purchase must be submitted with a new app version\.\)/,
  );
  expect((fetcher.mock.calls[0] as any)[0]).toBe(
    "https://api.appstoreconnect.apple.com/v2/inAppPurchases",
  );
});
