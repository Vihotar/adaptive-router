import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getPlatformUsageShare, listProviderLogoAssets } from '../src/server.mjs';

// Final UI Closure — the three items in this commit.

function seedTask(root, id, task) {
  const dir = path.join(root, '.router', 'tasks', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ id, ...task }, null, 2));
}

// ── Item 1: platform usage bars must be measured, never a guessed quota ──

test('getPlatformUsageShare: attributes real recorded tokens per platform', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-usage-'));
  seedTask(root, '20260101T000000-aaaaaaaa', {
    status: 'approved',
    created: '2026-01-01T00:00:00.000Z',
    tokenUsage: {
      invocations: [
        { role: 'builder', worker: 'codex', totalTokens: 60000, accuracy: 'Exact' },
        { role: 'reviewer', worker: 'antigravity', totalTokens: 40000, accuracy: 'Exact' }
      ]
    }
  });
  const share = getPlatformUsageShare(root);
  assert.equal(share.totalTokens, 100000);
  assert.equal(share.taskCount, 1);
  assert.equal(share.accuracy, 'Exact');
  assert.equal(share.byWorker.codex.sharePercent, 60);
  assert.equal(share.byWorker.antigravity.sharePercent, 40);
  fs.rmSync(root, { recursive: true, force: true });
});

test('getPlatformUsageShare: maps platform families to worker ids and falls back to role totals', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-usage-map-'));
  seedTask(root, '20260102T000000-bbbbbbbb', {
    status: 'approved',
    created: '2026-01-02T00:00:00.000Z',
    // Older shape: no per-invocation list, platform family names only.
    tokenUsage: {
      builder: { totalTokens: 30000, accuracy: 'Estimated', platform: 'claude' },
      reviewer: { totalTokens: 10000, accuracy: 'Estimated', platform: 'agy' }
    }
  });
  const share = getPlatformUsageShare(root);
  assert.equal(share.byWorker['claude-code'].tokens, 30000, 'claude maps to the claude-code worker id');
  assert.equal(share.byWorker.antigravity.tokens, 10000, 'agy maps to the antigravity worker id');
  assert.equal(share.accuracy, 'Estimated');
  fs.rmSync(root, { recursive: true, force: true });
});

test('getPlatformUsageShare: reports zero rather than inventing a figure when nothing is recorded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-usage-empty-'));
  seedTask(root, '20260103T000000-cccccccc', {
    status: 'cancelled',
    created: '2026-01-03T00:00:00.000Z',
    tokenUsage: { builder: { totalTokens: null, accuracy: 'Unavailable' }, reviewer: { totalTokens: null, accuracy: 'Unavailable' }, invocations: [] }
  });
  const share = getPlatformUsageShare(root);
  assert.equal(share.totalTokens, 0);
  assert.equal(share.taskCount, 0);
  assert.equal(share.accuracy, 'Unavailable');
  assert.deepEqual(share.byWorker, {});
  fs.rmSync(root, { recursive: true, force: true });
});

test('platform cards never claim or imply a provider quota', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'src', 'web', 'index.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  const js = fs.readFileSync(path.join(process.cwd(), 'src', 'web', 'app.js'), 'utf8')
    .replace(/\/\/.*/g, '');

  assert.ok(html.includes('Recent AR token share'), 'the bar names AR\'s own token share, not consumption of an allowance');
  assert.ok(html.includes('Provider quota not reported'), 'the quota state is stated separately and explicitly');
  assert.ok(js.includes('quotaReported'), 'the client reads the honest quota flag');

  // The bar may look like the prototype's, but it must never carry
  // used/remaining/quota framing unless a provider genuinely reports one.
  for (const banned of ['Used:', 'Remaining:', 'Quota used', 'Usage limit', 'quota used', 'usage limit']) {
    assert.ok(!html.includes(banned), `rendered markup must not say "${banned}"`);
    assert.ok(!js.includes(banned), `client strings must not say "${banned}"`);
  }
  assert.ok(!/Used:\s*<strong>\d+%/.test(html), 'no hardcoded demo usage percentages');
});

// ── Item 2: task detail modal ───────────────────────────────────────────

test('task detail modal markup and wiring exist', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'src', 'web', 'index.html'), 'utf8');
  assert.ok(html.includes('id="task-detail-modal"'), 'modal overlay present');
  assert.ok(html.includes('id="task-detail-modal-body"'), 'modal body present');
  assert.ok(html.includes('id="task-detail-modal-close"'), 'close control present');

  const js = fs.readFileSync(path.join(process.cwd(), 'src', 'web', 'app.js'), 'utf8');
  assert.ok(js.includes('function openTaskDetailModal'), 'open handler present');
  assert.ok(js.includes('function closeTaskDetailModal'), 'close handler present');
  assert.ok(js.includes('initTaskDetailModal()'), 'modal is initialised on boot');
  // The row click must open the modal in place, not navigate to Overview.
  assert.ok(js.includes('openTaskDetailModal(id);'), 'row click opens the modal');
});

// ── Item 3: provider logo assets ────────────────────────────────────────

test('listProviderLogoAssets: reports only files that genuinely exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-logos-'));
  const dir = path.join(root, 'src', 'web', 'assets', 'logos');
  fs.mkdirSync(dir, { recursive: true });
  assert.deepEqual(listProviderLogoAssets(root), {}, 'no files means no logos claimed');

  fs.writeFileSync(path.join(dir, 'codex.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  fs.writeFileSync(path.join(dir, 'grok.png'), 'not-really-a-png');
  fs.writeFileSync(path.join(dir, 'ignored.svg'), '<svg/>');
  const found = listProviderLogoAssets(root);
  assert.equal(found.codex, 'assets/logos/codex.svg');
  assert.equal(found.grok, 'assets/logos/grok.png');
  assert.ok(!('ignored' in found), 'only known seat ids are served');
  assert.ok(!('gemini' in found), 'a seat with no file is absent, not guessed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('Office View renders provider nodes, not robot illustrations', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'src', 'web', 'app.js'), 'utf8');
  assert.ok(js.includes('function renderProviderMark'), 'provider mark renderer present');
  assert.ok(!js.includes('renderRobotAvatarSvg'), 'robot avatar renderer is gone');
  assert.ok(js.includes('office-seat-logo'), 'supplied official assets are rendered');
  assert.ok(js.includes('office-seat-fallback'), 'neutral fallback node is rendered');

  const css = fs.readFileSync(path.join(process.cwd(), 'src', 'web', 'prototype.css'), 'utf8');
  assert.ok(css.includes('object-fit: contain'), 'supplied logos keep their own proportions');
  assert.ok(!css.includes('.office-pod-desk'), 'office furniture styling is gone');

  // Cline must not be a business-facing seat.
  const seatBlock = js.slice(js.indexOf('const OFFICE_SEATS'), js.indexOf('function renderProviderMark'));
  assert.ok(!/id:\s*'cline'/.test(seatBlock), 'Cline is not a visible Office View seat');
  for (const id of ['claude-code', 'codex', 'antigravity', 'gemini', 'nvidia-nim', 'openrouter', 'grok']) {
    assert.ok(seatBlock.includes(`id: '${id}'`), `${id} seat present`);
  }
});

test('prototype reference page remains untouched by this change', () => {
  const proto = fs.readFileSync(path.join(process.cwd(), 'src', 'web', 'prototype.html'), 'utf8');
  assert.ok(proto.includes('prototype-legacy.css'), 'prototype keeps its own isolated stylesheet');
  assert.ok(proto.includes('id="task-detail-modal"'), 'prototype still has its own reference modal');
});
