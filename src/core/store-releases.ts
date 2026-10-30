import type { AppleAPI } from "./stores";
import type {
  StoreRelease,
  StoreImageSource,
  StoreListingText,
} from "./store-release-types";
import { invariant } from "./errors";
const related = (row: any, key: string, included: any[]) =>
  included.find(
    (r) =>
      r.id === row.relationships?.[key]?.data?.id &&
      r.type === row.relationships?.[key]?.data?.type,
  );
const stateOf = (row: any) =>
  row.attributes?.appStoreState ?? row.attributes?.appVersionState ?? "UNKNOWN";

export async function appleReleases(api: AppleAPI, bundleId: string) {
  const app = await api.app(bundleId);
  const [versions, builds] = await Promise.allSettled([
    api.request(
      `/apps/${encodeURIComponent(app.id)}/appStoreVersions?filter[platform]=IOS&include=build&limit=25`,
    ),
    api.request(
      `/builds?filter[app]=${encodeURIComponent(app.id)}&sort=-uploadedDate&include=preReleaseVersion,buildBetaDetail,betaAppReviewSubmission&limit=25`,
    ),
  ]);
  const releases: StoreRelease[] = [];
  if (versions.status === "fulfilled")
    for (const row of versions.value.data ?? []) {
      const build = related(row, "build", versions.value.included ?? []);
      releases.push({
        id: `appstore:${row.id}`,
        resourceId: row.id,
        channel: "appstore",
        version: row.attributes.versionString,
        buildNumbers: build ? [String(build.attributes.version)] : [],
        status: stateOf(row),
        createdAt: row.attributes.createdDate,
        consoleUrl: `https://appstoreconnect.apple.com/apps/${app.id}/distribution`,
      });
    }
  if (builds.status === "fulfilled")
    for (const row of builds.value.data ?? []) {
      const included = builds.value.included ?? [],
        detail = related(row, "buildBetaDetail", included)?.attributes;
      const beta = related(
        row,
        "betaAppReviewSubmission",
        included,
      )?.attributes;
      releases.push({
        id: `testflight:${row.id}`,
        resourceId: row.id,
        channel: "testflight",
        version: related(row, "preReleaseVersion", included)?.attributes
          .version,
        buildNumbers: [String(row.attributes.version)],
        status: row.attributes.expired
          ? "EXPIRED"
          : row.attributes.processingState !== "VALID"
            ? (row.attributes.processingState ?? "UNKNOWN")
            : (detail?.internalBuildState ?? "VALID"),
        uploadedAt: row.attributes.uploadedDate,
        expiresAt: row.attributes.expirationDate,
        internalState: detail?.internalBuildState,
        externalState: detail?.externalBuildState,
        betaReviewState: beta?.betaReviewState,
        consoleUrl: `https://appstoreconnect.apple.com/apps/${app.id}/testflight`,
      });
    }
  return { releases, versions, builds };
}
async function appleList(api: AppleAPI, path: string) {
  const rows: any[] = [],
    seen = new Set<string>();
  for (let count = 0; path && count < 20; count++) {
    invariant(
      !seen.has(path),
      "APPLE_PAGINATION",
      "Apple returned a repeated asset page.",
    );
    seen.add(path);
    const result = await api.request(path);
    rows.push(...(result.data ?? []));
    if (!result.links?.next) return rows;
    const next = new URL(
      result.links.next,
      "https://api.appstoreconnect.apple.com",
    );
    invariant(
      next.origin === "https://api.appstoreconnect.apple.com" &&
        next.pathname.startsWith("/v1/"),
      "APPLE_PAGINATION",
      "Unexpected Apple results page.",
    );
    path = next.pathname.slice(3) + next.search;
  }
  throw new Error(
    "Apple returned too many asset pages. Open this release in App Store Connect.",
  );
}
export function appleImageUrl(asset: any) {
  if (!asset?.templateUrl) return undefined;
  const width = 480,
    height = Math.min(
      1400,
      Math.max(
        1,
        Math.round(
          (width * (Number(asset.height) || 1)) / (Number(asset.width) || 1),
        ),
      ),
    );
  return String(asset.templateUrl)
    .replaceAll("{w}", String(width))
    .replaceAll("{h}", String(height))
    .replaceAll("{f}", "png")
    .replaceAll("{c}", "bb");
}
export async function appleReleaseDetail(
  api: AppleAPI,
  release: StoreRelease,
  preferredLocale?: string,
) {
  const images: StoreImageSource[] = [],
    listings: StoreListingText[] = [],
    groups: string[] = [],
    notes: string[] = [];
  if (release.channel === "testflight") {
    const results = await Promise.allSettled([
      appleList(
        api,
        `/builds/${encodeURIComponent(release.resourceId)}/betaBuildLocalizations?limit=200`,
      ),
      appleList(
        api,
        `/builds/${encodeURIComponent(release.resourceId)}/betaGroups?limit=200`,
      ),
    ]);
    if (results[0].status === "fulfilled")
      for (const row of results[0].value)
        listings.push({
          locale: row.attributes.locale,
          whatsNew: row.attributes.whatsNew,
        });
    else
      notes.push(
        "What to Test could not be read: " +
          String(results[0].reason?.message ?? results[0].reason),
      );
    if (results[1].status === "fulfilled")
      groups.push(
        ...results[1].value.map(
          (r) =>
            `${r.attributes.name} (${r.attributes.isInternalGroup ? "internal" : "external"})`,
        ),
      );
    else
      notes.push(
        "Testing groups could not be read: " +
          String(results[1].reason?.message ?? results[1].reason),
      );
    notes.push(
      "TestFlight builds have no store screenshots attached. App Store listing screenshots belong to a version; local capture evidence, when available below, belongs to this exact build.",
    );
  } else {
    const locales = await appleList(
      api,
      `/appStoreVersions/${encodeURIComponent(release.resourceId)}/appStoreVersionLocalizations?limit=200`,
    );
    const imageLocale =
      locales.find((l) => l.attributes.locale === preferredLocale)?.attributes
        .locale ??
      locales.find((l) => l.attributes.locale === "en-US")?.attributes.locale ??
      locales[0]?.attributes.locale;
    for (const locale of locales) {
      listings.push({
        locale: locale.attributes.locale,
        description: locale.attributes.description,
        whatsNew: locale.attributes.whatsNew,
        keywords: locale.attributes.keywords,
      });
      if (locale.attributes.locale !== imageLocale) continue;
      try {
        const sets = await appleList(
          api,
          `/appStoreVersionLocalizations/${encodeURIComponent(locale.id)}/appScreenshotSets?limit=200`,
        );
        for (const set of sets) {
          const shots = await appleList(
            api,
            `/appScreenshotSets/${encodeURIComponent(set.id)}/appScreenshots?limit=200`,
          );
          for (const shot of shots)
            images.push({
              name: shot.attributes.fileName ?? "Screenshot",
              locale: locale.attributes.locale,
              displayType: set.attributes.screenshotDisplayType,
              status: shot.attributes.assetDeliveryState?.state,
              width: shot.attributes.imageAsset?.width,
              height: shot.attributes.imageAsset?.height,
              url: appleImageUrl(shot.attributes.imageAsset),
              origin: "store",
            });
        }
      } catch (error) {
        notes.push(
          `${locale.attributes.locale} screenshots could not be read: ${(error as Error).message}`,
        );
      }
    }
  }
  return { listings, images, groups, notes };
}

