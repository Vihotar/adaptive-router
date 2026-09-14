/**
 * capability-tiers.mjs — Normalized Model Capability Tier System & Seniority Verification
 *
 * Implements:
 * 1. Normalized 4-tier model capability classification (independent of provider branding).
 * 2. Task/domain-aware tier resolution (defaultTier with optional domain overrides like review/coding).
 * 3. Reviewer Seniority Rule: reviewer tier >= builder tier.
 * 4. Model-family & provider-level independence verification.
 * 5. Reasoning effort sufficiency enforcement for senior tasks.
 * 6. Fail-safe rejection of unknown/unregistered reviewer models.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRegistry = null;
let cachedRegistryMtime = 0;

/**
 * Load capability tiers registry from src/capability-tiers.json.
 */
export function loadCapabilityRegistry(root = process.cwd()) {
  const candidatePaths = [
    path.join(root, 'src', 'capability-tiers.json'),
    path.join(process.cwd(), 'src', 'capability-tiers.json'),
    fileURLToPath(new URL('./capability-tiers.json', import.meta.url))
  ];

  for (const jsonPath of candidatePaths) {
    try {
      if (fs.existsSync(jsonPath)) {
        const stat = fs.statSync(jsonPath);
        if (cachedRegistry && cachedRegistryMtime === stat.mtimeMs) {
          return cachedRegistry;
        }
        const raw = fs.readFileSync(jsonPath, 'utf8');
        cachedRegistry = JSON.parse(raw);
        cachedRegistryMtime = stat.mtimeMs;
        return cachedRegistry;
      }
    } catch (e) {
      console.error('Failed to read capability-tiers.json at', jsonPath, e.message);
    }
  }

  // Fallback defaults if file cannot be read
  return {
    tiers: {
      1: { level: 1, name: 'Lightweight', description: 'Lightweight models' },
      2: { level: 2, name: 'Standard', description: 'Standard models' },
      3: { level: 3, name: 'Advanced', description: 'Advanced models' },
      4: { level: 4, name: 'Expert / Frontier', description: 'Frontier models' }
    },
    models: {}
  };
}

/**
 * Normalize model identifier for matching (lowercased, stripped of common prefixes/tags).
 */
export function normalizeModelId(modelId) {
  if (!modelId || typeof modelId !== 'string') return '';
  return modelId.trim().toLowerCase();
}

/**
 * Get detailed model metadata from registry.
 * Returns null if model is unknown.
 */
export function getModelInfo(modelId, root = process.cwd()) {
  const reg = loadCapabilityRegistry(root);
  const norm = normalizeModelId(modelId);
  if (!norm) return null;

  // Direct lookup
  if (reg.models[norm]) {
    return { id: norm, ...reg.models[norm] };
  }

  // Prefix / partial matching for version variants (e.g. gpt-5.6-sol:latest -> gpt-5.6-sol)
  for (const [key, info] of Object.entries(reg.models)) {
    if (norm === key || norm.startsWith(`${key}:`) || norm.startsWith(`${key}-`)) {
      return { id: key, ...info };
    }
  }

  // Fallback: strip provider prefix if present (e.g., openai/gpt-oss-20b -> gpt-oss-20b)
  if (norm.includes('/')) {
    const unnamespaced = norm.split('/').slice(1).join('/');
    if (reg.models[unnamespaced]) {
      return { id: unnamespaced, ...reg.models[unnamespaced] };
    }
    const cleanUnnamespaced = unnamespaced.replace(/:free$/, '');
    if (reg.models[cleanUnnamespaced]) {
      return { id: cleanUnnamespaced, ...reg.models[cleanUnnamespaced] };
    }
  }

  // Fallback: strip :free suffix if present
  if (norm.endsWith(':free')) {
    const noFree = norm.replace(/:free$/, '');
    if (reg.models[noFree]) {
      return { id: noFree, ...reg.models[noFree] };
    }
  }

  return null;
}

/**
 * Resolve model capability tier (1..4) in a specific domain (default: 'default').
 * If unknown, returns { tier: null, isKnown: false }.
 */
