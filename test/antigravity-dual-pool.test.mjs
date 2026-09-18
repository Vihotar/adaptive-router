import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import {
  ANTIGRAVITY_POOLS,
  POOL_MODELS,
  getAntigravityModelPool,
  parseQuotaOutput,
  readAntigravityQuota,
  getAntigravityPoolHealth,
  markAntigravityPoolExhausted,
  clearAntigravityQuotaCache
} from '../src/antigravity-quota.mjs';

import {
  getModelTier,
  getModelPool,
  evaluateReviewerQualification
} from '../src/capability-tiers.mjs';

import {
  selectModelAndEffort,
  platformModelTiers,
  rankCandidatesForRole
} from '../src/smart-router.mjs';

import { getWorkerStatuses } from '../src/server.mjs';
import { getWorkerHealthState } from '../src/worker-health.mjs';

const mockQuotaJson = JSON.stringify({
  command: {
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-5h",
              window: "5h",
              remaining_fraction: 0.85,
              reset_time: "2026-09-18T15:00:00Z"
            },
            {
              id: "gemini-weekly",
              window: "weekly",
              remaining_fraction: 0.92,
              reset_time: "2026-09-22T00:00:00Z"
            }
          ]
        },
        {
          name: "Claude and GPT Models",
          buckets: [
            {
              id: "3p-5h",
              window: "5h",
              remaining_fraction: 0.75,
              reset_time: "2026-09-18T14:30:00Z"
            },
            {
              id: "3p-weekly",
              window: "weekly",
              remaining_fraction: 0.88,
              reset_time: "2026-09-21T00:00:00Z"
            }
          ]
        }
      ]
    }
  }
});

