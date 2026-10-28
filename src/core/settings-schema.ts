import { z } from "zod";
const text = z.string().max(4096),
  identifier = z.string().min(1).max(128);
export const settingsSchema = z
  .object({
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
