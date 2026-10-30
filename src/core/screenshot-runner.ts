import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScreenshotPlan } from "./release-check-schema";

/** A disposable UI-test target. It launches only this job's app, already installed
 * on the disposable simulator; no source-project test target is required. */
export async function createScreenshotRunner(
  root: string,
  bundleId: string,
  plan: ScreenshotPlan,
) {
  await mkdir(join(root, "DeskScreenshots.xcodeproj/xcshareddata/xcschemes"), {
    recursive: true,
  });
  await writeFile(
    join(root, "plan.json"),
    JSON.stringify({ ...plan, bundleId }),
  );
  await writeFile(join(root, "Screenshots.swift"), swiftRunner);
  const objects: string[] = [];
  let next = 0;
  const ids = new Map<string, string>();
  const id = (name: string) => {
    if (!ids.has(name)) ids.set(name, (++next).toString(16).padStart(24, "A"));
    return ids.get(name)!;
  };
  const add = (name: string, value: string) => {
    objects.push(`${id(name)} = { ${value} };`);
    return id(name);
  };
  const swift = add(
    "swift",
    'isa=PBXFileReference; lastKnownFileType=sourcecode.swift; path=Screenshots.swift; sourceTree="<group>";',
  );
  const json = add(
    "json",
    'isa=PBXFileReference; lastKnownFileType=text.json; path=plan.json; sourceTree="<group>";',
  );
  const product = add(
    "product",
    "isa=PBXFileReference; explicitFileType=wrapper.cfbundle; path=DeskScreenshots.xctest; sourceTree=BUILT_PRODUCTS_DIR;",
  );
  const swiftBuild = add("swift-build", `isa=PBXBuildFile; fileRef=${swift};`);
  const jsonBuild = add("json-build", `isa=PBXBuildFile; fileRef=${json};`);
  const sources = add(
    "sources",
    `isa=PBXSourcesBuildPhase; buildActionMask=2147483647; files=(${swiftBuild},); runOnlyForDeploymentPostprocessing=0;`,
  );
  const resources = add(
    "resources",
    `isa=PBXResourcesBuildPhase; buildActionMask=2147483647; files=(${jsonBuild},); runOnlyForDeploymentPostprocessing=0;`,
  );
  const frameworks = add(
    "frameworks",
    "isa=PBXFrameworksBuildPhase; buildActionMask=2147483647; files=(); runOnlyForDeploymentPostprocessing=0;",
  );
  for (const target of ["project", "test"]) {
    const configs = ["Debug", "Release"].map((name) =>
      add(
        `${target}-${name}`,
        `isa=XCBuildConfiguration; name=${name}; buildSettings={ SDKROOT=iphonesimulator; IPHONEOS_DEPLOYMENT_TARGET=17.0; SWIFT_VERSION=5.0; CLANG_ENABLE_MODULES=YES; GENERATE_INFOPLIST_FILE=YES; PRODUCT_NAME=DeskScreenshots; PRODUCT_BUNDLE_IDENTIFIER=com.localbuilddesk.screenshots; TARGETED_DEVICE_FAMILY="1,2"; CODE_SIGNING_ALLOWED=NO; SWIFT_OPTIMIZATION_LEVEL="-Onone"; };`,
      ),
    );
    add(
      `${target}-configs`,
      `isa=XCConfigurationList; buildConfigurations=(${configs.join(",")},); defaultConfigurationIsVisible=0; defaultConfigurationName=Debug;`,
    );
  }
  const target = add(
    "target",
    `isa=PBXNativeTarget; name=DeskScreenshots; productName=DeskScreenshots; productReference=${product}; productType="com.apple.product-type.bundle.ui-testing"; buildConfigurationList=${id("test-configs")}; buildPhases=(${sources},${frameworks},${resources},); buildRules=(); dependencies=();`,
  );
  const group = add(
    "group",
    `isa=PBXGroup; children=(${swift},${json},${product},); sourceTree="<group>";`,
  );
  const project = add(
    "project",
    `isa=PBXProject; attributes={ LastUpgradeCheck=2700; TargetAttributes={ ${target}={ CreatedOnToolsVersion=27.0; }; }; }; buildConfigurationList=${id("project-configs")}; compatibilityVersion="Xcode 14.0"; developmentRegion=en; knownRegions=(en,Base,); mainGroup=${group}; projectDirPath=""; projectRoot=""; targets=(${target},);`,
  );
  await writeFile(
    join(root, "DeskScreenshots.xcodeproj/project.pbxproj"),
    `// !$*UTF8*$!\n{ archiveVersion=1; classes={}; objectVersion=56; objects={\n${objects.join("\n")}\n}; rootObject=${project}; }\n`,
  );
  const ref = `<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${target}" BuildableName="DeskScreenshots.xctest" BlueprintName="DeskScreenshots" ReferencedContainer="container:DeskScreenshots.xcodeproj"/>`;
  await writeFile(
    join(
      root,
      "DeskScreenshots.xcodeproj/xcshareddata/xcschemes/DeskScreenshots.xcscheme",
    ),
    `<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="2700" version="1.3"><BuildAction parallelizeBuildables="NO" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">${ref}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">${ref}</TestableReference></Testables></TestAction></Scheme>`,
  );
}

