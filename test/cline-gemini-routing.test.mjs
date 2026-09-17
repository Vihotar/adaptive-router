import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyTask,
  selectModelAndEffort,
  getClineModelSequence,
  clineModelPools,
  platformModelTiers
} from '../src/smart-router.mjs';
import {
  withFailover,
  candidates,
  isClineModelFailoverError,
  isQuotaError
} from '../src/failover.mjs';
import { codeTask } from '../src/coding.mjs';
import { classifySensitivity, containsLikelySecret } from '../src/sensitivity.mjs';
import { buildSchema } from '../src/contracts.mjs';
import { getModelTier, getModelInfo } from '../src/capability-tiers.mjs';

const buildMockResult = {
  summary: 'Mock deliverable for testing',
  files: [{ path: 'index.html', content: '<h1>Test</h1>' }]
};

test('Cline Gemini Routing Test Suite', async (t) => {
  const root = process.cwd();

  await t.test('1. Easy task selects Gemini 3.5 Flash Lite with Low reasoning', () => {
    const classification = classifyTask('Fix minor typo in header title text');
    assert.equal(classification.difficulty, 'easy');

    const selection = selectModelAndEffort({
      platform: 'cline',
      role: 'build',
      difficulty: classification.difficulty,
      root
    });

    assert.equal(selection.model, 'gemini-3.5-flash-lite');
    assert.equal(selection.effort, 'low');
    assert.equal(selection.tier, 'tier1');
    assert.equal(selection.tierNumber, 1);
    assert.deepEqual(selection.fallbackModels, ['gemini-3.1-flash-lite']);
  });

  await t.test('2. Medium task selects Gemini 3.5 Flash Lite with Medium reasoning', () => {
    const classification = classifyTask('Add a customer feedback modal with state validation');
    assert.equal(classification.difficulty, 'medium');

    const selection = selectModelAndEffort({
      platform: 'cline',
      role: 'build',
      difficulty: classification.difficulty,
      root
    });

    assert.equal(selection.model, 'gemini-3.5-flash-lite');
    assert.equal(selection.effort, 'medium');
    assert.equal(selection.tier, 'tier2');
    assert.equal(selection.tierNumber, 1); // Flash-Lite is normalized Tier 1 capability
    assert.deepEqual(selection.fallbackModels, ['gemini-3.1-flash-lite']);
  });

  await t.test('3. Hard Cline task selects Gemini 3.8 Flash with High reasoning', () => {
    const classification = classifyTask('Critical database architecture multi-step transaction redesign');
    assert.equal(classification.difficulty, 'hard');

    const selection = selectModelAndEffort({
      platform: 'cline',
      role: 'build',
      difficulty: classification.difficulty,
      root
    });

    assert.equal(selection.model, 'gemini-3.8-flash');
    assert.equal(selection.effort, 'high');
    assert.equal(selection.tier, 'tier3');
    assert.equal(selection.tierNumber, 3);
    assert.deepEqual(selection.fallbackModels, [
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3-flash',
      'gemini-2.5-flash'
    ]);
  });

  await t.test('4. Easy model quota failure falls back to Gemini 3.1 Flash Lite', async () => {
    const dir = fs.mkdtempSync(path.resolve('.router/tests/cline-easy-failover-'));
    const attemptedModels = [];

    const mockConfig = {
      workers: [
        { id: 'cline', enabled: true, roles: ['build'], priority: 35, adapter: 'cline' }
      ],
      workerTimeoutSeconds: 60
    };

    const result = await withFailover({
      config: mockConfig,
      role: 'build',
      failed: new Set(),
      paths: {},
      root,
      dir,
      stage: 'build-1',
      schema: buildSchema,
      prompt: 'Simple test instruction',
      difficulty: 'easy',
      ready() {},
      log() {},
      call: async (worker, req) => {
        attemptedModels.push(req.model);
        if (req.model === 'gemini-3.5-flash-lite') {
          const err = new Error('HTTP 429: Resource has been exhausted (check quota)');
          err.isQuota = true;
          throw err;
        }
        return structuredClone(buildMockResult);
      }
    });

    assert.deepEqual(attemptedModels, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
    assert.equal(result.worker, 'cline');
    assert.equal(result.model, 'gemini-3.1-flash-lite');
  });

  await t.test('5. Hard sequence falls back: 3.8 -> 3.7 -> 3.6 -> 3.5 -> 3 -> 2.5', async () => {
    const dir = fs.mkdtempSync(path.resolve('.router/tests/cline-hard-failover-'));
    const attemptedModels = [];

    const mockConfig = {
      workers: [
        { id: 'cline', enabled: true, roles: ['build'], priority: 35, adapter: 'cline' }
      ],
      workerTimeoutSeconds: 60
    };

    const expectedSequence = [
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3-flash',
      'gemini-2.5-flash'
    ];

    const result = await withFailover({
      config: mockConfig,
      role: 'build',
      failed: new Set(),
      paths: {},
      root,
      dir,
      stage: 'build-1',
      schema: buildSchema,
      prompt: 'Complex critical architecture task',
      difficulty: 'hard',
      ready() {},
      log() {},
      call: async (worker, req) => {
        attemptedModels.push(req.model);
        // Fail the first 5 models in the sequence with quota/rate-limit errors
        if (req.model !== 'gemini-2.5-flash') {
          const err = new Error(`Rate limit exceeded for model ${req.model}`);
          err.isQuota = true;
          throw err;
        }
        return structuredClone(buildMockResult);
      }
    });

    assert.deepEqual(attemptedModels, expectedSequence);
    assert.equal(result.worker, 'cline');
    assert.equal(result.model, 'gemini-2.5-flash');
  });

  await t.test('6. After Cline model pool exhaustion, normal AR worker failover continues', async () => {
    const dir = fs.mkdtempSync(path.resolve('.router/tests/cline-exhaustion-'));
    const attemptedCalls = [];

    const mockConfig = {
      workers: [
        { id: 'cline', enabled: true, roles: ['build'], priority: 10, adapter: 'cline' },
        { id: 'antigravity', enabled: true, roles: ['build'], priority: 20, adapter: 'antigravity' }
      ],
      workerTimeoutSeconds: 60
    };

    const result = await withFailover({
      config: mockConfig,
      role: 'build',
      failed: new Set(),
      preferredFamily: 'cline',
      paths: {},
      root,
      dir,
      stage: 'build-1',
      schema: buildSchema,
      prompt: 'Simple test task',
      difficulty: 'easy',
      ready() {},
      log() {},
      call: async (worker, req) => {
        attemptedCalls.push({ worker: worker.id, model: req.model });
        if (worker.id === 'cline') {
          const err = new Error(`HTTP 429 quota exhausted on ${req.model}`);
          err.isQuota = true;
          throw err;
        }
        return structuredClone(buildMockResult);
      }
    });

    assert.equal(result.worker, 'antigravity');
    // Every approved Cline provider/model route (both easy Gemini models, then
    // NVIDIA NIM, then both OpenRouter models) is exhausted before AR cascades
    // to the next worker — and nothing outside the approved pool is attempted.
    assert.deepEqual(attemptedCalls, [
      { worker: 'cline', model: 'gemini-3.5-flash-lite' },
      { worker: 'cline', model: 'gemini-3.1-flash-lite' },
      { worker: 'cline', model: 'nvidia/nemotron-3-super-120b-a12b' },
      { worker: 'cline', model: 'cohere/north-mini-code:free' },
      { worker: 'cline', model: 'poolside/laguna-s-2.1:free' },
      { worker: 'antigravity', model: 'gemini-3.8-flash-low' }
    ]);
  });

  await t.test('7. Disabled Cline switch prevents Cline selection entirely', () => {
    const disabledConfig = {
      workers: [
        { id: 'cline', enabled: false, roles: ['build'], priority: 10, adapter: 'cline' },
        { id: 'antigravity', enabled: true, roles: ['build'], priority: 20, adapter: 'antigravity' }
      ]
    };

    const cands = candidates(disabledConfig, 'build');
    assert.equal(cands.some(w => w.id === 'cline'), false, 'Cline must not be in candidates when disabled');
    assert.equal(cands[0].id, 'antigravity');
  });

  await t.test('8. Sensitive/account-access task stops with needs_cto_attention before any Cline dispatch', async () => {
    const testDir = fs.mkdtempSync(path.resolve('.router/tests/sensitive-cline-'));
    fs.cpSync('fixtures', path.join(testDir, 'fixtures'), { recursive: true });
    fs.copyFileSync('workers.json', path.join(testDir, 'workers.json'));

    let workerCalled = false;
    const task = await codeTask(testDir, 'Please log in to our Cloudflare account and update DNS settings', {
      project: 'test-site',
      ready() {},
      log() {},
      call: async () => {
        workerCalled = true;
        return structuredClone(buildMockResult);
      }
    });

    assert.equal(task.status, 'needs_cto_attention');
    assert.equal(task.sensitive, true);
    assert.match(task.sensitiveMatch, /Cloudflare/i);
    assert.match(task.sensitiveReason, /credentials|account access/i);
    assert.equal(workerCalled, false, 'No worker must be dispatched for sensitive tasks');
    assert.equal(task.decisionRequired.type, 'sensitive_task');
  });

  await t.test('9. Real credentials trigger existing hard stop without dispatching Cline', () => {
    const textWithApiKey = 'Configure our service with sk-123456789012345678901234567890';
    assert.equal(containsLikelySecret(textWithApiKey), true);

    const textWithAwsKey = 'Access AWS bucket with AKIAIOSFODNN7EXAMPLE';
    assert.equal(containsLikelySecret(textWithAwsKey), true);

    const textWithBearer = 'Use Authorization: Bearer abcdef1234567890abcdef1234567890';
    assert.equal(containsLikelySecret(textWithBearer), true);
  });

  await t.test('10. Existing Codex/Claude/Antigravity routing and model mappings remain intact', () => {
    // Codex tiers
    assert.equal(platformModelTiers.codex.tier1.model, 'gpt-5.6-luna');
    assert.equal(platformModelTiers.codex.tier2.model, 'gpt-5.6-sol');
    assert.equal(platformModelTiers.codex.tier3.model, 'gpt-6-astra');

    // Claude tiers
    assert.equal(platformModelTiers.claude.tier1.model, 'haiku');
    assert.equal(platformModelTiers.claude.tier2.model, 'sonnet');
    assert.equal(platformModelTiers.claude.tier3.model, 'opus');

    // Antigravity tiers
    assert.equal(platformModelTiers.antigravity.tier1.model, 'gemini-3.8-flash-low');
    assert.equal(platformModelTiers.antigravity.tier2.model, 'gemini-3.8-flash-medium');
    assert.equal(platformModelTiers.antigravity.tier3.model, 'gemini-3.1-pro-high');
    assert.equal(platformModelTiers.antigravity.tier4.model, 'gemini-3.1-ultra');

    // Cline tiers
    assert.equal(platformModelTiers.cline.tier1.model, 'gemini-3.5-flash-lite');
    assert.equal(platformModelTiers.cline.tier2.model, 'gemini-3.5-flash-lite');
    assert.equal(platformModelTiers.cline.tier3.model, 'gemini-3.8-flash');

    // Active workforce platforms
    assert.deepEqual(Object.keys(platformModelTiers).sort(), ['antigravity', 'claude', 'cline', 'codex']);

    // Capability tiers for registered Gemini models
    assert.equal(getModelTier('gemini-3.5-flash-lite', 'coding', root).tier, 1);
    assert.equal(getModelTier('gemini-3.1-flash-lite', 'coding', root).tier, 1);
    assert.equal(getModelTier('gemini-3.8-flash', 'coding', root).tier, 3);
  });

  await t.test('11. isClineModelFailoverError correctly recognizes quota and model errors', () => {
    assert.equal(isClineModelFailoverError(new Error('HTTP 429 Too Many Requests')), true);
    assert.equal(isClineModelFailoverError(new Error('Resource has been exhausted (e.g. check quota)')), true);
    assert.equal(isClineModelFailoverError(new Error('models/gemini-3.5-flash-lite is not found for API version')), true);
    assert.equal(isClineModelFailoverError(new Error('503 Service Unavailable')), true);
    assert.equal(isClineModelFailoverError(new Error('rate limit exceeded')), true);
    // Non-retryable ordinary errors
    assert.equal(isClineModelFailoverError(new Error('SyntaxError: Unexpected token')), false);
  });
});
