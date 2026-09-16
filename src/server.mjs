import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { read, json, hash, event } from './storage.mjs';
import { executables } from './workers.mjs';
import { codeTask } from './coding.mjs';
import { decide, taskDir } from './router.mjs';
import { getSpecialist } from './specialists.mjs';
import { requestPermission, getPendingPermissions, resolvePermission, openNativeApp, onPermissionChange, onPermissionTimeout } from './permissions.mjs';
import { getPlanningState, sendPlanningMessage, resetPlanningState, approvePlanAndExecute } from './planning.mjs';
import { getOrCreateConnectorToken, rotateConnectorToken, getTunnelStatus, listProjects, getProjectStatus, listRecentTasks as listRecentTasksConnector, getTaskStatus, getLiveProgress, getTestResults, getReviewerFindings, getDeliverableSummary, getApprovalState, getFailoversAndErrors, submitTask, approveTask, rejectTask, toggleClaudeReserve } from './connector.mjs';
import { handleMcpRequest, ALL_TOOLS } from './mcp-server.mjs';
import { sanitizeText, sanitizePayload, loadTaskEvents, recordWorkerEvent } from './events.mjs';
import { listProjects as listRegisteredProjects, getProject, getActiveProject, setActiveProject, createProject, deleteProject, defaultProjectsFolder } from './projects.mjs';
import { getRecentStaffActivity } from './staff-log.mjs';
import { discoverAntigravityModels, classifyTask } from './smart-router.mjs';
import { classifySensitivity } from './sensitivity.mjs';
import { formatTaskFailure } from './failure.mjs';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

export const ACTIVE_TASK_STATUSES = new Set([
  'running',
  'building',
  'testing',
  'reviewing',
  'waiting_for_worker',
  'needs_cto_attention',
  'needs_human_input',
  'awaiting_plan_approval',
  'waiting_for_reviewer',
  'awaiting_approval',
  'paused_by_user'
]);

export const TERMINAL_TASK_STATUSES = new Set([
  'completed',
  'approved',
  'cancelled',
  'cancelled_by_user',
  'rejected',
  'failed'
]);

const activeStreams = new Map(); // taskId -> Set of res objects
let activeRunningTask = null; // Currently running taskId or null
const activeTaskAbortControllers = new Map(); // taskId -> AbortController

export function broadcastTaskEvent(taskId, eventData) {
  const streams = activeStreams.get(taskId);
  if (streams) {
    const payload = `data: ${JSON.stringify(sanitizePayload(eventData))}\n\n`;
    for (const res of streams) {
      try { res.write(payload); } catch {}
    }
  }
}

// Router-level activity items (auto-retry scheduling, permission timeouts,
// etc.) originate outside codeTask()'s own addActivity() closure in
// coding.mjs, but should show up the same way in both the live SSE feed and
// the durable per-task history — otherwise they only ever appear in the Live
// Activity panel while a browser tab happens to be open and connected, and
// vanish on refresh or on a later visit, same gap coding.mjs's own
// addActivity() already avoids for build/review activity.
function persistRouterActivity(root, taskId, icon, title, desc, category = 'router') {
  if (!taskId) return;
  const item = { time: new Date().toISOString(), icon, title, desc, category };
  try {
    const dir = taskDir(root, taskId);
    const task = read(path.join(dir, 'task.json'));
    task.activityLog = task.activityLog || [];
    task.activityLog.push(item);
    event(dir, 'activity', item);
    json(path.join(dir, 'task.json'), task);
  } catch {
    // Task file may not exist yet in rare races (e.g. right at creation) —
    // still broadcast live below so an open dashboard sees it either way.
  }
  broadcastTaskEvent(taskId, { type: 'activity', item });
}


// Auto-retry for tasks that stall because every eligible worker failed
// (waiting_for_worker / waiting_for_reviewer) — the operator asked for
// this so a rate limit or a transient hiccup doesn't just sit there needing
// a manual click. At most 3 auto-retries per task, with a growing wait
// between them (30 sec, then 1 min, then 2 min), then it stops and leaves
// the normal manual "Retry Now" button for the CEO — this caps how much
// paid-worker quota a single broken/expensive task can burn on its own
// before a human looks at it. A task that resolves itself (any status
// other than the two stall states, including it being manually retried or
// cancelled in the meantime) or gets deleted clears its entry, and only one
// retry timer is ever live per task at a time.
const AUTO_RETRY_DELAYS_MS = [30 * 1000, 60 * 1000, 2 * 60 * 1000];
const autoRetryState = new Map(); // taskId -> { attempts, timer }
const STALL_STATUSES = new Set(['waiting_for_worker', 'waiting_for_reviewer']);

function clearAutoRetry(taskId, root = null) {
  const entry = autoRetryState.get(taskId);
  if (entry?.timer) clearTimeout(entry.timer);
  autoRetryState.delete(taskId);
  // root is optional only because a couple of call sites predate this
  // countdown feature and don't have it trivially in scope; passing it
  // keeps the dashboard's countdown display in sync with reality whenever
  // a retry is cancelled (a human resumed manually, the task moved on).
  if (root) clearPersistedRetryCountdown(root, taskId);
}

// Formats a millisecond delay as "30 seconds" / "1 minute" / "2 minutes" —
// the old fixed "X minute(s)" wording would have shown "0 minutes" for the
// new 30-second first attempt, which reads as broken/instant rather than a
// real 30-second wait.
function formatDelay(ms) {
  if (ms < 60 * 1000) {
    const secs = Math.round(ms / 1000);
    return `${secs} second${secs === 1 ? '' : 's'}`;
  }
  const mins = Math.round(ms / 60000);
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

// Called after every codeTask() call settles, for whichever taskId it just
// acted on. root/project are needed to actually fire the retry later.
function maybeScheduleAutoRetry(root, project, taskId) {
  if (!taskId) return;
  let task;
  try { task = read(path.join(taskDir(root, taskId), 'task.json')); } catch { return; }
  if (!STALL_STATUSES.has(task.status)) {
    clearAutoRetry(taskId, root);
    return;
  }
  const entry = autoRetryState.get(taskId) || { attempts: 0, timer: null };
  if (entry.timer) return; // a retry is already scheduled for this task
  if (entry.attempts >= AUTO_RETRY_DELAYS_MS.length) {
    clearPersistedRetryCountdown(root, taskId);
    return; // exhausted; wait for a human
  }
  const delay = AUTO_RETRY_DELAYS_MS[entry.attempts];
  const retryAt = new Date(Date.now() + delay).toISOString();
  entry.attempts += 1;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    autoRetryState.set(taskId, entry);
    runAutoRetry(root, project, taskId);
  }, delay);
  if (entry.timer?.unref) entry.timer.unref();
  autoRetryState.set(taskId, entry);
  // Persisted (not just kept in the in-memory autoRetryState map) so the
  // dashboard can show a live "Retrying in..." countdown next to Retry Now
  // that survives a page refresh, instead of the person having to guess
  // whether anything is actually going to happen on its own.
  persistTaskFields(root, taskId, { autoRetryAt: retryAt, autoRetryAttempt: entry.attempts, autoRetryMax: AUTO_RETRY_DELAYS_MS.length });
  persistRouterActivity(
    root,
    taskId,
    '⏱️',
    'Auto-Retry Scheduled',
    `No worker could complete this task. Will automatically retry in ${formatDelay(delay)} (attempt ${entry.attempts} of ${AUTO_RETRY_DELAYS_MS.length}).`
  );
}

// Clears the persisted countdown fields once a task is no longer stalled or
// has exhausted its automatic retries, so the dashboard stops showing a
// countdown for something that isn't actually going to retry anymore.
function clearPersistedRetryCountdown(root, taskId) {
  persistTaskFields(root, taskId, { autoRetryAt: null, autoRetryAttempt: null, autoRetryMax: null });
}

function persistTaskFields(root, taskId, fields) {
  try {
    const taskPath = path.join(taskDir(root, taskId), 'task.json');
    const task = read(taskPath);
    Object.assign(task, fields);
    json(taskPath, task);
  } catch {
    // Best-effort — a missing/mid-write task file just means the dashboard
    // won't show a countdown this cycle, not a functional failure.
  }
  broadcastTaskEvent(taskId, { type: 'auto_retry_state', ...fields });
}

function runAutoRetry(root, project, taskId) {
  // Only the in-memory activeRunningTask guard is checked here — never force
  // a retry while something else in THIS process is genuinely running.
  // Deliberately NOT pre-checking router.lock's mere existence anymore: that
  // used to short-circuit here on ANY existing lock file, including a stale
  // one left by a process that had already been killed (a crash, a forced
  // Task Manager stop, a restart mid-task — exactly what happened here more
  // than once). storage.mjs's locked() is now the sole authority on whether
  // a lock is live or stale (it checks the recorded pid, not just file
  // existence) and self-heals a stale one automatically; duplicating a
  // cruder existence-only check here meant a stale lock could defer this
  // retry forever without ever reaching the code that could actually clear
  // it. So this now always attempts codeTask(), and a lock that's genuinely
  // still held throws its normal "Another router operation is running"
  // error, which the catch below reports and reschedules from — same
  // conservative-cap and visible-logging behavior, just without a second,
  // less capable gatekeeper in front of it.
  if (activeRunningTask) { maybeScheduleAutoRetry(root, project, taskId); return; }
  let task;
  try { task = read(path.join(taskDir(root, taskId), 'task.json')); } catch { return; }
  if (!STALL_STATUSES.has(task.status)) { clearAutoRetry(taskId, root); return; }

  (async () => {
    try {
      activeRunningTask = taskId;
      clearPersistedRetryCountdown(root, taskId); // it's happening now, not "in N seconds" anymore
      persistRouterActivity(root, taskId, '🔄', 'Auto-Retry Firing', 'Retrying automatically now.');
      await codeTask(root, '', {
        resume: taskId,
        preferredWorker: task.preferredWorker,
        allowClaude: Boolean(task.allowClaudeForTask || task.claudeQuotaAuthorized),
        onWorkerEvent: (evt) => broadcastTaskEvent(taskId, { type: 'worker_event', event: evt }),
        log: (msg) => broadcastTaskEvent(taskId, { type: 'log', message: msg }),
        onActivity: (item) => broadcastTaskEvent(taskId, { type: 'activity', item })
      });
    } catch (err) {
      console.error('Auto-retry background error:', err.message);
      persistRouterActivity(root, taskId, '⚠️', 'Auto-Retry Attempt Failed', err.message || 'Unknown error while retrying.');
    } finally {
      activeRunningTask = null;
      maybeScheduleAutoRetry(root, project, taskId);
    }
  })();
}

