import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The CLI tests start real child processes (tsx), which take a moment each.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts'],
      reporter: ['text', 'text-summary', 'json-summary'],
      // Floor just under the measured baseline (94.8 / 86.7 / 95.9 / 96.9): a regression guard.
      thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 },
    },
  },
});
