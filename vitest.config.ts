import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['qe/suites/**/*.test.ts'],
    // Property tests generate large command sequences; give them room.
    testTimeout: 30_000,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['sut/backend/**/*.ts', 'qe/model/**/*.ts'],
      reportsDirectory: 'coverage',
    },
  },
})
