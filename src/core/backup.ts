import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scrypt as rawScrypt,
  randomUUID,
} from "node:crypto";
import {
  readFile,
  stat,
  writeFile,
  rename,
  rm,
  lstat,
  realpath,
} from "node:fs/promises";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { z } from "zod";
import {
  validationResultSchema,
  checkpointSchema,
} from "./release-check-schema";
import { releaseJournalSchema } from "./release-journal";
import { settingsSchema } from "./settings-schema";
import { Store, appDirectoryKey } from "./database";
import { Vault } from "./vault";
import { invariant } from "./errors";
import type { Project, Job, Artifact, Credential } from "./types";
const maxBytes = 64 * 1024 * 1024;
const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    rawScrypt(
      password,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
const text = z.string().max(4096),
  id = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/);
const base64 = z
  .string()
  .max(Math.ceil(maxBytes * 1.4))
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  .refine(
    (value) =>
      value.length % 4 === 0 &&
      Buffer.from(value, "base64").toString("base64") === value,
  );
const credentialSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("apple"),
      label: text,
      keyId: z.string().regex(/^[A-Za-z0-9]+$/),
      issuerId: z.string().uuid(),
      teamId: z.string().regex(/^[A-Za-z0-9]+$/),
      privateKey: z.string().max(20000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("google"),
      label: text,
      serviceAccount: z
        .object({
          client_email: z.string().email(),
          private_key: z.string().max(20000),
        })
        .passthrough(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ios"),
      label: text,
      p12: base64,
      password: text,
      profiles: z.array(base64).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("android"),
      label: text,
      keystore: base64,
      storePassword: text,
      alias: text,
      keyPassword: text,
    })
    .strict(),
  z
    .object({
      kind: z.literal("environment"),
      label: text,
      values: z
        .record(z.string().max(256), z.string().max(1048576))
        .refine((v) => Object.keys(v).length <= 2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("login"),
      label: text,
      provider: z.enum(["apple", "google"]),
      username: text,
      password: text,
    })
    .strict(),
]);
const projectSchema = z
  .object({
    id,
    type: z.enum(["expo", "capacitor", "native-ios"]).optional(),
    usesCocoaPods: z.boolean().optional(),
    usesXcodeGen: z.boolean().optional(),
    platforms: z.array(z.enum(["ios", "android"])).optional(),
    path: text.refine(isAbsolute),
    name: text,
    bundleId: text.optional(),
    packageName: text.optional(),
    version: text.optional(),
    sdk: text.optional(),
    profiles: z.array(text).max(100),
    createdAt: text,
    settings: settingsSchema,
  })
  .strict();
const submissionSchema = z
  .object({
    state: z.enum([
      "uploading",
      "uploaded",
      "processing",
      "accepted",
      "rejected",
      "uncertain",
      "draft",
    ]),
    destination: text,
    externalId: id.optional(),
    message: z.string().max(1048576).optional(),
    uploadedAt: text.optional(),
    lastCheckedAt: text.optional(),
    rollout: z.boolean().optional(),
    supersededVersionCodes: z
      .array(z.string().regex(/^\d+$/))
      .max(10000)
      .optional(),
    baselineReleases: z
      .array(z.record(z.string(), z.unknown()))
      .max(5000)
      .optional(),
  })
  .strict();
const factsSchema = z
  .object({
    projectType: z.enum(["expo", "capacitor", "native-ios"]).optional(),
    nativeTarget: text.optional(),
    targetEntitlements: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional(),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    sourceCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    configuration: text,
    distribution: text,
    developmentClient: z.boolean(),
    simulator: z.boolean(),
    signing: text.optional(),
    entitlements: z.record(z.string(), z.unknown()).optional(),
    destination: text,
    toolVersions: z.record(z.string(), text).optional(),
  })
  .strict();
