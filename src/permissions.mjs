import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { read, json } from './storage.mjs';
import { sanitizePayload, sanitizeText } from './events.mjs';

// Pre-authorized low-risk actions inside isolated task workspaces
export const PREAUTHORIZED_ACTIONS = [
  'read_project_baseline',
  'write_task_deliverables',
  'run_browser_tests',
  'run_isolated_linter',
  'extract_json_response'
];

// In-memory pending permission requests: Map<string, PermissionRequest>
const pendingPermissions = new Map();
const permissionListeners = new Set();
const permissionTimeoutListeners = new Set();
// Session permissions for active tasks/sessions: Map<string, Set<string>> (taskId -> Set of approved actions)
const sessionPermissions = new Map();

export function onPermissionChange(callback) {
  permissionListeners.add(callback);
  return () => permissionListeners.delete(callback);
}

// Fires specifically when a permission request times out with no human
// decision (as opposed to onPermissionChange, which fires on every resolve
// including a normal human answer) — so callers can surface a distinct,
// honest activity entry explaining why the task moved on by itself.
export function onPermissionTimeout(callback) {
  permissionTimeoutListeners.add(callback);
  return () => permissionTimeoutListeners.delete(callback);
}

function notifyListeners() {
  const current = getPendingPermissions();
  for (const listener of permissionListeners) {
    try { listener(current); } catch {}
  }
}

export function getProjectPermissionsPath(root) {
  return path.join(root, '.router', 'permissions.json');
}

export function getProjectPermissions(root, projectId = 'test-site') {
  const file = getProjectPermissionsPath(root);
  if (!fs.existsSync(file)) return {};
  try {
    const all = read(file);
    return all[projectId] || {};
  } catch {
    return {};
  }
}

export function saveProjectPermission(root, projectId, key, value) {
  const file = getProjectPermissionsPath(root);
  let all = {};
  if (fs.existsSync(file)) {
    try { all = read(file); } catch {}
  }
  all[projectId] = all[projectId] || {};
  all[projectId][key] = value;
  json(file, all);
}

export function grantSessionPermission(taskId, action) {
  if (!taskId || !action) return;
  if (!sessionPermissions.has(taskId)) {
    sessionPermissions.set(taskId, new Set());
  }
  sessionPermissions.get(taskId).add(action);
}

export function clearSessionPermissions(taskId) {
  if (taskId) sessionPermissions.delete(taskId);
}

export function isPreauthorized(actionName, { root, projectId = 'test-site', taskId = null } = {}) {
  if (PREAUTHORIZED_ACTIONS.includes(actionName)) return true;
  if (taskId && sessionPermissions.has(taskId)) {
    if (sessionPermissions.get(taskId).has(actionName)) return true;
  }
  if (root) {
    const projectPerms = getProjectPermissions(root, projectId);
    if (projectPerms[actionName] === true) return true;
  }
  return false;
}

// A permission card that nobody answers (the human is away, missed the
// notification, or the browser tab's SSE connection dropped) previously hung
// its awaiting worker forever — the task never reached a status the
// auto-retry mechanism in server.mjs recognizes as stalled, so it just sat
// there silently until someone happened to open the dashboard and notice.
// This bounds that wait: after PERMISSION_TIMEOUT_MS with no human decision,
// the request resolves on its own as a safe "deny" (never an auto-approve —
// approving would mean spending paid quota with no human in the loop) so the
// task can fail over to the next worker or surface as needing attention
// through the normal path, instead of hanging indefinitely.
const PERMISSION_TIMEOUT_MS = 15 * 60 * 1000;

