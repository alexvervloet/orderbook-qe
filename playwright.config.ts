import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end configuration.
 *
 * One browser, not a matrix. The risk this suite covers is the frontend
 * disagreeing with the backend about state, and that is not a per-engine
 * behaviour. Running three browsers would triple the cost for no additional
 * signal; see docs/NON-GOALS.md.
 *
 * `retries: 0` everywhere, including CI. A retry turns a flaky test green and
 * removes the only evidence that something is wrong. Flakes get fixed or
 * deleted, per docs/CI-POLICY.md.
 */
export default defineConfig({
  testDir: 'qe/suites/e2e',
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI === undefined ? [['list']] : [['github'], ['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8099',
    trace: 'retain-on-failure',
    // A failure that cannot be reproduced is a failure that gets ignored.
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer:
    process.env.E2E_BASE_URL === undefined
      ? {
          command: 'node --experimental-strip-types sut/backend/main.ts',
          env: { PORT: '8099', SEED_ACCOUNTS: '1' },
          url: 'http://127.0.0.1:8099/health',
          reuseExistingServer: false,
          timeout: 20_000,
        }
      : undefined,
})
