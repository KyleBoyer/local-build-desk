# Local Build Desk

An Electron / React / TypeScript app that builds Expo, Capacitor, and native iOS apps on your Mac and uploads directly to App Store Connect and Google Play. The desktop and `ios-submit` CLI share one queue, credential vault, and SQLite database. Routine operations do not use EAS Build or EAS Submit.

## Run

Requires macOS, Git, and Node.js 24 or newer (`.nvmrc` selects Node 24). Install native build tools for your project's requirements through Guided setup or Toolchain. You do not need the original developer's machine, app project, Codex installation, accounts, signing identities, or file paths.

```sh
npm ci
npm run dev
```

Choose **Toolchain → Build storage folder** to place snapshots, native output, and dependency caches on another disk. Logs, counters, and encrypted credentials remain in the app’s normal data directory. Build storage must be outside the imported project. Allow at least 20 GB of free space. Guided setup checks the matching iOS platform runtime and can install it through Xcode.

To build a local Mac application:

```sh
npm run package
# Open the .app in release/mac-arm64 (Apple Silicon) or release/mac (Intel).
```

`npm run package` produces an unsigned local app. Signed and notarized distributable packages use the dedicated GitHub release workflow described below.

## Supported project types

Import an **Expo**, **Capacitor**, or **native iOS** repository. If it contains several apps, choose one in the app picker; the repository root stays available to local packages. Multiple apps can share that root and retain separate settings/signing references. Existing Expo imports and EAS profiles keep their behavior.

| Project    | Preparation                                                              | Native outputs                              |
| ---------- | ------------------------------------------------------------------------ | ------------------------------------------- |
| Expo       | Installed Expo config, EAS profiles, optional prebuild                   | iOS simulator app / IPA; Android APK / AAB  |
| Capacitor  | Locked dependencies → web build → Capacitor add/sync inside the snapshot | iOS simulator app / IPA; Android APK / AAB  |
| Native iOS | Xcode project/workspace, optional Swift packages or CocoaPods            | iOS simulator app / IPA, archives and dSYMs |

Capacitor 8 is the validated baseline. The project’s own CLI, plugins, native paths, and dependency manager are preserved. The default web script is `build`; select another package script in **Project → Project build settings**. `webDir/index.html` must be produced freshly. Existing native directories are maintained; missing platforms are generated only in the build copy, and only when their platform dependency is declared. Newly generated Capacitor 8 iOS projects default to Swift Package Manager. Unsupported plugin warnings stop packaging rather than silently dropping a plugin. Production profiles cannot use `server.url` to load a development server.

Native SwiftUI/UIKit projects can use `.xcodeproj` or `.xcworkspace`, generated Info.plists, `.xcconfig` variables, local Swift packages, widgets, and share extensions. Choose the app container and scheme when detection is ambiguous. Xcode resolves effective identities/versions and each embedded target’s entitlements. Signing setup prepares matching profiles per app/extension; capability assignment has a target selector. Frameworks and tests do not get provisioning profiles. Native desktop builds require Xcode and their actual native dependencies; Node/npm, Expo, Java, and CocoaPods are not prerequisites for a pure Swift/SPM app.

Swift package resolution honors existing `Package.resolved` pins. Android SDK/build-tools requirements come from native Gradle configuration and the selected variant’s resolved model, with no React Native fallback for Capacitor. Guided setup selects a project-compatible JDK; missing SDK packages install after license acceptance. Toolchain selection stays per project.

Non-Expo apps have editable **Local build profiles**:

- `development`: Debug iOS simulator app / Android debug APK.
- `preview`: ad-hoc iOS IPA / signed Android APK. Ad-hoc signing requires registered devices.
- `production`: App Store IPA / signed Play AAB.

Profiles support inheritance, configuration, distribution, simulator/debug selection, environment values, scheme, Android variant/build type, and automatic build-number increments. Existing native settings determine the app identity and marketing version. A newly generated Capacitor platform starts from the package’s version. Version overrides affect only the copied native project, and embedded extensions are verified against the same reserved version/build number.

Export/import portable settings from the project screen, or provide `ios-submit.json` / `--config FILE`:

```json
{
  "settings": {
    "projectType": "capacitor",
    "appDirectory": "apps/mobile",
    "webBuildScript": "build",
    "minimumIosSdk": "27.2",
    "localProfiles": {
      "development": {
        "configuration": "Debug",
        "distribution": "internal",
        "simulator": true,
        "debug": true,
        "buildType": "apk",
        "autoIncrement": true
      },
      "production": {
        "configuration": "Release",
        "distribution": "store",
        "buildType": "app-bundle",
        "autoIncrement": true
      }
    }
  }
}
```

Portable exports omit signing references, account connections, and machine-specific tool/storage paths. Profile `env` values are configuration literals; keep secrets in imported encrypted environment values or invocation credential references. The encrypted backup retains the complete local setup. Builds with unpinned dependencies are excluded from artifact reuse; Capacitor web changes always invalidate packaged artifacts. No Expo development-client shortcut is used for native or Capacitor binaries.

The CLI accepts `--project-type`, `--app-directory`, `--ios-target`, `--scheme`, `--configuration`, `--web-build-script`, `--ios-dependency-manager`, and `--android-module`. When a repository has several imported apps, select its project ID or `--app-directory` so signing settings cannot come from another app. For a packaged native build without the Node-based CLI wrapper, use the bundled executable directly:

```sh
"/Applications/Local Build Desk.app/Contents/MacOS/Local Build Desk" --desk-cli build --project /path/to/native-app --platform ios --profile development
```

