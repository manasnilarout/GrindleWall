import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Separate from vite.config.ts so the dev proxy never applies under test.
 * Pure-logic tests run in node; component and hook tests opt into jsdom with a
 * `// @vitest-environment jsdom` docblock on their first line.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    testTimeout: 20_000,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
