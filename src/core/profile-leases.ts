import { readFile, writeFile, rm } from "node:fs/promises";
import { withLock } from "./locks";
import { invariant } from "./errors";
const profiles = new Map<
  string,
  { refs: number; created: boolean; content: Buffer }
>();
export async function leaseProfile(path: string, content: Buffer) {
  await withLock(`profile:${path}`, undefined, async () => {
    const active = profiles.get(path);
    if (active) {
      invariant(
        active.content.equals(content),
        "PROFILE_CONFLICT",
        `A different profile is already active at ${path}.`,
      );
      active.refs++;
      return;
    }
    let created = false;
    try {
      await writeFile(path, content, { mode: 0o600, flag: "wx" });
      created = true;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      invariant(
        (await readFile(path)).equals(content),
        "PROFILE_CONFLICT",
        `A different profile already exists at ${path}. Resolve it in Xcode first.`,
      );
    }
    profiles.set(path, { refs: 1, created, content });
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await withLock(`profile:${path}`, undefined, async () => {
      const active = profiles.get(path);
      if (!active || --active.refs > 0) return;
      profiles.delete(path);
      if (active.created) {
        const current = await readFile(path).catch(() => undefined);
        if (current?.equals(active.content)) await rm(path, { force: true });
      }
    });
  };
}
