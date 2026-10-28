import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withLock } from "../src/core/locks";
import { leaseProfile } from "../src/core/profile-leases";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/core/database";
it("reuses released pre-upload leases, keeps committed versions, and rejects collisions across connections", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-counter-"));
  const a = new Store(root),
    b = new Store(root);
  try {
    a.seed("ios:app", 72);
    expect(a.claimNumber("ios:app", "job-a")).toBe("73");
    expect(b.claimNumber("ios:app", "job-b")).toBe("74");
    expect(a.counter("ios:app")).toBe(72);
    expect(a.highWater("ios:app")).toBe(74);
    expect(() => b.claimNumber("ios:app", "collision", undefined, 73)).toThrow(
      /reserved/,
    );
    expect(a.releaseNumber("job-a")).toBe(true);
    expect(b.claimNumber("ios:app", "retry")).toBe("73");
    b.commitNumber("ios:app", "retry", 73);
    b.commitNumber("ios:app", "retry", 73);
    expect(a.releaseNumber("retry")).toBe(false);
    a.releaseNumber("job-b");
    expect(a.claimNumber("ios:app", "new")).toBe("74");
    expect(b.claimNumber("android:new", "explicit", undefined, 8)).toBe("8");
    b.commitNumber("android:new", "explicit", 8);
    expect(a.counter("android:new")).toBe(8);
    expect(() => a.commitNumber("ios:app", "stale", 72)).toThrow(
      /higher or equal/,
    );
  } finally {
    b.close();
    a.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("cancels a queued cache waiter without letting the next build bypass the running owner", async () => {
  let finish!: () => void;
  const events: string[] = [];
  const first = withLock("cache-test", undefined, async () => {
    events.push("first");
    await new Promise<void>((resolve) => (finish = resolve));
    events.push("first-end");
  });
  await Promise.resolve();
  const abort = new AbortController();
  const cancelled = withLock("cache-test", abort.signal, async () =>
    events.push("cancelled-ran"),
  );
  const third = withLock("cache-test", undefined, async () =>
    events.push("third"),
  );
  abort.abort();
  await expect(cancelled).rejects.toThrow(/cancelled/);
  expect(events).toEqual(["first"]);
  finish();
  await Promise.all([first, third]);
  expect(events).toEqual(["first", "first-end", "third"]);
});
it("retains shared profiles until all jobs release and preserves pre-existing profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-profile-")),
    path = join(root, "profile");
  const content = Buffer.from("signed-profile");
  try {
    const a = await leaseProfile(path, content),
      b = await leaseProfile(path, content);
    await expect(leaseProfile(path, Buffer.from("different"))).rejects.toThrow(
      /different/,
    );
    await a();
    expect(await readFile(path)).toEqual(content);
    await b();
    await expect(readFile(path)).rejects.toThrow();
    await writeFile(path, content);
    const c = await leaseProfile(path, content);
    await c();
    expect(await readFile(path)).toEqual(content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("checkpoints the database so supported read-only inspection works after clean shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-readonly-"));
  const store = new Store(root);
  store.seed("ios:app", 72);
  store.close();
  const readonly = new DatabaseSync(join(root, "desk.sqlite"), {
    readOnly: true,
  });
  try {
    expect(
      readonly
        .prepare("SELECT last_used FROM counters WHERE identity=?")
        .get("ios:app")?.last_used,
    ).toBe(72);
  } finally {
    readonly.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("releases interrupted pre-upload claims while retaining uncertain uploaded numbers", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-recovery-"));
  const store = new Store(root);
  try {
    store.seed("ios:app", 72);
    store.claimNumber("ios:app", "native");
    store.putJob({
      id: "native",
      status: "running",
      kind: "build",
      versionReservation: "reserved",
    } as any);
    store.claimNumber("android:app", "upload", 0);
    store.commitNumber("android:app", "upload", 1);
    store.putJob({
      id: "upload",
      status: "running",
      kind: "build",
      versionReservation: "committed",
      submission: { state: "uploading" },
    } as any);
    store.recover();
    expect(store.claimNumber("ios:app", "retry")).toBe("73");
    expect(store.get<any>("jobs", "native").versionReservation).toBe(
      "released",
    );
    expect(store.get<any>("jobs", "upload").submission.state).toBe("uncertain");
    expect(store.counter("android:app")).toBe(1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
