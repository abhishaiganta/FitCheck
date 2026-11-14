import { expect, test, type Page } from '@playwright/test';

/** Navigate and wait until React has hydrated, so fills and clicks are not lost. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForSelector('html[data-hydrated]');
}

const DEMO = 'desk lamp and side table under $40, warm wood, I drive a Civic';

async function search(page: import('@playwright/test').Page, q: string) {
  await page.getByTestId('query').fill(q);
  await page.getByTestId('search').click();
}

test('typed search shows cards with the exact AR Quick Look anchor', async ({ page }) => {
  await open(page, '/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Used furniture');
  await search(page, DEMO);
  const cards = page.getByTestId('card');
  await expect(cards).toHaveCount(3);
  await expect(page.getByTestId('summary')).toContainText('Found 2 desk lamps and 1 side table under $40.');
  await expect(page.getByTestId('origin')).toContainText('From UCSD');
  await expect(page.getByTestId('filter-chip')).toContainText(['desk lamp', 'side table', 'under $40', 'warm wood', 'Honda Civic']);

  const anchors = page.getByTestId('ar-link');
  await expect(anchors).toHaveCount(3);
  for (const a of await anchors.all()) {
    expect(await a.getAttribute('rel')).toBe('ar');
    const href = (await a.getAttribute('href'))!;
    expect(href).toMatch(/^https:\/\/[^#]+\.usdz#allowsContentScaling=0&callToAction=View%20listing&checkoutTitle=[^&]+&checkoutSubtitle=[^&]+&price=[^&]+$/);
    // the anchor's first (and only) child is an <img>
    expect(await a.evaluate((el) => [el.children.length, el.firstElementChild?.tagName])).toEqual([1, 'IMG']);
  }
  const free = page.locator('[data-testid=card][data-id="1"]');
  await expect(free).toContainText('FREE');
  await expect(free).toContainText('pickup');
  await expect(free.getByTestId('car-fit')).toContainText('Fits your Civic');
  await expect(free).toContainText('Saves ~$32 vs. new (est.)');
  const shipped = page.locator('[data-testid=card][data-id="2"]');
  await expect(shipped).toContainText('Ships $9, total $24');
  expect(await free.getByTestId('ar-link').getAttribute('href')).toContain('&price=Free');
});

test('follow-up turns reuse the last search', async ({ page }) => {
  await open(page, '/');
  await search(page, DEMO);
  await expect(page.getByTestId('card')).toHaveCount(3);
  await search(page, 'what about one that ships');
  await expect(page.getByTestId('card')).toHaveCount(1);
  await expect(page.getByTestId('filter-chip')).toContainText(['shipped only']);
});

test('on a device without AR Quick Look the button opens the 3D preview, and QR opens too', async ({ page }) => {
  await open(page, '/');
  await search(page, 'side table');
  const card = page.locator('[data-testid=card][data-id="2"]');
  await card.getByTestId('ar-button').click();
  await expect(page.getByRole('dialog', { name: /3D preview/ })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await card.getByRole('button', { name: /QR code/ }).click();
  await expect(page.getByTestId('qr')).toBeVisible();
});

test('empty search explains why and widens with one tap', async ({ page }) => {
  await open(page, '/');
  await search(page, 'dresser under $5 pickup only');
  await expect(page.getByTestId('empty')).toContainText('No matches under $5 within 10 miles.');
  await page.getByTestId('widen').filter({ hasText: 'Any furniture' }).click();
  await expect(page.getByTestId('card').first()).toBeVisible();
});

test('no car: walkable or shipped only, and no car-fit badge', async ({ page }) => {
  await open(page, '/');
  await search(page, 'lamp near La Jolla Village, no car');
  await expect(page.getByTestId('origin')).toContainText('From La Jolla Village');
  await expect(page.locator('[data-testid=card][data-id="1"]')).toContainText('walkable pickup');
  await expect(page.getByTestId('car-fit')).toHaveCount(0);
});

test('mic without permission falls back to typing with a clear message', async ({ page }) => {
  await open(page, '/');
  await page.getByTestId('mic').dispatchEvent('pointerdown');
  await expect(page.getByTestId('notice')).toHaveText('Microphone is off. Type what you need instead.');
  await expect(page.getByTestId('query')).toBeFocused();
});

test('/item/[id] renders the card and a QR code; unknown ids show not-found', async ({ page }) => {
  await open(page, '/item/2');
  await expect(page.getByRole('heading', { level: 3 })).toContainText('Walnut side table');
  await expect(page.getByTestId('item-qr').locator('svg')).toBeVisible();
  await expect(page.getByTestId('ar-link')).toHaveAttribute('rel', 'ar');
  await open(page, '/item/9'); // still exporting
  await expect(page.getByTestId('model-coming')).toBeVisible();
  await open(page, '/item/99999');
  await expect(page.getByRole('heading', { name: 'Nothing at this address' })).toBeVisible();
});

test('/pipeline shows counts and picks up a new event within one poll', async ({ page, request }) => {
  await open(page, '/pipeline');
  await expect(page.locator('[data-status=ready]')).toHaveText('7');
  await expect(page.locator('[data-status=failed]')).toHaveText('1');
  const before = await page.getByTestId('pipeline-events').locator('li').count();
  const r = await request.patch('/api/admin/listings', {
    headers: { authorization: 'Bearer e2e-admin' }, data: { listing_id: 8, orient_override: '+90x' },
  });
  expect(r.ok()).toBe(true);
  await expect(page.getByTestId('pipeline-events').locator('li')).toHaveCount(before + 1, { timeout: 8000 });
  await expect(page.getByTestId('pipeline-events')).toContainText('admin: orient_override=+90x');
  await expect(page.locator('[data-status=ready]')).toHaveText('6'); // sent back to the exporter
});

test('/impact renders estimates', async ({ page }) => {
  await open(page, '/impact');
  await expect(page.getByTestId('impact-tiles')).toContainText('Free items right now');
  await expect(page.getByTestId('impact-tiles').locator('dd.font-display').first()).toHaveText(/\d/);
});

test('API errors are consistent JSON and never leak internals', async ({ request }) => {
  const bad = await request.post('/api/search', { data: { text: '' } });
  expect(bad.status()).toBe(400);
  expect(await bad.json()).toMatchObject({ error: { code: 'bad_request', retryable: false } });
  const notJson = await request.post('/api/search', { headers: { 'content-type': 'application/json' }, data: '{oops' });
  expect(notJson.status()).toBe(400);
  expect((await request.get('/api/admin/listings')).status()).toBe(401);
  expect((await request.post('/api/stt', { headers: { 'content-type': 'text/plain' }, data: 'x' })).status()).toBe(400);
  const tts = await request.post('/api/tts', { data: { text: 'hello' } });
  expect(tts.status()).toBe(503); // no ElevenLabs key in the test server: the UI stays silent
  expect(JSON.stringify(await tts.json())).not.toMatch(/stack|sk_|at \w+ \(/);
  const impact = await request.post('/api/impact', { data: { listing_id: 1, kind: 'ar_view' } });
  expect(await impact.json()).toEqual({ ok: true });
  expect((await request.post('/api/impact', { data: { listing_id: 1, kind: 'nope' } })).status()).toBe(400);
  expect((await request.get('/api/health')).ok()).toBe(true);
});

test('admin desk loads listings with the token and pins one', async ({ page }) => {
  await open(page, '/admin');
  await page.getByTestId('admin-token').fill('wrong');
  await page.getByTestId('admin-load').click();
  await expect(page.getByTestId('admin-msg')).toContainText('Admin token missing or wrong.');
  await page.getByTestId('admin-token').fill('e2e-admin');
  await page.getByTestId('admin-load').click();
  await expect(page.getByTestId('admin-rows').locator('li')).toHaveCount(12);
  await page.getByRole('button', { name: 'Pin for demo' }).first().click();
  await expect(page.getByTestId('admin-msg')).toContainText('for the demo');
});

test('public routes rate-limit per IP with a friendly 429', async ({ request }) => {
  let last = 200;
  for (let i = 0; i < 70; i++) last = (await request.post('/api/models/check', { data: { ids: [1] } })).status();
  expect(last).toBe(429);
  const body = await (await request.post('/api/models/check', { data: { ids: [1] } })).json();
  expect(body.error).toMatchObject({ code: 'rate_limited', retryable: true });
});
