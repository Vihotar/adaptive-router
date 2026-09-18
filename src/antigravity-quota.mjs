import { spawnSync } from 'node:child_process';

const CACHE_TTL_MS = 60_000;

export const ANTIGRAVITY_POOLS = {
  GEMINI: 'gemini',
  CLAUDE_GPT: 'claude_gpt'
};

export const POOL_MODELS = {
  [ANTIGRAVITY_POOLS.GEMINI]: [
    'gemini-3.8-flash-low',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-high',
    'gemini-3.7-flash-low',
    'gemini-3.7-flash-medium',
    'gemini-3.7-flash-high',
    'gemini-3.6-flash-low',
    'gemini-3.6-flash-medium',
    'gemini-3.6-flash-high',
    'gemini-3.1-pro-low',
    'gemini-3.1-pro-high'
  ],
  [ANTIGRAVITY_POOLS.CLAUDE_GPT]: [
    'claude-sonnet-4-6',
    'claude-opus-4-6-thinking',
    'gpt-oss-120b-medium'
  ]
};

export function getAntigravityModelPool(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  const norm = modelId.trim().toLowerCase();
  if (POOL_MODELS[ANTIGRAVITY_POOLS.GEMINI].includes(norm) || norm.startsWith('gemini-')) {
    return ANTIGRAVITY_POOLS.GEMINI;
  }
  if (POOL_MODELS[ANTIGRAVITY_POOLS.CLAUDE_GPT].includes(norm)) {
    return ANTIGRAVITY_POOLS.CLAUDE_GPT;
  }
  return null;
}

let quotaCache = {
  timestamp: 0,
  data: null,
  exePath: null
};

const reactiveExhaustion = {
  [ANTIGRAVITY_POOLS.GEMINI]: { exhausted: false, resetTime: null },
  [ANTIGRAVITY_POOLS.CLAUDE_GPT]: { exhausted: false, resetTime: null }
};

export function clearAntigravityQuotaCache() {
  quotaCache = { timestamp: 0, data: null, exePath: null };
  reactiveExhaustion[ANTIGRAVITY_POOLS.GEMINI] = { exhausted: false, resetTime: null };
  reactiveExhaustion[ANTIGRAVITY_POOLS.CLAUDE_GPT] = { exhausted: false, resetTime: null };
}

export function markAntigravityPoolExhausted(poolId, resetTime = null) {
  if (reactiveExhaustion[poolId]) {
    reactiveExhaustion[poolId] = {
      exhausted: true,
      resetTime: resetTime || new Date(Date.now() + 5 * 3600_000).toISOString()
    };
  }
}

export function parseQuotaOutput(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }

  const groups = parsed?.command?.data?.groups || parsed?.response?.groups || [];
  if (!Array.isArray(groups)) return null;

  let geminiGroup = groups.find(g => /gemini/i.test(g.name || g.displayName || ''));
  let claudeGptGroup = groups.find(g => /claude|gpt|3p/i.test(g.name || g.displayName || ''));

  const extractBucket = (group, windowType, fallbackId) => {
    if (!group || !Array.isArray(group.buckets)) return null;
    const bucket = group.buckets.find(b =>
      b.window === windowType ||
      b.id === fallbackId ||
      new RegExp(windowType, 'i').test(b.id || b.bucketId || '')
    );
    if (!bucket) return null;
    return {
      id: bucket.id || bucket.bucketId || fallbackId,
      remainingFraction: typeof bucket.remaining_fraction === 'number'
        ? bucket.remaining_fraction
        : (typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : 1.0),
      resetTime: bucket.reset_time || bucket.resetTime || null
    };
  };

  const g5h = extractBucket(geminiGroup, '5h', 'gemini-5h');
  const gWeekly = extractBucket(geminiGroup, 'weekly', 'gemini-weekly');
  const c5h = extractBucket(claudeGptGroup, '5h', '3p-5h');
  const cWeekly = extractBucket(claudeGptGroup, 'weekly', '3p-weekly');

  return {
    gemini: {
      remaining5h: g5h ? g5h.remainingFraction : 1.0,
      remainingWeekly: gWeekly ? gWeekly.remainingFraction : 1.0,
      reset5h: g5h ? g5h.resetTime : null,
      resetWeekly: gWeekly ? gWeekly.resetTime : null
    },
    claude_gpt: {
      remaining5h: c5h ? c5h.remainingFraction : 1.0,
      remainingWeekly: cWeekly ? cWeekly.remainingFraction : 1.0,
      reset5h: c5h ? c5h.resetTime : null,
      resetWeekly: cWeekly ? cWeekly.resetTime : null
    }
  };
}

