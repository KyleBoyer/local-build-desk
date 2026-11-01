import { it, expect } from "vitest";
import {
  mergeInbox,
  notable,
  readAppleReviews,
  readPlayReviews,
  readTestFlightFeedback,
  replyApple,
  replyPlay,
  type InboxItem,
} from "../src/core/inbox";

const review = (id: string, rating: number, body = "Nice") => ({
  id: `play-review:${id}`,
  kind: "review" as const,
  store: "google" as const,
  sourceId: id,
  rating,
  body,
  createdAt: `2026-10-${10 + Number(id)}T00:00:00.000Z`,
});

it("keeps reviews Play no longer returns, marks new and edited ones unread", () => {
  const first = mergeInbox([], [review("1", 5), review("2", 1)], "t1");
  expect(first.added).toHaveLength(2);
  const kept = first.items.map((i) => ({ ...i, read: true }));
  // A week later Play returns only review 2, edited, and a new review 3.
  const next = mergeInbox(
    kept,
    [review("2", 3, "Better now"), review("3", 2)],
    "t2",
  );
  expect(next.items.map((i) => i.sourceId)).toEqual(["3", "2", "1"]);
  expect(next.added.map((i) => i.sourceId)).toEqual(["2", "3"]);
  expect(next.items.find((i) => i.sourceId === "1")!.read).toBe(true);
  expect(next.items.find((i) => i.sourceId === "2")).toMatchObject({
    read: false,
    rating: 3,
    seenAt: "t1",
  });
  // Unchanged items keep their read state.
  expect(
    mergeInbox(
      next.items.map((i) => ({ ...i, read: true })),
      [review("3", 2)],
    ).added,
  ).toEqual([]);
});

it("alerts on low ratings and any TestFlight feedback, not on good reviews", () => {
  const base = { read: false, seenAt: "t" } as const;
  expect(notable({ ...review("1", 2), ...base } as InboxItem)).toBe(true);
  expect(notable({ ...review("1", 4), ...base } as InboxItem)).toBe(false);
  expect(
    notable({ ...review("1", 5), ...base, kind: "crash" } as InboxItem),
  ).toBe(true);
});

it("reads Play reviews with replies and device details across pages", async () => {
  const pages = [
    {
      reviews: [
        {
          reviewId: "r1",
          authorName: "Ana",
          comments: [
            {
              userComment: {
                text: " Crashes on fold ",
                starRating: 1,
                lastModified: { seconds: "1793000000" },
                appVersionName: "1.2",
                androidOsVersion: 35,
                deviceMetadata: { productName: "Pixel Fold" },
                reviewerLanguage: "en",
              },
            },
            {
              developerComment: {
                text: "Fixed in 1.3",
                lastModified: { seconds: "1793100000" },
              },
            },
          ],
        },
      ],
      tokenPagination: { nextPageToken: "p2" },
    },
    {
      reviews: [
        {
          reviewId: "r2",
          authorName: "",
          comments: [{ userComment: { text: "Great", starRating: 5 } }],
        },
      ],
    },
  ];
  const paths: string[] = [];
  const api = {
    request: async (path: string) => (paths.push(path), pages.shift()),
  } as any;
  const items = await readPlayReviews(api, "com.app");
  expect(paths[1]).toContain("token=p2");
  expect(items[0]).toMatchObject({
    id: "play-review:r1",
    rating: 1,
    body: "Crashes on fold",
    author: "Ana",
    device: "Pixel Fold",
    os: "Android API 35",
    appVersion: "1.2",
    reply: { body: "Fixed in 1.3" },
  });
  expect(items[1]!.author).toBeUndefined();
});

it("reads App Store reviews with their responses, and TestFlight feedback with builds", async () => {
  const api = {
    request: async (path: string) =>
      path.includes("customerReviews")
        ? {
            data: [
              {
                id: "a1",
                attributes: {
                  rating: 2,
                  title: "Hmm",
                  body: "Slow",
                  reviewerNickname: "kb",
                  territory: "USA",
                  createdDate: "2026-10-30T00:00:00Z",
                },
                relationships: { response: { data: { id: "resp1" } } },
              },
            ],
            included: [
              {
                type: "customerReviewResponses",
                id: "resp1",
                attributes: {
                  responseBody: "Thanks",
                  state: "PENDING_PUBLISH",
                },
              },
            ],
          }
        : path.includes("Screenshot")
          ? {
              data: [
                {
                  id: "f1",
                  attributes: {
                    comment: "Button cut off",
                    email: "t@x.com",
                    deviceModel: "iPhone17,1",
                    osVersion: "26.1",
                    createdDate: "2026-10-29T00:00:00Z",
                    screenshots: [{}, {}],
                  },
                  relationships: { build: { data: { id: "b1" } } },
                },
              ],
              included: [
                { type: "builds", id: "b1", attributes: { version: "42" } },
              ],
            }
          : {
              data: [
                {
                  id: "c1",
                  attributes: { createdDate: "2026-10-28T00:00:00Z" },
                  relationships: { build: { data: { id: "b1" } } },
                },
              ],
              included: [
                { type: "builds", id: "b1", attributes: { version: "42" } },
              ],
            },
  } as any;
  expect((await readAppleReviews(api, "app"))[0]).toMatchObject({
    rating: 2,
    title: "Hmm",
    reply: { id: "resp1", body: "Thanks", state: "PENDING_PUBLISH" },
  });
  const feedback = await readTestFlightFeedback(api, "app");
  expect(feedback.map((f) => [f.kind, f.appVersion])).toEqual([
    ["feedback", "build 42"],
    ["crash", "build 42"],
  ]);
  expect(feedback[0]!.screenshots).toBe(2);
  expect(feedback[1]!.body).toMatch(/Crash report/);
});

it("replaces an App Store reply, and replies on Play in one call", async () => {
  const calls: string[] = [];
  const apple = {
    request: async (path: string, method = "GET") => (
      calls.push(`${method} ${path}`),
      { data: { id: "resp2", attributes: {} } }
    ),
  } as any;
  const item = {
    ...review("1", 2),
    store: "apple",
    sourceId: "a1",
    reply: { id: "resp1", body: "old" },
    read: true,
    seenAt: "t",
  } as InboxItem;
  expect((await replyApple(apple, item, "new")).id).toBe("resp2");
  expect(calls).toEqual([
    "DELETE /customerReviewResponses/resp1",
    "POST /customerReviewResponses",
  ]);
  const play = {
    request: async (path: string, method: string, body: any) => (
      calls.push(`${method} ${path}`),
      { result: { replyText: body.replyText } }
    ),
  } as any;
  expect(
    (
      await replyPlay(
        play,
        "com.app",
        { ...item, store: "google", sourceId: "r1" },
        "hi",
      )
    ).body,
  ).toBe("hi");
  expect(calls.at(-1)).toBe("POST /applications/com.app/reviews/r1:reply");
});

it("treats a crash report without a shared log as empty, not an error", async () => {
  const { crashLog } = await import("../src/core/inbox");
  const item = {
    ...review("1", 1),
    kind: "crash",
    store: "apple",
    sourceId: "c1",
    read: false,
    seenAt: "t",
  } as InboxItem;
  const missing = {
    request: async () => {
      throw Object.assign(new Error("Apple 404"), { code: "APPLE_404" });
    },
  } as any;
  expect(await crashLog(missing, item)).toBe("");
  const present = {
    request: async () => ({
      data: { attributes: { logText: "Thread 0 Crashed" } },
    }),
  } as any;
  expect(await crashLog(present, item)).toBe("Thread 0 Crashed");
});
