import { it, expect, vi } from "vitest";
import { parseAvailableMemory, waitForMemory } from "../src/core/memory";

const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   100000.
Pages active:                                 160815.
Pages inactive:                               50000.
Pages speculative:                             20000.
Pages throttled:                                   0.
Pages wired down:                             120000.
Pages purgeable:                               10000.
`;

it("counts free, inactive, speculative and purgeable pages", () => {
  expect(parseAvailableMemory(vmStat)).toBe(180000 * 16384);
  expect(parseAvailableMemory("not vm_stat")).toBeUndefined();
});

it("waits for memory to free up, then proceeds", async () => {
  const readings = [1, 1.5, 5].map((gb) => gb * 1024 ** 3);
  const log = vi.fn();
  await waitForMemory(4, "The emulator", log, undefined, {
    pollMs: 1,
    read: async () => readings.shift(),
  });
  expect(readings).toEqual([]);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0]![0]).toMatch(
    /The emulator needs about 4 GB free; 1\.0 GB is available now/,
  );
});

it("fails clearly when memory never frees up, and skips the check when unknown", async () => {
  await expect(
    waitForMemory(4, "The simulator", () => {}, undefined, {
      waitMs: 5,
      pollMs: 2,
      read: async () => 2 * 1024 ** 3,
    }),
  ).rejects.toThrow(/only 2\.0 GB has been available for 10 minutes/);
  await waitForMemory(64, "Anything", () => {}, undefined, {
    read: async () => undefined,
  });
});
