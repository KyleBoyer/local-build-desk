import { z } from "zod";
export const purchaseTestingSchema = z
  .object({
    productId: z.string().min(1).max(200),
    scenarios: z
      .array(
        z.enum([
          "purchase",
          "restore",
          "refund",
          "failedPayment",
          "renewal",
          "cancellation",
          "expiration",
        ]),
      )
      .min(1)
      .max(7),
    buyIdentifier: z.string().min(1).max(300),
    unlockedIdentifier: z.string().min(1).max(300),
    lockedIdentifier: z.string().min(1).max(300),
    restoreIdentifier: z.string().max(300).optional(),
    failureIdentifier: z.string().max(300).optional(),
    launchArguments: z.array(z.string().max(500)).max(30).default([]),
    androidCommand: z
      .array(z.string().min(1).max(1000))
      .min(1)
      .max(100)
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scenarios.includes("restore") && !v.restoreIdentifier)
      ctx.addIssue({
        code: "custom",
        message:
          "Map the app’s Restore Purchases control before enabling restore tests.",
        path: ["restoreIdentifier"],
      });
    if (v.scenarios.includes("failedPayment") && !v.failureIdentifier)
      ctx.addIssue({
        code: "custom",
        message:
          "Map the app’s payment-error UI before enabling failure tests.",
        path: ["failureIdentifier"],
      });
    if (v.unlockedIdentifier === v.lockedIdentifier)
      ctx.addIssue({
        code: "custom",
        message: "Locked and unlocked UI identifiers must be different.",
        path: ["unlockedIdentifier"],
      });
  });
export type PurchaseTesting = z.infer<typeof purchaseTestingSchema>;
