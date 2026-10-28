import { DeskError } from "./errors";
const tails = new Map<string, Promise<void>>();
export async function withLock<T>(
  key: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal?.aborted)
    throw new DeskError(
      "CANCELLED",
      "Operation cancelled while waiting for shared build resources.",
    );
  let acquired = false;
  const previous = tails.get(key) ?? Promise.resolve();
  const running = previous.then(() => {
    if (signal?.aborted)
      throw new DeskError(
        "CANCELLED",
        "Operation cancelled while waiting for shared build resources.",
      );
    acquired = true;
    return operation();
  });
  const settled = running.then(
    () => {},
    () => {},
  );
  tails.set(key, settled);
  void settled.finally(() => {
    if (tails.get(key) === settled) tails.delete(key);
  });
  if (!signal) return running;
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      if (!acquired)
        reject(
          new DeskError(
            "CANCELLED",
            "Operation cancelled while waiting for shared build resources.",
          ),
        );
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([running, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
