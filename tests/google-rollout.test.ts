import { beforeAll, afterAll, it, expect } from "vitest";
import { generateKeyPair, exportPKCS8 } from "jose";
import { GoogleAPI, googleRollout } from "../src/core/stores";
import type { Artifact, Credential } from "../src/core/types";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
let google: Extract<Credential, { kind: "google" }>, dir: string;
let artifact: Artifact;
beforeAll(async () => {
  const g = await generateKeyPair("RS256", { extractable: true });
  google = {
    kind: "google",
    label: "Test",
    serviceAccount: {
      client_email: "rollout@example.com",
      private_key: await exportPKCS8(g.privateKey),
    },
  };
  dir = await mkdtemp(join(tmpdir(), "desk-google-rollout-"));
  const contents = Buffer.from("fixture-bundle");
  await writeFile(join(dir, "app.aab"), contents);
  artifact = {
    path: join(dir, "app.aab"),
    bundleId: "com.app",
    version: "1.1.0",
    buildNumber: "46",
    sha256: createHash("sha256").update(contents).digest("hex"),
  } as Artifact;
});
afterAll(() => rm(dir, { recursive: true, force: true }));
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
interface Call {
  url: string;
  method: string;
  body?: any;
}
// Simulates Play's edits API. `releases` is the track before upload; `put`
// and `commit` can return errors to model account-specific rejections.
function play(
  options: {
    releases?: unknown[];
    put?: (body: any) => Response | undefined;
    commit?: (url: string) => Response | undefined;
    live?: unknown[];
  } = {},
) {
  const calls: Call[] = [];
  let edits = 0;
  const fetcher = async (url: any, init: any = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    if (u.includes("oauth2"))
      return json({ access_token: "token", expires_in: 3600 });
    const path = u.replace(
      /^https:\/\/androidpublisher\.googleapis\.com(\/upload)?\/androidpublisher\/v3\/applications\/com\.app/,
      "",
    );
    const body =
      typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: path, method, body });
    if (path === "/edits" && method === "POST")
      return json({ id: `edit${++edits}` });
    if (path.includes("uploadType=media")) {
      await new Response(init.body).arrayBuffer();
      return json({ versionCode: 46, sha256: artifact.sha256 });
    }
    if (path.endsWith("/tracks/internal") || path.endsWith("/tracks/alpha")) {
      if (method === "PUT") return options.put?.(body) ?? json(body);
      return json({
        releases:
          path.startsWith("/edits/edit1") || !options.live
            ? (options.releases ?? [])
            : options.live,
      });
    }
    if (path.includes(":commit")) return options.commit?.(path) ?? json({});
    return json({});
  };
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}
const sequence = (calls: Call[]) =>
  calls.map((call) => `${call.method} ${call.url}`);
const uploads = (calls: Call[]) =>
  calls.filter((call) => call.url.includes("uploadType=")).length;

it("applies auto rollout only to the internal track and treats a missing setting as on", () => {
  expect(googleRollout({}, "internal")).toBe(true);
  expect(googleRollout({ playAutoRollout: true }, "internal")).toBe(true);
  expect(googleRollout({ playAutoRollout: false }, "internal")).toBe(false);
  expect(googleRollout({}, "alpha")).toBe(false);
  expect(googleRollout({ playAutoRollout: true }, "production")).toBe(false);
});

it("rolls an internal upload out as a completed release and commits it for publishing", async () => {
  const { calls, fetcher } = play({
    live: [{ status: "completed", versionCodes: ["46"] }],
  });
  const result = await new GoogleAPI(google, fetcher).upload(
    artifact,
    "internal",
    () => {},
    undefined,
    undefined,
    { rollout: true },
  );
  const put = calls.find((call) => call.method === "PUT")!;
  expect(put.body).toEqual({
    track: "internal",
    releases: [
      { name: "1.1.0 (46)", versionCodes: ["46"], status: "completed" },
    ],
  });
  const commit = calls.find((call) => call.url.includes(":commit"))!;
  expect(commit.url).toBe("/edits/edit1:commit");
  expect(result).toMatchObject({
    state: "accepted",
    destination: "Google Play · internal · rolled out",
  });
  expect(result.message).toMatch(/Rolled out to internal testers/);
  expect(result.message).toMatch(/managed publishing/);
  // The track is re-read in a fresh edit that is discarded afterwards.
  expect(sequence(calls).slice(-2)).toEqual([
    "GET /edits/edit2/tracks/internal",
    "DELETE /edits/edit2",
  ]);
});

it("replaces existing internal releases with the new completed release", async () => {
  const { calls, fetcher } = play({
    releases: [{ status: "completed", versionCodes: ["40"] }],
  });
  await new GoogleAPI(google, fetcher).upload(
    artifact,
    "internal",
    () => {},
    undefined,
    undefined,
    { rollout: true },
  );
  expect(calls.find((call) => call.method === "PUT")!.body.releases).toEqual([
    { name: "1.1.0 (46)", versionCodes: ["46"], status: "completed" },
  ]);
});