/** The image URL comes from a store API, but is still validated before fetching.
 * Never send an API credential to a CDN, follow a redirect off the allowlist,
 * accept SVG/HTML, or buffer an unbounded asset in the main process. */
export function trustedStoreImage(url: string) {
  const parsed = new URL(url);
  invariant(
    parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      ["mzstatic.com", "googleusercontent.com", "ggpht.com"].some(
        (domain) =>
          parsed.hostname === domain || parsed.hostname.endsWith("." + domain),
      ),
    "STORE_IMAGE_URL",
    "The store returned an unsupported image host. Open the console to view this asset.",
  );
  return parsed.href;
}
export async function fetchStoreImage(
  url: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  let target = trustedStoreImage(url);
  const abort = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
    : AbortSignal.timeout(20000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(target, {
      redirect: "manual",
      signal: abort,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      invariant(
        location,
        "STORE_IMAGE_REDIRECT",
        "The image redirect has no destination.",
      );
      target = trustedStoreImage(new URL(location, target).href);
      continue;
    }
    invariant(
      response.ok,
      "STORE_IMAGE_FETCH",
      `The store image is unavailable (${response.status}). Refresh the release or view it in the console.`,
    );
    const max = 12 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > max) {
      await response.body?.cancel();
      throw new Error("The store image exceeds the 12 MB preview limit.");
    }
    const reader = response.body?.getReader();
    invariant(reader, "STORE_IMAGE_FETCH", "The image response was empty.");
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        invariant(
          size <= max,
          "STORE_IMAGE_SIZE",
          "The store image exceeds the 12 MB preview limit.",
        );
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = Buffer.concat(chunks);
    const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp =
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP";
    invariant(
      png || jpeg || webp,
      "STORE_IMAGE_FORMAT",
      "The store did not return a supported PNG, JPEG or WebP preview.",
    );
    return `data:image/${png ? "png" : jpeg ? "jpeg" : "webp"};base64,${bytes.toString("base64")}`;
  }
  throw new Error("The store image redirected too many times.");
}
