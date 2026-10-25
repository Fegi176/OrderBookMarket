import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      include: ['src/**'],
      exclude: ['src/module_bindings/**', 'src/test/**', 'src/main.tsx', 'src/**/*.test.*'],
      reporter: ['text', 'html'],
    },
  },
});
