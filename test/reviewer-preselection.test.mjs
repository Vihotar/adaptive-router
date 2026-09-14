import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeTask } from '../src/coding.mjs';
import { read, json } from '../src/storage.mjs';
import { buildSchema, reviewSchema } from '../src/contracts.mjs';
import { candidates } from '../src/failover.mjs';
import { evaluateReviewerQualification } from '../src/capability-tiers.mjs';
import { selectModelAndEffort } from '../src/smart-router.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const baseWorkersConfig = {
  workers: [
    {
      id: 'codex',
      enabled: false,
      roles: ['plan', 'build', 'review'],
      priority: 10,
      adapter: 'codex'
    },
    {
      id: 'antigravity',
      enabled: false,
      roles: ['review', 'build'],
      priority: 30,
      adapter: 'antigravity'
    },
    {
      id: 'claude-code',
      enabled: false,
      roles: ['build', 'review'],
      priority: 20,
      adapter: 'claude'
    },
    {
      id: 'cline',
      enabled: true,
      roles: ['build'],
      priority: 35,
      adapter: 'cline'
    }
  ],
  maxCorrections: 2,
  workerTimeoutSeconds: 600,
  claudeReserve: true,
  connectorToken: 'CONNECTOR_TOKEN_REGENERATED_ON_FIRST_RUN'
};

const files = ['index.html', 'styles.css', 'app.js'].map(name => ({
  path: name,
  content: fs.readFileSync(path.join(rootDir, 'fixtures', 'test-site', name), 'utf8')
}));

const formFiles = files.map(f => f.path === 'index.html' ? {
  ...f,
  content: f.content.replace('A contact form will be added here.', '<form id="contact-form"><label for="name">Name</label><input id="name" required><label for="email">Email</label><input type="email" id="email" required><label for="msg">Message</label><textarea id="msg" required></textarea><div role="status" id="status"></div><button type="submit">Send message</button></form>')
} : f);

const buildResult = { summary: 'Working contact form implementation', files: formFiles };

function createTestFixture(customConfig = baseWorkersConfig) {
  const tmp = fs.mkdtempSync(path.resolve('.router/tests/preselect-'));
  fs.cpSync(path.join(rootDir, 'fixtures'), path.join(tmp, 'fixtures'), { recursive: true });
  json(path.join(tmp, 'workers.json'), customConfig);
  return tmp;
}

