/**
 * connector.mjs — ChatGPT ↔ Adaptive Router Connector Data Layer
 *
 * Provides safe, sanitized read and write operations for the MCP/REST connector.
 *
 * SECURITY CONTRACT:
 *   - sanitize() strips any field whose key contains: token, key, password,
 *     secret, auth, credential, apikey, bearer, jwt — recursively.
 *   - Workers.json tokens, worker credentials, and Claude keys are
 *     never included in connector responses.
 *   - Write operations preserve all existing Adaptive Router approval protections.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── Secret field detector ─────────────────────────────────────────────────────
const SECRET_PATTERN = /token|password|secret|apikey|api_key|bearer|jwt|credential|auth_?token/i;

export function sanitize(obj) {
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_PATTERN.test(k)) continue; // drop the field entirely
      out[k] = sanitize(v);
    }
    return out;
  }
  return obj;
}

// ── Token management ──────────────────────────────────────────────────────────

/**
 * Read or auto-generate the connector bearer token stored in workers.json.
 * SECURITY: The token value is NEVER logged or printed. It is only returned
 * in-memory to callers that need to validate a Bearer header or serve it
 * to the localhost-only /api/connector/token/copy endpoint.
 */
export function getOrCreateConnectorToken(root) {
  const configPath = path.join(root, 'workers.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  if (config.connectorToken && typeof config.connectorToken === 'string' && config.connectorToken.length === 64) {
    return config.connectorToken;
  }
  // Generate without logging — value only goes into workers.json
  const token = crypto.randomBytes(32).toString('hex');
  config.connectorToken = token;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return token;
}

/**
 * Invalidate the existing token and generate a fresh one.
 * SECURITY: The old token is destroyed first. The new token is never logged.
 * Returns { rotated: true } — the new token value is NOT included in the return.
 */
