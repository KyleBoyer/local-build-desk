import type {
  MonitorConfig,
  MonitorStatus,
  MonitorPairing,
} from "../mobile/types";
import type { CertificateFiles } from "../mobile/tls";
import type {
  StoreReleaseSnapshot,
  StoreReleaseDetail,
} from "./store-release-types";
export type Platform = "ios" | "android";
export type ProjectType = "expo" | "capacitor" | "native-ios";
export interface LocalBuildProfile {
  extends?: string;
  configuration?: string;
  distribution?: "store" | "internal";
  simulator?: boolean;
  debug?: boolean;
  autoIncrement?: boolean;
  env?: Record<string, string>;
  scheme?: string;
  androidVariant?: string;
  buildType?: "apk" | "app-bundle";
}
export interface XcodeContainer {
  path: string;
  kind: "project" | "workspace";
}
export interface IOSTarget {
  name: string;
  project: string;
  configuration: string;
  bundleId: string;
  version: string;
  buildNumber: string;
  productType: "application" | "extension";
  entitlements: Record<string, any>;
  entitlementsFile?: string;
  infoPlist?: string;
  deploymentTarget?: string;
}
export interface IOSBuildTarget {
  container: XcodeContainer;
  scheme: string;
  configuration: string;
  targets: IOSTarget[];
}
export type Severity = "error" | "warning" | "info";
export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  field?: string;
}
export interface Profile {
  debugBuild?: boolean;
  name: string;
  distribution: "store" | "internal";
  developmentClient: boolean;
  simulator: boolean;
  env: Record<string, string>;
  autoIncrement: boolean | string;
  buildType: "app-bundle" | "apk";
  configuration: string;
  scheme?: string;
  gradleCommand?: string;
  resourceClass?: string;
  raw: Record<string, unknown>;
  issues: Issue[];
}
export interface ProjectSettings {
  releaseChecks?: import("./release-check-schema").ReleaseCheckPolicy;
  projectType?: ProjectType;
  appDirectory?: string;
  iosTarget?: string;
  configuration?: string;
  webBuildScript?: string;
  iosDependencyManager?: "SPM" | "CocoaPods";
  androidModule?: string;
  localProfiles?: Record<string, LocalBuildProfile>;
  nodePath?: string;
  javaHome?: string;
  androidSdk?: string;
  androidSdkLicenseAccepted?: boolean;
  xcodePath?: string;
  buildDirectory?: string;
  minimumIosSdk?: string;
  pendingXcodePath?: string;
  iosSdk?: string;
  workspace?: string;
  scheme?: string;
  nativeMode?: "auto" | "generated" | "maintained";
  appleConnectionId?: string;
  iosSigningId?: string;
  androidSigningId?: string;
  googleConnectionId?: string;
  envCredentialId?: string;
  track?: string;
  /** Roll internal-track uploads out to testers. Missing means true. */
  playAutoRollout?: boolean;
  /** "What's new" text attached to the uploaded Play release. */
  playReleaseNotes?: string;
  /** Language for playReleaseNotes. Missing means en-US. */
  playReleaseNotesLanguage?: string;
  /** App Store listing JSON (relative to the project) used by `ios-submit listing`. */
  appStoreListing?: string;
  ascAppId?: string;
  setupAppleComplete?: boolean;
  testFlightGroupId?: string;
  testFlightGroupName?: string;
}
export type ToolName =
  "node" | "cocoapods" | "xcodegen" | "android" | "gcloud" | "ios-platform";
