import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { run, type CommandOptions } from "./process";
import { invariant, messageOf } from "./errors";
import type {
  AndroidDestination,
  CaptureStep,
  ScreenshotPlan,
} from "./release-check-schema";

/** One element from a `uiautomator dump`. */
export interface AndroidNode {
  resourceId: string;
  text: string;
  desc: string;
  hint: string;
  className: string;
  bounds: [number, number, number, number];
}

const unescapeXML = (value: string) =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
const escapeXML = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function parseHierarchy(xml: string): AndroidNode[] {
  const nodes: AndroidNode[] = [];
  for (const match of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs = new Map<string, string>();
    for (const a of match[1]!.matchAll(/([\w-]+)="([^"]*)"/g))
      attrs.set(a[1]!, unescapeXML(a[2]!));
    const b = attrs.get("bounds")?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    nodes.push({
      resourceId: attrs.get("resource-id") ?? "",
      text: attrs.get("text") ?? "",
      desc: attrs.get("content-desc") ?? "",
      hint: attrs.get("hint") ?? "",
      className: attrs.get("class") ?? "",
      bounds: [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])],
    });
  }
  return nodes;
}

const visible = (n: AndroidNode) =>
  n.bounds[2] > n.bounds[0] && n.bounds[3] > n.bounds[1];
const editable = (n: AndroidNode) => /EditText|AutoComplete/.test(n.className);

/** A label may start or end with "*": "Paycheck*" begins with, "*Rent*"
 * contains, as on iOS. */
export function labelMatcher(label: string): (value: string) => boolean {
  const starts = label.startsWith("*"),
    ends = label.length > 1 && label.endsWith("*");
  const core = label.slice(starts ? 1 : 0, ends ? -1 : undefined);
  if (starts && ends) return (v) => v.includes(core);
  if (ends) return (v) => v.startsWith(core);
  if (starts) return (v) => v.endsWith(core);
  return (v) => v === label;
}

/** Matches the iOS runner: an identifier is a resource ID (React Native testID,
 * Android view ID) or content description; a label is the visible text,
 * content description or a field's placeholder. */
export function findNode(
  nodes: AndroidNode[],
  target: { identifier?: string; label?: string },
  preferInput = false,
): AndroidNode | undefined {
  const matches = nodes.filter((n) => {
    if (!visible(n)) return false;
    if (target.identifier !== undefined)
      return (
        n.resourceId === target.identifier ||
        n.resourceId.endsWith(":id/" + target.identifier) ||
        n.desc === target.identifier
      );
    if (target.label !== undefined) {
      const match = labelMatcher(target.label);
      return match(n.text) || match(n.desc) || match(n.hint);
    }
    return false;
  });
  return (preferInput && matches.find(editable)) || matches[0];
}

