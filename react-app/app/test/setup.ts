import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Global test setup for vitest
// Imports jest-dom matchers for use in all test files

// gh-1608: @sentry/nextjs 10.72+ eagerly registers an orchestrion webpack
// bundler integration at import time (see @sentry/server-utils/build/cjs/
// orchestrion/bundler/webpack.js). That registration path calls
// fileURLToPath() on a value that is not a well-formed file:// URL when the
// module is loaded under vitest/Node instead of an actual webpack build,
// crashing every suite that imports app/providers/auth-provider.tsx (which
// does `import * as Sentry from '@sentry/nextjs'` for Sentry.setUser calls).
// Stub the package globally so unit tests exercise our own code paths
// without pulling in Sentry's bundler-plugin registration at all. Keep this
// in sync with the small, stable set of Sentry APIs actually used under
// app/ (SentryInitializer.tsx, auth-provider.tsx): init, replayIntegration,
// setUser.
vi.mock('@sentry/nextjs', () => ({
  init: vi.fn(),
  replayIntegration: vi.fn(() => ({})),
  setUser: vi.fn(),
}));
