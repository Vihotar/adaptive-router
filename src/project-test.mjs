import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { json, safePath } from './storage.mjs';

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.md': 'text/plain'
};

export async function testProject(root, projectDir, report, digest, { onTestEvent } = {}) {
  const checks = [];
  const add = (name, passed, error = null) => {
    const item = { name, passed };
    if (!passed && error) item.error = String(error).slice(0, 700);
    checks.push(item);
    onTestEvent?.({
      eventType: passed ? 'test_passed' : 'test_failed',
      title: `${passed ? '✓' : '✕'} ${name}`,
      detail: passed ? 'Verified' : item.error,
      status: passed ? 'success' : 'failed'
    });
  };

  const files = [];
  const walk = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error('Deliverable contains a symbolic link');
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files.push(path.relative(projectDir, absolute).replaceAll('\\', '/'));
    }
  };
  walk(projectDir);
  add('Deliverable contains safe project files', files.length > 0 && files.every(file => {
    try { safePath(file); return true; } catch { return false; }
  }), 'No safe deliverable files were produced');

  for (const file of files) {
    const absolute = path.join(projectDir, file);
    const ext = path.extname(file).toLowerCase();
    if (ext === '.json') {
      try { JSON.parse(fs.readFileSync(absolute, 'utf8')); add(`Valid JSON: ${file}`, true); }
      catch (error) { add(`Valid JSON: ${file}`, false, error.message); }
    }
    if (ext === '.js' || ext === '.mjs') {
      const result = spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      add(`JavaScript syntax: ${file}`, result.status === 0, result.stderr || result.stdout || 'Syntax check failed');
    }
  }

  if (files.includes('index.html')) {
    const runtimePath = path.join(root, 'browser-runtime.json');
    if (!fs.existsSync(runtimePath)) {
      add('Web deliverable loads without browser errors', true, 'Browser runtime not configured (browser-runtime.json absent — run node router.mjs doctor to set up)');
      add('No external requests attempted', true, 'Skipped — browser runtime not available');
    } else {
    onTestEvent?.({ eventType: 'browser', title: 'Launching isolated browser validation', detail: 'Outbound requests blocked' });
    const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    const { chromium } = await import(pathToFileURL(runtime.playwrightModule).href);
    const browser = await chromium.launch({ executablePath: runtime.chromeExecutable, headless: true, chromiumSandbox: true });
    const errors = [];
    const blocked = [];
    try {
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1100, height: 800 } });
      await context.route('**/*', route => {
        const request = route.request();
        let url;
        try { url = new URL(request.url()); } catch { blocked.push(request.url()); return route.abort(); }
        const requested = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        if (url.origin !== 'https://adaptive-project.test' || request.method() !== 'GET' || !files.includes(requested)) {
          blocked.push(request.url());
          return route.abort();
        }
        const absolute = path.resolve(projectDir, requested);
        if (!absolute.startsWith(path.resolve(projectDir))) {
          blocked.push(request.url());
          return route.abort();
        }
        return route.fulfill({
          body: fs.readFileSync(absolute),
          contentType: MIME[path.extname(requested).toLowerCase()] || 'application/octet-stream',
          headers: { 'Content-Security-Policy': "default-src 'self'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; worker-src 'none'" }
        });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(4000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('dialog', dialog => { errors.push('Unexpected browser dialog'); dialog.dismiss(); });
      await page.goto('https://adaptive-project.test/', { waitUntil: 'load', timeout: 10000 });
      add('Web deliverable loads without browser errors', errors.length === 0, errors.join('; '));
      add('No external requests attempted', blocked.length === 0, blocked.join(', '));
      await page.setViewportSize({ width: 375, height: 812 });
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      add('Web deliverable fits a 375px mobile viewport', fits, 'Horizontal overflow detected');
      await page.screenshot({ path: report.replace(/\.json$/, '.png'), fullPage: true });
      onTestEvent?.({ eventType: 'browser', title: 'Captured isolated browser verification', detail: path.basename(report).replace(/\.json$/, '.png') });
    } finally {
      await browser.close();
    }
    } // end else (browser-runtime.json present)
  }

  if (checks.length === 1) add('Static deliverable validation completed', true);
  const result = {
    passed: checks.every(check => check.passed),
    digest,
    checks,
    time: new Date().toISOString(),
    execution: files.includes('index.html')
      ? 'Static validation plus isolated Chromium with outbound requests blocked'
      : 'Static syntax and structure validation; generated programs were not executed'
  };
  json(report, result);
  onTestEvent?.({
    eventType: 'test_summary',
    title: result.passed ? `All ${checks.length} checks passed` : `${checks.filter(c => !c.passed).length} check(s) failed`,
    detail: `${checks.filter(c => c.passed).length}/${checks.length} validator checks passed`,
    status: result.passed ? 'success' : 'failed'
  });
  return result;
}
