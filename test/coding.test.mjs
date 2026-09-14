import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withFailover, candidates, isQuotaError } from '../src/failover.mjs';
import { codeTask, validateWebFiles } from '../src/coding.mjs';
import { findClaudeExe } from '../src/workers.mjs';
import { read, json } from '../src/storage.mjs';
import { buildSchema } from '../src/contracts.mjs';
import { decide } from '../src/router.mjs';
import { classifyTask, selectModelAndEffort, platformModelTiers } from '../src/smart-router.mjs';
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
  connectorToken: 'CONNECTOR_TOKEN_REGENERATED_ON_FIRST_RUN'
};
const failoverConfig = {
  ...baseConfig,
  workers: [
    { id: 'codex', enabled: true, roles: ['plan', 'build', 'review'], priority: 10, adapter: 'codex' },
    { id: 'antigravity', enabled: true, roles: ['review', 'build'], priority: 30, adapter: 'antigravity' },
    { id: 'claude-code', enabled: true, roles: ['build', 'review'], priority: 20, adapter: 'claude' }
  ]
};
const files = ['index.html', 'styles.css', 'app.js'].map(name => ({ path: name, content: fs.readFileSync(path.join('fixtures/test-site', name), 'utf8') }));
const formFiles = files.map(f => f.path === 'index.html' ? { ...f, content: f.content.replace('A contact form will be added here.', '<form id="contact-form"><input id="contact-name" required><button type="submit">Send message</button></form>') } : f);
const build = { summary: 'Test code', files: formFiles };
const baselineBuild = { summary: 'Stale baseline code', files };
const fixtureCodeTask = (root, instruction, options = {}) => codeTask(root, instruction, { project: 'test-site', ...options });
test('quota failure tries Claude then Antigravity when Claude is permitted', async () => {
  const dir = fs.mkdtempSync(path.resolve('.router/tests/failover-'));
  const seen = [];
  const r = await withFailover({ config: failoverConfig, role: 'build', allowClaude: true, failed: new Set(), paths: {}, root: process.cwd(), dir, stage: 'test', schema: buildSchema, prompt: 'test', ready() {}, log() {}, call: async w => { seen.push(w.id); if (w.id !== 'antigravity') throw Error('quota exhausted'); return build; } });
  assert.deepEqual(seen, ['codex', 'claude-code', 'antigravity']); assert.equal(r.worker, 'antigravity');
});
test('quota failure with Claude Reserve Mode ON skips Claude Code and goes directly to Antigravity', async () => {
  const dir = fs.mkdtempSync(path.resolve('.router/tests/failover-'));
  const seen = [];
  const r = await withFailover({ config: failoverConfig, role: 'build', claudeReserve: true, allowClaude: false, failed: new Set(), paths: {}, root: process.cwd(), dir, stage: 'test', schema: buildSchema, prompt: 'test', ready() {}, log() {}, call: async w => { seen.push(w.id); if (w.id !== 'antigravity') throw Error('quota exhausted'); return build; } });
  assert.deepEqual(seen, ['codex', 'antigravity']); assert.equal(r.worker, 'antigravity');
});
test('review excludes every contributor, even when another builder took over', () => {
  assert.deepEqual(candidates(failoverConfig, 'review', ['codex', 'claude-code']).map(w => w.id), ['antigravity']);
  assert.deepEqual(candidates(failoverConfig, 'review', ['codex', 'claude-code', 'antigravity']), []);
});
test('web recipe refuses edits to its test harness or router', () => {
  assert.throws(() => validateWebFiles([...files, { path: 'tests.js', content: '' }]));
});
function fixture(customConfig = null) {
  const root = fs.mkdtempSync(path.resolve('.router/tests/web-'));
  fs.cpSync('fixtures', path.join(root, 'fixtures'), { recursive: true });
  json(path.join(root, 'workers.json'), customConfig || baseConfig);
  return root;
}
test('browser failure causes correction; reviewer failure saves work and resumes independently', async () => {
  const root = fixture(); let tests = 0, calls = 0;
  const opts = { ready() {}, log() {}, paths: {}, call: async (_w, request) => { calls++; if (request.schema === buildSchema) return structuredClone(build); throw Error('Reviewer quota exhausted'); }, test: async (_root, _project, report, digest) => { const r = { passed: ++tests > 1, digest, checks: [{ name: 'submit', passed: tests > 1 }] }; json(report, r); return r; } };
  const t = await fixtureCodeTask(root, 'Add a contact form', opts);
  assert.equal(t.revision, 2); assert.equal(t.status, 'waiting_for_reviewer');
  await assert.rejects(decide(root, t.id, 'approved'));
  const resumed = await fixtureCodeTask(root, '', { ...opts, resume: t.id, call: async (w) => { assert.equal(w.id, 'antigravity'); return { verdict: 'pass', summary: 'Fine', issues: [] }; } });
  assert.equal(resumed.status, 'awaiting_approval'); assert.equal(tests, 2);
  assert.equal((await decide(root, t.id, 'approved')).status, 'approved');
});
test('failed or mismatched browser tests prevent coding approval', async () => {
  const root = fixture();
  const t = await fixtureCodeTask(root, 'Add a contact form', { ready() {}, log() {}, paths: {}, call: async (_w, r) => r.schema === buildSchema ? structuredClone(build) : { verdict: 'pass', summary: 'Fine', issues: [] }, test: async (_r, _p, report, digest) => { const r = { passed: true, digest, checks: [{ passed: true }] }; json(report, r); return r; } });
  const report = path.join(root, '.router/tasks', t.id, 'tests-1.json'); const r = read(report); r.passed = false; json(report, r);
  await assert.rejects(decide(root, t.id, 'approved'), /matching passed tests/);
});
test('approval report clearly points to tested final artifact and clears stale failure feedback', async () => {
  const root = fixture(codexConfig);
  let testsCount = 0;
  const t = await fixtureCodeTask(root, 'Add a contact form', {
    ready() {}, log() {}, paths: {},
    call: async (_w, r) => r.schema === buildSchema ? structuredClone(build) : { verdict: 'pass', summary: 'Fine', issues: [] },
    test: async (_r, _p, report, digest) => {
      testsCount++;
      const passed = testsCount > 1;
      const r = { passed, digest, checks: [{ name: 'check', passed }] };
      json(report, r);
      return r;
    }
  });
  assert.equal(t.status, 'awaiting_approval');
  assert.equal(t.revision, 2);
  assert.equal(t.feedback, undefined);
  assert.ok(t.testedArtifact && fs.existsSync(t.testedArtifact));
  assert.match(t.websiteUrl, /^file:\/\/\//);
  assert.ok(t.approvalReport && fs.existsSync(t.approvalReport));
  const reportContent = fs.readFileSync(t.approvalReport, 'utf8');
  assert.ok(reportContent.includes(`deliverables-${t.revision}/index.html`));
  assert.ok(reportContent.includes(t.websiteUrl));
  assert.ok(reportContent.includes(t.digest));
  assert.ok(reportContent.includes(t.projectRoot));
  assert.ok(reportContent.includes(t.contextHash));
  assert.equal((await decide(root, t.id, 'approved')).status, 'approved');
});
test('stale unmodified baseline deliverables are rejected and cannot be approved', async () => {
  const root = fixture(codexConfig);
  const t = await fixtureCodeTask(root, 'Add a contact form', {
    ready() {}, log() {}, paths: {},
    call: async (_w, r) => r.schema === buildSchema ? structuredClone(baselineBuild) : { verdict: 'pass', summary: 'Fine', issues: [] },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });
  assert.equal(t.status, 'failed');
  assert.match(t.error, /stale|baseline/i);
  await assert.rejects(decide(root, t.id, 'approved'));
});
test('mismatched or missing approval report prevents approval', async () => {
  const root = fixture(codexConfig);
  const t = await fixtureCodeTask(root, 'Add a contact form', {
    ready() {}, log() {}, paths: {},
    call: async (_w, r) => r.schema === buildSchema ? structuredClone(build) : { verdict: 'pass', summary: 'Fine', issues: [] },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });
  assert.equal(t.status, 'awaiting_approval');
  const reportFile = path.join(root, '.router/tasks', t.id, 'APPROVAL.md');
  fs.writeFileSync(reportFile, '# Tampered report pointing to wrong deliverable\n[Website](deliverables-999/index.html)\n');
  await assert.rejects(decide(root, t.id, 'approved'), /Approval report does not match/);
});
test('dynamic findClaudeExe finds newest version in package directory', () => {
  const tmp = fs.mkdtempSync(path.resolve('.router/tests/claude-find-'));
  const pkg = path.join(tmp, 'Packages', 'Claude_dummy123', 'LocalCache', 'Roaming', 'Claude', 'claude-code');
  fs.mkdirSync(path.join(pkg, '2.1.200'), { recursive: true });
  fs.writeFileSync(path.join(pkg, '2.1.200', 'claude.exe'), '');
  fs.mkdirSync(path.join(pkg, '2.1.265'), { recursive: true });
  fs.writeFileSync(path.join(pkg, '2.1.265', 'claude.exe'), '');
  fs.mkdirSync(path.join(pkg, '2.1.99'), { recursive: true });
  fs.writeFileSync(path.join(pkg, '2.1.99', 'claude.exe'), '');
  
  const found = findClaudeExe({ LOCALAPPDATA: tmp, USERPROFILE: tmp });
  assert.equal(found, path.join(pkg, '2.1.265', 'claude.exe'));
});
test('unavailableBuilders skips Codex as builder; Claude builds and Codex independently reviews', async () => {
  const root = fixture(codexConfig);
  const seenWorkers = [];
  const t = await fixtureCodeTask(root, 'Add a contact form', {
    ready() {}, log() {}, paths: {},
    unavailableBuilders: ['codex'],
    allowClaude: true,
    call: async (worker, r) => {
      seenWorkers.push(worker.id);
      if (r.schema === buildSchema) {
        assert.equal(worker.id, 'claude-code');
        return structuredClone(build);
      }
      assert.equal(worker.id, 'codex');
      return { verdict: 'pass', summary: 'Fine', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });
  assert.equal(t.status, 'awaiting_approval');
  assert.deepEqual(t.contributors, ['claude-code']);
  assert.equal(t.reviewer, 'codex');
  assert.deepEqual(seenWorkers, ['claude-code', 'codex']);
});

test('unavailableBuilders skips Codex; Claude Reserve Mode ON avoids Claude and chooses Antigravity', async () => {
  const root = fixture(codexConfig);
  const seenWorkers = [];
  const t = await fixtureCodeTask(root, 'Add a contact form', {
    ready() {}, log() {}, paths: {},
    unavailableBuilders: ['codex'],
    // claudeReserve defaults to true, allowClaude is false
    call: async (worker, r) => {
      seenWorkers.push(worker.id);
      if (r.schema === buildSchema) {
        assert.equal(worker.id, 'antigravity');
        return structuredClone(build);
      }
      return { verdict: 'pass', summary: 'Fine', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });
  // Antigravity built and Codex reviewed; Claude was completely bypassed and preserved
  assert.equal(t.status, 'awaiting_approval');
  assert.deepEqual(t.contributors, ['antigravity']);
  assert.equal(t.reviewer, 'codex');
  assert.deepEqual(seenWorkers, ['antigravity', 'codex']);
  assert.ok(!seenWorkers.includes('claude-code'));
});

test('isQuotaError accurately detects real quota and usage-limit patterns and rejects normal errors', () => {
  assert.equal(isQuotaError(Error("You've reached your usage limit for GPT-4. Limit resets at 12:00 PM.")), true);
  assert.equal(isQuotaError(Error("Worker failed (exit 1): 429 Too Many Requests")), true);
  assert.equal(isQuotaError(Error("insufficient_quota: You have exceeded your current quota.")), true);
  assert.equal(isQuotaError(Error("Claude Code failed: rate_limit_error: Rate limit exceeded")), true);
  assert.equal(isQuotaError(Error("overloaded_error: Claude is temporarily overloaded")), true);
  assert.equal(isQuotaError(Error("Credit balance is too low to complete this request.")), true);
  assert.equal(isQuotaError(null, "Your organization has reached its capacity limit"), true);

  // Normal / non-quota errors must NOT be flagged as quota
  assert.equal(isQuotaError(Error("Worker failed (exit 1): command not found")), false);
  assert.equal(isQuotaError(Error("SyntaxError: Unexpected token < in JSON at position 0")), false);
  assert.equal(isQuotaError(Error("EACCES: permission denied")), false);
  assert.equal(isQuotaError(null, "normal diagnostic message"), false);
});

test('real quota error from Codex automatically triggers immediate failover to Claude when Claude is permitted', async () => {
  const root = fixture(codexConfig);
  const logged = [];
  const seenWorkers = [];

  const t = await fixtureCodeTask(root, 'Add a contact form', {
    ready() {},
    log(msg) { logged.push(msg); },
    paths: {},
    allowClaude: true,
    call: async (worker, r) => {
      seenWorkers.push(worker.id);
      if (worker.id === 'codex' && r.schema === buildSchema) {
        const err = Error("Worker failed (exit 1): You've reached your usage limit for GPT-4.");
        err.stderr = "warning: usage limit reached";
        throw err;
      }
      if (worker.id === 'claude-code' && r.schema === buildSchema) {
        return structuredClone(build);
      }
      if (worker.id === 'antigravity') {
        return { verdict: 'pass', summary: 'All good', issues: [] };
      }
      throw Error(`Unexpected worker ${worker.id}`);
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });

  assert.equal(t.status, 'awaiting_approval');
  assert.deepEqual(t.contributors, ['claude-code']);
  assert.equal(t.reviewer, 'antigravity');
  assert.deepEqual(seenWorkers, ['codex', 'claude-code', 'antigravity']);
  assert.ok(logged.some(msg => msg.includes('codex reached quota or usage limit. Immediately trying the next available worker.')));

  // Check event record
  const events = fs.readFileSync(path.join(root, '.router', 'tasks', t.id, 'events.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(s => JSON.parse(s));
  const unavail = events.find(e => e.type === 'worker_unavailable' && e.worker === 'codex');
  assert.ok(unavail);
  assert.equal(unavail.isQuota, true);
});

test('real quota error from Codex with Claude Reserve Mode ON does NOT silently use Claude; fails over to Antigravity', async () => {
  const root = fixture(codexConfig);
  const logged = [];
  const seenWorkers = [];

  const t = await fixtureCodeTask(root, 'Add a contact form', {
    ready() {},
    log(msg) { logged.push(msg); },
    paths: {},
    // Claude Reserve Mode is ON by default and allowClaude is false
    call: async (worker, r) => {
      seenWorkers.push(worker.id);
      if (worker.id === 'codex' && r.schema === buildSchema) {
        const err = Error("Worker failed (exit 1): You've reached your usage limit for GPT-4.");
        err.stderr = "warning: usage limit reached";
        throw err;
      }
      if (worker.id === 'antigravity' && r.schema === buildSchema) {
        return structuredClone(build);
      }
      throw Error(`Unexpected worker ${worker.id}`);
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });

  // Antigravity built without touching Claude Code
  assert.equal(t.status, 'waiting_for_reviewer');
  assert.deepEqual(t.contributors, ['antigravity']);
  assert.deepEqual(seenWorkers, ['codex', 'antigravity']);
  assert.ok(!seenWorkers.includes('claude-code'));
  assert.ok(logged.some(msg => msg.includes('codex reached quota or usage limit')));
});

test('sequential quota failures from Codex and Claude automatically fall back to Antigravity builder', async () => {
  const root = fixture(codexConfig);
  const logged = [];
  const seenWorkers = [];

  const t = await fixtureCodeTask(root, 'Add a contact form', {
    ready() {},
    log(msg) { logged.push(msg); },
    paths: {},
    allowClaude: true,
    call: async (worker, r) => {
      seenWorkers.push(worker.id);
      if (worker.id === 'codex') {
        throw Error("Worker failed (exit 1): 429 Too Many Requests - rate limit exceeded");
      }
      if (worker.id === 'claude-code') {
        throw Error("Claude Code failed: rate_limit_error: credit balance is too low");
      }
      if (worker.id === 'antigravity' && r.schema === buildSchema) {
        return structuredClone(build);
      }
      throw Error(`Unexpected worker ${worker.id}`);
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });

  // Antigravity built, but Codex and Claude both failed with quota errors, so no independent reviewer remained
  assert.equal(t.status, 'waiting_for_reviewer');
  assert.deepEqual(t.contributors, ['antigravity']);
  assert.deepEqual(seenWorkers, ['codex', 'claude-code', 'antigravity']);
  assert.ok(logged.some(msg => msg.includes('codex reached quota or usage limit')));
  assert.ok(logged.some(msg => msg.includes('claude-code reached quota or usage limit')));
});

test('classifyTask categorizes tasks correctly into easy, medium, and hard tiers and handles escalation', () => {
  const easy = classifyTask('Simple text change for contact form', null, 0);
  assert.equal(easy.difficulty, 'easy');
  assert.equal(easy.risk, 'low');

  const medium = classifyTask('Add a contact form to the test website', null, 0);
  assert.equal(medium.difficulty, 'medium');
  assert.equal(medium.risk, 'medium');

  const hard = classifyTask('Complex multi-step security-critical contact form', null, 0);
  assert.equal(hard.difficulty, 'hard');
  assert.equal(hard.risk, 'high');

  const escalatedOnFeedback = classifyTask('Add a contact form', { independentReview: { issues: ['missing validation'] } }, 1);
  assert.equal(escalatedOnFeedback.difficulty, 'hard');
  assert.equal(escalatedOnFeedback.risk, 'high');
  assert.ok(escalatedOnFeedback.reason.includes('review findings'));

  const escalatedOnTest = classifyTask('Add a contact form', { automatedTests: { passed: false } }, 1);
  assert.equal(escalatedOnTest.difficulty, 'hard');
  assert.ok(escalatedOnTest.reason.includes('browser test failures'));
});

test('selectModelAndEffort selects appropriate tier, model, and reasoning effort across all platforms', () => {
  // Codex
  const codexTier1 = selectModelAndEffort({ platform: 'codex', role: 'build', difficulty: 'easy', revision: 0 });
  assert.equal(codexTier1.tier, 'tier1');
  assert.equal(codexTier1.model, 'gpt-5.6-luna');
  assert.equal(codexTier1.effort, 'low');

  const codexTier2 = selectModelAndEffort({ platform: 'codex', role: 'build', difficulty: 'medium', revision: 0 });
  assert.equal(codexTier2.tier, 'tier2');
  assert.equal(codexTier2.model, 'gpt-5.6-sol');
  assert.equal(codexTier2.effort, 'medium');

  const codexTier3 = selectModelAndEffort({ platform: 'codex', role: 'build', difficulty: 'hard', revision: 0 });
  assert.equal(codexTier3.tier, 'tier3');
  assert.equal(codexTier3.model, 'gpt-6-astra');
  assert.equal(codexTier3.effort, 'high');

  // Claude
  const claudeTier1 = selectModelAndEffort({ platform: 'claude-code', role: 'build', difficulty: 'easy', revision: 0 });
  assert.equal(claudeTier1.tier, 'tier1');
  assert.equal(claudeTier1.model, 'haiku');
  assert.equal(claudeTier1.effort, 'low');

  const claudeTier2 = selectModelAndEffort({ platform: 'claude-code', role: 'build', difficulty: 'medium', revision: 0 });
  assert.equal(claudeTier2.tier, 'tier2');
  assert.equal(claudeTier2.model, 'sonnet');
  assert.equal(claudeTier2.effort, 'medium');

  const claudeTier3 = selectModelAndEffort({ platform: 'claude-code', role: 'build', difficulty: 'hard', revision: 0 });
  assert.equal(claudeTier3.tier, 'tier3');
  assert.equal(claudeTier3.model, 'opus');
  assert.equal(claudeTier3.effort, 'high');

  // Antigravity
  const agyTier1 = selectModelAndEffort({ platform: 'antigravity', role: 'build', difficulty: 'easy', revision: 0 });
  assert.equal(agyTier1.tier, 'tier1');
  assert.equal(agyTier1.model, 'gemini-3.8-flash-low');
  assert.equal(agyTier1.effort, 'low');

  const agyTier2 = selectModelAndEffort({ platform: 'antigravity', role: 'build', difficulty: 'medium', revision: 0 });
  assert.equal(agyTier2.tier, 'tier2');
  assert.equal(agyTier2.model, 'gemini-3.8-flash-medium');
  assert.equal(agyTier2.effort, 'medium');

  const agyTier3 = selectModelAndEffort({ platform: 'antigravity', role: 'review', difficulty: 'hard', revision: 2 });
  assert.equal(agyTier3.tier, 'tier3');
  assert.equal(agyTier3.model, 'gemini-3.1-pro-high');
  assert.equal(agyTier3.effort, 'high');
});

const codexConfig = {
  ...baseConfig,
  workers: baseConfig.workers.filter(w => w.id !== 'cline')
};

test('easy task selects Tier 1 model with low effort in end-to-end coding task', async () => {
  const root = fixture();
  const routingCaptures = [];

  const t = await fixtureCodeTask(root, 'Simple minor text change: add a contact form', {
    ready() {}, log() {}, paths: {},
    call: async (worker, opts) => {
      routingCaptures.push({ worker: worker.id, model: opts.model, effort: opts.effort });
      if (opts.schema === buildSchema) return structuredClone(build);
      return { verdict: 'pass', summary: 'Approved', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });

  assert.equal(t.status, 'awaiting_approval');
  assert.equal(routingCaptures.length, 2);
  // Builder selected Cline Tier 1: gemini-3.5-flash-lite, effort low
  assert.equal(routingCaptures[0].worker, 'cline');
  assert.equal(routingCaptures[0].model, 'gemini-3.5-flash-lite');
  assert.equal(routingCaptures[0].effort, 'low');

  // Stored routing log
  assert.equal(t.routingLog[0].tier, 'tier1');
  assert.equal(t.routingLog[0].model, 'gemini-3.5-flash-lite');
  assert.equal(t.routingLog[0].effort, 'low');
});

test('standard task selects Tier 2 model with medium effort in end-to-end coding task', async () => {
  const root = fixture(codexConfig);
  const routingCaptures = [];

  const t = await fixtureCodeTask(root, 'Add a contact form to the test website', {
    ready() {}, log() {}, paths: {},
    call: async (worker, opts) => {
      routingCaptures.push({ worker: worker.id, model: opts.model, effort: opts.effort });
      if (opts.schema === buildSchema) return structuredClone(build);
      return { verdict: 'pass', summary: 'Approved', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });

  assert.equal(t.status, 'awaiting_approval');
  // Builder selected Tier 2: gpt-5.6-sol, effort medium
  assert.equal(routingCaptures[0].worker, 'codex');
  assert.equal(routingCaptures[0].model, 'gpt-5.6-sol');
  assert.equal(routingCaptures[0].effort, 'medium');
  assert.equal(t.routingLog[0].tier, 'tier2');
});

test('failed browser test escalates to Tier 3 with high effort on revision 2 and records in APPROVAL.md', async () => {
  const root = fixture(codexConfig);
  let testRuns = 0;
  const routingCaptures = [];

  const t = await fixtureCodeTask(root, 'Add a contact form', {
    ready() {}, log() {}, paths: {},
    call: async (worker, opts) => {
      routingCaptures.push({ worker: worker.id, model: opts.model, effort: opts.effort });
      if (opts.schema === buildSchema) return structuredClone(build);
      return { verdict: 'pass', summary: 'Approved after fix', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      testRuns++;
      const passed = testRuns > 1;
      const r = { passed, digest, checks: [{ name: 'submit', passed }] };
      json(report, r);
      return r;
    }
  });

  assert.equal(t.status, 'awaiting_approval');
  assert.equal(t.revision, 2);

  // Revision 1 builder: standard tier2 (gpt-5.6-sol, medium)
  assert.equal(routingCaptures[0].model, 'gpt-5.6-sol');
  assert.equal(routingCaptures[0].effort, 'medium');

  // Revision 2 builder: escalated tier3 (gpt-6-astra, high)
  assert.equal(routingCaptures[1].model, 'gpt-6-astra');
  assert.equal(routingCaptures[1].effort, 'high');

  // Task routing log records both rounds and reviewer
  assert.equal(t.routingLog.length, 3);
  assert.equal(t.routingLog[1].tier, 'tier3');
  assert.equal(t.routingLog[1].model, 'gpt-6-astra');
  assert.equal(t.routingLog[1].effort, 'high');

  // APPROVAL.md includes smart routing decisions table
  const reportContent = fs.readFileSync(t.approvalReport, 'utf8');
  assert.ok(reportContent.includes('## Smart Routing Decisions'));
  assert.ok(reportContent.includes('gpt-5.6-sol'));
  assert.ok(reportContent.includes('gpt-6-astra'));
  assert.ok(reportContent.includes('TIER3'));
});

test('reviewer diversity prevents builder platform family from reviewing its own build', async () => {
  const root = fixture(codexConfig);

  // Test 1: Codex builds -> reviewer cannot be Codex
  const t1 = await fixtureCodeTask(root, 'Add a contact form', {
    ready() {}, log() {}, paths: {},
    call: async (worker, opts) => {
      if (opts.schema === buildSchema) {
        assert.equal(worker.id, 'codex');
        return structuredClone(build);
      }
      assert.notEqual(worker.id, 'codex');
      return { verdict: 'pass', summary: 'Approved', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });
  assert.notEqual(t1.reviewer, 'codex');

  // Test 2: Claude builds -> reviewer cannot be Claude
  const t2 = await fixtureCodeTask(root, 'Add a contact form', {
    ready() {}, log() {}, paths: {},
    unavailableBuilders: ['codex'],
    allowClaude: true,
    call: async (worker, opts) => {
      if (opts.schema === buildSchema) {
        assert.equal(worker.id, 'claude-code');
        return structuredClone(build);
      }
      assert.notEqual(worker.id, 'claude-code');
      return { verdict: 'pass', summary: 'Approved', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });
  assert.equal(t2.reviewer, 'codex');
});

test('Cline easy task uses an economical builder and a qualified final reviewer', async () => {
  const root = fixture();
  const captures = [];

  const t = await fixtureCodeTask(root, 'Simple minor presentation: add a contact form', {
    ready() {}, log() {}, paths: {},
    call: async (worker, opts) => {
      captures.push({ worker: worker.id, model: opts.model, effort: opts.effort, role: opts.schema === buildSchema ? 'build' : 'review' });
      if (opts.schema === buildSchema) return structuredClone(build);
      return { verdict: 'pass', summary: 'Approved by reviewer', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });

  assert.equal(t.status, 'awaiting_approval');
  assert.equal(captures.length, 2);
  // The economical worker builds; qualification takes priority over review cost.
  assert.equal(captures[0].worker, 'cline');
  assert.equal(captures[0].model, 'gemini-3.5-flash-lite');
  assert.ok(['codex', 'antigravity'].includes(captures[1].worker));
  assert.ok(['codex', 'antigravity'].includes(t.reviewer));
});

test('Cline primary model failure retries with backup model', async () => {
  const root = fixture();
  const modelAttempts = [];

  const t = await fixtureCodeTask(root, 'Simple easy contact form', {
    ready() {}, log() {}, paths: {},
    call: async (worker, opts) => {
      if (worker.id === 'cline') {
        modelAttempts.push(opts.model);
        if (opts.model === 'gemini-3.5-flash-lite') {
          const err = Error('429 rate limit on primary model');
          err.isQuota = true;
          throw err;
        }
        return structuredClone(build);
      }
      return { verdict: 'pass', summary: 'Approved', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });

  assert.equal(t.status, 'awaiting_approval');
  // Attempted primary then backup model
  assert.deepEqual(modelAttempts, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
  assert.equal(t.routingLog[0].worker, 'cline');
  assert.equal(t.routingLog[0].model, 'gemini-3.1-flash-lite');
});

test('Exhausted Cline pool automatically escalates to Codex', async () => {
  const root = fixture();
  const workerSequence = [];

  const t = await fixtureCodeTask(root, 'Simple easy contact form', {
    ready() {}, log() {}, paths: {},
    call: async (worker, opts) => {
      workerSequence.push(worker.id);
      if (worker.id === 'cline') {
        const err = Error('All Cline models exhausted: 429 rate limit');
        err.isQuota = true;
        throw err;
      }
      if (opts.schema === buildSchema) return structuredClone(build);
      return { verdict: 'pass', summary: 'Approved', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });

  assert.equal(t.status, 'awaiting_approval');
  // Tried cline (both models), then escalated to codex
  assert.ok(workerSequence.includes('cline'));
  assert.ok(workerSequence.includes('codex'));
  assert.equal(t.contributors[0], 'codex');
});

test('Test failure on Cline build escalates effort on Revision 2', async () => {
  const root = fixture();
  let testsCount = 0;
  const revisions = [];

  const t = await fixtureCodeTask(root, 'Simple easy contact form', {
    ready() {}, log() {}, paths: {},
    call: async (worker, opts) => {
      revisions.push({ worker: worker.id, model: opts.model, effort: opts.effort, tier: opts.tier });
      if (opts.schema === buildSchema) return structuredClone(build);
      return { verdict: 'pass', summary: 'Approved', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      testsCount++;
      const passed = testsCount > 1; // Fails on revision 1, passes on revision 2
      const r = { passed, digest, checks: [{ name: 'submit', passed }] };
      json(report, r);
      return r;
    }
  });

  assert.equal(t.status, 'awaiting_approval');
  assert.equal(t.revision, 2);
  // Revision 1 was Cline
  assert.equal(t.routingLog[0].worker, 'cline');
  assert.equal(revisions[0].worker, 'cline');
  assert.equal(revisions[0].effort, 'low');
  assert.equal(revisions[1].worker, 'cline');
  assert.equal(revisions[1].effort, 'high');
});

test('Claude Reserve Mode ON prompts user when Claude styling advantage is detected; user confirms Yes', async () => {
  const root = fixture(codexConfig);
  let prompted = false;

  const t = await fixtureCodeTask(root, 'Update CSS layout, font family, and responsive styling for the contact form', {
    ready() {}, log() {}, paths: {},
    confirmClaudeUse: async (promptMsg) => {
      prompted = true;
      assert.ok(promptMsg.includes('Claude Code would be useful for this task'));
      return true; // User approves Claude quota usage
    },
    call: async (worker, opts) => {
      if (opts.schema === buildSchema) {
        assert.equal(worker.id, 'claude-code');
        return structuredClone(build);
      }
      return { verdict: 'pass', summary: 'Approved', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });

  assert.equal(prompted, true);
  assert.equal(t.status, 'awaiting_approval');
  assert.equal(t.claudeReserveMode, 'ON');
  assert.equal(t.claudeQuotaRequested, true);
  assert.equal(t.claudeQuotaAuthorized, true);
  assert.equal(t.contributors[0], 'claude-code');

  const report = fs.readFileSync(t.approvalReport, 'utf8');
  assert.ok(report.includes('## Claude Reserve Mode Status'));
  assert.ok(report.includes('`ON`'));
  assert.ok(report.includes('Claude Quota Authorized**: Yes'));
});

test('Claude Reserve Mode ON prompts user when Claude styling advantage is detected; user declines No', async () => {
  const root = fixture(codexConfig);
  let prompted = false;

  const t = await fixtureCodeTask(root, 'Update CSS layout, font family, and responsive styling for the contact form', {
    ready() {}, log() {}, paths: {},
    confirmClaudeUse: async (promptMsg) => {
      prompted = true;
      assert.ok(promptMsg.includes('Claude Code would be useful for this task'));
      return false; // User declines Claude quota
    },
    call: async (worker, opts) => {
      if (opts.schema === buildSchema) {
        // Falls back to next best worker (Codex)
        assert.equal(worker.id, 'codex');
        return structuredClone(build);
      }
      return { verdict: 'pass', summary: 'Approved', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });

  assert.equal(prompted, true);
  assert.equal(t.status, 'awaiting_approval');
  assert.equal(t.claudeReserveMode, 'ON');
  assert.equal(t.claudeQuotaRequested, true);
  assert.equal(t.claudeQuotaAuthorized, false);
  assert.equal(t.contributors[0], 'codex');

  const report = fs.readFileSync(t.approvalReport, 'utf8');
  assert.ok(report.includes('## Claude Reserve Mode Status'));
  assert.ok(report.includes('Claude Quota Authorized**: No'));
});
