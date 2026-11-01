import { defineConfig } from '@playwright/test';

// Runs in the installed Chrome, against the simulated amp. Nothing here touches Bluetooth.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  use: { baseURL: 'http://localhost:5175', channel: 'chrome' },
  webServer: { command: 'pnpm dev', port: 5175, reuseExistingServer: true },
  outputDir: '_work/playwright',
  reporter: 'line',
});