XcodeGen projects are supported: when a `project.yml` has no committed `.xcodeproj` beside it (or the generated project is gitignored), Local Build Desk runs `xcodegen generate` inside each disposable snapshot, so your checkout is never modified. Install XcodeGen from Guided setup or `brew install xcodegen`. macOS/watchOS/tvOS apps, standalone Swift libraries, Tuist projects, and hosted web/OTA updates are outside this release; generate a Tuist project before importing it. Local dependencies must stay within the imported repository root; external source symlinks are rejected.

## From zero to TestFlight

1. Import your Expo project folder. **Guided setup** checks the local toolchain and walks you through each remaining step.
2. Choose **Connect account**. Local Build Desk opens its own isolated account window and navigates to Apple setup. It prepares the team-key form, detects the key download, looks up your Team ID, and verifies the connection. Sign-in/MFA, legal acceptance, and approval to generate an Admin key pause automation for you. A timeout or changed page brings the window forward with a manual fallback. You can also import an existing `.p8` key. Individual API keys cannot manage provisioning.
3. Select **Set up signing automatically**. The app registers or reuses your bundle ID, enables supported capabilities, reuses a locally available signing private key or generates a new distribution certificate, and creates or reuses a matching App Store profile. It never revokes existing certificates.
4. For a brand-new app, use **Store app record & first upload** to prepare its App Store Connect record in the app-owned browser. Use **Assign iCloud containers & App Groups** to prepare explicit identifier assignments and validate matching profiles. Account agreements and restricted capabilities can still need an owner handoff; setup reports the exact issue.
5. Existing EAS projects can migrate credentials and environment files and enter their last used build numbers. Known store versions are merged into local counters. New-app counters start at zero only when you explicitly select the new-app option.
6. Select **Build & send to TestFlight**. Follow compilation, signing, upload, and Apple processing in Builds. Processing is checked automatically every 30 seconds while the app runs. CLI `status` also checks Apple directly; use `--wait` to follow processing without opening the desktop. Optionally select an internal TestFlight group or create a group and review invitations to existing eligible teammates in Guided setup. External beta review and external tester invitations remain in App Store Connect.

Certificates without their private keys cannot be reused for signing. If another computer or EAS holds an existing private key, export it once or let this app generate a new distribution certificate, subject to Apple’s certificate limits. App identity is preserved.