it("supersedes a stale Local Build Desk draft with a lower version code", async () => {
  const baseline = [
    { status: "completed", versionCodes: ["40"] },
    { status: "draft", versionCodes: ["44"] },
  ];
  const { calls, fetcher } = play({ releases: baseline });
  const logs: string[] = [];
  const edits: unknown[][] = [];
  const result = await new GoogleAPI(google, fetcher).upload(
    artifact,
    "internal",
    (...args) => edits.push(args),
    undefined,
    undefined,
    {
      rollout: true,
      uploadedByDesk: (code) => code === "44",
      log: (line) => logs.push(line),
    },
  );
  expect(result.state).toBe("accepted");
  expect(edits.at(-1)).toEqual(["edit1", baseline, ["44"]]);
  expect(logs.join("\n")).toMatch(
    /Superseding earlier Local Build Desk draft 44/,
  );
  expect(calls.find((call) => call.method === "PUT")!.body.releases).toEqual([
    { name: "1.1.0 (46)", versionCodes: ["46"], status: "completed" },
  ]);
  expect(uploads(calls)).toBe(1);
});

it.each([
  ["a draft made in Play Console", ["44"], () => false],
  ["a higher version code", ["47"], () => true],
  [
    "a draft mixing owned and unknown codes",
    ["43", "44"],
    (c: string) => c === "44",
  ],
])(
  "refuses to discard %s before any bytes are uploaded",
  async (_name, versionCodes, uploadedByDesk) => {
    const { calls, fetcher } = play({
      releases: [{ status: "draft", versionCodes }],
    });
    await expect(
      new GoogleAPI(google, fetcher).upload(
        artifact,
        "internal",
        () => {},
        undefined,
        undefined,
        { rollout: true, uploadedByDesk },
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_DRAFT_EXISTS" });
    expect(uploads(calls)).toBe(0);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    expect(sequence(calls).at(-1)).toBe("DELETE /edits/edit1");
  },
);

it("keeps draft behaviour on non-internal tracks and when rollout is off", async () => {
  const draftMode = async (track: string, rollout: boolean) => {
    const { calls, fetcher } = play({
      releases: [{ status: "completed", versionCodes: ["40"] }],
    });
    const result = await new GoogleAPI(google, fetcher).upload(
      artifact,
      track,
      () => {},
      undefined,
      undefined,
      { rollout, uploadedByDesk: () => true },
    );
    return { result, calls };
  };
  const off = await draftMode("internal", false);
  const legacy = play({
    releases: [{ status: "completed", versionCodes: ["40"] }],
  });
  await new GoogleAPI(google, legacy.fetcher).upload(
    artifact,
    "internal",
    () => {},
  );
  // Rollout off sends exactly the requests sent before this feature existed.
  expect(off.calls).toEqual(legacy.calls);
  expect(sequence(off.calls)).toEqual([
    "POST /edits",
    "GET /edits/edit1/tracks/internal",
    "POST /edits/edit1/bundles?uploadType=media",
    "PUT /edits/edit1/tracks/internal",
    "POST /edits/edit1:validate",
    "POST /edits/edit1:commit?changesNotSentForReview=true",
  ]);
  expect(off.calls[3].body.releases).toEqual([
    { status: "completed", versionCodes: ["40"] },
    { name: "1.1.0 (46)", versionCodes: ["46"], status: "draft" },
  ]);
  expect(off.result.state).toBe("draft");
  const alpha = await draftMode("alpha", true);
  expect(alpha.result).toMatchObject({
    state: "draft",
    destination: "Google Play · alpha · draft",
  });
  expect(sequence(alpha.calls).at(-1)).toBe(
    "POST /edits/edit1:commit?changesNotSentForReview=true",
  );
  // Rollout never discards drafts on other tracks.
  const { calls, fetcher } = play({
    releases: [{ status: "draft", versionCodes: ["44"] }],
  });
  await expect(
    new GoogleAPI(google, fetcher).upload(
      artifact,
      "alpha",
      () => {},
      undefined,
      undefined,
      { rollout: true, uploadedByDesk: () => true },
    ),
  ).rejects.toMatchObject({ code: "GOOGLE_DRAFT_EXISTS" });
  expect(uploads(calls)).toBe(0);
});

it("falls back to a draft in the same edit when Google only accepts drafts for an unpublished app", async () => {
  const { calls, fetcher } = play({
    put: (body) =>
      body.releases.some((release: any) => release.status === "completed")
        ? json(
            {
              error: {
                message:
                  "Only releases with status draft may be created on draft app.",
              },
            },
            400,
          )
        : undefined,
  });
  const result = await new GoogleAPI(google, fetcher).upload(
    artifact,
    "internal",
    () => {},
    undefined,
    undefined,
    { rollout: true },
  );
  expect(result).toMatchObject({
    state: "draft",
    destination: "Google Play · internal · draft",
    externalId: "edit1",
  });
  expect(result.message).toMatch(/no published release yet/);
  expect(uploads(calls)).toBe(1);
  const puts = calls.filter((call) => call.method === "PUT");
  expect(puts.map((put) => put.body.releases[0].status)).toEqual([
    "completed",
    "draft",
  ]);
  expect(puts.every((put) => put.url === "/edits/edit1/tracks/internal")).toBe(
    true,
  );
  expect(sequence(calls).at(-1)).toBe(
    "POST /edits/edit1:commit?changesNotSentForReview=true",
  );
});

it("retries a rejected publishing commit once with changesNotSentForReview and reports it needs sending for review", async () => {
  const { calls, fetcher } = play({
    commit: (url) =>
      url.includes("changesNotSentForReview")
        ? undefined
        : json(
            {
              error: {
                message:
                  "Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.",
              },
            },
            400,
          ),
  });
  const result = await new GoogleAPI(google, fetcher).upload(
    artifact,
    "internal",
    () => {},
    undefined,
    undefined,
    { rollout: true },
  );
  expect(sequence(calls).filter((call) => call.includes(":commit"))).toEqual([
    "POST /edits/edit1:commit",
    "POST /edits/edit1:commit?changesNotSentForReview=true",
  ]);
  expect(result).toMatchObject({
    state: "draft",
    destination: "Google Play · internal · waiting for review",
  });
  expect(result.message).toMatch(/Send for review/);
});

it("does not retry a rollout commit for unrelated errors", async () => {
  const { calls, fetcher } = play({
    commit: () => json({ error: { message: "Backend error" } }, 400),
  });
  await expect(
    new GoogleAPI(google, fetcher).upload(
      artifact,
      "internal",
      () => {},
      undefined,
      undefined,
      { rollout: true },
    ),
  ).rejects.toThrow(/Backend error/);
  expect(calls.filter((call) => call.url.includes(":commit"))).toHaveLength(1);
});

it("recovers a staged rollout edit by committing it in rollout mode", async () => {
  const baseline = [
    { status: "completed", versionCodes: ["40"] },
    { status: "draft", versionCodes: ["44"] },
  ];
  const ours = { status: "completed", versionCodes: ["46"] };
  const calls: Call[] = [];
  const fetcher = (async (url: any, init: any = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? "GET" });
    if (u.includes("oauth2"))
      return json({ access_token: "token", expires_in: 3600 });
    if (u.endsWith("/edits/original/bundles"))
      return json({ bundles: [{ versionCode: 46, sha256: artifact.sha256 }] });
    if (u.endsWith("/edits/original/tracks/internal"))
      return json({ releases: [ours] });
    if (u.endsWith("/edits")) return json({ id: "read" });
    if (u.endsWith("/edits/read/tracks/internal"))
      return json({ releases: [ours] });
    return json({});
  }) as unknown as typeof fetch;
  const api = new GoogleAPI(google, fetcher);
  const result = await api.reconcile(
    artifact,
    "internal",
    "original",
    baseline,
    {
      rollout: true,
      supersededVersionCodes: ["44"],
    },
  );
  expect(result.state).toBe("accepted");
  expect(result.message).toMatch(/No binary was uploaded again/);
  const commits = calls.filter((call) => call.url.includes(":commit"));
  expect(commits.map((call) => call.url.split("/edits/")[1])).toEqual([
    "original:commit",
  ]);
  expect(calls.some((call) => call.url.includes("uploadType="))).toBe(false);
  calls.length = 0;
  // A draft that was not recorded as superseded must not silently disappear.
  await expect(
    api.reconcile(artifact, "internal", "original", baseline, {
      rollout: true,
      supersededVersionCodes: [],
    }),
  ).rejects.toMatchObject({ code: "GOOGLE_TRACK_CHANGED" });
  expect(calls.some((call) => call.url.includes(":commit"))).toBe(false);
  // A draft-mode job keeps today's strict comparison and draft commit.
  await expect(
    api.reconcile(artifact, "internal", "original", baseline),
  ).rejects.toMatchObject({ code: "GOOGLE_EDIT_DRAFT" });
});

