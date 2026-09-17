import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createEmptyTokenUsage, normalizeUsage, accumulateInvocation, formatTokenUsageLog } from '../src/token-tracker.mjs';
import { codeTask } from '../src/coding.mjs';
import { json } from '../src/storage.mjs';
import { buildSchema } from '../src/contracts.mjs';

test('normalizeUsage extracts Exact tokens when reported by workers', () => {
  // Antigravity format
  const agy = normalizeUsage({ input_tokens: 1400, output_tokens: 600, total_tokens: 2000 }, 'antigravity');
  assert.equal(agy.accuracy, 'Exact');
  assert.equal(agy.inputTokens, 1400);
  assert.equal(agy.outputTokens, 600);
  assert.equal(agy.totalTokens, 2000);

  // Codex format
  const codex = normalizeUsage({ input_tokens: 5000, cached_input_tokens: 200, output_tokens: 400, reasoning_output_tokens: 50 }, 'codex');
  assert.equal(codex.accuracy, 'Exact');
  assert.equal(codex.inputTokens, 5200);
  assert.equal(codex.outputTokens, 450);
  assert.equal(codex.totalTokens, 5650);

  // Claude Code format
  const claude = normalizeUsage({ input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 500, output_tokens: 250 }, 'claude');
  assert.equal(claude.accuracy, 'Exact');
  assert.equal(claude.inputTokens, 1600);
  assert.equal(claude.outputTokens, 250);
  assert.equal(claude.totalTokens, 1850);

  // Cline format
  const cline = normalizeUsage({ inputTokens: 8420, outputTokens: 2180, cacheReadTokens: 100 }, 'cline');
  assert.equal(cline.accuracy, 'Exact');
  assert.equal(cline.inputTokens, 8520);
  assert.equal(cline.outputTokens, 2180);
  assert.equal(cline.totalTokens, 10700);
});

test('normalizeUsage returns Unavailable for empty or 0 tokens without inventing fake numbers', () => {
  const empty = normalizeUsage(null, 'cline');
  assert.equal(empty.accuracy, 'Unavailable');
  assert.equal(empty.totalTokens, null);

  const zeros = normalizeUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }, 'antigravity');
  assert.equal(zeros.accuracy, 'Unavailable');
  assert.equal(zeros.totalTokens, null);
});

test('accumulateInvocation accumulates multi-stage calls without double-counting', () => {
  let usage = createEmptyTokenUsage();

  // Initial build: 8,000 tokens
  usage = accumulateInvocation(usage, {
    id: 'inv_1',
    role: 'builder',
    stage: 'build-1',
    worker: 'cline',
    model: 'gemini-3.5-flash-lite',
    usage: { inputTokens: 6000, outputTokens: 2000, totalTokens: 8000, accuracy: 'Exact' }
  });

  assert.equal(usage.builder.totalTokens, 8000);
  assert.equal(usage.builder.accuracy, 'Exact');
  assert.equal(usage.builder.invocations, 1);

  // Duplicate call with same id must be ignored
  usage = accumulateInvocation(usage, {
    id: 'inv_1',
    role: 'builder',
    stage: 'build-1',
    worker: 'cline',
    model: 'gemini-3.5-flash-lite',
    usage: { inputTokens: 6000, outputTokens: 2000, totalTokens: 8000, accuracy: 'Exact' }
  });
  assert.equal(usage.builder.totalTokens, 8000);
  assert.equal(usage.builder.invocations, 1);

  // Revision 1: 6,500 tokens
  usage = accumulateInvocation(usage, {
    id: 'inv_2',
    role: 'builder',
    stage: 'build-2',
    worker: 'cline',
    model: 'gemini-3.5-flash-lite',
    usage: { inputTokens: 5000, outputTokens: 1500, totalTokens: 6500, accuracy: 'Exact' }
  });
  assert.equal(usage.builder.totalTokens, 14500);
  assert.equal(usage.builder.invocations, 2);

  // Reviewer call 1: 7,000 tokens
  usage = accumulateInvocation(usage, {
    id: 'inv_3',
    role: 'reviewer',
    stage: 'review-1',
    worker: 'antigravity',
    model: 'gemini-3.8-flash-medium',
    usage: { inputTokens: 6000, outputTokens: 1000, totalTokens: 7000, accuracy: 'Exact' }
  });
  assert.equal(usage.reviewer.totalTokens, 7000);
  assert.equal(usage.reviewer.accuracy, 'Exact');

  // Reviewer call 2: 7,200 tokens
  usage = accumulateInvocation(usage, {
    id: 'inv_4',
    role: 'reviewer',
    stage: 'review-2',
    worker: 'antigravity',
    model: 'gemini-3.8-flash-medium',
    usage: { inputTokens: 6200, outputTokens: 1000, totalTokens: 7200, accuracy: 'Exact' }
  });
  assert.equal(usage.reviewer.totalTokens, 14200);
  assert.equal(usage.reviewer.accuracy, 'Exact');

  // Combined Grand Total = 14500 + 14200 = 28700
  assert.equal(usage.totalTokens, 28700);
  assert.equal(usage.totalAccuracy, 'Exact');
  assert.equal(usage.summaryText, '28,700 tokens [Exact]');
});

