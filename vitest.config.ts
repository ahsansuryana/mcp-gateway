// @ts-check
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // D15: unit tests use no network; only test/e2e (Sprint 2+) may bind ports.
    environment: 'node',
    globals: false,
    restoreMocks: true,
    // Many suites spawn a child process or bind a port. Under a full parallel run on a
    // loaded Windows host those exceed vitest's 5s default and fail at the machine's
    // speed rather than the code's. The same suite passed unchanged on the Linux host.
    // Individual tests that need a longer budget still declare one explicitly.
    testTimeout: 20_000,
    // A leaked handle after a test file finishes hangs the run instead of failing it.
    teardownTimeout: 10_000,
  },
});