import "./store-releases";
import { AppleAPI, GoogleAPI } from "../../src/core/stores";
const fixture = globalThis as any;
fixture.__storeHistoryState = "PENDING_DEVELOPER_RELEASE";
fixture.__developmentWrites = [];
const people = [
  {
    id: "alice",
    attributes: {
      email: "alice@example.com",
      state: "INVITED",
      firstName: "Alice",
      appDevices: [],
    },
    relationships: { betaGroups: { data: [{ id: "external" }] } },
  },
];
let groups = ["old@googlegroups.com"];
const apple = AppleAPI.prototype.request;
AppleAPI.prototype.request = async function (path, method = "GET", body: any) {
  if (method !== "GET") {
    fixture.__developmentWrites.push({ provider: "apple", path, method, body });
    if (path === "/appStoreVersionReleaseRequests") {
      fixture.__storeHistoryState = "PENDING_APPLE_RELEASE";
      return { data: { id: "released" } };
    }
    if (path === "/betaTesterInvitations")
      return { data: { id: "invitation" } };
    if (path.includes("/relationships/betaTesters")) return {};
    throw Error(`Unexpected fixture write ${path}`);
  }
  if (path.startsWith("/appStoreVersions/version?"))
    return {
      data: {
        id: "version",
        attributes: {
          versionString: "1.0",
          appStoreState: fixture.__storeHistoryState,
          releaseType: "MANUAL",
        },
        relationships: {
          app: { data: { id: "123" } },
          build: { data: { id: "build3" } },
        },
      },
      included: [
        {
          id: "build3",
          type: "builds",
          attributes: { version: "3", processingState: "VALID" },
        },
      ],
    };
  if (path.startsWith("/reviewSubmissions?")) return { data: [] };
  if (path === "/betaFeedbackCrashSubmissions/crash/crashLog")
    return {
      data: {
        attributes: {
          logText: JSON.stringify({
            threads: [
              {
                triggered: true,
                frames: [
                  { imageIndex: 0, imageOffset: 16, symbol: "fixtureCrash()" },
                ],
              },
            ],
            usedImages: [
              {
                uuid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
                base: 4096,
                arch: "arm64",
                name: "Fixture",
              },
            ],
          }),
        },
      },
    };
  if (path.startsWith("/apps/123/betaGroups?"))
    return {
      data: [
        {
          id: "external",
          attributes: {
            name: "External QA",
            isInternalGroup: false,
            publicLinkEnabled: false,
          },
        },
      ],
    };
  if (path.startsWith("/betaTesters?")) return { data: people };
  if (path.includes("/metrics/betaTesterUsages"))
    return {
      data: [
        {
          dimensions: { betaTesters: { data: "alice" } },
          dataPoints: [
            { values: { sessionCount: 2, crashCount: 0, feedbackCount: 1 } },
          ],
        },
      ],
    };
  return apple.call(this, path, method, body);
};
const google = GoogleAPI.prototype.request;
GoogleAPI.prototype.request = async function (path, method = "GET", body: any) {
  if (path.includes("/testers/")) {
    if (method === "PUT") {
      groups = body.googleGroups;
      fixture.__developmentWrites.push({
        provider: "google",
        path,
        method,
        body,
      });
    }
    return { googleGroups: groups };
  }
  if (path.includes(":commit")) {
    fixture.__developmentWrites.push({
      provider: "google",
      path,
      method,
      body,
    });
    return {};
  }
  return google.call(this, path, method, body);
};
