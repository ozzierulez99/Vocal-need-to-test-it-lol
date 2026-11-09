import { defineConfig } from '@playwright/test';

/**
 * UI tests run the production renderer build in Chromium (browser platform:
 * IndexedDB projects, downloads for exports). e2e/electron.spec.ts drives the
 * real Electron app when a display (or xvfb-run) is available.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4174',
    viewport: { width: 1480, height: 920 },
    acceptDownloads: true,
    trace: 'off',
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
  },
  projects: [
    { name: 'web', testIgnore: /electron\.spec/ },
    { name: 'electron', testMatch: /electron\.spec/ },
  ],
  webServer: {
    command: 'npx vite build && npx vite preview --port 4174 --strictPort',
    url: 'http://localhost:4174',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