export interface Project {
  usesCocoaPods?: boolean;
  usesXcodeGen?: boolean;
  type?: ProjectType;
  platforms?: Platform[];
  id: string;
  path: string;
  name: string;
  bundleId?: string;
  packageName?: string;
  version?: string;
  sdk?: string;
  profiles: string[];
  createdAt: string;
  settings: ProjectSettings;
}
export interface Inspection {
  usesCocoaPods?: boolean;
  usesXcodeGen?: boolean;
  type?: ProjectType;
  platforms?: Platform[];
  appDirectory?: string;
  containers?: XcodeContainer[];
  schemes?: string[];
  iosTarget?: IOSBuildTarget;
  capacitor?: {
    version: string;
    webDir: string;
    webBuildScript: string;
    iosPath: string;
    androidPath: string;
    dependencyManager: "SPM" | "CocoaPods";
    plugins: string[];
  };
  name: string;
  version: string;
  bundleId?: string;
  packageName?: string;
  sdk?: string;
  profiles: string[];
  config: Record<string, any>;
  eas: Record<string, any>;
  packageManager: "npm" | "yarn" | "pnpm" | "bun";
  native: Record<Platform, boolean>;
  issues: Issue[];
}
export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "needs-attention";
export type Stage =
  | "queued"
  | "preflight"
  | "snapshot"
  | "install"
  | "configure"
  | "testing"
  | "screenshots"
  | "signing"
  | "compile"
  | "export"
  | "verify"
  | "upload"
  | "processing"
  | "complete";
export interface Artifact {
  iosSdk?: string;
  id: string;
  jobId: string;
  platform: Platform;
  kind: "ipa" | "aab" | "apk" | "app" | "archive" | "dsym";
  path: string;
  sha256: string;
  size: number;
  bundleId: string;
  version: string;
  buildNumber: string;
}
export interface Submission {
  baselineReleases?: unknown[];
  /** The upload committed a completed internal release instead of a draft. */
  rollout?: boolean;
  /** ios-submit drafts that the rollout release replaced. */
  supersededVersionCodes?: string[];
  lastCheckedAt?: string;
  state:
    | "uploading"
    | "uploaded"
    | "processing"
    | "accepted"
    | "rejected"
    | "uncertain"
    | "draft";
  destination: string;
  externalId?: string;
  message?: string;
  uploadedAt?: string;
}
export interface Checkpoint {
  stage: Stage;
  state: "running" | "complete" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  detail?: string;
}
export interface CapturedScreenshot {
  name: string;
  path: string;
  sha256: string;
  size: number;
  width: number;
  height: number;
  displayType?: string;
  device: string;
  runtime: string;
}
export interface CheckRun {
  device: string;
  runtime?: string;
  status: "passed" | "failed";
  resultBundle?: string;
  attachments?: string;
  passed?: number;
  failed?: number;
  skipped?: number;
  detail?: string;
}
export interface ValidationResult {
  state: "running" | "passed" | "failed" | "cancelled" | "interrupted";
  fingerprint: string;
  sourceHash: string;
  policyDigest: string;
  configuration: string;
  startedAt: string;
  finishedAt?: string;
  mode: "all" | "tests" | "screenshots";
  runs: CheckRun[];
  screenshots: CapturedScreenshot[];
  error?: string;
}
export interface ReadinessItem {
  id: string;
  title: string;
  status: "ready" | "blocked" | "warning" | "pending";
  detail: string;
  action?: string;
}
export interface ReleaseReadiness {
  projectId: string;
  jobId?: string;
  destination: "testflight" | "appstore";
  checkedAt: string;
  items: ReadinessItem[];
  canUpload: boolean;
  delivery: {
    built: boolean;
    uploaded: boolean;
    processed: boolean;
    assigned: boolean;
    review?: string;
  };
}
export interface Job {
  checkpoints?: Checkpoint[];
  validation?: ValidationResult;
  checksMode?: "all" | "tests" | "screenshots";
  resumedFrom?: string;

