// @ts-check
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // D15: unit tests use no network; only test/e2e (Sprint 2+) may bind ports.
    environment: 'node',
    globals: false,
    restoreMocks: true,
  },
});