import { app } from "electron";
// Fixture startup errors must fail the test in stderr, never open a native dialog.
const fail = (error: unknown) => {
  console.error(error);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
void import("./account").catch(fail);
