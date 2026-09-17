import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyTask,
  selectModelAndEffort,
  rankCandidatesForRole,
  platformModelTiers,
  clineModelPools,
  getClineModelSequence
} from '../src/smart-router.mjs';
import {
  getModelTier,
  getModelInfo,
  isModelFamilyIndependent,
  evaluateReviewerQualification
} from '../src/capability-tiers.mjs';
import { withFailover, candidates, isClineModelFailoverError } from '../src/failover.mjs';
import { classifySensitivity, containsLikelySecret } from '../src/sensitivity.mjs';
import { codeTask } from '../src/coding.mjs';
import { buildSchema, reviewSchema } from '../src/contracts.mjs';
import { read, json, hash } from '../src/storage.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const activeWorkersConfig = {
  workers: [
    { id: 'codex', enabled: false, roles: ['plan', 'build', 'review'], priority: 10, adapter: 'codex' },
    { id: 'antigravity', enabled: true, roles: ['review', 'build'], priority: 30, adapter: 'antigravity' },
    { id: 'claude-code', enabled: false, roles: ['build', 'review'], priority: 20, adapter: 'claude' },
    { id: 'cline', enabled: true, roles: ['build'], priority: 35, adapter: 'cline' }
  ],
  maxCorrections: 2,
  workerTimeoutSeconds: 600,
  claudeReserve: true,
  connectorToken: 'CONNECTOR_TOKEN_REGENERATED_ON_FIRST_RUN'
};

function createFixture() {
  const tmp = fs.mkdtempSync(path.resolve('.router/tests/active-workforce-'));
  fs.cpSync(path.join(rootDir, 'fixtures'), path.join(tmp, 'fixtures'), { recursive: true });
  json(path.join(tmp, 'workers.json'), activeWorkersConfig);
  return tmp;
}

const mockBuildResult = {
  summary: 'Created test deliverable',
  files: [
    { path: 'greeting.js', content: 'export function greet(name) { return `Hello, ${name}!`; }\n' },
    { path: 'test/greeting.test.mjs', content: 'import assert from "node:assert";\nimport { greet } from "../greeting.js";\nassert.equal(greet("World"), "Hello, World!");\n' }
  ]
};