  restoredFromBackup?: boolean;
  reuseFingerprint?: string;
  nativeReuseFingerprint?: string;
  facts?: BuildFacts;
  projectSnapshot?: Project;
  requiresInvocationCredentials?: boolean;
  connectionFingerprint?: string;
  requestedBuildNumber?: number;
  versionReservation?: "reserved" | "committed" | "released";
  stageStartedAt?: string;
  progress?: WorkProgress;
  toolchain?: {
    developerDirectory: string;
    xcodeVersion: string;
    iosSdk: string;
  };
  id: string;
  projectId: string;
  projectName: string;
  platform: Platform;
  profile: string;
  status: JobStatus;
  stage: Stage;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  autoSubmit: boolean;
  clean: boolean;
  buildNumber?: string;
  version?: string;
  bundleId?: string;
  fingerprint?: string;
  artifactId?: string;
  submission?: Submission;
  parentJobId?: string;
  storeEligible?: boolean;
  kind: "build" | "submit" | "test";
}
export interface LogEntry {
  time: string;
  stage: Stage;
  text: string;
}
export interface WorkProgress {
  kind: "upload" | "download" | "work" | "processing";
  label: string;
  startedAt: string;
  updatedAt: string;
  completedBytes?: number;
  totalBytes?: number;
  percent?: number;
  detail?: string;
}
export type ProgressUpdate = Omit<WorkProgress, "startedAt" | "updatedAt">;
export interface Check {
  name: string;
  status: "ok" | "error" | "warning";
  detail: string;
  action?: string;
}
export interface CredentialSummary {
  id: string;
  kind: Credential["kind"];
  label: string;
  detail: string;
  createdAt: string;
}
export type Credential =
  | {
      kind: "apple";
      label: string;
      keyId: string;
      issuerId: string;
      teamId: string;
      privateKey: string;
    }
  | { kind: "google"; label: string; serviceAccount: Record<string, any> }
  | {
      kind: "ios";
      label: string;
      p12: string;
      password: string;
      profiles: string[];
    }
  | {
      kind: "android";
      label: string;
      keystore: string;
      storePassword: string;
      alias: string;
      keyPassword: string;
    }
  | { kind: "environment"; label: string; values: Record<string, string> }
  /** A saved Apple ID or Google account sign-in, filled into their sign-in pages. */
  | {
      kind: "login";
      label: string;
      provider: "apple" | "google";
      username: string;
      password: string;
    };
export interface BuildRequest {
  checksMode?: "all" | "tests" | "screenshots";
  validationOnly?: boolean;
  projectId: string;
  platform: Platform | "all";
  profile: string;
  autoSubmit?: boolean;
  clean?: boolean;
}
export interface DeskState {
  concurrency?: Record<Platform, number>;
  projects: Project[];
  jobs: Job[];
  credentials: CredentialSummary[];
  artifacts: Artifact[];
  dataPath: string;
}
export interface UpdateStatus {
  state:
    | "disabled"
    | "idle"
    | "checking"
    | "current"
    | "downloading"
    | "ready"
    | "error";
  currentVersion: string;
  version?: string;
  percent?: number;
  error?: string;
}
export interface DeskEvent {
  type:
    "state" | "log" | "update" | "focus-job" | "operation-progress" | "monitor";
  operationId?: string;
  progress?: WorkProgress;
  jobId?: string;
  entry?: LogEntry;
  update?: UpdateStatus;
}
export interface DesktopAPI {
  mobileStatus(): Promise<MonitorStatus>;
  configureMobileMonitor(
    config: MonitorConfig,
    files?: CertificateFiles,
  ): Promise<MonitorStatus>;
  mobilePairing(): Promise<MonitorPairing>;
  revokeMobileDevice(id?: string): Promise<MonitorStatus>;
  copyMobileLink(): Promise<void>;
  storeReleases(projectId: string): Promise<StoreReleaseSnapshot>;
  storeReleaseDetails(
    projectId: string,
    releaseId: string,
    locale?: string,
  ): Promise<StoreReleaseDetail>;
  storeImagePreview(projectId: string, imageId: string): Promise<string>;
  checkTargets(projectId: string): Promise<{
    devices: { id: string; name: string }[];
    runtimes: { id: string; name: string; version: string }[];
    schemes: string[];
    testPlans: string[];
  }>;
  runChecks(
    projectId: string,
    profile: string,
    mode: "all" | "tests" | "screenshots",
  ): Promise<Job[]>;
  useScreenshots(jobId: string): Promise<string>;
  screenshotPreview(jobId: string, index: number): Promise<string>;
  readiness(
    projectId: string,
    destination?: "testflight" | "appstore",
  ): Promise<ReleaseReadiness>;
  resume(jobId: string): Promise<Job[]>;
  readStoreStatus(projectId: string): Promise<{
    version: string;
    state: string;
    editable: boolean;
    buildNumber?: string;
  }>;

