import { test, expect } from '../src/fixture';

test('example.com homepage loads with correct content', async ({ page, usePerfContext }) => {
  usePerfContext({ name: 'example-com-homepage', env: 'prod', version: '1.0.0' });

  await page.goto('https://example.com');

  await expect(page.locator('h1')).toHaveText('Example Domain');
  await expect(page.locator('p a')).toHaveAttribute('href', 'https://iana.org/domains/example');
});