test('handles Partial honesty when one role has unavailable tokens', () => {
  let usage = createEmptyTokenUsage();

  // Builder exact
  usage = accumulateInvocation(usage, {
    id: 'inv_10',
    role: 'builder',
    stage: 'build-1',
    worker: 'cline',
    model: 'gemini-3.5-flash-lite',
    usage: { inputTokens: 8000, outputTokens: 2000, totalTokens: 10000, accuracy: 'Exact' }
  });

  // Reviewer unavailable
  usage = accumulateInvocation(usage, {
    id: 'inv_11',
    role: 'reviewer',
    stage: 'review-1',
    worker: 'antigravity',
    model: 'gemini-3.8-flash-medium',
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, accuracy: 'Unavailable' }
  });

  assert.equal(usage.builder.totalTokens, 10000);
  assert.equal(usage.reviewer.totalTokens, null);
  assert.equal(usage.reviewer.accuracy, 'Unavailable');
  assert.equal(usage.totalAccuracy, 'Partial');
  assert.match(usage.summaryText, /Partial/);
  assert.match(usage.summaryText, /Builder exact/);
  assert.match(usage.summaryText, /Reviewer unavailable/);
});

test('formatTokenUsageLog produces required technical log format', () => {
  const line = formatTokenUsageLog({
    role: 'builder',
    worker: 'cline',
    model: 'gemini-3.5-flash-lite',
    usage: { inputTokens: 8420, outputTokens: 2180, totalTokens: 10600, accuracy: 'Exact' }
  });
  assert.equal(line, '[TOKEN_USAGE] Builder (Cline — gemini-3.5-flash-lite) consumed 10,600 tokens (input: 8,420, output: 2,180) [Exact]');
});

test('codeTask accurately tracks and persists token usage for builder and reviewer in task.json and events.jsonl', async () => {
  const baseConfig = {
    workers: [
      { id: 'codex', enabled: true, roles: ['plan', 'build', 'review'], priority: 10, adapter: 'codex' },
      { id: 'antigravity', enabled: true, roles: ['review', 'build'], priority: 30, adapter: 'antigravity' },
      { id: 'claude-code', enabled: true, roles: ['build', 'review'], priority: 20, adapter: 'claude' },
      { id: 'cline', enabled: true, roles: ['build'], priority: 35, adapter: 'cline' }
    ],
    maxCorrections: 2,
    workerTimeoutSeconds: 180,
    claudeReserve: true,
    connectorToken: 'test'
  };

  const files = ['index.html', 'styles.css', 'app.js'].map(name => ({
    path: name,
    content: fs.readFileSync(path.join('fixtures/test-site', name), 'utf8')
  }));
  const formFiles = files.map(f => f.path === 'index.html' ? {
    ...f,
    content: f.content.replace('A contact form will be added here.', '<form id="contact-form"><input id="contact-name" required><button type="submit">Send message</button></form>')
  } : f);
  const build = { summary: 'Test code', files: formFiles };

  const root = fs.mkdtempSync(path.resolve('.router/tests/token-e2e-'));
  try {
    fs.cpSync('fixtures', path.join(root, 'fixtures'), { recursive: true });
    json(path.join(root, 'workers.json'), baseConfig);

    const t = await codeTask(root, 'Add a contact form', {
      project: 'test-site',
      ready() {},
      log() {},
      paths: {},
      call: async (w, req) => {
        if (req.schema === buildSchema) {
          req.onUsage?.({ input_tokens: 8420, output_tokens: 2180, total_tokens: 10600 });
          return structuredClone(build);
        } else {
          req.onUsage?.({ input_tokens: 4200, output_tokens: 800, total_tokens: 5000 });
          return { verdict: 'pass', summary: 'Clean implementation', issues: [] };
        }
      },
      test: async (_r, _p, report, digest) => {
        const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
        json(report, r);
        return r;
      }
    });

    // Check task.json
    const taskFile = path.join(root, '.router/tasks', t.id, 'task.json');
    const diskTask = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    assert.ok(diskTask.tokenUsage, 'task.json must contain tokenUsage');
    assert.equal(diskTask.tokenUsage.builder.totalTokens, 10600);
    assert.equal(diskTask.tokenUsage.builder.inputTokens, 8420);
    assert.equal(diskTask.tokenUsage.builder.outputTokens, 2180);
    assert.equal(diskTask.tokenUsage.builder.accuracy, 'Exact');

    assert.equal(diskTask.tokenUsage.reviewer.totalTokens, 5000);
    assert.equal(diskTask.tokenUsage.reviewer.inputTokens, 4200);
    assert.equal(diskTask.tokenUsage.reviewer.outputTokens, 800);
    assert.equal(diskTask.tokenUsage.reviewer.accuracy, 'Exact');

    assert.equal(diskTask.tokenUsage.totalTokens, 15600);
    assert.equal(diskTask.tokenUsage.totalAccuracy, 'Exact');

    // Check events.jsonl
    const eventsFile = path.join(root, '.router/tasks', t.id, 'events.jsonl');
    const events = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const tokenEvents = events.filter(e => e.eventType === 'token_usage');
    assert.equal(tokenEvents.length, 2);
    // Token accounting names the provider that actually served the request
    // (the Cline runtime is plumbing, not a provider identity).
    assert.equal(tokenEvents[0].title, '[TOKEN_USAGE] Builder (Google AI Studio (Gemini) — gemini-3.5-flash-lite) consumed 10,600 tokens (input: 8,420, output: 2,180) [Exact]');
    assert.equal(tokenEvents[1].title, '[TOKEN_USAGE] Reviewer (Antigravity — gemini-3.8-flash-medium) consumed 5,000 tokens (input: 4,200, output: 800) [Exact]');

    // Verify activity.jsonl has no raw token telemetry noise
    const activityFile = path.join(root, '.router/tasks', t.id, 'activity.jsonl');
    if (fs.existsSync(activityFile)) {
      const act = fs.readFileSync(activityFile, 'utf8');
      assert.ok(!act.includes('[TOKEN_USAGE]'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
