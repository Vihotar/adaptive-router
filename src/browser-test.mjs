import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { read, json } from './storage.mjs';

// Trusted tests are outside the worker's editable files. Generated JS runs only
// in a fresh browser renderer, never in Node, a shell, or the user's browser profile.
export async function testWebsite(root, project, report, digest, { onTestEvent } = {}) {
  const runtime = read(path.join(root, 'browser-runtime.json'));
  const { chromium } = await import(pathToFileURL(runtime.playwrightModule).href);
  onTestEvent?.({ eventType: 'browser', title: 'Launching headless sandboxed Chrome', detail: 'Isolated test environment' });
  const browser = await chromium.launch({ executablePath: runtime.chromeExecutable, headless: true, chromiumSandbox: true });
  const checks = [], errors = [], blocked = [];
  const check = async (name, action) => {
    onTestEvent?.({ eventType: 'test_check', title: `Running check: ${name}`, status: 'in_progress' });
    try {
      await action();
      checks.push({ name, passed: true });
      onTestEvent?.({ eventType: 'test_passed', title: `✓ ${name}`, detail: 'Check verified successfully', status: 'success' });
    } catch (e) {
      const errMsg = e.message.slice(0, 700);
      checks.push({ name, passed: false, error: errMsg });
      onTestEvent?.({ eventType: 'test_failed', title: `✕ ${name}`, detail: errMsg, status: 'failed' });
    }
  };
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1100, height: 800 } });
    const headers = { 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; worker-src 'none'" };
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (url.origin !== 'https://adaptive-router.test' || request.method() !== 'GET' || !['index.html', 'styles.css', 'app.js'].includes(name)) { blocked.push(request.url()); return route.abort(); }
      return route.fulfill({ body: fs.readFileSync(path.join(project, name)), contentType: ({ 'index.html': 'text/html', 'styles.css': 'text/css', 'app.js': 'text/javascript' })[name], headers });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(3500);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('dialog', d => { errors.push('Unexpected browser dialog'); d.dismiss(); });
    onTestEvent?.({ eventType: 'browser', title: 'Navigating to https://adaptive-router.test/', detail: 'Loading sandboxed deliverables' });
    await page.goto('https://adaptive-router.test/', { waitUntil: 'load', timeout: 10000 });
    const name = page.getByRole('textbox', { name: /^name$/i });
    const email = page.getByRole('textbox', { name: /^email$/i });
    const message = page.getByRole('textbox', { name: /^message$/i });
    const submit = page.getByRole('button', { name: /send|submit/i });
    const status = page.getByRole('status');
    await check('Accessible required fields', async () => {
      for (const field of [name, email, message]) { if (!await field.isVisible() || !await field.evaluate(e => e.required)) throw Error('Name, Email and Message must have labels and be required'); }
      if (await email.getAttribute('type') !== 'email') throw Error('Use native email validation');
    });
    await check('Blank form is rejected', async () => { await submit.click(); if (await page.locator('form').evaluate(f => f.checkValidity())) throw Error('Empty form accepted'); if ((await status.textContent()).includes('message not sent')) throw Error('Empty form reported as successful'); });
    await check('Invalid email is rejected', async () => { await name.fill('Test User'); await email.fill('invalid'); await message.fill('Test enquiry'); await submit.click(); if (await page.locator('form').evaluate(f => f.checkValidity())) throw Error('Invalid email accepted'); });
    await check('Valid submission works without sending', async () => { await email.fill('test@example.invalid'); await submit.click(); await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('Demo only: message not sent.')); });
    await check('Mobile layout fits', async () => { await page.setViewportSize({ width: 375, height: 812 }); if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Horizontal overflow on mobile'); });
    await page.screenshot({ path: report.replace(/\.json$/, '.png'), fullPage: true });
    onTestEvent?.({ eventType: 'browser', title: 'Captured verification screenshot', detail: path.basename(report).replace(/\.json$/, '.png') });
    const jsPassed = errors.length === 0;
    checks.push({ name: 'No JavaScript or browser-policy errors', passed: jsPassed, errors });
    onTestEvent?.({ eventType: jsPassed ? 'test_passed' : 'test_failed', title: `${jsPassed ? '✓' : '✕'} No JavaScript or browser-policy errors`, detail: jsPassed ? 'Clean execution in Chrome' : errors.join('; '), status: jsPassed ? 'success' : 'failed' });
    const isolationPassed = blocked.length === 0;
    checks.push({ name: 'No external requests attempted', passed: isolationPassed, blocked });
    onTestEvent?.({ eventType: isolationPassed ? 'test_passed' : 'test_failed', title: `${isolationPassed ? '✓' : '✕'} No external requests attempted`, detail: isolationPassed ? 'Strict network isolation verified' : `Blocked: ${blocked.join(', ')}`, status: isolationPassed ? 'success' : 'failed' });
  } finally { await browser.close(); }
  const result = { passed: checks.every(c => c.passed), digest, checks, time: new Date().toISOString(), execution: 'Fresh sandboxed Chrome; only three project files served in memory; outbound requests blocked; no generated Node/shell code executed' };
  json(report, result);
  onTestEvent?.({ eventType: 'test_summary', title: result.passed ? `All ${checks.length} checks passed` : `${checks.filter(c => !c.passed).length} check(s) failed`, detail: `${checks.filter(c => c.passed).length}/${checks.length} automated browser checks verified in Chrome`, status: result.passed ? 'success' : 'failed' });
  return result;
}
