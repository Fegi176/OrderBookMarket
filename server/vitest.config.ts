import { defineConfig } from 'vitest/config';
import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';

export default defineConfig({
  plugins: [spacetimedbModuleTestPlugin()],
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: { include: ['src/**'], reporter: ['text', 'html'] },
  },
});
