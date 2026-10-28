import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/database";
import { Vault } from "../src/core/vault";
import {
  requestedCapabilities,
  prepareApple,
  prepareAndroid,
} from "../src/core/setup";
import type { Project } from "../src/core/types";
const mock = vi.hoisted(() => ({
  appExists: true,
  bundleExists: false,
  certificateCalls: 0,
  profileCalls: 0,
  requests: [] as { path: string; method: string }[],
  config: {
    name: "Fixture",
    ios: {
      bundleIdentifier: "com.example.fixture",
      entitlements: {
        "com.apple.developer.nfc.readersession.formats": ["TAG"],
      },
    },
    plugins: ["expo-notifications"],
  } as Record<string, any>,
}));
vi.mock("../src/core/config", async (original) => ({
  ...(await original<any>()),
  inspectProject: vi.fn(async () => ({ config: mock.config })),
  inspectIOSEntitlements: vi.fn(async () => mock.config.ios.entitlements),
}));
vi.mock("../src/core/stores", () => ({
  AppleAPI: class {
    async validate() {
      return "Connected";
    }
    async apps() {
      return mock.appExists
        ? [{ id: "app", attributes: { name: "Fixture" } }]
        : [];
    }
    async latestBuild() {
      return mock.appExists ? 12 : undefined;
    }
    async request(path: string, method = "GET") {
      mock.requests.push({ path, method });
      if (/\/bundleIdCapabilities\?.*limit=/.test(path))
        throw new Error(
          "Apple 400: The parameter 'limit' can not be used with this request : This relationship does not support this parameter.",
        );
      if (path.startsWith("/bundleIds?"))
        return { data: mock.bundleExists ? [{ id: "bundle" }] : [] };
      if (path === "/bundleIds" && method === "POST") {
        mock.bundleExists = true;
        return { data: { id: "bundle" } };
      }
      return { data: [] };
    }
    async profile() {
      mock.profileCalls++;
      return { attributes: { profileContent: "profile-content" } };
    }
  },
  GoogleAPI: class {},
}));
vi.mock("../src/core/signing", async (original) => ({
  ...(await original<any>()),
  certificateId: vi.fn(async () => "cert"),
  createDistributionCertificate: vi.fn(async () => {
    mock.certificateCalls++;
    return {
      kind: "ios",
      label: "Generated",
      p12: "encoded",
      password: "secret",
      profiles: [],
    };
  }),
  decodeProfile: vi.fn(async () => ({
    UUID: "1234",
    Name: "Generated profile",
    TeamIdentifier: ["TEAM"],
    ExpirationDate: new Date("2099-01-01"),
    DeveloperCertificates: [],
    Entitlements: {
      "application-identifier": "TEAM.com.example.fixture",
      "com.apple.developer.nfc.readersession.formats": ["TAG"],
    },
  })),
}));
let store: Store, vault: Vault, root: string, project: Project;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desk-setup-test-"));
  store = new Store(root);
  vault = new Vault(store, {
    async encrypt(v) {
      return Buffer.from(v);
    },
    async decrypt(v) {
      return v.toString();
    },
  });
  const connection = await vault.put({
    kind: "apple",
    label: "Team",
    keyId: "KEY",
    issuerId: "issuer",
    teamId: "TEAM",
    privateKey: "test-key",
  });
  project = {
    id: "p",
    name: "Fixture",
    path: root,
    bundleId: "com.example.fixture",
    packageName: "com.example.fixture",
    profiles: ["production"],
    createdAt: "",
    settings: { appleConnectionId: connection.id },
  };
  store.putProject(project);
  mock.appExists = true;
  mock.bundleExists = false;
  mock.certificateCalls = 0;
  mock.profileCalls = 0;
  mock.requests = [];
  delete mock.config.ios.usesIcloudStorage;
});
afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});
it("derives NFC, iCloud, push, and other supported capabilities", () => {
  expect(
    requestedCapabilities({
      ios: {
        usesIcloudStorage: true,
        entitlements: {
          "com.apple.developer.nfc.readersession.formats": ["TAG"],
          "com.apple.developer.associated-domains": ["applinks:example.com"],
        },
      },
      plugins: ["expo-notifications"],
    }),
  ).toEqual(
    expect.arrayContaining([
      "NFC_TAG_READING",
      "ICLOUD",
      "PUSH_NOTIFICATIONS",
      "ASSOCIATED_DOMAINS",
    ]),
  );
});
it("automates bundle registration, certificate creation, profile creation, and version seeding", async () => {
  const report = await prepareApple(
    store,
    vault,
    project,
    { platform: "ios", newApp: false },
    () => {},
  );
  expect(report.ready).toBe(true);
  expect(mock.certificateCalls).toBe(1);
  expect(mock.profileCalls).toBe(1);
  expect(project.settings.iosSigningId).toBeTruthy();
  expect(store.counter("ios:com.example.fixture")).toBe(12);
  expect(
    mock.requests.some(
      (r) => r.path === "/bundleIdCapabilities" && r.method === "POST",
    ),
  ).toBe(true);
  expect(mock.requests.some((r) => r.method === "DELETE")).toBe(false);
});
it("reuses local signing keys and valid profiles on repeat setup", async () => {
  await prepareApple(
    store,
    vault,
    project,
    { platform: "ios", newApp: false },
    () => {},
  );
  await prepareApple(
    store,
    vault,
    project,
    { platform: "ios", newApp: false },
    () => {},
  );
  expect(mock.certificateCalls).toBe(1);
  expect(mock.profileCalls).toBe(1);
});
it("guides the required first app-record handoff instead of claiming readiness", async () => {
  mock.appExists = false;
  const report = await prepareApple(
    store,
    vault,
    project,
    { platform: "ios", newApp: true },
    () => {},
  );
  expect(report.ready).toBe(false);
  expect(report.handoffs.some((h) => h.title.includes("app record"))).toBe(
    true,
  );
  expect(
    mock.requests.some((r) => r.path === "/apps" && r.method === "POST"),
  ).toBe(false);
});
it("blocks readiness when iCloud containers still need portal assignment", async () => {
  mock.config.ios.usesIcloudStorage = true;
  const report = await prepareApple(
    store,
    vault,
    project,
    { platform: "ios", newApp: false },
    () => {},
  );
  expect(report.ready).toBe(false);
  expect(
    report.handoffs.some((h) => h.title.includes("iCloud container")),
  ).toBe(true);
});
it("will not generate a replacement Android key for an existing app", async () => {
  await expect(
    prepareAndroid(
      store,
      vault,
      project,
      { platform: "android", newApp: false },
      () => {},
    ),
  ).rejects.toThrow(/EAS upload keystore/);
});
