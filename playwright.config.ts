import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.E2E_PORT ?? 3100)

// The specs share one database and run in file order (01-, 02-…): each builds on the state
// the previous one left, like a user would. `scripts/e2e-server.mjs` starts from an empty one.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "desktop",
      testMatch: /\d\d-.*\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, storageState: "e2e/.auth/state.json" },
    },
    {
      name: "mobile",
      testMatch: /mobile\.spec\.ts/,
      dependencies: ["desktop"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        storageState: "e2e/.auth/state.json",
      },
    },
  ],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: `http://localhost:${port}/login`,
    env: { E2E_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
