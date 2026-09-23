import { defineConfig } from 'vitest/config'

/**
 * Config for AI-generated suites only.
 *
 * Kept out of the default run on purpose. Generated tests are evidence for the
 * measurement in docs/AI-IN-QE.md, not part of the suite that guards the
 * platform, and nothing should start depending on them by accident.
 */
export default defineConfig({
  test: {
    include: ['qe/ai/generated/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