export function requestPermission(taskId, {
  type = 'action_approval',
  description,
  worker = 'system',
  action,
  requiresNativeApp = false,
  canRemember = true,
  projectId = null,
  details = {}
}) {
  const id = `perm-${Date.now()}-${randomUUID().slice(0, 6)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const current = pendingPermissions.get(id);
      if (!current) return; // already resolved by a human in the meantime
      for (const listener of permissionTimeoutListeners) {
        try {
          listener({ id, taskId: current.taskId, projectId: current.projectId, description: current.description, worker: current.worker });
        } catch {}
      }
      current.resolve({
        decision: 'deny',
        rawDecision: 'timeout',
        remember: false,
        feedback: 'No response to the permission request within 15 minutes; automatically denied. Continue without it or propose another safe method.',
        allowed: false,
        timedOut: true
      });
    }, PERMISSION_TIMEOUT_MS);
    const perm = {
      id,
      taskId,
      projectId,
      type,
      description,
      worker,
      action,
      requiresNativeApp,
      canRemember,
      details,
      created: new Date().toISOString(),
      resolve: (decisionResult) => {
        clearTimeout(timer);
        pendingPermissions.delete(id);
        notifyListeners();
        resolve(decisionResult);
      }
    };
    pendingPermissions.set(id, perm);
    notifyListeners();
  });
}

export function getPendingPermissions(taskId = null) {
  const list = [];
  for (const p of pendingPermissions.values()) {
    if (!taskId || p.taskId === taskId) {
      list.push({
        id: p.id,
        taskId: p.taskId,
        projectId: p.projectId,
        type: p.type,
        description: sanitizeText(p.description),
        worker: sanitizeText(p.worker),
        action: sanitizeText(p.action),
        requiresNativeApp: p.requiresNativeApp,
        canRemember: p.canRemember,
        details: sanitizePayload(p.details),
        created: p.created
      });
    }
  }
  return list;
}

export function resolvePermission(root, id, { decision, remember = false, projectId = 'test-site' }) {
  const p = pendingPermissions.get(id);
  if (!p) return false;

  // Normalize 4 choices:
  // 1. 'yes' / 'allow_once': Allow this single requested action only
  // 2. 'yes_session' / 'allow_task': Allow for the remainder of the current task/session
  // 3. 'no' / 'deny': Deny this requested action, keep same worker, inform worker
  // 4. 'stop_task' / 'cancel': Immediately stop/cancel the current task
  let normalizedDecision = decision;
  if (decision === 'yes') normalizedDecision = 'allow_once';
  else if (decision === 'yes_session') normalizedDecision = 'allow_task';
  else if (decision === 'no') normalizedDecision = 'deny';
  else if (decision === 'stop_task' || decision === 'stop' || decision === 'cancel') normalizedDecision = 'stop_task';

  // 2. Yes for this session -> store in session permissions for the active task
  if ((normalizedDecision === 'allow_task' || decision === 'yes_session') && p.taskId && p.action) {
    grantSessionPermission(p.taskId, p.action);
  }

  // Handle optional permanent remember only if explicitly requested
  if (remember && p.action && root) {
    saveProjectPermission(root, projectId, p.action, normalizedDecision === 'allow_task' || normalizedDecision === 'allow_once');
  }

  let feedback = null;
  if (normalizedDecision === 'deny' || decision === 'no') {
    feedback = 'Permission denied for this action. Continue without it or propose another safe method.';
  } else if (normalizedDecision === 'stop_task') {
    feedback = 'Task stopped by user during permission request.';
  }

  p.resolve({
    decision: normalizedDecision,
    rawDecision: decision,
    remember,
    feedback,
    allowed: normalizedDecision === 'allow_once' || normalizedDecision === 'allow_task'
  });
  return true;
}

export function openNativeApp(worker) {
  try {
    if (worker === 'claude' || worker === 'claude-code') {
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', 'claude:'], { detached: true, stdio: 'ignore' }).unref();
        return { success: true, app: 'Claude Desktop' };
      }
    } else if (worker === 'antigravity') {
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', 'antigravity:'], { detached: true, stdio: 'ignore' }).unref();
        return { success: true, app: 'Antigravity' };
      }
    }
    return { success: false, reason: 'Native URL scheme or app launcher not configured' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
