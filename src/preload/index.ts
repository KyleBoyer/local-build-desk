import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI, DeskEvent } from "../core/types";
const names = [
  "exportBuildSettings",
  "importBuildSettings",
  "readRelease",
  "relinkArtifact",
  "installTargets",
  "installArtifact",
  "cancelInstall",
  "findReusableBuilds",
  "useReusableBuild",
  "exportBackup",
  "previewBackup",
  "restoreBackup",
  "prepareRelease",
  "applyRelease",
  "savePlayNotes",
  "releaseNoteDraft",
  "notificationSettings",
  "testNotification",
  "compareBuild",
  "xcodeInstallations",
  "installXcode",
  "openXcodeDownload",
  "approveXcodeLicense",
  "state",
  "choose",
  "projectApplications",
  "importProject",
  "inspect",
  "saveSettings",
  "doctor",
  "build",
  "cancel",
  "retry",
  "logs",
  "submit",
  "reconcile",
  "reveal",
  "saveCredential",
  "removeCredential",
  "validateConnection",
  "migrate",
  "seedCounter",
  "createCertificate",
  "registerDevice",
  "createProfile",
  "generateKeystore",
  "prepareProject",
  "setupLogs",
  "installTool",
  "googleLogin",
  "createGoogleConnection",
  "testFlightGroups",
  "testFlightUsers",
  "configureTestFlight",
  "openStoreSetup",
  "approveStoreSetup",
  "openAccountSetup",
  "accountState",
  "revealAccountDiagnostics",
  "retryAccountAutomation",
  "accountNavigate",
  "updateAccountSetup",
  "approveAccountKey",
  "approveGoogleSetup",
  "completeAccountSetup",
  "closeAccountSetup",
  "openExternal",
  "updateStatus",
  "checkForUpdates",
  "installUpdate",
] as const;
const api: Record<string, unknown> = {};
for (const name of names)
  api[name] = async (...args: unknown[]) => {
    const response = await ipcRenderer.invoke("desk:invoke", name, args);
    if (!response.ok) throw new Error(response.error);
    return response.value;
  };
api.onEvent = (listener: (event: DeskEvent) => void) => {
  const callback = (_event: unknown, value: DeskEvent) => listener(value);
  ipcRenderer.on("desk:event", callback);
  return () => ipcRenderer.removeListener("desk:event", callback);
};
contextBridge.exposeInMainWorld("desk", api as unknown as DesktopAPI);