it("attaches release notes to the new release in rollout and draft modes", async () => {
  const releaseNotes = [{ language: "en-US", text: "Bug fixes" }];
  for (const rollout of [true, false]) {
    const { calls, fetcher } = play();
    await new GoogleAPI(google, fetcher).upload(
      artifact,
      "internal",
      () => {},
      undefined,
      undefined,
      { rollout, releaseNotes },
    );
    expect(calls.find((call) => call.method === "PUT")!.body.releases).toEqual([
      {
        name: "1.1.0 (46)",
        versionCodes: ["46"],
        status: rollout ? "completed" : "draft",
        releaseNotes,
      },
    ]);
  }
});
it("treats a package Play has never seen as having no version codes, but keeps other failures", async () => {
  const missing = async (url: any) =>
    String(url).includes("oauth2")
      ? json({ access_token: "token", expires_in: 3600 })
      : json({ error: { message: "Package not found: com.app." } }, 404);
  expect(
    await new GoogleAPI(google, missing as any).existingVersions("com.app"),
  ).toEqual([]);
  const denied = async (url: any) =>
    String(url).includes("oauth2")
      ? json({ access_token: "token", expires_in: 3600 })
      : json(
          { error: { message: "The caller does not have permission" } },
          403,
        );
  await expect(
    new GoogleAPI(google, denied as any).existingVersions("com.app"),
  ).rejects.toThrow(/403/);
});
