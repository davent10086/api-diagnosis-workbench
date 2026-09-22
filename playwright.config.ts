import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: { baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3100", trace: "retain-on-failure", screenshot: "only-on-failure", video: "retain-on-failure" },
  webServer: process.env.E2E_BASE_URL ? undefined : { command: "npm run dev -- --port 3100", url: "http://127.0.0.1:3100", reuseExistingServer: false },
});
