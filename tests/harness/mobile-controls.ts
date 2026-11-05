import { Engine } from "../../src/core/engine";
import { AppleAPI } from "../../src/core/stores";
const state = Engine.prototype.state;
Engine.prototype.state = function () {
  (globalThis as any).__mobileEngine = this;
  return state.call(this);
};
void import("./store-releases").then(() => {
  const fixture = globalThis as any;
  fixture.__storeHistoryState = "PENDING_DEVELOPER_RELEASE";
  const original = AppleAPI.prototype.request;
  AppleAPI.prototype.request = async function (path, method = "GET", body) {
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
    if (path === "/appStoreVersionReleaseRequests" && method === "POST") {
      fixture.__storeHistoryWrites.push({ path, method, body });
      fixture.__storeHistoryState = "PENDING_APPLE_RELEASE";
      return { data: { id: "release-request" } };
    }
    return original.call(this, path, method, body);
  };
});