Generated signing entitlements are inspected through the project’s installed Expo plugins before setup reports readiness. Profile-controlled push/iCloud environments are resolved in the build snapshot. Apple’s scalar/list wildcard entitlement representations are validated without changing capability identifiers. The temporary signing keychain includes the public [Apple WWDR G3 intermediate](https://www.apple.com/certificateauthority/), checked against existing macOS root trust; system trust settings are unchanged.

The account window belongs to Local Build Desk and uses its own persistent provider session. No Codex browser or Codex runtime is needed. Its remote pages have no Node integration or preload bridge. Only the local guide panel can call the limited setup APIs. Password and one-time-code field values are never inspected by the automation. An optional checkbox hides the window during automated work; login, approval, and errors show it again. Key downloads go directly to a private local folder and are removed after the verified encrypted import; no save dialog is required.

## Android setup

Guided setup can install JDK 17 and the Android command-line SDK via Homebrew after you review and accept Google’s SDK license. It reads the project’s React Native version catalog and Gradle properties to install matching platform/build tools/NDK packages. With external build storage selected, SDK packages use that disk. The installer resolves Google’s exact base API package names (for example, API 37 → `android-37.0`) from the repository catalog; it never substitutes a newer minor SDK or beta. Only the agreement for requested packages is accepted; unrelated repository licenses are not accepted automatically.

For an existing app, import its existing EAS upload keystore. The app will not silently replace it. For a genuinely new app, setup can generate the keystore and passwords automatically.

Choose **Connect account** for the app-owned Google guide: it prepares Cloud project creation, API enablement, service-account/key provisioning, and app-scoped Play permissions, with explicit approvals before new access. You can also import an existing JSON key. The Google Cloud CLI fallback signs in through Google’s supported external browser, encrypts the generated key, and continues into the same guided Play permission flow. Both paths verify access to the intended Android package before replacing the saved connection. Organization policies can restrict key creation. Enrollment and app declarations remain owner steps. **Store app record & first upload** can build the first AAB locally and prepare its console upload as an internal draft, pausing for required agreements. The default track is `internal`; see **Guided Google provisioning** below.

Uploads to `internal` roll out to internal testers automatically (`playAutoRollout`, on by default): the new build is committed as a `completed` release that replaces the previous internal release, and the job reports `accepted`. Earlier drafts that ios-submit itself uploaded for lower version codes are superseded and logged; any other draft (made in Play Console, or with a higher or unknown version code) still stops the upload before any binary bytes are sent. If Google only allows drafts because the app has never been published, the same staged bundle is committed as a draft with an explanation. Accounts that require `changesNotSentForReview=true` get the release committed and reported as waiting for **Send for review** in Play Console. If managed publishing is on, a committed release still waits for **Publish changes**; the edits API does not expose that setting, so ios-submit re-reads the track and notes the possibility. Set `playAutoRollout` to `false` (desktop toggle under Connections, `--set playAutoRollout=false`, `--play-auto-rollout=false`, `IOS_SUBMIT_PLAY_AUTO_ROLLOUT=false`, or `"settings": { "playAutoRollout": false }`) to restore draft uploads. Other tracks always upload drafts; automatic rollout never applies to closed, open or production tracks. Whether a draft was uploaded by ios-submit is looked up in the app database by package name and version code, not by project or checkout path, so CI runs from fresh checkouts recognize earlier uploads as long as they share the app's data directory (the default `~/Library/Application Support/Local Build Desk`; build-number counters live there too).

Release notes ("What's new") can be attached to each uploaded release with `--release-notes TEXT`, `IOS_SUBMIT_PLAY_RELEASE_NOTES`, or `playReleaseNotes` (up to 500 characters). The language defaults to `en-US`; set `playReleaseNotesLanguage` (for example `es-419`) to match a language in your store listing.

In draft mode, uploads create drafts on the selected track. Existing active releases are preserved. An unrelated existing draft stops upload before any binary bytes are sent, with an instruction to resolve it in Play Console. Google permits one open edit per account/app, so account checks are serialized and blocked while an upload needs reconciliation. Recovery inspects the original edit before opening another one and verifies the exact AAB checksum and preserved releases. If Google discarded the edit, the app confirms the version is absent before allowing a resend of the existing artifact. Recovery commits in the same mode (draft or rollout) as the original upload. Accounts that reject `changesNotSentForReview` use Google’s default commit mode for the same draft; the app does not change listings or roll out production releases.

## Xcode and iOS SDK automation

In **Toolchain**, set the minimum iOS SDK, then select **Download Xcode automatically**. The app opens its own Apple downloads session, selects the requested Xcode archive, downloads it to build storage, verifies its Apple signature, and extracts it beside existing installations. It shows the bundled Xcode agreement before completing first launch. macOS may request administrator authentication in its native dialog. Matching iOS platform components install automatically with an explicit runtime version and a final availability check. Existing compatible runtimes are reused. Reopening setup for an installed toolchain works locally without another Apple sign-in; component progress and administrator-authentication handoffs appear in the guide.

Select the installed Xcode and exact SDK for each project. Builds use `DEVELOPER_DIR` and an explicit `-sdk iphoneosVERSION`; they do not change the Mac’s global `xcode-select`. An older or missing SDK stops preflight before reserving a build number. Build history and artifacts record the toolchain, and the exported IPA’s SDK metadata is checked. A simulator runtime alone does not supply a newer device SDK; the matching Xcode is required.

Download/verification failures pause automation until **Retry automation**. Downloaded archives, extracted applications, and license approval survive restart. Apple sign-in/MFA and any new agreement remain visible handoffs.

```sh
ios-submit toolchain --project /path/to/app --minimum-ios-sdk 27.2
ios-submit toolchain --project /path/to/app --xcode-archive /path/to/Xcode.xip
# After reviewing the bundled agreement:
ios-submit toolchain --project /path/to/app --xcode-archive /path/to/Xcode.app --accept-xcode-license
```

## Bring an existing EAS project

Use `eas credentials` once to download signing credentials into `credentials.json`. In **Connections → Migration**, import that file and its referenced certificate/profile/keystore files, local `.env` files or a JSON map of environment values, and the last reserved EAS build numbers. EAS Secret values must come from their original source.

Local and EAS remote counters are independent. `ios-submit versions --project /path/to/app` shows the local authority and next minimum for each identity. Before returning to EAS, stop local jobs and run `versions --project /path/to/app --platform ios --handoff-eas`. This one-time operation raises EAS to at least the highest local reservation, verifies the remote value, and pauses local reservations across checkouts. EAS’s next auto-increment is then above local builds. After EAS jobs finish, run `versions --project /path/to/app --platform ios --resume-local` to import its last reservation and resume locally. An uncertain handoff keeps local builds paused until reconciled. Failed pre-upload jobs release uncommitted number leases; numbers committed at upload and legacy counter floors are never reused. Routine local builds never consult EAS.

The project’s `app.json` / `app.config.*`, Expo plugins, app identity, and EAS profile names are preserved. Local selections live in the desktop database. Sources are copied into a job directory, including uncommitted tracked files and eligible untracked modules; installation and prebuild happen there. Native folders tracked by Git are preserved. Toolchain overrides can force generated or maintained-native mode.

## CLI

After `npm run build`, use `node bin/ios-submit.mjs`, `npm run cli --`, or `npm link` to install the `ios-submit` command. It launches the same Electron backend for Keychain access. If the desktop is open, requests use its local owner-only Unix socket and the same queue.

```sh
ios-submit doctor --project /path/to/app
ios-submit inspect --project /path/to/app --profile production --platform ios
ios-submit migrate --project /path/to/app --credentials /path/to/credentials.json --ios-last-used 12 --android-last-used 8
ios-submit build --project /path/to/app --platform all --profile production
ios-submit build --project /path/to/app --platform ios --profile production --auto-submit --build-directory /Volumes/Builds/LocalBuildDesk
ios-submit status
ios-submit status --job JOB_ID --wait --timeout 1800
ios-submit logs --job JOB_ID
ios-submit cancel --job JOB_ID
ios-submit submit --artifact ARTIFACT_ID --wait
ios-submit reconcile --job JOB_ID
ios-submit connect-google --project /path/to/app --key /path/to/existing-service-account.json
ios-submit install-tool --project /path/to/app --tool android --accept-android-license
```

The CLI exits **0** for success, **1** for failure, and **2** while Apple processing is pending. `--wait` on `build`, `submit`, or `status` waits for processing; `--timeout` is in seconds (default 1800). `status` refreshes pending jobs directly from Apple, so it works without the desktop open. A refresh failure is reported with a recovery action. Upload completion and accepted processing remain separate states. `status` distinguishes accepted builds and Play drafts. An uncertain upload must be reconciled before retrying; retries never blindly upload a second copy. Existing successful artifacts can be uploaded without rebuilding. `cancel --job` works through the shared engine. Interrupting a headless owner stops and awaits its child processes; during normal completion, the owner waits for forwarded CLI requests before closing the shared engine.

## Long-running operations

Build stages, signing/setup, account automation and component installation show elapsed time, a progress bar, and guidance about expected delays. Xcode archive downloads and AAB uploads report byte totals. Xcode platform downloads and IPA uploads use percentages only when their tools report them. Opaque compilation, verification and store-processing stages use an indeterminate bar without an invented percentage.

AAB transfer, waiting for Google’s bundle confirmation, validation, and draft commit are separate phases. Sending all bytes does not mean Google has finished processing them. Last-progress timestamps make a quiet network wait visible. iOS upload and Apple processing remain separate as well.

Replay fixtures are deliberately sanitized and run in hidden windows; dummy Apple pages are never presented as live account pages. CLI owners and forwarded CLI clients run without an extra Dock icon.

## Everyday build and release tools

**Preferences → Completion notifications** enables native macOS alerts for finished builds, upload results, processing completion, and failures. Click an alert to open that build, including delivered alerts from an earlier app session. Notifications need the signed app and macOS permission. The desktop must be running to observe completion; CLI jobs forwarded to an open desktop also notify. The preference is local to this Mac.

**Builds → What changed?** compares the selected build with the previous successful build for the same app/platform. It includes source fingerprints and commits, profile/configuration, versions, signing and entitlements, destination, tool versions, Xcode/iOS SDK, and artifact size. Older builds show missing details as “Not recorded”; new builds capture those facts automatically.

**Release** prepares TestFlight What to Test, App Store draft What’s New, optional localized listing fields, or Google Play notes for the next upload. Draft notes from recorded git commits, edit them, then review the exact current/proposed Apple values before applying. Apple previews expire after ten minutes, are invalidated by changed remote metadata/connections, and are consumed once. An uncertain write requires a fresh preview instead of a blind retry. Creating a missing App Store version is opt-in and selects manual release. Saving metadata does not submit for App Review or release to production. Play notes are saved locally and used by subsequent uploads; they do not modify existing releases.

**Preferences → Encrypted backup & restore** creates a portable `.lbdbackup` protected by a passphrase of at least 12 characters (AES-256-GCM with scrypt). It includes signing credentials, API connections, imported environment values, project settings, build history/artifact metadata, and version reservations. It excludes source code, artifact contents, logs, caches, browser sessions, and notification preferences. Keep the passphrase separately; it is not stored or recoverable by the app. Restore previews its contents and lets you map source folders. Machine-specific tool/storage paths reset by default. Existing credentials are preserved, imported credentials receive new IDs and are encrypted for the destination Mac, and counters never move below existing floors. Active historical jobs become interrupted/uncertain and restored uploads require explicit reconciliation. Transfer artifact files separately and use **Locate file** in build history; the original checksum and size must match.

**Build** and **Build & Upload** offer existing verified artifacts when source, configuration, environment, signing credentials, and toolchain fingerprints match. Reuse keeps the original version and does not reserve another build number. Already-uploaded artifacts open their existing result instead of uploading twice. Development clients may also offer native-compatible reuse using the project’s installed `@expo/fingerprint`; run Metro to load the current JavaScript. Production artifacts require an exact match. A clean build or **Build fresh** bypasses reuse. Builds made before fingerprint capture need one fresh build before they can be matched. Invocation-only/no-Keychain CI credentials do not create reusable fingerprints.

**Install & launch** on a simulator `.app` or Android APK verifies its checksum, lets you select a target, boots the simulator/emulator if necessary, installs, and launches the app. Existing Android virtual devices and USB-debugging devices are supported; unauthorized devices show the approval needed. Installation preserves app data and never uninstalls an app to work around a signing mismatch. Store IPAs and AABs use TestFlight/Play distribution; build a simulator or APK profile for direct installation. First boot can take a minute and has cancellable progress. An app that exits within a few seconds of launching is reported as a launch failure instead of a success.

## Storage and security

Data lives in `~/Library/Application Support/Local Build Desk`:

- `desk.sqlite`: projects, jobs, artifact metadata, encrypted credential records, and monotonically increasing counters keyed by platform/app identity.
- `jobs/`: isolated source snapshots, logs, signed outputs, Xcode archives, and dSYMs.
- `cache/`: package downloads, Gradle caches, and compatible native output caches.
- `setup/`: setup activity logs.

Project records are keyed by repository root and app directory. The first launch upgrades older path-only records transactionally while preserving IDs, jobs, and counters.

Secrets are encrypted using Electron `safeStorage`, backed by the macOS Keychain. Decrypted credential files live in private temporary directories and are removed after use. Gradle configuration caching is disabled for builds so injected signing passwords are not serialized into that cache. Native outputs and dependency download caches remain available. Signing keychains are temporary; imported profiles are removed when the job ends if the app installed them. Build logs redact imported environment values, signing passwords, and keys. Secrets required by project scripts remain available to those scripts; only import projects you trust. Back up your signing keys and keep your Mac account secure.

The renderer is sandboxed with context isolation and no Node integration. Its preload bridge exposes validated methods; it cannot run arbitrary shell commands. `LOCAL_BUILD_DESK_DATA_DIR` selects an alternative data directory for tests or isolated installations.

## Compatibility and current limits

Supported build-profile behavior includes inheritance, platform overrides, environment values, development/preview/store profiles, simulator builds, build-number increments, Android APK/AAB selection, explicit schemes/configurations, and EAS lifecycle hooks. `expo-dev-client` is required for profiles that request it. Tool version fields are checked against local tools. Cloud resource/image/cache settings are reported as local differences. Unsupported fields stop preflight instead of being silently ignored.

Generated native projects get versions in the copied Expo config. Maintained native projects retain their native configuration and are verified against the expected identity/version. Custom multi-flavor Gradle commands must yield one artifact. Dynamic bundle IDs must resolve consistently. Signing multiple iOS targets requires matching profiles for every resolved bundle identifier; native iOS/Capacitor setup resolves build-setting variables and prepares embedded-target profiles. Workspace dependencies or symlinks outside the imported project root need a self-contained project root; external symlinks are rejected.

Screenshots, review submission, external tester invitation/review, and production rollout remain outside this release. Localized release/listing metadata can be prepared in the Release assistant. Uploading to TestFlight is not an App Store production release.

## Verification

```sh
npm run typecheck
npm test
npm run test:ui
```

Unit and fixture integration tests cover profile resolution, version reservations, encrypted storage boundaries, snapshots, profile validation, secret redaction, process cancellation, queue recovery, AAB metadata, Apple version matching, and Google draft/ambiguous-upload behavior. Electron UI tests exercise actual IPC, project import, profile controls, migration, navigation, keyboard dialogs, and build errors. Additional tests cover native notification routing, comparison, metadata previews and uncertain writes, encrypted backup/restore rollback and counter preservation, artifact integrity and reuse, and simulator/device installation commands. The desktop workflow test exports and restores an encrypted backup through real IPC.

Real signed builds and store acceptance are a separate validation step. They require your own store accounts, app records, signing credentials, and compatible native toolchains. Fixture tests do not establish live acceptance for a newly imported app. Local acceptance reports and account diagnostics are intentionally excluded from this repository.

`node scripts/acceptance.mjs` runs type checking and unit tests. Add `--ui` to include Electron fixture tests; these use isolated temporary projects and do not sign in to real accounts.

## Setup diagnostics and regression replay

Every account-setup run writes an owner-only directory under `~/Library/Application Support/Local Build Desk/diagnostics/accounts`. **Open redacted diagnostics** in the account window reveals the current run. The latest 20 sessions are retained.

`events.jsonl` correlates navigation and redirects, request method/status/timing, JavaScript failures, passkey outcome/error names, cookie persistence metadata, detected page states, attempted control targets, and verified transitions. It deliberately excludes request/response bodies, authorization headers, cookie values, password/MFA field values, and private-key contents. Authentication console/exception text is omitted. URL query values are omitted.

State changes, actions, failures, and timeouts also save sanitized HTML plus a semantic control inventory. Scripts, inline event handlers, hidden inputs, entered values, authentication-page contents, and sensitive text are removed. These files preserve the structure needed to reproduce selectors without retaining raw login pages or executable JavaScript. Do not treat diagnostics as a raw HAR or browser-profile export.

The test fixtures in `tests/fixtures/apple` come from sanitized live Apple pages. The Electron replay test uses those structures with mocked provider responses to cover redirects, the unlabeled Add button, searchable role selection, the single key-generation approval, automatic download, Team ID lookup, and connection verification. It asserts one generation request, private download permissions and cleanup, and reuse of the verified encrypted connection after restart. An additional replay simulates a 503 response during key creation and proves retry and restart never send a duplicate request. Failed replay tests retain diagnostics in their Playwright output directory.

```sh
npm test
npm run build
npx playwright test tests/ui/account-replay.spec.ts
```

Setup stores nonsecret progress separately from the provider's persistent browser session, allowing a downloaded key and discovered IDs to be reused after restart. Apple may still require sign-in again. A submitted key-generation request is recorded and is never blindly repeated after a timeout or restart.

## CI and arbitrary checkouts

The shared engine defaults to **one iOS and one Android job at the same time**. Each job gets its own source snapshot, output folder, temporary signing keychain, and credential context. Shared dependency/native caches and macOS keychain/profile changes are locked. Configure 1–8 slots per platform with `--ios-concurrency` / `--android-concurrency`, `IOS_SUBMIT_IOS_CONCURRENCY` / `IOS_SUBMIT_ANDROID_CONCURRENCY`, or `concurrency` in the invocation config. These are engine-wide limits while that instance runs. A Forgejo runner also needs capacity ≥2 to dispatch two jobs concurrently.

```sh
ios-submit build --settings-from SAVED_PROJECT_ID --source /ci/app-ios --platform ios --profile production --auto-submit --wait
ios-submit build --settings-from SAVED_PROJECT_ID --source /ci/app-android --platform android --profile production --auto-submit --wait
ios-submit doctor --settings-from SAVED_PROJECT_ID --source /ci/app-ios --platform ios
ios-submit inspect --source /any/checkout --platform android
ios-submit build --source /any/checkout --config /runner/ios-submit.json --platform ios --build-number 90
```

`--project` accepts a saved ID/path or an arbitrary source checkout. `--settings-from` explicitly requires a saved template; `--source` chooses different code. Build/doctor/inspect do not register new projects or update template settings. Install the checkout’s npm dependencies first so its installed Expo tooling can evaluate dynamic configuration. Native compilation, hooks and prebuild use the snapshot. A headless CLI owner stays alive for forwarded requests and queued/running jobs even when its own command fails; each client streams its own output and returns its own exit code. CLI runs do not create Dock icons. Ctrl-C in the owning command cancels its own build and returns 130 after other clients finish; it does not cancel their jobs.

Settings precedence is **flags > environment > configuration > stored template**. Use `--config FILE` (default `SOURCE/ios-submit.json`) with `{ "settings": { ... } }`. Every `ProjectSettings` field supports `--set name=value` and `IOS_SUBMIT_UPPER_SNAKE_CASE`, for example `IOS_SUBMIT_XCODE_PATH`, `IOS_SUBMIT_MINIMUM_IOS_SDK`, `IOS_SUBMIT_JAVA_HOME`, `IOS_SUBMIT_ANDROID_SDK`, `IOS_SUBMIT_BUILD_DIRECTORY`, `IOS_SUBMIT_ANDROID_SDK_LICENSE_ACCEPTED=true`, and `IOS_SUBMIT_PLAY_AUTO_ROLLOUT=false`. Common fields also have dedicated flags (`--xcode`, `--ios-sdk`, `--minimum-ios-sdk`, `--java-home`, `--android-sdk`, `--track`, `--play-auto-rollout`, `--asc-app-id`). `IOS_SUBMIT_SOURCE`, `IOS_SUBMIT_SETTINGS_FROM`, and `IOS_SUBMIT_CONFIG` select the invocation. CLI options never alter the global Xcode selection.

### Credentials without the app vault

Supply a `credentials` object in the config, `--credential-config FILE`, or `IOS_SUBMIT_CREDENTIALS_JSON`. Refer to secrets by environment variable or temporary path; keep only references in committed files:

```json
{
  "settings": {
    "minimumIosSdk": "27.2",
    "ascAppId": "123456789",
    "track": "internal"
  },
  "concurrency": { "ios": 1, "android": 1 },
  "credentials": {
    "apple": {
      "keyId": { "env": "ASC_KEY_ID" },
      "issuerId": { "env": "ASC_ISSUER_ID" },
      "teamId": { "env": "ASC_TEAM_ID" },
      "privateKey": { "env": "ASC_KEY_P8" }
    },
    "ios": {
      "p12": { "base64Env": "IOS_DIST_P12_BASE64" },
      "password": { "env": "IOS_DIST_P12_PASSWORD" },
      "profiles": []
    },
    "google": { "serviceAccount": { "env": "PLAY_SERVICE_ACCOUNT_JSON" } },
    "android": {
      "keystore": { "base64Env": "ANDROID_KEYSTORE_BASE64" },
      "storePassword": { "env": "ANDROID_KEYSTORE_PASSWORD" },
      "keyPassword": { "env": "ANDROID_KEY_PASSWORD" },
      "alias": { "env": "ANDROID_KEY_ALIAS" }
    }
  },
  "environment": { "BUILD_SECRET": { "env": "BUILD_SECRET" } }
}
```

Include only the credential kinds required by that platform. An Apple API key plus an existing P12 can fetch/create matching profiles when `profiles` is empty. CI requires the existing certificate/private key; it never silently replaces signing identities. Offline builds can provide P12+profiles without an API key. References accept `{ "env": "NAME" }`, `{ "base64Env": "NAME" }`, `{ "file": "relative-or-absolute-path" }`, and `{ "fileEnv": "PATH_VARIABLE" }`. Binary values become base64 in memory; files referenced from configs resolve relative to the config file. `environment` values also accept references; `IOS_SUBMIT_ENVIRONMENT_JSON` overrides them.

Convenience environment variables avoid writing a config for credentials:

| Kind        | Variables (prefix each with `IOS_SUBMIT_`)                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| Apple       | `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_TEAM_ID`, `ASC_KEY_P8`                                                                  |
| iOS signing | `IOS_P12_BASE64` or `IOS_P12_PATH`, `IOS_P12_PASSWORD`, optional `IOS_PROFILES_BASE64` / `IOS_PROFILES_PATHS` (JSON arrays) |
| Google      | `GOOGLE_JSON`, `GOOGLE_JSON_BASE64`, or `GOOGLE_JSON_PATH`                                                                  |
| Android     | `ANDROID_KEYSTORE_BASE64` or `ANDROID_KEYSTORE_PATH`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_PASSWORD`, `ANDROID_KEY_ALIAS` |

The Apple P8 also accepts `_BASE64` / `_PATH` suffixes. Explicit credentials disable the app’s vault by default (`--no-keychain` or `IOS_SUBMIT_NO_KEYCHAIN=true` makes this explicit). `--use-keychain` permits mixing invocation and stored credentials. This concerns Local Build Desk’s encrypted vault: iOS signing still uses a temporary macOS signing keychain. Invocation secrets, including Apple key IDs, are redacted from output and are never written into the project/job records or encrypted vault. Only `IOS_SUBMIT_*` and explicitly referenced variables cross the owner-only CLI socket; unrelated client environment values are excluded. Temporary signing files are deleted after use. Reprovide credentials to `submit`, `status --job`, or `reconcile --job` after an app restart; the app fails clearly instead of attempting Keychain access for a previous ephemeral job.

### Counters and inspection

The database remains authoritative across desktop and CI checkouts. Number leases are reserved in an atomic SQLite transaction. Failed/cancelled/interrupted native builds release uncommitted leases. A successful build-only artifact keeps its lease; reaching upload commits the number permanently, including uncertain upload outcomes. Released gaps above the committed/store floor can be reused; higher uploads can make older unuploaded artifacts stale. `--build-number N` (or `IOS_SUBMIT_BUILD_NUMBER`) explicitly reserves N, rejects collisions/stale numbers, and can initialize a new identity. Legacy counters are never lowered. `versions` reports both the committed floor and highest outstanding reservation.

Use `status`, `status --job ID`, `logs --job ID`, `inspect`, and `versions` for supported inspection; direct SQL/schema edits are unnecessary. The store checkpoints its WAL on clean shutdown so a read-only SQLite connection can open the self-contained database afterward. While the app is running, read the live WAL with a normal read-only SQLite connection or use the CLI socket; do not copy only `desk.sqlite` for backups while writes are active.

## Guided Google provisioning

**Guided setup → Android / Play → Connect account** opens Google inside Local Build Desk. Select an existing Cloud project, or enter an ID and select **Create a new Cloud project**. The guide prepares project/account forms, enables the Android Publisher and IAM APIs, reuses a matching `local-build-desk` service account, and prepares a JSON key download. A scoped approval appears before creating Cloud resources and credentials. The key is encrypted immediately; a temporary downloaded copy is removed even while Play permissions are still pending. The existing project connection stays selected until the new credential verifies access to that exact Android package.

The guide then navigates Play Console’s developer-account selection and Users and permissions. It fills the service-account email, selects the exact app package, and prepares only **View app information** and **Release apps to testing tracks**. It refuses account-wide, financial, production, user-management, or additional-app access and asks for a separate approval before submitting the invitation. The same app-scoped connection supports the selected internal rollout/draft behavior; setup does not change `playAutoRollout`.

For a new Play app, **Prepare a new Play app record** fills the app name and pauses for language, pricing, declarations, and Google’s final creation step. Enrollment, payments, identity checks, agreements, organization restrictions, and any required first console upload remain visible user steps. Google sign-in/MFA stays in the provider page. If Google rejects the embedded browser, the guide explains that boundary; the **Google Cloud CLI fallback** uses Google’s supported external-browser sign-in. It never copies browser cookies or disables organization policy.

Submitted project/account/key/invitation requests are recorded before clicking. An ambiguous key request is never automatically repeated, including after restart. Retry checks the resulting page, while approvals remain bound to the selected project, service account, developer account, and app. Network status, JavaScript errors, action candidates, and sanitized DOM snapshots are recorded locally; passwords, MFA values, downloaded private keys, cookies, and response bodies are excluded. Replay tests cover provisioning, app-scoped approval, fresh project creation, interrupted downloads, and restart recovery. New-key authentication retries automatically for up to three minutes during Google’s activation window, without creating another key. The Play permission grant has a separate app-scoped approval gate; completion is recorded only after the new credential can access the intended Android package. Enrollment, agreements and any required first console upload still need the account owner.

Build logs follow the tail only while at least 90% of the panel is visible and the reader is near its bottom. Appending logs scrolls only that panel. Hidden/sliver-visible panels, filtered logs, and scrolling up to read earlier output pause automatic following.

### Store records, capability assignments, and the first Play upload

Guided setup now includes **Store app record & first upload**. Enter the store name, language and SKU (Apple), or App/Game and Free/Paid (Play), once. The app prepares the provider form in its own sandboxed browser and shows a scoped approval before creating a record. Apple records are reused by bundle ID; Play records can be associated from the exact package on a dashboard or app-list row. Sign-in/MFA, enrollment and agreement/declaration acceptance remain visible owner steps. Apple documents app-record creation as a [website operation](https://developer.apple.com/documentation/appstoreconnectapi/apps); Google documents standard Play App Signing enrollment as a [console operation](https://developers.google.com/android-publisher/api-ref/rest/v3/appsigning/enrollApp).

For a new Play app, run signing setup with **New app**, use **Build first AAB locally**, select the successful artifact, and choose **Set up first Play upload**. This local build does not auto-submit. The browser opens internal testing, pauses for any App Signing agreement, attaches the approved exact AAB, and saves a draft. It never selects a rollout or production action. The engine rechecks the artifact's project, package, version, size and checksum and commits its version reservation before file attachment. Completion requires Google to report the same AAB checksum and version in an internal draft. A pending encrypted service-account key is supported; if the saved draft still needs app permissions, the Google permission guide opens and verification resumes after access is approved. Existing apps keep their normal upload and rollout settings.

Console editor sessions block conflicting API edits for the same credential/app, including after restart. Closing an editor before file attachment releases this guard. Once attachment starts, its durable marker prevents automatic reattachment after interruption or an ambiguous result. Resume the console session and save the exact version as a draft before API reconciliation. Unknown app/account pages, multiple file inputs and mismatched identities stop automation. Upload/processing steps show elapsed time and an indeterminate progress indicator when browser byte counts are unavailable.

**Assign iCloud containers & App Groups** reads explicit identifiers from generated entitlements, prepares their portal assignments, preserves other checked identifiers, and requests approval before registration or saving. It then creates a profile when no valid matching profile exists and validates profiles against the app's entitlements. A usable existing signing certificate is required; this capability-only flow does not silently generate a new private key. Unrecognized portal controls and unsupported configurations remain actionable handoffs.

**Create an internal TestFlight group** lists existing eligible App Store Connect teammates who have access to the exact app. Review the group and selected recipients before the final creation/invitation action. New groups have public links and all-build access disabled; reused groups retain their existing settings and builds. No App Store Connect team roles are added or expanded. Persistent request journals reconcile uncertain group/invitation requests before any repeat. The selected group receives future builds through the existing post-processing distribution path.

Validation distinguishes replay coverage from live acceptance: fixture tests exercise creation, legal handoffs, capability confirmation/profile verification, exact file attachment, internal-draft completion, interrupted-upload recovery, and existing-dashboard redirects. Creation of a genuinely new live app, a real first console upload, capability changes, and new tester invitations still need a chosen new app and explicit account actions; replay success is not store acceptance.

## Repository privacy and portability

Credentials, provider sessions, local databases, acceptance evidence, native artifacts, downloaded toolchains, local invocation configuration, and `.env` files stay outside Git. Import your own Expo project and signing credentials through the app; sample identifiers and paths in tests are synthetic. The bundled Apple WWDR intermediate is a public Apple certificate, not a signing private key.

Toolchain paths come from project settings, environment variables, standard macOS locations, and discovery. Existing Xcode installations use their installed device SDK unless you configure a minimum or exact SDK. Automatic Xcode download requires an explicit target SDK; no particular SDK release is imposed on new projects. Android SDK/NDK packages are inferred from the imported project's React Native/Gradle configuration.

Do not commit `ios-submit.json` if it contains local paths or credential material. CI configuration should use environment references as shown above. Publishing and notarizing distributable desktop binaries use the separate signed-release setup below; local packaging stays credential-free.

## Signed GitHub releases

`.github/workflows/ci.yml` checks pull requests and main with isolated tests and an unsigned local package. It has no signing credentials. `.github/workflows/release.yml` builds a **Developer ID signed, notarized and stapled** ARM64 macOS app for Apple Silicon, then publishes a GitHub Release only after it passes verification. Source/version validation runs first, then tests and signing/notarization run in parallel. Publication requires both jobs to succeed. Actions are pinned to commits. No signing workflow runs on pull requests.

Version 0.1.2 is the last universal release for Intel Macs. New releases target Apple Silicon, as [Xcode 27 requires Apple Silicon](https://developer.apple.com/documentation/Xcode-Release-Notes/xcode-27-release-notes).

CI reuses npm, Electron, and electron-builder download caches. Credentials and signed outputs are excluded from caches. ARM64 packaging avoids the Intel download/build and universal merge.

Configure a GitHub environment named **release**, limited to the `main` branch and `v*` tags. Set these environment variables:

| Variable                 | Value                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `MACOS_SIGNING_IDENTITY` | Your Developer ID Application name without its prefix, such as `Example Developer (TEAM123456)`, or its certificate SHA-1 fingerprint |
| `MACOS_TEAM_ID`          | The 10-character Apple developer team ID                                                                                              |

Set these **environment secrets**, never repository files:

| Secret                         | Value                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64 of a password-protected P12 containing your **Developer ID Application certificate and its private key** |
| `MACOS_CERTIFICATE_PASSWORD`   | The P12 export password                                                                                         |
| `APPLE_API_KEY_P8_BASE64`      | Base64 of the notarization team API `.p8` key                                                                   |
| `APPLE_API_KEY_ID`             | The API key ID                                                                                                  |
| `APPLE_API_ISSUER`             | The team API issuer UUID                                                                                        |

An iOS Apple Distribution certificate does not sign desktop releases. Prefer a dedicated notarization API key with the least privilege Apple accepts; a provisioning Admin key is unnecessary for notarization. GitHub encrypts the secrets, but trusted release workflow code can use them, so review changes to release scripts and workflows before pushing version tags. Revoke/rotate CI credentials in Apple and replace the GitHub secrets if access changes. No existing certificates or API keys need to be revoked to enable releases.

For example, after exporting the chosen certificate from Keychain Access, set binary secrets from private local files without printing their contents:

```sh
base64 -i /secure/path/DeveloperID.p12 | gh secret set MACOS_CERTIFICATE_P12_BASE64 --repo OWNER/REPO --env release
gh secret set MACOS_CERTIFICATE_PASSWORD --repo OWNER/REPO --env release
base64 -i /secure/path/AuthKey.p8 | gh secret set APPLE_API_KEY_P8_BASE64 --repo OWNER/REPO --env release
gh secret set APPLE_API_KEY_ID --repo OWNER/REPO --env release
gh secret set APPLE_API_ISSUER --repo OWNER/REPO --env release
```

The remaining `gh secret set` commands prompt for values. Keep exported key files private and remove temporary plaintext copies after upload. The signing job restores a temporary keychain and a mode-600 `.p8` file, deletes them even if the build fails, and never uploads either as an artifact. Missing credentials or the wrong signing identity fail the release; unsigned/ad-hoc packages are never substituted.

To publish, bump `package.json` and its lockfile, commit, and push a matching version tag (`v0.1.0` for version `0.1.0`). Alternatively run **Signed macOS release** from `main` with the matching tag through workflow dispatch. An existing tag must point to the exact checked-out source commit. A version mismatch stops before credentials are used. The workflow checks signatures, team, hardened runtime, timestamps, bundle identity/version, that the executable is ARM64, notarization tickets, Gatekeeper acceptance and ZIP contents. The DMG itself is separately notarized and stapled. Releases include one ARM64 DMG and ZIP, the ZIP blockmap, a SHA-256 file and a `latest-mac.yml` update feed.

Installed signed builds update themselves from these releases with `electron-updater`. The app checks 15 seconds after launch and every four hours, downloads a newer release in the background (only the changed blocks when a blockmap is available), and shows **Restart to update** in the top bar once the download is ready. The update installs when you choose to restart or on the next quit. Restarting is refused while builds are queued or running. The top-bar download button checks on demand. Prerelease tags are offered only to apps already running a prerelease. Unpackaged, test and `LOCAL_BUILD_DESK_DISABLE_UPDATES=1` runs never check. Squirrel.Mac accepts only updates signed by the same Developer ID team.

The publisher creates a draft with all of these files and publishes it only after verifying the checksums. It never overwrites an existing release. If a publication is interrupted and leaves a draft, inspect that draft and its assets before deleting/retrying or bumping the version. Signing/notarization failures remain failed workflow runs; no public release is created.

`npm run package` remains unsigned and credential-free for local development. `npm run release:mac` builds the ARM64 app with the separate strict `electron-builder.release.cjs` configuration and requires the release signing/notarization environment. GitHub release credentials do not contain any imported Expo project's signing keystore or provisioning profiles.
