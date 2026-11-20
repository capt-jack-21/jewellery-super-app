// Dev smoke (mocks on): logs in as each surface, screenshots every screen, checks offline billing gate.
// Usage: node scripts/smoke.mjs [baseUrl]  → screenshots/{f0,platform}/*.png
import { chromium } from 'playwright-core';
const base = process.argv[2] ?? 'http://localhost:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errors = [];
let failed = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failed++; };

async function session(login, otp) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 820 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${login}: ${e}`));
  page.on('console', (m) => m.type() === 'error' && !/manifest|favicon/i.test(m.text()) && errors.push(`${login}: ${m.text()}`));
  await page.goto(base + '/login');
  await page.locator('input[autocomplete="username"]').fill(login);
  await page.locator('input[type="password"]').fill('Password@123');
  await page.locator('button[type="submit"]').click();
  if (otp) { await page.locator('input[autocomplete="one-time-code"]').fill('123456'); await page.locator('button[type="submit"]').click(); }
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  return { ctx, page };
}
async function shot(page, path, dir, name) {
  await page.goto(base + path);
  await page.waitForSelector('main', { timeout: 15000 });
  await page.waitForTimeout(900);
  const file = `screenshots/${dir}/${name ?? (path.replace(/\//g, '_').replace(/^_/, '') || 'home')}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`shot ${path} -> ${file}`);
}

// ---- Tenant owner
const { ctx, page } = await session('owner', true);
for (const p of ['/', '/counter', '/device', '/setup', '/setup?step=4', '/settings/tax', '/settings/language', '/settings/print', '/settings/import', '/dev/print'])
  await shot(page, p, 'f0', p === '/setup?step=4' ? 'setup_step4' : undefined);
for (const p of ['/settings/shop', '/settings/branches', '/settings/users', '/settings/roles', '/settings/devices', '/settings/branding', '/settings/domains', '/settings/rules', '/audit', '/dev/tokens'])
  await shot(page, p, 'platform');
await page.goto(base + '/settings/gst-rates'); await page.waitForTimeout(600);
check('/settings/gst-rates redirects to /settings/tax', new URL(page.url()).pathname === '/settings/tax');

// Offline: banner + bill/estimate disabled
await page.goto(base + '/counter'); await page.waitForTimeout(800);
await ctx.setOffline(true);
await page.evaluate(() => window.dispatchEvent(new Event('offline')));
await page.waitForTimeout(500);
check('offline banner visible', await page.getByTestId('offline-banner').isVisible());
const gate = await page.getByTestId('device-gate').count();
if (gate) console.log('note: device gate shown (unregistered device) — bill buttons not rendered');
else {
  check('bill button disabled offline', await page.getByTestId('bill-button').isDisabled());
  check('estimate button disabled offline', await page.getByTestId('estimate-button').isDisabled());
}
await page.screenshot({ path: 'screenshots/f0/counter_offline.png', fullPage: true });
await page.goto(base + '/settings/tax').catch(() => {}); await page.waitForTimeout(800);
await page.screenshot({ path: 'screenshots/f0/settings_tax_offline.png', fullPage: true });
await ctx.setOffline(false);
await ctx.close();

// ---- Partner + platform admin
for (const [login, otp, paths] of [['partner', false, ['/partner', '/partner/branding', '/partner/domains', '/partner/billing']], ['admin', true, ['/admin', '/admin/partners']]]) {
  const s = await session(login, otp);
  for (const p of paths) await shot(s.page, p, 'platform');
  await s.ctx.close();
}
console.log('errors:', errors);
await browser.close();
process.exit(failed ? 1 : 0);
