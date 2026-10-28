import { app } from "electron";
// Test startup failures belong in captured stderr, never a modal on the user's Mac.
const fail = (error: unknown) => {
  console.error(error);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
void import("../../src/main/index").catch(fail);
