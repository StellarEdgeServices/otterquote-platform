import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./app/test/setup.ts'],
    // Vitest 5 defaults clearMocks to true, which clears vi.mocked(...).mock.calls
    // between each `it()` inside a shared `describe` (gh-2046 S2's sentry-wiring
    // tests build a shared client in `beforeAll` and inspect its mock calls
    // per-test). Restore Vitest 4's opt-in behavior rather than rewrite the tests.
    clearMocks: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './app'),
    },
  },
});
