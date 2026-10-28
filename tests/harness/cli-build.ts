export const hashArtifact = async () => "fixture";
export async function buildLocal(ctx: any) {
  if (process.platform === "darwin" && app.dock?.isVisible())
    throw new Error("CLI test unexpectedly created a Dock icon");
  if (process.env.IOS_SUBMIT_ENVIRONMENT_JSON)
    throw new Error(
      "Caller secrets leaked into the shared process environment",
    );
  ctx.job.bundleId = "com.example.fixture";
  ctx.job.buildNumber = ctx.store.claimNumber(
    `${ctx.job.platform}:com.example.fixture`,
    ctx.job.id,
    0,
    ctx.job.requestedBuildNumber,
  );
  ctx.job.versionReservation = "reserved";
  ctx.save();
  const env = ctx.project.settings.envCredentialId
    ? (await ctx.vault.get(ctx.project.settings.envCredentialId, "environment"))
        .values
    : {};
  ctx.log("fixture-token " + (env.TOKEN ?? "none"));
  ctx.stage("compile");
  ctx.log("fixture-active " + ctx.job.id);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      resolve,
      ctx.project.path.endsWith("second") ? 3000 : 1500,
    );
    ctx.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Operation cancelled."));
      },
      { once: true },
    );
  });
  if (env.FIXTURE_FAIL === "true") throw new Error("fixture requested failure");
}
import { app } from "electron";
