import { z } from "zod";
const text = z.string().min(1).max(4096);
export const simulatorDestinationSchema = z
  .object({
    deviceType: z.string().min(1).max(200),
    runtime: z.string().max(200).optional(),
  })
  .strict();
export const captureStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tap"), identifier: text }).strict(),
  z
    .object({
      action: z.literal("type"),
      identifier: text,
      text: z.string().max(16000),
    })
    .strict(),
  z
    .object({
      action: z.literal("wait"),
      identifier: text,
      timeoutSeconds: z.number().int().min(1).max(60).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("assertText"),
      identifier: text,
      text: z.string().max(16000),
    })
    .strict(),
  z
    .object({
      action: z.enum(["swipeUp", "swipeDown", "swipeLeft", "swipeRight"]),
      identifier: text.optional(),
    })
    .strict(),
]);
export const screenshotPlanSchema = z
  .object({
    appearance: z.enum(["light", "dark"]).default("light"),
    language: z
      .string()
      .regex(/^[A-Za-z-]{2,30}$/)
      .default("en"),
    locale: z
      .string()
      .regex(/^[A-Za-z_@=-]{2,50}$/)
      .default("en_US"),
    captures: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
            launchArguments: z.array(z.string().max(4096)).max(100).default([]),
            launchEnvironment: z
              .record(
                z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
                z.string().max(4096),
              )
              .default({}),
            steps: z.array(captureStepSchema).max(100).default([]),
            readyIdentifier: text.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10)
      .refine(
        (c) => new Set(c.map((s) => s.name)).size === c.length,
        "Capture names must be unique.",
      ),
  })
  .strict();
export const releaseChecksSchema = z
  .object({
    enabled: z.boolean().default(true),
    required: z.boolean().default(true),
    runner: z.enum(["xcode", "command"]).default("xcode"),
    scheme: z.string().min(1).max(200).optional(),
    testPlan: z.string().min(1).max(200).optional(),
    configuration: z.string().min(1).max(100).optional(),
    onlyTesting: z.array(z.string().min(1).max(300)).max(100).default([]),
    command: z.array(z.string().min(1).max(4096)).min(1).max(100).optional(),
    destinations: z.array(simulatorDestinationSchema).max(8).default([]),
    timeoutSeconds: z.number().int().min(30).max(7200).default(1800),
    screenshots: screenshotPlanSchema.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (!c.enabled) return;
    if (c.runner === "command" && !c.command?.length)
      ctx.addIssue({
        code: "custom",
        message: "Choose the project-owned test executable and arguments.",
        path: ["command"],
      });
    if ((c.runner === "xcode" || c.screenshots) && !c.destinations.length)
      ctx.addIssue({
        code: "custom",
        message: "Choose at least one simulator device and runtime.",
        path: ["destinations"],
      });
  });
export type ReleaseCheckPolicy = z.infer<typeof releaseChecksSchema>;
export type SimulatorDestination = z.infer<typeof simulatorDestinationSchema>;
export type ScreenshotPlan = z.infer<typeof screenshotPlanSchema>;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const capturedScreenshotSchema = z
  .object({
    name: text,
    path: text,
    sha256: digest,
    size: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    displayType: text.optional(),
    device: text,
    runtime: text,
  })
  .strict();
export const validationResultSchema = z
  .object({
    state: z.enum(["running", "passed", "failed", "cancelled", "interrupted"]),
    fingerprint: digest,
    sourceHash: digest,
    policyDigest: digest,
    configuration: text,
    startedAt: text,
    finishedAt: text.optional(),
    mode: z.enum(["all", "tests", "screenshots"]),
    error: z.string().max(1048576).optional(),
    runs: z
      .array(
        z
          .object({
            device: text,
            runtime: text.optional(),
            status: z.enum(["passed", "failed"]),
            resultBundle: text.optional(),
            attachments: text.optional(),
            passed: z.number().int().nonnegative().optional(),
            failed: z.number().int().nonnegative().optional(),
            skipped: z.number().int().nonnegative().optional(),
            total: z.number().int().nonnegative().optional(),
            detail: text.optional(),
          })
          .strict(),
      )
      .max(100),
    screenshots: z.array(capturedScreenshotSchema).max(100),
  })
  .strict();
export const checkpointSchema = z
  .object({
    stage: z.enum([
      "queued",
      "preflight",
      "snapshot",
      "install",
      "configure",
      "testing",
      "screenshots",
      "signing",
      "compile",
      "export",
      "verify",
      "upload",
      "processing",
      "complete",
    ]),
    state: z.enum(["running", "complete", "failed", "interrupted"]),
    startedAt: text,
    finishedAt: text.optional(),
    detail: z.string().max(1048576).optional(),
  })
  .strict();
