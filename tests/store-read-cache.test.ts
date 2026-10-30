import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  mkdtemp,
  rm,
  readdir,
  readFile,
  writeFile,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StoreReadCache } from "../src/core/store-read-cache";
let root: string, clock: number, cache: StoreReadCache;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desk-store-cache-"));
  clock = Date.now();
  cache = new StoreReadCache(root, () => clock);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
it("deduplicates concurrent provider reads and persists private, independently cloned results across restarts", async () => {
  const response = deferred<{ checkedAt: string; names: string[] }>(),
    load = vi.fn(() => response.promise),
    policy = { ttl: 1000, retention: 10000, load };
  const first = cache.read("project/apple/list", policy),
    second = cache.read("project/apple/list", policy);
  await expect.poll(() => load.mock.calls.length).toBe(1);
  response.resolve({ checkedAt: "original", names: ["v1"] });
  const [a, b] = await Promise.all([first, second]);
  a.value.names.push("local mutation");
  expect(b.value.names).toEqual(["v1"]);
  const reopened = new StoreReadCache(root, () => clock);
  expect((await reopened.read("project/apple/list", policy)).cache.source).toBe(
    "cache",
  );
  expect(load).toHaveBeenCalledTimes(1);
  const files = await readdir(root);
  expect(files).toHaveLength(1);
  expect((await stat(join(root, files[0]!))).mode & 0o777).toBe(0o600);
});
it("serves stale data immediately during one background refresh without inventing a new checked-at time", async () => {
  await cache.remember("list", { checkedAt: "yesterday", value: 1 }, 10000);
  clock += 1001;
  const next = deferred<{ checkedAt: string; value: number }>(),
    load = vi.fn(() => next.promise),
    policy = { ttl: 1000, retention: 10000, load };
  const a = await cache.read("list", policy),
    b = await cache.read("list", policy);
  expect(a.value.checkedAt).toBe("yesterday");
  expect(a.cache).toMatchObject({
    source: "cache",
    stale: true,
    refreshing: true,
  });
  expect(b.value.value).toBe(1);
  expect(load).toHaveBeenCalledTimes(1);
  next.resolve({ checkedAt: "today", value: 2 });
  await expect
    .poll(async () => (await cache.read("list", policy)).value.value)
    .toBe(2);
});
it("retains data after network errors, backs off background retries, and lets explicit refresh bypass the backoff", async () => {
  await cache.remember("list", { checkedAt: "original" }, 100000);
  clock += 1001;
  const load = vi.fn(async (): Promise<{ checkedAt: string }> => {
      throw Error("Apple 500");
    }),
    policy = { ttl: 1000, retention: 100000, load };
  await cache.read("list", policy);
  await expect
    .poll(async () => (await cache.read("list", policy)).cache.refreshing)
    .toBe(false);
  const stale = await cache.read("list", policy);
  expect(stale.cache.refreshError).toBe("Apple 500");
  expect(stale.value.checkedAt).toBe("original");
  expect(load).toHaveBeenCalledTimes(1);
  await cache.read("list", { ...policy, force: true });
  expect(load).toHaveBeenCalledTimes(2);
});
it("invalidates by revision and isolates account identities without discarding the last saved value", async () => {
  const load = vi.fn(async () => ({ value: 1 }));
  await cache.read("account-a", {
    ttl: 10000,
    retention: 100000,
    version: "before-upload",
    load,
  });
  const next = deferred<{ value: number }>();
  const stale = await cache.read("account-a", {
    ttl: 10000,
    retention: 100000,
    version: "after-upload",
    load: () => next.promise,
  });
  expect(stale.cache.stale).toBe(true);
  expect(stale.value.value).toBe(1);
  const other = await cache.read("account-b", {
    ttl: 10000,
    retention: 100000,
    load: async () => ({ value: 50 }),
  });
  expect(other.value.value).toBe(50);
  next.resolve({ value: 2 });
  await expect
    .poll(
      async () =>
        (await cache.peek<{ value: number }>("account-a"))?.value.value,
    )
    .toBe(2);
});
it("forces a fresh response while ordinary reads reuse a fresh cache, expires retained entries, and tolerates corruption", async () => {
  const load = vi.fn(async () => ({ count: load.mock.calls.length })),
    policy = { ttl: 1000, retention: 10000, load };
  await cache.read("key", policy);
  expect((await cache.read("key", policy)).value.count).toBe(1);
  expect(
    (await cache.read("key", { ...policy, force: true })).value.count,
  ).toBe(2);
  clock += 10001;
  expect((await cache.read("key", policy)).value.count).toBe(3);
  const file = (await readdir(root)).find((f) => f.endsWith(".json"))!;
  await writeFile(join(root, file), "broken");
  expect(
    (await new StoreReadCache(root, () => clock).read("key", policy)).value
      .count,
  ).toBe(4);
});
it("enforces a disk budget and never treats an unwritable cache as a provider failure", async () => {
  const tiny = new StoreReadCache(root, () => clock, 2000);
  for (let i = 0; i < 8; i++)
    await tiny.remember("image" + i, "x".repeat(1000), 100000);
  const files = await readdir(root);
  expect(
    (await Promise.all(files.map((f) => stat(join(root, f))))).reduce(
      (sum, s) => sum + s.size,
      0,
    ),
  ).toBeLessThanOrEqual(2000);
  const bad = join(root, "not-a-directory");
  await writeFile(bad, "file");
  const value = await new StoreReadCache(bad).read("key", {
    ttl: 1000,
    retention: 10000,
    load: async () => ({ ok: true }),
  });
  expect(value.value.ok).toBe(true);
});
