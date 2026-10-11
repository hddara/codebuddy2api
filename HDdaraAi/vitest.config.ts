import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * Test setup for the App.
 *
 * Scope is deliberately narrow: **pure logic only**. Anything that renders a
 * page or reaches `plus.*` is out of reach here and is covered by the platform
 * builds instead. What this catches is the layer where a bug is invisible to a
 * build — a wrong comparison, a message that never gets translated, an error
 * path that leaks a raw transport string to the screen.
 *
 * `environment: 'node'` because none of the tested modules touch the DOM.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // The uni runtime is not available outside a real build, so it is stubbed
    // globally rather than re-declared in every file that touches storage or
    // shows a toast. See `tests/setup.ts`.
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
})