/** Quotes one word for the device's shell. */
export const shellQuote = (value: string) =>
  "'" + value.replace(/'/g, "'\\''") + "'";

/** `input text` treats %s as a space and needs shell metacharacters escaped. */
export function inputText(value: string) {
  invariant(
    /^[\x20-\x7e]*$/.test(value),
    "CAPTURE_TEXT",
    "Android capture text must be plain ASCII; adb cannot type other characters.",
  );
  return value
    .replace(/[\\()<>|;&*~"'`$!#?[\]{}]/g, "\\$&")
    .replace(/ /g, "%s");
}

export function sharedPreferencesXML(values: Record<string, string>) {
  return (
    "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n" +
    Object.entries(values)
      .map(
        ([key, value]) =>
          `    <string name="${escapeXML(key)}">${escapeXML(value)}</string>`,
      )
      .join("\n") +
    "\n</map>\n"
  );
}

const center = (n: AndroidNode): [number, number] => [
  Math.round((n.bounds[0] + n.bounds[2]) / 2),
  Math.round((n.bounds[1] + n.bounds[3]) / 2),
];

/** adb commands against one device. */
export class AndroidDevice {
  constructor(
    readonly adb: string,
    readonly serial: string,
    private readonly options: CommandOptions,
  ) {}
  async shell(command: string, allowFailure = false) {
    const result = await run(this.adb, ["-s", this.serial, "shell", command], {
      ...this.options,
      log: undefined,
      allowFailure: true,
      timeout: 120000,
    });
    invariant(
      allowFailure || result.code === 0,
      "ADB",
      `adb shell failed: ${command.split(" ")[0]} ${result.stderr.trim() || result.stdout.trim()}`.trim(),
    );
    return result.stdout;
  }
  async adbCommand(...args: string[]) {
    const result = await run(this.adb, ["-s", this.serial, ...args], {
      ...this.options,
      log: undefined,
      allowFailure: true,
      timeout: 300000,
    });
    invariant(
      result.code === 0,
      "ADB",
      `adb ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
    return result.stdout;
  }
  /** The current UI, or undefined when the screen never settles (a game
   * that redraws every frame keeps uiautomator from finding an idle moment). */
  async hierarchy(): Promise<AndroidNode[] | undefined> {
    const out = await this.shell(
      "rm -f /sdcard/local-build-desk.xml; uiautomator dump /sdcard/local-build-desk.xml >/dev/null 2>&1 && cat /sdcard/local-build-desk.xml",
      true,
    );
    return out.includes("<hierarchy") ? parseHierarchy(out) : undefined;
  }
  async screenSize(): Promise<[number, number]> {
    const out = await this.shell("wm size");
    const size = (out.match(/Override size: (\d+)x(\d+)/) ??
      out.match(/Physical size: (\d+)x(\d+)/))!;
    invariant(size, "ADB", "Could not read the emulator's screen size.");
    return [Number(size[1]), Number(size[2])];
  }
  async screenshot(path: string) {
    await this.shell("screencap -p /sdcard/local-build-desk.png");
    await this.adbCommand("pull", "/sdcard/local-build-desk.png", path);
  }
  /** SystemUI demo mode: 9:41, full battery and Wi-Fi, no notifications.
   * Applied just before each screenshot; SystemUI can drop it after boot. */
  async demoStatusBar() {
    await this.shell("settings put global sysui_demo_allowed 1");
    for (const command of [
      "enter",
      "clock -e hhmm 0941",
      "battery -e level 100 -e plugged false",
      "network -e wifi show -e level 4 -e mobile hide",
      "notifications -e visible false",
    ])
      await this.shell(
        `am broadcast -a com.android.systemui.demo -e command ${command}`,
      );
  }
  /** Closes the soft keyboard, which covers fields lower on the screen. Back
   * only hides the keyboard while it is showing, so the app never sees it. */
  async hideKeyboard() {
    const ime = await this.shell(
      "dumpsys input_method | grep -E 'mInputShown|isInputViewShown'",
      true,
    );
    if (!/(mInputShown|isInputViewShown)=true/.test(ime)) return false;
    await this.shell("input keyevent 4");
    return true;
  }
  async foreground(pkg: string) {
    const out = await this.shell(
      "dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity'",
      true,
    );
    return out.includes(pkg + "/");
  }
}

export interface AndroidCaptureContext {
  device: AndroidDevice;
  pkg: string;
  /** The launcher activity, as package/class. */
  activity: string;
  debuggable: boolean;
  folder: string;
  log: (line: string) => void;
  signal?: AbortSignal;
}

/** Runs a capture plan's steps on one booted emulator, mirroring the iOS
 * runner, and returns the PNGs in plan order. */
export async function captureAndroid(
  ctx: AndroidCaptureContext,
  plan: ScreenshotPlan,
): Promise<{ name: string; path: string }[]> {
  const { device, pkg } = ctx;
  await mkdir(ctx.folder, { recursive: true });
  const [width, height] = await device.screenSize();
  const shots: { name: string; path: string }[] = [];
  const pause = (seconds: number) =>
    sleep(seconds * 1000, undefined, { signal: ctx.signal });
  const waitFor = async (
    target: { identifier?: string; label?: string },
    timeoutSeconds: number,
    preferInput = false,
  ) => {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let settled = false;
    for (;;) {
      const nodes = await device.hierarchy();
      if (nodes) {
        settled = true;
        const node = findNode(nodes, target, preferInput);
        if (node) return node;
      }
      if (Date.now() > deadline) break;
      await pause(0.5);
    }
    const name = target.identifier ?? target.label;
    throw Object.assign(
      new Error(
        settled
          ? `Missing element: ${name}`
          : `Could not read the screen to find ${name}: it never stops animating. Use an x/y tap instead.`,
      ),
      { code: "CAPTURE_STEP" },
    );
  };
  for (const capture of plan.captures) {
    const fail = async (error: unknown) => {
      await device
        .screenshot(join(ctx.folder, `failure-${capture.name}.png`))
        .catch(() => undefined);
      const xml = await device
        .shell("cat /sdcard/local-build-desk.xml", true)
        .catch(() => "");
      if (xml)
        await writeFile(join(ctx.folder, `failure-${capture.name}.xml`), xml);
      throw Object.assign(
        new Error(`Capture ${capture.name}: ${messageOf(error)}`),
        { code: "SCREENSHOT_FAILURE" },
      );
    };
    try {
      await device.shell(`am force-stop ${pkg}`);
      for (const [file, values] of Object.entries(
        capture.sharedPreferences ?? {},
      )) {
        invariant(
          ctx.debuggable,
          "CAPTURE_PREFERENCES",
          "sharedPreferences needs a debuggable capture build. Set the Android capture task to a debug variant, such as :app:assembleDebug.",
        );
        const local = join(ctx.folder, `${file}.xml`);
        await writeFile(local, sharedPreferencesXML(values));
        await device.adbCommand("push", local, "/data/local/tmp/lbd-prefs.xml");
        await device.shell(
          `run-as ${pkg} sh -c ${shellQuote(`mkdir -p shared_prefs && cp /data/local/tmp/lbd-prefs.xml shared_prefs/${file}.xml`)}`,
        );
      }
      const extras = [
        ...Object.entries(capture.launchEnvironment).flatMap(([k, v]) => [
          "--es",
          shellQuote(k),
          shellQuote(v),
        ]),
        ...(capture.launchArguments.length
          ? [
              "--esa",
              "launchArguments",
              shellQuote(
                capture.launchArguments
                  .map((a) => a.replace(/,/g, "\\,"))
                  .join(","),
              ),
            ]
          : []),
      ];
      await device.shell(
        `am start -W -n ${shellQuote(ctx.activity)} ${extras.join(" ")}`,
      );
      for (const step of capture.steps) await perform(step);
      if (capture.readyIdentifier)
        await waitFor({ identifier: capture.readyIdentifier }, 20);
      if (capture.delaySeconds) await pause(capture.delaySeconds);
      invariant(
        await device.foreground(pkg),
        "CAPTURE_FOREGROUND",
        "The app is not in the foreground.",
      );
      const path = join(ctx.folder, `store-${capture.name}.png`);
      await device.demoStatusBar();
      await pause(0.5);
      await device.screenshot(path);
      shots.push({ name: capture.name, path });
      ctx.log(`Captured ${capture.name}.`);
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      await fail(error);
    }
  }
  return shots;

  async function perform(step: CaptureStep) {
    const ms = (s: number) => String(Math.round(s * 1000));
    if (step.action === "sleep") return pause(step.seconds);
    if (step.action === "drag") {
      await device.shell(
        `input swipe ${Math.round(step.fromX * width)} ${Math.round(step.fromY * height)} ${Math.round(step.toX * width)} ${Math.round(step.toY * height)} ${ms(step.seconds ?? 0.6)}`,
      );
      return;
    }
    if (step.action === "tap" && step.x !== undefined && step.y !== undefined) {
      await device.shell(
        `input tap ${Math.round(step.x * width)} ${Math.round(step.y * height)}`,
      );
      return;
    }
    const named = step.identifier !== undefined || step.label !== undefined;
    if (step.action.startsWith("swipe")) {
      const [x1, y1, x2, y2] = named
        ? (await waitFor(step as { identifier?: string; label?: string }, 15))
            .bounds
        : [0, 0, width, height];
      const cx = (x1 + x2) / 2,
        cy = (y1 + y2) / 2,
        dx = (x2 - x1) * 0.3,
        dy = (y2 - y1) * 0.3;
      const [fx, fy, tx, ty] =
        step.action === "swipeUp"
          ? [cx, cy + dy, cx, cy - dy]
          : step.action === "swipeDown"
            ? [cx, cy - dy, cx, cy + dy]
            : step.action === "swipeLeft"
              ? [cx + dx, cy, cx - dx, cy]
              : [cx - dx, cy, cx + dx, cy];
      await device.shell(
        `input swipe ${[fx, fy, tx, ty].map(Math.round).join(" ")} 300`,
      );
      return;
    }
    if (
      step.action === "tap" ||
      step.action === "type" ||
      step.action === "wait" ||
      step.action === "assertText"
    ) {
      if (
        (step.action === "tap" || step.action === "type") &&
        (await device.hideKeyboard())
      )
        await pause(0.6);
      const node = await waitFor(
        step,
        step.action === "wait" ? (step.timeoutSeconds ?? 15) : 15,
        step.action === "type",
      );
      if (step.action === "wait") return;
      if (step.action === "assertText") {
        const actual = node.text || node.desc;
        invariant(
          actual === step.text,
          "CAPTURE_ASSERT",
          `Expected "${step.text}", found "${actual}".`,
        );
        return;
      }
      await device.shell(`input tap ${center(node).join(" ")}`);
      if (step.action === "type") {
        await pause(0.3);
        await device.shell(`input text ${shellQuote(inputText(step.text))}`);
      }
    }
  }
}

/** The newest installed Google APIs image for this Mac's architecture. */
export async function defaultSystemImage(sdk: string) {
  const list = (path: string) => readdir(path).catch((): string[] => []);
  const versions = await list(join(sdk, "system-images"));
  const sorted = versions
    .filter((v) => /^android-\d+$/.test(v))
    .sort((a, b) => Number(b.slice(8)) - Number(a.slice(8)));
  const abi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
  for (const version of sorted)
    for (const tag of ["google_apis", "default"])
      if ((await list(join(sdk, "system-images", version, tag))).includes(abi))
        return `system-images;${version};${tag};${abi}`;
  return undefined;
}

/** The first SDK with the emulator, avdmanager and a usable system image.
 * A project may build with an SDK that has no emulator installed. */
export async function emulatorSDK(
  candidates: (string | undefined)[],
  systemImage?: string,
) {
  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );
  for (const sdk of new Set(candidates.filter((v): v is string => !!v))) {
    if (
      !(await exists(join(sdk, "emulator/emulator"))) ||
      !(await exists(join(sdk, "cmdline-tools/latest/bin/avdmanager")))
    )
      continue;
    const image = systemImage
      ? (await exists(join(sdk, ...systemImage.split(";"))))
        ? systemImage
        : undefined
      : await defaultSystemImage(sdk);
    if (image) return { sdk, image };
  }
  return undefined;
}

/** Boots a disposable emulator, stored with the job, for `use`, then deletes
 * it. Existing emulators and devices are left alone. */
export async function withEmulator<T>(
  options: {
    sdks: (string | undefined)[];
    home: string;
    name: string;
    destination: AndroidDestination;
    env: NodeJS.ProcessEnv;
    log: (line: string) => void;
    signal?: AbortSignal;
    appearance: "light" | "dark";
  },
  use: (device: AndroidDevice, image: string) => Promise<T>,
): Promise<T> {
  const { home } = options;
  const found = await emulatorSDK(
    options.sdks,
    options.destination.systemImage,
  );
  invariant(
    found,
    "ANDROID_IMAGE",
    options.destination.systemImage
      ? `${options.destination.systemImage} is not installed with an Android emulator. Install it with sdkmanager.`
      : 'No Android SDK here has the emulator and a system image. Install them with sdkmanager, for example "emulator" and "system-images;android-36;google_apis;arm64-v8a".',
  );
  const { sdk, image } = found;
  const adb = join(sdk, "platform-tools/adb");
  const env = {
    ...options.env,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    ANDROID_AVD_HOME: home,
  };
  const quiet: CommandOptions = {
    env,
    signal: options.signal,
    timeout: 120000,
  };
  await mkdir(home, { recursive: true });
  const avdmanager = join(sdk, "cmdline-tools/latest/bin/avdmanager");
  const created = await run(
    avdmanager,
    [
      "create",
      "avd",
      "-n",
      options.name,
      "-k",
      image,
      "-d",
      options.destination.device,
      "--force",
    ],
    { ...quiet, input: "no\n", allowFailure: true },
  );
  invariant(
    created.code === 0,
    "ANDROID_AVD",
    `Could not create the ${options.destination.device} emulator from ${image}: ${(created.stderr || created.stdout).trim().split("\n").pop()}`,
  );
  const connected = (
    await run(adb, ["devices"], { ...quiet, allowFailure: true })
  ).stdout;
  let port = 5600;
  while (connected.includes(`emulator-${port}\t`) && port < 5680) port += 2;
  const serial = `emulator-${port}`;
  options.log(
    `Starting the ${options.destination.device} emulator (${image.split(";")[1]})…`,
  );
  let emulator: ChildProcess | undefined = spawn(
    join(sdk, "emulator/emulator"),
    [
      "-avd",
      options.name,
      "-port",
      String(port),
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-no-snapshot",
      "-gpu",
      "swiftshader_indirect",
    ],
    { env, stdio: "ignore" },
  );
  let exited = false;
  emulator.on("exit", () => (exited = true));
  const device = new AndroidDevice(adb, serial, quiet);
  try {
    const deadline = Date.now() + 300000;
    for (;;) {
      invariant(
        !exited,
        "EMULATOR_START",
        "The emulator exited while starting.",
      );
      const booted = await run(
        adb,
        ["-s", serial, "shell", "getprop", "sys.boot_completed"],
        { ...quiet, allowFailure: true, timeout: 10000 },
      ).catch(() => undefined);
      if (booted?.stdout.trim() === "1") break;
      invariant(
        Date.now() < deadline,
        "EMULATOR_START",
        "The emulator did not finish booting in 5 minutes.",
      );
      await sleep(2000, undefined, { signal: options.signal });
    }
    for (const setting of [
      "window_animation_scale",
      "transition_animation_scale",
      "animator_duration_scale",
    ])
      await device.shell(`settings put global ${setting} 0`);
    await device.shell(
      `cmd uimode night ${options.appearance === "dark" ? "yes" : "no"}`,
    );
    await device.demoStatusBar();
    return await use(device, image);
  } finally {
    await run(adb, ["-s", serial, "emu", "kill"], {
      ...quiet,
      signal: undefined,
      allowFailure: true,
      timeout: 30000,
    }).catch(() => undefined);
    for (let i = 0; i < 30 && !exited; i++) await sleep(1000);
    if (!exited) emulator.kill("SIGKILL");
    emulator = undefined;
    await rm(join(home, `${options.name}.avd`), {
      recursive: true,
      force: true,
    });
    await rm(join(home, `${options.name}.ini`), { force: true });
  }
}
