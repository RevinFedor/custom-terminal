import { defineConfig } from '@playwright/test';

/**
 * Playwright Configuration for Electron Testing
 *
 * Docs: https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests',

  // Timeout for each test (30 seconds)
  timeout: 30000,

  // Retry failed tests once
  retries: 1,

  // Run tests in parallel
  workers: 1,

  // Reporter configuration
  reporter: [
    ['html', { outputFolder: './results/playwright-report' }],
    ['list'],
    ['json', { outputFile: './results/test-results.json' }]
  ],

  use: {
    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video on failure
    video: 'retain-on-failure',

    // Trace on first retry
    trace: 'on-first-retry',
  },

  // Output folder for test artifacts
  outputDir: './results/test-artifacts',
});
