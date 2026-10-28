import { createReadStream } from "node:fs";
// Pull only when fetch can consume more data. Do not pre-read a whole artifact
// and report 100% before its bytes have been handed to the HTTP transport.
export function uploadStream(
  path: string,
  total: number,
  report: (completed: number) => void,
  signal?: AbortSignal,
) {
  const source = createReadStream(path, { highWaterMark: 256 * 1024, signal });
  source.on("error", () => {});
  const iterator = source[Symbol.asyncIterator]();
  let completed = 0,
    last = 0;
  report(0);
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const item = await iterator.next();
        if (item.done) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(item.value));
        completed += item.value.length;
        if (Date.now() - last >= 200 || completed === total) {
          last = Date.now();
          report(completed);
        }
      },
      cancel() {
        source.destroy();
      },
    },
    { highWaterMark: 0 },
  );
  return { body, dispose: () => source.destroy() };
}