export function readAntigravityQuota(exePath, options = {}) {
  const now = Date.now();
  const { forceRefresh = false, mockOutput = null } = options;

  if (mockOutput) {
    const parsed = parseQuotaOutput(mockOutput);
    if (parsed) {
      quotaCache = {
        timestamp: now,
        data: parsed,
        exePath: exePath || 'mock'
      };
      return parsed;
    }
  }

  if (!forceRefresh && quotaCache.data && (now - quotaCache.timestamp < CACHE_TTL_MS) && (!exePath || quotaCache.exePath === exePath)) {
    return quotaCache.data;
  }

  if (!exePath) {
    if (quotaCache.data) return quotaCache.data;
    return {
      gemini: { remaining5h: 1.0, remainingWeekly: 1.0, reset5h: null, resetWeekly: null },
      claude_gpt: { remaining5h: 1.0, remainingWeekly: 1.0, reset5h: null, resetWeekly: null }
    };
  }

  try {
    const res = spawnSync(exePath, ['--output-format', 'json', '-p', '/quota'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    });
    if (res.status === 0 && res.stdout) {
      const parsed = parseQuotaOutput(res.stdout);
      if (parsed) {
        quotaCache = {
          timestamp: now,
          data: parsed,
          exePath
        };
        return parsed;
      }
    }
  } catch {}

  if (quotaCache.data) return quotaCache.data;
  return {
    gemini: { remaining5h: 1.0, remainingWeekly: 1.0, reset5h: null, resetWeekly: null },
    claude_gpt: { remaining5h: 1.0, remainingWeekly: 1.0, reset5h: null, resetWeekly: null }
  };
}

function evaluateHealth(poolData, reactive) {
  const now = Date.now();
  if (reactive?.exhausted) {
    if (reactive.resetTime) {
      const resetDate = new Date(reactive.resetTime).getTime();
      if (!isNaN(resetDate) && now >= resetDate) {
        reactive.exhausted = false;
        reactive.resetTime = null;
      } else {
        return { status: 'exhausted', healthy: false, available: false };
      }
    } else {
      return { status: 'exhausted', healthy: false, available: false };
    }
  }

  const { remaining5h, remainingWeekly } = poolData;
  if (remaining5h <= 0.01 || remainingWeekly <= 0.01) {
    return { status: 'exhausted', healthy: false, available: false };
  }
  if (remaining5h <= 0.10 || remainingWeekly <= 0.05) {
    return { status: 'low', healthy: false, available: true };
  }
  return { status: 'healthy', healthy: true, available: true };
}

export function getAntigravityPoolHealth(exePath, options = {}) {
  const quota = readAntigravityQuota(exePath, options);
  const gemHealth = evaluateHealth(quota.gemini, reactiveExhaustion[ANTIGRAVITY_POOLS.GEMINI]);
  const cHealth = evaluateHealth(quota.claude_gpt, reactiveExhaustion[ANTIGRAVITY_POOLS.CLAUDE_GPT]);

  return {
    gemini: {
      ...quota.gemini,
      ...gemHealth
    },
    claude_gpt: {
      ...quota.claude_gpt,
      ...cHealth
    },
    overallHealthy: gemHealth.healthy || cHealth.healthy,
    overallAvailable: gemHealth.available || cHealth.available
  };
}
