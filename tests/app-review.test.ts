import { it, expect, vi } from "vitest";
import { plainText, readAppReview } from "../src/core/app-review";
import type { AppleWebSession } from "../src/core/app-store-compliance";
import { DeskError } from "../src/core/errors";
import { reviewReasonText } from "../src/core/app-review-labels";

const thread = (
  id: string,
  versions: string[],
  date: string,
  type = "REJECTION_BINARY",
) => ({
  id,
  type: "resolutionCenterThreads",
  attributes: { threadType: type, state: "ACTIVE", createdDate: date },
  relationships: {
    appStoreVersions: {
      data: versions.map((v) => ({ type: "appStoreVersions", id: v })),
    },
  },
});

function session(routes: Record<string, any>) {
  const request = vi.fn(
    async (path: string, _options?: { interactive?: boolean }) => {
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      if (!key) throw Error(`unexpected ${path}`);
      const value = routes[key];
      if (value instanceof Error) throw value;
      return value;
    },
  );
  return { web: { request } as AppleWebSession, request };
}

it("turns Apple's HTML message bodies into plain text without markup", () => {
  expect(
    plainText(
      "<p>Hello,</p><p>Guideline 2.1 &amp; 4.3<br/>We found:</p><ul><li>Crash on launch</li></ul><script>x()</script>&#39;ok&#x27;",
    ),
  ).toBe("Hello,\nGuideline 2.1 & 4.3\nWe found:\n• Crash on launch\nx()'ok'");
});

it("reads the reviewer's messages and cited guidelines for the selected version only", async () => {
  const { web, request } = session({
    "/apps/app/resolutionCenterThreads": {
      data: [
        thread("old", ["v1"], "2026-09-01T00:00:00Z"),
        thread("mine", ["v2"], "2026-10-20T00:00:00Z"),
        thread(
          "app-wide",
          [],
          "2026-10-21T00:00:00Z",
          "APP_MESSAGE_INFORMATIONAL",
        ),
      ],
    },
    "/resolutionCenterThreads/mine/resolutionCenterMessages": {
      data: [
        {
          id: "reply",
          attributes: {
            createdDate: "2026-10-21T00:00:00Z",
            messageBody: "<p>Fixed it.</p>",
          },
          relationships: { fromActor: { data: { type: "actors", id: "me" } } },
        },
        {
          id: "apple",
          attributes: {
            createdDate: "2026-10-20T00:00:00Z",
            messageBody: "<p>Your app crashed.</p>",
          },
          relationships: {
            fromActor: { data: { type: "actors", id: "reviewer" } },
            resolutionCenterMessageAttachments: {
              data: [{ type: "resolutionCenterMessageAttachments", id: "a" }],
            },
          },
        },
      ],
      included: [
        { type: "actors", id: "reviewer", attributes: { actorType: "APPLE" } },
        {
          type: "actors",
          id: "me",
          attributes: { actorType: "USER", name: "Kai" },
        },
      ],
    },
    "/reviewRejections": {
      data: [
        {
          id: "r",
          attributes: {
            reasons: [
              {
                reasonSection: "2.1",
                reasonDescription: "Performance: App Completeness",
                reasonCode: "X",
              },
              {
                reasonSection: "2.1",
                reasonDescription: "Performance: App Completeness",
                reasonCode: "X",
              },
            ],
          },
        },
      ],
    },
  });
  const review = await readAppReview(web, "app", "v2", false);
  expect(review.signedIn).toBe(true);
  expect(review.threads.map((t) => t.id)).toEqual(["mine"]);
  const [t] = review.threads;
  expect(t!.reasons).toHaveLength(1);
  expect(reviewReasonText(t!.reasons[0]!)).toBe(
    "Guideline 2.1 — Performance: App Completeness",
  );
  expect(t!.messages).toEqual([
    expect.objectContaining({
      id: "apple",
      from: "App Review",
      fromApple: true,
      body: "Your app crashed.",
      attachments: 1,
    }),
    expect.objectContaining({
      id: "reply",
      from: "Kai",
      fromApple: false,
      body: "Fixed it.",
    }),
  ]);
  expect(request.mock.calls.every(([path]) => !path.includes("/old/"))).toBe(
    true,
  );
  for (const [, options] of request.mock.calls)
    expect(options?.interactive).toBeFalsy();
});

it("includes app-wide notices only when the version has a review issue", async () => {
  const { web } = session({
    "/apps/app/resolutionCenterThreads": {
      data: [
        thread("app-wide", [], "2026-10-21T00:00:00Z", "APP_MESSAGE_COMM"),
      ],
    },
    "/resolutionCenterThreads/": { data: [] },
    "/reviewRejections": { data: [] },
  });
  expect((await readAppReview(web, "app", "v2", false)).threads).toEqual([]);
  expect((await readAppReview(web, "app", "v2", true)).threads[0]?.id).toBe(
    "app-wide",
  );
});

it("reports a missing App Store Connect sign-in instead of failing the release", async () => {
  const { web } = session({
    "/apps/": new DeskError("APPLE_WEB_SIGN_IN", "Sign in"),
  });
  expect(await readAppReview(web, "app", "v", true)).toMatchObject({
    signedIn: false,
    threads: [],
  });
  const broken = session({ "/apps/": new DeskError("APPLE_WEB_500", "boom") });
  expect(await readAppReview(broken.web, "app", "v", true)).toMatchObject({
    signedIn: true,
    error: expect.stringContaining("boom"),
  });
  expect((await readAppReview(undefined, "app", "v", true)).signedIn).toBe(
    false,
  );
});

it("doesn't follow pagination links off App Store Connect's web API", async () => {
  const { web, request } = session({
    "/apps/app/resolutionCenterThreads": {
      data: [],
      links: {
        next: "https://evil.example/iris/v1/apps/app/resolutionCenterThreads?page=2",
      },
    },
  });
  await readAppReview(web, "app", "v", false);
  expect(request).toHaveBeenCalledTimes(1);
});
