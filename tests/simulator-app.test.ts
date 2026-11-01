import { it, expect, vi } from "vitest";
import { withHeadlessSimulator } from "../src/core/simulator-app";

const ok = (stdout = "", code = 0) => ({ stdout, stderr: "", code });
const booted = (...udids: string[]) =>
  ok(
    JSON.stringify({
      devices: {
        "iOS-27-2": udids.map((udid) => ({ udid, state: "Booted" })),
      },
    }),
  );

/** A fake Mac: `pids` is the running Simulator.app, `devices` the booted set. */
function mac(state: { pids: string[]; devices: string[] }) {
  return vi.fn(async (command: string, args: string[]) => {
    if (command === "/usr/bin/pgrep")
      return ok(state.pids.join("\n"), state.pids.length ? 0 : 1);
    if (command === "/bin/kill") {
      state.pids = [];
      return ok();
    }
    if (args[0] === "simctl" && args[1] === "list")
      return booted(...state.devices);
    return ok();
  });
}
const kills = (execute: ReturnType<typeof mac>) =>
  execute.mock.calls.filter(([command]) => command === "/bin/kill");

it("closes an idle Simulator before booting and leaves nothing open", async () => {
  const state = { pids: ["42"], devices: [] as string[] };
  const execute = mac(state);
  const log = vi.fn();
  await withHeadlessSimulator(
    {},
    log,
    async (owned) => {
      owned.add("A");
      state.devices = ["A"];
      expect(state.pids).toEqual([]);
      // Something reopens the app mid-run; the run's own device does not count.
      state.pids = ["43"];
    },
    execute as any,
  );
  expect(kills(execute).map(([, args]) => args)).toEqual([
    ["-TERM", "42"],
    ["-TERM", "43"],
  ]);
  expect(log).toHaveBeenCalledWith(
    expect.stringMatching(/Closed the idle Simulator/),
  );
});

it("never quits a Simulator showing the user's booted devices", async () => {
  const state = { pids: ["42"], devices: ["USER"] };
  const execute = mac(state);
  const log = vi.fn();
  await withHeadlessSimulator(
    {},
    log,
    async () => {
      state.devices = [];
    },
    execute as any,
  );
  expect(kills(execute)).toEqual([]);
  expect(log).toHaveBeenCalledWith(
    expect.stringMatching(/will appear in its window/),
  );
});

it("treats an unreadable device list as busy", async () => {
  const execute = vi.fn(async (command: string) =>
    command === "/usr/bin/pgrep" ? ok("42") : ok("", 1),
  );
  await withHeadlessSimulator(
    {},
    vi.fn(),
    async () => undefined,
    execute as any,
  );
  expect(execute.mock.calls.some(([command]) => command === "/bin/kill")).toBe(
    false,
  );
});

it("does nothing when Simulator is not running", async () => {
  const execute = mac({ pids: [], devices: [] });
  const log = vi.fn();
  await withHeadlessSimulator({}, log, async () => "done", execute as any);
  expect(kills(execute)).toEqual([]);
  expect(log).not.toHaveBeenCalled();
});

it("still cleans up after a failed run", async () => {
  const state = { pids: [] as string[], devices: [] as string[] };
  const execute = mac(state);
  await expect(
    withHeadlessSimulator(
      {},
      vi.fn(),
      async () => {
        state.pids = ["7"];
        throw new Error("capture failed");
      },
      execute as any,
    ),
  ).rejects.toThrow("capture failed");
  expect(kills(execute).map(([, args]) => args)).toEqual([["-TERM", "7"]]);
});
