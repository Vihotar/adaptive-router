import fs from 'node:fs';
import path from 'node:path';
import { read, json } from './storage.mjs';

// Lightweight, persisted worker health tracking. Deliberately NOT a full
// observability platform: one small JSON file, a rolling count of recent
// outcomes per worker, and coarse states. The goal is only to let
// repeated recent failures temporarily affect routing, and to make that
// visible, without building metrics/alerting/dashboards infrastructure.
//
// States:
//  - healthy: default. No penalty.
//  - degraded: 2+ failures/timeouts in the recent window. Still eligible,
//    but ranked after healthy alternatives when any exist.
//  - cooldown: 3+ failures/timeouts in the recent window, most recent
//    within COOLDOWN_MS. Excluded from candidate selection until the
//    cooldown window elapses or a success is recorded.
//  - unavailable: not a health-derived state here; workers.json's own
//    `enabled` flag already covers deliberate disablement (e.g. Cline
//    being turned off). getWorkerHealthState() never returns this — callers
//    that want the 4-state label for display should combine `enabled` with
//    this module's healthy/degraded/cooldown.

const HEALTH_FILE = '.router/worker-health.json';
const WINDOW_SIZE = 5; // recent outcomes considered per worker
const DEGRADED_THRESHOLD = 2; // failures within the window
const COOLDOWN_THRESHOLD = 3; // failures within the window
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function healthFilePath(root) {
  return path.join(root, HEALTH_FILE);
}

function loadAll(root) {
  try {
    return read(healthFilePath(root));
  } catch {
    return {};
  }
}

function saveAll(root, data) {
  try {
    json(healthFilePath(root), data);
  } catch (e) {
    // Health tracking is best-effort; never let it break task execution.
    console.error('Failed to persist worker health:', e.message);
  }
}

/**
 * Record a build/review call outcome for a worker. Call this once per
 * attempt, from the same place that already knows whether the call
 * succeeded, timed out, or errored — not from deep inside the process
 * spawn, so this stays decoupled from any single adapter.
 * @param {string} root
 * @param {string} workerId
 * @param {'success'|'failure'|'timeout'} outcome
 * @param {string} [reason]
 */
export function recordWorkerOutcome(root, workerId, outcome, reason = '') {
  if (!workerId) return;
  const all = loadAll(root);
  const entry = all[workerId] || { recent: [] };
  entry.recent = Array.isArray(entry.recent) ? entry.recent : [];
  entry.recent.push({ outcome, reason: String(reason || '').slice(0, 200), at: new Date().toISOString() });
  if (entry.recent.length > WINDOW_SIZE) entry.recent = entry.recent.slice(-WINDOW_SIZE);
  entry.lastOutcome = outcome;
  entry.lastAt = new Date().toISOString();
  all[workerId] = entry;
  saveAll(root, all);
}

import { getAntigravityPoolHealth } from './antigravity-quota.mjs';

/**
 * Returns { state: 'healthy'|'degraded'|'cooldown', failureCount,
 * lastOutcome, lastAt, cooldownUntil } for a worker. Never throws; missing
 * or corrupt health data reads as healthy (fail open - a missing/unreadable
 * health file must never itself block routing).
 * @param {string} root
 * @param {string} workerId
 * @param {object} [options]
 */
export function getWorkerHealthState(root, workerId, options = {}) {
  const all = loadAll(root);
  const entry = all[workerId];
  let res;
  if (!entry || !Array.isArray(entry.recent) || entry.recent.length === 0) {
    // sampleSize 0 is the difference between "nothing has gone wrong" and
    // "nothing has been tried yet". Callers that display health need it so
    // they can say the latter honestly instead of implying a clean record.
    res = { state: 'healthy', failureCount: 0, sampleSize: 0, lastOutcome: null, lastAt: null };
  } else {
    const failureCount = entry.recent.filter(r => r.outcome === 'failure' || r.outcome === 'timeout').length;
    const mostRecentFailure = [...entry.recent].reverse().find(r => r.outcome === 'failure' || r.outcome === 'timeout');
    let state = 'healthy';
    let cooldownUntil = null;
    if (failureCount >= COOLDOWN_THRESHOLD && mostRecentFailure) {
      const sinceFailure = Date.now() - new Date(mostRecentFailure.at).getTime();
      if (sinceFailure < COOLDOWN_MS) {
        state = 'cooldown';
        cooldownUntil = new Date(new Date(mostRecentFailure.at).getTime() + COOLDOWN_MS).toISOString();
      } else if (failureCount >= DEGRADED_THRESHOLD) {
        state = 'degraded';
      }
    } else if (failureCount >= DEGRADED_THRESHOLD) {
      state = 'degraded';
    }
    res = { state, failureCount, sampleSize: entry.recent.length, lastOutcome: entry.lastOutcome, lastAt: entry.lastAt, cooldownUntil };
  }

  if (workerId === 'antigravity') {
    const poolHealth = getAntigravityPoolHealth(options?.exePath);
    res.pools = {
      gemini: poolHealth.gemini,
      claude_gpt: poolHealth.claude_gpt
    };
  }

  return res;
}

/**
 * Returns the full health map, keyed by worker id, for display (e.g.
 * /api/status). Includes derived state for every worker present in the
 * health file.
 * @param {string} root
 * @param {object} [options]
 */
export function getAllWorkerHealth(root, options = {}) {
  const all = loadAll(root);
  const result = {};
  for (const workerId of Object.keys(all)) {
    result[workerId] = getWorkerHealthState(root, workerId, options);
  }
  if (!result.antigravity) {
    result.antigravity = getWorkerHealthState(root, 'antigravity', options);
  }
  return result;
}

/**
 * Clear recorded health for a worker (e.g. the CTO re-enables a disabled
 * worker and wants a clean slate rather than an immediate cooldown from
 * stale failures).
 * @param {string} root
 * @param {string} workerId
 */
export function resetWorkerHealth(root, workerId) {
  const all = loadAll(root);
  if (all[workerId]) {
    delete all[workerId];
    saveAll(root, all);
  }
}
