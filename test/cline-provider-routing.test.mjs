import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CLINE_PROVIDERS,
  DEFAULT_PROVIDER_ORDER,
  buildClineRouteSequence,
  resolveClineRoute,
  isApprovedClineRoute,
  providerIdForModel,
  describeClineRoute
} from '../src/cline-providers.mjs';
import { withFailover } from '../src/failover.mjs';
import { platformModelTiers } from '../src/smart-router.mjs';
import { buildSchema } from '../src/contracts.mjs';
import { getModelTier } from '../src/capability-tiers.mjs';
import { invoke, parseClineStream } from '../src/workers.mjs';
import { accumulateInvocation, recordProviderAttempt, createEmptyTokenUsage } from '../src/token-tracker.mjs';

const buildMockResult = {
  summary: 'Mock deliverable for testing',
  files: [{ path: 'index.html', content: '<h1>Test</h1>' }]
};

const clineOnlyConfig = {
  workers: [{ id: 'cline', enabled: true, roles: ['build'], priority: 35, adapter: 'cline', providerOrder: DEFAULT_PROVIDER_ORDER }],
  workerTimeoutSeconds: 60
};

function tempDir(prefix) {
  fs.mkdirSync('.router/tests', { recursive: true });
  return fs.mkdtempSync(path.resolve('.router/tests', prefix));
}

