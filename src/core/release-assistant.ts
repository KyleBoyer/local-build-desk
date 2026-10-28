import { randomUUID, createHash } from "node:crypto";
import { AppleAPI } from "./stores";
import { invariant } from "./errors";
import type { Job, ReleaseDraft, ReleasePreview } from "./types";
export const releaseFields = [
  "whatsNew",
  "description",
  "keywords",
  "promotionalText",
  "supportUrl",
  "marketingUrl",
] as const;
async function list(api: AppleAPI, path: string) {
  const items: any[] = [];
  for (let pages = 0; path && pages < 50; pages++) {
    const response = await api.request(path);
    items.push(...response.data);
    if (!response.links?.next) return items;
    const next = new URL(
      response.links.next,
      "https://api.appstoreconnect.apple.com",
    );
    invariant(
      next.origin === "https://api.appstoreconnect.apple.com" &&
        next.pathname.startsWith("/v1/"),
      "APPLE_PAGE",
      "Invalid Apple pagination link.",
    );
    path = next.pathname.slice(3) + next.search;
  }
  throw new Error(
    "Too many Apple result pages. Narrow the selected app/version.",
  );
}
export async function releaseContext(
  api: AppleAPI,
  job: Job,
  draft: ReleaseDraft,
) {
  invariant(
    job.bundleId && job.version && job.platform === "ios",
    "RELEASE_BUILD",
    "Choose an iOS build with a recorded app identity and version.",
  );
  const app = await api.app(job.bundleId);
  let parent: any, localization: any;
  if (draft.destination === "testflight") {
    invariant(
      job.buildNumber,
      "RELEASE_BUILD",
      "The selected build has no build number.",
    );
    const builds = await api.build(job.bundleId, job.buildNumber, job.version);
    invariant(
      builds.length === 1 && !builds[0].attributes.expired,
      "TESTFLIGHT_BUILD",
      "Upload this exact build first and wait for it to appear in TestFlight.",
    );
    parent = builds[0];
    localization = (
      await list(
        api,
        `/builds/${encodeURIComponent(parent.id)}/betaBuildLocalizations?limit=200`,
      )
    ).find((x) => x.attributes.locale === draft.locale);
  } else {
    parent = (
      await list(
        api,
        `/apps/${encodeURIComponent(app.id)}/appStoreVersions?filter[platform]=IOS&limit=200`,
      )
    ).find((x) => x.attributes.versionString === job.version);
    invariant(
      !parent ||
        [
          "PREPARE_FOR_SUBMISSION",
          "DEVELOPER_REJECTED",
          "REJECTED",
          "METADATA_REJECTED",
        ].includes(
          parent.attributes.appVersionState ?? parent.attributes.appStoreState,
        ),
      "VERSION_NOT_EDITABLE",
      "This App Store version is not an editable draft. Manage its review state in App Store Connect first.",
    );
    invariant(
      parent || draft.createVersion,
      "VERSION_MISSING",
      "No App Store draft exists for this version. Enable ‘Create draft version’ to prepare one; this does not submit it for review.",
    );
    if (parent)
      localization = (
        await list(
          api,
          `/appStoreVersions/${encodeURIComponent(parent.id)}/appStoreVersionLocalizations?limit=200`,
        )
      ).find((x) => x.attributes.locale === draft.locale);
  }
  const fields =
    draft.destination === "testflight" ? ["whatsNew"] : releaseFields;
  const current = Object.fromEntries(
    fields.map((key) => [key, localization?.attributes[key] ?? ""]),
  );
  return {
    appId: app.id as string,
    parentId: parent?.id as string | undefined,
    localizationId: localization?.id as string | undefined,
    current,
    versionState:
      parent?.attributes.appVersionState ?? parent?.attributes.appStoreState,
  };
}
export function contextFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function previewRelease(
  job: Job,
  draft: ReleaseDraft,
  context: Awaited<ReturnType<typeof releaseContext>>,
): ReleasePreview {
  const keys: readonly (keyof ReleaseDraft["fields"])[] =
    draft.destination === "testflight" ? ["whatsNew"] : releaseFields;
  const changes = keys
    .filter((key) => draft.fields[key] !== undefined)
    .map((key) => ({
      field: key,
      before: String(context.current[key] ?? ""),
      after: draft.fields[key]!,
      changed: context.current[key] !== draft.fields[key],
    }));
  invariant(
    changes.some((x) => x.changed) || !context.parentId,
    "RELEASE_UNCHANGED",
    "These values already match Apple.",
  );
  return {
    token: randomUUID(),
    destination: draft.destination,
    identity: job.bundleId!,
    version: job.version!,
    buildNumber: job.buildNumber,
    locale: draft.locale,
    createsVersion: !context.parentId,
    changes,
  };
}
export async function applyRelease(
  api: AppleAPI,
  job: Job,
  draft: ReleaseDraft,
  expected: string,
) {
  const current = await releaseContext(api, job, draft);
  invariant(
    contextFingerprint(current) === expected,
    "RELEASE_CHANGED",
    "Apple’s metadata changed after this preview. Refresh the preview before applying.",
  );
  let parentId = current.parentId;
  if (!parentId)
    parentId = (
      await api.request("/appStoreVersions", "POST", {
        data: {
          type: "appStoreVersions",
          attributes: {
            platform: "IOS",
            versionString: job.version,
            releaseType: "MANUAL",
          },
          relationships: { app: { data: { type: "apps", id: current.appId } } },
        },
      })
    ).data.id;
  const beta = draft.destination === "testflight",
    type = beta ? "betaBuildLocalizations" : "appStoreVersionLocalizations";
  const attributes = Object.fromEntries(
    Object.entries(draft.fields).filter(([key]) =>
      (beta ? ["whatsNew"] : releaseFields).includes(key as any),
    ),
  );
  if (current.localizationId)
    await api.request(
      `/${type}/${encodeURIComponent(current.localizationId)}`,
      "PATCH",
      { data: { type, id: current.localizationId, attributes } },
    );
  else
    await api.request(`/${type}`, "POST", {
      data: {
        type,
        attributes: { ...attributes, locale: draft.locale },
        relationships: {
          [beta ? "build" : "appStoreVersion"]: {
            data: { type: beta ? "builds" : "appStoreVersions", id: parentId },
          },
        },
      },
    });
  const verified = await releaseContext(api, job, draft);
  invariant(
    Object.entries(attributes).every(
      ([key, value]) => verified.current[key] === value,
    ),
    "RELEASE_VERIFY",
    "Apple did not return the expected notes. Refresh the preview before retrying.",
  );
  return "Apple metadata saved and verified. No App Review submission or production release was performed.";
}