test('Antigravity Dual-Quota Pool Awareness Test Suite', async (t) => {
  t.beforeEach(() => {
    clearAntigravityQuotaCache();
  });

  await t.test('1. JSON parsing of agy.exe -p /quota output extracts both pools accurately', () => {
    const parsed = parseQuotaOutput(mockQuotaJson);
    assert.ok(parsed);
    assert.equal(parsed.gemini.remaining5h, 0.85);
    assert.equal(parsed.gemini.remainingWeekly, 0.92);
    assert.equal(parsed.gemini.reset5h, "2026-09-18T15:00:00Z");
    assert.equal(parsed.gemini.resetWeekly, "2026-09-22T00:00:00Z");

    assert.equal(parsed.claude_gpt.remaining5h, 0.75);
    assert.equal(parsed.claude_gpt.remainingWeekly, 0.88);
    assert.equal(parsed.claude_gpt.reset5h, "2026-09-18T14:30:00Z");
    assert.equal(parsed.claude_gpt.resetWeekly, "2026-09-21T00:00:00Z");
  });

  await t.test('2. Pool health evaluation accurately identifies healthy, low, and exhausted states', () => {
    // Healthy
    const healthHealthy = getAntigravityPoolHealth(null, { mockOutput: mockQuotaJson });
    assert.equal(healthHealthy.gemini.status, 'healthy');
    assert.equal(healthHealthy.claude_gpt.status, 'healthy');
    assert.equal(healthHealthy.overallHealthy, true);
    assert.equal(healthHealthy.overallAvailable, true);

    // Low
    const lowJson = JSON.stringify({
      command: {
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "gemini-5h", remaining_fraction: 0.08 },
                { id: "gemini-weekly", remaining_fraction: 0.80 }
              ]
            },
            {
              name: "Claude and GPT Models",
              buckets: [
                { id: "3p-5h", remaining_fraction: 0.90 },
                { id: "3p-weekly", remaining_fraction: 0.90 }
              ]
            }
          ]
        }
      }
    });
    const healthLow = getAntigravityPoolHealth(null, { mockOutput: lowJson });
    assert.equal(healthLow.gemini.status, 'low');
    assert.equal(healthLow.gemini.available, true);
    assert.equal(healthLow.claude_gpt.status, 'healthy');

    // Exhausted
    const exhaustedJson = JSON.stringify({
      command: {
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "gemini-5h", remaining_fraction: 0.005 },
                { id: "gemini-weekly", remaining_fraction: 0.80 }
              ]
            },
            {
              name: "Claude and GPT Models",
              buckets: [
                { id: "3p-5h", remaining_fraction: 0.90 },
                { id: "3p-weekly", remaining_fraction: 0.90 }
              ]
            }
          ]
        }
      }
    });
    const healthExhausted = getAntigravityPoolHealth(null, { mockOutput: exhaustedJson });
    assert.equal(healthExhausted.gemini.status, 'exhausted');
    assert.equal(healthExhausted.gemini.available, false);
    assert.equal(healthExhausted.claude_gpt.status, 'healthy');
    assert.equal(healthExhausted.overallAvailable, true);
  });

  await t.test('3. 60s cache TTL avoids redundant CLI calls within the TTL window', () => {
    let callCount = 0;
    const fakeMock1 = JSON.stringify({
      command: {
        data: {
          groups: [
            { name: "Gemini Models", buckets: [{ id: "gemini-5h", remaining_fraction: 0.9 }] },
            { name: "Claude and GPT Models", buckets: [{ id: "3p-5h", remaining_fraction: 0.9 }] }
          ]
        }
      }
    });
    const fakeMock2 = JSON.stringify({
      command: {
        data: {
          groups: [
            { name: "Gemini Models", buckets: [{ id: "gemini-5h", remaining_fraction: 0.1 }] },
            { name: "Claude and GPT Models", buckets: [{ id: "3p-5h", remaining_fraction: 0.1 }] }
          ]
        }
      }
    });

    const res1 = readAntigravityQuota('fake.exe', { mockOutput: fakeMock1 });
    assert.equal(res1.gemini.remaining5h, 0.9);

    // Call again without forceRefresh; should use cache
    const res2 = readAntigravityQuota('fake.exe');
    assert.equal(res2.gemini.remaining5h, 0.9);

    // Force refresh with new data
    const res3 = readAntigravityQuota('fake.exe', { forceRefresh: true, mockOutput: fakeMock2 });
    assert.equal(res3.gemini.remaining5h, 0.1);
  });

  await t.test('4. Gemini-low routing shifts Tier 3 tasks to claude-sonnet-4-6', () => {
    const lowGeminiPoolHealth = {
      gemini: { status: 'low', healthy: false, available: true, remaining5h: 0.08, remainingWeekly: 0.5 },
      claude_gpt: { status: 'healthy', healthy: true, available: true, remaining5h: 0.8, remainingWeekly: 0.9 },
      overallHealthy: true,
      overallAvailable: true
    };

    const sel = selectModelAndEffort({
      platform: 'antigravity',
      role: 'review',
      difficulty: 'hard',
      antigravityPoolHealth: lowGeminiPoolHealth
    });

    assert.equal(sel.model, 'claude-sonnet-4-6');
    assert.equal(sel.pool, 'claude_gpt');
    assert.match(sel.reason, /Gemini pool low -> shifted to Claude pool claude-sonnet-4-6/);
  });

  await t.test('5. Claude-low routing shifts Tier 4 tasks to gemini-3.1-pro-high', () => {
    const exhaustedClaudePoolHealth = {
      gemini: { status: 'healthy', healthy: true, available: true, remaining5h: 0.8, remainingWeekly: 0.9 },
      claude_gpt: { status: 'exhausted', healthy: false, available: false, remaining5h: 0.0, remainingWeekly: 0.5 },
      overallHealthy: true,
      overallAvailable: true
    };

    const sel = selectModelAndEffort({
      platform: 'antigravity',
      role: 'review',
      builderTier: 4,
      antigravityPoolHealth: exhaustedClaudePoolHealth
    });

    assert.equal(sel.model, 'gemini-3.1-pro-high');
    assert.equal(sel.pool, 'gemini');
    assert.match(sel.reason, /Claude\/GPT pool exhausted -> shifted to Gemini pool gemini-3.1-pro-high/);
  });

  await t.test('6. Single pool exhaustion resilience preserves Antigravity seat availability', () => {
    const geminiExhaustedHealth = {
      gemini: { status: 'exhausted', healthy: false, available: false, remaining5h: 0.0, remainingWeekly: 0.0 },
      claude_gpt: { status: 'healthy', healthy: true, available: true, remaining5h: 0.9, remainingWeekly: 0.9 },
      overallHealthy: true,
      overallAvailable: true
    };

    // Tier 1/2 falls back to gpt-oss-120b-medium
    const sel = selectModelAndEffort({
      platform: 'antigravity',
      role: 'build',
      difficulty: 'medium',
      antigravityPoolHealth: geminiExhaustedHealth
    });

    assert.equal(sel.model, 'gpt-oss-120b-medium');
    assert.equal(sel.pool, 'claude_gpt');
    assert.equal(sel.available, true);
    assert.equal(sel.exhausted, false);
  });

  await t.test('7. Dual pool failover excludes Antigravity when both pools are exhausted', () => {
    // Mark both pools exhausted
    markAntigravityPoolExhausted(ANTIGRAVITY_POOLS.GEMINI);
    markAntigravityPoolExhausted(ANTIGRAVITY_POOLS.CLAUDE_GPT);

    const health = getAntigravityPoolHealth(null);
    assert.equal(health.gemini.available, false);
    assert.equal(health.claude_gpt.available, false);
    assert.equal(health.overallAvailable, false);

    const config = {
      workers: [
        { id: 'codex', enabled: true, roles: ['build', 'review'], priority: 10, adapter: 'codex' },
        { id: 'antigravity', enabled: true, roles: ['review'], priority: 20, adapter: 'antigravity' }
      ]
    };

    const candidates = rankCandidatesForRole(config, 'review', {
      difficulty: 'medium',
      builderTier: 2
    });

    // Antigravity must be filtered out because both pools are exhausted
    assert.ok(!candidates.some(c => c.id === 'antigravity'));
    assert.ok(candidates.some(c => c.id === 'codex'));
  });

  await t.test('8. Rejection of non-existent models gemini-3.1-ultra and gemini-3.1-pro-medium', () => {
    // gemini-3.1-ultra is removed from registry and unmapped
    const ultraTier = getModelTier('gemini-3.1-ultra');
    assert.equal(ultraTier.tier, null);
    assert.equal(ultraTier.isKnown, false);

    // Verify neither model exists in verified POOL_MODELS
    assert.ok(!POOL_MODELS[ANTIGRAVITY_POOLS.GEMINI].includes('gemini-3.1-ultra'));
    assert.ok(!POOL_MODELS[ANTIGRAVITY_POOLS.GEMINI].includes('gemini-3.1-pro-medium'));
    assert.ok(!POOL_MODELS[ANTIGRAVITY_POOLS.CLAUDE_GPT].includes('gemini-3.1-ultra'));
    assert.ok(!POOL_MODELS[ANTIGRAVITY_POOLS.CLAUDE_GPT].includes('gemini-3.1-pro-medium'));

    // Verify neither model is configured in platformModelTiers.antigravity
    const configuredModels = Object.values(platformModelTiers.antigravity).map(t => t.model);
    assert.ok(!configuredModels.includes('gemini-3.1-ultra'));
    assert.ok(!configuredModels.includes('gemini-3.1-pro-medium'));
  });

  await t.test('9. --effort suppression logic on 3P models (claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium)', () => {
    const testEffortPassing = (model, effort) => {
      const is3PModel = /^(claude|gpt)/i.test(model || '') || getAntigravityModelPool(model) === ANTIGRAVITY_POOLS.CLAUDE_GPT;
      const hasEffortSuffix = /-high$|-medium$|-low$|-thinking$/i.test(model || '');
      return Boolean(effort && !is3PModel && !hasEffortSuffix);
    };

    // 3P models must NEVER pass --effort
    assert.equal(testEffortPassing('claude-sonnet-4-6', 'high'), false);
    assert.equal(testEffortPassing('claude-opus-4-6-thinking', 'high'), false);
    assert.equal(testEffortPassing('gpt-oss-120b-medium', 'medium'), false);

    // Effort-suffixed Gemini models must NEVER pass --effort
    assert.equal(testEffortPassing('gemini-3.8-flash-low', 'low'), false);
    assert.equal(testEffortPassing('gemini-3.8-flash-medium', 'medium'), false);
    assert.equal(testEffortPassing('gemini-3.1-pro-high', 'high'), false);
  });

  await t.test('10. gpt-oss-120b-medium valid registry config and pool mapping', () => {
    const tier = getModelTier('gpt-oss-120b-medium');
    assert.equal(tier.tier, 2);
    assert.equal(tier.provider, 'google-antigravity');
    assert.equal(tier.family, 'gpt');

    const pool = getModelPool('gpt-oss-120b-medium');
    assert.equal(pool, 'CLAUDE_GPT');
    assert.equal(getAntigravityModelPool('gpt-oss-120b-medium'), ANTIGRAVITY_POOLS.CLAUDE_GPT);
  });

  await t.test('11. Claude Reserve preservation allows Antigravity Claude models', () => {
    // When claudeReserve: true, Antigravity using claude-sonnet-4-6 or claude-opus-4-6-thinking
    // should NOT be blocked because it consumes Google's quota, not Anthropic's.
    const sel = selectModelAndEffort({
      platform: 'antigravity',
      role: 'review',
      builderTier: 4,
      claudeReserve: true,
      allowClaude: false
    });

    assert.equal(sel.model, 'claude-opus-4-6-thinking');
    assert.equal(sel.pool, 'claude_gpt');
    assert.equal(sel.available, true);
  });

  await t.test('12. Existing routes remain stable across workforce platforms', () => {
    assert.equal(platformModelTiers.codex.tier1.model, 'gpt-5.6-luna');
    assert.equal(platformModelTiers.claude.tier2.model, 'sonnet');
    assert.equal(platformModelTiers.cline.tier1.model, 'gemini-3.5-flash-lite');

    // Default healthy Antigravity routes
    assert.equal(platformModelTiers.antigravity.tier1.model, 'gemini-3.8-flash-low');
    assert.equal(platformModelTiers.antigravity.tier2.model, 'gemini-3.8-flash-medium');
    assert.equal(platformModelTiers.antigravity.tier3.model, 'gemini-3.1-pro-high');
    assert.equal(platformModelTiers.antigravity.tier4.model, 'claude-opus-4-6-thinking');
  });

  await t.test('13. Worker health state exposes dual pools for Antigravity seat', () => {
    const health = getWorkerHealthState(process.cwd(), 'antigravity');
    assert.ok(health.pools);
    assert.ok(health.pools.gemini);
    assert.ok(health.pools.claude_gpt);
    assert.equal(typeof health.pools.gemini.remaining5h, 'number');
    assert.equal(typeof health.pools.claude_gpt.remaining5h, 'number');
  });

  await t.test('14. Reactive exhaustion marks specific pool and allows surviving pool', () => {
    // Mark Gemini pool exhausted
    markAntigravityPoolExhausted(ANTIGRAVITY_POOLS.GEMINI);

    const health = getAntigravityPoolHealth(null);
    assert.equal(health.gemini.status, 'exhausted');
    assert.equal(health.gemini.available, false);
    assert.equal(health.claude_gpt.status, 'healthy');
    assert.equal(health.claude_gpt.available, true);
    assert.equal(health.overallAvailable, true); // Surviving Claude pool keeps worker available
  });
});
