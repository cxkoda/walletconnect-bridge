// Note: `vitest/config`, not `vite` — only vitest's defineConfig accepts `test`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
