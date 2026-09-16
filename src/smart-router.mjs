import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function classifyTask(instruction = '', feedback = null, revision = 0, { claudeReserve = true, allowClaude = false } = {}) {
  const text = instruction.toLowerCase();
  let difficulty = 'medium';
  let risk = 'medium';
  let reasons = [];
  let claudeAdvantage = false;

  // Escalation: Any revision with feedback or test failures escalates difficulty
  if (revision > 1 || feedback) {
    difficulty = 'hard';
    risk = 'high';
    reasons.push(`Escalated on revision ${revision + 1} due to ${feedback?.independentReview ? 'review findings' : 'browser test failures'}`);
  } else if (/\b(simple|trivial|typo|color|css\s*only|text\s*change|minor|easy|fast|seo|meta|metadata|sitemap|robots\.txt)\b/i.test(text) && !/\b(security|crypto|billing|auth|database|full-stack|complex)\b/i.test(text)) {
    difficulty = 'easy';
    risk = 'low';
    reasons.push('Simple presentation, SEO metadata, or minor text adjustment with minimal functional risk');
  } else if (/\b(critical|security|crypto|billing|database|full-stack|multi-step|architecture|complex)\b/i.test(text)) {
    difficulty = 'hard';
    risk = 'high';
    reasons.push('High complexity or sensitive operational requirements detected');
  } else {
    difficulty = 'medium';
    risk = 'medium';
    reasons.push('Standard interactive web recipe with validation and state requirements');
  }

  // Level 1: Platform Selection based on task requirements
  let preferredPlatform = 'codex';
  let platformReason = 'Codex chosen for structured schema adherence, state management, and strict interactive validation';

  const isDesignWork = /\b(style|css|layout|responsive|design|accessibility|accessible|theme|typography|visual|ui|appearance)\b/i.test(text) && !/\b(fast|quick|prototype|minimal)\b/i.test(text);

  if (isDesignWork) {
    // Design/UI/CSS quality benefits more from a stronger worker than from
    // routing to low-cost Cline by default — checked before the general
    // cost-saving rule below so design work keeps going to Codex/Claude Code
    // even at medium difficulty.
    claudeAdvantage = true;
    if (claudeReserve && !allowClaude) {
      preferredPlatform = 'codex';
      platformReason = 'Claude Code would be advantageous for UI/CSS, but Claude Reserve Mode is ON (quota preserved for Cowork); selecting next-best worker Codex';
    } else {
      preferredPlatform = 'claude-code';
      platformReason = 'Claude Code chosen for superior responsive CSS layout, accessible UI semantic structure, and design polish';
    }
  } else if ((difficulty === 'easy' || difficulty === 'medium') && risk !== 'high') {
    // Business rule: Cline is AR's normal lower-cost worker for ordinary/medium-difficulty
    // work (that isn't design/UI work, handled above), reserving paid Codex/Claude/Antigravity
    // subscriptions for genuinely hard or explicitly premium-flagged work.
    preferredPlatform = 'cline';
    platformReason = difficulty === 'easy'
      ? 'Cline chosen as economical low-cost worker for routine tasks'
      : 'Cline chosen for standard-difficulty work to preserve paid subscription quota for harder tasks';
  } else if (/\b(fast|quick|rapid|lightweight|prototype|minimal|speed|instant)\b/i.test(text)) {
    preferredPlatform = 'antigravity';
    platformReason = 'Antigravity chosen for rapid turnaround, fast Flash execution, and lightweight prototyping';
  } else {
    preferredPlatform = 'codex';
    platformReason = 'Codex chosen for structured schema adherence, state management, and strict interactive validation';
  }

  return { difficulty, risk, preferredPlatform, platformReason, claudeAdvantage, claudeReserve, allowClaude, reason: reasons.join('; ') };
}

export function discoverCodexModels() {
  const cachePath = path.join(process.env.USERPROFILE || '', '.codex', 'models_cache.json');
  if (fs.existsSync(cachePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (Array.isArray(data.models) && data.models.length > 0) {
        return data.models.map(m => m.id || m.slug);
      }
    } catch {}
  }
  return [];
}

let antigravityModelCache = { exePath: '', checkedAt: 0, models: [] };

