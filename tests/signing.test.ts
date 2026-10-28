import { it, expect } from "vitest";
import {
  validateProvision,
  signingEnvironments,
  type Provision,
} from "../src/core/signing";
import { parseBundleManifest } from "../src/core/android-manifest";
import { appleWWDRG3, appleWWDRG3SHA256 } from "../src/core/apple-ca";
import { createHash, X509Certificate } from "node:crypto";
const valid: Provision = {
  UUID: "1234-ABCD",
  Name: "App Store profile",
  TeamIdentifier: ["TEAM123"],
  ExpirationDate: new Date("2099-01-01"),
  DeveloperCertificates: [],
  Entitlements: {
    "application-identifier": "TEAM123.com.example.app",
    "com.apple.developer.nfc.readersession.formats": ["TAG"],
    "com.apple.developer.icloud-container-identifiers": [
      "iCloud.com.example.app",
    ],
    "keychain-access-groups": ["TEAM123.*"],
  },
};
it("resolves profile-controlled environments for build inputs while keeping artifact validation strict", () => {
  const profile = {
    ...valid,
    Entitlements: {
      ...valid.Entitlements,
      "aps-environment": "production",
      "com.apple.developer.icloud-container-environment": "Production",
    },
  };
  const input = {
    "aps-environment": "development",
    "com.apple.developer.icloud-container-environment": "Development",
    "com.apple.developer.nfc.readersession.formats": ["TAG"],
  };
  const resolved = signingEnvironments(input, profile);
  expect(resolved["aps-environment"]).toBe("production");
  expect(resolved["com.apple.developer.icloud-container-environment"]).toBe(
    "Production",
  );
  expect(input["aps-environment"]).toBe("development");
  expect(() =>
    validateProvision(profile, "com.example.app", "TEAM123", resolved, "store"),
  ).not.toThrow();
  expect(() =>
    validateProvision(profile, "com.example.app", "TEAM123", input, "store"),
  ).toThrow(/aps-environment/);
  expect(
    signingEnvironments({ "aps-environment": "invalid" }, profile)[
      "aps-environment"
    ],
  ).toBe("invalid");
  expect(() =>
    validateProvision(
      valid,
      "com.example.app",
      "TEAM123",
      signingEnvironments(input, valid),
      "store",
    ),
  ).toThrow(/aps-environment/);
});
it("validates distribution profiles and capability subsets", () => {
  expect(() =>
    validateProvision(
      valid,
      "com.example.app",
      "TEAM123",
      {
        "com.apple.developer.nfc.readersession.formats": ["TAG"],
        "keychain-access-groups": ["TEAM123.com.example.app"],
      },
      "store",
    ),
  ).not.toThrow();
});
it("accepts Apple's scalar iCloud wildcard and list of permitted environments without broadening container IDs", () => {
  const profile = {
    ...valid,
    Entitlements: {
      ...valid.Entitlements,
      "com.apple.developer.icloud-services": "*",
      "com.apple.developer.icloud-container-environment": [
        "Production",
        "Development",
      ],
    },
  };
  const required = {
    "com.apple.developer.icloud-services": ["CloudDocuments"],
    "com.apple.developer.icloud-container-environment": "Development",
    "com.apple.developer.icloud-container-identifiers": [
      "iCloud.com.example.app",
    ],
  };
  const resolved = signingEnvironments(required, profile);
  expect(resolved["com.apple.developer.icloud-container-environment"]).toBe(
    "Production",
  );
  expect(() =>
    validateProvision(profile, "com.example.app", "TEAM123", resolved, "store"),
  ).not.toThrow();
  expect(() =>
    validateProvision(
      profile,
      "com.example.app",
      "TEAM123",
      {
        ...resolved,
        "com.apple.developer.icloud-container-identifiers": ["iCloud.wrong"],
      },
      "store",
    ),
  ).toThrow(/container-identifiers/);
});
it("rejects expired profiles, wrong teams, and wrong app identities", () => {
  expect(() =>
    validateProvision(
      { ...valid, ExpirationDate: new Date("2020-01-01") },
      "com.example.app",
      "TEAM123",
      {},
      "store",
    ),
  ).toThrow(/expired/);
  expect(() =>
    validateProvision(valid, "com.example.app", "OTHER", {}, "store"),
  ).toThrow(/team/);
  expect(() =>
    validateProvision(valid, "com.other.app", "TEAM123", {}, "store"),
  ).toThrow(/does not match/);
});
it("rejects entitlement mismatches and device profiles for store distribution", () => {
  expect(() =>
    validateProvision(
      valid,
      "com.example.app",
      "TEAM123",
      { "com.apple.developer.icloud-container-identifiers": ["iCloud.wrong"] },
      "store",
    ),
  ).toThrow(/entitlement/);
  expect(() =>
    validateProvision(
      { ...valid, ProvisionedDevices: ["device"] },
      "com.example.app",
      "TEAM123",
      {},
      "store",
    ),
  ).toThrow(/Store builds/);
  expect(() =>
    validateProvision(valid, "com.example.app", "TEAM123", {}, "internal"),
  ).toThrow(/registered device/);
});
function varint(value: number) {
  const out = [];
  do {
    let n = value & 127;
    value = Math.floor(value / 128);
    if (value) n |= 128;
    out.push(n);
  } while (value);
  return Buffer.from(out);
}
function field(tag: number, value: string | Buffer) {
  const b = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([varint((tag << 3) | 2), varint(b.length), b]);
}
it("reads package and versions from the AAB protobuf manifest", () => {
  const attr = (name: string, value: string) =>
    field(4, Buffer.concat([field(2, name), field(3, value)]));
  const xml = field(
    1,
    Buffer.concat([
      field(3, "manifest"),
      attr("package", "com.example.app"),
      attr("versionCode", "42"),
      attr("versionName", "1.2.3"),
    ]),
  );
  expect(parseBundleManifest(xml)).toEqual({
    packageName: "com.example.app",
    versionCode: "42",
    versionName: "1.2.3",
  });
  expect(() => parseBundleManifest(Buffer.from([255]))).toThrow();
});

