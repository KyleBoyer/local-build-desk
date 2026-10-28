import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  projectAndroidPackages,
  installAndroidPackages,
} from "./android-toolchain";
import { installIosPlatform } from "./xcode-toolchain";
import { Store } from "./database";
import { Vault, privateDirectory } from "./vault";
import { AppleAPI, GoogleAPI } from "./stores";
import {
  createDistributionCertificate,
  certificateId,
  decodeProfile,
  validateProvision,
  signingEnvironments,
  expandSigningEntitlements,
} from "./signing";
import {
  inspectProject,
  inspectIOSEntitlements,
  toolEnvironment,
} from "./config";
import { run, Redactor, existsCommand } from "./process";
import { invariant, messageOf } from "./errors";
import type {
  Credential,
  Project,
  ProjectSettings,
  SetupReport,
  SetupRequest,
} from "./types";
export function requestedCapabilities(config: Record<string, any>): string[] {
  const entitlements = config.ios?.entitlements ?? {};
  const capabilities = new Set<string>();
  if (
    Object.keys(entitlements).some((k) =>
      k.startsWith("com.apple.developer.nfc."),
    )
  )
    capabilities.add("NFC_TAG_READING");
  if (
    config.ios?.usesIcloudStorage ||
    Object.keys(entitlements).some((k) => /icloud|ubiquity/.test(k))
  )
    capabilities.add("ICLOUD");
  if (
    entitlements["aps-environment"] ||
    config.plugins?.some(
      (p: any) => (Array.isArray(p) ? p[0] : p) === "expo-notifications",
    )
  )
    capabilities.add("PUSH_NOTIFICATIONS");
  if (entitlements["com.apple.developer.associated-domains"])
    capabilities.add("ASSOCIATED_DOMAINS");
  if (entitlements["com.apple.security.application-groups"])
    capabilities.add("APP_GROUPS");
  if (
    config.ios?.usesAppleSignIn ||
    entitlements["com.apple.developer.applesignin"]
  )
    capabilities.add("APPLE_ID_AUTH");
  if (entitlements["com.apple.developer.healthkit"])
    capabilities.add("HEALTHKIT");
  return [...capabilities];
}
export async function prepareApple(
  store: Store,
  vault: Vault,
  project: Project,
  request: SetupRequest,
  log: (text: string) => void,
  signal?: AbortSignal,
  environment: Record<string, string> = {},
): Promise<SetupReport> {
  invariant(
    project.settings.appleConnectionId,
    "APPLE_CONNECTION",
    "Connect an Apple team API key first.",
  );
  const credential = await vault.get(
    project.settings.appleConnectionId,
    "apple",
  );
  const api = new AppleAPI(
    credential,
    fetch,
    (event) =>
      log(
        `Apple ${event.method} ${event.path} → ${event.status ?? "network failure"} (${event.durationMs}ms)${event.retryInMs !== undefined ? `; retrying after ${event.retryInMs}ms (attempt ${event.attempt})` : ""}`,
      ),
    { signal },
  );
  const report: SetupReport = { actions: [], handoffs: [], ready: false };
  const record = (text: string) => {
    report.actions.push(text);
    log(text);
  };
  log("Verifying Apple team access…");
  await api.validate();
  const inspection = await inspectProject(
    project.path,
    project.settings,
    environment,
  );
  const config: Record<string, any> = {
    ...inspection.config,
    ios: {
      ...inspection.config.ios,
      entitlements: inspection.native?.ios
        ? (inspection.config.ios?.entitlements ?? {})
        : await inspectIOSEntitlements(
            project.path,
            project.settings,
            environment,
          ),
    },
  };
  const bundleId = config.ios?.bundleIdentifier;
  invariant(
    bundleId,
    "BUNDLE_ID_REQUIRED",
    "Set ios.bundleIdentifier in your Expo project.",
  );
  let bundles = (
    await api.request(
      `/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&limit=200`,
    )
  ).data;
  if (!bundles.length) {
    const created = await api.request("/bundleIds", "POST", {
      data: {
        type: "bundleIds",
        attributes: {
          identifier: bundleId,
          name: config.name.replace(/[^A-Za-z0-9 ._-]/g, ""),
          platform: "IOS",
        },
      },
    });
    bundles = [created.data];
    record(`Registered bundle ID ${bundleId}.`);
  } else record(`Reusing bundle ID ${bundleId}.`);
  const bundle = bundles[0];
  const existing = (
    await api.request(`/bundleIds/${bundle.id}/bundleIdCapabilities`)
  ).data;
  for (const capabilityType of requestedCapabilities(config)) {
    if (
      existing.some((c: any) => c.attributes.capabilityType === capabilityType)
    ) {
      record(`${capabilityType.replaceAll("_", " ")} is already enabled.`);
      continue;
    }
    try {
      await api.request("/bundleIdCapabilities", "POST", {
        data: {
          type: "bundleIdCapabilities",
          attributes: { capabilityType },
          relationships: {
            bundleId: { data: { type: "bundleIds", id: bundle.id } },
          },
        },
      });
      record(`Enabled ${capabilityType.replaceAll("_", " ")}.`);
    } catch (error) {
      report.handoffs.push({
        title: `Enable ${capabilityType.replaceAll("_", " ")}`,
        detail: messageOf(error),
        url: `https://developer.apple.com/account/resources/identifiers/bundleId/edit/${bundle.id}`,
      });
    }
  }
  const apps = await api.apps(bundleId);
  const app = apps[0];
  if (!app)
    report.handoffs.push({
      title: "Create the App Store Connect app record",
      automation: "record",
      detail: `Choose New App → iOS. Name: ${config.name}; bundle ID: ${bundleId}; SKU: ${bundleId}; primary language: your app’s language. Return here and select Check again.`,
      url: "https://appstoreconnect.apple.com/apps",
    });
  else {
    project.settings.ascAppId = app.id;
    record(`Found App Store Connect app ${app.attributes.name}.`);
  }
  await privateDirectory(async (root) => {
    let signing: Extract<Credential, { kind: "ios" }> | undefined;
    let signingId = project.settings.iosSigningId;
    if (signingId) {
      const selected = await vault.get(signingId, "ios");
      try {
        await certificateId(api, selected, root, true);
        signing = selected;
        record("Reusing the project’s valid local signing private key.");
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (
          ![
            "CERT_EXPIRED",
            "CERT_NOT_IN_TEAM",
            "DISTRIBUTION_CERT_REQUIRED",
          ].includes(code ?? "")
        )
          throw error;
        record(
          "The selected certificate needs replacement; existing certificates will be preserved.",
        );
        signingId = undefined;
      }
    }
    if (!signing) {
      // Reuse an app-managed team certificate when its private key is already in this vault.
      for (const summary of store
        .credentialSummaries()
        .filter((c) => c.kind === "ios")) {
        const candidate = await vault.get(summary.id, "ios");
        try {
          await certificateId(api, candidate, root, true);
          signing = candidate;
          signingId = summary.id;
          record(`Reusing local certificate ${summary.label}.`);
          break;
        } catch {}
      }
      if (!signing) {
        log(
          "Creating a private key on this Mac and requesting an Apple Distribution certificate…",
        );
        signing = await createDistributionCertificate(
          credential,
          `${credential.teamId} · Distribution`,
          root,
        );
        const summary = await vault.put(signing);
        signingId = summary.id;
        record(
          "Created and encrypted an Apple Distribution certificate and private key.",
        );
      }
      project.settings.iosSigningId = signingId;
      store.putProject(project);
    }
    const certId = await certificateId(api, signing, root, true);
    let matching = false;
    let selectedProfile: any;
    for (const encoded of signing.profiles) {
      try {
        const decoded = await decodeProfile(encoded, root);
        validateProvision(
          decoded,
          bundleId,
          credential.teamId,
          expandSigningEntitlements(
            signingEnvironments(config.ios?.entitlements ?? {}, decoded),
            decoded,
            bundleId,
            credential.teamId,
          ),
          "store",
        );
        matching = !(
          config.ios?.usesIcloudStorage &&
          !(
            decoded.Entitlements[
              "com.apple.developer.icloud-container-identifiers"
            ]?.length ||
            decoded.Entitlements[
              "com.apple.developer.ubiquity-container-identifiers"
            ]?.length
          )
        );
        selectedProfile = decoded;
        record(`Reusing valid App Store profile ${decoded.Name}.`);
        break;
      } catch {}
    }
    if (!matching || request.renewProfiles) {
      log("Creating a matching App Store provisioning profile…");
      const created = await api.profile(
        bundleId,
        `Local Build Desk ${config.name} ${Date.now()}`,
        "IOS_APP_STORE",
        certId,
      );
      selectedProfile = await decodeProfile(
        created.attributes.profileContent,
        root,
      );
      const retained: string[] = [];
      for (const encoded of signing.profiles) {
        const decoded = await decodeProfile(encoded, root);
        if (
          decoded.Entitlements["application-identifier"] !==
            selectedProfile.Entitlements["application-identifier"] ||
          decoded.ProvisionedDevices ||
          decoded.ProvisionsAllDevices
        )
          retained.push(encoded);
      }
      signing.profiles = [...retained, created.attributes.profileContent];
      await vault.put(signing, signingId);
      record(
        vault.ephemeral
          ? "Created a matching App Store provisioning profile for this invocation."
          : "Created and encrypted a matching App Store provisioning profile.",
      );
    }
    try {
      validateProvision(
        selectedProfile,
        bundleId,
        credential.teamId,
        expandSigningEntitlements(
          signingEnvironments(config.ios?.entitlements ?? {}, selectedProfile),
          selectedProfile,
          bundleId,
          credential.teamId,
        ),
        "store",
      );
    } catch (error) {
      report.handoffs.push({
        title: "Complete required app capabilities",
        automation: "capabilities",
        detail: messageOf(error),
        url: `https://developer.apple.com/account/resources/identifiers/bundleId/edit/${bundle.id}`,
      });
    }
    if (
      config.ios?.usesIcloudStorage &&
      !(
        selectedProfile?.Entitlements?.[
          "com.apple.developer.icloud-container-identifiers"
        ]?.length ||
        selectedProfile?.Entitlements?.[
          "com.apple.developer.ubiquity-container-identifiers"
        ]?.length
      )
    )
      report.handoffs.push({
        title: "Assign your iCloud container",
        automation: "capabilities",
        detail:
          "Create or select the iCloud Documents/CloudKit container for this bundle ID in Apple Developer. Return and run Check & repair setup again to regenerate the profile.",
        url: `https://developer.apple.com/account/resources/identifiers/bundleId/edit/${bundle.id}`,
      });
  });
  if (app) {
    const latest = await api.latestBuild(bundleId);
    const key = `ios:${bundleId}`;
    if (latest !== undefined) {
      store.seed(key, latest);
      record(
        `Latest Apple build is ${latest}; local last reserved build is ${store.counter(key)}.`,
      );
    } else if (request.newApp && store.counter(key) === undefined) {
      store.seed(key, 0);
      record("Initialized a new app’s iOS build counter.");
    } else if (store.counter(key) === undefined)
      report.handoffs.push({
        title: "Enter your last EAS build number",
        detail:
          "This existing project has no visible Apple build number. Enter the last used number in Migration so unsubmitted EAS builds are not reused.",
      });
  }
  if (request.lastIosBuildNumber !== undefined) {
    store.seed(`ios:${bundleId}`, request.lastIosBuildNumber);
    record(
      `Imported last used iOS build number ${request.lastIosBuildNumber}.`,
    );
  }
  project.settings.setupAppleComplete = Boolean(
    app &&
    project.settings.iosSigningId &&
    store.counter(`ios:${bundleId}`) !== undefined &&
    !report.handoffs.length,
  );
  store.putProject(project);
  report.ready = project.settings.setupAppleComplete;
  return report;
}
export async function prepareAndroid(
  store: Store,
  vault: Vault,
  project: Project,
  request: SetupRequest,
  log: (text: string) => void,
): Promise<SetupReport> {
  const report: SetupReport = { actions: [], handoffs: [], ready: false };
  const record = (text: string) => {
    report.actions.push(text);
    log(text);
  };
  const packageName = project.packageName;
  invariant(
    packageName,
    "ANDROID_PACKAGE",
    "Set android.package in the Expo project.",
  );
  if (!project.settings.androidSigningId) {
    invariant(
      request.newApp,
      "EXISTING_UPLOAD_KEY",
      "For an existing app, import its EAS upload keystore in Migration. Android updates must preserve that key. Choose “new app” only if it has no previous signing identity.",
    );
    const password = randomBytes(24).toString("base64url");
    const saved = await privateDirectory(async (root) => {
      const key = join(root, "upload.jks");
      await run(
        "keytool",
        [
          "-genkeypair",
          "-keystore",
          key,
          "-storetype",
          "JKS",
          "-alias",
          "upload",
          "-keyalg",
          "RSA",
          "-keysize",
          "2048",
          "-validity",
          "10000",
          "-dname",
          `CN=${project.name.replace(/[^A-Za-z0-9 ._-]/g, "")}`,
          "-storepass:env",
          "DESK_PASSWORD",
          "-keypass:env",
          "DESK_PASSWORD",
        ],
        {
          env: {
            ...toolEnvironment(project.settings),
            DESK_PASSWORD: password,
          },
        },
      );
      return vault.put({
        kind: "android",
        label: `${project.name} · upload key`,
        keystore: (await readFile(key)).toString("base64"),
        alias: "upload",
        storePassword: password,
        keyPassword: password,
      });
    });
    project.settings.androidSigningId = saved.id;
    store.putProject(project);
    record("Generated an Android upload keystore and encrypted its passwords.");
  } else record("Reusing the existing Android upload key.");
  if (project.settings.googleConnectionId) {
    const api = new GoogleAPI(
      await vault.get(project.settings.googleConnectionId, "google"),
    );
    try {
      await api.validate(packageName);
      record("Verified Google Play permissions for this app.");
      const versions = await api.versions(packageName);
      if (versions.length) {
        store.seed(`android:${packageName}`, Math.max(...versions));
        record("Synchronized Google Play version codes.");
      }
    } catch (error) {
      report.handoffs.push({
        title: "Finish Play Console setup",
        automation: "bootstrap",
        detail: `${messageOf(error)} Create this app in Play Console, enable Play App Signing, grant the service account release permissions, and perform the initial manual upload when Google requires it.`,
        url: "https://play.google.com/console/developers",
      });
    }
  } else
    report.handoffs.push({
      title: "Connect a Google Play service account",
      detail:
        "Import a service-account key, or use the Google Cloud helper to create one. Invite its email in Play Console → Users and permissions with access to this app.",
      url: "https://play.google.com/console/developers",
    });
  if (request.lastAndroidBuildNumber !== undefined)
    store.seed(`android:${packageName}`, request.lastAndroidBuildNumber);
  else if (
    request.newApp &&
    store.counter(`android:${packageName}`) === undefined
  )
    store.seed(`android:${packageName}`, 0);
  report.ready = Boolean(
    project.settings.androidSigningId &&
    project.settings.googleConnectionId &&
    store.counter(`android:${packageName}`) !== undefined &&
    !report.handoffs.length,
  );
  return report;
}
export async function createGoogleServiceAccount(
  vault: Vault,
  cloudProject: string,
  log: (text: string) => void,
) {
  invariant(
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(cloudProject),
    "CLOUD_PROJECT",
    "Enter an existing Google Cloud project ID.",
  );
  invariant(
    await existsCommand("gcloud"),
    "GCLOUD_REQUIRED",
    "Install the Google Cloud CLI and sign in using the setup helper first.",
  );
  const env = toolEnvironment();
  const redactor = new Redactor();
  log("Enabling Android Publisher and IAM APIs…");
  await run(
    "gcloud",
    [
      "services",
      "enable",
      "androidpublisher.googleapis.com",
      "iam.googleapis.com",
      "--project",
      cloudProject,
      "--quiet",
    ],
    { env, log, secrets: redactor },
  );
  const account = "local-build-desk";
  const email = `${account}@${cloudProject}.iam.gserviceaccount.com`;
  const exists = await run(
    "gcloud",
    [
      "iam",
      "service-accounts",
      "describe",
      email,
      "--project",
      cloudProject,
      "--format=json",
    ],
    { env, allowFailure: true },
  );
  if (exists.code !== 0)
    await run(
      "gcloud",
      [
        "iam",
        "service-accounts",
        "create",
        account,
        "--display-name=Local Build Desk",
        "--project",
        cloudProject,
        "--quiet",
      ],
      { env, log, secrets: redactor },
    );
  log("Creating a service-account key and moving it into the encrypted vault…");
  const saved = await privateDirectory(async (root) => {
    const file = join(root, "google-key.json");
    await run(
      "gcloud",
      [
        "iam",
        "service-accounts",
        "keys",
        "create",
        file,
        `--iam-account=${email}`,
        "--project",
        cloudProject,
        "--quiet",
      ],
      { env, log, secrets: redactor },
    );
    return vault.put({
      kind: "google",
      label: `Google Play · ${cloudProject}`,
      serviceAccount: JSON.parse(await readFile(file, "utf8")),
    });
  });
  return { credential: saved, email };
}
export async function installTool(
  tool: "node" | "cocoapods" | "android" | "gcloud" | "ios-platform",
  acceptAndroidLicense: boolean,
  log: (text: string) => void,
  projectPath?: string,
  settings: ProjectSettings = {},
  signal?: AbortSignal,
) {
  const env = toolEnvironment(settings);
  if (tool === "ios-platform") {
    invariant(
      await existsCommand("xcodebuild", ["-version"], env),
      "XCODE_REQUIRED",
      "Install Xcode first.",
    );
    const sdk =
      settings.iosSdk ??
      (
        await run("xcrun", ["--sdk", "iphoneos", "--show-sdk-version"], {
          env,
          signal,
        })
      ).stdout.trim();
    await installIosPlatform(sdk, { env, log, signal });
    return {};
  }
  invariant(
    await existsCommand("brew"),
    "BREW_REQUIRED",
    "Install Homebrew from brew.sh first, then return to setup.",
  );
  if (tool === "node") {
    await run("brew", ["install", "node@24"], { env, log, signal });
    const prefix = (
      await run("brew", ["--prefix"], { env, signal })
    ).stdout.trim();
    return { nodePath: join(prefix, "opt/node@24/bin/node") };
  }
  if (tool === "cocoapods") {
    await run("brew", ["install", "cocoapods"], { env, log, signal });
    return {};
  }
  if (tool === "gcloud") {
    await run("brew", ["install", "--cask", "gcloud-cli"], {
      env,
      log,
      signal,
    });
    return {};
  }
  invariant(
    acceptAndroidLicense,
    "ANDROID_LICENSE",
    "Review and accept the Android SDK license in setup before installing SDK packages.",
  );
  await run("brew", ["install", "openjdk@17"], { env, log, signal });
  await run("brew", ["install", "--cask", "android-commandlinetools"], {
    env,
    log,
    signal,
  });
  const prefix = (
    await run("brew", ["--prefix"], { env, signal })
  ).stdout.trim();
  const javaHome = join(
    prefix,
    "opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
  );
  const androidSdk =
    settings.androidSdk ??
    (settings.buildDirectory
      ? join(settings.buildDirectory, "Android/sdk")
      : join(homedir(), "Library/Android/sdk"));
  await mkdir(androidSdk, { recursive: true });
  const manager = join(prefix, "bin/sdkmanager");
  const javaEnv = {
    ...env,
    JAVA_HOME: javaHome,
    PATH: `${javaHome}/bin:${env.PATH}`,
  };
  await installAndroidPackages(
    manager,
    androidSdk,
    await projectAndroidPackages(projectPath ?? ""),
    acceptAndroidLicense,
    { env: javaEnv, log, signal },
  );
  return { javaHome, androidSdk, androidSdkLicenseAccepted: true };
}