  readRelease(
    jobId: string,
    draft: ReleaseDraft,
  ): Promise<Record<string, string>>;
  relinkArtifact(artifactId: string, path: string): Promise<Artifact>;
  installTargets(
    artifactId: string,
  ): Promise<{ targets: InstallTarget[]; notes: string[] }>;
  installArtifact(artifactId: string, targetId: string): Promise<void>;
  cancelInstall(artifactId: string): Promise<void>;
  findReusableBuilds(
    projectId: string,
    profile: string,
    platform: Platform,
  ): Promise<ReusableBuild[]>;
  useReusableBuild(
    projectId: string,
    profile: string,
    platform: Platform,
    artifactId: string,
    upload: boolean,
  ): Promise<Job>;
  exportBuildSettings(projectId: string): Promise<boolean>;
  importBuildSettings(projectId: string): Promise<void>;
  exportBackup(password: string): Promise<string | undefined>;
  previewBackup(password: string): Promise<BackupPreview | undefined>;
  restoreBackup(
    token: string,
    mappings: Record<string, string>,
    resetMachinePaths?: boolean,
  ): Promise<{ projects: number; credentials: number; jobs: number }>;
  prepareRelease(jobId: string, draft: ReleaseDraft): Promise<ReleasePreview>;
  applyRelease(token: string): Promise<string>;
  savePlayNotes(projectId: string, text: string, locale: string): Promise<void>;
  readCompliance(projectId: string, listing?: string): Promise<ComplianceView>;
  saveCompliance(
    projectId: string,
    listing: string,
    answers: Omit<import("./app-store-compliance").Compliance, "attestation">,
    attestBy?: string,
  ): Promise<ComplianceView>;
  releaseNoteDraft(jobId: string): Promise<{ text: string; note: string }>;
  notificationSettings(
    enabled?: boolean,
  ): Promise<{ enabled: boolean; supported: boolean; error?: string }>;
  testNotification(): Promise<void>;
  compareBuild(jobId: string): Promise<BuildComparison>;
  xcodeInstallations(
    projectId: string,
  ): Promise<import("./xcode-toolchain").XcodeInstallation[]>;
  installXcode(
    projectId: string,
    archive: string,
    acceptLicense?: boolean,
  ): Promise<import("./xcode-toolchain").XcodeInstallResult>;
  openXcodeDownload(projectId: string): Promise<void>;
  approveXcodeLicense(): Promise<void>;
  state(): Promise<DeskState>;
  choose(options: {
    kind: "directory" | "file" | "files";
    extensions?: string[];
  }): Promise<string[]>;
  projectApplications(
    path: string,
  ): Promise<import("./project-discovery").ProjectApplication[]>;
  importProject(path: string, settings?: ProjectSettings): Promise<Project>;
  inspect(
    projectId: string,
    profile?: string,
    platform?: Platform,
  ): Promise<{ inspection: Inspection; profile?: Profile }>;
  saveSettings(projectId: string, settings: ProjectSettings): Promise<void>;
  doctor(projectId?: string): Promise<Check[]>;
  build(request: BuildRequest): Promise<Job[]>;
  cancel(jobId: string): Promise<void>;
  retry(jobId: string): Promise<Job[]>;
  logs(jobId: string): Promise<LogEntry[]>;
  submit(artifactId: string): Promise<Job>;
  reconcile(jobId: string): Promise<void>;
  reveal(path: string): Promise<void>;
  saveCredential(input: Record<string, unknown>): Promise<CredentialSummary>;
  removeCredential(id: string): Promise<void>;
  validateConnection(id: string, projectId?: string): Promise<string>;
  migrate(
    projectId: string,
    input: {
      credentialsPath?: string;
      environmentPaths?: string[];
      iosBuildNumber?: number;
      androidBuildNumber?: number;
    },
  ): Promise<string[]>;
  seedCounter(
    projectId: string,
    platform: Platform,
    lastUsed: number,
  ): Promise<void>;
  createCertificate(
    connectionId: string,
    label: string,
  ): Promise<CredentialSummary>;
  registerDevice(
    connectionId: string,
    name: string,
    udid: string,
  ): Promise<string>;
  createProfile(
    connectionId: string,
    signingId: string,
    bundleId: string,
    type: "IOS_APP_STORE" | "IOS_APP_ADHOC" | "IOS_APP_DEVELOPMENT",
  ): Promise<string>;
  generateKeystore(
    projectId: string,
    label: string,
    alias: string,
    password: string,
  ): Promise<CredentialSummary>;
  prepareProject(
    projectId: string,
    request: SetupRequest,
  ): Promise<SetupReport>;
  setupLogs(projectId: string): Promise<LogEntry[]>;
  installTool(
    projectId: string,
    tool: ToolName,
    acceptAndroidLicense: boolean,
  ): Promise<void>;
  googleLogin(projectId: string): Promise<void>;
  createGoogleConnection(
    projectId: string,
    cloudProject: string,
  ): Promise<{
    email: string;
    connectionId: string;
    ready: boolean;
    message?: string;
  }>;
  openStoreSetup(projectId: string, request: StoreSetupRequest): Promise<void>;
  approveStoreSetup(): Promise<void>;
  testFlightUsers(
    projectId: string,
  ): Promise<{ id: string; email: string; name: string }[]>;
  configureTestFlight(
    projectId: string,
    request: { name: string; userIds: string[] },
  ): Promise<{ id: string; name: string }>;
  testFlightGroups(projectId: string): Promise<{ id: string; name: string }[]>;
  openAccountSetup(
    projectId: string,
    provider: AccountProvider,
    pendingGoogleConnectionId?: string,
  ): Promise<void>;
  accountState(): Promise<AccountSetupState>;
  revealAccountDiagnostics(): Promise<void>;
  retryAccountAutomation(): Promise<void>;
  accountNavigate(
    action:
      | "apple-api"
      | "apple-team"
      | "apple-enroll"
      | "google-cloud"
      | "google-play"
      | "back"
      | "reload",
  ): Promise<void>;
  updateAccountSetup(
    values: Partial<AccountSetupState> & {
      storeAppName?: string;
      googleCloudProject?: string;
      googleCreateProject?: boolean;
      googleDeveloperId?: string;
      googleRequestNewPlayApp?: boolean;
      googleStartSetup?: boolean;
    },
  ): Promise<void>;
  approveAccountKey(): Promise<void>;
  approveGoogleSetup(): Promise<void>;
  completeAccountSetup(): Promise<void>;
  closeAccountSetup(): Promise<void>;
  openExternal(url: string): Promise<void>;
  updateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  installUpdate(): Promise<void>;
  onEvent(listener: (event: DeskEvent) => void): () => void;
}

