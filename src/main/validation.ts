import { monitorConfigSchema } from "../mobile/config";
import { z } from "zod";
const text = z.string().max(4096),
  identifier = z.string().min(1).max(128),
  platform = z.enum(["ios", "android"]);
export { settingsSchema } from "../core/settings-schema";
import { settingsSchema } from "../core/settings-schema";
import { monetizationSchema } from "../core/monetization";
import {
  ageRatingSchema,
  appPrivacySchema,
  pricingSchema,
} from "../core/app-store-compliance";
const credential = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("apple"),
      label: text,
      keyPath: text,
      keyId: z.string().regex(/^[A-Za-z0-9]+$/),
      issuerId: z.string().uuid(),
      teamId: z.string().regex(/^[A-Za-z0-9]+$/),
    })
    .strict(),
  z.object({ kind: z.literal("google"), label: text, keyPath: text }).strict(),
  z
    .object({
      kind: z.literal("ios"),
      label: text,
      p12Path: text,
      password: text,
      profilePaths: z.array(text).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("android"),
      label: text,
      keystorePath: text,
      storePassword: text,
      alias: text,
      keyPassword: text,
    })
    .strict(),
  z
    .object({
      kind: z.literal("environment"),
      label: text,
      values: z.record(z.string(), z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("login"),
      label: text,
      provider: z.enum(["apple", "google"]),
      username: z.string().min(3).max(320),
      password: z.string().min(1).max(1024),
    })
    .strict(),
]);
export const methods = {
  readRelease: z.tuple([
    identifier,
    z
      .object({
        destination: z.enum(["testflight", "appstore"]),
        locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
        createVersion: z.boolean().optional(),
        fields: z.object({}).strict(),
      })
      .strict(),
  ]),
  relinkArtifact: z.tuple([identifier, text]),
  installTargets: z.tuple([identifier]),
  installArtifact: z.tuple([
    identifier,
    z
      .string()
      .min(1)
      .max(256)
      .regex(/^(?:sim|adb|avd):[A-Za-z0-9_.:-]+$/),
  ]),
  cancelInstall: z.tuple([identifier]),
  findReusableBuilds: z.tuple([identifier, text, platform]),
  useReusableBuild: z.tuple([
    identifier,
    text,
    platform,
    identifier,
    z.boolean(),
  ]),
  exportBuildSettings: z.tuple([identifier]),
  importBuildSettings: z.tuple([identifier]),
  exportBackup: z.tuple([z.string().min(12).max(1024)]),
  previewBackup: z.tuple([z.string().min(1).max(1024)]),
  restoreBackup: z.tuple([
    z.string().uuid(),
    z.record(z.string().min(1).max(128), text),
    z.boolean().optional(),
  ]),
  prepareRelease: z.tuple([
    identifier,
    z
      .object({
        destination: z.enum(["testflight", "appstore"]),
        locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
        createVersion: z.boolean().optional(),
        fields: z
          .object({
            whatsNew: z.string().max(4000).optional(),
            description: z.string().max(4000).optional(),
            keywords: z.string().max(100).optional(),
            promotionalText: z.string().max(170).optional(),
            supportUrl: z
              .union([z.literal(""), z.string().url().startsWith("https://")])
              .optional(),
            marketingUrl: z
              .union([z.literal(""), z.string().url().startsWith("https://")])
              .optional(),
          })
          .strict(),
      })
      .strict(),
  ]),
  applyRelease: z.tuple([z.string().uuid()]),
  savePlayNotes: z.tuple([
    identifier,
    z.string().max(500),
    z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
  ]),
  releaseNoteDraft: z.tuple([identifier]),
  readCompliance: z.tuple([identifier, text.optional()]),
  checkTargets: z.tuple([identifier]),
  runChecks: z.tuple([
    identifier,
    text,
    z.enum(["all", "tests", "screenshots"]),
    z.enum(["ios", "android", "all"]).optional(),
  ]),
  useScreenshots: z.tuple([identifier]),
  screenshotPreview: z.tuple([
    identifier,
    z.number().int().min(0).max(79),
    z.boolean().optional(),
  ]),
  readiness: z.tuple([
    identifier,
    z.enum(["testflight", "appstore"]).optional(),
  ]),
  resume: z.tuple([identifier]),
  mobileStatus: z.tuple([]),
  configureMobileMonitor: z.tuple([
    monitorConfigSchema,
    z.object({ certificatePath: text, keyPath: text }).strict().optional(),
  ]),
  mobilePairing: z.tuple([]),
  revokeMobileDevice: z.tuple([identifier.optional()]),
  copyMobileLink: z.tuple([]),
  readStoreStatus: z.tuple([identifier]),
  storeReleases: z.tuple([identifier, z.boolean().optional()]),
  storeReleaseDetails: z.tuple([
    identifier,
    identifier,
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{2,30}$/)
      .optional(),
    z.boolean().optional(),
  ]),
  storeImagePreview: z.tuple([identifier, z.string().uuid()]),
  signInAppStoreConnect: z.tuple([]),
  saveCompliance: z.tuple([
    identifier,
    z.string().min(1).max(1024),
    z
      .object({
        ageRating: ageRatingSchema.optional(),
        appPrivacy: appPrivacySchema.optional(),
        pricing: pricingSchema.optional(),
      })
      .strict(),
    z.string().min(2).max(100).optional(),
  ]),
  saveReleaseType: z.tuple([
    identifier,
    z.string().min(1).max(1024),
    z.enum(["MANUAL", "AFTER_APPROVAL", "SCHEDULED"]),
    z.string().max(64).optional(),
    z.boolean().optional(),
  ]),
  rolloutHealth: z.tuple([identifier, z.string().max(300)]),
  saveRolloutGuard: z.tuple([
    identifier,
    z
      .object({
        enabled: z.boolean(),
        maxCrashRate: z.number().gt(0).max(100),
        maxAnrRate: z.number().gt(0).max(100),
        minUsers: z.number().int().min(1).max(1000000),
      })
      .strict(),
  ]),
  setPhasedRelease: z.tuple([
    identifier,
    z.string().max(300),
    z.enum(["INACTIVE", "ACTIVE", "PAUSED", "COMPLETE"]),
  ]),
  readInbox: z.tuple([identifier, z.boolean().optional()]),
  replyInbox: z.tuple([
    identifier,
    z.string().max(300),
    z.string().min(1).max(5970),
  ]),
  markInbox: z.tuple([
    identifier,
    z.array(z.string().max(300)).max(2000),
    z.boolean(),
  ]),
  inboxCrashLog: z.tuple([identifier, z.string().max(300)]),
  promotionOptions: z.tuple([identifier, z.string().max(300)]),
  promoteRelease: z.tuple([
    identifier,
    z.string().max(300),
    z.union([
      z
        .object({
          kind: z.literal("play"),
          to: z.string().regex(/^[A-Za-z0-9:._ -]{1,100}$/),
          fraction: z.number().gt(0).lt(1).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("rollout"),
          change: z.union([
            z
              .object({
                action: z.literal("fraction"),
                fraction: z.number().gt(0).lt(1),
              })
              .strict(),
            z
              .object({ action: z.enum(["halt", "resume", "complete"]) })
              .strict(),
          ]),
        })
        .strict(),
      z
        .object({
          kind: z.literal("testflight"),
          promotion: z
            .object({
              groupIds: z.array(z.string().max(100)).max(50),
              newGroup: z
                .object({
                  name: z.string().min(1).max(50),
                  publicLink: z.boolean(),
                  publicLinkLimit: z
                    .number()
                    .int()
                    .min(1)
                    .max(10000)
                    .optional(),
                })
                .strict()
                .optional(),
              publicLinks: z
                .array(
                  z
                    .object({
                      groupId: z.string().max(100),
                      enabled: z.boolean(),
                      limit: z.number().int().min(1).max(10000).optional(),
                    })
                    .strict(),
                )
                .max(50)
                .optional(),
              contact: z
                .object({
                  contactFirstName: z.string().max(100).optional(),
                  contactLastName: z.string().max(100).optional(),
                  contactEmail: z.string().max(200).optional(),
                  contactPhone: z.string().max(50).optional(),
                })
                .strict()
                .optional(),
            })
            .strict(),
        })
        .strict(),
    ]),
  ]),
  readMonetization: z.tuple([identifier]),
  saveMonetization: z.tuple([
    identifier,
    monetizationSchema,
    z.array(z.string().max(300)).max(500).optional(),
  ]),
  importMonetization: z.tuple([
    identifier,
    z.array(z.string().max(300)).min(1).max(500),
  ]),
  openPlayMonetization: z.tuple([identifier, z.string().max(300)]),
  markMonetizationDone: z.tuple([identifier, z.string().max(300)]),
  notificationSettings: z.tuple([z.boolean().optional()]),
  testNotification: z.tuple([]),
  cliCommand: z.tuple([z.boolean().optional()]),
  compareBuild: z.tuple([identifier]),
  xcodeInstallations: z.tuple([identifier]),
  installXcode: z.tuple([identifier, text, z.boolean().optional()]),
  openXcodeDownload: z.tuple([identifier]),
  approveXcodeLicense: z.tuple([]),
  state: z.tuple([]),
  choose: z.tuple([
    z
      .object({
        kind: z.enum(["directory", "file", "files"]),
        extensions: z.array(z.string().regex(/^[A-Za-z0-9]+$/)).optional(),
      })
      .strict(),
  ]),
  projectApplications: z.tuple([text]),
  importProject: z.tuple([text, settingsSchema.optional()]),
  inspect: z.tuple([
    identifier,
    text.optional(),
    platform.optional(),
    z.boolean().optional(),
  ]),
  saveSettings: z.tuple([identifier, settingsSchema]),
  doctor: z.tuple([identifier.optional()]),
  build: z.tuple([
    z
      .object({
        projectId: identifier,
        platform: z.enum(["ios", "android", "all"]),
        profile: text,
        autoSubmit: z.boolean().optional(),
        clean: z.boolean().optional(),
      })
      .strict(),
  ]),
  cancel: z.tuple([identifier]),
  retry: z.tuple([identifier]),
  logs: z.tuple([identifier]),
  logPage: z.tuple([
    identifier.regex(/^[A-Za-z0-9_-]+$/),
    z
      .object({
        before: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        search: z.string().max(300).optional(),
      })
      .strict()
      .optional(),
  ]),
  cancelLogRead: z.tuple([identifier.regex(/^[A-Za-z0-9_-]+$/)]),
  submit: z.tuple([identifier]),
  reconcile: z.tuple([identifier]),
  reveal: z.tuple([text]),
  saveCredential: z.tuple([credential]),
  removeCredential: z.tuple([identifier]),
  validateConnection: z.tuple([identifier, identifier.optional()]),
  migrate: z.tuple([
    identifier,
    z
      .object({
        credentialsPath: text.optional(),
        environmentPaths: z.array(text).optional(),
        iosBuildNumber: z.number().int().nonnegative().optional(),
        androidBuildNumber: z.number().int().nonnegative().optional(),
      })
      .strict(),
  ]),
  seedCounter: z.tuple([identifier, platform, z.number().int().nonnegative()]),
  createCertificate: z.tuple([identifier, text]),
  registerDevice: z.tuple([
    identifier,
    text,
    z.string().regex(/^[A-Za-z0-9-]{16,64}$/),
  ]),
  createProfile: z.tuple([
    identifier,
    identifier,
    z.string().regex(/^[A-Za-z0-9.\-]+$/),
    z.enum(["IOS_APP_STORE", "IOS_APP_ADHOC", "IOS_APP_DEVELOPMENT"]),
  ]),
  prepareProject: z.tuple([
    identifier,
    z
      .object({
        platform,
        newApp: z.boolean(),
        renewProfiles: z.boolean().optional(),
        lastIosBuildNumber: z.number().int().nonnegative().optional(),
        lastAndroidBuildNumber: z.number().int().nonnegative().optional(),
      })
      .strict(),
  ]),
  setupLogs: z.tuple([identifier]),
  installTool: z.tuple([
    identifier,
    z.enum([
      "node",
      "cocoapods",
      "xcodegen",
      "android",
      "gcloud",
      "ios-platform",
    ]),
    z.boolean(),
  ]),
  googleLogin: z.tuple([identifier]),
  createGoogleConnection: z.tuple([
    identifier,
    z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  ]),
  openStoreSetup: z.tuple([
    identifier,
    z
      .object({
        provider: z.enum(["apple", "google"]),
        mode: z.enum(["record", "capabilities", "bootstrap"]),
        targetBundleId: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9.-]+$/)
          .optional(),
        appName: z.string().trim().min(1).max(50),
        language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
        sku: z.string().trim().min(1).max(100).optional(),
        appType: z.enum(["app", "game"]).optional(),
        pricing: z.enum(["free", "paid"]).optional(),
        newApp: z.boolean().optional(),
        artifactId: identifier.optional(),
      })
      .strict(),
  ]),
  approveStoreSetup: z.tuple([]),
  testFlightUsers: z.tuple([identifier]),
  configureTestFlight: z.tuple([
    identifier,
    z
      .object({
        name: z.string().trim().min(1).max(100),
        userIds: z.array(identifier).max(100),
      })
      .strict(),
  ]),
  testFlightGroups: z.tuple([identifier]),
  generateKeystore: z.tuple([identifier, text, text, text]),
  openAccountSetup: z.tuple([
    identifier,
    z.enum(["apple", "google"]),
    identifier.optional(),
  ]),
  accountState: z.tuple([]),
  revealAccountDiagnostics: z.tuple([]),
  retryAccountAutomation: z.tuple([]),
  accountNavigate: z.tuple([
    z.enum([
      "apple-api",
      "apple-team",
      "apple-enroll",
      "google-cloud",
      "google-play",
      "back",
      "reload",
    ]),
  ]),
  updateAccountSetup: z.tuple([
    z
      .object({
        issuerId: text.optional(),
        teamId: text.optional(),
        keyId: text.optional(),
        label: text.optional(),
        downloadedFile: text.optional(),
        hideWhenWorking: z.boolean().optional(),
        storeAppName: z.string().trim().min(1).max(50).optional(),
        googleCloudProject: z
          .string()
          .regex(/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9])?$/)
          .optional(),
        googleCreateProject: z.boolean().optional(),
        googleDeveloperId: z.string().regex(/^\d*$/).max(40).optional(),
        googleRequestNewPlayApp: z.boolean().optional(),
        googleStartSetup: z.boolean().optional(),
      })
      .strict(),
  ]),
  approveAccountKey: z.tuple([]),
  approveGoogleSetup: z.tuple([]),
  completeAccountSetup: z.tuple([]),
  closeAccountSetup: z.tuple([]),
  openExternal: z.tuple([z.string().url()]),
  updateStatus: z.tuple([]),
  checkForUpdates: z.tuple([]),
  installUpdate: z.tuple([]),
};
export type Method = keyof typeof methods;
