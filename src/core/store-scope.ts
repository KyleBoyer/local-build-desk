import type { StoreSetupState } from "./types";
export function storeScope(state: StoreSetupState, action: string) {
  return JSON.stringify([
    state.provider,
    state.mode,
    state.identity,
    state.connectionId ?? "",
    action === "resume" ? "" : (state.developerId ?? ""),
    action === "resume" ? "" : (state.appId ?? ""),
    state.appName,
    state.language,
    state.sku ?? "",
    state.appType ?? "",
    state.pricing ?? "",
    state.artifact?.sha256 ?? "",
    state.identifiers ?? [],
    action,
  ]);
}