import { certificateId, macKeychainP12 } from "../src/core/signing";
import { run } from "../src/core/process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
it("bundles an intact Apple intermediate accepted by the existing macOS root trust", async () => {
  const cert = Buffer.from(appleWWDRG3, "base64");
  expect(createHash("sha256").update(cert).digest("hex").toUpperCase()).toBe(
    appleWWDRG3SHA256,
  );
  const decoded = new X509Certificate(cert);
  expect(decoded.ca).toBe(true);
  expect(decoded.subject).toContain("OU=G3");
  expect(new Date(decoded.validTo).getTime()).toBeGreaterThan(Date.now());
  if (process.platform === "darwin") {
    const { writeFile } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "desk-ca-test-"));
    try {
      const path = join(root, "intermediate.cer");
      await writeFile(path, cert);
      await expect(
        run("security", ["verify-cert", "-c", path, "-p", "basic"]),
      ).resolves.toMatchObject({ code: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
it("verifies an imported P12 certificate and its private key against the Apple team", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-cert-test-"));
  try {
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "key.pem"),
      "-out",
      join(root, "cert.pem"),
      "-days",
      "3",
      "-subj",
      "/CN=Fixture Distribution",
    ]);
    await run(
      "openssl",
      [
        "pkcs12",
        "-export",
        "-in",
        join(root, "cert.pem"),
        "-inkey",
        join(root, "key.pem"),
        "-out",
        join(root, "cert.p12"),
        "-passout",
        "stdin",
      ],
      { input: "test-password\n" },
    );
    const pem = await readFile(join(root, "cert.pem"), "utf8");
    const cert = pem
      .match(
        /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/,
      )![1]
      .replace(/\s/g, "");
    const api = {
      request: async () => ({
        data: [
          {
            id: "apple-cert",
            attributes: {
              certificateContent: cert,
              certificateType: "DISTRIBUTION",
            },
          },
        ],
      }),
    };
    const credential = {
      kind: "ios" as const,
      label: "Fixture",
      p12: (await readFile(join(root, "cert.p12"))).toString("base64"),
      password: "test-password",
      profiles: [],
    };
    if (process.platform === "darwin") {
      const keychain = join(root, "fixture.keychain-db");
      await run("security", [
        "create-keychain",
        "-p",
        "fixture-keychain-password",
        keychain,
      ]);
      try {
        const compatible = await macKeychainP12(credential, root);
        const imported = await run("security", [
          "import",
          compatible,
          "-k",
          keychain,
          "-P",
          credential.password,
          "-T",
          "/usr/bin/codesign",
        ]);
        expect(imported.stdout).toContain("1 identity imported");
      } finally {
        await run("security", ["delete-keychain", keychain]);
      }
    }
    await expect(
      certificateId(api as any, credential, root, true),
    ).resolves.toBe("apple-cert");
    await run(
      "openssl",
      [
        "pkcs12",
        "-export",
        "-legacy",
        "-in",
        join(root, "cert.pem"),
        "-inkey",
        join(root, "key.pem"),
        "-out",
        join(root, "legacy.p12"),
        "-passout",
        "stdin",
      ],
      { input: credential.password + "\n" },
    );
    const legacy = {
      ...credential,
      p12: (await readFile(join(root, "legacy.p12"))).toString("base64"),
    };
    await expect(certificateId(api as any, legacy, root, true)).resolves.toBe(
      "apple-cert",
    );
    await expect(macKeychainP12(legacy, root)).resolves.toContain(
      "keychain-import.p12",
    );
    await expect(
      certificateId(
        api as any,
        { ...credential, password: "wrong-password" },
        root,
        true,
      ),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