const swiftRunner = String.raw`import XCTest

struct Step: Decodable {
  let action: String; let identifier: String?; let label: String?; let text: String?
  let timeoutSeconds: Double?; let x: Double?; let y: Double?; let seconds: Double?
  let fromX: Double?; let fromY: Double?; let toX: Double?; let toY: Double?
}
struct Capture: Decodable {
  let name: String; let launchArguments: [String]; let launchEnvironment: [String:String]
  let steps: [Step]; let readyIdentifier: String?; let delaySeconds: Double?
  let userDefaults: [String:String]?
}
struct Plan: Decodable { let bundleId: String; let language: String; let locale: String; let captures: [Capture] }

final class DeskScreenshots: XCTestCase {
  func pause(_ seconds: Double) {
    _ = XCTWaiter.wait(for: [XCTestExpectation(description: "pause")], timeout: seconds)
  }
  @MainActor func testCapturePlan() throws {
    continueAfterFailure = false
    let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "plan", withExtension: "json"))
    let plan = try JSONDecoder().decode(Plan.self, from: Data(contentsOf: url))
    for capture in plan.captures {
      let app = XCUIApplication(bundleIdentifier: plan.bundleId)
      // "-key value" arguments override user defaults for this launch. Quoting
      // keeps a JSON value a string rather than a parsed property list.
      let defaults = (capture.userDefaults ?? [:]).sorted { $0.key < $1.key }.flatMap { key, value in
        ["-" + key, "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""]
      }
      app.launchArguments = capture.launchArguments + defaults + ["-AppleLanguages", "(\(plan.language))", "-AppleLocale", plan.locale]
      app.launchEnvironment = capture.launchEnvironment
      app.launch()
      defer { app.terminate() }
      XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30), "App did not enter foreground")
      func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
      }
      // A label may start or end with "*": "Paycheck*" begins with, "*Rent*"
      // contains. Lists often merge a row's texts into one label.
      func pattern(_ label: String) -> NSPredicate {
        let starts = label.hasPrefix("*"), ends = label.hasSuffix("*")
        let core = String(label.dropFirst(starts ? 1 : 0).dropLast(ends && label.count > 1 ? 1 : 0))
        let op = starts && ends ? "CONTAINS" : ends ? "BEGINSWITH" : starts ? "ENDSWITH" : "=="
        return NSPredicate(format: "label \(op) %@ OR placeholderValue \(op) %@", core, core)
      }
      func labelled(_ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(pattern(label)).firstMatch
      }
      for step in capture.steps {
        if step.action == "sleep" { pause(step.seconds ?? 1); continue }
        if step.action == "drag", let fx = step.fromX, let fy = step.fromY, let tx = step.toX, let ty = step.toY {
          let from = app.coordinate(withNormalizedOffset: CGVector(dx: fx, dy: fy))
          let to = app.coordinate(withNormalizedOffset: CGVector(dx: tx, dy: ty))
          let size = app.frame.size
          let distance = hypot((tx - fx) * size.width, (ty - fy) * size.height)
          let speed = max(distance / (step.seconds ?? 0.6), 50)
          from.press(forDuration: 0.15, thenDragTo: to, withVelocity: XCUIGestureVelocity(rawValue: speed), thenHoldForDuration: 0.2)
          continue
        }
        if step.action == "tap", let x = step.x, let y = step.y {
          app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)).tap()
          continue
        }
        let name = step.identifier ?? step.label
        var target = step.identifier.map { element($0) } ?? step.label.map { labelled($0) } ?? app
        if !step.action.hasPrefix("swipe") || name != nil {
          XCTAssertTrue(target.waitForExistence(timeout: step.timeoutSeconds ?? 15), "Missing element: \(name ?? "app")")
        }
        // A form section header often shares its field's label; type into the field.
        if step.action == "type", let name {
          let named = step.identifier != nil ? NSPredicate(format: "identifier == %@", name) : pattern(name)
          let kinds: [XCUIElement.ElementType] = [.textField, .secureTextField, .textView, .searchField]
          if let input = kinds.lazy.map({ app.descendants(matching: $0).matching(named).firstMatch }).first(where: { $0.exists }) {
            target = input
          }
        }
        switch step.action {
        case "wait": break
        case "tap": target.tap()
        case "type":
          target.tap()
          // One character at a time: React Native inputs drop fast keystrokes.
          for character in step.text ?? "" { target.typeText(String(character)) }
        case "assertText":
          let actual = (target.value as? String) ?? target.label
          XCTAssertEqual(actual, step.text ?? "")
        case "swipeUp": target.swipeUp()
        case "swipeDown": target.swipeDown()
        case "swipeLeft": target.swipeLeft()
        case "swipeRight": target.swipeRight()
        default: XCTFail("Unsupported capture action")
        }
      }
      if let ready = capture.readyIdentifier { XCTAssertTrue(element(ready).waitForExistence(timeout: 20), "Capture is not ready: \(ready)") }
      if let delay = capture.delaySeconds, delay > 0 { pause(delay) }
      XCTAssertEqual(app.state, .runningForeground)
      let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
      image.name = "store-" + capture.name
      image.lifetime = .keepAlways
      add(image)
    }
  }
}
`;
