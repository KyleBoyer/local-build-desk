import { it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureAndroid,
  findNode,
  inputText,
  parseHierarchy,
  sharedPreferencesXML,
  shellQuote,
  type AndroidDevice,
} from "../src/core/android-capture";
import { screenshotPlanSchema } from "../src/core/release-check-schema";

const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" bounds="[0,0][1080,2400]">
<node index="0" text="Name" resource-id="" class="android.widget.TextView" content-desc="" hint="" bounds="[40,200][300,260]"/>
<node index="1" text="" resource-id="com.example:id/bill-name" class="android.widget.EditText" content-desc="" hint="Name" bounds="[40,270][1040,370]"/>
<node index="2" text="Save &amp; close" resource-id="" class="android.widget.Button" content-desc="" hint="" bounds="[700,2200][1040,2300]"/>
<node index="3" text="" resource-id="" class="android.view.View" content-desc="Open menu" hint="" bounds="[0,0][0,0]"/>
<node index="4" text="" resource-id="add-bill" class="android.view.ViewGroup" content-desc="Add bill" hint="" bounds="[900,100][1040,200]"/>
</node></hierarchy>`;

it("parses a uiautomator dump and finds elements like the iOS runner", () => {
  const nodes = parseHierarchy(xml);
  expect(nodes).toHaveLength(6);
  expect(findNode(nodes, { label: "Save & close" })?.bounds).toEqual([
    700, 2200, 1040, 2300,
  ]);
  // A label matches the header first, but typing prefers the field.
  expect(findNode(nodes, { label: "Name" })?.className).toMatch(/TextView/);
  expect(findNode(nodes, { label: "Name" }, true)?.resourceId).toBe(
    "com.example:id/bill-name",
  );
  // React Native testIDs and Android view IDs both match an identifier.
  expect(findNode(nodes, { identifier: "bill-name" })).toBeDefined();
  expect(findNode(nodes, { identifier: "add-bill" })?.desc).toBe("Add bill");
  // "*" matches the start or end of merged row labels, as on iOS.
  expect(findNode(nodes, { label: "Save*" })?.text).toBe("Save & close");
  expect(findNode(nodes, { label: "*& clo*" })?.text).toBe("Save & close");
  expect(findNode(nodes, { label: "*close" })?.text).toBe("Save & close");
  expect(findNode(nodes, { label: "Save" })).toBeUndefined();
  // Zero-size elements are not tappable.
  expect(findNode(nodes, { label: "Open menu" })).toBeUndefined();
});

it("escapes text for adb input and the device shell", () => {
  expect(inputText("Rent & utilities $1,200 (May)")).toBe(
    "Rent%s\\&%sutilities%s\\$1,200%s\\(May\\)",
  );
  expect(() => inputText("Café")).toThrow(/plain ASCII/);
  expect(shellQuote("it's")).toBe("'it'\\''s'");
  expect(
    sharedPreferencesXML({ "progress.v1": '{"unlocked":true,"a":"<b>"}' }),
  ).toContain(
    '<string name="progress.v1">{&quot;unlocked&quot;:true,&quot;a&quot;:&quot;&lt;b&gt;&quot;}</string>',
  );
});

class FakeDevice {
  commands: string[] = [];
  pulled: string[] = [];
  constructor(private screens: string[]) {}
  async shell(command: string) {
    this.commands.push(command);
    if (command.startsWith("uiautomator dump"))
      return this.screens.length > 1 ? this.screens.shift()! : this.screens[0]!;
    if (command.startsWith("dumpsys activity"))
      return "topResumedActivity=com.example/.Main";
    if (command === "wm size") return "Physical size: 1080x2400";
    if (command.startsWith("cat ")) return "";
    return "";
  }
  async adbCommand(...args: string[]) {
    this.commands.push("adb " + args.join(" "));
    if (args[0] === "pull") {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(args[2]!, Buffer.from([137, 80, 78, 71]));
      this.pulled.push(args[2]!);
    }
    return "";
  }
  async screenSize(): Promise<[number, number]> {
    return [1080, 2400];
  }
  async screenshot(path: string) {
    await this.shell("screencap -p /sdcard/local-build-desk.png");
    await this.adbCommand("pull", "/sdcard/local-build-desk.png", path);
  }
  async foreground() {
    return true;
  }
  async hideKeyboard() {
    return false;
  }
  async demoStatusBar() {
    this.commands.push("demo status bar");
  }
  async hierarchy() {
    const out = await this.shell(
      "uiautomator dump /sdcard/local-build-desk.xml",
    );
    return out.includes("<hierarchy") ? parseHierarchy(out) : undefined;
  }
}

it("runs a plan's steps over adb and captures each screen", async () => {
  const folder = await mkdtemp(join(tmpdir(), "lbd-android-"));
  const device = new FakeDevice([xml]);
  const plan = screenshotPlanSchema.parse({
    captures: [
      {
        name: "bills",
        launchEnvironment: { DEMO: "1" },
        sharedPreferences: { CapacitorStorage: { "progress.v1": "{}" } },
        steps: [
          { action: "tap", identifier: "add-bill" },
          { action: "type", label: "Name", text: "Phone bill" },
          { action: "tap", x: 0.5, y: 0.25 },
          {
            action: "drag",
            fromX: 0.9,
            fromY: 0.6,
            toX: 0.9,
            toY: 0.3,
            seconds: 1,
          },
          { action: "swipeUp" },
          { action: "assertText", label: "Save & close", text: "Save & close" },
        ],
        readyIdentifier: "add-bill",
      },
    ],
  });
  const shots = await captureAndroid(
    {
      device: device as unknown as AndroidDevice,
      pkg: "com.example",
      activity: "com.example/.Main",
      debuggable: true,
      folder,
      log: () => {},
    },
    plan,
  );
  expect(shots).toEqual([
    { name: "bills", path: join(folder, "store-bills.png") },
  ]);
  const commands = device.commands.filter(
    (c) => !c.startsWith("uiautomator") && !c.startsWith("dumpsys"),
  );
  expect(commands).toEqual([
    "am force-stop com.example",
    `adb push ${join(folder, "CapacitorStorage.xml")} /data/local/tmp/lbd-prefs.xml`,
    "run-as com.example sh -c 'mkdir -p shared_prefs && cp /data/local/tmp/lbd-prefs.xml shared_prefs/CapacitorStorage.xml'",
    "am start -W -n 'com.example/.Main' --es 'DEMO' '1'",
    "input tap 970 150",
    "input tap 540 320",
    "input text 'Phone%sbill'",
    "input tap 540 600",
    "input swipe 972 1440 972 720 1000",
    "input swipe 540 1920 540 480 300",
    "demo status bar",
    "screencap -p /sdcard/local-build-desk.png",
    `adb pull /sdcard/local-build-desk.png ${join(folder, "store-bills.png")}`,
  ]);
  expect(
    await readFile(join(folder, "CapacitorStorage.xml"), "utf8"),
  ).toContain('<string name="progress.v1">{}</string>');
});

it("explains a screen that never settles and keeps failure evidence", async () => {
  const folder = await mkdtemp(join(tmpdir(), "lbd-android-fail-"));
  const device = new FakeDevice(["ERROR: could not get idle state."]);
  const plan = screenshotPlanSchema.parse({
    captures: [
      {
        name: "game",
        steps: [{ action: "wait", label: "Start", timeoutSeconds: 1 }],
      },
    ],
  });
  await expect(
    captureAndroid(
      {
        device: device as unknown as AndroidDevice,
        pkg: "com.example",
        activity: "com.example/.Main",
        debuggable: false,
        folder,
        log: () => {},
      },
      plan,
    ),
  ).rejects.toThrow(/Capture game: .*never stops animating\. Use an x\/y tap/);
  expect(device.pulled).toEqual([join(folder, "failure-game.png")]);
});

it("needs a debuggable build to seed SharedPreferences", async () => {
  const device = new FakeDevice([xml]);
  await expect(
    captureAndroid(
      {
        device: device as unknown as AndroidDevice,
        pkg: "com.example",
        activity: "com.example/.Main",
        debuggable: false,
        folder: await mkdtemp(join(tmpdir(), "lbd-android-prefs-")),
        log: () => {},
      },
      screenshotPlanSchema.parse({
        captures: [{ name: "a", sharedPreferences: { P: { k: "v" } } }],
      }),
    ),
  ).rejects.toThrow(/debuggable capture build/);
});