export function getModelTier(modelId, domain = 'default', root = process.cwd()) {
  const info = getModelInfo(modelId, root);
  if (!info) {
    return {
      tier: null,
      level: null,
      name: 'Unknown',
      isKnown: false,
      model: modelId
    };
  }

  const reg = loadCapabilityRegistry(root);
  let level = info.defaultTier || 1;
  if (domain && domain !== 'default' && info.domains && typeof info.domains[domain] === 'number') {
    level = info.domains[domain];
  }

  const tierMeta = reg.tiers[String(level)] || { level, name: `Tier ${level}`, description: '' };
  return {
    tier: level,
    level,
    name: tierMeta.name || `Tier ${level}`,
    description: tierMeta.description || '',
    provider: info.provider || 'unknown',
    family: info.family || 'unknown',
    isKnown: true,
    model: info.id
  };
}

/**
 * Verify whether builder and reviewer are genuinely independent by model family & provider.
 */
export function isModelFamilyIndependent(builderModel, reviewerModel, root = process.cwd(), { builderPlatform = '', candidatePlatform = '' } = {}) {
  const bNorm = normalizeModelId(builderModel);
  const rNorm = normalizeModelId(reviewerModel);
  const bPlat = (builderPlatform || (bNorm.includes('flash-lite') ? 'cline' : '')).toLowerCase();
  const rPlat = (candidatePlatform || '').toLowerCase();
  const isCrossClineAntigravity = (bPlat === 'cline' && (rPlat === 'antigravity' || rNorm.includes('flash-medium') || rNorm.includes('pro-high') || rNorm.includes('ultra') || rNorm.includes('gemini-3.8-flash-low'))) ||
                                  (bPlat === 'antigravity' && (rPlat === 'cline' || rNorm.includes('flash-lite')));

  const bInfo = getModelInfo(builderModel, root);
  const rInfo = getModelInfo(reviewerModel, root);

  // If both models are known
  if (bInfo && rInfo) {
    const sameFamily = bInfo.family && rInfo.family && bInfo.family === rInfo.family;
    const sameProvider = bInfo.provider && rInfo.provider && bInfo.provider === rInfo.provider;
    if (sameFamily) {
      if (isCrossClineAntigravity) {
        return {
          independent: true,
          reason: `Independent agent platforms: Antigravity environment reviewing Cline (${rInfo.id} reviewing ${bInfo.id})`,
          builderFamily: bInfo.family,
          reviewerFamily: rInfo.family,
          builderProvider: bInfo.provider,
          reviewerProvider: rInfo.provider
        };
      }
      return {
        independent: false,
        reason: `Both models belong to the same '${bInfo.family}' model family (${bInfo.provider || 'same provider'})`,
        builderFamily: bInfo.family,
        reviewerFamily: rInfo.family,
        builderProvider: bInfo.provider,
        reviewerProvider: rInfo.provider
      };
    }
    return {
      independent: true,
      reason: `Independent model families: '${rInfo.family}' (${rInfo.provider}) vs '${bInfo.family}' (${bInfo.provider})`,
      builderFamily: bInfo.family,
      reviewerFamily: rInfo.family,
      builderProvider: bInfo.provider,
      reviewerProvider: rInfo.provider
    };
  }

  // Fallback heuristic if one or both models are unmapped
  const getHeuristicFamily = (str) => {
    if (/claude|sonnet|opus|haiku/i.test(str)) return 'claude';
    if (/gpt|o1|o3|codex/i.test(str)) return 'gpt';
    if (/gemini/i.test(str)) return 'gemini';
    if (/llama|meta/i.test(str)) return 'llama';
    return str;
  };
  const bFam = getHeuristicFamily(bNorm);
  const rFam = getHeuristicFamily(rNorm);
  const same = bFam && rFam && bFam === rFam;
  if (same && isCrossClineAntigravity) {
    return {
      independent: true,
      reason: `Independent agent platforms: Antigravity environment reviewing Cline (${rNorm} reviewing ${bNorm})`,
      builderFamily: bFam,
      reviewerFamily: rFam,
      builderProvider: 'cline',
      reviewerProvider: 'antigravity'
    };
  }
  return {
    independent: !same,
    reason: same ? `Same model family heuristic (${bFam})` : `Independent model families (${rFam} vs ${bFam})`,
    builderFamily: bFam,
    reviewerFamily: rFam,
    builderProvider: 'heuristic',
    reviewerProvider: 'heuristic'
  };
}

/**
 * Normalized reasoning effort scale:
 * 1 = Low
 * 2 = Medium
 * 3 = High
 * 4 = Extra High / Max / equivalent
 */
export const NORMALIZED_EFFORT_LEVELS = {
  1: 'low',
  2: 'medium',
  3: 'high',
  4: 'max'
};

