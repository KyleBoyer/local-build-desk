import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/ui",
  globalSetup: "./tests/ui/setup.ts",
  workers: process.env.CI ? 2 : 1,
  timeout: 60000,
  use: { trace: "retain-on-failure" },
  reporter: "list",
});
