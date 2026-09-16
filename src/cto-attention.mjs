import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { json, read } from './storage.mjs';

// Persistent CTO Attention / CTO Inbox / nudge system.
//
// Per the CTO Handover doc (sections 22-25): a durable inbox of items that
// need CTO judgment, separate from live per-task dashboard state, surviving
// browser refresh AND AR restart (hence a plain JSON file, not in-memory
// state) — plus a small machine-friendly endpoint so the CTO can cheaply
// answer "does attention exist / what task / why / what action" without
// parsing logs.
//
// Deliberately narrow, matching the doc's own warnings:
//  - This does NOT duplicate decision logic. The inbox only records THAT an
//    item needs attention and a short reason/action string; the actual
//    decision UI (approve/reject, resume, override) is the existing
//    per-task dialog system already in server.mjs/app.js. Resolving an item
//    here never itself performs the underlying action.
//  - Only fires for genuine CTO-judgment events (the doc's explicit list:
//    TASK_READY_FOR_CTO_REVIEW, TASK_COMPLETED, TECHNICAL_APPROVAL_REQUIRED,
//    TASK_BLOCKED, REVIEW_FAILED_REPEATEDLY, FAILOVERS_EXHAUSTED,
//    TOKEN_GUARDRAIL_REACHED, TIME_GUARDRAIL_REACHED,
//    SENSITIVE_TECHNICAL_DECISION_REQUIRED, WORKER_UNAVAILABLE_NO_FALLBACK,
//    MANUAL_INTERVENTION_REQUIRED) — never for normal internal progress.
//  - No metrics/alerting platform: one JSON file, capped history, simple
//    unread/acknowledged/resolved states.

const INBOX_FILE = '.router/cto-attention.json';
const MAX_ITEMS = 500; // resolved items beyond this are trimmed, oldest first

function inboxPath(root) {
  return path.join(root, INBOX_FILE);
}

function loadInbox(root) {
  try {
    const data = read(inboxPath(root));
    if (data && Array.isArray(data.items)) return data;
  } catch { /* missing or corrupt — start fresh, never throw */ }
  return { items: [] };
}

function saveInbox(root, data) {
  try {
    // Cap total size: keep all unread/acknowledged items, trim oldest
    // resolved items first so the file can't grow unbounded over a long
    // AR lifetime.
    if (data.items.length > MAX_ITEMS) {
      const resolved = data.items.filter(i => i.state === 'resolved').sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
      const overflow = data.items.length - MAX_ITEMS;
      if (overflow > 0 && resolved.length > 0) {
        const toDrop = new Set(resolved.slice(0, Math.min(overflow, resolved.length)).map(i => i.id));
        data.items = data.items.filter(i => !toDrop.has(i.id));
      }
    }
    json(inboxPath(root), data);
  } catch (e) {
    // Best-effort. The inbox is a convenience/notification layer, not the
    // source of truth for task state — never let it break task execution.
    console.error('Failed to persist CTO attention inbox:', e.message);
  }
}

// Maps AR's internal task statuses / event types to the doc's canonical
// attention event types. Only entries present here ever create an inbox
// item — everything else is normal internal progress and is intentionally
// ignored, per the doc: "Do NOT notify CTO for normal internal progress."
const STATUS_EVENT_TYPE = {
  needs_cto_attention: 'SENSITIVE_TECHNICAL_DECISION_REQUIRED',
  needs_human_input: 'TECHNICAL_APPROVAL_REQUIRED',
  awaiting_approval: 'TASK_READY_FOR_CTO_REVIEW',
  completed: 'TASK_COMPLETED',
  approved: 'TASK_COMPLETED',
  failed: 'TASK_BLOCKED'
};

function titleFor(eventType) {
  switch (eventType) {
    case 'SENSITIVE_TECHNICAL_DECISION_REQUIRED': return 'CTO Sensitivity Override Required';
    case 'TECHNICAL_APPROVAL_REQUIRED': return 'Technical Decision Required';
    case 'TASK_READY_FOR_CTO_REVIEW': return 'Ready for CTO Review';
    case 'TASK_COMPLETED': return 'Task Completed';
    case 'TASK_BLOCKED': return 'Task Blocked';
    case 'REVIEW_FAILED_REPEATEDLY': return 'Review Failed Repeatedly';
    case 'FAILOVERS_EXHAUSTED': return 'All Workers Exhausted';
    case 'TOKEN_GUARDRAIL_REACHED': return 'Token Guardrail Reached';
    case 'TIME_GUARDRAIL_REACHED': return 'Time Guardrail Reached';
    case 'WORKER_UNAVAILABLE_NO_FALLBACK': return 'No Worker Available';
    case 'MANUAL_INTERVENTION_REQUIRED': return 'Manual Intervention Required';
    default: return eventType.replace(/_/g, ' ');
  }
}

function actionFor(eventType) {
  switch (eventType) {
    case 'SENSITIVE_TECHNICAL_DECISION_REQUIRED': return 'Authorize CTO override or cancel the task';
    case 'TECHNICAL_APPROVAL_REQUIRED': return 'Review the task and decide next step';
    case 'TASK_READY_FOR_CTO_REVIEW': return 'Review result and approve or reject';
    case 'TASK_COMPLETED': return 'No action required — informational';
    case 'TASK_BLOCKED': return 'Investigate failure and retry or intervene';
    case 'REVIEW_FAILED_REPEATEDLY': return 'Review feedback and decide whether to continue or intervene';
    case 'FAILOVERS_EXHAUSTED': return 'No eligible worker remains — retry later or intervene directly';
    case 'TOKEN_GUARDRAIL_REACHED': return 'Review token usage; task continues unless stopped';
    case 'TIME_GUARDRAIL_REACHED': return 'Review elapsed time; task continues unless stopped';
    case 'WORKER_UNAVAILABLE_NO_FALLBACK': return 'No fallback worker configured — intervene directly';
    case 'MANUAL_INTERVENTION_REQUIRED': return 'Manual technical intervention required';
    default: return 'Review Result';
  }
}

