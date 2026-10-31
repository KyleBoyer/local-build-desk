export interface StoreCacheInfo {
  source: "network" | "cache";
  stale: boolean;
  refreshing: boolean;
  refreshError?: string;
}
export type StoreChannel = "appstore" | "testflight" | "play";
export interface StoreRelease {
  id: string;
  resourceId: string;
  channel: StoreChannel;
  version?: string;
  buildNumbers: string[];
  status: string;
  uploadedAt?: string;
  createdAt?: string;
  expiresAt?: string;
  track?: string;
  fraction?: number;
  internalState?: string;
  externalState?: string;
  betaReviewState?: string;
  /** App Review returned this version with issues. Apple's API doesn't expose
   * the reviewer's message, so the UI points to App Store Connect for it. */
  reviewIssue?: "rejected" | "unresolved";
  consoleUrl: string;
}
export interface StoreImage {
  id: string;
  name: string;
  locale: string;
  displayType: string;
  status?: string;
  width?: number;
  height?: number;
  origin: "store" | "local";
  available: boolean;
}
export interface StoreListingText {
  locale: string;
  title?: string;
  description?: string;
  shortDescription?: string;
  whatsNew?: string;
  keywords?: string;
}
export interface StoreReleaseSnapshot {
  projectId: string;
  cache?: StoreCacheInfo;
  checkedAt: string;
  releases: StoreRelease[];
  channels: Record<
    StoreChannel,
    {
      connected: boolean;
      error?: string;
      note?: string;
      checkedAt?: string;
      cached?: boolean;
    }
  >;
}
export interface AppReviewMessage {
  id: string;
  createdAt?: string;
  from?: string;
  fromApple: boolean;
  /** Plain text; Apple's HTML is never passed to the UI. */
  body: string;
  attachments: number;
}
export interface AppReviewThread {
  id: string;
  /** e.g. REJECTION_BINARY, REJECTION_METADATA, APP_MESSAGE_COMM. */
  type: string;
  state?: string;
  createdAt?: string;
  lastActivityAt?: string;
  /** The guidelines App Review cited. */
  reasons: { section?: string; description?: string; code?: string }[];
  messages: AppReviewMessage[];
  error?: string;
}
/** App Review's Resolution Center messages, read through the desk's App Store Connect sign-in. */
export interface AppReviewInfo {
  checkedAt: string;
  /** False when the desk's App Store Connect web sign-in is missing or expired. */
  signedIn: boolean;
  threads: AppReviewThread[];
  error?: string;
}
export interface StoreReleaseDetail {
  releaseId: string;
  /** App Store versions only. */
  review?: AppReviewInfo;
  cache?: StoreCacheInfo;
  checkedAt: string;
  listings: StoreListingText[];
  images: StoreImage[];
  groups: string[];
  notes: string[];
  imageLocale?: string;
}
/** Main-process-only image locations. Renderer receives expiring opaque handles. */
export interface StoreImageSource extends Omit<StoreImage, "id" | "available"> {
  url?: string;
  local?: { jobId: string; index: number };
}