const jobSchema = z
  .object({
    id,
    projectId: id,
    projectName: text,
    platform: z.enum(["ios", "android"]),
    profile: text,
    kind: z.enum(["build", "submit", "test"]),
    status: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
      "needs-attention",
    ]),
    stage: z.enum([
      "queued",
      "preflight",
      "snapshot",
      "install",
      "configure",
      "testing",
      "screenshots",
      "signing",
      "compile",
      "export",
      "verify",
      "upload",
      "processing",
      "complete",
    ]),
    createdAt: text,
    autoSubmit: z.boolean(),
    clean: z.boolean(),
    artifactId: id.optional(),
    parentJobId: id.optional(),
    bundleId: text.optional(),
    version: text.optional(),
    buildNumber: text.optional(),
    projectSnapshot: projectSchema.optional(),
    requiresInvocationCredentials: z.boolean().optional(),
    connectionFingerprint: text.optional(),
    requestedBuildNumber: z.number().int().positive().optional(),
    versionReservation: z
      .enum(["reserved", "committed", "released"])
      .optional(),
    stageStartedAt: text.optional(),
    progress: z
      .object({
        kind: z.enum(["upload", "download", "work", "processing"]),
        label: text,
        startedAt: text,
        updatedAt: text,
        completedBytes: z.number().optional(),
        totalBytes: z.number().optional(),
        percent: z.number().optional(),
        detail: text.optional(),
      })
      .strict()
      .optional(),
    toolchain: z
      .object({ developerDirectory: text, xcodeVersion: text, iosSdk: text })
      .strict()
      .optional(),
    startedAt: text.optional(),
    finishedAt: text.optional(),
    error: z.string().max(1048576).optional(),
    fingerprint: text.optional(),
    submission: submissionSchema.optional(),
    storeEligible: z.boolean().optional(),
    facts: factsSchema.optional(),
    restoredFromBackup: z.boolean().optional(),
    validation: validationResultSchema.optional(),
    checkpoints: z.array(checkpointSchema).max(1000).optional(),
    checksMode: z.enum(["all", "tests", "screenshots"]).optional(),
    resumedFrom: id.optional(),
    reuseFingerprint: text.optional(),
    nativeReuseFingerprint: text.optional(),
  })
  .strict();
const artifactSchema = z
  .object({
    id,
    jobId: id,
    platform: z.enum(["ios", "android"]),
    kind: z.enum(["ipa", "aab", "apk", "app", "archive", "dsym"]),
    path: text.refine(isAbsolute),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
    bundleId: text,
    version: text,
    buildNumber: text,
    iosSdk: text.optional(),
  })
  .strict();
const payloadSchema = z
  .object({
    format: z.literal("local-build-desk"),
    version: z.literal(1),
    createdAt: text,
    projects: z.array(projectSchema).max(1000),
    credentials: z
      .array(z.object({ id, value: credentialSchema }).strict())
      .max(2000),
    counters: z
      .array(
        z
          .object({
            identity: text,
            last_used: z.number().int().min(0).max(2100000000),
            authority: z.enum(["local", "eas"]),
          })
          .strict(),
      )
      .max(5000),
    versionClaims: z
      .array(
        z
          .object({
            identity: text,
            number: z.number().int().positive().max(2100000000),
            owner: id,
            state: z.enum(["reserved", "committed"]),
          })
          .strict(),
      )
      .max(200000),
    jobs: z.array(jobSchema).max(100000),
    artifacts: z.array(artifactSchema).max(200000),
    releaseJournals: z.array(releaseJournalSchema).max(10000).optional(),
    notificationsEnabled: z.boolean(),
  })
  .strict();
export type BackupPayload = z.infer<typeof payloadSchema>;
const envelopeSchema = z
  .object({
    format: z.literal("local-build-desk-encrypted"),
    version: z.literal(1),
    kdf: z.literal("scrypt-32768-8-1"),
    salt: base64,
    iv: base64,
    tag: base64,
    ciphertext: base64,
  })
  .strict();
