/**
 * token-tracker.mjs — Real Task-Level Token Usage Tracker for Adaptive Router
 *
 * Implements:
 * 1. Canonical task.tokenUsage schema for Builder AI & Reviewer AI.
 * 2. Strict accuracy labelling: Exact | Estimated | Unavailable (and Partial for combined).
 * 3. Multi-attempt and multi-stage accumulation without double-counting.
 * 4. Technical log formatting for events.jsonl.
 */

import { randomUUID } from 'node:crypto';

export function createEmptyTokenUsage() {
  return {
    builder: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      accuracy: 'Unavailable',
      invocations: 0,
      platform: null,
      model: null
    },
    reviewer: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      accuracy: 'Unavailable',
      invocations: 0,
      platform: null,
      model: null
    },
    totalTokens: null,
    totalAccuracy: 'Unavailable',
    summaryText: 'Unavailable',
    invocations: [],
    // Every provider attempt, successful or not, with the provider/model that
    // actually served it, its latency and its outcome. Failed attempts are
    // kept here rather than in `invocations` so they never distort the task's
    // token totals or accuracy labelling, while still being auditable.
    attempts: []
  };
}

export function normalizeUsage(raw, platform) {
  if (!raw) {
    return {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      accuracy: 'Unavailable'
    };
  }

  if (raw.accuracy && (typeof raw.totalTokens === 'number' || raw.totalTokens === null)) {
    return raw;
  }

  let inputTokens = null;
  let outputTokens = null;
  let totalTokens = null;

  if (platform === 'codex') {
    const rawIn = typeof raw.input_tokens === 'number' ? raw.input_tokens : raw.inputTokens;
    const rawOut = typeof raw.output_tokens === 'number' ? raw.output_tokens : raw.outputTokens;
    const rawCached = raw.cached_input_tokens || raw.cachedInputTokens || 0;
    const rawReasoning = raw.reasoning_output_tokens || raw.reasoningOutputTokens || 0;
    if (typeof rawIn === 'number') {
      inputTokens = rawIn + rawCached;
      outputTokens = (rawOut || 0) + rawReasoning;
      totalTokens = inputTokens + outputTokens;
    }
  } else if (platform === 'antigravity' || platform === 'agy') {
    const rawIn = typeof raw.input_tokens === 'number' ? raw.input_tokens : raw.inputTokens;
    const rawOut = typeof raw.output_tokens === 'number' ? raw.output_tokens : raw.outputTokens;
    const rawTot = typeof raw.total_tokens === 'number' ? raw.total_tokens : raw.totalTokens;
    const rawCache = raw.cache_read_tokens || raw.cacheReadTokens || 0;
    if (typeof rawIn === 'number' && (rawIn > 0 || rawOut > 0 || rawTot > 0)) {
      inputTokens = rawIn + rawCache;
      outputTokens = rawOut || 0;
      totalTokens = rawTot || (inputTokens + outputTokens);
    }
  } else if (platform === 'claude') {
    if (typeof raw.input_tokens === 'number') {
      inputTokens = raw.input_tokens + (raw.cache_creation_input_tokens || 0) + (raw.cache_read_input_tokens || 0);
      outputTokens = raw.output_tokens || 0;
      totalTokens = inputTokens + outputTokens;
    }
  } else if (platform === 'cline') {
    const inp = typeof raw.inputTokens === 'number' ? raw.inputTokens : (typeof raw.input_tokens === 'number' ? raw.input_tokens : null);
    const out = typeof raw.outputTokens === 'number' ? raw.outputTokens : (typeof raw.output_tokens === 'number' ? raw.output_tokens : null);
    const cache = raw.cacheReadTokens || raw.cache_read_tokens || 0;
    if (typeof inp === 'number' && (inp > 0 || out > 0)) {
      inputTokens = inp + cache;
      outputTokens = out || 0;
      totalTokens = inputTokens + outputTokens;
    }
  }

  if (typeof totalTokens === 'number' && totalTokens > 0) {
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      accuracy: 'Exact'
    };
  }

  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    accuracy: 'Unavailable'
  };
}

/**
 * Append one provider attempt (success or failure) to the audit trail. This is
 * deliberately separate from accumulateInvocation: it records what happened,
 * not what the task consumed.
 */
export function recordProviderAttempt(tokenUsage = createEmptyTokenUsage(), {
  id = `att_${randomUUID().slice(0, 8)}`,
  role = 'builder',
  stage = '',
  worker = '',
  provider = null,
  providerLabel = null,
  model = '',
  usage = null,
  latencyMs = null,
  success = true
} = {}) {
  const current = tokenUsage || createEmptyTokenUsage();
  current.attempts = Array.isArray(current.attempts) ? current.attempts : [];
  const u = usage && usage.accuracy ? usage : normalizeUsage(usage, worker);
  current.attempts.push({
    id,
    role: (role === 'build' || role === 'builder') ? 'builder' : 'reviewer',
    stage,
    worker,
    provider: provider || u.provider || null,
    providerLabel: providerLabel || u.providerLabel || null,
    model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
    accuracy: u.accuracy,
    latencyMs: typeof latencyMs === 'number' ? latencyMs : null,
    success: success !== false,
    timestamp: new Date().toISOString()
  });
  return current;
}

