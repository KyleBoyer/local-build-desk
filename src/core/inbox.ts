import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppleAPI, GoogleAPI } from "./stores";
import { invariant } from "./errors";

/**
 * One place for what people say about the app: App Store and Google Play
 * reviews, and TestFlight feedback and crash reports. The inbox is kept on
 * this Mac, because Play's API only returns the last week of reviews, and so
 * new items can be told apart from ones already seen.
 */
export interface InboxItem {
  id: string;
  kind: "review" | "feedback" | "crash";
  store: "apple" | "google";
  /** The store's own id for replying or fetching a crash log. */
  sourceId: string;
  rating?: number;
  title?: string;
  body: string;
  author?: string;
  territory?: string;
  language?: string;
  createdAt: string;
  appVersion?: string;
  device?: string;
  os?: string;
  screenshots?: number;
  reply?: { body: string; at?: string; state?: string; id?: string };
  read: boolean;
  /** First seen by this Mac; drives "new" notifications. */
  seenAt: string;
}
export interface InboxView {
  items: InboxItem[];
  checkedAt?: string;
  sources: Record<
    "appleReviews" | "testflight" | "playReviews",
    { connected: boolean; error?: string }
  >;
}

const MAX_ITEMS = 2000;

async function appleAll(api: AppleAPI, path: string, max = 5) {
  const data: any[] = [];
  let included: any[] = [];
  for (let page = 0; path && page < max; page++) {
    const response = await api.request(path);
    data.push(...(response.data ?? []));
    included = included.concat(response.included ?? []);
    const next = response.links?.next as string | undefined;
    if (!next) break;
    const url = new URL(next);
    invariant(
      url.origin === "https://api.appstoreconnect.apple.com",
      "APPLE_PAGE",
      "Invalid Apple pagination link.",
    );
    path = url.pathname.replace(/^\/v1/, "") + url.search;
  }
  return { data, included };
}

export async function readAppleReviews(
  api: AppleAPI,
  appId: string,
): Promise<Omit<InboxItem, "read" | "seenAt">[]> {
  const { data, included } = await appleAll(
    api,
    `/apps/${appId}/customerReviews?sort=-createdDate&include=response&limit=200`,
    3,
  );
  return data.map((r) => {
    const response = included.find(
      (i) =>
        i.type === "customerReviewResponses" &&
        i.id === r.relationships?.response?.data?.id,
    );
    return {
      id: `apple-review:${r.id}`,
      kind: "review" as const,
      store: "apple" as const,
      sourceId: r.id,
      rating: r.attributes.rating,
      title: r.attributes.title ?? undefined,
      body: r.attributes.body ?? "",
      author: r.attributes.reviewerNickname ?? undefined,
      territory: r.attributes.territory ?? undefined,
      createdAt: r.attributes.createdDate,
      ...(response
        ? {
            reply: {
              id: response.id,
              body: response.attributes.responseBody,
              at: response.attributes.lastModifiedDate,
              state: response.attributes.state,
            },
          }
        : {}),
    };
  });
}

export async function readTestFlightFeedback(
  api: AppleAPI,
  appId: string,
): Promise<Omit<InboxItem, "read" | "seenAt">[]> {
  const [shots, crashes] = await Promise.all([
    appleAll(
      api,
      `/apps/${appId}/betaFeedbackScreenshotSubmissions?sort=-createdDate&include=build&limit=100`,
      2,
    ),
    appleAll(
      api,
      `/apps/${appId}/betaFeedbackCrashSubmissions?sort=-createdDate&include=build&limit=100`,
      2,
    ),
  ]);
  const version = (included: any[], row: any) =>
    included.find(
      (i) => i.type === "builds" && i.id === row.relationships?.build?.data?.id,
    )?.attributes?.version;
  const map = (
    kind: "feedback" | "crash",
    { data, included }: { data: any[]; included: any[] },
  ) =>
    data.map((f) => ({
      id: `testflight-${kind}:${f.id}`,
      kind,
      store: "apple" as const,
      sourceId: f.id,
      body:
        f.attributes.comment ??
        (kind === "crash" ? "Crash report (no comment)" : ""),
      author: f.attributes.email ?? undefined,
      createdAt: f.attributes.createdDate,
      appVersion: version(included, f)
        ? `build ${version(included, f)}`
        : undefined,
      device: f.attributes.deviceModel ?? undefined,
      os: f.attributes.osVersion ?? undefined,
      language: f.attributes.locale ?? undefined,
      ...(kind === "feedback"
        ? { screenshots: (f.attributes.screenshots ?? []).length }
        : {}),
    }));
  return [...map("feedback", shots), ...map("crash", crashes)];
}