/**
 * Record a new attention item, or refresh an existing open one for the same
 * task + event type rather than creating a duplicate (e.g. a task that
 * flips between needs_human_input and back keeps a single inbox entry).
 * Never throws — failures here must never affect task execution.
 * @param {string} root
 * @param {object} opts
 * @param {string} opts.eventType one of the canonical types above
 * @param {string} [opts.taskId]
 * @param {string} [opts.project]
 * @param {string} [opts.reason] short human-readable reason
 * @param {string} [opts.instruction] short task instruction for display
 */
export function notifyCtoAttention(root, { eventType, taskId = null, project = null, reason = '', instruction = '' } = {}) {
  try {
    if (!eventType) return null;
    const data = loadInbox(root);
    // If an open (unread/acknowledged) item already exists for this exact
    // task + event type, refresh it in place instead of piling up
    // duplicates every time the same condition re-fires.
    let item = taskId
      ? data.items.find(i => i.taskId === taskId && i.eventType === eventType && i.state !== 'resolved')
      : null;
    const now = new Date().toISOString();
    if (item) {
      item.reason = reason || item.reason;
      item.instruction = instruction || item.instruction;
      item.updatedAt = now;
      // A refreshed item that had already been acknowledged goes back to
      // unread only if the underlying condition is genuinely new — but we
      // can't distinguish "same problem still open" from "new occurrence"
      // reliably here, so we conservatively leave acknowledged/resolved
      // state alone and just keep the detail current. The one exception is
      // TASK_COMPLETED-style terminal events, which always read as fresh.
    } else {
      item = {
        id: randomUUID(),
        eventType,
        title: titleFor(eventType),
        action: actionFor(eventType),
        taskId,
        project,
        reason: String(reason || '').slice(0, 2000),
        instruction: String(instruction || '').slice(0, 500),
        state: 'unread',
        createdAt: now,
        updatedAt: now
      };
      data.items.push(item);
    }
    saveInbox(root, data);
    return item;
  } catch (e) {
    console.error('Failed to record CTO attention item:', e.message);
    return null;
  }
}

/**
 * Convenience wrapper: given an AR task status transition, record an
 * attention item if (and only if) that status is one the doc lists as
 * CTO-judgment-worthy. Safe to call on every status transition — statuses
 * not in the map are silently ignored (normal internal progress).
 */
export function notifyFromTaskStatus(root, task, status, detail = {}) {
  const eventType = STATUS_EVENT_TYPE[status];
  if (!eventType) return null;
  // TASK_COMPLETED is informational-only per the doc's action guidance;
  // still recorded so the inbox has a full picture, but callers/UI may
  // choose to badge it differently than a true decision-required item.
  return notifyCtoAttention(root, {
    eventType,
    taskId: task?.id,
    project: task?.project,
    reason: detail?.note || detail?.guardrailReason || detail?.feedback?.slice?.(0, 500) || '',
    instruction: task?.instruction
  });
}

/**
 * Mark an item's underlying task resolved (approved/rejected/cancelled/
 * completed elsewhere) — called from the same places that already resolve
 * the task itself, so the inbox doesn't show stale "action required" items
 * for tasks the CTO already acted on via the normal decision dialog.
 */
export function resolveAttentionForTask(root, taskId) {
  if (!taskId) return;
  try {
    const data = loadInbox(root);
    let changed = false;
    for (const item of data.items) {
      if (item.taskId === taskId && item.state !== 'resolved') {
        item.state = 'resolved';
        item.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) saveInbox(root, data);
  } catch (e) {
    console.error('Failed to resolve CTO attention for task:', e.message);
  }
}

/** List inbox items, newest first. Never throws. */
export function listAttention(root, { state = null } = {}) {
  const data = loadInbox(root);
  let items = [...data.items].sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
  if (state) items = items.filter(i => i.state === state);
  return items;
}

/** Set an item's state to 'acknowledged' or 'resolved'. Returns the item or null. */
export function setAttentionState(root, id, newState) {
  if (!['unread', 'acknowledged', 'resolved'].includes(newState)) throw Error('Invalid attention state');
  const data = loadInbox(root);
  const item = data.items.find(i => i.id === id);
  if (!item) return null;
  item.state = newState;
  item.updatedAt = new Date().toISOString();
  saveInbox(root, data);
  return item;
}

/**
 * Machine-friendly summary for Cowork/CTO supervision integration (doc
 * section 25's `GET /api/cto/attention` or equivalent). Answers cheaply,
 * without parsing logs: does attention exist, what task, why, what action.
 */
export function getAttentionSummary(root) {
  const items = listAttention(root).filter(i => i.state !== 'resolved');
  return {
    attentionRequired: items.length > 0,
    unreadCount: items.filter(i => i.state === 'unread').length,
    totalOpen: items.length,
    items: items.slice(0, 20).map(i => ({
      id: i.id,
      eventType: i.eventType,
      title: i.title,
      taskId: i.taskId,
      project: i.project,
      reason: i.reason,
      action: i.action,
      state: i.state,
      createdAt: i.createdAt
    }))
  };
}