const aad = Buffer.from("local-build-desk-encrypted:1:scrypt-32768-8-1");
export async function encryptBackup(payload: BackupPayload, password: string) {
  invariant(
    password.length >= 12 && password.length <= 1024,
    "BACKUP_PASSWORD",
    "Use a backup passphrase with at least 12 characters.",
  );
  const plaintext = Buffer.from(JSON.stringify(payloadSchema.parse(payload)));
  let key: Buffer | undefined;
  try {
    invariant(
      plaintext.length <= maxBytes,
      "BACKUP_SIZE",
      "Backup metadata exceeds the 64 MB limit.",
    );
    const salt = randomBytes(32),
      iv = randomBytes(12);
    key = await derive(password, salt);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return Buffer.from(
      JSON.stringify({
        format: "local-build-desk-encrypted",
        version: 1,
        kdf: "scrypt-32768-8-1",
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      }),
    );
  } finally {
    key?.fill(0);
    plaintext.fill(0);
  }
}
export async function decryptBackup(
  bytes: Buffer,
  password: string,
): Promise<BackupPayload> {
  invariant(
    bytes.length <= maxBytes * 1.4 && password.length <= 1024,
    "BACKUP_SIZE",
    "Backup file is too large or the passphrase is invalid.",
  );
  const envelope = envelopeSchema.parse(JSON.parse(bytes.toString("utf8")));
  const salt = Buffer.from(envelope.salt, "base64"),
    iv = Buffer.from(envelope.iv, "base64"),
    tag = Buffer.from(envelope.tag, "base64");
  invariant(
    salt.length === 32 && iv.length === 12 && tag.length === 16,
    "BACKUP_FORMAT",
    "Invalid backup encryption parameters.",
  );
  const key = await derive(password, salt);
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    return payloadSchema.parse(JSON.parse(plaintext.toString("utf8")));
  } catch {
    throw new Error(
      "The backup passphrase is incorrect, or the backup is damaged or unsupported. Nothing was restored.",
    );
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}
export async function captureBackup(
  store: Store,
  vault: Vault,
): Promise<BackupPayload> {
  invariant(
    !vault.ephemeral,
    "BACKUP_VAULT",
    "Invocation-only credentials cannot be exported.",
  );
  store.db.exec("BEGIN");
  let projects: Project[],
    jobs: Job[],
    artifacts: Artifact[],
    rows: { id: string; encrypted: Uint8Array }[],
    counters: BackupPayload["counters"];
  let versionClaims: BackupPayload["versionClaims"];
  try {
    projects = store.list<Project>("projects");
    jobs = store.list<Job>("jobs");
    artifacts = store.list<Artifact>("artifacts");
    rows = store.db
      .prepare("SELECT id,encrypted FROM credentials")
      .all() as any;
    const identities = store.db
      .prepare(
        "SELECT identity FROM counters UNION SELECT identity FROM version_claims UNION SELECT identity FROM counter_authority",
      )
      .all() as { identity: string }[];
    counters = identities.map(({ identity }) => ({
      identity,
      last_used: store.counter(identity) ?? 0,
      authority: store.authority(identity),
    }));
    versionClaims = store.db
      .prepare("SELECT identity,number,owner,state FROM version_claims")
      .all() as any;
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  const credentials = [];
  for (const row of rows!)
    credentials.push({
      id: row.id,
      value: await vault.decryptRecord(row.encrypted),
    });
  return payloadSchema.parse({
    format: "local-build-desk",
    version: 1,
    createdAt: new Date().toISOString(),
    projects: projects!,
    credentials,
    counters: counters!,
    versionClaims: versionClaims!,
    jobs: jobs!,
    artifacts: artifacts!,
    releaseJournals: store.preference("release-journals", []),
    notificationsEnabled: store.preference("notificationsEnabled", true),
  });
}
export async function writeBackup(
  path: string,
  payload: BackupPayload,
  password: string,
) {
  invariant(
    path.endsWith(".lbdbackup"),
    "BACKUP_PATH",
    "Choose a .lbdbackup file.",
  );
  const info = await lstat(path).catch(() => undefined);
  invariant(
    !info || (info.isFile() && !info.isSymbolicLink()),
    "BACKUP_PATH",
    "The backup destination must be a regular file.",
  );
  const bytes = await encryptBackup(payload, password),
    temporary = join(dirname(path), ".desk-backup-" + randomUUID());
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
    bytes.fill(0);
  }
}
export async function readBackup(path: string, password: string) {
  const info = await stat(path);
  invariant(
    info.isFile() && info.size <= maxBytes * 1.4,
    "BACKUP_SIZE",
    "Choose a backup file smaller than 90 MB.",
  );
  return decryptBackup(await readFile(path), password);
}
export async function restorePayload(
  store: Store,
  vault: Vault,
  payload: BackupPayload,
  mappings: Record<string, string>,
  assertIdle: () => void,
  resetMachinePaths = true,
) {
  payload = payloadSchema.parse(payload);
  assertIdle();
  const credentialIds = new Map<string, string>(),
    projectIds = new Map<string, string>(),
    prepared = [];
  for (const record of payload.credentials) {
    invariant(
      !credentialIds.has(record.id),
      "BACKUP_IDS",
      "Duplicate credential IDs in backup.",
    );
    const row = await vault.prepareCredential(record.value as Credential);
    credentialIds.set(record.id, row.summary.id);
    prepared.push(row);
  }
  const mapSettings = (settings: Project["settings"], strict = true) => {
    const result = { ...settings };
    for (const key of [
      "appleConnectionId",
      "googleConnectionId",
      "iosSigningId",
      "androidSigningId",
      "envCredentialId",
    ] as const) {
      if (result[key]) {
        invariant(
          !strict || credentialIds.has(result[key]!),
          "BACKUP_CREDENTIAL",
          "Backup references a missing credential.",
        );
        result[key] = credentialIds.get(result[key]!);
      }
    }
    if (resetMachinePaths)
      for (const key of [
        "nodePath",
        "javaHome",
        "androidSdk",
        "xcodePath",
        "pendingXcodePath",
        "buildDirectory",
        "androidSdkLicenseAccepted",
      ] as const)
        delete result[key];
    return result;
  };
  const existing = store.list<Project>("projects"),
    paths = new Set<string>(),
    projects: Project[] = [];
  for (const source of payload.projects) {
    invariant(
      !projectIds.has(source.id),
      "BACKUP_IDS",
      "Duplicate project IDs in backup.",
    );
    const requested = resolve(mappings[source.id] ?? source.path);
    const path = await realpath(requested).catch(() => requested);
    const identity = JSON.stringify([
      path,
      appDirectoryKey(source.settings.appDirectory),
    ]);
    invariant(
      !paths.has(identity),
      "BACKUP_PATH",
      "Two restored projects cannot select the same app directory inside the same source root.",
    );
    paths.add(identity);
    const match = existing.find(
      (p) =>
        p.path === path &&
        appDirectoryKey(p.settings.appDirectory) ===
          appDirectoryKey(source.settings.appDirectory),
    );
    const project = {
      ...source,
      id: match?.id ?? randomUUID(),
      path,
      settings: mapSettings(source.settings),
    };
    projectIds.set(source.id, project.id);
    projects.push(project);
  }
  for (const records of [payload.jobs, payload.artifacts])
    invariant(
      new Set(records.map((record) => record.id)).size === records.length,
      "BACKUP_IDS",
      "Duplicate history IDs in backup.",
    );
  const oldJobs = new Set(store.list<Job>("jobs").map((j) => j.id)),
    oldArtifacts = new Set(store.list<Artifact>("artifacts").map((a) => a.id));
  for (const job of payload.jobs) {
    invariant(
      projectIds.has(job.projectId) || !!job.projectSnapshot,
      "BACKUP_PROJECT",
      "A historical job references a missing project.",
    );
    if (job.projectSnapshot && !job.requiresInvocationCredentials)
      mapSettings(job.projectSnapshot.settings, false);
  }
  assertIdle();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const journals = store.preference<z.infer<typeof releaseJournalSchema>[]>(
      "release-journals",
      [],
    );
    const journalIds = new Set(journals.map((j) => j.id));
    for (const journal of payload.releaseJournals ?? [])
      if (!journalIds.has(journal.id))
        journals.push({
          ...journal,
          projectId: projectIds.get(journal.projectId) ?? journal.projectId,
          state: journal.state === "running" ? "interrupted" : journal.state,
        });
    store.setPreference("release-journals", journals);
    for (const row of prepared) vault.writePrepared(row);
    for (const project of projects) store.putProject(project);
    for (const row of payload.versionClaims)
      store.db
        .prepare(
          "INSERT OR IGNORE INTO version_claims(identity,number,owner,state) VALUES(?,?,?,?)",
        )
        .run(row.identity, row.number, row.owner, row.state);
    for (const row of payload.counters) {
      store.seed(row.identity, row.last_used);
      if (row.authority === "eas") store.setAuthority(row.identity, "eas");
    }
    for (const record of payload.jobs) {
      if (oldJobs.has(record.id)) continue;
      const job = {
        ...record,
        restoredFromBackup: true,
        projectId: projectIds.get(record.projectId) ?? record.projectId,
      } as Job;
      if (job.projectSnapshot) {
        job.projectSnapshot = {
          ...job.projectSnapshot,
          path:
            projects.find((p) => p.id === job.projectId)?.path ??
            job.projectSnapshot.path,
          settings: job.requiresInvocationCredentials
            ? job.projectSnapshot.settings
            : mapSettings(job.projectSnapshot.settings, false),
        };
      }
      if (["running", "queued"].includes(job.status)) {
        job.status = "interrupted";
        job.error =
          "Restored from a backup; retry locally after checking project paths and credentials.";
      }
      if (job.validation?.state === "running") {
        job.validation.state = "interrupted";
        job.validation.finishedAt = new Date().toISOString();
      }
      for (const point of job.checkpoints ?? [])
        if (point.state === "running") {
          point.state = "interrupted";
          point.finishedAt = new Date().toISOString();
        }
      if (job.submission?.state === "uploading") {
        job.submission.state = "uncertain";
        job.status = "needs-attention";
      }
      store.putJob(job);
      store.setPreference(
        "notification:" + job.id,
        job.submission?.state === "processing"
          ? "processing"
          : job.submission?.state === "accepted"
            ? "accepted"
            : job.submission?.state === "draft"
              ? "draft"
              : ["failed", "interrupted"].includes(job.status)
                ? job.status
                : job.status === "needs-attention"
                  ? "attention"
                  : "built",
      );
    }
    for (const artifact of payload.artifacts)
      if (!oldArtifacts.has(artifact.id)) store.putArtifact(artifact);
    store.setPreference("notificationsEnabled", payload.notificationsEnabled);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return {
    projects: projects.length,
    credentials: prepared.length,
    jobs: payload.jobs.length,
  };
}
