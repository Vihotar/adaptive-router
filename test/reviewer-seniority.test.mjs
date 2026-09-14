import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getModelTier,
  getModelInfo,
  isModelFamilyIndependent,
  isReasoningEffortSufficient,
  evaluateReviewerQualification,
  formatQualificationBadge,
  isModelAvailableOnWorker,
  normalizeReasoningEffort
} from '../src/capability-tiers.mjs';
import { rankCandidatesForRole, selectModelAndEffort } from '../src/smart-router.mjs';

test('Reviewer Seniority & Capability Floor Test Suite', async (t) => {
  const root = process.cwd();

  await t.test('1. Tier 1 builder can be reviewed by Tier 1 or higher', () => {
    // Builder: haiku (Tier 1)
    // Reviewers: gemini-3.1-flash-lite (Tier 1), gemini-3.8-flash-medium (Tier 2)
    const qualTier1 = evaluateReviewerQualification({
      builderModel: 'haiku',
      builderTier: 1,
      candidateModel: 'gemini-3.1-flash-lite',
      candidatePlatform: 'antigravity',
      root
    });
    assert.equal(qualTier1.qualified, true, 'Tier 1 reviewer qualifies for Tier 1 builder');

    const qualTier2 = evaluateReviewerQualification({
      builderModel: 'haiku',
      builderTier: 1,
      candidateModel: 'gemini-3.8-flash-medium',
      candidatePlatform: 'antigravity',
      root
    });
    assert.equal(qualTier2.qualified, true, 'Tier 2 reviewer qualifies for Tier 1 builder');
    assert.equal(qualTier2.isSenior, true, 'Tier 2 reviewer is marked senior to Tier 1 builder');
  });

  await t.test('2. Tier 2 builder cannot be finally reviewed by Tier 1', () => {
    // Builder: gemini-3.8-flash-medium (Tier 2)
    // Candidate: gemini-3.5-flash-lite (Tier 1)
    const qual = evaluateReviewerQualification({
      builderModel: 'gemini-3.8-flash-medium',
      builderTier: 2,
      candidateModel: 'gemini-3.5-flash-lite',
      candidatePlatform: 'cline',
      root
    });
    assert.equal(qual.qualified, false);
    assert.equal(qual.reasonCode, 'SUB_SENIORITY_FLOOR');
    assert.match(qual.reason, /below builder seniority floor/i);
  });

  await t.test('3. Tier 3 builder cannot be finally reviewed by Tier 1 or Tier 2', () => {
    // Builder: gpt-5.6-sol (Tier 3)
    // Candidate 1: gemini-3.5-flash-lite (Tier 1)
    const qual1 = evaluateReviewerQualification({
      builderModel: 'gpt-5.6-sol',
      builderTier: 3,
      candidateModel: 'gemini-3.5-flash-lite',
      candidatePlatform: 'cline',
      root
    });
    assert.equal(qual1.qualified, false);
    assert.equal(qual1.reasonCode, 'SUB_SENIORITY_FLOOR');

    // Candidate 2: gemini-3.8-flash-medium (Tier 2 in normalized registry)
    const qual2 = evaluateReviewerQualification({
      builderModel: 'gpt-5.6-sol',
      builderTier: 3,
      candidateModel: 'gemini-3.8-flash-medium',
      candidatePlatform: 'antigravity',
      root
    });
    assert.equal(qual2.qualified, false);
    assert.equal(qual2.reasonCode, 'SUB_SENIORITY_FLOOR');
  });

  await t.test('4. Tier 4 builder cannot be finally reviewed by lower tiers (1, 2, 3)', () => {
    // Builder: gpt-6-astra (Tier 4)
    for (const model of ['gemini-3.5-flash-lite', 'gemini-3.8-flash-medium', 'gpt-5.6-sol', 'sonnet', 'gemini-3.1-pro-high']) {
      const qual = evaluateReviewerQualification({
        builderModel: 'gpt-6-astra',
        builderTier: 4,
        candidateModel: model,
        candidatePlatform: 'test',
        root
      });
      assert.equal(qual.qualified, false, `${model} must not qualify to review Tier 4 builder`);
      assert.equal(qual.reasonCode, 'SUB_SENIORITY_FLOOR');
    }

    // But opus (Tier 4) qualifies
    const qualOpus = evaluateReviewerQualification({
      builderModel: 'gpt-6-astra',
      builderTier: 4,
      candidateModel: 'opus',
      candidatePlatform: 'claude-code',
      root
    });
    assert.equal(qualOpus.qualified, true, 'Opus (Tier 4) qualifies to review Astra (Tier 4)');
  });

  await t.test('5. Cost protection: cheaper same-tier reviewer is preferred over unnecessarily expensive higher-tier', () => {
    // Builder is Tier 2 (gpt-5-mini)
    const config = {
      workers: [
        { id: 'antigravity', enabled: true, roles: ['review'], priority: 30, adapter: 'antigravity' },
        { id: 'claude-code', enabled: true, roles: ['review'], priority: 20, adapter: 'claude' }
      ]
    };

    // selectModelAndEffort for Antigravity on Tier 2 builder should pick Tier 2 (flash-medium), not Tier 3 (pro)
    const agSel = selectModelAndEffort({
      platform: 'antigravity',
      role: 'review',
      difficulty: 'medium',
      builderTier: 2,
      root
    });
    assert.equal(agSel.tierNumber, 2, 'Antigravity selects Tier 2 model to match Tier 2 builder and save quota');
    assert.equal(agSel.model, 'gemini-3.8-flash-medium');

    // Candidate ranking prefers the same-tier candidate
    const ranked = rankCandidatesForRole(config, 'review', {
      builderModel: 'gpt-5-mini',
      builderTier: 2,
      claudeReserve: false,
      allowClaude: true,
      root
    });
    assert.equal(ranked[0].id, 'antigravity', 'Cheaper Tier 2 candidate ranked first before Tier 3 Claude');
  });

  await t.test('6. Model-family independence is enforced (rejects same family even across different platforms)', () => {
    // Builder: sonnet (family: claude, provider: anthropic)
    // Reviewer: opus (family: claude, provider: anthropic)
    const qual = evaluateReviewerQualification({
      builderModel: 'sonnet',
      builderTier: 3,
      candidateModel: 'opus',
      candidatePlatform: 'antigravity', // running on another platform, but same family
      root
    });
    assert.equal(qual.qualified, false);
    assert.equal(qual.reasonCode, 'INSUFFICIENT_INDEPENDENCE');
    assert.match(qual.reason, /same 'claude' model family/i);

    // But gemini-3.1-pro-high (family: gemini, provider: google) is independent
    const qualIndependent = evaluateReviewerQualification({
      builderModel: 'sonnet',
      builderTier: 3,
      candidateModel: 'gemini-3.1-pro-high',
      candidatePlatform: 'antigravity',
      root
    });
    assert.equal(qualIndependent.qualified, true);
    assert.equal(qualIndependent.independence.independent, true);
  });

  await t.test('7. Reasoning effort parity: low effort is rejected for Tier 3+ reviews', () => {
    // Builder: gpt-5.6-sol (Tier 3)
    const lowEffort = isReasoningEffortSufficient(3, 'medium', 'low', 'medium');
    assert.equal(lowEffort, false, 'Low reasoning effort must be rejected for Tier 3+ builder work');

    const medEffort = isReasoningEffortSufficient(3, 'medium', 'medium', 'medium');
    assert.equal(medEffort, true, 'Medium reasoning effort is acceptable for Tier 3 review');

    // For Tier 1 builder, low effort reviewer is fine
    const tier1Effort = isReasoningEffortSufficient(1, 'low', 'low', 'low');
    assert.equal(tier1Effort, true, 'Low effort is acceptable for Tier 1 work');
  });

  await t.test('8. Claude Reserve Mode: when Claude is sole qualified senior reviewer, prompts with exact 3 options', () => {
    // Config where only Claude and a non-review worker are enabled
    const config = {
      workers: [
        { id: 'claude-code', enabled: true, roles: ['review'], priority: 20, adapter: 'claude' },
        { id: 'cline', enabled: true, roles: ['build'], priority: 35, adapter: 'cline' }
      ],
      claudeReserve: true
    };

    // Builder is Tier 3 (gpt-5.6-sol)
    // Cline only builds, so only Claude Code (Tier 3 sonnet) qualifies for review
    const withReserveOn = rankCandidatesForRole(config, 'review', {
      builderModel: 'gpt-5.6-sol',
      builderTier: 3,
      claudeReserve: true,
      allowClaude: false,
      root
    });
    assert.equal(withReserveOn.length, 0, 'No candidate selected silently while Claude is reserved');

    // With Claude allowed, it qualifies
    const withClaudeAllowed = rankCandidatesForRole(config, 'review', {
      builderModel: 'gpt-5.6-sol',
      builderTier: 3,
      claudeReserve: true,
      allowClaude: true,
      root
    });
    assert.equal(withClaudeAllowed.length, 1);
    assert.equal(withClaudeAllowed[0].id, 'claude-code');
  });

  await t.test('9. Unknown models fail safe: unregistered reviewer model is rejected as UNKNOWN_MODEL', () => {
    const qual = evaluateReviewerQualification({
      builderModel: 'gpt-5.6-sol',
      builderTier: 3,
      candidateModel: 'unmapped-cheap-llm-9000',
      candidatePlatform: 'custom',
      root
    });
    assert.equal(qual.qualified, false);
    assert.equal(qual.reasonCode, 'UNKNOWN_MODEL');
    assert.match(qual.reason, /not registered in capability-tiers\.json/i);
  });

  await t.test('10. Reviewer qualification badge formatting', () => {
    const seniorBadge = formatQualificationBadge({
      builderTier: 3,
      reviewerTier: 4,
      builderFamily: 'gpt',
      reviewerFamily: 'claude',
      reviewerWorker: 'claude-code'
    });
    assert.equal(seniorBadge, '✓ Senior reviewer — Tier 4 reviewing Tier 3 builder');

    const equalBadge = formatQualificationBadge({
      builderTier: 3,
      reviewerTier: 3,
      builderFamily: 'gpt',
      reviewerFamily: 'gemini',
      reviewerWorker: 'antigravity'
    });
    assert.equal(equalBadge, '✓ Equal capability (Tier 3) • Independent family (gemini vs gpt)');
  });

  await t.test('11. Reviewer model escalation: selectModelAndEffort raises Antigravity to Tier 3 on Tier 3 builder', () => {
    // For Tier 3 builder, Antigravity selects tier3 (gemini-3.1-pro-high) instead of tier2 (flash-medium)
    const sel = selectModelAndEffort({
      platform: 'antigravity',
      role: 'review',
      difficulty: 'medium',
      builderTier: 3,
      root
    });
    assert.equal(sel.model, 'gemini-3.1-pro-high', 'Antigravity automatically escalates model to Tier 3 to meet builder floor');
    assert.equal(sel.tierNumber, 3);
    assert.equal(sel.effort, 'high');
  });

  await t.test('12. High-effort Tier 3 builder cannot be reviewed at Medium effort', () => {
    // Builder: gpt-5.6-sol (Tier 3) with High effort
    // Reviewer: gemini-3.1-pro-high (Tier 3) with Medium effort -> REJECTED (effort parity violated)
    const qual = evaluateReviewerQualification({
      builderModel: 'gpt-5.6-sol',
      builderTier: 3,
      builderFamily: 'gpt',
      builderEffort: 'high',
      candidateModel: 'gemini-3.1-pro-high',
      candidatePlatform: 'antigravity',
      reviewerEffort: 'medium',
      taskDifficulty: 'hard',
      taskRisk: 'medium',
      root
    });
    assert.equal(qual.qualified, false);
    assert.equal(qual.reasonCode, 'INSUFFICIENT_EFFORT');
    assert.match(qual.reason, /below builder reasoning effort/i);

    // Effort sufficiency helper directly verifies
    const sufficient = isReasoningEffortSufficient(3, 'high', 'medium', 'medium');
    assert.equal(sufficient, false, 'Reviewer Medium effort is insufficient for High effort builder');
  });

  await t.test('13. Medium builder can be reviewed at High effort', () => {
    // Builder: gpt-5.6-sol (Tier 3) with Medium effort
    // Reviewer: gemini-3.1-pro-high (Tier 3) with High effort -> ACCEPTED (reviewer effort >= builder effort)
    const qual = evaluateReviewerQualification({
      builderModel: 'gpt-5.6-sol',
      builderTier: 3,
      builderFamily: 'gpt',
      builderEffort: 'medium',
      candidateModel: 'gemini-3.1-pro-high',
      candidatePlatform: 'antigravity',
      reviewerEffort: 'high',
      taskDifficulty: 'medium',
      taskRisk: 'medium',
      root
    });
    assert.equal(qual.qualified, true);
    assert.equal(qual.reviewerTier, 3);

    const sufficient = isReasoningEffortSufficient(3, 'medium', 'high', 'medium');
    assert.equal(sufficient, true, 'Reviewer High effort is valid for Medium builder');
  });

  await t.test('14. Security-critical Medium build may escalate reviewer to High', () => {
    // Builder: Medium effort on a security-critical task
    // Reviewer at Medium effort fails because security escalates requirement to High
    const qualMed = evaluateReviewerQualification({
      builderModel: 'gemini-3.8-flash-medium',
      builderTier: 2,
      builderFamily: 'gemini',
      builderEffort: 'medium',
      candidateModel: 'sonnet',
      candidatePlatform: 'claude-code',
      reviewerEffort: 'medium',
      taskDifficulty: 'medium',
      taskRisk: 'high',
      taskCategory: 'security',
      root
    });
    assert.equal(qualMed.qualified, false);
    assert.equal(qualMed.reasonCode, 'INSUFFICIENT_EFFORT');

    // Reviewer at High effort passes
    const qualHigh = evaluateReviewerQualification({
      builderModel: 'gemini-3.8-flash-medium',
      builderTier: 2,
      builderFamily: 'gemini',
      builderEffort: 'medium',
      candidateModel: 'sonnet',
      candidatePlatform: 'claude-code',
      reviewerEffort: 'high',
      taskDifficulty: 'medium',
      taskRisk: 'high',
      taskCategory: 'security',
      root
    });
    assert.equal(qualHigh.qualified, true);

    const isHighEscalated = isReasoningEffortSufficient(2, 'medium', 'medium', 'high', { taskCategory: 'security' });
    assert.equal(isHighEscalated, false, 'Security task escalates required reviewer effort above builder Medium effort');

    const isHighSatisfied = isReasoningEffortSufficient(2, 'medium', 'high', 'high', { taskCategory: 'security' });
    assert.equal(isHighSatisfied, true, 'High effort satisfies security task escalation');
  });

  await t.test('15. Unsupported reviewer effort causes another candidate to be selected', () => {
    // worker-mid only supports medium effort; worker-high supports high effort
    const config = {
      workers: [
        { id: 'worker-mid', enabled: true, roles: ['review'], priority: 10, adapter: 'antigravity', maxEffort: 'medium' },
        { id: 'worker-high', enabled: true, roles: ['review'], priority: 20, adapter: 'antigravity', maxEffort: 'high' }
      ]
    };
    // Builder ran High effort
    const ranked = rankCandidatesForRole(config, 'review', {
      builderModel: 'gpt-5.6-sol',
      builderTier: 3,
      builderFamily: 'gpt',
      builderEffort: 'high',
      difficulty: 'hard',
      root
    });
    // worker-mid cannot provide high effort, so worker-high is selected
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].id, 'worker-high');
  });

  await t.test('16. Registered but unavailable model is not considered qualified', () => {
    // Worker is configured with availableModels that excludes gemini-3.1-pro-high
    const worker = {
      id: 'antigravity',
      enabled: true,
      roles: ['review'],
      availableModels: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium']
    };

    // isModelAvailableOnWorker helper directly checks availability
    assert.equal(isModelAvailableOnWorker(worker, 'gemini-3.1-pro-high'), false);
    assert.equal(isModelAvailableOnWorker(worker, 'gemini-3.8-flash-low'), true);

    // evaluateReviewerQualification rejects the unavailable model
    const qual = evaluateReviewerQualification({
      builderModel: 'gpt-5.6-sol',
      builderTier: 3,
      candidateModel: 'gemini-3.1-pro-high',
      candidatePlatform: 'antigravity',
      candidateWorker: worker,
      reviewerEffort: 'high',
      root
    });
    assert.equal(qual.qualified, false);
    assert.equal(qual.reasonCode, 'MODEL_UNAVAILABLE');
    assert.match(qual.reason, /not available\/configured on worker/i);
  });
});
