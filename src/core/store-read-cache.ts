import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { StoreCacheInfo } from "./store-release-types";
interface Entry<T> {
  key: string;
  value: T;
  fetchedAt: number;
  keepUntil: number;
  version?: string;
}
interface Policy<T> {
  ttl: number | ((value: T) => number);
  retention: number;
  force?: boolean;
  version?: string;
  load: () => Promise<T>;
}
/** Read-only provider data; never used to authorize uploads or release mutations. */
export class StoreReadCache {
  private memory = new Map<string, Entry<unknown>>();
  private pending = new Map<string, Promise<Entry<unknown>>>();
  private failures = new Map<string, { message: string; retryAt: number }>();
  private writes = 0;
  private diskBytes = 0;
  constructor(
    private root: string,
    private clock = () => Date.now(),
    private budget = 128 * 1024 * 1024,
  ) {}
  private file(key: string) {
    return join(
      this.root,
      createHash("sha256").update(key).digest("hex") + ".json",
    );
  }
  async peek<T>(key: string): Promise<Entry<T> | undefined> {
    let entry = this.memory.get(key) as Entry<T> | undefined;
    if (!entry)
      try {
        const file = this.file(key),
          info = await stat(file);
        if (info.size > 20 * 1024 * 1024) return;
        entry = JSON.parse(await readFile(file, "utf8"));
        if (
          entry?.key !== key ||
          !("value" in entry) ||
          !Number.isFinite(entry.fetchedAt) ||
          !Number.isFinite(entry.keepUntil) ||
          entry.keepUntil - entry.fetchedAt > 8 * 86400000
        )
          return;
        this.hot(key, entry, info.size);
      } catch {
        return;
      }
    if (
      !entry ||
      entry.keepUntil <= this.clock() ||
      entry.fetchedAt > this.clock() + 60000
    ) {
      this.memory.delete(key);
      return;
    }
    return structuredClone(entry);
  }
  private hot(key: string, value: Entry<unknown>, size: number) {
    if (size > 1024 * 1024) return;
    this.memory.delete(key);
    this.memory.set(key, value);
    while (this.memory.size > 128)
      this.memory.delete(this.memory.keys().next().value!);
  }
  async remember<T>(
    key: string,
    value: T,
    retention: number,
    version?: string,
  ) {
    const entry: Entry<T> = {
        key,
        value,
        fetchedAt: this.clock(),
        keepUntil: this.clock() + retention,
        version,
      },
      json = JSON.stringify(entry);
    this.hot(key, entry, Buffer.byteLength(json));
    const temp = join(this.root, randomUUID() + ".tmp");
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const previous =
        (await stat(this.file(key)).catch(() => undefined))?.size ?? 0;
      await writeFile(temp, json, { mode: 0o600 });
      await rename(temp, this.file(key));
      this.diskBytes += Buffer.byteLength(json) - previous;
      if (
        ++this.writes % 32 === 1 ||
        this.diskBytes > this.budget ||
        json.length > 1024 * 1024
      )
        await this.prune();
    } catch {
      /* Cache failure must not fail a valid provider response. */
    } finally {
      await unlink(temp).catch(() => {});
    }
    return entry;
  }
  async read<T>(
    key: string,
    policy: Policy<T>,
  ): Promise<{ value: T; cache: StoreCacheInfo }> {
    const pendingKey = JSON.stringify([key, policy.version]);
    const saved = await this.peek<T>(key),
      failure = this.failures.get(pendingKey),
      ttl = saved
        ? typeof policy.ttl === "function"
          ? policy.ttl(saved.value)
          : policy.ttl
        : 0;
    const refresh = () => {
      let pending = this.pending.get(pendingKey) as
        Promise<Entry<T>> | undefined;
      if (!pending) {
        pending = Promise.resolve()
          .then(policy.load)
          .then((value) =>
            this.remember(key, value, policy.retention, policy.version),
          )
          .then((value) => {
            this.failures.delete(pendingKey);
            return value;
          })
          .catch((error) => {
            this.failures.set(pendingKey, {
              message:
                error instanceof Error
                  ? error.message
                  : "Store refresh failed.",
              retryAt: this.clock() + 30000,
            });
            while (this.failures.size > 128)
              this.failures.delete(this.failures.keys().next().value!);
            throw error;
          })
          .finally(() => {
            if (this.pending.get(pendingKey) === pending)
              this.pending.delete(pendingKey);
          });
        this.pending.set(pendingKey, pending);
      }
      return pending;
    };
    if (saved && !policy.force) {
      const stale =
        saved.version !== policy.version ||
        this.clock() - saved.fetchedAt >= ttl;
      if (stale && (!failure || failure.retryAt <= this.clock()))
        void refresh().catch(() => {});
      return {
        value: structuredClone(saved.value),
        cache: {
          source: "cache",
          stale,
          refreshing: this.pending.has(pendingKey),
          refreshError: failure?.message,
        },
      };
    }
    try {
      const value = await refresh();
      return {
        value: structuredClone(value.value),
        cache: { source: "network", stale: false, refreshing: false },
      };
    } catch (error) {
      if (!saved) throw error;
      return {
        value: structuredClone(saved.value),
        cache: {
          source: "cache",
          stale: true,
          refreshing: false,
          refreshError:
            error instanceof Error ? error.message : "Store refresh failed.",
        },
      };
    }
  }
  private async prune() {
    const files = await readdir(this.root).catch(() => []),
      rows = [] as { file: string; size: number; time: number }[];
    for (const name of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = join(this.root, name),
        info = await stat(file).catch(() => undefined);
      if (info) rows.push({ file, size: info.size, time: info.mtimeMs });
    }
    rows.sort((a, b) => b.time - a.time);
    let bytes = 0;
    this.diskBytes = 0;
    for (const [i, row] of rows.entries()) {
      bytes += row.size;
      if (
        bytes > this.budget ||
        i >= 4096 ||
        row.time < this.clock() - 7 * 86400000
      )
        await unlink(row.file).catch(() => {});
      else this.diskBytes += row.size;
    }
  }
}
