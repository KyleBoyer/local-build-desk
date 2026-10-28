import { z } from "zod";
const text = z.string().max(4096),
  identifier = z.string().min(1).max(128);
export const localProfileSchema = z
  .object({
    extends: identifier.optional(),
    configuration: text.optional(),
    distribution: z.enum(["store", "internal"]).optional(),
    simulator: z.boolean().optional(),
    debug: z.boolean().optional(),
    autoIncrement: z.boolean().optional(),
    env: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z.string().max(65536),
      )
      .optional(),
    scheme: text.optional(),
    androidVariant: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9]*$/)
      .optional(),
    buildType: z.enum(["apk", "app-bundle"]).optional(),
  })
  .strict();
export const settingsSchema = z
  .object({
    projectType: z.enum(["expo", "capacitor", "native-ios"]).optional(),
    appDirectory: text.optional(),
    iosTarget: text.optional(),
    configuration: text.optional(),
    webBuildScript: z
      .string()
      .regex(/^[A-Za-z0-9_:.-]+$/)
      .optional(),
    iosDependencyManager: z.enum(["SPM", "CocoaPods"]).optional(),
    androidModule: z
      .string()
      .regex(/^:?[A-Za-z0-9_:-]+$/)
      .optional(),
    localProfiles: z
      .record(identifier, localProfileSchema)
      .refine(
        (v) => Object.keys(v).length > 0 && Object.keys(v).length <= 100,
        "Define between 1 and 100 profiles.",
      )
      .optional(),
    ascAppId: text.optional(),
    setupAppleComplete: z.boolean().optional(),
    testFlightGroupId: text.optional(),
    testFlightGroupName: text.optional(),
    nodePath: text.optional(),
    javaHome: text.optional(),
    androidSdk: text.optional(),
    androidSdkLicenseAccepted: z.boolean().optional(),
    xcodePath: text.optional(),
    buildDirectory: text.optional(),
    pendingXcodePath: text.optional(),
    minimumIosSdk: z
      .string()
      .regex(/^(?:\d+(?:\.\d+){0,2})?$/)
      .optional(),
    iosSdk: z
      .string()
      .regex(/^(?:\d+(?:\.\d+){0,2})?$/)
      .optional(),
    workspace: text.optional(),
    scheme: text.optional(),
    nativeMode: z.enum(["auto", "generated", "maintained"]).optional(),
    appleConnectionId: identifier.optional(),
    iosSigningId: identifier.optional(),
    androidSigningId: identifier.optional(),
    googleConnectionId: identifier.optional(),
    envCredentialId: identifier.optional(),
    track: z
      .string()
      .regex(/^[a-zA-Z0-9_:.\-]+$/)
      .optional(),
    playAutoRollout: z.boolean().optional(),
    // Google Play limits release notes to 500 characters per language.
    playReleaseNotes: z.string().max(500).optional(),
    playReleaseNotesLanguage: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
      .optional(),
  })
  .strict();
