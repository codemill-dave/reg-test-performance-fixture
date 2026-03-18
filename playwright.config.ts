import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: [['html', { open: 'never' }]],
  use: {
    headless: true,
  },
  globalTeardown: './src/globalTeardown.ts',
});
