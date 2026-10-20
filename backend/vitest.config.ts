import { defineConfig } from 'vitest/config';

/**
 * Unit tests live in test/unit, integration tests (real HTTP/WS servers, real
 * files, local vendor fakes) in test/integration. Neither may touch the
 * network beyond 127.0.0.1 or need a vendor key — that is what the live probes
 * in scripts/ are for, and a green run here is not vendor evidence.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Several modules hold process-level singletons (the session store, the
    // factory's registry, config read once at import), so each file gets its
    // own process.
    pool: 'forks',
    restoreMocks: true,
    unstubEnvs: true,
  },
});