export interface BuildFacts {
  projectType?: ProjectType;
  nativeTarget?: string;
  targetEntitlements?: Record<string, Record<string, unknown>>;
  toolVersions?: Record<string, string>;
  sourceCommit?: string;
  sourceHash?: string;
  configuration: string;
  distribution: string;
  developmentClient: boolean;
  simulator: boolean;
  signing?: string;
  entitlements?: Record<string, unknown>;
  destination: string;
}
export interface BuildDifference {
  field: string;
  before: string;
  after: string;
  changed: boolean;
}
export interface BuildComparison {
  baselineId?: string;
  baselineLabel?: string;
  fields: BuildDifference[];
  note?: string;
}
export interface ReleaseDraft {
  destination: "testflight" | "appstore";
  locale: string;
  createVersion?: boolean;
  fields: {
    whatsNew?: string;
    description?: string;
    keywords?: string;
    promotionalText?: string;
    supportUrl?: string;
    marketingUrl?: string;
  };
}
export interface ReleasePreview {
  token: string;
  destination: ReleaseDraft["destination"];
  identity: string;
  version: string;
  buildNumber?: string;
  locale: string;
  createsVersion: boolean;
  changes: BuildDifference[];
}
export interface BackupPreview {
  token: string;
  createdAt: string;
  projects: { id: string; name: string; path: string }[];
  credentials: number;
  jobs: number;
  counters: number;
}
export interface ReusableBuild {
  job: Job;
  artifact: Artifact;
  match: "exact" | "native-development";
  alreadySubmitted: boolean;
}
export interface InstallTarget {
  id: string;
  kind: "ios-simulator" | "android-device" | "android-avd";
  name: string;
  available: boolean;
  detail: string;
}