/**
 * Normalizes platform-specific reasoning effort into normalized 1-4 scale.
 */
export function normalizeReasoningEffort(effort) {
  if (effort === null || effort === undefined) return 2; // Default to Medium
  if (typeof effort === 'number') {
    if (effort <= 1) return 1;
    if (effort === 2) return 2;
    if (effort === 3) return 3;
    return 4;
  }
  const str = String(effort).trim().toLowerCase();
  if (/^(1|low|minimum|min)$/i.test(str)) return 1;
  if (/^(2|med|medium|standard|default|normal)$/i.test(str)) return 2;
  if (/^(3|high|deep|thorough|o3-high)$/i.test(str)) return 3;
  if (/^(4|extra[-_]?high|max|maximum|ultra|extreme|o3-max)$/i.test(str)) return 4;
  return 2;
}

/**
 * Check if a model is currently available/configured on a specific worker.
 */
export function isModelAvailableOnWorker(worker, modelId, { availableModels = {}, root = process.cwd() } = {}) {
  if (!worker || !modelId) return false;
  const normModel = normalizeModelId(modelId);

  // If worker object has explicit availableModels or models list
  if (Array.isArray(worker.availableModels)) {
    return worker.availableModels.map(normalizeModelId).includes(normModel);
  }
  if (Array.isArray(worker.models)) {
    return worker.models.map(normalizeModelId).includes(normModel);
  }

  // If passed via availableModels dictionary by worker.id or worker.adapter
  const hasWorkerList = Object.prototype.hasOwnProperty.call(availableModels, worker.id);
  const hasAdapterList = Object.prototype.hasOwnProperty.call(availableModels, worker.adapter);
  const workerList = hasWorkerList ? availableModels[worker.id] : availableModels[worker.adapter];
  if ((hasWorkerList || hasAdapterList) && Array.isArray(workerList)) {
    return workerList.map(normalizeModelId).includes(normModel);
  }

  // If worker specifies unavailableModels
  if (Array.isArray(worker.unavailableModels) && worker.unavailableModels.length > 0) {
    if (worker.unavailableModels.map(normalizeModelId).includes(normModel)) {
      return false;
    }
  }

  return true;
}

/**
 * Verify if reviewer reasoning effort satisfies effort parity and task risk:
 * Rule: reviewer reasoning effort >= builder reasoning effort
 * (and risk escalation may increase reviewer effort above builder effort).
 */
export function isReasoningEffortSufficient(builderTier, builderEffort, reviewerEffort, taskRisk = 'medium', { taskCategory = '' } = {}) {
  const bEffortRank = normalizeReasoningEffort(builderEffort);
  const rEffortRank = normalizeReasoningEffort(reviewerEffort);

  // Core Rule: reviewer effort must meet or exceed builder effort
  let requiredEffortRank = bEffortRank;

  // Tier 3+ builder tasks strictly forbid Low effort (must be at least Medium)
  if (builderTier >= 3) {
    requiredEffortRank = Math.max(requiredEffortRank, 2);
  }

  // Risk Escalation: high risk or security-critical tasks escalate reviewer effort to High (rank 3)
  const isSecurityOrHighRisk = taskRisk === 'high' ||
    /\b(security|critical|auth|crypto|vulnerability|audit)\b/i.test(taskCategory || '');
  if (isSecurityOrHighRisk) {
    requiredEffortRank = Math.max(requiredEffortRank, 3);
  }

  // Effort Parity check: reviewer reasoning effort >= builder reasoning effort
  return rEffortRank >= requiredEffortRank;
}

/**
 * Evaluates candidate reviewer against all qualification gates.
 *
 * Qualification Gates:
 * 1. Known model in registry (fail-safe reject if unknown).
 * 1b. Worker model availability (reject if registered but not available on worker).
 * 2. Reviewer capability floor: reviewerTier >= builderTier (in 'review' domain).
 * 3. Model family & provider independence.
 * 4. Reasoning effort parity: reviewerEffort >= builderEffort (and risk escalation).
 */
