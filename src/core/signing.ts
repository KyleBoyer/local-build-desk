import { withLock } from "./locks";
import { leaseProfile } from "./profile-leases";
import {
  randomBytes,
  createHash,
  X509Certificate,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import plist from "plist";
import xcode from "xcode";
import { invariant, messageOf } from "./errors";
import { run, type CommandOptions } from "./process";
import { secretFile } from "./vault";
import { AppleAPI, type AppleCredential } from "./stores";
import type { Credential, Profile } from "./types";
import { appleWWDRG3, appleWWDRG3SHA256 } from "./apple-ca";
export interface Provision {
  UUID: string;
  Name: string;
  TeamIdentifier: string[];
  ApplicationIdentifierPrefix?: string[];
  ExpirationDate: Date;
  Entitlements: Record<string, any>;
  DeveloperCertificates: (Buffer | string)[];
  ProvisionedDevices?: string[];
  ProvisionsAllDevices?: boolean;
}
export async function decodeProfile(
  content: string,
  root: string,
): Promise<Provision> {
  const path = await secretFile(
    root,
    `profile-${randomBytes(6).toString("hex")}.mobileprovision`,
    Buffer.from(content, "base64"),
  );
  const result = await run("security", ["cms", "-D", "-i", path]);
  return plist.parse(result.stdout) as unknown as Provision;
}
function permits(allowed: any, required: any): boolean {
  if (typeof required === "string" && typeof allowed === "string") {
    const escaped = allowed
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(required);
  }
  if (Array.isArray(required))
    return (
      (Array.isArray(allowed) || typeof allowed === "string") &&
      required.every((r) =>
        (Array.isArray(allowed) ? allowed : [allowed]).some((a) =>
          permits(a, r),
        ),
      )
    );
  if (Array.isArray(allowed))
    return allowed.some((value) => permits(value, required));
  if (required && typeof required === "object")
    return (
      allowed &&
      Object.entries(required).every(([k, v]) => permits(allowed[k], v))
    );
  return allowed === required;
}
export function validateProvision(
  profile: Provision,
  bundleId: string,
  teamId: string,
  entitlements: Record<string, any>,
  kind: "store" | "internal" | "development",
  date = new Date(),
) {
  invariant(
    new Date(profile.ExpirationDate).getTime() > date.getTime(),
    "PROFILE_EXPIRED",
    `Profile "${profile.Name}" expired. Renew it in Signing.`,
  );
  invariant(
    profile.TeamIdentifier.includes(teamId),
    "PROFILE_TEAM",
    `Profile ${profile.Name} belongs to a different Apple team.`,
  );
  invariant(
    permits(
      profile.Entitlements["application-identifier"],
      `${teamId}.${bundleId}`,
    ),
    "PROFILE_BUNDLE",
    `Profile ${profile.Name} does not match ${bundleId}.`,
  );
  invariant(
    kind !== "store" ||
      (!profile.ProvisionedDevices &&
        !profile.ProvisionsAllDevices &&
        !profile.Entitlements["get-task-allow"]),
    "PROFILE_DISTRIBUTION",
    "Store builds require an App Store distribution profile.",
  );
  invariant(
    kind !== "development" || profile.Entitlements["get-task-allow"] === true,
    "PROFILE_DEVELOPMENT",
    "Development builds require a development profile and certificate.",
  );
  invariant(
    kind !== "internal" ||
      Boolean(
        profile.ProvisionedDevices?.length || profile.ProvisionsAllDevices,
      ),
    "PROFILE_DEVICES",
    "Internal builds require an ad hoc profile containing registered device UDIDs.",
  );
  for (const [key, value] of Object.entries(entitlements)) {
    if (
      [
        "com.apple.developer.team-identifier",
        "application-identifier",
        "get-task-allow",
      ].includes(key)
    )
      continue;
    invariant(
      permits(profile.Entitlements[key], value),
      "ENTITLEMENT_MISMATCH",
      `Profile "${profile.Name}" does not allow entitlement ${key}. Required: ${JSON.stringify(value).slice(0, 1000)}; profile allows: ${JSON.stringify(profile.Entitlements[key] ?? null).slice(0, 1000)}. Enable the capability and its identifiers/containers in Apple Developer, then regenerate the profile.`,
    );
  }
}
// These environments are selected by the signing profile, unlike app capability
// identifiers. Keep final artifact validation strict; resolve only build inputs.
export function signingEnvironments(
  entitlements: Record<string, any>,
  profile: Provision,
) {
  const resolved = { ...entitlements };
  for (const [key, allowed] of [
    ["aps-environment", ["development", "production"]],
    [
      "com.apple.developer.icloud-container-environment",
      ["Development", "Production"],
    ],
  ] as const) {
    const values = Array.isArray(profile.Entitlements[key])
      ? profile.Entitlements[key]
      : [profile.Entitlements[key]];
    const preferred =
      key === "aps-environment"
        ? profile.Entitlements["get-task-allow"]
          ? "development"
          : "production"
        : profile.Entitlements["get-task-allow"]
          ? "Development"
          : "Production";
    const selected = values.includes(preferred)
      ? preferred
      : values.find((value: string) =>
          (allowed as readonly string[]).includes(value),
        );
    if ((allowed as readonly string[]).includes(entitlements[key]) && selected)
      resolved[key] = selected;
  }
  return resolved;
}
export function expandSigningEntitlements(
  entitlements: Record<string, any>,
  profile: Provision,
  bundleId: string,
  teamId: string,
): Record<string, any> {
  const prefix =
    profile.ApplicationIdentifierPrefix?.[0] ??
    profile.Entitlements["application-identifier"]?.split(".")[0] ??
    teamId;
  const expand = (value: any): any =>
    typeof value === "string"
      ? value
          .replace(/\$\(AppIdentifierPrefix\)/g, prefix + ".")
          .replace(/\$\(TeamIdentifierPrefix\)/g, teamId + ".")
          .replace(
            /\$\((?:PRODUCT_BUNDLE_IDENTIFIER|CFBundleIdentifier)\)/g,
            bundleId,
          )
      : Array.isArray(value)
        ? value.map(expand)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([key, entry]) => [key, expand(entry)]),
            )
          : value;
  return expand(entitlements);
}
export async function withIOSSigning<T>(
  credential: Extract<Credential, { kind: "ios" }>,
  root: string,
  options: CommandOptions,
  fn: (value: {
    keychain: string;
    identity: string;
    profiles: Provision[];
    teamId: string;
  }) => Promise<T>,
): Promise<T> {
  const password = randomBytes(24).toString("hex");
  const keychain = join(root, "signing.keychain-db");
  const p12 = await macKeychainP12(credential, root);
  options.secrets?.add(password, credential.password, credential.p12);
  const listKeychains = async () =>
    (await run("security", ["list-keychains", "-d", "user"])).stdout
      .split("\n")
      .map((line) => line.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  const installed: (() => Promise<void>)[] = [];
  try {
    await withLock("macos-keychain-search-list", options.signal, async () => {
      await run(
        "security",
        ["create-keychain", "-p", password, keychain],
        options,
      );
      const current = await listKeychains();
      await run(
        "security",
        [
          "list-keychains",
          "-d",
          "user",
          "-s",
          ...new Set([keychain, ...current]),
        ],
        options,
      );
    });
    await run(
      "security",
      ["set-keychain-settings", "-lut", "21600", keychain],
      options,
    );
    await run(
      "security",
      ["unlock-keychain", "-p", password, keychain],
      options,
    );
    await run(
      "security",
      [
        "import",
        p12,
        "-k",
        keychain,
        "-P",
        credential.password,
        "-T",
        "/usr/bin/codesign",
        "-T",
        "/usr/bin/security",
      ],
      options,
    );
    const intermediate = Buffer.from(appleWWDRG3, "base64");
    invariant(
      createHash("sha256").update(intermediate).digest("hex").toUpperCase() ===
        appleWWDRG3SHA256,
      "APPLE_INTERMEDIATE",
      "The bundled Apple signing intermediate failed its integrity check.",
    );
    const intermediatePath = await secretFile(
      root,
      "AppleWWDRCAG3.cer",
      intermediate,
    );
    // Verify against macOS's existing root trust. Importing an intermediate into
    // our temporary keychain does not add a new trust anchor or override trust.
    await run(
      "security",
      ["verify-cert", "-c", intermediatePath, "-p", "basic"],
      options,
    );
    await run(
      "security",
      ["import", intermediatePath, "-k", keychain],
      options,
    );
    await run(
      "security",
      [
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        password,
        keychain,
      ],
      options,
    );
    const identities = await run(
      "security",
      ["find-identity", "-v", "-p", "codesigning", keychain],
      options,
    );
    const identity = identities.stdout.match(/\) ([A-Fa-f0-9]{40}) "/)?.[1];
    if (!identity)
      await run(
        "security",
        ["find-identity", "-p", "codesigning", keychain],
        options,
      );
    invariant(
      identity,
      "NO_PRIVATE_KEY",
      "macOS found no valid signing identity after import. Check the certificate/private-key pair, certificate expiry, and Apple intermediate trust chain. Details are retained in the signing logs.",
    );
    const profiles: Provision[] = [];
    for (const content of credential.profiles) {
      const profile = await decodeProfile(content, root);
      const certMatch = profile.DeveloperCertificates.some(
        (cert) =>
          createHash("sha1")
            .update(Buffer.isBuffer(cert) ? cert : Buffer.from(cert, "base64"))
            .digest("hex")
            .toLowerCase() === identity.toLowerCase(),
      );
      if (!certMatch) continue;
      profiles.push(profile);
      invariant(
        /^[A-Fa-f0-9-]+$/.test(profile.UUID),
        "PROFILE_UUID",
        "Profile UUID is invalid.",
      );
      for (const folder of [
        join(homedir(), "Library/MobileDevice/Provisioning Profiles"),
        join(
          homedir(),
          "Library/Developer/Xcode/UserData/Provisioning Profiles",
        ),
      ]) {
        await mkdir(folder, { recursive: true });
        const path = join(folder, `${profile.UUID}.mobileprovision`);
        installed.push(
          await leaseProfile(path, Buffer.from(content, "base64")),
        );
      }
    }
    invariant(
      profiles.length,
      "NO_PROFILES",
      "Import a provisioning profile or create one in Signing.",
    );
    return await fn({
      keychain,
      identity,
      profiles,
      teamId: profiles[0].TeamIdentifier[0],
    });
  } finally {
    await Promise.allSettled(installed.map((release) => release()));
    await withLock("macos-keychain-search-list", undefined, async () => {
      const current = await listKeychains().catch(() => undefined);
      if (current)
        await run(
          "security",
          [
            "list-keychains",
            "-d",
            "user",
            "-s",
            ...current.filter((path) => path !== keychain),
          ],
          { allowFailure: true },
        );
      await run("security", ["delete-keychain", keychain], {
        allowFailure: true,
      }).catch(() => {});
    }).catch(() => {});
  }
}
async function readPKCS12(args: string[], password: string) {
  try {
    return await run("openssl", ["pkcs12", ...args, "-passin", "stdin"], {
      input: password + "\n",
    });
  } catch (error) {
    // Older EAS exports can use RC2, requiring OpenSSL's legacy provider.
    if (!/unsupported|RC2/i.test(messageOf(error))) throw error;
    return run("openssl", ["pkcs12", "-legacy", ...args, "-passin", "stdin"], {
      input: password + "\n",
    });
  }
}
// macOS Security does not accept all PKCS#12 defaults used by newer OpenSSL.
// Convert only the temporary import wrapper; the vault keeps the original.
export async function macKeychainP12(
  credential: Extract<Credential, { kind: "ios" }>,
  root: string,
) {
  const original = await secretFile(
    root,
    "original.p12",
    Buffer.from(credential.p12, "base64"),
  );
  const pem = join(root, "keychain-import.pem");
  const output = join(root, "keychain-import.p12");
  try {
    await writeFile(pem, "", { mode: 0o600 });
    await writeFile(output, "", { mode: 0o600 });
    await readPKCS12(
      ["-in", original, "-nodes", "-out", pem],
      credential.password,
    );
    await run(
      "openssl",
      [
        "pkcs12",
        "-export",
        "-in",
        pem,
        "-inkey",
        pem,
        "-out",
        output,
        "-keypbe",
        "PBE-SHA1-3DES",
        "-certpbe",
        "PBE-SHA1-3DES",
        "-macalg",
        "sha1",
        "-passout",
        "stdin",
      ],
      { input: credential.password + "\n" },
    );
    return output;
  } finally {
    await rm(pem, { force: true });
  }
}
export async function configureIOSSigning(
  iosRoot: string,
  signing: { identity: string; teamId: string; profiles: Provision[] },
  profile: Profile,
  bundleId: string,
  log?: (text: string) => void,
) {
  const entries = await readdir(iosRoot);
  const projectName = entries.find((x) => x.endsWith(".xcodeproj"));
  invariant(projectName, "XCODE_PROJECT", "No .xcodeproj found in ios.");
  const project = xcode.project(join(iosRoot, projectName, "project.pbxproj"));
  project.parseSync();
  const objects: any = project.hash.project.objects;
  const targets = objects.PBXNativeTarget ?? {};
  const configs = objects.XCBuildConfiguration ?? {};
  let mapped = 0;
  const selectedProfiles: Record<string, string> = {};
  for (const [key, target] of Object.entries<any>(targets)) {
    if (
      key.endsWith("_comment") ||
      !target.buildConfigurationList ||
      /unit-test|ui-testing/.test(target.productType ?? "")
    )
      continue;
    const configList =
      objects.XCConfigurationList[target.buildConfigurationList];
    for (const item of configList?.buildConfigurations ?? []) {
      const config = configs[item.value];
      if (
        !config?.buildSettings ||
        String(config.name).replace(/^"|"$/g, "") !== profile.configuration
      )
        continue;
      const settings = config.buildSettings;
      const id = String(settings.PRODUCT_BUNDLE_IDENTIFIER ?? bundleId).replace(
        /^"|"$/g,
        "",
      );
      invariant(
        !id.includes("$("),
        "BUNDLE_VARIABLE",
        `Resolve target bundle identifier ${id} to a literal value before local signing.`,
      );
      const candidates = signing.profiles.filter((p) =>
        permits(
          p.Entitlements["application-identifier"],
          `${signing.teamId}.${id}`,
        ),
      );
      const distribution = (p: Provision) =>
        profile.developmentClient
          ? p.Entitlements["get-task-allow"] === true
          : profile.distribution === "internal"
            ? Boolean(p.ProvisionedDevices?.length || p.ProvisionsAllDevices)
            : !p.ProvisionedDevices &&
              !p.ProvisionsAllDevices &&
              !p.Entitlements["get-task-allow"];
      const selected =
        candidates
          .filter(
            (p) =>
              distribution(p) &&
              new Date(p.ExpirationDate).getTime() > Date.now(),
          )
          .sort(
            (a, b) =>
              new Date(b.ExpirationDate).getTime() -
              new Date(a.ExpirationDate).getTime(),
          )[0] ?? candidates[0];
      invariant(
        selected,
        "TARGET_PROFILE",
        `No provisioning profile matches target ${id}. Import profiles for every app/extension target.`,
      );
      let entitlements: Record<string, any> = {};
      if (settings.CODE_SIGN_ENTITLEMENTS) {
        const entPath = String(settings.CODE_SIGN_ENTITLEMENTS)
          .replace(/^"|"$/g, "")
          .replace(/\$\(SRCROOT\)/g, iosRoot);
        invariant(
          !entPath.includes("$("),
          "ENTITLEMENT_PATH",
          `Resolve the entitlements path for target ${id}.`,
        );
        const file = entPath.startsWith("/") ? entPath : join(iosRoot, entPath);
        entitlements = plist.parse(await readFile(file, "utf8")) as Record<
          string,
          any
        >;
        const resolved = signingEnvironments(entitlements, selected);
        if (JSON.stringify(resolved) !== JSON.stringify(entitlements)) {
          await writeFile(file, plist.build(resolved));
          log?.(
            `Resolved push/iCloud signing environments from the selected profile for ${id} in the build snapshot.`,
          );
          entitlements = resolved;
        }
      }
      validateProvision(
        selected,
        id,
        signing.teamId,
        expandSigningEntitlements(entitlements, selected, id, signing.teamId),
        profile.developmentClient ? "development" : profile.distribution,
      );
      settings.CODE_SIGN_STYLE = "Manual";
      settings.DEVELOPMENT_TEAM = signing.teamId;
      settings.CODE_SIGN_IDENTITY = `"${signing.identity}"`;
      settings.PROVISIONING_PROFILE_SPECIFIER = `"${selected.UUID}"`;
      selectedProfiles[id] = selected.UUID;
      mapped++;
    }
  }
  invariant(mapped, "SIGNING_TARGETS", "No signable Xcode targets were found.");
  await writeFile(
    join(iosRoot, projectName, "project.pbxproj"),
    project.writeSync(),
  );
  return selectedProfiles;
}
export async function createDistributionCertificate(
  credential: AppleCredential,
  label: string,
  root: string,
): Promise<Extract<Credential, { kind: "ios" }>> {
  const key = join(root, "private.key"),
    csr = join(root, "request.csr"),
    cert = join(root, "certificate.pem"),
    p12 = join(root, "certificate.p12");
  await run("openssl", [
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    csr,
    "-subj",
    "/CN=Local Build Desk",
  ]);
  const api = new AppleAPI(credential);
  const result = await api.request("/certificates", "POST", {
    data: {
      type: "certificates",
      attributes: {
        certificateType: "DISTRIBUTION",
        csrContent: await readFile(csr, "utf8"),
      },
    },
  });
  const base64 = result.data.attributes.certificateContent;
  await writeFile(
    cert,
    `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`,
    { mode: 0o600 },
  );
  const password = randomBytes(24).toString("hex");
  await run(
    "openssl",
    [
      "pkcs12",
      "-export",
      "-inkey",
      key,
      "-in",
      cert,
      "-out",
      p12,
      "-passout",
      "stdin",
    ],
    { input: password + "\n" },
  );
  return {
    kind: "ios",
    label,
    p12: (await readFile(p12)).toString("base64"),
    password,
    profiles: [],
  };
}
export async function certificateId(
  api: AppleAPI,
  credential: Extract<Credential, { kind: "ios" }>,
  root: string,
  requireDistribution = false,
) {
  const path = await secretFile(
    root,
    "existing.p12",
    Buffer.from(credential.p12, "base64"),
  );
  const result = await readPKCS12(
    ["-in", path, "-clcerts", "-nokeys"],
    credential.password,
  );
  const cert = result.stdout.match(
    /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/,
  )?.[1];
  invariant(
    cert,
    "P12_CERTIFICATE",
    "Could not extract the signing certificate.",
  );
  const local = Buffer.from(cert.replace(/\s/g, ""), "base64");
  const certificate = new X509Certificate(local);
  invariant(
    new Date(certificate.validTo).getTime() > Date.now() + 86400000,
    "CERT_EXPIRED",
    "The signing certificate has expired or expires within a day. Create a replacement certificate.",
  );
  const privateResult = await readPKCS12(
    ["-in", path, "-nocerts", "-nodes"],
    credential.password,
  );
  const key = createPrivateKey(privateResult.stdout);
  invariant(
    createPublicKey(key)
      .export({ type: "spki", format: "der" })
      .equals(certificate.publicKey.export({ type: "spki", format: "der" })),
    "P12_PRIVATE_KEY",
    "The certificate and private key in the .p12 do not match.",
  );
  const list = (await api.request("/certificates?limit=200")).data;
  const match = list.find((c: any) =>
    Buffer.from(c.attributes.certificateContent, "base64").equals(local),
  );
  invariant(
    match,
    "CERT_NOT_IN_TEAM",
    "The certificate is not present in this Apple team. Import the matching team credential.",
  );
  invariant(
    !requireDistribution ||
      ["DISTRIBUTION", "IOS_DISTRIBUTION"].includes(
        match.attributes.certificateType,
      ),
    "DISTRIBUTION_CERT_REQUIRED",
    "Select an Apple Distribution certificate for App Store builds.",
  );
  return match.id as string;
}
