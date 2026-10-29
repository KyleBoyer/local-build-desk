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
  if (env.FIXTURE_CLOSE_AUX_WINDOW === "true") {
    const auxiliary = new BrowserWindow({ show: false });
    await auxiliary.loadURL(
      "data:text/html,<title>Temporary account session</title>",
    );
    auxiliary.close();
    await wait(50, undefined, { signal: ctx.signal });
    ctx.log("fixture-auxiliary-closed");
  }
  const waitForQueued = env.FIXTURE_WAIT_FOR_QUEUED === "true";
  if (env.FIXTURE_WAIT_FOR_SECOND === "true" || waitForQueued) {
    const deadline = Date.now() + 20000;
    while (
      !ctx.store
        .list("jobs")
        .some(
          (job: any) =>
            job.id !== ctx.job.id &&
            (waitForQueued ||
              (job.status === "running" && job.stage === "compile")),
        )
    ) {
      if (Date.now() >= deadline)
        throw new Error("Second fixture build did not enter compilation");
      await wait(25, undefined, { signal: ctx.signal });
    }
  }
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
import { app, BrowserWindow } from "electron";
import { setTimeout as wait } from "node:timers/promises";
