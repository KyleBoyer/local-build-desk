import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import plist from "plist";
export async function createNativeFixture(
  root: string,
  extensions = true,
  style: "swiftui" | "uikit" = "swiftui",
) {
  await mkdir(join(root, "DeskApp.xcodeproj/xcshareddata/xcschemes"), {
    recursive: true,
  });
  await mkdir(join(root, "App"), { recursive: true });
  await mkdir(join(root, "Widget"), { recursive: true });
  await writeFile(
    join(root, "App/Main.swift"),
    `import SwiftUI\n@main struct DeskFixtureApp: App { var body: some Scene { WindowGroup { Text("Local Build Desk native fixture").padding() } } }\n`,
  );
  await writeFile(
    join(root, "Widget/Main.swift"),
    `import WidgetKit\nimport SwiftUI\nstruct Entry: TimelineEntry { let date:Date }\nstruct Provider:TimelineProvider { func placeholder(in context:Context)->Entry { Entry(date:Date()) }; func getSnapshot(in context:Context,completion:@escaping(Entry)->Void) { completion(Entry(date:Date())) }; func getTimeline(in context:Context,completion:@escaping(Timeline<Entry>)->Void) { completion(Timeline(entries:[Entry(date:Date())],policy:.never)) } }\n@main struct DeskFixtureWidget:Widget { var body: some WidgetConfiguration { StaticConfiguration(kind:"fixture",provider:Provider()) { _ in Text("Desk widget").containerBackground(.fill.tertiary,for:.widget) }.configurationDisplayName("Desk fixture").description("Signing fixture") } }\n`,
  );
  await writeFile(
    join(root, "Build.xcconfig"),
    "BASE_BUNDLE_ID = com.example.localbuilddesk.nativefixture\nMARKETING_VERSION = 1.2.3\nCURRENT_PROJECT_VERSION = 7\n",
  );
  const ents = plist.build({
    "com.apple.security.application-groups": [
      "group.com.example.localbuilddesk.fixture",
    ],
  });
  await writeFile(join(root, "App/App.entitlements"), ents);
  await writeFile(join(root, "Widget/Widget.entitlements"), ents);
  await writeFile(
    join(root, "Widget/Info.plist"),
    plist.build({
      CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
      CFBundleExecutable: "$(EXECUTABLE_NAME)",
      CFBundleName: "$(PRODUCT_NAME)",
      CFBundlePackageType: "XPC!",
      CFBundleShortVersionString: "$(MARKETING_VERSION)",
      CFBundleVersion: "$(CURRENT_PROJECT_VERSION)",
      NSExtension: {
        NSExtensionPointIdentifier: "com.apple.widgetkit-extension",
      },
    }),
  );
  await mkdir(join(root, "Support/Sources/DeskSupport"), { recursive: true });
  await writeFile(
    join(root, "Support/Package.swift"),
    `// swift-tools-version: 5.9
import PackageDescription
let package = Package(name:"DeskSupport",platforms:[.iOS(.v15)],products:[.library(name:"DeskSupport",targets:["DeskSupport"])],targets:[.target(name:"DeskSupport")])
`,
  );
  await writeFile(
    join(root, "Support/Sources/DeskSupport/Support.swift"),
    `public enum DeskSupport { public static let message = "Local Swift package loaded" }
`,
  );
  if (style === "swiftui")
    await writeFile(
      join(root, "App/Main.swift"),
      `import SwiftUI
import DeskSupport
@main struct DeskFixtureApp:App { var body: some Scene { WindowGroup { Text(DeskSupport.message).padding() } } }
`,
    );
  else
    await writeFile(
      join(root, "App/Main.swift"),
      `import UIKit
import DeskSupport
@main class FixtureDelegate:UIResponder,UIApplicationDelegate { func application(_ application:UIApplication, configurationForConnecting session:UISceneSession,options:UIScene.ConnectionOptions)->UISceneConfiguration { let config=UISceneConfiguration(name:"Default",sessionRole:session.role);config.delegateClass=FixtureScene.self;return config } }
class FixtureScene:UIResponder,UIWindowSceneDelegate { var window:UIWindow?;func scene(_ scene:UIScene,willConnectTo session:UISceneSession,options:UIScene.ConnectionOptions){guard let scene=scene as? UIWindowScene else{return};let window=UIWindow(windowScene:scene);let vc=UIViewController();vc.view.backgroundColor = .systemBlue;let label=UILabel(frame:CGRect(x:20,y:120,width:350,height:80));label.text=DeskSupport.message;vc.view.addSubview(label);window.rootViewController=vc;window.makeKeyAndVisible();self.window=window} }
`,
    );
  const ids: Record<string, string> = {};
  let next = 1;
  const id = (name: string) =>
    (ids[name] ??= "A" + String(next++).padStart(23, "0"));
  const objects: string[] = [];
  const add = (name: string, body: string) => {
    objects.push(`${id(name)} = { ${body} };`);
    return id(name);
  };
  const appFile = add(
    "app-file",
    'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = App/Main.swift; sourceTree = "<group>";',
  );
  const widgetFile = add(
    "widget-file",
    'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = Widget/Main.swift; sourceTree = "<group>";',
  );
  const configFile = add(
    "xcconfig",
    'isa = PBXFileReference; lastKnownFileType = text.xcconfig; path = Build.xcconfig; sourceTree = "<group>";',
  );
  const appProduct = add(
    "app-product",
    "isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = DeskFixture.app; sourceTree = BUILT_PRODUCTS_DIR;",
  );
  const widgetProduct = add(
    "widget-product",
    'isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = DeskWidget.appex; sourceTree = BUILT_PRODUCTS_DIR;',
  );
  const appBuild = add(
      "app-build",
      `isa = PBXBuildFile; fileRef = ${appFile};`,
    ),
    widgetBuild = add(
      "widget-build",
      `isa = PBXBuildFile; fileRef = ${widgetFile};`,
    );
  const localPackage = add(
    "local-package",
    "isa = XCLocalSwiftPackageReference; relativePath = Support;",
  );
  const product = add(
    "package-product",
    `isa = XCSwiftPackageProductDependency; package = ${localPackage}; productName = DeskSupport;`,
  );
  const library = add(
    "package-build",
    `isa = PBXBuildFile; productRef = ${product};`,
  );
  const frameworks = add(
    "frameworks",
    `isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (${library},); runOnlyForDeploymentPostprocessing = 0;`,
  );
  const appSources = add(
      "app-sources",
      `isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (${appBuild},); runOnlyForDeploymentPostprocessing = 0;`,
    ),
    widgetSources = add(
      "widget-sources",
      `isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (${widgetBuild},); runOnlyForDeploymentPostprocessing = 0;`,
    );
  const embedFile = add(
    "embed-file",
    `isa = PBXBuildFile; fileRef = ${widgetProduct}; settings = { ATTRIBUTES = (RemoveHeadersOnCopy,); };`,
  );
  const embed = add(
    "embed",
    `isa = PBXCopyFilesBuildPhase; buildActionMask = 2147483647; dstPath = ""; dstSubfolderSpec = 13; files = (${embedFile},); name = "Embed App Extensions"; runOnlyForDeploymentPostprocessing = 0;`,
  );
  for (const target of ["app", "widget", "project"]) {
    for (const config of ["Debug", "Release"]) {
      const common =
        "SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 18.0; SWIFT_VERSION = 5.0; CLANG_ENABLE_MODULES = YES;";
      const app =
        'PRODUCT_BUNDLE_IDENTIFIER = "$(BASE_BUNDLE_ID)"; PRODUCT_NAME = DeskFixture; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES; INFOPLIST_KEY_UILaunchScreen_Generation = YES; CODE_SIGN_ENTITLEMENTS = App/App.entitlements; TARGETED_DEVICE_FAMILY = "1,2";';
      const widget =
        'PRODUCT_BUNDLE_IDENTIFIER = "$(BASE_BUNDLE_ID).widget"; PRODUCT_NAME = DeskWidget; INFOPLIST_FILE = Widget/Info.plist; CODE_SIGN_ENTITLEMENTS = Widget/Widget.entitlements; APPLICATION_EXTENSION_API_ONLY = YES; SKIP_INSTALL = YES; TARGETED_DEVICE_FAMILY = "1,2";';
      add(
        `${target}-${config}`,
        `isa = XCBuildConfiguration; baseConfigurationReference = ${configFile}; buildSettings = { ${common} ${target === "app" ? app : target === "widget" ? widget : ""} SWIFT_OPTIMIZATION_LEVEL = "${config === "Debug" ? "-Onone" : "-O"}"; }; name = ${config};`,
      );
    }
    add(
      `${target}-configs`,
      `isa = XCConfigurationList; buildConfigurations = (${id(target + "-Debug")},${id(target + "-Release")},); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;`,
    );
  }
  const proxy = add(
    "proxy",
    `isa = PBXContainerItemProxy; containerPortal = ${id("project")}; proxyType = 1; remoteGlobalIDString = ${id("widget")}; remoteInfo = DeskWidget;`,
  );
  const dependency = add(
    "dependency",
    `isa = PBXTargetDependency; target = ${id("widget")}; targetProxy = ${proxy};`,
  );
  add(
    "app",
    `isa = PBXNativeTarget; buildConfigurationList = ${id("app-configs")}; packageProductDependencies = (${product},); buildPhases = (${appSources},${frameworks},${extensions ? embed + "," : ""}); buildRules = (); dependencies = (${extensions ? dependency + "," : ""}); name = DeskFixture; productName = DeskFixture; productReference = ${appProduct}; productType = "com.apple.product-type.application";`,
  );
  if (extensions)
    add(
      "widget",
      `isa = PBXNativeTarget; buildConfigurationList = ${id("widget-configs")}; buildPhases = (${widgetSources},); buildRules = (); dependencies = (); name = DeskWidget; productName = DeskWidget; productReference = ${widgetProduct}; productType = "com.apple.product-type.app-extension";`,
    );
  const group = add(
    "group",
    `isa = PBXGroup; children = (${appFile},${widgetFile},${configFile},${appProduct},${widgetProduct},); sourceTree = "<group>";`,
  );
  add(
    "project",
    `isa = PBXProject; attributes = { LastUpgradeCheck = 2700; }; buildConfigurationList = ${id("project-configs")}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en,Base,); mainGroup = ${group}; productRefGroup = ${group}; projectDirPath = ""; projectRoot = ""; packageReferences = (${localPackage},); targets = (${id("app")},${extensions ? id("widget") + "," : ""});`,
  );
  await writeFile(
    join(root, "DeskApp.xcodeproj/project.pbxproj"),
    `// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n${[...new Set(objects.map((o) => o.match(/isa = ([^;]+);/)![1]))].map((section) => `/* Begin ${section} section */\n${objects.filter((o) => o.includes(`isa = ${section};`)).join("\n")}\n/* End ${section} section */`).join("\n")}\n}; rootObject = ${id("project")}; }\n`,
  );
  await writeFile(
    join(root, "DeskApp.xcodeproj/xcshareddata/xcschemes/DeskFixture.xcscheme"),
    `<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="2700" version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${id("app")}" BuildableName="DeskFixture.app" BlueprintName="DeskFixture" ReferencedContainer="container:DeskApp.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction><LaunchAction buildConfiguration="Debug"/><ProfileAction buildConfiguration="Release"/><AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/></Scheme>`,
  );
  return root;
}
// Same app and widget, but described by an XcodeGen spec with the project gitignored.
export async function createXcodeGenFixture(root: string) {
  await createNativeFixture(root, true, "swiftui");
  const { rm } = await import("node:fs/promises");
  await rm(join(root, "DeskApp.xcodeproj"), { recursive: true, force: true });
  await writeFile(join(root, ".gitignore"), "*.xcodeproj\n");
  await writeFile(
    join(root, "project.yml"),
    `name: DeskApp
options:
  deploymentTarget:
    iOS: "18.0"
configFiles:
  Debug: Build.xcconfig
  Release: Build.xcconfig
packages:
  DeskSupport:
    path: Support
targets:
  DeskFixture:
    type: application
    platform: iOS
    sources: [App]
    dependencies:
      - target: DeskWidget
      - package: DeskSupport
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: $(BASE_BUNDLE_ID)
        PRODUCT_NAME: DeskFixture
        GENERATE_INFOPLIST_FILE: YES
        INFOPLIST_KEY_UIApplicationSceneManifest_Generation: YES
        INFOPLIST_KEY_UILaunchScreen_Generation: YES
        CODE_SIGN_ENTITLEMENTS: App/App.entitlements
        TARGETED_DEVICE_FAMILY: "1,2"
  DeskWidget:
    type: app-extension
    platform: iOS
    sources:
      - path: Widget
        excludes: [Info.plist, Widget.entitlements]
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: $(BASE_BUNDLE_ID).widget
        PRODUCT_NAME: DeskWidget
        INFOPLIST_FILE: Widget/Info.plist
        CODE_SIGN_ENTITLEMENTS: Widget/Widget.entitlements
        APPLICATION_EXTENSION_API_ONLY: YES
        SKIP_INSTALL: YES
        TARGETED_DEVICE_FAMILY: "1,2"
schemes:
  DeskFixture:
    build:
      targets:
        DeskFixture: all
`,
  );
}