export function accumulateInvocation(tokenUsage = createEmptyTokenUsage(), {
  id = `inv_${randomUUID().slice(0, 8)}`,
  role = 'builder',
  stage = '',
  worker = '',
  provider = null,
  providerLabel = null,
  model = '',
  latencyMs = null,
  usage = null
}) {
  const normRole = (role === 'build' || role === 'builder') ? 'builder' : 'reviewer';
  const current = tokenUsage || createEmptyTokenUsage();
  current.invocations = current.invocations || [];
  current.builder = current.builder || { inputTokens: null, outputTokens: null, totalTokens: null, accuracy: 'Unavailable', invocations: 0 };
  current.reviewer = current.reviewer || { inputTokens: null, outputTokens: null, totalTokens: null, accuracy: 'Unavailable', invocations: 0 };

  // Guard against double counting by unique invocation id
  if (current.invocations.some(i => i.id === id)) {
    return current;
  }

  const u = usage && usage.accuracy ? usage : normalizeUsage(usage, worker);
  const record = {
    id,
    role: normRole,
    stage,
    worker,
    // The real provider behind this invocation (Gemini / NVIDIA NIM /
    // OpenRouter when the Cline runtime was used); null when the worker is
    // its own provider.
    provider: provider || u.provider || null,
    providerLabel: providerLabel || u.providerLabel || null,
    model,
    latencyMs: typeof latencyMs === 'number' ? latencyMs : null,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
    accuracy: u.accuracy,
    timestamp: new Date().toISOString()
  };
  current.invocations.push(record);

  const roleStats = current[normRole];
  roleStats.platform = worker || roleStats.platform;
  roleStats.provider = record.provider || roleStats.provider || null;
  roleStats.providerLabel = record.providerLabel || roleStats.providerLabel || null;
  roleStats.model = model || roleStats.model;
  roleStats.invocations = (roleStats.invocations || 0) + 1;

  if (u.accuracy === 'Exact' || u.accuracy === 'Estimated') {
    if (roleStats.totalTokens === null) {
      roleStats.inputTokens = u.inputTokens || 0;
      roleStats.outputTokens = u.outputTokens || 0;
      roleStats.totalTokens = u.totalTokens || 0;
      roleStats.accuracy = u.accuracy;
    } else {
      roleStats.inputTokens = (roleStats.inputTokens || 0) + (u.inputTokens || 0);
      roleStats.outputTokens = (roleStats.outputTokens || 0) + (u.outputTokens || 0);
      roleStats.totalTokens = (roleStats.totalTokens || 0) + (u.totalTokens || 0);
      if (u.accuracy === 'Estimated') {
        roleStats.accuracy = 'Estimated';
      }
    }
  } else {
    // Invocation usage was Unavailable
    if (roleStats.accuracy === 'Exact') {
      roleStats.accuracy = 'Partial';
    }
  }

  // Calculate Combined Task Total
  const b = current.builder;
  const r = current.reviewer;

  const bHasTokens = typeof b.totalTokens === 'number' && b.totalTokens > 0;
  const rHasTokens = typeof r.totalTokens === 'number' && r.totalTokens > 0;

  if (b.accuracy === 'Exact' && r.accuracy === 'Exact') {
    current.totalTokens = (b.totalTokens || 0) + (r.totalTokens || 0);
    current.totalAccuracy = 'Exact';
    current.summaryText = `${current.totalTokens.toLocaleString()} tokens [Exact]`;
  } else if (bHasTokens && rHasTokens && (b.accuracy === 'Estimated' || r.accuracy === 'Estimated')) {
    current.totalTokens = (b.totalTokens || 0) + (r.totalTokens || 0);
    current.totalAccuracy = 'Estimated';
    current.summaryText = `${current.totalTokens.toLocaleString()} tokens [Estimated]`;
  } else if (bHasTokens && !rHasTokens) {
    current.totalTokens = b.totalTokens;
    current.totalAccuracy = 'Partial';
    const bAcc = b.accuracy.toLowerCase();
    current.summaryText = `Task Total: Partial — Builder ${bAcc} (${b.totalTokens.toLocaleString()}), Reviewer unavailable`;
  } else if (!bHasTokens && rHasTokens) {
    current.totalTokens = r.totalTokens;
    current.totalAccuracy = 'Partial';
    const rAcc = r.accuracy.toLowerCase();
    current.summaryText = `Task Total: Partial — Builder unavailable, Reviewer ${rAcc} (${r.totalTokens.toLocaleString()})`;
  } else if (bHasTokens && rHasTokens) {
    current.totalTokens = (b.totalTokens || 0) + (r.totalTokens || 0);
    current.totalAccuracy = 'Partial';
    current.summaryText = `Task Total: Partial — ${current.totalTokens.toLocaleString()} tokens`;
  } else {
    current.totalTokens = null;
    current.totalAccuracy = 'Unavailable';
    current.summaryText = 'Unavailable';
  }

  return current;
}

export function formatTokenUsageLog({ role, worker, model, usage, providerLabel = null }) {
  const u = usage && usage.accuracy ? usage : normalizeUsage(usage, worker);
  const roleName = (role === 'build' || role === 'builder') ? 'Builder' : 'Reviewer';
  // Report the provider that actually served the request when one is known,
  // so token accounting reads as "NVIDIA NIM" rather than a generic "Cline".
  const label = providerLabel || u.providerLabel;
  const workerDisplay = label || (worker ? (worker.charAt(0).toUpperCase() + worker.slice(1)) : 'Unknown');
  const modelDisplay = model || 'default';
  const totalDisplay = u?.totalTokens != null ? u.totalTokens.toLocaleString() : 'unknown';
  const inDisplay = u?.inputTokens != null ? u.inputTokens.toLocaleString() : 'unavailable';
  const outDisplay = u?.outputTokens != null ? u.outputTokens.toLocaleString() : 'unavailable';
  const acc = u?.accuracy || 'Unavailable';

  return `[TOKEN_USAGE] ${roleName} (${workerDisplay} — ${modelDisplay}) consumed ${totalDisplay} tokens (input: ${inDisplay}, output: ${outDisplay}) [${acc}]`;
}
