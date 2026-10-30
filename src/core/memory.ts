import { setTimeout as sleep } from "node:timers/promises";
import { run } from "./process";
import { invariant } from "./errors";
import { withLock } from "./locks";

const GB = 1024 ** 3;

/** Memory macOS can hand out without swapping: free, inactive, speculative
 * and purgeable pages, as `vm_stat` reports them. */
export function parseAvailableMemory(vmStat: string) {
  if (!/Pages free:/.test(vmStat)) return undefined;
  const page = Number(vmStat.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const pages = (name: string) =>
    Number(vmStat.match(new RegExp(`Pages ${name}:\\s+(\\d+)`))?.[1] ?? 0);
  return (
    (pages("free") +
      pages("inactive") +
      pages("speculative") +
      pages("purgeable")) *
    page
  );
}

export async function availableMemory(): Promise<number | undefined> {
  if (process.platform !== "darwin") return undefined;
  const result = await run("vm_stat", [], {
    allowFailure: true,
    timeout: 10000,
  }).catch(() => undefined);
  return result?.code === 0 ? parseAvailableMemory(result.stdout) : undefined;
}

/** Simulators, emulators and native builds each need several GB. Starting one
 * while memory is short pushes the whole Mac into swap, so wait for another
 * job to finish first, and fail clearly if memory never frees up. */
export async function waitForMemory(
  gigabytes: number,
  what: string,
  log: (line: string) => void,
  signal?: AbortSignal,
  options: {
    waitMs?: number;
    pollMs?: number;
    read?: () => Promise<number | undefined>;
  } = {},
) {
  const read = options.read ?? availableMemory;
  const needed = gigabytes * GB;
  const deadline = Date.now() + (options.waitMs ?? 10 * 60 * 1000);
  let told = false;
  for (;;) {
    const available = await read();
    if (available === undefined || available >= needed) return;
    const shown = (available / GB).toFixed(1);
    invariant(
      Date.now() < deadline,
      "MEMORY_LOW",
      `${what} needs about ${gigabytes} GB of free memory, but only ${shown} GB has been available for 10 minutes. Close other apps, simulators or emulators, then resume.`,
    );
    if (!told)
      log(
        `Waiting for memory: ${what} needs about ${gigabytes} GB free; ${shown} GB is available now…`,
      );
    told = true;
    await sleep(options.pollMs ?? 5000, undefined, { signal });
  }
}

// A process another job just started hasn't claimed its memory yet; the next
// job's admission waits until it has had time to.
let last = { owner: "", at: 0 };
const SETTLE_MS = 45000;

/** Admits one memory-heavy step at a time across this engine's jobs. */
export function admitHeavyStep(
  gigabytes: number,
  what: string,
  ctx: {
    job: { id: string };
    log: (line: string) => void;
    signal?: AbortSignal;
  },
) {
  return withLock("desk-memory-admission", ctx.signal, async () => {
    const settle =
      last.owner !== ctx.job.id ? last.at + SETTLE_MS - Date.now() : 0;
    if (settle > 0) await sleep(settle, undefined, { signal: ctx.signal });
    await waitForMemory(gigabytes, what, ctx.log, ctx.signal);
    last = { owner: ctx.job.id, at: Date.now() };
  });
}
