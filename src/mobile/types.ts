import type {
  Job,
  ProjectType,
  Platform,
  WorkProgress,
  LogEntry,
  Artifact,
  Submission,
  Checkpoint,
  ValidationResult,
} from "../core/types";
export interface MonitorConfig {
  tls: "self-signed" | "custom" | "off";
  enabled: boolean;
  host: string;
  port: number;
  publicOrigin?: string;
}
export interface MonitorDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}
export interface MonitorStatus {
  config: MonitorConfig;
  running: boolean;
  url?: string;
  localUrl?: string;
  error?: string;
  devices: MonitorDevice[];
  clients: number;
  certificate?: {
    fingerprint: string;
    subject: string;
    issuer: string;
    expiresAt: string;
    selfSigned: boolean;
  };
  interfaces: { address: string; label: string }[];
}
export interface MonitorPairing {
  url: string;
  code: string;
  expiresAt: string;
  qrDataUrl: string;
}
export interface MonitorProject {
  id: string;
  name: string;
  type?: ProjectType;
  platforms?: Platform[];
  bundleId?: string;
  packageName?: string;
  version?: string;
  /** What the project's release checks run, when they're set up. */
  checks?: {
    enabled: boolean;
    /** Store uploads wait for passing checks. */
    required: boolean;
    tests: string;
    simulators: string[];
    emulators: string[];
    /** The capture plan: its file in the project, or "inline". */
    screenshots?: string;
  };
}
export interface MonitorArtifact extends Omit<Artifact, "path"> {}
export interface MonitorJob {
  id: string;
  projectId: string;
  projectName: string;
  platform: Platform;
  profile: string;
  kind: Job["kind"];
  status: Job["status"];
  stage: Job["stage"];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  stageStartedAt?: string;
  bundleId?: string;
  version?: string;
  buildNumber?: string;
  error?: string;
  progress?: WorkProgress;
  submission?: Pick<
    Submission,
    | "state"
    | "destination"
    | "message"
    | "uploadedAt"
    | "lastCheckedAt"
    | "rollout"
  >;
  checkpoints?: Checkpoint[];
  validation?: Pick<
    ValidationResult,
    "state" | "configuration" | "startedAt" | "finishedAt" | "error" | "mode"
  > & {
    runs: {
      device: string;
      runtime?: string;
      status: "passed" | "failed";
      passed?: number;
      failed?: number;
      skipped?: number;
      /** Screenshot runs have no test counts. */
      captures: boolean;
      detail?: string;
    }[];
    screenshots: {
      index: number;
      name: string;
      device: string;
      width: number;
      height: number;
      /** A framed store image exists for this capture. */
      framed: boolean;
    }[];
  };
  source?: { hash?: string; commit?: string; configuration: string };
  toolchain?: { xcodeVersion: string; iosSdk: string };
  artifacts: MonitorArtifact[];
}
export interface MonitorSnapshot {
  server: { name: string; version: string; startedAt: string; now: string };
  projects: MonitorProject[];
  jobs: MonitorJob[];
  counts: {
    active: number;
    queued: number;
    processing: number;
    attention: number;
    total: number;
  };
}
export interface MonitorLogs {
  entries: LogEntry[];
  cursor: number;
  hasMore: boolean;
  reset: boolean;
}
