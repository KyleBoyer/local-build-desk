import {
  mkdir,
  writeFile,
  rm,
  mkdtemp,
  readFile,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac, randomBytes } from "node:crypto";
import { Store, id, now } from "./database";
import { invariant } from "./errors";
import type { Credential, CredentialSummary } from "./types";
export interface Encryption {
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}
export class Vault {
  get canFingerprint() {
    return true;
  }
  private fingerprintKey?: Promise<Buffer>;
  async fingerprint(value: string): Promise<string> {
    if (!this.fingerprintKey)
      this.fingerprintKey = (async () => {
        const saved = this.store.preference<string | undefined>(
          "reuseFingerprintKey",
          undefined,
        );
        if (saved)
          return Buffer.from(
            await this.encryption.decrypt(Buffer.from(saved, "base64")),
            "base64",
          );
        const key = randomBytes(32);
        this.store.setPreference(
          "reuseFingerprintKey",
          (await this.encryption.encrypt(key.toString("base64"))).toString(
            "base64",
          ),
        );
        return key;
      })().catch((error) => {
        this.fingerprintKey = undefined;
        throw error;
      });
    return createHmac("sha256", await this.fingerprintKey)
      .update(value)
      .digest("hex");
  }
  readonly ephemeral: boolean = false;
  constructor(
    private store: Store,
    private encryption: Encryption,
  ) {}
  async put(
    credential: Credential,
    existingId?: string,
  ): Promise<CredentialSummary> {
    const prepared = await this.prepareCredential(credential, existingId);
    this.writePrepared(prepared);
    return prepared.summary;
  }
  async prepareCredential(credential: Credential, existingId?: string) {
    const summary: CredentialSummary = {
      id: existingId ?? id(),
      kind: credential.kind,
      label: credential.label,
      createdAt: now(),
      detail:
        credential.kind === "apple"
          ? `Team ${credential.teamId}`
          : credential.kind === "google"
            ? credential.serviceAccount.client_email
            : credential.kind === "android"
              ? `Upload key · ${credential.alias}`
              : credential.kind === "ios"
                ? `${credential.profiles.length} provisioning profile(s)`
                : `${Object.keys(credential.values).length} environment values`,
    };
    const encrypted = await this.encryption.encrypt(JSON.stringify(credential));
    return { summary, encrypted };
  }
  writePrepared({
    summary,
    encrypted,
  }: {
    summary: CredentialSummary;
    encrypted: Buffer;
  }) {
    this.store.db
      .prepare(
        "INSERT INTO credentials(id,summary,encrypted) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary,encrypted=excluded.encrypted",
      )
      .run(summary.id, JSON.stringify(summary), encrypted);
  }
  async decryptRecord(bytes: Uint8Array): Promise<Credential> {
    return JSON.parse(await this.encryption.decrypt(Buffer.from(bytes)));
  }
  async get<T extends Credential["kind"]>(
    id: string | undefined,
    kind?: T,
  ): Promise<Extract<Credential, { kind: T }>> {
    invariant(
      id,
      "CREDENTIAL_REQUIRED",
      (
        {
          ios: "Open Guided setup to create or import an Apple signing certificate and provisioning profile.",
          android:
            "Open Guided setup to create a new Android upload key or import your existing EAS key.",
          apple:
            "Connect your Apple team API key in Guided setup or Connections.",
          google:
            "Connect a Google Play service account in Guided setup or Connections.",
          environment: "Select a build environment in project settings.",
        } as Record<string, string>
      )[kind ?? ""] ?? "Choose a credential in project settings.",
    );
    const row = this.store.db
      .prepare("SELECT encrypted FROM credentials WHERE id=?")
      .get(id) as { encrypted: Uint8Array } | undefined;
    invariant(
      row,
      "CREDENTIAL_MISSING",
      "The selected credential no longer exists.",
    );
    const value = JSON.parse(
      await this.encryption.decrypt(Buffer.from(row.encrypted)),
    );
    invariant(
      !kind || value.kind === kind,
      "CREDENTIAL_TYPE",
      `Expected a ${kind} credential.`,
    );
    return value;
  }
  remove(id: string) {
    this.store.db.prepare("DELETE FROM credentials WHERE id=?").run(id);
  }
}
export async function privateDirectory<T>(
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(
    join(tmpdir(), `local-build-desk-secrets-${process.pid}-`),
  );
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
export async function secretFile(
  root: string,
  name: string,
  content: string | Buffer,
) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, name);
  await writeFile(path, content, { mode: 0o600 });
  return path;
}
export async function importCredential(
  input: Record<string, any>,
): Promise<Credential> {
  const label = String(input.label ?? "").trim();
  invariant(label, "LABEL_REQUIRED", "Give this credential a name.");
  const file = async (key: string) => {
    invariant(
      typeof input[key] === "string" && input[key],
      "FILE_REQUIRED",
      `Select ${key}.`,
    );
    return readFile(input[key]);
  };
  switch (input.kind) {
    case "apple": {
      const privateKey = (await file("keyPath")).toString();
      invariant(
        /-----BEGIN PRIVATE KEY-----/.test(privateKey),
        "INVALID_KEY",
        "Select an Apple .p8 private key.",
      );
      for (const key of ["keyId", "issuerId", "teamId"])
        invariant(
          typeof input[key] === "string" && input[key].trim(),
          "APPLE_FIELD",
          `${key} is required.`,
        );
      return {
        kind: "apple",
        label,
        keyId: input.keyId.trim(),
        issuerId: input.issuerId.trim(),
        teamId: input.teamId.trim(),
        privateKey,
      };
    }
    case "google": {
      const serviceAccount = JSON.parse((await file("keyPath")).toString());
      invariant(
        serviceAccount.type === "service_account" &&
          serviceAccount.private_key &&
          serviceAccount.client_email,
        "GOOGLE_KEY",
        "Choose a Google service-account JSON key.",
      );
      return { kind: "google", label, serviceAccount };
    }
    case "ios": {
      invariant(
        Array.isArray(input.profilePaths),
        "PROFILES_REQUIRED",
        "Select one or more provisioning profiles.",
      );
      return {
        kind: "ios",
        label,
        p12: (await file("p12Path")).toString("base64"),
        password: String(input.password ?? ""),
        profiles: await Promise.all(
          input.profilePaths.map(async (path: string) =>
            (await readFile(path)).toString("base64"),
          ),
        ),
      };
    }
    case "android": {
      invariant(
        input.alias &&
          typeof input.storePassword === "string" &&
          typeof input.keyPassword === "string",
        "ANDROID_FIELDS",
        "Keystore alias and passwords are required.",
      );
      return {
        kind: "android",
        label,
        keystore: (await file("keystorePath")).toString("base64"),
        alias: input.alias,
        storePassword: input.storePassword,
        keyPassword: input.keyPassword,
      };
    }
    case "environment":
      return { kind: "environment", label, values: input.values ?? {} };
    default:
      throw new Error("Unknown credential kind.");
  }
}

export async function cleanupStaleSecrets() {
  for (const name of await readdir(tmpdir())) {
    const pid = name.match(/^local-build-desk-secrets-(\d+)-/)?.[1];
    if (!pid) continue;
    let alive = true;
    try {
      process.kill(Number(pid), 0);
    } catch (error: any) {
      alive = error.code !== "ESRCH";
    }
    if (!alive)
      await rm(join(tmpdir(), name), { recursive: true, force: true });
  }
}
