import { expect, test, type Page } from '@playwright/test';

/** Navigate and wait until React has hydrated, so fills and clicks are not lost. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForSelector('html[data-hydrated]');
}

// Run with: E2E_BROKEN_DB=1 npm run test:e2e
test('with the database unreachable in DEMO_MODE, search serves the bundled demo snapshot', async ({ page, request }) => {
  await open(page, '/');
  await page.getByTestId('query').fill('desk lamp and side table under $40, warm wood, I drive a Civic');
  await page.getByTestId('search').click();
  await expect(page.getByTestId('snapshot-banner')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('card').first()).toBeVisible();
  await expect(page.getByTestId('ar-link').first()).toHaveAttribute('rel', 'ar');
  expect((await request.get('/api/health')).status()).toBe(503);
  const pipe = await request.get('/api/pipeline');
  expect(pipe.status()).toBe(503);
  expect(await pipe.json()).toMatchObject({ error: { code: 'db_unreachable', retryable: true } });
  await open(page, '/pipeline');
  await expect(page.getByTestId('pipeline-updated')).toContainText("Can't reach the database");
  await open(page, '/item/1');
  await expect(page.getByTestId('card')).toBeVisible();
});
