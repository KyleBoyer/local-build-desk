import { Vault } from "./vault";
import { Store, id, now } from "./database";
import { invariant } from "./errors";
import type {
  Credential,
  CredentialSummary,
  Project,
  ProjectSettings,
} from "./types";
export interface RuntimeContext {
  credentials: Record<string, Credential>;
  noKeychain: boolean;
}
export interface BuildInvocation {
  project: Project;
  context: RuntimeContext;
  buildNumber?: number;
  concurrency?: Partial<Record<"ios" | "android", number>>;
}
// Saved sign-ins belong to the desk, not to a project build.
const binding: Record<
  Exclude<Credential["kind"], "login">,
  keyof ProjectSettings
> = {
  apple: "appleConnectionId",
  ios: "iosSigningId",
  google: "googleConnectionId",
  android: "androidSigningId",
  environment: "envCredentialId",
};
export function bindRuntimeCredentials(
  settings: ProjectSettings,
  credentials: Credential[],
  noKeychain: boolean,
): { settings: ProjectSettings; context: RuntimeContext } {
  const result = { ...settings };
  const values: Record<string, Credential> = {};
  if (noKeychain) for (const key of Object.values(binding)) delete result[key];
  for (const credential of credentials) {
    if (credential.kind === "login") continue;
    const key = `runtime:${id()}`;
    values[key] = credential;
    (result as any)[binding[credential.kind]] = key;
  }
  return { settings: result, context: { credentials: values, noKeychain } };
}
function summary(key: string, value: Credential): CredentialSummary {
  return {
    id: key,
    kind: value.kind,
    label: value.label,
    createdAt: now(),
    detail: "Temporary invocation credential",
  };
}
export class RunVault extends Vault {
  override get canFingerprint() {
    return (
      !this.context.noKeychain &&
      Object.keys(this.context.credentials).length === 0
    );
  }
  override async fingerprint(value: string) {
    invariant(
      this.canFingerprint,
      "CI_FINGERPRINT",
      "Invocation-only credentials are not used for persistent build reuse.",
    );
    return this.base.fingerprint(value);
  }
  override readonly ephemeral = true;
  constructor(
    store: Store,
    private base: Vault,
    readonly context: RuntimeContext,
  ) {
    super(store, {
      async encrypt() {
        throw Error("Invocation credentials must never be persisted.");
      },
      async decrypt() {
        throw Error(
          "Invocation credentials must never use this keychain provider.",
        );
      },
    });
  }
  override async get<T extends Credential["kind"]>(
    key: string | undefined,
    kind?: T,
  ): Promise<Extract<Credential, { kind: T }>> {
    if (key && this.context.credentials[key]) {
      const value = this.context.credentials[key];
      invariant(
        !kind || value.kind === kind,
        "CREDENTIAL_TYPE",
        `Provide a ${kind} credential for this invocation.`,
      );
      return value as Extract<Credential, { kind: T }>;
    }
    invariant(
      !this.context.noKeychain,
      "CI_CREDENTIALS_REQUIRED",
      `Provide ${kind ?? "the required"} credentials for this invocation, or explicitly allow Keychain access. No Keychain access was attempted.`,
    );
    return this.base.get(key, kind);
  }
  override async put(value: Credential, key?: string) {
    key ??= `runtime:${id()}`;
    this.context.credentials[key] = value;
    return summary(key, value);
  }
  override remove(key: string) {
    delete this.context.credentials[key];
  }
  summaries() {
    return Object.entries(this.context.credentials).map(([key, value]) =>
      summary(key, value),
    );
  }
}
export function invocationStore(
  base: Store,
  vault: RunVault,
  project: Project,
  onProject: (project: Project) => void,
): Store {
  return new Proxy(base, {
    get(target, key) {
      if (key === "putProject")
        return (value: Project) => {
          invariant(
            value.id === project.id,
            "CI_PROJECT",
            "Unexpected project update during an invocation.",
          );
          Object.assign(project, value);
          onProject(project);
        };
      if (key === "credentialSummaries")
        return () => [
          ...vault.summaries(),
          ...(vault.context.noKeychain
            ? []
            : target
                .credentialSummaries()
                .filter((value) => !vault.context.credentials[value.id])),
        ];
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export function credentialSecrets(
  values: Record<string, Credential>,
): string[] {
  return Object.values(values).flatMap((value) => {
    switch (value.kind) {
      case "apple":
        return [value.privateKey, value.keyId];
      case "ios":
        return [value.p12, value.password, ...value.profiles];
      case "android":
        return [value.keystore, value.storePassword, value.keyPassword];
      case "google":
        return [
          JSON.stringify(value.serviceAccount),
          value.serviceAccount.private_key,
          value.serviceAccount.private_key_id,
        ].filter((item): item is string => typeof item === "string");
      case "environment":
        return Object.values(value.values);
      case "login":
        return [value.password];
    }
  });
}