export async function readPlayReviews(
  api: GoogleAPI,
  packageName: string,
): Promise<Omit<InboxItem, "read" | "seenAt">[]> {
  const items: Omit<InboxItem, "read" | "seenAt">[] = [];
  let token: string | undefined;
  for (let page = 0; page < 10; page++) {
    const response = await api.request(
      `/applications/${encodeURIComponent(packageName)}/reviews?maxResults=100${token ? `&token=${encodeURIComponent(token)}` : ""}`,
    );
    for (const review of response.reviews ?? []) {
      const user = review.comments?.find(
        (c: any) => c.userComment,
      )?.userComment;
      const developer = review.comments?.find(
        (c: any) => c.developerComment,
      )?.developerComment;
      if (!user) continue;
      const seconds = (t?: { seconds?: string }) =>
        t?.seconds
          ? new Date(Number(t.seconds) * 1000).toISOString()
          : undefined;
      items.push({
        id: `play-review:${review.reviewId}`,
        kind: "review",
        store: "google",
        sourceId: review.reviewId,
        rating: user.starRating,
        body: (user.text ?? "").trim(),
        author: review.authorName || undefined,
        language: user.reviewerLanguage ?? undefined,
        createdAt: seconds(user.lastModified) ?? new Date().toISOString(),
        appVersion: user.appVersionName ?? undefined,
        device: user.deviceMetadata?.productName ?? user.device ?? undefined,
        os: user.androidOsVersion
          ? `Android API ${user.androidOsVersion}`
          : undefined,
        ...(developer
          ? {
              reply: {
                body: developer.text,
                at: seconds(developer.lastModified),
              },
            }
          : {}),
      });
    }
    token = response.tokenPagination?.nextPageToken;
    if (!token) break;
  }
  return items;
}

/** The kept inbox, merged with what the stores returned now. */
export function mergeInbox(
  kept: InboxItem[],
  fresh: Omit<InboxItem, "read" | "seenAt">[],
  now = new Date().toISOString(),
) {
  const byId = new Map(kept.map((i) => [i.id, i]));
  const added: InboxItem[] = [];
  for (const item of fresh) {
    const previous = byId.get(item.id);
    if (previous) {
      // A reviewer can edit a review; it counts as new again.
      const edited =
        previous.body !== item.body || previous.rating !== item.rating;
      byId.set(item.id, {
        ...previous,
        ...item,
        read: edited ? false : previous.read,
        seenAt: previous.seenAt,
      });
      if (edited) added.push(byId.get(item.id)!);
    } else {
      const next = { ...item, read: false, seenAt: now };
      byId.set(item.id, next);
      added.push(next);
    }
  }
  const items = [...byId.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_ITEMS);
  return { items, added };
}

export async function loadInbox(
  path: string,
): Promise<{ items: InboxItem[]; checkedAt?: string; primed?: boolean }> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { items: [] };
  }
}
export async function saveInbox(
  path: string,
  value: { items: InboxItem[]; checkedAt?: string; primed?: boolean },
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

/** Replies to a review. Apple keeps one reply per review: an edit replaces it. */
export async function replyApple(api: AppleAPI, item: InboxItem, body: string) {
  if (item.reply?.id)
    await api.request(`/customerReviewResponses/${item.reply.id}`, "DELETE");
  const created = (
    await api.request("/customerReviewResponses", "POST", {
      data: {
        type: "customerReviewResponses",
        attributes: { responseBody: body },
        relationships: {
          review: { data: { type: "customerReviews", id: item.sourceId } },
        },
      },
    })
  ).data;
  return {
    id: created.id,
    body,
    at: created.attributes?.lastModifiedDate,
    state: created.attributes?.state,
  };
}
export async function replyPlay(
  api: GoogleAPI,
  packageName: string,
  item: InboxItem,
  body: string,
) {
  const result = await api.request(
    `/applications/${encodeURIComponent(packageName)}/reviews/${encodeURIComponent(item.sourceId)}:reply`,
    "POST",
    { replyText: body },
  );
  return {
    body: result.result?.replyText ?? body,
    at: new Date().toISOString(),
  };
}
export async function crashLog(api: AppleAPI, item: InboxItem) {
  // Apple attaches a log only when the tester shares one; most crash reports
  // have none, and Apple answers 404.
  const log = await api
    .request(`/betaFeedbackCrashSubmissions/${item.sourceId}/crashLog`)
    .catch((error) => {
      if (/APPLE_404/.test(error?.code ?? "")) return undefined;
      throw error;
    });
  return String(log?.data?.attributes?.logText ?? "");
}

/** What deserves a notification: low ratings, any TestFlight feedback or crash. */
export const notable = (item: InboxItem) =>
  item.kind !== "review" || (item.rating ?? 5) <= 2;
