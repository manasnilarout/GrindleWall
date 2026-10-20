import { afterEach } from 'vitest';

/**
 * Testing Library only auto-unmounts when vitest runs with `globals: true`,
 * which this project does not, so unmount explicitly between tests. Imported
 * lazily so node-environment files never load react-dom.
 */
afterEach(async () => {
  if (typeof document === 'undefined') return;
  const { cleanup } = await import('@testing-library/react');
  cleanup();
});