test('Cline multi-provider routing', async (t) => {
  const root = process.cwd();

  await t.test('Gemini provider selection keeps the existing working configuration', () => {
    const routes = buildClineRouteSequence({
      primaryModel: 'gemini-3.5-flash-lite',
      fallbackModels: ['gemini-3.1-flash-lite']
    });
    assert.equal(routes[0].provider, 'gemini');
    assert.equal(routes[0].clineProvider, 'gemini');
    assert.equal(routes[0].model, 'gemini-3.5-flash-lite');
    assert.equal(routes[1].model, 'gemini-3.1-flash-lite');
    assert.equal(describeClineRoute(routes[0]), 'Google AI Studio (Gemini) (gemini-3.5-flash-lite)');

    const pinned = buildClineRouteSequence({ pinnedProvider: 'gemini', primaryModel: 'gemini-3.8-flash' });
    assert.equal(pinned.length, 1);
    assert.equal(pinned[0].model, 'gemini-3.8-flash');
  });

  await t.test('NVIDIA NIM provider selection resolves the one verified model', () => {
    const routes = buildClineRouteSequence({ pinnedProvider: 'nvidia' });
    assert.deepEqual(routes.map(r => r.model), ['nvidia/nemotron-3-super-120b-a12b']);
    assert.equal(routes[0].clineProvider, 'nvidia');
    assert.equal(routes[0].label, 'NVIDIA NIM');
    // Alias spellings resolve to the same single provider, never to a guess.
    assert.equal(buildClineRouteSequence({ pinnedProvider: 'nvidia-nim' })[0].provider, 'nvidia');
  });

  await t.test('Both approved OpenRouter models are selectable, in declared order', () => {
    const routes = buildClineRouteSequence({ pinnedProvider: 'openrouter' });
    assert.deepEqual(routes.map(r => r.model), ['cohere/north-mini-code:free', 'poolside/laguna-s-2.1:free']);
    assert.ok(routes.every(r => r.clineProvider === 'openrouter'));
    assert.equal(resolveClineRoute('openrouter', 'poolside/laguna-s-2.1:free').model, 'poolside/laguna-s-2.1:free');
  });

  await t.test('Disabled gpt-oss-20b can never be selected', () => {
    assert.equal(isApprovedClineRoute('nvidia', 'openai/gpt-oss-20b'), false);
    assert.throws(() => resolveClineRoute('nvidia', 'openai/gpt-oss-20b'), /disabled for NVIDIA NIM/i);
    assert.throws(() => buildClineRouteSequence({ pinnedModel: 'openai/gpt-oss-20b', pinnedProvider: 'nvidia' }), /disabled/i);
    const all = buildClineRouteSequence({ primaryModel: 'gemini-3.5-flash-lite' });
    assert.equal(all.some(r => r.model === 'openai/gpt-oss-20b'), false);
  });

  await t.test('No unknown provider or model can silently enter the pool', () => {
    assert.throws(() => resolveClineRoute('gemini', 'gemini-9-ultra'), /Unapproved model/i);
    assert.throws(() => resolveClineRoute('freellmapi', 'anything'), /Unapproved Cline provider/i);
    assert.throws(() => resolveClineRoute('gemini', ''), /No model specified/i);
    assert.throws(() => buildClineRouteSequence({ pinnedProvider: 'freellmapi' }), /Unapproved/i);
    // An unknown provider in configuration is ignored, never guessed at.
    const routes = buildClineRouteSequence({ primaryModel: 'gemini-3.5-flash-lite', providerOrder: ['mystery-llm', 'nvidia'] });
    assert.deepEqual(routes.map(r => r.provider), ['nvidia']);
    assert.equal(providerIdForModel('some/unknown-model'), null);
  });

  await t.test('The adapter refuses an unapproved route before any provider is contacted', async () => {
    const dir = tempDir('cline-unapproved-');
    await assert.rejects(
      () => invoke({ id: 'cline', adapter: 'cline' }, {
        root,
        dir,
        schema: buildSchema,
        prompt: 'test',
        timeout: 5000,
        paths: { cline: 'C:/definitely/not/real/cline.cmd' },
        model: 'openai/gpt-oss-20b',
        providerId: 'nvidia'
      }),
      /disabled for NVIDIA NIM/i
    );
    // The prompt file is only written after validation, so nothing was staged.
    assert.equal(fs.readdirSync(path.join(dir, 'workspace')).length, 0);
  });

  await t.test('Approved Gemini pool never drifts from the Cline tier pools', () => {
    const tierModels = new Set();
    for (const tier of Object.values(platformModelTiers.cline)) {
      tierModels.add(tier.model);
      for (const fb of tier.fallback || []) tierModels.add(fb);
    }
    for (const model of tierModels) {
      assert.equal(isApprovedClineRoute('gemini', model), true, `${model} must be an approved Gemini route`);
    }
  });

  await t.test('Approved non-Gemini models are registered with their real provider identity', () => {
    const nim = getModelTier('nvidia/nemotron-3-super-120b-a12b', 'coding', root);
    assert.equal(nim.isKnown, true);
    assert.equal(nim.provider, 'nvidia');
    for (const model of CLINE_PROVIDERS.openrouter.models) {
      const info = getModelTier(model, 'coding', root);
      assert.equal(info.isKnown, true, `${model} must be registered`);
      assert.equal(info.provider, 'openrouter');
    }
  });

  await t.test('Provider/model identity and token telemetry persist through a run', async () => {
    const dir = tempDir('cline-identity-');
    const seen = [];
    const telemetry = [];
    const result = await withFailover({
      config: clineOnlyConfig,
      role: 'build',
      failed: new Set(),
      paths: {},
      root,
      dir,
      stage: 'build-1',
      schema: buildSchema,
      prompt: 'tiny task',
      difficulty: 'easy',
      clineProvider: 'nvidia',
      ready() {},
      log() {},
      onTokenUsage: (t) => telemetry.push(t),
      call: async (worker, req) => {
        seen.push({ model: req.model, provider: req.provider, providerId: req.providerId, providerLabel: req.providerLabel });
        req.onUsage({ inputTokens: 3200, outputTokens: 180, totalTokens: 3380, accuracy: 'Exact' });
        return structuredClone(buildMockResult);
      }
    });

    assert.deepEqual(seen, [{
      model: 'nvidia/nemotron-3-super-120b-a12b',
      provider: 'nvidia',
      providerId: 'nvidia',
      providerLabel: 'NVIDIA NIM'
    }]);
    assert.equal(result.worker, 'cline');
    assert.equal(result.model, 'nvidia/nemotron-3-super-120b-a12b');
    assert.equal(result.provider, 'nvidia');
    assert.equal(result.providerLabel, 'NVIDIA NIM');
    assert.equal(result.runtime, 'cline');

    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0].provider, 'nvidia');
    assert.equal(telemetry[0].providerLabel, 'NVIDIA NIM');
    assert.equal(telemetry[0].success, true);
    assert.equal(typeof telemetry[0].latencyMs, 'number');
    assert.equal(telemetry[0].usage.inputTokens, 3200);
    assert.equal(telemetry[0].usage.outputTokens, 180);
    assert.equal(telemetry[0].usage.totalTokens, 3380);
    assert.equal(telemetry[0].usage.accuracy, 'Exact');

    // ...and lands in the task-level token record with provider attribution.
    let usage = recordProviderAttempt(createEmptyTokenUsage(), { ...telemetry[0], worker: 'cline' });
    usage = accumulateInvocation(usage, { ...telemetry[0], worker: 'cline' });
    assert.equal(usage.builder.provider, 'nvidia');
    assert.equal(usage.builder.providerLabel, 'NVIDIA NIM');
    assert.equal(usage.builder.totalTokens, 3380);
    assert.equal(usage.invocations[0].model, 'nvidia/nemotron-3-super-120b-a12b');
    assert.equal(usage.attempts[0].success, true);
    assert.equal(usage.attempts[0].provider, 'nvidia');
  });

  await t.test('A provider failure returns cleanly, attributed, without switching to an unknown model', async () => {
    const dir = tempDir('cline-fail-');
    const attempts = [];
    const telemetry = [];
    await assert.rejects(
      () => withFailover({
        config: clineOnlyConfig,
        role: 'build',
        failed: new Set(),
        paths: {},
        root,
        dir,
        stage: 'build-1',
        schema: buildSchema,
        prompt: 'tiny task',
        difficulty: 'easy',
        clineProvider: 'openrouter',
        ready() {},
        log() {},
        onTokenUsage: (t) => telemetry.push(t),
        call: async (worker, req) => {
          attempts.push(req.model);
          const err = new Error(`Upstream provider error for ${req.model}`);
          err.usage = { inputTokens: 900, outputTokens: 0, totalTokens: 900, accuracy: 'Exact' };
          throw err;
        }
      }),
      /No available independent build worker/
    );

    // A non-retryable failure stops at the first route; nothing outside the
    // approved OpenRouter pool was ever attempted.
    assert.deepEqual(attempts, ['cohere/north-mini-code:free']);
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0].success, false);
    assert.equal(telemetry[0].provider, 'openrouter');
    assert.equal(telemetry[0].usage.totalTokens, 900);

    const health = JSON.parse(fs.readFileSync(path.join(root, '.router', 'worker-health.json'), 'utf8'));
    assert.ok(health['cline:openrouter:cohere/north-mini-code:free'], 'per-route health telemetry must be recorded');
  });

  await t.test('Quota failover walks the approved providers in deterministic order', async () => {
    const dir = tempDir('cline-chain-');
    const attempts = [];
    const result = await withFailover({
      config: clineOnlyConfig,
      role: 'build',
      failed: new Set(),
      paths: {},
      root,
      dir,
      stage: 'build-1',
      schema: buildSchema,
      prompt: 'tiny task',
      difficulty: 'easy',
      ready() {},
      log() {},
      call: async (worker, req) => {
        attempts.push(`${req.providerId}:${req.model}`);
        if (req.providerId !== 'openrouter') {
          const err = new Error(`HTTP 429 quota exhausted on ${req.model}`);
          err.isQuota = true;
          throw err;
        }
        return structuredClone(buildMockResult);
      }
    });

    assert.deepEqual(attempts, [
      'gemini:gemini-3.5-flash-lite',
      'gemini:gemini-3.1-flash-lite',
      'nvidia:nvidia/nemotron-3-super-120b-a12b',
      'openrouter:cohere/north-mini-code:free'
    ]);
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.model, 'cohere/north-mini-code:free');
  });

  await t.test('A deliverable returned before submit_and_exit is not thrown away', () => {
    // Observed live on NVIDIA NIM (Nemotron): the model prints the requested
    // JSON as a normal assistant message and then ends the run with Cline's
    // submit_and_exit tool, so the run's final text is only an acknowledgement.
    const stream = [
      { type: 'agent_event', event: { type: 'content_end', contentType: 'text', text: '{\n  "summary": "did the thing"\n}' } },
      { type: 'agent_event', event: { type: 'content_start', contentType: 'tool', toolName: 'submit_and_exit', input: { summary: 'Task completed successfully', verified: true } } },
      { type: 'agent_event', event: { type: 'usage', inputTokens: 15361, outputTokens: 250 } },
      { type: 'run_result', text: 'Submission recorded (verified): Task completed successfully', usage: { inputTokens: 15361, outputTokens: 250 } }
    ].map(o => JSON.stringify(o)).join('\n');

    const parsed = parseClineStream(stream, process.cwd());
    assert.equal(parsed.deliverable, 'Submission recorded (verified): Task completed successfully');
    assert.ok(parsed.candidates.includes('{\n  "summary": "did the thing"\n}'), 'the assistant JSON must remain a candidate');
    // The raw event stream is never a candidate: it parses as JSON but is not
    // a deliverable, which previously produced a bogus "missing summary" result.
    assert.equal(parsed.candidates.some(c => c.includes('"type":"agent_event"')), false);
    assert.equal(parsed.usage.totalTokens, 15611);
    assert.equal(parsed.usage.accuracy, 'Exact');
  });

  await t.test('Non-Cline workers are unaffected by provider routing', async () => {
    const dir = tempDir('non-cline-');
    const seen = [];
    const result = await withFailover({
      config: {
        workers: [{ id: 'antigravity', enabled: true, roles: ['build'], priority: 20, adapter: 'antigravity' }],
        workerTimeoutSeconds: 60
      },
      role: 'build',
      failed: new Set(),
      paths: {},
      root,
      dir,
      stage: 'build-1',
      schema: buildSchema,
      prompt: 'tiny task',
      difficulty: 'easy',
      ready() {},
      log() {},
      call: async (worker, req) => {
        seen.push(req);
        return structuredClone(buildMockResult);
      }
    });
    assert.equal(result.worker, 'antigravity');
    assert.equal(result.model, 'gemini-3.8-flash-low');
    assert.equal(result.provider, undefined);
    assert.equal(result.runtime, undefined);
    assert.equal(seen[0].provider, undefined, 'non-Cline adapters must not receive a Cline provider');
  });
});
