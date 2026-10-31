import type { AppleWebSession } from "./app-store-compliance";
import type { AppReviewInfo, AppReviewThread } from "./store-release-types";

// App Review's messages (the Resolution Center). Apple's public API only
// reports review state; the reviewer's messages and the guidelines they cite
// come from App Store Connect's web API, in the person's own signed-in
// session, the same requests the App Review page makes. Read-only.

// App Store Connect's App Review page sends exactly these; narrower include or
// filter shapes on this endpoint answer 400.
const THREAD_TYPES =
  "REJECTION_BINARY,REJECTION_METADATA,REJECTION_REVIEW_SUBMISSION,APP_MESSAGE_ARC,APP_MESSAGE_ARB,APP_MESSAGE_COMM,APP_MESSAGE_INFORMATIONAL";
const THREAD_INCLUDE =
  "appStoreVersions,app,appMessageThreadDetail,build,betaBackgroundAssetReviewSubmission";
/** The newest threads are the ones that matter; older ones stay in App Store Connect. */
const MAX_THREADS = 5;

const ref = (row: any, key: string): { type: string; id: string }[] => {
  const data = row?.relationships?.[key]?.data;
  return Array.isArray(data) ? data : data ? [data] : [];
};

async function pages(web: AppleWebSession, path: string) {
  const data: any[] = [];
  let included: any[] = [];
  for (let page = 0; path && page < 10; page++) {
    const response = await web.request(path);
    data.push(...(response.data ?? []));
    included = included.concat(response.included ?? []);
    const next = response.links?.next as string | undefined;
    if (!next) break;
    const url = new URL(next, "https://appstoreconnect.apple.com");
    // Only follow Apple's own pagination within the same web API.
    if (
      url.origin !== "https://appstoreconnect.apple.com" ||
      !url.pathname.startsWith("/iris/v1/")
    )
      break;
    path = url.pathname.slice("/iris/v1".length) + url.search;
  }
  return { data, included };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Apple sends message bodies as HTML. The UI shows text only, never markup. */
export function plainText(html: string) {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] === "#") {
        const code =
          entity[1]?.toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function actorName(actor: any) {
  const a = actor?.attributes ?? {};
  const name = a.name ?? a.displayName;
  if (name) return String(name);
  if (a.actorType === "APPLE") return "App Review";
  return a.actorType ? String(a.actorType).toLowerCase() : undefined;
}

async function threadDetail(
  web: AppleWebSession,
  thread: any,
): Promise<AppReviewThread> {
  const id = encodeURIComponent(thread.id);
  const [messages, rejections] = await Promise.allSettled([
    pages(
      web,
      `/resolutionCenterThreads/${id}/resolutionCenterMessages?include=fromActor,rejections,resolutionCenterMessageAttachments&limit[rejections]=2000&limit[resolutionCenterMessageAttachments]=1000`,
    ),
    pages(
      web,
      `/reviewRejections?filter[resolutionCenterMessage.resolutionCenterThread]=${id}&limit=2000`,
    ),
  ]);
  const result: AppReviewThread = {
    id: thread.id,
    type: thread.attributes?.threadType ?? "UNKNOWN",
    state: thread.attributes?.state,
    createdAt: thread.attributes?.createdDate,
    lastActivityAt: thread.attributes?.lastMessageResponseDate,
    reasons: [],
    messages: [],
  };
  if (messages.status === "fulfilled") {
    const { data, included } = messages.value;
    const actor = (row: any) => {
      const [r] = ref(row, "fromActor");
      return r && included.find((i) => i.type === r.type && i.id === r.id);
    };
    result.messages = data
      .map((row) => {
        const from = actor(row);
        return {
          id: row.id,
          createdAt: row.attributes?.createdDate,
          from: actorName(from),
          fromApple: from?.attributes?.actorType === "APPLE",
          body: plainText(String(row.attributes?.messageBody ?? "")),
          attachments: ref(row, "resolutionCenterMessageAttachments").length,
        };
      })
      .sort((a, b) =>
        String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
      );
  } else
    result.error = `Messages could not be read: ${String(messages.reason?.message ?? messages.reason)}`;
  if (rejections.status === "fulfilled") {
    const seen = new Set<string>();
    for (const row of rejections.value.data) {
      const a = row.attributes ?? {};
      for (const reason of [
        ...(a.reasons ?? []),
        ...(a.reviewRejectionReasons ?? []),
      ]) {
        const entry = {
          section: reason?.reasonSection,
          description: reason?.reasonDescription,
          code: reason?.reasonCode,
        };
        const key = JSON.stringify(entry);
        if ((entry.section || entry.description) && !seen.has(key)) {
          seen.add(key);
          result.reasons.push(entry);
        }
      }
    }
  }
  return result;
}

/**
 * Resolution Center threads about one App Store version, newest first. Threads
 * not tied to any version (app-wide notices) are included when `appWide` is set.
 */
export async function appReviewThreads(
  web: AppleWebSession,
  appId: string,
  versionId: string,
  appWide: boolean,
): Promise<AppReviewThread[]> {
  const { data } = await pages(
    web,
    `/apps/${encodeURIComponent(appId)}/resolutionCenterThreads?include=${THREAD_INCLUDE}&limit[appStoreVersions]=2000&filter[threadType]=${THREAD_TYPES}`,
  );
  const relevant = data
    .filter((thread) => {
      const versions = ref(thread, "appStoreVersions");
      return versions.length
        ? versions.some((v) => v.id === versionId)
        : appWide;
    })
    .sort((a, b) =>
      String(
        b.attributes?.lastMessageResponseDate ?? b.attributes?.createdDate,
      ).localeCompare(
        String(
          a.attributes?.lastMessageResponseDate ?? a.attributes?.createdDate,
        ),
      ),
    )
    .slice(0, MAX_THREADS);
  return Promise.all(relevant.map((thread) => threadDetail(web, thread)));
}

/** Never throws: a signed-out session or Apple error is reported in the result. */
export async function readAppReview(
  web: AppleWebSession | undefined,
  appId: string,
  versionId: string,
  appWide: boolean,
): Promise<AppReviewInfo> {
  const checkedAt = new Date().toISOString();
  if (!web)
    return {
      checkedAt,
      signedIn: false,
      threads: [],
      error: "App Review messages are only available in Local Build Desk.",
    };
  try {
    return {
      checkedAt,
      signedIn: true,
      threads: await appReviewThreads(web, appId, versionId, appWide),
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === "APPLE_WEB_SIGN_IN")
      return { checkedAt, signedIn: false, threads: [] };
    return {
      checkedAt,
      signedIn: true,
      threads: [],
      error: `App Review messages could not be read: ${e.message ?? String(error)}`,
    };
  }
}
