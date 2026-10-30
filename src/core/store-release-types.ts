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
  checkedAt: string;
  releases: StoreRelease[];
  channels: Record<
    StoreChannel,
    { connected: boolean; error?: string; note?: string }
  >;
}
export interface StoreReleaseDetail {
  releaseId: string;
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
