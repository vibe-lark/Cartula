import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
export default defineConfig({
  testDir: './tests/e2e', timeout: 45_000, expect: { timeout: 15_000 },
  fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:3911', viewport: { width: 1440, height: 960 },
    // The opaque test frame uses a loopback server. Production assets use public
    // HTTPS; disable only Chromium's local-network check in this test browser.
    launchOptions: { executablePath, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-features=LocalNetworkAccessChecks'] },
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node --import tsx tests/e2e-server.ts', url: 'http://127.0.0.1:3911/healthz', reuseExistingServer: false, timeout: 30_000 },
});
