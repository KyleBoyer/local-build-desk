import { app } from "electron";
import { AppleAPI, GoogleAPI } from "../../src/core/stores";
import { Vault } from "../../src/core/vault";
// Recorded provider responses behind the real engine, IPC, preload and renderer.
const fixture = globalThis as any;
fixture.__storeHistoryState = "WAITING_FOR_REVIEW";
fixture.__storeHistoryGoogleError = false;
fixture.__storeHistoryWrites = [];
fixture.__storeHistoryReads = [];
fixture.__storeHistoryImageFetches = 0;
const read = Vault.prototype.get;
Vault.prototype.get = async function (id: any, kind: any): Promise<any> {
  if (id === "apple-fixture")
    return {
      kind: "apple",
      label: "Fixture",
      privateKey: "unused",
      keyId: "fixture",
      issuerId: "issuer",
      teamId: "TEAM",
    };
  if (id === "google-fixture")
    return {
      kind: "google",
      label: "Fixture",
      serviceAccount: {
        client_email: "fixture@example.com",
        private_key: "unused",
      },
    };
  return read.call(this, id, kind);
};
AppleAPI.prototype.request = async function (path, method = "GET", body) {
  fixture.__storeHistoryReads.push(path);
  if (fixture.__storeHistoryDelay)
    await new Promise((resolve) =>
      setTimeout(resolve, fixture.__storeHistoryDelay),
    );
  if (method !== "GET") {
    fixture.__storeHistoryWrites.push({ path, method });
    throw Error("The status view must not write to Apple");
  }
  if (path.startsWith("/apps?"))
    return {
      data: [{ id: "123", attributes: { bundleId: "com.example.fixture" } }],
    };
  if (path.includes("/appStoreVersions?"))
    return {
      data: [
        {
          id: "version",
          attributes: {
            versionString: "1.0",
            appStoreState: fixture.__storeHistoryState,
            createdDate: "2026-10-29T10:00:00Z",
          },
          relationships: { build: { data: { type: "builds", id: "build3" } } },
        },
      ],
      included: [
        { type: "builds", id: "build3", attributes: { version: "3" } },
      ],
    };
  if (path.startsWith("/builds?"))
    return {
      data: [
        {
          id: "build4",
          attributes: {
            version: "4",
            processingState: "VALID",
            uploadedDate: "2026-10-29T12:00:00Z",
            expirationDate: "2027-01-27T12:00:00Z",
          },
          relationships: {
            preReleaseVersion: {
              data: { type: "preReleaseVersions", id: "pre" },
            },
            buildBetaDetail: {
              data: { type: "buildBetaDetails", id: "detail" },
            },
            betaAppReviewSubmission: {
              data: { type: "betaAppReviewSubmissions", id: "beta" },
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
          id: "detail",
          attributes: {
            internalBuildState: "IN_BETA_TESTING",
            externalBuildState: "WAITING_FOR_BETA_REVIEW",
          },
        },
        {
          type: "betaAppReviewSubmissions",
          id: "beta",
          attributes: { betaReviewState: "WAITING_FOR_REVIEW" },
        },
      ],
    };
  if (path.includes("appStoreVersionLocalizations?"))
    return {
      data: [
        {
          id: "locale",
          attributes: {
            locale: "en-US",
            description: "The submitted review description.",
            whatsNew: "A new action.",
          },
        },
      ],
    };
  if (path.includes("appScreenshotSets?"))
    return {
      data: [
        { id: "set", attributes: { screenshotDisplayType: "APP_IPHONE_67" } },
      ],
    };
  if (path.includes("appScreenshots?"))
    return {
      data: [
        {
          id: "shot",
          attributes: {
            fileName: "review-home.png",
            assetDeliveryState: { state: "COMPLETE" },
            imageAsset: {
              width: 1320,
              height: 2868,
              templateUrl: "https://is1.mzstatic.com/review.png",
            },
          },
        },
      ],
    };
  if (path.includes("betaBuildLocalizations?"))
    return {
      data: [
        {
          id: "beta-locale",
          attributes: {
            locale: "en-US",
            whatsNew: "Try the new TestFlight action.",
          },
        },
      ],
    };
  if (path.includes("betaGroups?"))
    return {
      data: [
        {
          id: "group",
          attributes: { name: "Internal testers", isInternalGroup: true },
        },
      ],
    };
  throw Error("Unexpected Apple fixture endpoint " + path);
};
GoogleAPI.prototype.request = async function (path, method = "GET", body) {
  if (fixture.__storeHistoryGoogleError)
    throw Error("Google Play 403: permission needs attention");
  if (method !== "GET") fixture.__storeHistoryWrites.push({ path, method });
  if (method === "POST" && path.endsWith("/edits")) return { id: "read-view" };
  if (method === "DELETE") return {};
  if (method !== "GET")
    throw Error("The status view must not change Google releases");
  if (path.endsWith("/tracks"))
    return {
      tracks: [
        {
          track: "internal",
          releases: [
            {
              name: "1.0",
              versionCodes: ["4"],
              status: "completed",
              releaseNotes: [
                { language: "en-US", text: "New folding levels." },
              ],
            },
          ],
        },
      ],
    };
  if (path.endsWith("/listings"))
    return {
      listings: [
        {
          language: "en-US",
          title: "Fixture",
          fullDescription: "Current Play listing description.",
          shortDescription: "A folding puzzle.",
        },
      ],
    };
  if (path.endsWith("/phoneScreenshots"))
    return {
      images: [
        {
          id: "google-shot",
          url: "https://play-lh.googleusercontent.com/phone.png",
        },
      ],
    };
  return {};
};
const actualFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = String(input);
  if (
    url.startsWith("https://is1.mzstatic.com/") ||
    url.startsWith("https://play-lh.googleusercontent.com/")
  ) {
    fixture.__storeHistoryImageFetches++;
    return new Response(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZkAAAAASUVORK5CYII=",
        "base64",
      ),
      { headers: { "Content-Type": "image/png" } },
    );
  }
  return actualFetch(input, init);
};
const fail = (error: unknown) => {
  console.error(error);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
void import("../../src/main/index").catch(fail);