export function evaluateReviewerQualification({
  builderModel,
  builderTier,
  builderFamily,
  builderPlatform = '',
  builderEffort = 'medium',
  candidateModel,
  candidatePlatform,
  candidateWorker = null,
  reviewerEffort = 'medium',
  taskDifficulty = 'medium',
  taskRisk = 'medium',
  taskCategory = '',
  availableModels = {},
  root = process.cwd()
}) {
  const rTierMeta = getModelTier(candidateModel, 'review', root);
  const bTier = typeof builderTier === 'number' ? builderTier : (getModelTier(builderModel, 'coding', root).tier || 2);

  // Gate 1: Fail-safe rejection of unknown models
  if (!rTierMeta.isKnown) {
    return {
      qualified: false,
      reasonCode: 'UNKNOWN_MODEL',
      reason: `Reviewer model '${candidateModel}' is not registered in capability-tiers.json`,
      reviewerTier: null,
      builderTier: bTier
    };
  }

  const rTier = rTierMeta.tier;

  // Gate 1b: Worker Model Availability Check
  const workerObj = candidateWorker || (typeof candidatePlatform === 'object' ? candidatePlatform : { id: candidatePlatform });
  if (!isModelAvailableOnWorker(workerObj, candidateModel, { availableModels, root })) {
    return {
      qualified: false,
      reasonCode: 'MODEL_UNAVAILABLE',
      reason: `Reviewer model '${candidateModel}' is not available/configured on worker '${workerObj.id || candidatePlatform}'`,
      reviewerTier: rTier,
      builderTier: bTier
    };
  }

  // Gate 2: Capability Floor (reviewerTier >= builderTier)
  if (rTier < bTier) {
    return {
      qualified: false,
      reasonCode: 'SUB_SENIORITY_FLOOR',
      reason: `Reviewer capability (Tier ${rTier} - ${rTierMeta.name}) is below builder seniority floor (Tier ${bTier})`,
      reviewerTier: rTier,
      builderTier: bTier
    };
  }

  // Gate 3: Model Family Independence
  const cPlat = typeof candidatePlatform === 'string' ? candidatePlatform : (candidateWorker?.id || candidateWorker?.adapter || '');
  const indep = isModelFamilyIndependent(builderModel, candidateModel, root, {
    builderPlatform,
    candidatePlatform: cPlat
  });
  if (!indep.independent) {
    return {
      qualified: false,
      reasonCode: 'INSUFFICIENT_INDEPENDENCE',
      reason: `Reviewer lacks model-family independence from builder: ${indep.reason}`,
      reviewerTier: rTier,
      builderTier: bTier,
      independence: indep
    };
  }

  // Gate 4: Reasoning Effort Parity & Sufficiency
  const bEffortNorm = normalizeReasoningEffort(builderEffort);
  const rEffortNorm = normalizeReasoningEffort(reviewerEffort);
  const effortOk = isReasoningEffortSufficient(bTier, builderEffort, reviewerEffort, taskRisk, { taskCategory });
  if (!effortOk) {
    return {
      qualified: false,
      reasonCode: 'INSUFFICIENT_EFFORT',
      reason: `Reviewer reasoning effort '${reviewerEffort}' (level ${rEffortNorm}) is below builder reasoning effort '${builderEffort}' (level ${bEffortNorm}) or required risk level for Tier ${bTier}`,
      reviewerTier: rTier,
      builderTier: bTier
    };
  }

  // All gates passed!
  const isSenior = rTier > bTier;
  return {
    qualified: true,
    isSenior,
    reviewerTier: rTier,
    builderTier: bTier,
    reviewerTierName: rTierMeta.name,
    reason: isSenior
      ? `Senior reviewer (Tier ${rTier} ${rTierMeta.name} reviewing Tier ${bTier} builder)`
      : `Equal capability reviewer (Tier ${rTier} ${rTierMeta.name}) with verified independent model family`,
    independence: indep
  };
}

/**
 * Generate user-facing qualification summary badge text.
 */
export function formatQualificationBadge({ builderTier, reviewerTier, builderFamily, reviewerFamily, reviewerWorker }) {
  if (typeof reviewerTier !== 'number' || typeof builderTier !== 'number') {
    return 'Reviewer qualification pending';
  }
  if (reviewerTier > builderTier) {
    return `✓ Senior reviewer — Tier ${reviewerTier} reviewing Tier ${builderTier} builder`;
  }
  if (reviewerTier === builderTier) {
    const famText = reviewerFamily && builderFamily && reviewerFamily !== builderFamily
      ? ` • Independent family (${reviewerFamily} vs ${builderFamily})`
      : '';
    return `✓ Equal capability (Tier ${reviewerTier})${famText}`;
  }
  return `⚠️ Sub-seniority warning: Tier ${reviewerTier} reviewing Tier ${builderTier} builder`;
}
