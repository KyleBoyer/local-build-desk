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

struct Step: Decodable { let action: String; let identifier: String?; let text: String?; let timeoutSeconds: Double? }
struct Capture: Decodable { let name: String; let launchArguments: [String]; let launchEnvironment: [String:String]; let steps: [Step]; let readyIdentifier: String? }
struct Plan: Decodable { let bundleId: String; let language: String; let locale: String; let captures: [Capture] }

final class DeskScreenshots: XCTestCase {
  @MainActor func testCapturePlan() throws {
    continueAfterFailure = false
    let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "plan", withExtension: "json"))
    let plan = try JSONDecoder().decode(Plan.self, from: Data(contentsOf: url))
    for capture in plan.captures {
      let app = XCUIApplication(bundleIdentifier: plan.bundleId)
      app.launchArguments = capture.launchArguments + ["-AppleLanguages", "(\(plan.language))", "-AppleLocale", plan.locale]
      app.launchEnvironment = capture.launchEnvironment
      app.launch()
      defer { app.terminate() }
      XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30), "App did not enter foreground")
      func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
      }
      for step in capture.steps {
        let target = step.identifier.map { element($0) } ?? app
        if !step.action.hasPrefix("swipe") {
          XCTAssertTrue(target.waitForExistence(timeout: step.timeoutSeconds ?? 15), "Missing element: \(step.identifier ?? "app")")
        }
        switch step.action {
        case "wait": break
        case "tap": target.tap()
        case "type": target.tap(); target.typeText(step.text ?? "")
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
      XCTAssertEqual(app.state, .runningForeground)
      let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
      image.name = "store-" + capture.name
      image.lifetime = .keepAlways
      add(image)
    }
  }
}
`;