export function discoverAntigravityModels(exePath) {
  const now = Date.now();
  if (exePath && antigravityModelCache.exePath === exePath && now - antigravityModelCache.checkedAt < 30_000) {
    return [...antigravityModelCache.models];
  }
  let discovered = [];
  if (exePath && fs.existsSync(exePath)) {
    try {
      const res = spawnSync(exePath, ['models'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      if (res.status === 0 && res.stdout) {
        const lines = res.stdout.trim().split(/\r?\n/);
        const models = [];
        for (const line of lines) {
          const id = line.split(/\s+/)[0]?.trim();
          if (id && !id.startsWith('Fetching') && !models.includes(id)) models.push(id);
        }
        if (models.length > 0) discovered = models;
      }
    } catch {}
  }
  antigravityModelCache = { exePath: exePath || '', checkedAt: now, models: discovered };
  return [...discovered];
}

export function discoverClaudeModels() {
  const configPath = path.join(process.env.USERPROFILE || '', '.claude.json');
  if (fs.existsSync(configPath)) {
    try {
      const d = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (Array.isArray(d.additionalModelOptionsCache) && d.additionalModelOptionsCache.length > 0) {
        const models = d.additionalModelOptionsCache.map(m => m.value || m.label?.toLowerCase());
        return ['haiku', 'sonnet', ...models];
      }
    } catch {}
  }
  return [];
}

export function discoverAvailableModels(paths = {}) {
  return {
    codex: discoverCodexModels(),
    claude: discoverClaudeModels(),
    antigravity: discoverAntigravityModels(paths.antigravity)
  };
}

export const platformModelTiers = {
  codex: {
    tier1: { model: 'gpt-5.6-luna', effort: 'low', description: 'Fastest lightweight model with low reasoning effort for simple tasks' },
    tier2: { model: 'gpt-5.6-sol', effort: 'medium', description: 'Balanced standard model with medium reasoning effort for typical recipes' },
    tier3: { model: 'gpt-6-astra', effort: 'high', description: 'Flagship high-capability model with high reasoning effort for difficult or escalated tasks' }
  },
  claude: {
    tier1: { model: 'haiku', effort: 'low', description: 'Fast lightweight Claude model for rapid straightforward implementation' },
    tier2: { model: 'sonnet', effort: 'medium', description: 'Standard balanced Claude Sonnet model for comprehensive coding' },
    tier3: { model: 'opus', effort: 'high', description: 'Deepest reasoning Claude model for high-risk or escalated revisions' }
  },
  antigravity: {
    tier1: { model: 'gemini-3.8-flash-low', effort: 'low', description: 'Gemini 3.8 Flash low-effort pool for fast responsive execution' },
    tier2: { model: 'gemini-3.8-flash-medium', effort: 'medium', description: 'Gemini 3.8 Flash medium-effort pool for thorough review and balanced building' },
    tier3: { model: 'gemini-3.1-pro-high', effort: 'high', description: 'Gemini 3.1 Pro high-effort pool for complex reasoning and deep audits' },
    tier4: { model: 'gemini-3.1-ultra', effort: 'high', description: 'Gemini 3.1 Ultra pool for frontier reasoning and senior Tier 4 audits' }
  },
  // Cline is configured with a Google Gemini API key.
  // Dynamic model tiers with intra-worker failover:
  // - Easy tasks: gemini-3.5-flash-lite (low reasoning effort, fallback: gemini-3.1-flash-lite)
  // - Medium tasks: gemini-3.5-flash-lite (medium reasoning effort, fallback: gemini-3.1-flash-lite)
  // - Hard tasks: gemini-3.8-flash (high reasoning effort, multi-model fallback: 3.7 -> 3.6 -> 3.5 -> 3 -> 2.5)
  cline: {
    tier1: {
      model: 'gemini-3.5-flash-lite',
      effort: 'low',
      fallback: ['gemini-3.1-flash-lite'],
      description: 'High-throughput Gemini Flash-Lite with low reasoning for simple Cline tasks'
    },
    tier2: {
      model: 'gemini-3.5-flash-lite',
      effort: 'medium',
      fallback: ['gemini-3.1-flash-lite'],
      description: 'High-throughput Gemini Flash-Lite with medium reasoning for standard Cline tasks'
    },
    tier3: {
      model: 'gemini-3.8-flash',
      effort: 'high',
      fallback: [
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-3-flash',
        'gemini-2.5-flash'
      ],
      description: 'Advanced Gemini Flash with high reasoning and multi-model fallback for complex Cline tasks'
    }
  }
};

import {
  getModelTier,
  getModelInfo,
  evaluateReviewerQualification,
  isModelFamilyIndependent,
  normalizeReasoningEffort
} from './capability-tiers.mjs';
import { getWorkerHealthState } from './worker-health.mjs';

export function selectModelAndEffort({
  platform,
  role,
  difficulty = 'medium',
  revision = 0,
  feedback = null,
  availableModels = {},
  platformReason = '',
  builderModel = '',
  builderProvider = '',
  builderTier = null,
  builderEffort = 'medium',
  taskRisk = 'medium',
  taskCategory = '',
  worker = null,
  root = process.cwd()
}) {
  const adapter = platform === 'claude-code' ? 'claude' : platform;
  const tiers = platformModelTiers[adapter] || platformModelTiers.antigravity;

  let selectedTierKey = 'tier2';
  let tierReason = 'standard recipe';

  if (difficulty === 'easy' && revision === 0) {
    selectedTierKey = 'tier1';
    tierReason = 'simple task suited for fast low-effort model';
  } else if (difficulty === 'hard' || revision >= 2) {
    selectedTierKey = 'tier3';
    tierReason = revision > 0 ? `escalated to maximum capability on revision ${revision + 1}` : 'high-complexity task requires flagship model';
  } else if (revision === 1) {
    selectedTierKey = 'tier2';
    tierReason = 'medium capability with escalated reasoning effort';
  }

  // Reviewer Capability Floor: if reviewing, the reviewer must meet or exceed the builder tier
  if (role === 'review' && typeof builderTier === 'number') {
    if (builderTier >= 4) {
      if (adapter === 'antigravity') {
        selectedTierKey = 'tier4';
        tierReason = `senior reviewer floor enforced for Tier ${builderTier} builder (gemini-3.1-ultra)`;
      } else if (adapter === 'codex') {
        selectedTierKey = 'tier3'; // gpt-6-astra (Tier 4)
        tierReason = `senior reviewer floor enforced for Tier ${builderTier} builder`;
      } else if (adapter === 'claude') {
        selectedTierKey = 'tier3'; // opus (Tier 4)
        tierReason = `senior reviewer floor enforced for Tier ${builderTier} builder`;
      }
    } else if (builderTier === 3) {
      if (adapter === 'antigravity') {
        selectedTierKey = 'tier3'; // gemini-3.1-pro-high (Tier 3 in normalized registry)
        tierReason = `senior reviewer floor enforced for Tier ${builderTier} builder (gemini-3.1-pro-high)`;
      } else if (adapter === 'codex') {
        selectedTierKey = 'tier2'; // gpt-5.6-sol (Tier 3)
        tierReason = `senior reviewer floor enforced for Tier ${builderTier} builder`;
      } else if (adapter === 'claude') {
        selectedTierKey = 'tier2'; // sonnet (Tier 3)
        tierReason = `senior reviewer floor enforced for Tier ${builderTier} builder`;
      }
    } else if (builderTier === 2) {
      // Cost protection: Tier 2 builder only needs Tier 2 reviewer
      if (selectedTierKey === 'tier1') {
        selectedTierKey = 'tier2';
        tierReason = 'reviewer capability floor raised to Tier 2 to match builder';
      }
    }
  }

  const baseTier = tiers[selectedTierKey] || tiers['tier3'] || tiers['tier2'];
  let model = baseTier.model;
  let effort = baseTier.effort;

  // For review role: Enforce Reviewer Effort Parity (reviewer effort >= builder effort) & risk escalation
  if (role === 'review') {
    // Target effort starts at builder's effort level
    const bEffortLevel = normalizeReasoningEffort(builderEffort || 'medium');
    let targetEffortLevel = bEffortLevel;

    // Default for tier1 reviews without specified builder effort is low
    if (!builderEffort && selectedTierKey === 'tier1') {
      targetEffortLevel = 1;
    }

    // Tier 3+ builder work requires at least medium effort (level 2)
    if (typeof builderTier === 'number' && builderTier >= 3) {
      targetEffortLevel = Math.max(targetEffortLevel, 2);
    }

    // Risk / security escalation: security tasks or high-risk escalate reviewer effort to High (level 3)
    if (taskRisk === 'high' || revision >= 2 || /\b(security|critical|auth|crypto)\b/i.test(taskCategory || '')) {
      targetEffortLevel = Math.max(targetEffortLevel, 3);
    }

    // Map target effort level to effort string
    const effortMap = { 1: 'low', 2: 'medium', 3: 'high', 4: 'max' };
    effort = effortMap[targetEffortLevel] || 'medium';
  }

  // If revision > 0, escalate effort
  if (revision > 0 && effort === 'low') {
    effort = 'medium';
  } else if (revision >= 2) {
    effort = 'high';
  }

  // Check if worker / platform restricts maximum effort
  const workerObj = worker || (typeof platform === 'object' ? platform : null);
  if (workerObj?.maxEffort) {
    const maxWorkerEffort = normalizeReasoningEffort(workerObj.maxEffort);
    const currentEffortLevel = normalizeReasoningEffort(effort);
    if (currentEffortLevel > maxWorkerEffort) {
      const effortMap = { 1: 'low', 2: 'medium', 3: 'high', 4: 'max' };
      effort = effortMap[maxWorkerEffort] || 'medium';
    }
  }

  // Antigravity exposes reasoning level as part of the model identifier. Keep
  // governance metadata aligned with what the CLI will actually run.
  if (adapter === 'antigravity') {
    if (/-high$|-thinking$/i.test(model)) effort = 'high';
    else if (/-medium$/i.test(model)) effort = 'medium';
    else if (/-low$|-lite$/i.test(model)) effort = 'low';
  }

  // Validate that model is in available models if list provided
  const list = availableModels[adapter];
  if (Array.isArray(list) && list.length > 0 && !list.includes(model)) {
    const fallback = list.find(m => m.includes(selectedTierKey === 'tier1' ? 'flash' : selectedTierKey === 'tier3' ? 'pro' : 'flash')) || list[0];
    if (fallback) model = fallback;
  }

  // Resolve normalized capability tier
  const normTier = getModelTier(model, role === 'review' ? 'review' : 'coding', root);
  const normalizedTierLevel = normTier.tier || (selectedTierKey === 'tier1' ? 1 : selectedTierKey === 'tier3' ? 4 : 2);
  const normalizedTierName = normTier.name || `Tier ${normalizedTierLevel}`;

  let cleanPlatformReason = platformReason || '';
  if (platform !== 'codex' && cleanPlatformReason.includes('Codex chosen')) {
    if (platform === 'antigravity') {
      cleanPlatformReason = 'Antigravity chosen for rapid turnaround, fast Flash execution, and lightweight prototyping';
    } else if (platform === 'cline') {
      cleanPlatformReason = 'Cline chosen for autonomous task execution';
    } else {
      cleanPlatformReason = '';
    }
  }

  const prefix = cleanPlatformReason ? `${cleanPlatformReason}. ` : '';
  const reason = `${prefix}${difficulty.toUpperCase()} task (${tierReason}) -> ${model} [effort: ${effort}]`;
  return {
    model,
    effort,
    reason,
    tier: selectedTierKey,
    tierNumber: normalizedTierLevel,
    tierName: normalizedTierName,
    provider: normTier.provider,
    family: normTier.family,
    fallbackModels: baseTier.fallback ? [...baseTier.fallback] : []
  };
}

export const clineModelPools = {
  easy: {
    primary: 'gemini-3.5-flash-lite',
    fallbacks: ['gemini-3.1-flash-lite'],
    effort: 'low'
  },
  medium: {
    primary: 'gemini-3.5-flash-lite',
    fallbacks: ['gemini-3.1-flash-lite'],
    effort: 'medium'
  },
  hard: {
    primary: 'gemini-3.8-flash',
    fallbacks: [
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3-flash',
      'gemini-2.5-flash'
    ],
    effort: 'high'
  }
};

export function getClineModelSequence(difficulty = 'medium') {
  const pool = clineModelPools[difficulty] || clineModelPools.medium;
  return [pool.primary, ...pool.fallbacks];
}

export function rankCandidatesForRole(config, role, {
  excluded = [],
  failed = new Set(),
  preferredFamily = null,
  difficulty = 'medium',
  claudeReserve = (config?.claudeReserve !== false),
  allowClaude = false,
  builderModel = '',
  builderTier = null,
  builderFamily = '',
  builderEffort = 'medium',
  builderPlatform = '',
  taskRisk = 'medium',
  taskCategory = '',
  availableModels = {},
  root = process.cwd()
} = {}) {
  const isEasy = difficulty === 'easy';
  const clineEligible = (isEasy || difficulty === 'medium') && taskRisk !== 'high';
  const defaultOrder = role === 'review'
    ? ['codex', 'antigravity', 'claude-code']
    : (clineEligible ? ['cline', 'codex', 'claude-code', 'antigravity'] : ['codex', 'claude-code', 'antigravity', 'cline']);

  return config.workers
    .filter(w => {
      if (!w.enabled || !w.roles.includes(role) || excluded.includes(w.id) || failed.has(w.id)) return false;

      // Worker health: a worker with 3+ recent failures/timeouts is in a
      // temporary cooldown and excluded from selection until the cooldown
      // window elapses or a success is recorded. This is separate from
      // workers.json's `enabled` flag (deliberate on/off) and from `failed`
      // (this-task-only, reset every new task) — cooldown persists across
      // tasks but is always temporary and never a substitute for actually
      // disabling a worker.
      if (getWorkerHealthState(root, w.id).state === 'cooldown') return false;

      // When Claude Reserve Mode is ON and Claude use is not authorized,
      // exclude Claude Code from normal silent failover and candidate selection
      if ((w.id === 'claude-code' || w.adapter === 'claude') && claudeReserve && !allowClaude) {
        return false;
      }

      // Reviewer Seniority & Independence Floor
      if (role === 'review' && typeof builderTier === 'number') {
        const candidateSelection = selectModelAndEffort({
          platform: w.id,
          worker: w,
          role: 'review',
          difficulty,
          builderModel,
          builderTier,
          builderEffort,
          taskRisk,
          taskCategory,
          availableModels,
          root
        });
        const qual = evaluateReviewerQualification({
          builderModel,
          builderTier,
          builderFamily,
          builderPlatform,
          builderEffort,
          candidateModel: candidateSelection.model,
          candidatePlatform: w.id,
          candidateWorker: w,
          reviewerEffort: candidateSelection.effort,
          taskDifficulty: difficulty,
          taskRisk,
          taskCategory,
          availableModels,
          root
        });

        if (!qual.qualified) {
          return false;
        }
      }

      return true;
    })
    .sort((a, b) => {
      if (preferredFamily) {
        const aMatch = a.id === preferredFamily || a.adapter === preferredFamily;
        const bMatch = b.id === preferredFamily || b.adapter === preferredFamily;
        if (aMatch && !bMatch) return -1;
        if (!aMatch && bMatch) return 1;
      }

      // Worker health: rank a degraded worker after healthy alternatives.
      // Still eligible (unlike cooldown, which excludes outright) — this is
      // a soft preference, not a hard rule, so a degraded worker is still
      // used when it's the only qualified candidate.
      const aDegraded = getWorkerHealthState(root, a.id).state === 'degraded';
      const bDegraded = getWorkerHealthState(root, b.id).state === 'degraded';
      if (aDegraded !== bDegraded) return aDegraded ? 1 : -1;

      // If review role: Cost protection — sort qualified candidates so lowest sufficient tier / free tier comes first
      if (role === 'review' && typeof builderTier === 'number') {
        const aSel = selectModelAndEffort({ platform: a.id, role: 'review', difficulty, builderTier, root });
        const bSel = selectModelAndEffort({ platform: b.id, role: 'review', difficulty, builderTier, root });
        const aDiff = (aSel.tierNumber || 2) - builderTier;
        const bDiff = (bSel.tierNumber || 2) - builderTier;
        // Prefer candidate closest to builderTier (same tier first to avoid burning quota)
        if (aDiff !== bDiff) return aDiff - bDiff;
      }

      return defaultOrder.indexOf(a.id) - defaultOrder.indexOf(b.id);
    });
}