export async function getWorkerStatuses(root, requestedProject = null) {
  const config = read(path.join(root, 'workers.json'));
  const paths = executables(root);
  const isReserve = config.claudeReserve !== false;
  const isUserEnabled = (id) => (config.workers.find(w => w.id === id)?.enabled) !== false;

  // Codex status
  let codexStatus = 'Unavailable';
  let codexNote = 'Codex CLI not found';
  if (paths.codex) {
    codexStatus = 'Available';
    codexNote = 'Connected via ChatGPT Pro';
  }

  // Claude Code status
  let claudeStatus = 'Unavailable';
  let claudeNote = 'Claude CLI not found';
  if (paths.claude) {
    if (isReserve) {
      claudeStatus = 'Reserved';
      claudeNote = 'Quota preserved for Claude Cowork';
    } else {
      claudeStatus = 'Available';
      claudeNote = 'Connected via Claude Pro';
    }
  }

  // Antigravity status
  let antigravityStatus = 'Unavailable';
  let antigravityNote = 'Antigravity CLI not found or not signed in';
  if (paths.antigravity) {
    const antigravityModels = discoverAntigravityModels(paths.antigravity);
    if (antigravityModels.length) {
      antigravityStatus = 'Available';
      antigravityNote = `Connected in Google account mode (${antigravityModels.length} models)`;
    } else {
      antigravityNote = 'CLI installed, but sign-in/model availability could not be verified';
    }
  }

  // Cline status
  let clineStatus = 'Unavailable';
  let clineNote = 'Cline CLI not found (install with: npm i -g cline)';
  if (paths.cline) {
    clineStatus = 'Available';
    clineNote = 'Connected via Cline CLI (local install, model set by connected provider)';
  }

  const activeProject = requestedProject
    ? getProject(root, requestedProject, { includeHidden: false })
    : getActiveProject(root);
  let visibleRunningTask = activeRunningTask;
  if (!visibleRunningTask) {
    const active = getActiveTask(root, activeProject.id);
    if (active) visibleRunningTask = active.id;
  } else if (visibleRunningTask !== 'running') {
    try {
      const running = read(path.join(taskDir(root, visibleRunningTask), 'task.json'));
      if (running.project !== activeProject.id) visibleRunningTask = null;
    } catch { visibleRunningTask = null; }
  }
  return {
    workers: [
      { id: 'codex', name: 'Codex', platform: 'OpenAI / ChatGPT Pro', status: codexStatus, note: codexNote, userEnabled: isUserEnabled('codex') },
      { id: 'claude-code', name: 'Claude Code', platform: 'Anthropic / Claude Pro', status: claudeStatus, note: claudeNote, isReserve, userEnabled: isUserEnabled('claude-code') },
      { id: 'antigravity', name: 'Antigravity', platform: 'Google Deepmind', status: antigravityStatus, note: antigravityNote, userEnabled: isUserEnabled('antigravity') },
      { id: 'cline', name: 'Cline', platform: 'Cline CLI (local)', status: clineStatus, note: clineNote, userEnabled: isUserEnabled('cline') }
    ],
    claudeReserve: isReserve,
    routingMode: 'Auto',
    activeRunningTask: visibleRunningTask,
    activeProject,
    projects: listRegisteredProjects(root)
  };
}

export function listRecentTasks(root, projectFilter = null) {
  const tasksDir = path.join(root, '.router', 'tasks');
  if (!fs.existsSync(tasksDir)) return [];
  const entries = fs.readdirSync(tasksDir).filter(id => /^\d{8}T\d{6}-[a-f0-9]{8}$/.test(id));
  const tasks = [];
  for (const id of entries.sort().reverse().slice(0, 30)) {
    try {
      const tFile = path.join(tasksDir, id, 'task.json');
      if (!fs.existsSync(tFile)) continue;
      const t = read(tFile);
      const builderEntry = t.routingLog?.find(r => r.role === 'build');
      const reviewerEntry = t.routingLog?.find(r => r.role === 'review');
      const project = t.project || (t.kind === 'system' || /adaptive\s*router|dashboard|planning\s*chat|workflow/i.test(t.instruction || '') ? 'adaptive-router' : 'test-site');
      const projectName = t.projectName || (project === 'adaptive-router' ? 'Adaptive Router System' : 'Adaptive Router Test Project');
      const kind = t.kind || (project === 'adaptive-router' ? 'system' : 'web');
      if (projectFilter && project !== projectFilter) continue;

      let duration = null;
      if (t.created) {
        const start = new Date(t.created).getTime();
        const end = t.completionTime ? new Date(t.completionTime).getTime() : Date.now();
        const diffSec = Math.max(0, Math.floor((end - start) / 1000));
        const m = Math.floor(diffSec / 60);
        const s = diffSec % 60;
        duration = `${m}m ${s < 10 ? '0' : ''}${s}s`;
      }

      let progress = 50;
      if (t.status === 'completed' || t.status === 'approved') progress = 100;
      else if (t.status === 'awaiting_approval') progress = 85;
      else if (t.status === 'reviewing' || t.status === 'testing') progress = 70;
      else if (t.status === 'building' || t.status === 'running') progress = 45;
      else if (t.status === 'failed' || t.status === 'rejected') progress = 60;

      tasks.push({
        id: t.id,
        instruction: t.instruction,
        status: t.status,
        created: t.created,
        completionTime: t.completionTime || null,
        duration,
        progress,
        revision: t.revision,
        builder: builderEntry?.worker || t.contributors?.[0] || 'Unknown',
        model: builderEntry?.model || 'default',
        effort: builderEntry?.effort || 'standard',
        reviewer: t.reviewerWorker || t.selectedReviewer || t.reviewer || reviewerEntry?.worker || 'None',
        reviewerModel: t.reviewerModel || reviewerEntry?.model || null,
        reviewerEffort: t.reviewerEffort || reviewerEntry?.effort || null,
        specialist: builderEntry?.specialist || t.specialist || null,
        specialistName: builderEntry?.specialistName || t.specialistName || null,
        summary: t.summary || '',
        project,
        projectName,
        kind,
        tokenUsage: t.tokenUsage || null
      });
    } catch {}
  }
  return tasks;
}

export function getActiveTask(root, projectId = null) {
  if (activeRunningTask && activeRunningTask !== 'running') {
    try {
      const t = read(path.join(taskDir(root, activeRunningTask), 'task.json'));
      if (!projectId || t.project === projectId) {
        if (ACTIVE_TASK_STATUSES.has(t.status)) return t;
      }
    } catch {}
  }
  const recent = listRecentTasks(root, projectId);
  if (recent.length > 0) {
    const newest = recent[0];
    if (ACTIVE_TASK_STATUSES.has(newest.status)) {
      return newest;
    }
  }
  return null;
}

