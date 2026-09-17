import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { childEnv, invoke } from './workers.mjs';
import { read, event } from './storage.mjs';
import { validate } from './contracts.mjs';
import { recordWorkerOutcome } from './worker-health.mjs';
import { discoverAntigravityModels } from './smart-router.mjs';
import { buildClineRouteSequence } from './cline-providers.mjs';

export function workerReady(worker, paths) {
  const exe = paths[worker.adapter];
  if (!exe) throw Error('Command not installed or not found');
  if (worker.adapter === 'codex') {
    const r = spawnSync(exe, ['login', 'status'], { env: childEnv(), encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (r.status !== 0 || !/Logged in using ChatGPT/.test(r.stdout + r.stderr)) throw Error('ChatGPT subscription sign-in unavailable');
  } else if (worker.adapter === 'claude') {
    const r = spawnSync(exe, ['auth', 'status'], { env: childEnv(), encoding: 'utf8', windowsHide: true, timeout: 15000 });
    let auth; try { auth = JSON.parse(r.stdout); } catch { throw Error('Claude sign-in could not be verified'); }
    if (r.status !== 0 || !auth.loggedIn || auth.authMethod !== 'claude.ai') throw Error('Claude subscription sign-in unavailable; API billing is not enabled');
  } else if (worker.adapter === 'antigravity') {
    const file = path.join(process.env.USERPROFILE, '.gemini', 'antigravity-cli', 'settings.json');
    if (fs.existsSync(file) && read(file).modelProvider === 'gemini') throw Error('Antigravity API billing mode is not allowed');
    if (!discoverAntigravityModels(exe).length) throw Error('Antigravity sign-in or model availability could not be verified');
  }
}
// Some locally installed CLI builds (a stale/orphaned Codex install has been
// observed doing this on at least one machine) emit a generic "usage limit"
// message for problems that have nothing to do with the account's real
// quota — e.g. a missing internal component ("Code Mode... host executable
// was not found") that prevents the CLI from working at all. Confirmed
// against the account's actual usage page (chatgpt.com/codex/settings/usage)
// showing plenty of quota remaining while the CLI still reported "hit your
// usage limit". Treating every occurrence of that phrase as a real quota
// event was misleading — it should instead be reported as a broken
// installation, since the fix (reinstalling the CLI) is completely
// different from the fix for a real quota outage (waiting for a reset).
const KNOWN_FALSE_QUOTA_PATTERNS = [
  /shell snapshot not supported/i,
  /code mode is unavailable because failed to spawn code-mode host/i,
  /host executable was not found/i
];

export function isLikelyBrokenInstall(error, extra = '') {
  const combined = `${error?.message || ''} ${error?.stderr || ''} ${error?.stdout || ''} ${extra}`;
  return KNOWN_FALSE_QUOTA_PATTERNS.some(rx => rx.test(combined));
}

export function isQuotaError(error, extra = '') {
  if (!error && !extra) return false;
  if (isLikelyBrokenInstall(error, extra)) return false;
  const combined = `${error?.message || ''} ${error?.stderr || ''} ${error?.stdout || ''} ${extra}`.toLowerCase();
  return Boolean(
    error?.isQuota ||
    /\b(quota|usage[- ]limit\w*|rate[- ]limit\w*|too many requests|429|overloaded|overloaded_error|credit balance|insufficient credits?|capacity|resets? at|try again in|cooldown|exhausted)\b/i.test(combined)
  );
}

export function isClineModelFailoverError(error, extra = '') {
  if (!error && !extra) return false;
  if (isLikelyBrokenInstall(error, extra)) return false;
  const combined = `${error?.message || ''} ${error?.stderr || ''} ${error?.stdout || ''} ${extra}`.toLowerCase();
  return Boolean(
    error?.isQuota ||
    error?.isModelUnavailable ||
    /\b(429|500|503|quota|usage[- ]limit\w*|rate[- ]limit\w*|too many requests|resource[- ]exhausted|models? exhausted|exhausted|overloaded|capacity|cooldown|model[- ]?(?:not[- ]?found|unavailable|not supported|does not exist)|not[-_\s]+found|temporarily unavailable|try again in)\b/i.test(combined)
  );
}

import { selectModelAndEffort, rankCandidatesForRole } from './smart-router.mjs';

export function candidates(config, role, excluded = [], failed = new Set(), preferredFamily = null, difficulty = 'medium', claudeReserve = (config?.claudeReserve !== false), allowClaude = false, { builderModel = '', builderTier = null, builderFamily = '', builderEffort = 'medium', builderPlatform = '', taskRisk = 'medium', taskCategory = '', availableModels = {}, root = process.cwd() } = {}) {
  return rankCandidatesForRole(config, role, {
    excluded,
    failed,
    preferredFamily,
    difficulty,
    claudeReserve,
    allowClaude,
    builderModel,
    builderTier,
    builderFamily,
    builderEffort,
    builderPlatform,
    taskRisk,
    taskCategory,
    availableModels,
    root
  });
}
export async function withFailover({
  config,
  role,
  excluded = [],
  failed,
  paths,
  root,
  dir,
  stage,
  schema,
  prompt,
  call = invoke,
  ready = workerReady,
  log = console.log,
  difficulty = 'medium',
  revision = 0,
  feedback = null,
  availableModels = {},
  preferredFamily = null,
  platformReason = '',
  claudeReserve = (config?.claudeReserve !== false),
  allowClaude = false,
  confirmClaudeUse = null,
  builderModel = '',
  builderProvider = '',
  builderTier = null,
  builderFamily = '',
  builderEffort = 'medium',
  builderPlatform = '',
  taskRisk = 'medium',
  taskCategory = '',
  projectRoot = null,
  onWorkerEvent = null,
  onTokenUsage = null,
  signal = null,
  // Explicit provider/model pin for the Cline runtime. Both are optional and
  // validated against the approved registry; they exist so a caller (or a
  // live verification run) can say "use NVIDIA NIM" deliberately instead of
  // relying on failover order.
  clineProvider = null,
  clineModel = null
}) {
  let lastWorkerError = null;
  let lastFailedWorker = null;
  let lastFailedModel = null;
  let lastInvocationUsage = null;
  const handleUsage = (u, attemptWorker, attemptModel, extra = {}) => {
    if (extra.success !== false) lastInvocationUsage = u;
    if (onTokenUsage) {
      try {
        onTokenUsage({
          role,
          stage,
          worker: attemptWorker,
          model: attemptModel,
          usage: u,
          success: extra.success !== false,
          provider: extra.provider || null,
          providerLabel: extra.providerLabel || null,
          latencyMs: typeof extra.latencyMs === 'number' ? extra.latencyMs : null
        });
      } catch {}
    }
  };
  for (const worker of candidates(config, role, excluded, failed, preferredFamily, difficulty, claudeReserve, allowClaude, { builderModel, builderTier, builderFamily, builderEffort, builderPlatform, taskRisk, taskCategory, availableModels, root })) {
    if (signal?.aborted) {
      throw Error('TASK_ABORTED_BY_USER');
    }
    if (dir) {
      try {
        const taskDisk = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
        if (taskDisk.status === 'paused_by_user') {
          throw Error('TASK_PAUSED_BY_USER');
        }
        if (taskDisk.status === 'cancelled_by_user') {
          throw Error('TASK_ABORTED_BY_USER');
        }
      } catch (e) {
        if (e.message === 'TASK_PAUSED_BY_USER' || e.message === 'TASK_ABORTED_BY_USER') throw e;
      }
    }
    if ((worker.id === 'claude-code' || worker.adapter === 'claude') && claudeReserve && !allowClaude) {
      if (confirmClaudeUse) {
        const approved = await confirmClaudeUse('Claude Code would be useful for this task. Use Claude quota? (Yes / No)');
        if (!approved) {
          log('Claude Reserve Mode is ON. Claude quota declined by user; selecting next-best suitable worker.');
          event(dir, 'claude_quota_declined', { stage, role });
          onWorkerEvent?.({ platform: 'router', worker: worker.id, role, eventType: 'routing', title: 'Claude Reserve Mode active', detail: 'Claude quota declined; evaluating next worker' });
          failed.add(worker.id);
          continue;
        }
        allowClaude = true;
        event(dir, 'claude_quota_authorized', { stage, role });
        onWorkerEvent?.({ platform: 'router', worker: worker.id, role, eventType: 'routing', title: 'Claude quota authorized', detail: 'Proceeding with Claude Code' });
      } else {
        log('Claude Reserve Mode is ON. Claude quota preserved for Cowork; skipping Claude Code.');
        failed.add(worker.id);
        continue;
      }
    }
    const isPreferred = preferredFamily && (worker.id === preferredFamily || worker.adapter === preferredFamily);
    const workerPlatformReason = isPreferred ? platformReason : (preferredFamily ? `Failover replacement for ${preferredFamily}` : '');
    const selection = selectModelAndEffort({
      platform: worker.id,
      role,
      difficulty,
      revision,
      feedback,
      availableModels,
      platformReason: workerPlatformReason,
      builderModel,
      builderProvider,
      builderTier,
      builderEffort,
      taskRisk,
      root
    });
    try {
      ready(worker, paths);
      log(`${worker.id} (${selection.model}, effort: ${selection.effort}): ${stage}`);
      event(dir, 'worker_started', {
        worker: worker.id,
        stage,
        model: selection.model,
        effort: selection.effort,
        tier: selection.tier,
        tierNumber: selection.tierNumber,
        tierName: selection.tierName,
        reason: selection.reason
      });
      onWorkerEvent?.({
        platform: worker.adapter || 'router',
        worker: worker.id,
        model: selection.model,
        effort: selection.effort,
        role,
        eventType: 'worker_start',
        title: `Worker selected: ${(worker.name || worker.id).toUpperCase()}`,
        detail: selection.reason || `Model: ${selection.model} [${selection.effort}]`
      });
      let result;
      let usedModel = selection.model;
      let usedRoute = null;
      if (worker.adapter === 'cline') {
        // Cline is the runtime; the real identity of each attempt is the
        // direct provider behind it. The sequence is deterministic and comes
        // entirely from the approved registry — failover can never reach a
        // provider or model that is not on that list.
        const routes = buildClineRouteSequence({
          primaryModel: selection.model,
          fallbackModels: selection.fallbackModels,
          providerOrder: worker.providerOrder,
          pinnedProvider: clineProvider || worker.provider || null,
          pinnedModel: clineModel || worker.model || null
        });

        let modelSuccess = false;
        let lastModelError = null;

        for (let i = 0; i < routes.length; i++) {
          const route = routes[i];
          usedModel = route.model;
          usedRoute = route;
          const attemptStartedAt = Date.now();
          try {
            if (i > 0) {
              const previous = routes[i - 1];
              log(`${previous.label} (${previous.model}) failed (${lastModelError?.message || 'error'}). Retrying with ${route.label} (${route.model}).`);
              onWorkerEvent?.({
                platform: 'cline',
                worker: 'cline',
                model: route.model,
                role,
                eventType: 'retry',
                title: `Retrying with ${route.label} (${route.model})`,
                detail: lastModelError?.message || `Fallback from ${previous.label} (${previous.model})`,
                status: 'info',
                metadata: { provider: route.provider, providerLabel: route.label, previousProvider: previous.provider }
              });
            }
            result = await call(worker, {
              root,
              dir: path.join(dir, `${stage}-${worker.id}${i > 0 ? '-' + route.provider + '-' + route.model.replace(/[\\/:]/g, '_') : ''}`),
              schema,
              prompt,
              timeout: config.workerTimeoutSeconds * 1000,
              paths,
              model: route.model,
              provider: route.clineProvider,
              providerId: route.provider,
              providerLabel: route.label,
              effort: selection.effort,
              projectRoot,
              onWorkerEvent,
              onUsage: (u) => handleUsage(u, worker.id, route.model, {
                provider: route.provider,
                providerLabel: route.label,
                latencyMs: Date.now() - attemptStartedAt,
                success: true
              }),
              signal
            });
            modelSuccess = true;
            recordWorkerOutcome(root, route.healthId, 'success');
            break;
          } catch (modelErr) {
            lastModelError = modelErr;
            if (signal?.aborted || modelErr.message?.includes('aborted') || modelErr.message?.includes('TASK_STOPPED')) {
              throw modelErr;
            }
            // Per-route health telemetry: a provider/model pair that keeps
            // failing is tracked on its own, separately from "Cline". Quota
            // exhaustion stays excluded from failure counts here for the same
            // reason it is at worker level — it is normal usage, not a fault.
            const routeQuota = isQuotaError(modelErr);
            const routeTimeout = /timed out/i.test(modelErr.message || '');
            recordWorkerOutcome(root, route.healthId, routeQuota ? 'quota' : (routeTimeout ? 'timeout' : 'failure'), modelErr.message);
            handleUsage(modelErr.usage || { inputTokens: null, outputTokens: null, totalTokens: null, accuracy: 'Unavailable' }, worker.id, route.model, {
              provider: route.provider,
              providerLabel: route.label,
              latencyMs: Date.now() - attemptStartedAt,
              success: false
            });
            onWorkerEvent?.({
              platform: 'cline',
              worker: 'cline',
              model: route.model,
              role,
              eventType: 'failover',
              title: `${route.label} (${route.model}) failed`,
              detail: modelErr.message || 'Provider attempt failed',
              status: 'failed',
              metadata: { provider: route.provider, providerLabel: route.label, isQuota: routeQuota }
            });
            if (isLikelyBrokenInstall(modelErr)) {
              throw modelErr;
            }
            const isRetryable = isClineModelFailoverError(modelErr) || isQuotaError(modelErr);
            const hasNextRoute = i + 1 < routes.length;
            if (!isRetryable || !hasNextRoute) {
              throw modelErr;
            }
          }
        }
        if (!modelSuccess && lastModelError) {
          throw lastModelError;
        }
      } else {
        result = await call(worker, {
          root,
          dir: path.join(dir, `${stage}-${worker.id}`),
          schema,
          prompt,
          timeout: config.workerTimeoutSeconds * 1000,
          paths,
          model: selection.model,
          effort: selection.effort,
          projectRoot,
          onWorkerEvent,
          onUsage: (u) => handleUsage(u, worker.id, selection.model),
          signal
        });
      }
      validate(result, schema);
      recordWorkerOutcome(root, worker.id, 'success');
      event(dir, 'worker_completed', {
        worker: worker.id,
        stage,
        model: usedModel,
        effort: selection.effort,
        tier: selection.tier,
        provider: usedRoute?.provider,
        providerLabel: usedRoute?.label
      });
      onWorkerEvent?.({
        platform: worker.adapter || 'router',
        worker: worker.id,
        model: usedModel,
        effort: selection.effort,
        role,
        eventType: 'progress',
        title: `Worker completed: ${(usedRoute ? usedRoute.label : (worker.name || worker.id)).toUpperCase()}`,
        detail: `Generated output for stage ${stage}`,
        status: 'success'
      });
      return {
        result,
        worker: worker.id,
        model: usedModel,
        effort: selection.effort,
        tier: selection.tier,
        tierNumber: selection.tierNumber,
        tierName: selection.tierName,
        reason: selection.reason,
        usage: lastInvocationUsage,
        // Real provider identity for this invocation (Cline runtime only);
        // undefined for workers that are their own provider.
        provider: usedRoute?.provider,
        providerLabel: usedRoute?.label,
        runtime: usedRoute ? 'cline' : undefined
      };
    } catch (error) {
      if (signal?.aborted || error.message === 'TASK_STOPPED' || error.message === 'TASK_ABORTED_BY_USER' || error.message === 'TASK_PAUSED_BY_USER' || error.message?.includes('aborted by user')) {
        throw error;
      }
      failed.add(worker.id);
      lastWorkerError = error;
      lastFailedWorker = worker.id;
      lastFailedModel = selection.model;
      const quota = isQuotaError(error);
      const brokenInstall = isLikelyBrokenInstall(error);
      // Quota exhaustion is expected/normal usage, not a sign the worker
      // itself is unreliable — don't let it count toward degraded/cooldown
      // health. Timeouts and genuine errors (including broken installs) do.
      if (!quota) {
        const isTimeout = /timed out/i.test(error.message || '');
        recordWorkerOutcome(root, worker.id, isTimeout ? 'timeout' : 'failure', error.message);
      }
      event(dir, 'worker_unavailable', {
        worker: worker.id,
        stage,
        model: selection.model,
        effort: selection.effort,
        tier: selection.tier,
        error: error.message,
        isQuota: quota,
        isBrokenInstall: brokenInstall
      });
      onWorkerEvent?.({
        platform: 'router',
        worker: worker.id,
        role,
        eventType: 'failover',
        title: brokenInstall
          ? `${worker.id} installation appears broken (not a quota issue)`
          : (quota ? `Quota limit reached on ${worker.id}` : `Worker ${worker.id} unavailable`),
        detail: brokenInstall
          ? `The local ${worker.id} program reported an internal error unrelated to account usage: ${error.message}`
          : (error.message || 'Transitioning to next available candidate worker'),
        status: 'failed',
        metadata: { isQuota: quota, isBrokenInstall: brokenInstall }
      });
      if (brokenInstall) {
        log(`${worker.id} appears to have a broken local installation (not a quota issue): ${error.message}`);
      } else if (quota) {
        log(`${worker.id} reached quota or usage limit. Immediately trying the next available worker.`);
      } else {
        log(`${worker.id} unavailable or unsuccessful; trying the next eligible worker.`);
      }
    }
  }
  const exhaustionMsg = lastWorkerError?.message
    ? `No available independent ${role} worker (${lastWorkerError.message}). Work is saved; retry after a worker becomes available.`
    : `No available independent ${role} worker. Work is saved; retry after a worker becomes available.`;
  const exhaustionErr = Error(exhaustionMsg);
  exhaustionErr.lastWorker = lastFailedWorker;
  exhaustionErr.lastModel = lastFailedModel;
  exhaustionErr.lastError = lastWorkerError;
  throw exhaustionErr;
}