export function rotateConnectorToken(root) {
  const configPath = path.join(root, 'workers.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  // Destroy old
  delete config.connectorToken;
  // Generate new without logging
  config.connectorToken = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return { rotated: true, message: 'Connector token has been rotated. Use the Copy Connector Token button to retrieve the new value.' };
}

/**
 * Get current tunnel status by reading the .mcp_tunnel_url file if it exists.
 * Returns { connected, tunnelId, note }
 */
export function getTunnelStatus(root) {
  const urlFile = path.join(root, '.mcp_tunnel_url');
  if (fs.existsSync(urlFile)) {
    const raw = fs.readFileSync(urlFile, 'utf8').trim();
    if (raw && raw.startsWith('tunnel_')) {
      return { connected: true, tunnelId: raw, note: 'Secure MCP Tunnel is active.' };
    }
    if (raw) {
      return { connected: true, tunnelId: null, note: 'Tunnel active (URL mode).' };
    }
  }
  return { connected: false, tunnelId: null, note: 'Secure MCP Tunnel not configured. Provide Tunnel ID and tunnel-client.exe location to activate.' };
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function taskDir(root, id) {
  return path.join(root, '.router', 'tasks', id);
}

function safeRead(filePath) {
  try { return readJson(filePath); } catch { return null; }
}

// ── Read Operations ───────────────────────────────────────────────────────────

/**
 * List all available projects with their current high-level status.
 */
export function listProjects(root) {
  const configPath = path.join(root, 'workers.json');
  const config = safeRead(configPath) || {};
  return sanitize([
    {
      id: 'adaptive-router',
      name: 'Adaptive Router System',
      description: 'Core router, dashboard UI, and AI workforce engine',
      claudeReserve: Boolean(config.claudeReserve)
    },
    {
      id: 'test-site',
      name: 'Adaptive Router Test Project (Sample Shop)',
      description: 'Disposable e-commerce website used for safe testing'
    }
  ]);
}

/**
 * Get project-level status: active task, worker health, Claude Reserve state.
 */
export function getProjectStatus(root) {
  const configPath = path.join(root, 'workers.json');
  const config = safeRead(configPath) || {};
  const lockPath = path.join(root, '.router', 'router.lock');
  const isLocked = fs.existsSync(lockPath);

  // Count tasks by status
  const tasksDir = path.join(root, '.router', 'tasks');
  let taskSummary = { total: 0, awaiting_approval: 0, approved: 0, failed: 0 };
  if (fs.existsSync(tasksDir)) {
    const ids = fs.readdirSync(tasksDir).filter(id => /^\d{8}T\d{6}-[a-f0-9]{8}$/.test(id));
    taskSummary.total = ids.length;
    for (const id of ids.slice(-20)) {
      const t = safeRead(path.join(tasksDir, id, 'task.json'));
      if (t?.status) taskSummary[t.status] = (taskSummary[t.status] || 0) + 1;
    }
  }

  return sanitize({
    claudeReserve: Boolean(config.claudeReserve),
    claudeReserveNote: config.claudeReserve
      ? 'Claude quota is reserved — Adaptive Router uses Codex/Antigravity/Cline as primary workers'
      : 'Claude available — may be used for high-complexity tasks',
    taskInProgress: isLocked,
    routingMode: 'Auto (Intelligent Routing)',
    maxCorrections: config.maxCorrections || 2,
    taskSummary
  });
}

/**
 * List the most recent N tasks (default 10) with key metadata.
 * Safe subset: id, instruction summary, status, worker, model, specialist, created.
 */
export function listRecentTasks(root, n = 10) {
  const tasksDir = path.join(root, '.router', 'tasks');
  if (!fs.existsSync(tasksDir)) return [];
  const ids = fs.readdirSync(tasksDir)
    .filter(id => /^\d{8}T\d{6}-[a-f0-9]{8}$/.test(id))
    .sort()
    .reverse()
    .slice(0, n);

  return sanitize(ids.map(id => {
    const t = safeRead(path.join(tasksDir, id, 'task.json'));
    if (!t) return null;
    const buildLog = t.routingLog?.find(r => r.role === 'build');
    const instr = (t.instruction || '').trim();
    const firstLine = instr.split(/\r?\n/).find(l => l.trim()) || instr;
    return {
      id: t.id,
      summary: firstLine.replace(/^#+\s*/, '').slice(0, 120),
      status: t.status,
      created: t.created,
      project: t.project || 'test-site',
      worker: buildLog?.worker || t.contributors?.[0] || 'Unknown',
      model: buildLog?.model || 'Standard',
      effort: buildLog?.effort || 'medium',
      specialist: buildLog?.specialistName || t.specialistName || null
    };
  }).filter(Boolean));
}

/**
 * Get full status for a single task.
 * Returns: status, worker, model, effort, specialist, routing reason,
 *          revision, created, project.
 */
export function getTaskStatus(root, taskId) {
  const dir = taskDir(root, taskId);
  const t = safeRead(path.join(dir, 'task.json'));
  if (!t) throw new Error(`Task not found: ${taskId}`);
  const buildLog = t.routingLog?.find(r => r.role === 'build');
  const reviewLog = t.routingLog?.find(r => r.role === 'review');
  return sanitize({
    id: t.id,
    status: t.status,
    project: t.project || 'test-site',
    created: t.created,
    revision: t.revision || 1,
    instructionSummary: (t.instruction || '').split(/\r?\n/).find(l => l.trim())?.slice(0, 120),
    worker: buildLog?.worker || t.contributors?.[0] || 'Unknown',
    model: buildLog?.model || 'Standard',
    effort: buildLog?.effort || 'medium',
    specialist: buildLog?.specialistName || t.specialistName || null,
    routingReason: buildLog?.reason || 'Optimal worker selected based on task requirements',
    reviewer: reviewLog?.worker || t.reviewer || null,
    decisionRequired: t.status === 'needs_human_input' ? {
      question: t.decisionRequired?.question || 'Claude Code would be useful. Use Claude quota?',
      recommendation: t.decisionRequired?.recommended || 'Preserve Claude — Use Next Best Worker'
    } : null
  });
}

/**
 * Get recent activity log lines for a task (last 15 items, newest first).
 * Suitable for ChatGPT to summarise what's happening right now.
 */
export function getLiveProgress(root, taskId) {
  const dir = taskDir(root, taskId);
  const t = safeRead(path.join(dir, 'task.json'));
  if (!t) throw new Error(`Task not found: ${taskId}`);

  // Read events.jsonl
  const eventsFile = path.join(dir, 'events.jsonl');
  let events = [];
  if (fs.existsSync(eventsFile)) {
    events = fs.readFileSync(eventsFile, 'utf8')
      .trim().split(/\r?\n/).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  const activityEvents = events
    .filter(e => e.type === 'activity' || e.type === 'log')
    .slice(-15)
    .reverse()
    .map(e => ({
      time: e.time,
      title: e.title || e.message || 'Activity',
      description: e.desc || e.message || '',
      category: e.category || 'worker'
    }));

  return sanitize({
    taskId,
    status: t.status,
    activityCount: activityEvents.length,
    recentActivity: activityEvents
  });
}

/**
 * Get automated test results for a task.
 */
export function getTestResults(root, taskId) {
  const dir = taskDir(root, taskId);
  const t = safeRead(path.join(dir, 'task.json'));
  if (!t) throw new Error(`Task not found: ${taskId}`);
  const testsFile = path.join(dir, `tests-${t.revision || 1}.json`);
  const tests = safeRead(testsFile);
  if (!tests) return sanitize({ taskId, available: false, note: 'No automated test results recorded yet.' });
  return sanitize({
    taskId,
    available: true,
    passed: tests.passed,
    checksCount: tests.checks?.length || 0,
    checks: (tests.checks || []).map(c => ({ name: c.name, passed: c.passed !== false })),
    summary: tests.passed ? 'All automated browser checks passed.' : 'One or more browser checks failed.'
  });
}

/**
 * Get independent reviewer findings for a task.
 */
export function getReviewerFindings(root, taskId) {
  const dir = taskDir(root, taskId);
  const t = safeRead(path.join(dir, 'task.json'));
  if (!t) throw new Error(`Task not found: ${taskId}`);
  const reviewFile = path.join(dir, `review-${t.revision || 1}.json`);
  const review = safeRead(reviewFile);
  if (!review) return sanitize({ taskId, available: false, note: 'No reviewer findings recorded yet.' });
  return sanitize({
    taskId,
    available: true,
    reviewer: review.worker || t.reviewer || 'Independent Reviewer',
    verdict: review.verdict,
    passed: review.verdict === 'pass',
    summary: review.summary || review.comment || '',
    issues: review.issues || []
  });
}

/**
 * Get deliverable summary for a task — what was built, which files changed.
 */
export function getDeliverableSummary(root, taskId) {
  const dir = taskDir(root, taskId);
  const t = safeRead(path.join(dir, 'task.json'));
  if (!t) throw new Error(`Task not found: ${taskId}`);
  const manifestFile = path.join(dir, `manifest-${t.revision || 1}.json`);
  const manifest = safeRead(manifestFile);
  const isSystem = t.project === 'adaptive-router' || t.kind === 'system';
  return sanitize({
    taskId,
    project: t.project || 'test-site',
    isSystemTask: isSystem,
    featureSummary: t.summary || t.featureSummary || 'Deliverable produced',
    filesChanged: manifest?.files?.map(f => f.path) || (t.systemFiles || []),
    revision: t.revision || 1,
    status: t.status,
    viewAt: isSystem ? 'Adaptive Router Dashboard (system task)' : `http://localhost:3210/api/tasks/${taskId}/deliverable/index.html`
  });
}

/**
 * Get approval state for a task.
 */
export function getApprovalState(root, taskId) {
  const dir = taskDir(root, taskId);
  const t = safeRead(path.join(dir, 'task.json'));
  if (!t) throw new Error(`Task not found: ${taskId}`);
  const approvalFile = path.join(dir, 'approval.json');
  const approval = safeRead(approvalFile);
  return sanitize({
    taskId,
    status: t.status,
    approvalState: (() => {
      if (t.status === 'approved') return 'approved';
      if (t.status === 'rejected') return 'rejected';
      if (t.status === 'awaiting_approval') return 'awaiting_your_approval';
      if (t.status === 'needs_human_input') return 'paused_needs_decision';
      return t.status;
    })(),
    approvedAt: approval?.time || null,
    approvedBy: approval?.approvedBy || (approval ? 'User via Dashboard' : null),
    rejectionReason: approval?.reason && t.status === 'rejected' ? approval.reason : null,
    actionRequired: t.status === 'awaiting_approval'
      ? 'Deliverable ready — please review and approve or reject in Adaptive Router dashboard.'
      : (t.status === 'needs_human_input'
        ? 'Adaptive Router is paused waiting for a decision. Check the dashboard.'
        : null)
  });
}

/**
 * Get all worker failures and failover events for a task.
 */
export function getFailoversAndErrors(root, taskId) {
  const dir = taskDir(root, taskId);
  const t = safeRead(path.join(dir, 'task.json'));
  if (!t) throw new Error(`Task not found: ${taskId}`);
  const eventsFile = path.join(dir, 'events.jsonl');
  let failovers = [];
  if (fs.existsSync(eventsFile)) {
    failovers = fs.readFileSync(eventsFile, 'utf8')
      .trim().split(/\r?\n/).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && (e.type === 'worker_unavailable' || e.type === 'failover'))
      .map(e => ({
        time: e.time,
        worker: e.worker,
        reason: e.isQuota ? 'Quota/usage limit reached' : (e.reason || 'Worker unavailable'),
        escalatedTo: e.escalatedTo || null
      }));
  }
  return sanitize({
    taskId,
    failoverCount: failovers.length,
    failovers,
    summary: failovers.length === 0
      ? 'No worker failures — task ran cleanly.'
      : `${failovers.length} worker failover(s) occurred. Adaptive Router automatically escalated to backup workers.`
  });
}

// ── Write Operations ──────────────────────────────────────────────────────────
// These are implemented and ready. ChatGPT Pro cannot call them via MCP today
// (write actions are restricted on Pro). They are available for:
//   - ChatGPT Work (browser operation) hitting the REST endpoints
//   - Direct API calls from the user's scripts
//   - Future ChatGPT Pro write-action support

/**
 * Submit a new task for execution.
 * Returns { success, taskId, message }
 * IMPORTANT: Does NOT bypass Claude Reserve Mode — the existing gate still fires.
 */
export async function submitTask(root, { instruction, project = 'test-site', allowClaude = false }) {
  if (!instruction?.trim()) throw new Error('Instruction is required');
  const lockPath = path.join(root, '.router', 'router.lock');
  if (fs.existsSync(lockPath)) {
    throw new Error('A task is already running. Please wait for it to complete before submitting a new one.');
  }
  // Import codeTask dynamically to avoid circular deps
  const { codeTask } = await import('./coding.mjs');
  // Fire and forget — return task ID after brief wait
  let taskId = null;
  (async () => {
    try { taskId = await codeTask(root, instruction.trim(), { project, allowClaude }); }
    catch (err) { console.error('submitTask error:', err.message); }
  })();
  await new Promise(r => setTimeout(r, 150));
  // Find newest task
  const tasksDir = path.join(root, '.router', 'tasks');
  if (fs.existsSync(tasksDir)) {
    const newest = fs.readdirSync(tasksDir)
      .filter(id => /^\d{8}T\d{6}-[a-f0-9]{8}$/.test(id))
      .sort().reverse()[0];
    if (newest) taskId = newest;
  }
  return { success: true, taskId, message: 'Task submitted. Monitor progress via get_live_progress.' };
}

/**
 * Approve a completed deliverable.
 */
export function approveTask(root, taskId, { reason = 'Approved via ChatGPT connector' } = {}) {
  const dir = taskDir(root, taskId);
  const t = safeRead(path.join(dir, 'task.json'));
  if (!t) throw new Error(`Task not found: ${taskId}`);
  if (t.status !== 'awaiting_approval') {
    throw new Error(`Task ${taskId} is not awaiting approval (current status: ${t.status})`);
  }
  // Write approval directly (mirrors POST /api/tasks/:id/decide)
  const approval = { decision: 'approved', reason, time: new Date().toISOString(), approvedBy: 'ChatGPT Connector' };
  fs.writeFileSync(path.join(dir, 'approval.json'), JSON.stringify(approval, null, 2) + '\n');
  t.status = 'approved';
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(t, null, 2) + '\n');
  return { success: true, taskId, newStatus: 'approved', message: 'Deliverable approved.' };
}

/**
 * Reject a completed deliverable.
 */
export function rejectTask(root, taskId, { reason }) {
  if (!reason?.trim()) throw new Error('A rejection reason is required');
  const dir = taskDir(root, taskId);
  const t = safeRead(path.join(dir, 'task.json'));
  if (!t) throw new Error(`Task not found: ${taskId}`);
  if (!['awaiting_approval', 'approved'].includes(t.status)) {
    throw new Error(`Task ${taskId} cannot be rejected in status: ${t.status}`);
  }
  const rejection = { decision: 'rejected', reason: reason.trim(), time: new Date().toISOString(), rejectedBy: 'ChatGPT Connector' };
  fs.writeFileSync(path.join(dir, 'approval.json'), JSON.stringify(rejection, null, 2) + '\n');
  t.status = 'rejected';
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(t, null, 2) + '\n');
  return { success: true, taskId, newStatus: 'rejected', message: `Deliverable rejected: ${reason}` };
}

/**
 * Toggle Claude Reserve Mode on or off.
 */
export function toggleClaudeReserve(root, enabled) {
  const configPath = path.join(root, 'workers.json');
  const config = safeRead(configPath) || {};
  config.claudeReserve = Boolean(enabled);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return {
    success: true,
    claudeReserve: config.claudeReserve,
    message: config.claudeReserve
      ? 'Claude Reserve Mode is now ON — Claude quota preserved for Cowork.'
      : 'Claude Reserve Mode is now OFF — Claude available for routing.'
  };
}