export function getTaskDetails(root, id) {
  const dir = taskDir(root, id);
  const task = read(path.join(dir, 'task.json'));
  let events = [];
  const eventsFile = path.join(dir, 'events.jsonl');
  if (fs.existsSync(eventsFile)) {
    events = fs.readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  let tests = null;
  const testsFile = path.join(dir, `tests-${task.revision}.json`);
  if (fs.existsSync(testsFile)) {
    try { tests = read(testsFile); } catch {}
  }

  let review = null;
  const reviewFile = path.join(dir, `review-${task.revision}.json`);
  if (fs.existsSync(reviewFile)) {
    try { review = read(reviewFile); } catch {}
  }

  let manifest = null;
  const manifestFile = path.join(dir, `manifest-${task.revision}.json`);
  if (fs.existsSync(manifestFile)) {
    try { manifest = read(manifestFile); } catch {}
  }

  let changes = null;
  const changesFile = path.join(dir, `changes-${task.revision}.json`);
  if (fs.existsSync(changesFile)) {
    try { changes = read(changesFile); } catch {}
  }

  let approvalReport = '';
  const reportFile = path.join(dir, 'APPROVAL.md');
  if (fs.existsSync(reportFile)) {
    try { approvalReport = fs.readFileSync(reportFile, 'utf8'); } catch {}
  }

  let approvalData = null;
  const approvalFile = path.join(dir, 'approval.json');
  if (fs.existsSync(approvalFile)) {
    try { approvalData = read(approvalFile); } catch {}
  }

  // Quota and failover events
  const failoverEvents = events.filter(e => e.type === 'worker_unavailable' || e.type === 'failover');

  // Ensure decisionRequired is populated if status is needs_human_input or context mismatch
  let decisionRequired = task.decisionRequired || null;
  const isContextMismatch = task.reasonCode === 'CONTEXT_MISMATCH' || task.status === 'context_mismatch' || decisionRequired?.reasonCode === 'CONTEXT_MISMATCH' || decisionRequired?.type === 'context_mismatch';
  if ((task.status === 'needs_human_input' || isContextMismatch) && !decisionRequired) {
    if (isContextMismatch) {
      decisionRequired = {
        type: 'context_mismatch',
        reasonCode: 'CONTEXT_MISMATCH',
        title: 'Deliverable Context Mismatch Detected',
        question: 'Cross-project or stale deliverable context detected. Automatic revision is prohibited.',
        reason: 'A context mismatch was detected between the task instruction/project and the deliverable artifacts. Because cross-task contamination occurred, automatic revision is prohibited.',
        recommendation: 'Reject Draft & Rerun Cleanly from a fresh isolated context.',
        options: [
          { id: 'reject_rerun', label: 'Reject Draft & Rerun Cleanly', recommended: true },
          { id: 'cancel', label: 'Cancel / Leave Task Paused', recommended: false }
        ]
      };
    } else {
      decisionRequired = {
        type: 'claude_reserve',
        title: 'Decision Required',
        question: 'Claude Code would be useful for this task. Use Claude quota?',
        reason: 'Claude Reserve Mode is ON to preserve your Claude Pro quota for Cowork browser and desktop usage. You can choose to authorize Claude or proceed with the next-best worker.',
        recommended: 'Preserve Claude — Use Next Best Worker (Antigravity)',
        options: [
          { id: 'preserve_claude', label: 'Preserve Claude — Use Next Best Worker', recommended: true, worker: 'antigravity' },
          { id: 'use_claude', label: 'Use Claude', recommended: false, worker: 'claude-code' }
        ]
      };
    }
  } else if (decisionRequired && isContextMismatch) {
    decisionRequired.options = [
      { id: 'reject_rerun', label: 'Reject Draft & Rerun Cleanly', recommended: true },
      { id: 'cancel', label: 'Cancel / Leave Task Paused', recommended: false }
    ];
  }

  let activityLog = (task.activityLog?.length ? task.activityLog : events.filter(e => e.type === 'activity').map(e => ({
    time: e.time,
    icon: e.icon,
    title: e.title,
    desc: e.desc,
    category: e.category || 'worker',
    bullets: e.bullets,
    reportAvailable: e.reportAvailable
  }))).map(item => {
    let category = item.category;
    if (!category) {
      if (/instruction/i.test(item.title)) category = 'instruction';
      else if (/specialist|selected|transition|resumed/i.test(item.title)) category = 'router';
      else if (/decision|quota/i.test(item.title)) category = 'decision';
      else if (/test passed|ready for approval|accepted|verdict/i.test(item.title)) category = 'result';
      else category = 'worker';
    }
    // Clean up desc if it contains an entire multi-line markdown prompt
    let desc = item.desc || '';
    let details = item.details || null;
    if (category === 'instruction' && (desc.includes('\n') || desc.length > 150)) {
      details = desc;
      const firstLine = desc.trim().split(/\r?\n/).find(l => l.trim().length > 0) || 'Instruction received';
      desc = firstLine.replace(/^#+\s*/, '').slice(0, 100);
    }
    return { ...item, category, desc, details };
  });

  if (!activityLog.length) {
    const buildLog = task.routingLog?.find(r => r.role === 'build');
    const reviewLog = task.routingLog?.find(r => r.role === 'review');
    const createdTime = task.created || new Date().toISOString();

    const firstLine = (task.instruction || '').trim().split(/\r?\n/).find(l => l.trim().length > 0) || 'Objective provided';
    const cleanTitle = firstLine.replace(/^#+\s*/, '').slice(0, 100);

    activityLog = [
      { time: createdTime, icon: '⚡', title: 'Task Initiated', desc: `Business instruction: "${cleanTitle}"`, category: 'instruction' }
    ];

    if (task.specialist || buildLog?.specialist) {
      activityLog.push({
        time: createdTime,
        icon: '🎯',
        title: 'Specialist Matched',
        desc: `Loaded specialist expertise: ${task.specialistName || buildLog?.specialistName || task.specialist || buildLog?.specialist}`,
        category: 'router'
      });
    }

    if (buildLog || task.builder) {
      activityLog.push({
        time: createdTime,
        icon: '🤖',
        title: 'Worker Selected',
        desc: `Selected ${(buildLog?.worker || task.builder).toUpperCase()} using ${buildLog?.model || 'Standard'} [effort: ${buildLog?.effort || 'medium'}]`,
        category: 'router'
      });
    }

    if (task.status !== 'failed') {
      activityLog.push({
        time: createdTime,
        icon: '🛠️',
        title: 'Deliverable Drafted',
        desc: 'Builder completed code drafting in isolated sandbox workspace.',
        category: 'worker'
      });
    }

    if (tests?.passed) {
      activityLog.push({
        time: tests.time || createdTime,
        icon: '🧪',
        title: 'Automated Tests Passed',
        desc: `Isolated headless Chrome verified ${tests.checks?.length || 0} automated browser checks.`,
        category: 'result'
      });
    }

    if (review?.verdict === 'pass') {
      activityLog.push({
        time: createdTime,
        icon: '🔍',
        title: 'Independent Review Approved',
        desc: `Audited independently by ${(review.worker || task.reviewer || 'Reviewer').toUpperCase()} with zero defects.`,
        category: 'result'
      });
    }

    if (task.status === 'awaiting_approval') {
      activityLog.push({
        time: createdTime,
        icon: '✅',
        title: 'Ready for Your Approval',
        desc: 'All automated tests passed and independent audit approved. Deliverable presented for decision.',
        category: 'result'
      });
    } else if (task.status === 'approved') {
      activityLog.push({
        time: task.approvalData?.time || createdTime,
        icon: '🎉',
        title: 'Deliverable Accepted',
        desc: task.approvalData?.reason || 'Approved and accepted locally.',
        category: 'result'
      });
    }
  }

  const project = task.project || (task.kind === 'system' || /adaptive\s*router|dashboard|planning\s*chat|workflow/i.test(task.instruction || '') ? 'adaptive-router' : 'test-site');
  let registeredProject = null;
  try { registeredProject = getProject(root, project, { includeHidden: true }); } catch {}
  const projectName = task.projectName || registeredProject?.name || (project === 'adaptive-router' ? 'Adaptive Router System' : 'Adaptive Router Test Project');
  const kind = task.kind || (project === 'adaptive-router' ? 'system' : 'web');
  const hasPreviewImage = fs.existsSync(path.join(dir, 'deliverable-preview.png'));
  const deliverablePreviewUrl = hasPreviewImage ? `/api/tasks/${id}/deliverable-preview` : null;
  const pendingPermissions = getPendingPermissions(id);
  const workerEvents = loadTaskEvents(root, id);

  let failure = task.failure;
  if (task.status === 'failed' && !failure) {
    failure = formatTaskFailure({
      error: task.error,
      task
    });
  }

  if (task.status === 'failed' && failure) {
    const hasFailedActivity = activityLog.some(a => a.title === 'Task Failed' || a.category === 'error');
    if (!hasFailedActivity) {
      activityLog.push({
        time: task.created || new Date().toISOString(),
        icon: '❌',
        title: 'Task Failed',
        desc: failure.reason || task.error || 'Task execution failed.',
        category: 'error',
        details: failure.technicalError || task.error
      });
    }
  }

  let contextIntegrity = { valid: false, reasonCode: 'CONTEXT_MISMATCH', reason: 'Legacy task lacks a verifiable task/project context binding. Reject it and rerun cleanly before approval.' };
  if (task.schemaVersion === 2 && task.contextHash && task.projectRoot && task.baselineDigest && task.acceptanceCriteria) {
    const expected = hash({ taskId: task.id, project: task.project, projectRoot: path.resolve(task.projectRoot), instruction: task.instruction, acceptanceCriteria: task.acceptanceCriteria, baselineDigest: task.baselineDigest });
    const artifacts = [manifest, tests, review].filter(Boolean);
    const stageBState = ['awaiting_approval', 'approved', 'rejected'].includes(task.status);
    const requiredArtifactsPresent = !stageBState || Boolean(manifest && tests && review);
    const bound = requiredArtifactsPresent && expected === task.contextHash && registeredProject && path.resolve(registeredProject.rootPath) === path.resolve(task.projectRoot) && artifacts.every(artifact =>
      artifact.taskId === task.id && artifact.project === task.project && artifact.contextHash === task.contextHash && path.resolve(artifact.projectRoot || '') === path.resolve(task.projectRoot)
    );
    contextIntegrity = bound
      ? { valid: true, contextHash: task.contextHash }
      : { valid: false, reasonCode: 'CONTEXT_MISMATCH', reason: 'Task, project, deliverable, validator, or reviewer bindings do not match.' };
  }

  return {
    ...task,
    failure: failure || null,
    workerEvents,
    project,
    projectName,
    kind,
    deliverablePreviewUrl,
    decisionRequired,
    activityLog,
    taskProgress: activityLog,
    pendingPermissions,
    events,
    tests,
    review,
    manifest,
    changes,
    contextIntegrity,
    approvalReport,
    approvalData,
    failoverEvents
  };
}

// Statuses that only ever mean "a worker process is actively running this
// task right now" — never a paused/waiting/terminal state a human or the
// auto-retry logic is meant to find sitting still. If the dashboard server
// stops (a crash, a manual restart, an update like this one) while a task is
// at one of these statuses, the in-memory record of what was running dies
// with the old process, but the on-disk task.json is left exactly as it
// was — permanently stuck, since nothing else ever writes to it again. That
// orphaned task is invisible to both the resumable-status allowlist in
// coding.mjs (so even a manual "Retry Now" fails with "Only a waiting
// coding task can be resumed") and to the auto-retry mechanism above (which
// only watches waiting_for_worker/waiting_for_reviewer). This is exactly
// what happened to a real build task here: it was silently dead for good
// after a routine restart, with no error, no retry option, and no visible
// sign anything was wrong beyond stale timestamps.
const ORPHANABLE_STATUSES = new Set(['building', 'testing', 'reviewing', 'created']);

function recoverOrphanedTasks(root) {
  const tasksDir = path.join(root, '.router', 'tasks');
  if (!fs.existsSync(tasksDir)) return;
  let entries;
  try { entries = fs.readdirSync(tasksDir).filter(id => /^\d{8}T\d{6}-[a-f0-9]{8}$/.test(id)); } catch { return; }
  for (const id of entries) {
    const dir = path.join(tasksDir, id);
    const taskPath = path.join(dir, 'task.json');
    let task;
    try { task = read(taskPath); } catch { continue; }

    if (ORPHANABLE_STATUSES.has(task.status)) {
      // This process just started, so nothing can legitimately still be
      // running this task — it can only be a leftover from before the
      // previous process stopped. Demote it to the same stalled state a
      // normal "every worker failed" outcome leaves behind, so the existing
      // Retry Now button and auto-retry scheduling both just work on it,
      // rather than inventing a separate recovery path.
      const staleStatus = task.status;
      task.status = 'waiting_for_worker';
      task.activityLog = task.activityLog || [];
      const item = {
        time: new Date().toISOString(),
        icon: '🔁',
        title: 'Recovered After Restart',
        desc: `This task was still "${staleStatus}" when Adaptive Router last stopped — no worker is actually running it anymore. Marked as stalled so it can be retried.`,
        category: 'router'
      };
      task.activityLog.push(item);
      try {
        event(dir, 'activity', item);
        json(taskPath, task);
        console.log(`Recovered orphaned task ${id} (was "${staleStatus}")`);
      } catch (err) {
        console.error(`Failed to recover orphaned task ${id}:`, err.message);
        continue;
      }
    }

    // Also (re-)schedule auto-retry for anything already sitting stalled,
    // whether it was just demoted above or was already at
    // waiting_for_worker/waiting_for_reviewer before this restart (e.g. it
    // stalled, then the server stopped before its retry timer ever fired,
    // or before this auto-retry feature existed at all). Any in-memory
    // autoRetryState from the previous process is gone on a fresh start, so
    // without this, such a task would sit untouched forever, needing a
    // manual click — the exact problem this whole mechanism exists to
    // remove. maybeScheduleAutoRetry() itself re-checks the current status
    // and no-ops for anything not actually stalled, so it's safe to call
    // unconditionally here.
    maybeScheduleAutoRetry(root, task.project, id);
  }
}

export function createDashboardServer(root, options = {}) {
  const webDir = path.join(root, 'src', 'web');

  // See ORPHANABLE_STATUSES above — this must run before anything else
  // touches tasks, so a stuck task is fixed before the dashboard or
  // auto-retry ever look at it.
  recoverOrphanedTasks(root);

  // A permission card (e.g. "Authorize Claude Pro Quota?") that nobody
  // answers used to hang its task's worker forever with no visible
  // explanation — the card would eventually stop showing (e.g. after a
  // dashboard refresh) with no record of why. permissions.mjs now
  // auto-resolves those as "deny" after a bounded wait; this listener turns
  // that into a plain activity entry in the same Live Activity feed the
  // task's other events already show up in, so it's clear the task moved on
  // because nobody answered in time, not that it silently vanished.
  onPermissionTimeout(({ taskId, description, worker }) => {
    persistRouterActivity(
      root,
      taskId,
      '⌛',
      'Permission Request Timed Out',
      `No response to "${description || 'a permission request'}" (${worker || 'worker'}) within 15 minutes — automatically denied so the task could continue or fail over.`
    );
  });

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(parsedUrl.pathname);
    const method = req.method.toUpperCase();

    // Helper to send JSON responses
    const sendJson = (data, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store'
      });
      res.end(JSON.stringify(data));
    };

    // Helper to read JSON request body
    const readBody = () => new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 1e6) { req.destroy(); reject(Error('Payload too large')); }
      });
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch (e) { reject(Error('Invalid JSON body')); }
      });
      req.on('error', reject);
    });

    try {
      // ── Connector CORS headers (allow ChatGPT origin) ─────────────────────
      if (pathname.startsWith('/mcp') || pathname.startsWith('/api/connector')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }
        // Bearer token authentication
        // Exempt: token/copy and token/rotate (have their own localhost guards),
        //         openapi.yaml (public spec), tunnel/status, tunnel/start (local-only UI calls)
        const isExempt = pathname === '/api/connector/token/copy'
          || pathname === '/api/connector/token'
          || pathname === '/api/connector/token/rotate'
          || pathname === '/api/connector/openapi.yaml'
          || pathname === '/api/tunnel/status'
          || pathname === '/api/tunnel/start';
        if (!isExempt) {
          const connectorToken = getOrCreateConnectorToken(root);
          const authHeader = req.headers['authorization'] || '';
          const providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
          if (providedToken !== connectorToken) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Unauthorized. Provide the connector token in the Authorization: Bearer <token> header.' }));
          }
        }
      }

      // ── MCP Protocol Endpoint ─────────────────────────────────────────────
      // GET /mcp  — health/info
      if (pathname === '/mcp' && method === 'GET') {
        return sendJson({
          name: 'adaptive-router',
          version: '1.0.0',
          description: 'Adaptive Router MCP connector — AI task routing and workforce management',
          tools: ALL_TOOLS.length,
          readTools: ALL_TOOLS.filter(t => t.annotations?.readOnlyHint).length,
          writeTools: ALL_TOOLS.filter(t => !t.annotations?.readOnlyHint).length
        });
      }

      // POST /mcp  — MCP JSON-RPC 2.0
      if (pathname === '/mcp' && method === 'POST') {
        const body = await readBody();
        const response = await handleMcpRequest(root, body);
        return sendJson(response);
      }

      // ── REST Connector Endpoints (/api/connector/*) ───────────────────────
      // Served alongside MCP for ChatGPT Work bridge and future use

      if (pathname === '/api/connector/status' && method === 'GET') {
        return sendJson(getProjectStatus(root));
      }
      if (pathname === '/api/connector/projects' && method === 'GET') {
        return sendJson(listProjects(root));
      }
      if (pathname === '/api/connector/tasks' && method === 'GET') {
        const limit = parseInt(parsedUrl.searchParams.get('limit') || '10');
        return sendJson(listRecentTasksConnector(root, Math.min(limit, 30)));
      }
      const connTaskMatch = pathname.match(/^\/api\/connector\/tasks\/(\d{8}T\d{6}-[a-f0-9]{8})(\/(.+))?$/);
      if (connTaskMatch) {
        const taskId = connTaskMatch[1];
        const sub = connTaskMatch[3];
        if (method === 'GET') {
          if (!sub) return sendJson(getTaskStatus(root, taskId));
          if (sub === 'progress') return sendJson(getLiveProgress(root, taskId));
          if (sub === 'tests') return sendJson(getTestResults(root, taskId));
          if (sub === 'review') return sendJson(getReviewerFindings(root, taskId));
          if (sub === 'deliverable') return sendJson(getDeliverableSummary(root, taskId));
          if (sub === 'approval') return sendJson(getApprovalState(root, taskId));
          if (sub === 'failovers') return sendJson(getFailoversAndErrors(root, taskId));
        }
        if (method === 'POST') {
          const body = await readBody();
          if (sub === 'approve') return sendJson(approveTask(root, taskId, { reason: body.reason }));
          if (sub === 'reject') return sendJson(rejectTask(root, taskId, { reason: body.reason }));
        }
      }
      if (pathname === '/api/connector/tasks' && method === 'POST') {
        const body = await readBody();
        return sendJson(await submitTask(root, { instruction: body.instruction, project: body.project, allowClaude: body.allow_claude }));
      }
      if (pathname === '/api/connector/claude-reserve' && method === 'POST') {
        const body = await readBody();
        return sendJson(toggleClaudeReserve(root, body.enabled));
      }

      // OpenAPI spec for ChatGPT connector discovery
      if (pathname === '/api/connector/openapi.yaml' && method === 'GET') {
        const specPath = path.join(root, 'connector-openapi.yaml');
        if (fs.existsSync(specPath)) {
          res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Cache-Control': 'no-cache' });
          return res.end(fs.readFileSync(specPath));
        }
        return sendJson({ error: 'OpenAPI spec not found' }, 404);
      }

      // Connector token — secure copy endpoint (localhost only, clipboard use)
      // SECURITY: no logging of token value; cache disabled; CORS blocked by host check
      if ((pathname === '/api/connector/token/copy' || pathname === '/api/connector/token') && method === 'GET') {
        const host = req.headers.host || '';
        const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
        if (!isLocal) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Token copy endpoint is only accessible from the local Adaptive Router dashboard.' }));
        }
        const connectorToken = getOrCreateConnectorToken(root);
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'X-Content-Type-Options': 'nosniff'
        });
        return res.end(connectorToken);
      }

      // Connector token rotation (localhost only)
      if (pathname === '/api/connector/token/rotate' && method === 'POST') {
        const host = req.headers.host || '';
        const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
        if (!isLocal) {
          return sendJson({ error: 'Token rotation only accessible from localhost.' }, 403);
        }
        return sendJson(rotateConnectorToken(root));
      }

      // Tunnel status — reads .mcp_tunnel_url file written by tunnel-client
      if (pathname === '/api/tunnel/status' && method === 'GET') {
        return sendJson(getTunnelStatus(root));
      }

      // Tunnel start stub — implementation added after user provides tunnel ID + exe path
      if (pathname === '/api/tunnel/start' && method === 'POST') {
        return sendJson({ started: false, note: 'Tunnel configuration not yet set. Please provide your Tunnel ID and tunnel-client.exe location.' });
      }

      // 1. GET /api/status - System and worker statuses
      if (pathname === '/api/status' && method === 'GET') {
        const requestedProject = parsedUrl.searchParams.get('project');
        const status = await getWorkerStatuses(root, requestedProject);
        return sendJson(status);
      }

      // Project registry — production projects only. Hidden fixtures remain
      // available to automated tests but never appear in this UI response.
      if (pathname === '/api/projects' && method === 'GET') {
        const activeProject = getActiveProject(root);
        return sendJson({ projects: listRegisteredProjects(root), activeProjectId: activeProject.id, defaultFolder: defaultProjectsFolder(root) });
      }
      if (pathname === '/api/projects' && method === 'POST') {
        const body = await readBody();
        const project = createProject(root, body);
        return sendJson({ success: true, project }, 201);
      }
      if (pathname === '/api/projects/active' && method === 'POST') {
        const body = await readBody();
        const project = setActiveProject(root, body.projectId);
        return sendJson({ success: true, project });
      }
      if (pathname === '/api/projects' && method === 'DELETE') {
        const body = await readBody();
        try {
          const TERMINAL_STATUSES = new Set(['approved', 'rejected', 'failed']);
          const result = deleteProject(root, body.projectId, {
            deleteFolder: Boolean(body.deleteFolder),
            hasActiveTask(projectId) {
              const active = getActiveTask(root, projectId);
              return Boolean(active);
            }
          });
          return sendJson({ success: true, ...result });
        } catch (e) {
          return sendJson({ error: e.message }, 400);
        }
      }

      // 2. POST /api/claude-reserve - Toggle Claude Reserve Mode
      if (pathname === '/api/claude-reserve' && method === 'POST') {
        const body = await readBody();
        const configPath = path.join(root, 'workers.json');
        const cfg = read(configPath);
        cfg.claudeReserve = Boolean(body.enabled);
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
        return sendJson({ success: true, claudeReserve: cfg.claudeReserve });
      }

      // 2a. POST /api/workers/toggle - Manually enable/disable a worker platform
      // for routing (Codex / Claude Code / Antigravity / Cline switches).
      // Turning a switch off only affects routing decisions made from this
      // point forward — a task already in progress on that worker keeps
      // running to completion; it just won't be picked again for new tasks
      // or failover until switched back on.
      if (pathname === '/api/workers/toggle' && method === 'POST') {
        const body = await readBody();
        const workerId = String(body.workerId || '');
        const enabled = Boolean(body.enabled);
        const TOGGLEABLE_WORKER_IDS = new Set(['codex', 'claude-code', 'antigravity', 'cline']);
        if (!TOGGLEABLE_WORKER_IDS.has(workerId)) {
          return sendJson({ error: `Unknown or non-toggleable worker id: ${workerId}` }, 400);
        }
        const configPath = path.join(root, 'workers.json');
        const cfg = read(configPath);
        let matched = false;
        for (const w of cfg.workers) {
          if (w.id === workerId) { w.enabled = enabled; matched = true; }
        }
        if (!matched) return sendJson({ error: `Worker not found in config: ${workerId}` }, 404);
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
        return sendJson({ success: true, workerId, enabled });
      }

      // 2b. GET /api/permissions - Pending permission requests
      if (pathname === '/api/permissions' && method === 'GET') {
        const projectFilter = parsedUrl.searchParams.get('project');
        const perms = getPendingPermissions().filter(permission => {
          if (!projectFilter) return true;
          if (permission.projectId) return permission.projectId === projectFilter;
          if (!permission.taskId || permission.taskId === 'current') return false;
          try { return read(path.join(taskDir(root, permission.taskId), 'task.json')).project === projectFilter; }
          catch { return false; }
        });
        return sendJson(perms);
      }

      // 2c. POST /api/permissions/open-app - Open native worker application
      if (pathname === '/api/permissions/open-app' && method === 'POST') {
        const body = await readBody();
        const resApp = openNativeApp(body.worker || 'claude');
        return sendJson(resApp);
      }

      // 2d. POST /api/permissions/demo - Trigger a demo permission request
      if (pathname === '/api/permissions/demo' && method === 'POST') {
        const body = await readBody().catch(() => ({}));
        requestPermission('demo-task-01', {
          type: 'action_approval',
          description: body.description || 'Run Command: npm install --save-dev @testing-library/react',
          worker: body.worker || 'codex',
          action: 'run_command',
          requiresNativeApp: false,
          canRemember: true,
          details: {
            reason: body.reason || 'Codex is requesting permission to run a package installation command on the system.'
          }
        });
        return sendJson({ success: true, message: 'Demo permission requested' });
      }

      // 2e. POST /api/permissions/:id - Resolve a pending permission request
      const permMatch = pathname.match(/^\/api\/permissions\/([a-zA-Z0-9_-]+)$/);
      if (permMatch && method === 'POST') {
        const permId = permMatch[1];
        const body = await readBody();
        const resolved = resolvePermission(root, permId, {
          decision: body.decision || 'allow_once',
          remember: Boolean(body.remember),
          projectId: body.projectId || getActiveProject(root).id
        });
        return sendJson({ success: resolved });
      }

      // 2c3. GET /api/tasks/cost-hint - Plain-language "what this will likely use" preview,
      // computed the same way real routing decides, but without creating a task.
      if (pathname === '/api/tasks/cost-hint' && method === 'GET') {
        const instruction = (parsedUrl.searchParams.get('instruction') || '').trim();
        const allowClaude = parsedUrl.searchParams.get('allowClaude') === 'true';
        if (!instruction) return sendJson({ hint: '' });

        const sensitivity = classifySensitivity(instruction);
        if (sensitivity.sensitive) {
          return sendJson({ hint: 'This looks like it involves credentials or account access — Claude (CTO) will handle this personally, not a worker model.', sensitive: true });
        }

        const configPath = path.join(root, 'workers.json');
        const cfg = read(configPath);
        const claudeReserve = cfg.claudeReserve !== false;
        const classification = classifyTask(instruction, null, 0, { claudeReserve, allowClaude });

        let hint;
        if (classification.preferredPlatform === 'cline') {
          hint = 'This will likely use Cline — lower-cost execution.';
        } else if (classification.preferredPlatform === 'claude-code') {
          hint = allowClaude
            ? 'This will likely use Claude Code, using your Claude Pro quota.'
            : 'This would benefit from Claude Code, but Claude Reserve Mode is ON — it will ask you before using Claude quota (or route to the next-best worker automatically).';
        } else if (classification.preferredPlatform === 'antigravity') {
          hint = 'This will likely use Antigravity (Google), using your Gemini access.';
        } else {
          hint = 'This will likely use Codex, using your ChatGPT Plus quota.';
        }
        return sendJson({ hint, difficulty: classification.difficulty, preferredPlatform: classification.preferredPlatform });
      }

      // 2c. GET /api/staff-activity - Plain-language log of staff completions
      if (pathname === '/api/staff-activity' && method === 'GET') {
        const limit = Math.min(Math.max(parseInt(parsedUrl.searchParams.get('limit') || '20', 10) || 20, 1), 200);
        return sendJson({ activity: getRecentStaffActivity(root, { limit }) });
      }

      // 3. GET /api/tasks - List recent tasks
      if (pathname === '/api/tasks' && method === 'GET') {
        const projectFilter = parsedUrl.searchParams.get('project') || getActiveProject(root).id;
        const tasks = listRecentTasks(root, projectFilter);
        return sendJson(tasks);
      }

      // 4. POST /api/tasks - Launch new task
      if (pathname === '/api/tasks' && method === 'POST') {
        const body = await readBody();
        const instruction = (body.instruction || '').trim();
        if (!instruction) {
          return sendJson({ error: 'Instruction cannot be empty' }, 400);
        }

        // Check lock
        const lockPath = path.join(root, '.router', 'router.lock');
        if (fs.existsSync(lockPath)) {
          let isStale = false;
          try {
            const staleOwner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            if (staleOwner?.pid) {
              try { process.kill(staleOwner.pid, 0); } catch (e) { if (e.code === 'ESRCH') isStale = true; }
            }
          } catch {}
          if (isStale) {
            try { fs.unlinkSync(lockPath); } catch {}
          } else {
            return sendJson({ error: 'Another task is currently running. Please wait for it to complete.' }, 409);
          }
        }

        // Run task asynchronously
        const allowClaude = Boolean(body.allowClaude);
        const unavailableBuilders = Array.isArray(body.unavailableBuilders) ? body.unavailableBuilders : [];
        const project = body.project || getActiveProject(root).id;
        getProject(root, project, { includeHidden: true });

        const activeTask = getActiveTask(root, project);
        if (activeTask) {
          return sendJson({
            error: `Another task (${activeTask.id}) is currently active (${activeTask.status}). Please wait for it to complete or stop it before starting a new task.`,
            activeTaskId: activeTask.id,
            activeTaskStatus: activeTask.status
          }, 409);
        }

        const abortController = new AbortController();

        // Kick off execution in background
        (async () => {
          try {
            activeRunningTask = 'running';
            await codeTask(root, instruction, {
              project,
              allowClaude,
              unavailableBuilders,
              signal: abortController.signal,
              confirmClaudeUse: async (promptMsg) => {
                const taskId = activeRunningTask && activeRunningTask !== 'running' ? activeRunningTask : 'current';
                const permResult = await requestPermission(taskId, {
                  type: 'claude_quota',
                  description: promptMsg,
                  worker: 'claude-code',
                  action: 'use_claude_quota',
                  projectId: project,
                  canRemember: true
                });
                if (permResult.decision === 'stop_task') throw Error('TASK_STOPPED');
                return permResult.decision === 'allow_once' || permResult.decision === 'allow_task';
              },
              log: (msg) => {
                if (activeRunningTask && activeRunningTask !== 'running') {
                  broadcastTaskEvent(activeRunningTask, { type: 'log', message: msg });
                }
              },
              onWorkerEvent: (event) => {
                if (activeRunningTask === 'running' && event.taskId) activeRunningTask = event.taskId;
                const targetId = activeRunningTask && activeRunningTask !== 'running' ? activeRunningTask : (event.taskId || 'current');
                broadcastTaskEvent(targetId, { type: 'worker_event', event });
              },
              onActivity: (item) => {
                if (activeRunningTask && activeRunningTask !== 'running') {
                  broadcastTaskEvent(activeRunningTask, { type: 'activity', item });
                }
              }
            });
          } catch (err) {
            console.error('Task background error:', err.message);
          } finally {
            const finishedTaskId = activeRunningTask && activeRunningTask !== 'running' ? activeRunningTask : null;
            if (finishedTaskId) activeTaskAbortControllers.delete(finishedTaskId);
            activeRunningTask = null;
            if (finishedTaskId) maybeScheduleAutoRetry(root, project, finishedTaskId);
          }
        })();

        // Briefly wait to capture the newly generated task ID
        await new Promise(r => setTimeout(r, 120));
        const recent = listRecentTasks(root, project);
        const newest = recent[0];
        if (newest) {
          activeRunningTask = newest.id;
          activeTaskAbortControllers.set(newest.id, abortController);
        }

        return sendJson({ success: true, taskId: newest?.id || null, status: 'started' });
      }

      // 5. GET /api/tasks/:id - Get task detail
      const taskDetailMatch = pathname.match(/^\/api\/tasks\/(\d{8}T\d{6}-[a-f0-9]{8})$/);
      if (taskDetailMatch && method === 'GET') {
        const taskId = taskDetailMatch[1];
        try {
          const detail = getTaskDetails(root, taskId);
          return sendJson(detail);
        } catch (e) {
          return sendJson({ error: e.message }, 404);
        }
      }

      // 5b. GET /api/tasks/:id/deliverable-preview - Deliverable screenshot for system tasks
      const deliverablePreviewMatch = pathname.match(/^\/api\/tasks\/(\d{8}T\d{6}-[a-f0-9]{8})\/deliverable-preview$/);
      if (deliverablePreviewMatch && method === 'GET') {
        const taskId = deliverablePreviewMatch[1];
        try {
          const dir = taskDir(root, taskId);
          const imgPath = path.join(dir, 'deliverable-preview.png');
          if (fs.existsSync(imgPath)) {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
            return fs.createReadStream(imgPath).pipe(res);
          }
        } catch {}
        return sendJson({ error: 'No preview image found' }, 404);
      }

      // 5c. POST /api/tasks/:id/execute-plan - Stage A: Plan Approval execution
      const executePlanMatch = pathname.match(/^\/api\/tasks\/(\d{8}T\d{6}-[a-f0-9]{8})\/execute-plan$/);
      if (executePlanMatch && method === 'POST') {
        const taskId = executePlanMatch[1];
        try {
          const t = read(path.join(taskDir(root, taskId), 'task.json'));
          (async () => {
            try {
              activeRunningTask = taskId;
              await codeTask(root, t.instruction, {
                resume: taskId,
                onWorkerEvent: (event) => broadcastTaskEvent(taskId, { type: 'worker_event', event }),
                onActivity: (item) => broadcastTaskEvent(taskId, { type: 'activity', item }),
                log: (msg) => broadcastTaskEvent(taskId, { type: 'log', message: msg })
              });
            } catch (err) {
              console.error('Execute plan error:', err.message);
            } finally {
              activeRunningTask = null;
              maybeScheduleAutoRetry(root, t.project, taskId);
            }
          })();
          return sendJson({ success: true, taskId, status: 'executing' });
        } catch (e) {
          return sendJson({ error: e.message }, 400);
        }
      }

      // 6. POST /api/tasks/:id/decide - Human approval decision
      const taskDecideMatch = pathname.match(/^\/api\/tasks\/(\d{8}T\d{6}-[a-f0-9]{8})\/decide$/);
      if (taskDecideMatch && method === 'POST') {
        const taskId = taskDecideMatch[1];
        const body = await readBody();
        const decision = body.decision;
        const reason = body.reason || '';

        if (!['approved', 'rejected', 'correct'].includes(decision)) {
          return sendJson({ error: 'Decision must be "approved", "rejected", or "correct"' }, 400);
        }

        if (decision === 'correct') {
          // Send back for correction with user feedback
          const t = read(path.join(taskDir(root, taskId), 'task.json'));
          if (body.project && t.project !== body.project) return sendJson({ error: 'Task does not belong to the active project' }, 409);
          if (t.reasonCode === 'CONTEXT_MISMATCH' || t.status === 'context_mismatch' || t.decisionRequired?.reasonCode === 'CONTEXT_MISMATCH' || t.decisionRequired?.type === 'context_mismatch') {
            return sendJson({ error: 'Automatic revision is prohibited for tasks with context mismatch. Use clean rerun.' }, 400);
          }
          if (t.schemaVersion !== 2 || !t.contextHash) return sendJson({ error: 'Legacy/unbound task cannot be revised. Use Reject Draft & Rerun Cleanly.' }, 400);
          if (t.status !== 'awaiting_approval') {
            return sendJson({ error: 'Task must be awaiting approval to request correction' }, 400);
          }
          // Resume task with user feedback
          (async () => {
            try {
              activeRunningTask = taskId;
              await codeTask(root, t.instruction, {
                resume: taskId,
                feedback: { userComment: reason },
                onWorkerEvent: (event) => broadcastTaskEvent(taskId, { type: 'worker_event', event }),
                onActivity: (item) => broadcastTaskEvent(taskId, { type: 'activity', item }),
                log: (msg) => broadcastTaskEvent(taskId, { type: 'log', message: msg })
              });
            } catch (err) {
              console.error('Correction error:', err.message);
            } finally {
              activeRunningTask = null;
              maybeScheduleAutoRetry(root, t.project, taskId);
            }
          })();
          return sendJson({ success: true, status: 'resumed_correction' });
        }

        // Run decide
        try {
          const t = read(path.join(taskDir(root, taskId), 'task.json'));
          if (body.project && t.project !== body.project) return sendJson({ error: 'Task does not belong to the active project' }, 409);
          const updated = await decide(root, taskId, decision, reason);
          return sendJson({ success: true, task: updated });
        } catch (e) {
          return sendJson({ error: e.message }, 400);
        }
      }

      // 6b. POST /api/tasks/:id/resume - Resume paused task from human-input gate or decision
      const taskResumeMatch = pathname.match(/^\/api\/tasks\/(\d{8}T\d{6}-[a-f0-9]{8})\/resume$/);
      if (taskResumeMatch && method === 'POST') {
        const taskId = taskResumeMatch[1];
        const body = await readBody();
        const decision = body.decision || 'preserve_claude';

        if (decision === 'reject_rerun' || decision === 'rerun_clean' || decision === 'retry_same_worker' || decision === 'retry_other_worker') {
          // Delegate to clean rerun logic
          clearAutoRetry(taskId, root); // superseded by the new clean-rerun task below
          try {
            const oldDir = taskDir(root, taskId);
            const oldTask = read(path.join(oldDir, 'task.json'));

            const isCleanRerun = decision === 'reject_rerun' || decision === 'rerun_clean';
            if (isCleanRerun) {
              oldTask.status = 'rejected';
              oldTask.reasonCode = 'CONTEXT_MISMATCH';
              oldTask.rejectionReason = 'Rejected due to CONTEXT_MISMATCH — Clean rerun initiated';
              oldTask.approval = {
                decision: 'rejected',
                reason: 'Rejected due to CONTEXT_MISMATCH — Clean rerun initiated',
                digest: oldTask.digest || 'contaminated',
                time: new Date().toISOString(),
                actor: 'user-rerun-clean',
                scope: 'rejected contaminated draft; clean rerun scheduled'
              };
              json(path.join(oldDir, 'task.json'), oldTask);
              json(path.join(oldDir, 'approval.json'), oldTask.approval);
              event(oldDir, 'rejected', { reason: oldTask.rejectionReason });
            }

            const cleanInstruction = oldTask.instruction;
            const cleanProject = oldTask.project || (oldTask.kind === 'system' ? 'adaptive-router' : 'test-site');
            const allowClaude = Boolean(oldTask.allowClaudeForTask || oldTask.claudeQuotaAuthorized);
            const preferredWorker = decision === 'retry_same_worker' ? (oldTask.failure?.worker || oldTask.builderWorker || undefined) : undefined;
            const unavailableBuilders = decision === 'retry_other_worker' ? [oldTask.failure?.worker || oldTask.builderWorker].filter(Boolean) : [];

            (async () => {
              try {
                activeRunningTask = 'running';
                await codeTask(root, cleanInstruction, {
                  project: cleanProject,
                  allowClaude,
                  preferredWorker,
                  unavailableBuilders,
                  confirmClaudeUse: async (promptMsg) => {
                    const currentId = activeRunningTask && activeRunningTask !== 'running' ? activeRunningTask : 'current';
                    const permResult = await requestPermission(currentId, {
                      type: 'claude_quota',
                      description: promptMsg,
                      worker: 'claude-code',
                      action: 'use_claude_quota',
                      projectId: cleanProject,
                      canRemember: true
                    });
                    if (permResult.decision === 'stop_task') throw Error('TASK_STOPPED');
                    return permResult.decision === 'allow_once' || permResult.decision === 'allow_task';
                  },
                  log: (msg) => {
                    if (activeRunningTask && activeRunningTask !== 'running') {
                      broadcastTaskEvent(activeRunningTask, { type: 'log', message: msg });
                    }
                  },
                  onWorkerEvent: (event) => {
                    if (activeRunningTask === 'running' && event.taskId) activeRunningTask = event.taskId;
                    const targetId = activeRunningTask && activeRunningTask !== 'running' ? activeRunningTask : (event.taskId || 'current');
                    broadcastTaskEvent(targetId, { type: 'worker_event', event });
                  },
                  onActivity: (item) => {
                    if (activeRunningTask && activeRunningTask !== 'running') {
                      broadcastTaskEvent(activeRunningTask, { type: 'activity', item });
                    }
                  }
                });
              } catch (err) {
                console.error('Clean rerun background error:', err.message);
              } finally {
                const finishedTaskId = activeRunningTask && activeRunningTask !== 'running' ? activeRunningTask : null;
                activeRunningTask = null;
                if (finishedTaskId) maybeScheduleAutoRetry(root, cleanProject, finishedTaskId);
              }
            })();

            await new Promise(r => setTimeout(r, 200));
            const recent = listRecentTasks(root, cleanProject);
            const newest = recent.find(t => t.id !== taskId);
            if (newest) activeRunningTask = newest.id;

            return sendJson({ success: true, oldTaskId: taskId, taskId: newest?.id || null, status: 'started' });
          } catch (e) {
            return sendJson({ error: e.message }, 400);
          }
        }

        const taskPath = path.join(taskDir(root, taskId), 'task.json');
        if (!fs.existsSync(taskPath)) return sendJson({ error: 'Task not found' }, 404);
        const t = read(taskPath);
        if (body.project && t.project !== body.project) return sendJson({ error: 'Task does not belong to the active project' }, 409);

        if (decision === 'stop_task') {
          t.status = 'cancelled_by_user';
          t.stoppedByUser = true;
          json(taskPath, t);
          return sendJson({ success: true, taskId, status: t.status });
        }

        if (TERMINAL_TASK_STATUSES.has(t.status)) {
          return sendJson({ error: `Cannot resume task in terminal status (${t.status})` }, 400);
        }
        if (t.reasonCode === 'CONTEXT_MISMATCH' || t.status === 'context_mismatch' || t.decisionRequired?.reasonCode === 'CONTEXT_MISMATCH' || t.decisionRequired?.type === 'context_mismatch') {
          if (decision === 'correct' || decision === 'send_for_revision') {
            return sendJson({ error: 'Automatic revision is prohibited for tasks with context mismatch. Use clean rerun.' }, 400);
          }
        }

        if (decision === 'acknowledge_sensitive') {
          t.sensitiveAcknowledged = true;
          json(taskPath, t);
          return sendJson({ success: true, acknowledged: true, taskId, status: t.status });
        }

        if (decision === 'check_again_start' || decision === 'check_again_review') {
          delete t.decisionRequired;
          delete t.error;
          json(taskPath, t);
        }

        // The CEO explicitly reviewed a "sensitive task" warning and chose to
        // send it to a worker anyway. Persist this to the task file itself —
        // codeTask() re-reads task.json fresh on resume, so this flag has to
        // be on disk, not just in this request's memory, for the sensitivity
        // gate in coding.mjs to see it. Only settable via this exact decision
        // value, which only the dashboard's own override button sends.
        if (decision === 'override_sensitive') {
          t.sensitiveOverridden = true;
          const previousStatus = t.status;
          const overrideEvent = {
            time: new Date().toISOString(),
            icon: '🔓',
            title: 'Sensitive-Task Warning Overridden',
            desc: 'The CEO reviewed and manually overrode the sensitive-task advisory warning.',
            category: 'decision',
            eventType: 'SENSITIVITY_OVERRIDE_BY_USER'
          };
          t.activityLog = t.activityLog || [];
          t.activityLog.push(overrideEvent);
          json(taskPath, t);
          broadcastTaskEvent(taskId, { type: 'activity', item: overrideEvent });
          recordWorkerEvent(root, taskId, {
            eventType: 'SENSITIVITY_OVERRIDE_BY_USER',
            role: 'router',
            title: 'Sensitive-Task Warning Overridden',
            detail: 'The CEO reviewed and manually overrode the sensitive-task advisory warning.',
            taskId,
            category: 'credentials_or_access',
            rule: 'advisory_override',
            reason: t.sensitiveReason || 'Sensitive task advisory warning',
            previousStatus,
            overrideAction: 'continue_with_worker',
            timestamp: new Date().toISOString()
          });
        }

        const preferredWorker = body.preferredWorker || (decision === 'preserve_claude' ? 'antigravity' : undefined);
        const allowClaude = decision === 'use_claude' || Boolean(t.allowClaudeForTask || t.claudeQuotaAuthorized);

        // Check if there is a pending in-memory permission request for this task and resolve it
        const perms = getPendingPermissions(taskId);
        for (const p of perms) {
          p.resolve(allowClaude ? 'allow_task' : 'deny', false);
        }

        // Check lock
        const lockPath = path.join(root, '.router', 'router.lock');
        if (fs.existsSync(lockPath)) {
          await new Promise(r => setTimeout(r, 200));
        }

        // A human just explicitly triggered this resume (whether via the
        // manual Retry Now button or a decision button) — that supersedes
        // any pending auto-retry timer and resets the auto-retry attempt
        // count, since the human's own action is a fresh, informed attempt,
        // not one of the automatic ones counted toward the conservative cap.
        clearAutoRetry(taskId, root);

        const abortController = new AbortController();
        activeTaskAbortControllers.set(taskId, abortController);

        // Resume coding in background
        (async () => {
          try {
            activeRunningTask = taskId;
            await codeTask(root, null, {
              resume: taskId,
              preferredWorker,
              allowClaude,
              signal: abortController.signal,
              confirmClaudeUse: async (promptMsg) => {
                const permResult = await requestPermission(taskId, {
                  type: 'claude_quota',
                  description: promptMsg,
                  worker: 'claude-code',
                  action: 'use_claude_quota',
                  projectId: t.project || 'test-site',
                  canRemember: true
                });
                if (permResult.decision === 'stop_task') throw Error('TASK_STOPPED');
                return permResult.decision === 'allow_once' || permResult.decision === 'allow_task';
              },
              log: (msg) => broadcastTaskEvent(taskId, { type: 'log', message: msg }),
              onWorkerEvent: (event) => broadcastTaskEvent(taskId, { type: 'worker_event', event }),
              onActivity: (item) => broadcastTaskEvent(taskId, { type: 'activity', item })
            });
          } catch (err) {
            console.error('Resume background error:', err.message);
          } finally {
            activeTaskAbortControllers.delete(taskId);
            activeRunningTask = null;
            maybeScheduleAutoRetry(root, t.project, taskId);
          }
        })();

        return sendJson({ success: true, taskId, status: 'resumed', preferredWorker, allowClaude });
      }

      // 6c. POST /api/tasks/:id/pause - Pause active task
      const taskPauseMatch = pathname.match(/^\/api\/tasks\/(\d{8}T\d{6}-[a-f0-9]{8})\/pause$/);
      if (taskPauseMatch && method === 'POST') {
        const taskId = taskPauseMatch[1];
        const taskPath = path.join(taskDir(root, taskId), 'task.json');
        if (!fs.existsSync(taskPath)) return sendJson({ error: 'Task not found' }, 404);
        const t = read(taskPath);
        if (t.status === 'paused_by_user') {
          return sendJson({ success: true, taskId, status: 'paused_by_user', message: 'Task already paused' });
        }
        if (TERMINAL_TASK_STATUSES.has(t.status)) {
          return sendJson({ error: `Cannot pause task in terminal status (${t.status})` }, 400);
        }
        // Do NOT abort running worker! Let in-flight operation complete safely.
        // Clear auto-retry timers so no automatic retry fires while paused.
        clearAutoRetry(taskId, root);
        t.status = 'paused_by_user';
        const pauseActivity = {
          time: new Date().toISOString(),
          icon: '⏸️',
          title: 'Task Paused',
          desc: 'The task execution has been paused by the user. In-flight work will finish safely and execution will pause before the next step.',
          category: 'router'
        };
        t.activityLog = t.activityLog || [];
        t.activityLog.push(pauseActivity);
        json(taskPath, t);
        broadcastTaskEvent(taskId, { type: 'activity', item: pauseActivity });
        broadcastTaskEvent(taskId, { type: 'status', status: 'paused_by_user' });
        recordWorkerEvent(root, taskId, {
          eventType: 'TASK_PAUSED_BY_USER',
          role: 'router',
          title: 'Task Paused by User',
          detail: 'Task execution was paused by the user. Workflow will pause at the next boundary.',
          taskId,
          timestamp: new Date().toISOString()
        });
        return sendJson({ success: true, taskId, status: 'paused_by_user' });
      }

      // 6d. POST /api/tasks/:id/stop - Stop / Cancel active task
      const taskStopMatch = pathname.match(/^\/api\/tasks\/(\d{8}T\d{6}-[a-f0-9]{8})\/stop$/);
      if (taskStopMatch && method === 'POST') {
        const taskId = taskStopMatch[1];
        const taskPath = path.join(taskDir(root, taskId), 'task.json');
        if (!fs.existsSync(taskPath)) return sendJson({ error: 'Task not found' }, 404);
        const t = read(taskPath);
        if (t.status === 'cancelled_by_user' || t.status === 'cancelled') {
          return sendJson({ success: true, taskId, status: 'cancelled_by_user', message: 'Task already stopped' });
        }
        clearAutoRetry(taskId, root);
        if (activeTaskAbortControllers.has(taskId)) {
          try { activeTaskAbortControllers.get(taskId).abort(); } catch {}
          activeTaskAbortControllers.delete(taskId);
        }
        const lockPath = path.join(root, '.router', 'router.lock');
        try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch {}
        if (activeRunningTask === taskId || activeRunningTask === 'running') {
          activeRunningTask = null;
        }
        t.status = 'cancelled_by_user';
        t.stoppedByUser = true;
        delete t.decisionRequired;
        const stopActivity = {
          time: new Date().toISOString(),
          icon: '⏹️',
          title: 'Task Stopped',
          desc: 'The task was stopped by the user. Active task lock released.',
          category: 'router'
        };
        t.activityLog = t.activityLog || [];
        t.activityLog.push(stopActivity);
        json(taskPath, t);
        broadcastTaskEvent(taskId, { type: 'activity', item: stopActivity });
        broadcastTaskEvent(taskId, { type: 'status', status: 'cancelled_by_user' });
        recordWorkerEvent(root, taskId, {
          eventType: 'TASK_STOPPED_BY_USER',
          role: 'router',
          title: 'Task Stopped by User',
          detail: 'Task execution was stopped by the user.',
          taskId,
          timestamp: new Date().toISOString()
        });
        return sendJson({ success: true, taskId, status: 'cancelled_by_user' });
      }

      // 6c. POST /api/tasks/:id/rerun-clean - Reject contaminated draft and rerun cleanly
      const taskRerunCleanMatch = pathname.match(/^\/api\/tasks\/(\d{8}T\d{6}-[a-f0-9]{8})\/rerun-clean$/);
      if (taskRerunCleanMatch && method === 'POST') {
        const taskId = taskRerunCleanMatch[1];
        clearAutoRetry(taskId, root); // superseded by the new clean-rerun task below
        try {
          const oldDir = taskDir(root, taskId);
          const oldTask = read(path.join(oldDir, 'task.json'));

          oldTask.status = 'rejected';
          oldTask.reasonCode = 'CONTEXT_MISMATCH';
          oldTask.rejectionReason = 'Rejected due to CONTEXT_MISMATCH — Clean rerun initiated';
          oldTask.approval = {
            decision: 'rejected',
            reason: 'Rejected due to CONTEXT_MISMATCH — Clean rerun initiated',
            digest: oldTask.digest || 'contaminated',
            time: new Date().toISOString(),
            actor: 'user-rerun-clean',
            scope: 'rejected contaminated draft; clean rerun scheduled'
          };
          json(path.join(oldDir, 'task.json'), oldTask);
          json(path.join(oldDir, 'approval.json'), oldTask.approval);
          event(oldDir, 'rejected', { reason: oldTask.rejectionReason });

          const cleanInstruction = oldTask.instruction;
          const cleanProject = oldTask.project || (oldTask.kind === 'system' ? 'adaptive-router' : 'test-site');
          const allowClaude = Boolean(oldTask.allowClaudeForTask || oldTask.claudeQuotaAuthorized);

          (async () => {
            try {
              activeRunningTask = 'running';
              await codeTask(root, cleanInstruction, {
                project: cleanProject,
                allowClaude,
                confirmClaudeUse: async (promptMsg) => {
                  const currentId = activeRunningTask && activeRunningTask !== 'running' ? activeRunningTask : 'current';
                  const permResult = await requestPermission(currentId, {
                    type: 'claude_quota',
                    description: promptMsg,
                    worker: 'claude-code',
                    action: 'use_claude_quota',
                    projectId: cleanProject,
                    canRemember: true
                  });
                  if (permResult.decision === 'stop_task') throw Error('TASK_STOPPED');
                  return permResult.decision === 'allow_once' || permResult.decision === 'allow_task';
                },
                log: (msg) => {
                  if (activeRunningTask && activeRunningTask !== 'running') {
                    broadcastTaskEvent(activeRunningTask, { type: 'log', message: msg });
                  }
                },
                onWorkerEvent: (event) => {
                  if (activeRunningTask === 'running' && event.taskId) activeRunningTask = event.taskId;
                  const targetId = activeRunningTask && activeRunningTask !== 'running' ? activeRunningTask : (event.taskId || 'current');
                  broadcastTaskEvent(targetId, { type: 'worker_event', event });
                },
                onActivity: (item) => {
                  if (activeRunningTask && activeRunningTask !== 'running') {
                    broadcastTaskEvent(activeRunningTask, { type: 'activity', item });
                  }
                }
              });
            } catch (err) {
              console.error('Clean rerun background error:', err.message);
            } finally {
              const finishedTaskId = activeRunningTask && activeRunningTask !== 'running' ? activeRunningTask : null;
              activeRunningTask = null;
              if (finishedTaskId) maybeScheduleAutoRetry(root, cleanProject, finishedTaskId);
            }
          })();

          await new Promise(r => setTimeout(r, 200));
          const recent = listRecentTasks(root, cleanProject);
          const newest = recent.find(t => t.id !== taskId);
          if (newest) activeRunningTask = newest.id;

          return sendJson({ success: true, oldTaskId: taskId, taskId: newest?.id || null, status: 'started' });
        } catch (e) {
          return sendJson({ error: e.message }, 400);
        }
      }

      // 7. GET /api/tasks/:id/stream - SSE real-time stream
      const streamMatch = pathname.match(/^\/api\/tasks\/(\d{8}T\d{6}-[a-f0-9]{8})\/stream$/);
      if (streamMatch && method === 'GET') {
        const taskId = streamMatch[1];
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        res.write(`data: ${JSON.stringify({ type: 'connected', taskId })}\n\n`);

        if (!activeStreams.has(taskId)) {
          activeStreams.set(taskId, new Set());
        }
        activeStreams.get(taskId).add(res);

        // Replay missed events if client reconnected with ?sinceSequence=N
        const sinceSeqParam = parsedUrl.searchParams.get('sinceSequence');
        if (sinceSeqParam !== null) {
          const sinceSeq = parseInt(sinceSeqParam, 10);
          if (!isNaN(sinceSeq)) {
            try {
              const history = loadTaskEvents(root, taskId);
              for (const ev of history) {
                if (typeof ev.sequence === 'number' && ev.sequence > sinceSeq) {
                  res.write(`data: ${JSON.stringify({ type: 'worker_event', event: ev })}\n\n`);
                }
              }
            } catch {}
          }
        }

        const unsubPerm = onPermissionChange((perms) => {
          try {
            res.write(`data: ${JSON.stringify({ type: 'permissions', permissions: perms.filter(p => p.taskId === taskId) })}\n\n`);
          } catch {}
        });

        req.on('close', () => {
          unsubPerm();
          const set = activeStreams.get(taskId);
          if (set) {
            set.delete(res);
            if (set.size === 0) activeStreams.delete(taskId);
          }
        });
        return;
      }

      // 8. GET /api/tasks/:id/deliverable/* - Safe deliverable serving for preview
      const deliverableMatch = pathname.match(/^\/api\/tasks\/(\d{8}T\d{6}-[a-f0-9]{8})\/deliverable\/(.*)$/);
      if (deliverableMatch && method === 'GET') {
        const taskId = deliverableMatch[1];
        const requestedFile = deliverableMatch[2] || 'index.html';
        const dir = taskDir(root, taskId);
        const task = read(path.join(dir, 'task.json'));
        const rev = task.revision || 1;
        const deliverablesDir = path.resolve(path.join(dir, `deliverables-${rev}`));

        const resolved = path.resolve(path.join(deliverablesDir, requestedFile));
        if (resolved !== deliverablesDir && !resolved.startsWith(deliverablesDir + path.sep)) {
          res.writeHead(403);
          return res.end('Access denied');
        }

        if (!fs.existsSync(resolved) || !fs.lstatSync(resolved).isFile()) {
          res.writeHead(404);
          return res.end('Deliverable file not found');
        }

        const ext = path.extname(resolved).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        return res.end(fs.readFileSync(resolved));
      }

      // 8b. GET /api/planning - Get planning state for a project
      if (pathname === '/api/planning' && method === 'GET') {
        const project = parsedUrl.searchParams.get('project') || 'adaptive-router';
        const state = getPlanningState(root, project);
        return sendJson(state);
      }

      // 8c. POST /api/planning/chat - Send a message to the AI CTO
      if (pathname === '/api/planning/chat' && method === 'POST') {
        const body = await readBody();
        const project = body.project || 'adaptive-router';
        const message = (body.message || '').trim();
        if (!message) return sendJson({ error: 'Message cannot be empty' }, 400);
        try {
          const result = await sendPlanningMessage(root, { project, message });
          return sendJson({ success: true, ...result });
        } catch (err) {
          return sendJson({ error: err.message }, 500);
        }
      }

      // 8d. POST /api/planning/reset - Clear planning conversation
      if (pathname === '/api/planning/reset' && method === 'POST') {
        const body = await readBody();
        const project = body.project || 'adaptive-router';
        resetPlanningState(root, project);
        return sendJson({ success: true });
      }

      // 8e. POST /api/planning/execute - Approve plan and start execution
      if (pathname === '/api/planning/execute' && method === 'POST') {
        const body = await readBody();
        const project = body.project || 'adaptive-router';
        const allowClaude = Boolean(body.allowClaude);

        // Check lock
        const lockPath = path.join(root, '.router', 'router.lock');
        if (fs.existsSync(lockPath)) {
          let isStale = false;
          try {
            const staleOwner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            if (staleOwner?.pid) {
              try { process.kill(staleOwner.pid, 0); } catch (e) { if (e.code === 'ESRCH') isStale = true; }
            }
          } catch {}
          if (isStale) {
            try { fs.unlinkSync(lockPath); } catch {}
          } else {
            return sendJson({ error: 'Another task is currently running. Please wait for it to complete.' }, 409);
          }
        }

        const activeTask = getActiveTask(root, project);
        if (activeTask) {
          return sendJson({
            error: `Another task (${activeTask.id}) is currently active (${activeTask.status}). Please wait for it to complete or stop it before starting a new task.`,
            activeTaskId: activeTask.id,
            activeTaskStatus: activeTask.status
          }, 409);
        }

        let resolvedTaskId = null;
        (async () => {
          try {
            activeRunningTask = 'running';
            resolvedTaskId = await approvePlanAndExecute(root, {
              project,
              allowClaude,
              log: (msg) => {
                if (activeRunningTask && activeRunningTask !== 'running') {
                  broadcastTaskEvent(activeRunningTask, { type: 'log', message: msg });
                }
              },
              onActivity: (item) => {
                if (activeRunningTask && activeRunningTask !== 'running') {
                  broadcastTaskEvent(activeRunningTask, { type: 'activity', item });
                }
              }
            });
          } catch (err) {
            console.error('Planning execute error:', err.message);
          } finally {
            const finishedTaskId = resolvedTaskId || (activeRunningTask && activeRunningTask !== 'running' ? activeRunningTask : null);
            activeRunningTask = null;
            if (finishedTaskId) maybeScheduleAutoRetry(root, project, finishedTaskId);
          }
        })();

        // Wait briefly to capture new task ID
        await new Promise(r => setTimeout(r, 150));
        const recent = listRecentTasks(root);
        const newest = recent[0];
        if (newest) activeRunningTask = newest.id;

        return sendJson({ success: true, taskId: newest?.id || null, status: 'started' });
      }

      // 9. Static UI files from src/web/
      let staticFile = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
      const staticPath = path.resolve(path.join(webDir, staticFile));
      if (staticPath.startsWith(path.resolve(webDir)) && fs.existsSync(staticPath) && fs.lstatSync(staticPath).isFile()) {
        const ext = path.extname(staticPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'text/plain';
        res.writeHead(200, { 'Content-Type': contentType });
        return res.end(fs.readFileSync(staticPath));
      }

      // 404 for unknown endpoints
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');

    } catch (err) {
      console.error('Server error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });

  const origClose = server.close.bind(server);
  server.close = function(cb) {
    for (const entry of autoRetryState.values()) {
      if (entry?.timer) clearTimeout(entry.timer);
    }
    autoRetryState.clear();
    return origClose(cb);
  };

  return server;
}

export function startDashboardServer(root, { port = 3210, host = 'localhost', openBrowser = false } = {}) {
  const server = createDashboardServer(root);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      console.log(`\n======================================================`);
      console.log(`Adaptive Router Business Dashboard`);
      console.log(`Status: Running at ${url}`);
      console.log(`Press Ctrl+C to stop the dashboard`);
      console.log(`======================================================\n`);

      if (openBrowser) {
        try {
          if (process.platform === 'win32') {
            spawn('cmd.exe', ['/c', 'start', url], { detached: true, stdio: 'ignore' }).unref();
          }
        } catch {}
      }
      resolve({ server, port, url });
    });
  });
}
