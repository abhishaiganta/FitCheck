import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3210);
const BROKEN = process.env.E2E_BROKEN_DB === '1';

// `npm run test:e2e` runs against the in-process fixture database.
// `E2E_BROKEN_DB=1 npm run test:e2e -- broken-db` checks the demo snapshot fallback.
export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: BROKEN ? [] : ['**/broken-db.spec.ts'],
  testMatch: BROKEN ? ['**/broken-db.spec.ts'] : undefined,
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [{
    name: 'iphone-14',
    use: {
      ...devices['iPhone 14'], browserName: 'chromium',
      // PW_CHROME=/path/to/chrome uses an installed browser when `npx playwright install chromium` is not possible
      ...(process.env.PW_CHROME ? { launchOptions: { executablePath: process.env.PW_CHROME } } : {}),
    },
  }],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health?soft=1`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: BROKEN ? 'postgresql://x:y@127.0.0.1:1/none' : 'pglite://fixtures',
      DATABASE_URL_DEMO: BROKEN ? 'postgresql://x:y@127.0.0.1:1/none' : 'pglite://fixtures',
      DEMO_MODE: '1',
      SEARCH_ENGINE: 'keyword',
      CAR_FIT: '1',
      GEMINI_API_KEYS: '',
      ELEVENLABS_API_KEY: '',
      NEXT_PUBLIC_SITE_URL: `http://localhost:${PORT}`,
      ADMIN_TOKEN: 'e2e-admin',
      DB_TIMEOUT_MS: '2500',
    },
  },
});
