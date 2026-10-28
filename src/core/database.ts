import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { invariant } from "./errors";
import type { Project, Job, Artifact, CredentialSummary } from "./types";
export class Store {
  db: DatabaseSync;
  constructor(public root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, "desk.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY,summary TEXT NOT NULL,encrypted BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS counters(identity TEXT PRIMARY KEY,last_used INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS version_claims(identity TEXT NOT NULL,number INTEGER NOT NULL,owner TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(identity,number),UNIQUE(identity,owner));
      CREATE TABLE IF NOT EXISTS counter_authority(identity TEXT PRIMARY KEY,authority TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    for (const summary of this.credentialSummaries().filter(
      (item) => item.kind === "apple" && item.detail.includes(" · "),
    )) {
      summary.detail = summary.detail.split(" · ")[0];
      this.db
        .prepare("UPDATE credentials SET summary=? WHERE id=?")
        .run(JSON.stringify(summary), summary.id);
    }
  }
  list<T>(table: "projects" | "jobs" | "artifacts"): T[] {
    return (
      this.db.prepare(`SELECT data FROM ${table}`).all() as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  get<T>(table: "projects" | "jobs" | "artifacts", id: string): T {
    const row = this.db
      .prepare(`SELECT data FROM ${table} WHERE id=?`)
      .get(id) as { data: string } | undefined;
    invariant(row, "NOT_FOUND", `${table.slice(0, -1)} was not found.`);
    return JSON.parse(row.data);
  }
  putProject(project: Project) {
    this.db
      .prepare(
        "INSERT INTO projects(id,path,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,data=excluded.data",
      )
      .run(project.id, project.path, JSON.stringify(project));
  }
  putJob(job: Job) {
    this.db
      .prepare(
        "INSERT INTO jobs(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(job.id, JSON.stringify(job));
  }
  putArtifact(artifact: Artifact) {
    this.db
      .prepare(
        "INSERT INTO artifacts(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(artifact.id, JSON.stringify(artifact));
  }
  credentialSummaries(): CredentialSummary[] {
    return (
      this.db.prepare("SELECT summary FROM credentials").all() as {
        summary: string;
      }[]
    ).map((r) => JSON.parse(r.summary));
  }
  preference<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value FROM preferences WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : fallback;
  }
  setPreference(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  seed(identity: string, lastUsed: number) {
    invariant(
      Number.isSafeInteger(lastUsed) && lastUsed >= 0 && lastUsed < 2100000000,
      "COUNTER_INVALID",
      "Enter the last used build number as a nonnegative integer below 2,100,000,000.",
    );
    this.db
      .prepare(
        "INSERT INTO counters(identity,last_used) VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET last_used=MAX(last_used,excluded.last_used)",
      )
      .run(identity, lastUsed);
  }
  counter(identity: string): number | undefined {
    return (
      this.db
        .prepare("SELECT last_used FROM counters WHERE identity=?")
        .get(identity) as { last_used: number } | undefined
    )?.last_used;
  }
  highWater(identity: string): number | undefined {
    const floor = this.counter(identity);
    const lease = (
      this.db
        .prepare(
          "SELECT MAX(number) AS value FROM version_claims WHERE identity=?",
        )
        .get(identity) as { value: number | null }
    ).value;
    return floor === undefined && lease === null
      ? undefined
      : Math.max(floor ?? 0, lease ?? 0);
  }
  claimNumber(
    identity: string,
    owner: string,
    initial?: number,
    explicit?: number,
  ): string {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      invariant(
        this.authority(identity) === "local",
        "COUNTER_EAS_AUTHORITY",
        "This identity is handed to EAS. Resume local counter ownership before building.",
      );
      const existing = this.db
        .prepare(
          "SELECT number FROM version_claims WHERE identity=? AND owner=?",
        )
        .get(identity, owner) as { number: number } | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return String(existing.number);
      }
      if (
        this.counter(identity) === undefined &&
        (initial !== undefined || explicit !== undefined)
      )
        this.seed(identity, initial ?? 0);
      const floor = this.counter(identity);
      invariant(
        floor !== undefined,
        "COUNTER_UNSEEDED",
        "Initialize the last used build number, or pass an explicit --build-number for this identity.",
      );
      let available = floor + 1;
      for (const row of this.db
        .prepare(
          "SELECT number FROM version_claims WHERE identity=? AND number>? ORDER BY number",
        )
        .all(identity, floor) as { number: number }[]) {
        if (row.number === available) available++;
        else if (row.number > available) break;
      }
      const next = explicit ?? available;
      invariant(
        Number.isSafeInteger(next) && next > floor && next <= 2100000000,
        "COUNTER_COLLISION",
        `Build ${next} is at or below the committed counter ${floor}, or is invalid.`,
      );
      invariant(
        !this.db
          .prepare(
            "SELECT owner FROM version_claims WHERE identity=? AND number=?",
          )
          .get(identity, next),
        "COUNTER_COLLISION",
        `Build ${next} is already reserved by another job.`,
      );
      this.db
        .prepare(
          "INSERT INTO version_claims(identity,number,owner,state) VALUES(?,?,?,'reserved')",
        )
        .run(identity, next, owner);
      this.db.exec("COMMIT");
      return String(next);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  commitNumber(identity: string, owner: string, number: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      invariant(
        this.authority(identity) === "local",
        "COUNTER_EAS_AUTHORITY",
        "Resume local counter ownership before uploading.",
      );
      const existing = this.db
        .prepare(
          "SELECT owner,state FROM version_claims WHERE identity=? AND number=?",
        )
        .get(identity, number) as { owner: string; state: string } | undefined;
      invariant(
        !existing || existing.owner === owner,
        "COUNTER_COLLISION",
        "This artifact's released build number was reserved by another job. Rebuild it with a new number.",
      );
      if (existing?.state !== "committed") {
        const floor = this.counter(identity) ?? 0;
        invariant(
          number > floor,
          "COUNTER_STALE",
          `A higher or equal build number (${floor}) has already been committed. Rebuild this artifact before uploading.`,
        );
        if (existing)
          this.db
            .prepare(
              "UPDATE version_claims SET state='committed' WHERE identity=? AND number=?",
            )
            .run(identity, number);
        else
          this.db
            .prepare(
              "INSERT INTO version_claims(identity,number,owner,state) VALUES(?,?,?,'committed')",
            )
            .run(identity, number, owner);
        this.seed(identity, number);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  releaseNumber(owner: string) {
    return (
      this.db
        .prepare(
          "DELETE FROM version_claims WHERE owner=? AND state='reserved'",
        )
        .run(owner).changes > 0
    );
  }
  reserve(identity: string, initial?: number, fixed?: number): string {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      invariant(
        this.authority(identity) === "local",
        "COUNTER_EAS_AUTHORITY",
        "This app identity's counter is handed to EAS. Run ios-submit versions --project PATH --resume-local after EAS builds finish before building locally again.",
      );
      let last = this.highWater(identity);
      if (last === undefined && initial !== undefined) {
        this.seed(identity, initial);
        last = initial;
      }
      invariant(
        last !== undefined,
        "COUNTER_UNSEEDED",
        "Local build numbers are not initialized. Enter the last used EAS/store build number in Migration (0 for a new app).",
      );
      const next = fixed ?? last + 1;
      invariant(
        Number.isSafeInteger(next) && next > last && next <= 2100000000,
        "COUNTER_COLLISION",
        `Build ${next} has already been reserved or is invalid. Last reserved: ${last}. Enable autoIncrement or set a higher build number.`,
      );
      this.db
        .prepare("UPDATE counters SET last_used=? WHERE identity=?")
        .run(next, identity);
      this.db.exec("COMMIT");
      return String(next);
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  authority(identity: string): "local" | "eas" {
    return (
      (
        this.db
          .prepare("SELECT authority FROM counter_authority WHERE identity=?")
          .get(identity) as { authority: "local" | "eas" } | undefined
      )?.authority ?? "local"
    );
  }
  setAuthority(identity: string, authority: "local" | "eas") {
    this.db
      .prepare(
        "INSERT INTO counter_authority(identity,authority) VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET authority=excluded.authority",
      )
      .run(identity, authority);
  }
  handoff(identity: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      invariant(
        !this.list<Job>("jobs").some((job) =>
          ["running", "queued"].includes(job.status),
        ),
        "COUNTER_BUSY",
        "Wait for the native build queue to finish before handing counters to EAS.",
      );
      const value = this.highWater(identity);
      invariant(
        value !== undefined,
        "COUNTER_UNSEEDED",
        "Initialize the local counter before handing it to EAS.",
      );
      this.setAuthority(identity, "eas");
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  recover() {
    for (const job of this.list<Job>("jobs"))
      if (
        job.status === "running" ||
        (job.status === "queued" && job.requiresInvocationCredentials)
      ) {
        job.status =
          job.submission &&
          ["uploading", "processing"].includes(job.submission.state)
            ? "needs-attention"
            : "interrupted";
        if (job.submission?.state === "uploading")
          job.submission.state = "uncertain";
        job.error =
          "The app stopped during this operation. Inspect the logs; reconcile store state before retrying an upload.";
        if (this.releaseNumber(job.id)) job.versionReservation = "released";
        this.putJob(job);
      }
  }
  close() {
    // Leave a self-contained DB for read-only tools when this is the last connection.
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
    this.db.close();
  }
}
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