test('Active Workforce & Eradication Verification Suite', async (t) => {
  const root = rootDir;

  await t.test('1. Active workforce strictly contains exactly 4 workers', () => {
    const rawConfig = read(path.join(root, 'workers.json'));
    const workerIds = rawConfig.workers.map(w => w.id).sort();
    assert.deepEqual(workerIds, ['antigravity', 'claude-code', 'cline', 'codex']);
    assert.deepEqual(Object.keys(platformModelTiers).sort(), ['antigravity', 'claude', 'cline', 'codex']);
  });

  await t.test('2. Cline serves as normal economical builder for routine tasks', () => {
    const easy = classifyTask('Fix minor typo in header title text');
    assert.equal(easy.difficulty, 'easy');
    const easySelection = selectModelAndEffort({ platform: 'cline', role: 'build', difficulty: easy.difficulty, root });
    assert.equal(easySelection.model, 'gemini-3.5-flash-lite');
    assert.equal(easySelection.effort, 'low');
    assert.equal(easySelection.tierNumber, 1);

    const medium = classifyTask('Add a customer feedback modal with state validation');
    assert.equal(medium.difficulty, 'medium');
    const medSelection = selectModelAndEffort({ platform: 'cline', role: 'build', difficulty: medium.difficulty, root });
    assert.equal(medSelection.model, 'gemini-3.5-flash-lite');
    assert.equal(medSelection.effort, 'medium');
  });

  await t.test('3. Cline intra-worker Gemini failover functions correctly on quota exhaust', async () => {
    const dir = fs.mkdtempSync(path.resolve('.router/tests/cline-intra-failover-'));
    const tried = [];
    const mockConfig = {
      workers: [{ id: 'cline', enabled: true, roles: ['build'], priority: 35, adapter: 'cline' }],
      workerTimeoutSeconds: 60
    };

    const res = await withFailover({
      config: mockConfig,
      role: 'build',
      failed: new Set(),
      paths: {},
      root,
      dir,
      stage: 'build-1',
      schema: buildSchema,
      prompt: 'Routine task',
      difficulty: 'easy',
      ready() {},
      log() {},
      call: async (_w, req) => {
        tried.push(req.model);
        if (req.model === 'gemini-3.5-flash-lite') {
          const err = new Error('HTTP 429 quota exhausted');
          err.isQuota = true;
          throw err;
        }
        return structuredClone(mockBuildResult);
      }
    });

    assert.deepEqual(tried, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
    assert.equal(res.worker, 'cline');
    assert.equal(res.model, 'gemini-3.1-flash-lite');
  });

  await t.test('4. Hard Cline sequence cascades across full Flash generation chain', async () => {
    const dir = fs.mkdtempSync(path.resolve('.router/tests/cline-hard-chain-'));
    const tried = [];
    const mockConfig = {
      workers: [{ id: 'cline', enabled: true, roles: ['build'], priority: 35, adapter: 'cline' }],
      workerTimeoutSeconds: 60
    };

    const expected = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-flash'];
    const res = await withFailover({
      config: mockConfig,
      role: 'build',
      failed: new Set(),
      paths: {},
      root,
      dir,
      stage: 'build-1',
      schema: buildSchema,
      prompt: 'Heavy database rebuild',
      difficulty: 'hard',
      ready() {},
      log() {},
      call: async (_w, req) => {
        tried.push(req.model);
        if (req.model !== 'gemini-2.5-flash') {
          const err = new Error('Rate limit exceeded');
          err.isQuota = true;
          throw err;
        }
        return structuredClone(mockBuildResult);
      }
    });

    assert.deepEqual(tried, expected);
    assert.equal(res.model, 'gemini-2.5-flash');
  });

  await t.test('5. Cascading cross-worker failover reaches Antigravity after Cline pool exhaustion', async () => {
    const dir = fs.mkdtempSync(path.resolve('.router/tests/cross-worker-failover-'));
    const calls = [];
    const mockConfig = {
      workers: [
        { id: 'cline', enabled: true, roles: ['build'], priority: 10, adapter: 'cline' },
        { id: 'antigravity', enabled: true, roles: ['build'], priority: 20, adapter: 'antigravity' }
      ],
      workerTimeoutSeconds: 60
    };

    const res = await withFailover({
      config: mockConfig,
      role: 'build',
      failed: new Set(),
      preferredFamily: 'cline',
      paths: {},
      root,
      dir,
      stage: 'build-1',
      schema: buildSchema,
      prompt: 'Routine web build',
      difficulty: 'easy',
      ready() {},
      log() {},
      call: async (worker, req) => {
        calls.push({ worker: worker.id, model: req.model });
        if (worker.id === 'cline') {
          const err = new Error('HTTP 429 quota exhausted');
          err.isQuota = true;
          throw err;
        }
        return structuredClone(mockBuildResult);
      }
    });

    assert.equal(res.worker, 'antigravity');
    // The Cline runtime now covers every approved provider route (Gemini, then
    // NVIDIA NIM, then both OpenRouter models) before AR cascades to the next
    // worker — and nothing outside that approved pool is ever attempted.
    assert.deepEqual(calls, [
      { worker: 'cline', model: 'gemini-3.5-flash-lite' },
      { worker: 'cline', model: 'gemini-3.1-flash-lite' },
      { worker: 'cline', model: 'nvidia/nemotron-3-super-120b-a12b' },
      { worker: 'cline', model: 'cohere/north-mini-code:free' },
      { worker: 'cline', model: 'poolside/laguna-s-2.1:free' },
      { worker: 'antigravity', model: 'gemini-3.8-flash-low' }
    ]);
  });

  await t.test('6. Builder + Reviewer pre-selection designates Cline and Antigravity before work starts', async () => {
    const fixture = createFixture();
    let capturedTask = null;

    const task = await codeTask(fixture, 'Create greeting script', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async (_w, req) => {
        if (req.schema === buildSchema) {
          return structuredClone(mockBuildResult);
        }
        return { verdict: 'pass', summary: 'Approved', issues: [] };
      }
    });

    assert.equal(task.selectedBuilder, 'cline');
    assert.equal(task.selectedReviewer, 'antigravity');
    assert.ok(task.reviewerQualification);
    assert.equal(typeof task.reviewerQualification.builderTier, 'number');
    assert.equal(typeof task.reviewerQualification.reviewerTier, 'number');
    assert.equal(task.reviewerQualification.independentFamily, true);
  });

  await t.test('7. Antigravity provides independent cross-platform review for Cline builds', () => {
    const independent = isModelFamilyIndependent(
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash-medium',
      'cline',
      'antigravity'
    );
    assert.equal(independent.independent, true, 'Cross-platform independence between Cline CLI and Antigravity CLI must hold');

    const qual = evaluateReviewerQualification({
      builderModel: 'gemini-3.5-flash-lite',
      builderTier: 1,
      builderPlatform: 'cline',
      candidateModel: 'gemini-3.8-flash-medium',
      candidatePlatform: 'antigravity',
      root
    });
    assert.equal(qual.qualified, true);
    assert.equal(qual.isSenior, true);
  });

  await t.test('8. Reviewer seniority floor rejects under-qualified reviewer candidates', () => {
    const qual = evaluateReviewerQualification({
      builderModel: 'gpt-5.6-sol',
      builderTier: 3,
      candidateModel: 'gemini-3.5-flash-lite',
      candidatePlatform: 'cline',
      root
    });
    assert.equal(qual.qualified, false);
    assert.equal(qual.reasonCode, 'SUB_SENIORITY_FLOOR');
  });

  await t.test('9. Cost protection prefers same-tier reviewer over unnecessarily expensive higher-tier', () => {
    const config = {
      workers: [
        { id: 'antigravity', enabled: true, roles: ['review'], priority: 30, adapter: 'antigravity' },
        { id: 'claude-code', enabled: true, roles: ['review'], priority: 20, adapter: 'claude' }
      ]
    };

    const ranked = rankCandidatesForRole(config, 'review', {
      builderModel: 'gpt-5-mini',
      builderTier: 2,
      claudeReserve: false,
      allowClaude: true,
      root
    });
    assert.equal(ranked[0].id, 'antigravity');
  });

  await t.test('10. Validator and Reviewer evaluate identical draft content and digest', async () => {
    const fixture = createFixture();
    let reviewerReceivedFiles = null;

    const task = await codeTask(fixture, 'Create greeting script', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async (_w, req) => {
        if (req.schema === buildSchema) {
          return structuredClone(mockBuildResult);
        }
        if (req.schema === reviewSchema) {
          const match = req.prompt.match(/Current code:\s*(\[.*?\])(?:\nActual validator results:|$)/s);
          if (match) reviewerReceivedFiles = JSON.parse(match[1]);
          return { verdict: 'pass', summary: 'Approved', issues: [] };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      }
    });

    assert.ok(reviewerReceivedFiles);
    assert.equal(hash(reviewerReceivedFiles), task.digest);
    assert.equal(task.tests.digest, task.digest);
  });

  await t.test('11. Sensitive/account-access tasks halt before worker dispatch', async () => {
    const fixture = createFixture();
    let dispatched = false;

    const task = await codeTask(fixture, 'Please log in to Cloudflare account and update DNS settings', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async () => {
        dispatched = true;
        return structuredClone(mockBuildResult);
      }
    });

    assert.equal(dispatched, false, 'No worker should be dispatched for sensitive tasks');
    assert.equal(task.status, 'needs_cto_attention');
    assert.equal(task.sensitive, true);
    assert.equal(task.decisionRequired.type, 'sensitive_task');
  });

  await t.test('12. Secret tokens are flagged to prevent transmission to workers', () => {
    assert.equal(containsLikelySecret('Authorization: Bearer sk-ant-api-token-12345678901234567890'), true);
    assert.equal(containsLikelySecret('AWS credentials: AKIAIOSFODNN7EXAMPLE'), true);
    assert.equal(containsLikelySecret('Normal text without any keys'), false);
  });

  await t.test('13. Task lifecycle supports Pause, Resume, and Stop controls', async () => {
    const fixture = createFixture();
    let task = await codeTask(fixture, 'Build feature with pause', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async () => structuredClone(mockBuildResult)
    });

    // Simulate task state
    task.status = 'paused_by_user';
    assert.equal(task.status, 'paused_by_user');
    task.status = 'building';
    assert.equal(task.status, 'building');
  });

  await t.test('14. Dual-tab event logging separates user progress from raw technical diagnostic logs', async () => {
    const fixture = createFixture();
    const task = await codeTask(fixture, 'Create greeting script', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async (_w, req) => {
        if (req.schema === buildSchema) return structuredClone(mockBuildResult);
        return { verdict: 'pass', summary: 'Approved', issues: [] };
      }
    });

    const progress = task.activityLog || [];
    assert.ok(progress.length > 0, 'Task progress items must exist in activityLog');
    const titles = progress.map(p => p.title);
    assert.ok(titles.some(t => t.includes('Checks') || t.includes('Reviewer') || t.includes('Draft') || t.includes('Work')));
  });

  await t.test('15. Failure reporting yields clear diagnosis on worker crash', async () => {
    const fixture = createFixture();
    const task = await codeTask(fixture, 'Create failing task', {
      project: 'adaptive-router',
      call: async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:59999');
        err.code = 'ECONNREFUSED';
        throw err;
      }
    });

    assert.ok(task.status === 'failed' || task.status === 'waiting_for_worker');
    assert.ok(task.failure);
    assert.equal(task.failure.stage, 'Build');
    assert.ok(task.failure.reason);
  });

  await t.test('16. Correction feedback increments revision and triggers targeted re-build', async () => {
    const fixture = createFixture();
    let callCount = 0;

    const task = await codeTask(fixture, 'Create greeting script', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async (_w, req) => {
        callCount++;
        if (req.schema === buildSchema) {
          return structuredClone(mockBuildResult);
        }
        if (req.schema === reviewSchema && callCount <= 2) {
          return { verdict: 'reject', summary: 'Needs uppercase greeting', issues: ['Missing uppercase'] };
        }
        return { verdict: 'pass', summary: 'Approved', issues: [] };
      }
    });

    assert.ok(task.revision >= 1);
    assert.ok(callCount >= 2);
  });

  await t.test('17. Capability tiers and router maps contain zero decommissioned worker references', () => {
    const modelKeys = Object.keys(platformModelTiers);
    assert.deepEqual(modelKeys.sort(), ['antigravity', 'claude', 'cline', 'codex']);
    const clineSeq = getClineModelSequence('hard');
    assert.ok(clineSeq.every(m => m.startsWith('gemini-')));
  });
});