export interface SetupRequest {
  platform: Platform;
  newApp: boolean;
  renewProfiles?: boolean;
  lastIosBuildNumber?: number;
  lastAndroidBuildNumber?: number;
}
export interface SetupReport {
  actions: string[];
  handoffs: {
    title: string;
    detail: string;
    url?: string;
    automation?: "record" | "capabilities" | "bootstrap";
  }[];
  ready: boolean;
}

export type AccountProvider = "apple" | "google";
export interface GoogleSetupState {
  cloudProject: string;
  createProject?: boolean;
  email?: string;
  developerId?: string;
  serviceUrl?: string;
  stage: "cloud" | "play";
  apiIndex?: number;
  pendingCredentialId?: string;
  keyImportedAt?: number;
  submitted: Record<string, string>;
  approval?: "cloud" | "play";
  approvedCloudScope?: string;
  approvedPlayScope?: string;
  requestNewPlayApp?: boolean;
}
export interface StoreSetupRequest {
  targetBundleId?: string;
  provider: AccountProvider;
  mode: "record" | "capabilities" | "bootstrap";
  appName: string;
  language: string;
  sku?: string;
  appType?: "app" | "game";
  pricing?: "free" | "paid";
  newApp?: boolean;
  artifactId?: string;
}
export interface StoreSetupState extends StoreSetupRequest {
  identity: string;
  identifiers?: string[];
  artifact?: {
    id: string;
    name: string;
    sha256: string;
    size: number;
    buildNumber: string;
    version: string;
  };
  appId?: string;
  developerId?: string;
  capabilityIndex?: number;
  lastUrl?: string;
  internalUrl?: string;
  connectionId?: string;
  consoleEditActive?: boolean;
  stage: "opening" | "preparing" | "uploading" | "verifying" | "complete";
  submitted: Record<string, string>;
  approval?: { action: string; scope: string; title: string; detail: string };
  /** The provider's message when it rejected the create form, e.g. a taken app name. */
  rejection?: string;
  /** A rejection the user already answered with a new name; it may linger on the form until resubmitted. */
  staleError?: string;
  /** When the create form was submitted, to tell a slow response from a stuck form. */
  createSubmittedAt?: number;
}
export interface AccountSetupState {
  google?: GoogleSetupState;
  activityStartedAt?: string;
  progress?: WorkProgress;
  purpose?: "connection" | "xcode" | "store";
  storeSetup?: StoreSetupState;
  requiredSdk?: string;
  xcodeApp?: string;
  xcodeLicenseRequired?: boolean;
  xcodeLicenseText?: string;
  xcodeLicenseApproved?: boolean;
  projectId: string;
  provider: AccountProvider;
  url: string;
  status: "working" | "needs-input" | "complete";
  message: string;
  issuerId: string;
  teamId: string;
  keyId: string;
  label: string;
  downloadedFile?: string;
  hideWhenWorking: boolean;
  approvalRequired?: boolean;
  keyGenerationSubmitted?: boolean;
  connectedCredentialId?: string;
  events: string[];
  diagnosticPath?: string;
}

/** A project's App Store compliance answers, read from its listing file. */
export interface ComplianceView {
  /** The listing file, relative to the project; missing until one is chosen. */
  listing?: string;
  compliance?: import("./app-store-compliance").Compliance;
  attested?: boolean;
  statements?: string[];
}