test('Builder + Reviewer Pre-Selection Suite', async (t) => {

  await t.test('1. Builder + reviewer both available -> task starts, builds and reviews', async () => {
    const configWithReviewer = structuredClone(baseWorkersConfig);
    configWithReviewer.workers.find(w => w.id === 'antigravity').enabled = true;
    const root = createTestFixture(configWithReviewer);

    let buildCalled = false;
    let reviewCalled = false;

    const task = await codeTask(root, 'Add a contact form to the test website', {
      project: 'test-site',
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          buildCalled = true;
          assert.equal(worker.id, 'cline');
          return structuredClone(buildResult);
        }
        if (opts.schema === reviewSchema) {
          reviewCalled = true;
          assert.equal(worker.id, 'antigravity');
          return { verdict: 'pass', summary: 'Clean and compliant', issues: [] };
        }
        throw Error('Unexpected call');
      },
      test: async (_r, _p, report, digest) => {
        const r = { passed: true, digest, checks: [{ name: 'form-exists', passed: true }] };
        json(report, r);
        return r;
      }
    });

    assert.equal(buildCalled, true, 'Builder should have executed');
    assert.equal(reviewCalled, true, 'Reviewer should have executed');
    assert.equal(task.selectedBuilder, 'cline');
    assert.equal(task.selectedReviewer, 'antigravity');
    assert.equal(task.status, 'awaiting_approval');
  });

  await t.test('2. Builder available but no reviewer -> builder does NOT start', async () => {
    // All reviewers disabled (codex, claude-code, antigravity = false)
    const root = createTestFixture(baseWorkersConfig);

    let buildCalled = false;
    let reviewCalled = false;

    const task = await codeTask(root, 'Add a contact form to the test website', {
      project: 'test-site',
      ready() {},
      log() {},
      call: async () => {
        buildCalled = true;
        return structuredClone(buildResult);
      }
    });

    assert.equal(buildCalled, false, 'Builder must NEVER start if no reviewer is available');
    assert.equal(reviewCalled, false, 'No review should be called');
    assert.equal(task.status, 'waiting_for_reviewer');
    assert.ok(task.decisionRequired, 'Decision required card must be set');
  });

  await t.test('3. AR asks CEO/CTO to enable a qualified reviewer with exact qualifying list and options', async () => {
    const root = createTestFixture(baseWorkersConfig);

    const task = await codeTask(root, 'Add a contact form to the test website', {
      project: 'test-site',
      ready() {},
      log() {}
    });

    assert.equal(task.status, 'waiting_for_reviewer');
    const dr = task.decisionRequired;
    assert.ok(dr);
    assert.equal(dr.type, 'reviewer_required_before_start');
    assert.equal(dr.question, 'A qualified reviewer is required before this task can start.');
    assert.match(dr.reason, /Builder selected:\s*Cline/i);
    assert.match(dr.reason, /Required reviewer level:\s*Tier/i);
    assert.match(dr.recommendation, /Please enable one of these reviewer workers:/i);

    // Codex, Claude, and Antigravity should be listed as qualifying
    assert.match(dr.recommendation, /Antigravity/i);
    assert.match(dr.recommendation, /Codex/i);
    assert.match(dr.recommendation, /Claude/i);

    // Options must have Check Again and Start Task and Stop Task
    const optionIds = dr.options.map(o => o.id);
    assert.ok(optionIds.includes('check_again_start'));
    assert.ok(optionIds.includes('stop_task'));

    // Defer option must NOT exist
    assert.ok(!optionIds.includes('defer'));
  });

  await t.test('4. Enabling reviewer + clicking Check Again -> task starts, builds and reviews', async () => {
    const root = createTestFixture(baseWorkersConfig);

    // Step A: Task creation with all reviewers OFF -> enters waiting_for_reviewer
    let buildAttempts = 0;
    const task1 = await codeTask(root, 'Add a contact form to the test website', {
      project: 'test-site',
      ready() {},
      log() {},
      call: async () => {
        buildAttempts++;
        return structuredClone(buildResult);
      }
    });

    assert.equal(buildAttempts, 0);
    assert.equal(task1.status, 'waiting_for_reviewer');

    // Step B: CEO enables Antigravity in workers.json
    const configPath = path.join(root, 'workers.json');
    const cfg = read(configPath);
    cfg.workers.find(w => w.id === 'antigravity').enabled = true;
    json(configPath, cfg);

    // Step C: User clicks "Check Again and Start Task" (resumes task)
    let reviewCalled = false;
    const resumedTask = await codeTask(root, '', {
      project: 'test-site',
      resume: task1.id,
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          buildAttempts++;
          return structuredClone(buildResult);
        }
        if (opts.schema === reviewSchema) {
          reviewCalled = true;
          assert.equal(worker.id, 'antigravity');
          return { verdict: 'pass', summary: 'Antigravity passed review', issues: [] };
        }
        throw Error('Unexpected call');
      },
      test: async (_r, _p, report, digest) => {
        const r = { passed: true, digest, checks: [{ name: 'form-exists', passed: true }] };
        json(report, r);
        return r;
      }
    });

    assert.equal(buildAttempts, 1, 'Builder should have run after reviewer was enabled');
    assert.equal(reviewCalled, true, 'Antigravity should have performed review');
    assert.equal(resumedTask.selectedBuilder, 'cline');
    assert.equal(resumedTask.selectedReviewer, 'antigravity');
    assert.equal(resumedTask.status, 'awaiting_approval');
  });

  await t.test('5. Selected reviewer is saved before build starts', async () => {
    const configWithReviewer = structuredClone(baseWorkersConfig);
    configWithReviewer.workers.find(w => w.id === 'antigravity').enabled = true;
    const root = createTestFixture(configWithReviewer);

    let savedStateBeforeBuild = null;

    await codeTask(root, 'Add a contact form to the test website', {
      project: 'test-site',
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          // Inspect task.json on disk during the build step!
          const taskDirs = fs.readdirSync(path.join(root, '.router', 'tasks'));
          const onDisk = read(path.join(root, '.router', 'tasks', taskDirs[0], 'task.json'));
          savedStateBeforeBuild = structuredClone(onDisk);
          return structuredClone(buildResult);
        }
        return { verdict: 'pass', summary: 'Passed', issues: [] };
      },
      test: async (_r, _p, report, digest) => {
        const r = { passed: true, digest, checks: [{ name: 'ok', passed: true }] };
        json(report, r);
        return r;
      }
    });

    assert.ok(savedStateBeforeBuild, 'task.json must exist before builder returns');
    assert.equal(savedStateBeforeBuild.selectedBuilder, 'cline');
    assert.equal(savedStateBeforeBuild.selectedReviewer, 'antigravity');
    assert.ok(savedStateBeforeBuild.builderModel);
    assert.ok(savedStateBeforeBuild.reviewerModel);
    assert.ok(savedStateBeforeBuild.reviewerCapabilityLevel);
    assert.ok(savedStateBeforeBuild.reviewerEffortLevel);
  });

  await t.test('6. Builder cannot review own work', async () => {
    // Only Codex is enabled for both build and review
    const onlyCodex = {
      workers: [
        { id: 'codex', enabled: true, roles: ['build', 'review'], priority: 10, adapter: 'codex' },
        { id: 'antigravity', enabled: false, roles: ['review'], priority: 30, adapter: 'antigravity' }
      ],
      maxCorrections: 2,
      workerTimeoutSeconds: 600
    };

    const root = createTestFixture(onlyCodex);

    const task = await codeTask(root, 'Hard complex algorithm: add a contact form', {
      project: 'test-site',
      ready() {},
      log() {},
      call: async () => structuredClone(buildResult)
    });

    // Codex was selected as builder; Codex cannot review its own work; therefore no qualified reviewer is available
    assert.equal(task.status, 'waiting_for_reviewer');
    assert.equal(task.selectedBuilder, 'codex');
    assert.equal(task.decisionRequired.type, 'reviewer_required_before_start');
    // Codex should NOT be listed as a qualifying reviewer for its own work!
    assert.doesNotMatch(task.decisionRequired.recommendation, /Codex/i);
    assert.match(task.decisionRequired.recommendation, /Antigravity/i);
  });

  await t.test('7. Reviewer seniority rule still works', () => {
    // Tier 3 builder (gpt-5.6-sol)
    const tier1Reviewer = evaluateReviewerQualification({
      builderModel: 'gpt-5.6-sol',
      builderTier: 3,
      candidateModel: 'gemini-3.8-flash-low', // Tier 1
      candidatePlatform: 'antigravity',
      root: rootDir
    });
    assert.equal(tier1Reviewer.qualified, false);
    assert.equal(tier1Reviewer.reasonCode, 'SUB_SENIORITY_FLOOR');

    // Tier 3 Antigravity reviewer qualifies
    const tier3Reviewer = evaluateReviewerQualification({
      builderModel: 'gpt-5.6-sol',
      builderTier: 3,
      candidateModel: 'gemini-3.1-pro-high', // Tier 3
      candidatePlatform: 'antigravity',
      root: rootDir
    });
    assert.equal(tier3Reviewer.qualified, true);
  });

  await t.test('8. Reviewer effort rule still works', () => {
    // Builder with high effort cannot be reviewed by low effort
    const qualLow = evaluateReviewerQualification({
      builderModel: 'gpt-5.6-sol',
      builderTier: 3,
      builderEffort: 'high',
      candidateModel: 'gemini-3.1-pro-high',
      candidatePlatform: 'antigravity',
      reviewerEffort: 'low',
      root: rootDir
    });
    assert.equal(qualLow.qualified, false);
    assert.equal(qualLow.reasonCode, 'INSUFFICIENT_EFFORT');

    // High effort reviewer qualifies
    const qualHigh = evaluateReviewerQualification({
      builderModel: 'gpt-5.6-sol',
      builderTier: 3,
      builderEffort: 'high',
      candidateModel: 'gemini-3.1-pro-high',
      candidatePlatform: 'antigravity',
      reviewerEffort: 'high',
      root: rootDir
    });
    assert.equal(qualHigh.qualified, true);
  });

  await t.test('9. Disabled reviewer is never selected', () => {
    const config = structuredClone(baseWorkersConfig);
    // Antigravity has review role but enabled: false
    config.workers.find(w => w.id === 'antigravity').enabled = false;

    const availableReviewers = candidates(config, 'review', ['cline'], new Set(), undefined, 'easy', false, false, {
      builderModel: 'gemini-3.5-flash-lite',
      builderTier: 1,
      root: rootDir
    });
    assert.equal(availableReviewers.length, 0);
  });

  await t.test('10. Defer final review no longer appears in decision options', async () => {
    const root = createTestFixture(baseWorkersConfig);

    const task = await codeTask(root, 'Add a contact form to the test website', {
      project: 'test-site',
      ready() {},
      log() {}
    });

    assert.ok(task.decisionRequired);
    const options = task.decisionRequired.options || [];
    const labels = options.map(o => o.label.toLowerCase());
    const ids = options.map(o => o.id);

    assert.ok(!ids.includes('defer'), 'defer id must not exist');
    assert.ok(!labels.some(l => l.includes('defer')), 'no label with defer');
  });

  await t.test('11. No deferred-review state is created', async () => {
    const root = createTestFixture(baseWorkersConfig);

    const task = await codeTask(root, 'Add a contact form to the test website', {
      project: 'test-site',
      ready() {},
      log() {}
    });

    assert.notEqual(task.status, 'review_pending_unqualified');
    assert.notEqual(task.status, 'deferred');
    assert.equal(task.status, 'waiting_for_reviewer');
  });

  await t.test('12. Reviewer unexpectedly unavailable after build -> task waits for another reviewer, not deferred', async () => {
    const configWithReviewer = structuredClone(baseWorkersConfig);
    configWithReviewer.workers.find(w => w.id === 'antigravity').enabled = true;
    const root = createTestFixture(configWithReviewer);

    let buildDone = false;

    const task = await codeTask(root, 'Add a contact form to the test website', {
      project: 'test-site',
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          buildDone = true;
          return structuredClone(buildResult);
        }
        if (opts.schema === reviewSchema) {
          throw Error('Antigravity quota exhausted unexpectedly');
        }
        throw Error('Unexpected call');
      },
      test: async (_r, _p, report, digest) => {
        const r = { passed: true, digest, checks: [{ name: 'form-exists', passed: true }] };
        json(report, r);
        return r;
      }
    });

    assert.equal(buildDone, true, 'Build must have completed');
    assert.equal(task.status, 'waiting_for_reviewer');
    assert.ok(task.decisionRequired);
    assert.equal(task.decisionRequired.type, 'reviewer_required_after_build');
    assert.match(task.decisionRequired.question, /qualified reviewer is required/i);

    const optionIds = task.decisionRequired.options.map(o => o.id);
    assert.ok(optionIds.includes('check_again_review'));
    assert.ok(optionIds.includes('stop_task'));
    assert.ok(!optionIds.includes('defer'), 'Defer must not be offered mid-flight');

    // Deliverables are safely saved!
    assert.ok(fs.existsSync(path.join(root, '.router', 'tasks', task.id, 'deliverables-1')));
    assert.ok(fs.existsSync(path.join(root, '.router', 'tasks', task.id, 'manifest-1.json')));
  });

  await t.test('13. Stop Task works from reviewer-required screen', async () => {
    const root = createTestFixture(baseWorkersConfig);

    const task = await codeTask(root, 'Add a contact form to the test website', {
      project: 'test-site',
      ready() {},
      log() {}
    });

    assert.equal(task.status, 'waiting_for_reviewer');

    // Resume with stop_task decision
    const stoppedTask = await codeTask(root, '', {
      project: 'test-site',
      resume: task.id,
      signal: { aborted: true }
    });

    assert.equal(stoppedTask.status, 'cancelled_by_user');
  });

  await t.test('14. Cline easy task routes with pre-selected builder & reviewer', async () => {
    const configWithReviewer = structuredClone(baseWorkersConfig);
    configWithReviewer.workers.find(w => w.id === 'antigravity').enabled = true;
    const root = createTestFixture(configWithReviewer);

    const task = await codeTask(root, 'Simple text change: add a contact form', {
      project: 'test-site',
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          assert.equal(worker.id, 'cline');
          return structuredClone(buildResult);
        }
        assert.equal(worker.id, 'antigravity');
        return { verdict: 'pass', summary: 'Approved', issues: [] };
      },
      test: async (_r, _p, report, digest) => {
        const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
        json(report, r);
        return r;
      }
    });

    assert.equal(task.selectedBuilder, 'cline');
    assert.equal(task.selectedReviewer, 'antigravity');
    assert.equal(task.status, 'awaiting_approval');
  });
});
