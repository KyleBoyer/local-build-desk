import type { AppReviewThread } from "./store-release-types";

// Display text for App Review threads, shared by the desktop and mobile views.

const THREAD_TITLES: Record<string, string> = {
  REJECTION_BINARY: "Build rejected",
  REJECTION_METADATA: "Metadata rejected",
  REJECTION_REVIEW_SUBMISSION: "Submission rejected",
  APP_MESSAGE_ARC: "Message from App Review",
  APP_MESSAGE_ARB: "App Review Board",
  APP_MESSAGE_COMM: "Message from App Review",
  APP_MESSAGE_INFORMATIONAL: "Information from App Review",
};

export const reviewThreadTitle = (thread: AppReviewThread) =>
  THREAD_TITLES[thread.type] ?? thread.type.replaceAll("_", " ").toLowerCase();

export const reviewThreadIsRejection = (thread: AppReviewThread) =>
  thread.type.startsWith("REJECTION_");

/** "Guideline 2.1 - Performance - App Completeness" style, as Apple shows it. */
export const reviewReasonText = (reason: AppReviewThread["reasons"][number]) =>
  [
    reason.section &&
      (/^\d/.test(reason.section)
        ? `Guideline ${reason.section}`
        : reason.section),
    reason.description,
  ]
    .filter(Boolean)
    .join(" — ") ||
  reason.code ||
  "Unspecified guideline";
