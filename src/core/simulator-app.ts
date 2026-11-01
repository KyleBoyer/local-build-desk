import { setTimeout as sleep } from "node:timers/promises";
import { run, type CommandOptions } from "./process";

type Executor = typeof run;

/** The Simulator GUI. Test runs never need it: `xcodebuild test` on a device
 * booted with simctl stays headless. But a Simulator.app that is already open
 * attaches a window to every device that boots, so disposable test devices,
 * and every tap of a capture plan, show up on screen. */
const SIMULATOR_PROCESS = "Simulator\\.app/Contents/MacOS/Simulator( |$)";

async function simulatorPids(execute: Executor, options: CommandOptions) {
  const found = await execute("/usr/bin/pgrep", ["-f", SIMULATOR_PROCESS], {
    ...options,
    log: undefined,
    allowFailure: true,
    timeout: 10000,
  }).catch(() => undefined);
  return (found?.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));
}

/** Booted devices in the default set, other than `ignore`. A device in any
 * other state has no window worth keeping; an unreadable list counts as busy. */
async function bootedDevices(
  execute: Executor,
  options: CommandOptions,
  ignore: ReadonlySet<string>,
) {
  const listed = await execute(
    "xcrun",
    ["simctl", "list", "devices", "booted", "--json"],
    { ...options, log: undefined, allowFailure: true, timeout: 20000 },
  ).catch(() => undefined);
  if (!listed || listed.code) return undefined;
  try {
    const devices = JSON.parse(listed.stdout).devices ?? {};
    return Object.values(devices)
      .flat()
      .filter(
        (device: any) =>
          device?.state === "Booted" && !ignore.has(String(device.udid)),
      ).length;
  } catch {
    return undefined;
  }
}

/** Quits Simulator.app only while no device is booted, so nobody loses a
 * window they are using; detaching from an idle app loses nothing. */
async function quitIfIdle(
  execute: Executor,
  options: CommandOptions,
  ignore: ReadonlySet<string> = new Set(),
) {
  const pids = await simulatorPids(execute, options);
  if (!pids.length) return "closed" as const;
  if ((await bootedDevices(execute, options, ignore)) !== 0)
    return "busy" as const;
  await execute("/bin/kill", ["-TERM", ...pids], {
    ...options,
    log: undefined,
    allowFailure: true,
    timeout: 10000,
  }).catch(() => undefined);
  for (let i = 0; i < 20; i++) {
    if (!(await simulatorPids(execute, options)).length) return "quit" as const;
    await sleep(250);
  }
  return "busy" as const;
}

/** Keeps simulator test and capture runs in the background. An idle
 * Simulator.app is closed before the first device boots; one with the user's
 * devices is left alone and reported. Afterwards a Simulator.app with no booted
 * devices left is closed unless the user already had it open with devices. */
export async function withHeadlessSimulator<T>(
  options: CommandOptions,
  log: (line: string) => void,
  use: (owned: Set<string>) => Promise<T>,
  execute: Executor = run,
) {
  const quiet = { ...options, signal: undefined };
  const before = await quitIfIdle(execute, quiet);
  if (before === "quit")
    log(
      "Closed the idle Simulator app so test devices stay in the background.",
    );
  else if (before === "busy")
    log(
      "Simulator is open with booted devices, so the test device will appear in its window. Quit Simulator before running checks to keep them in the background.",
    );
  // Devices this run boots: they are shut down before the final check, but a
  // late shutdown must not keep the app open.
  const owned = new Set<string>();
  try {
    return await use(owned);
  } finally {
    if (before !== "busy") await quitIfIdle(execute, quiet, owned);
  }
}
