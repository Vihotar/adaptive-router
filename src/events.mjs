/**
 * events.mjs — Universal Worker Event Layer & Security Sanitizer
 *
 * Provides:
 *  1. Monotonic sequence numbering and unique event IDs per task.
 *  2. Whitelist validation for observable worker activity (filters out token noise and reasoning).
 *  3. Strict secret redaction across all events, stdout, stderr, and technical logs.
 *  4. Append-only persistence to .router/tasks/<taskId>/events.jsonl.
 *  5. Legacy event normalization for backward compatibility.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// In-memory monotonic sequence counters per taskId
const taskSequences = new Map();

export function getNextSequence(taskId, initialVal = 0) {
  const current = taskSequences.get(taskId) || initialVal;
  const next = current + 1;
  taskSequences.set(taskId, next);
  return next;
}

export function initSequenceFromDisk(root, taskId) {
  if (taskSequences.has(taskId)) return taskSequences.get(taskId);
  const eventsFile = path.join(root, '.router', 'tasks', taskId, 'events.jsonl');
  let maxSeq = 0;
  if (fs.existsSync(eventsFile)) {
    try {
      const lines = fs.readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      for (const l of lines) {
        try {
          const parsed = JSON.parse(l);
          if (typeof parsed.sequence === 'number' && parsed.sequence > maxSeq) {
            maxSeq = parsed.sequence;
          }
        } catch {}
      }
    } catch {}
  }
  taskSequences.set(taskId, maxSeq);
  return maxSeq;
}

// ── Strict Secret Sanitization ────────────────────────────────────────────────

// Known secret pattern matchers
const SECRET_REGEXES = [
  // OpenAI & generic API keys
  /sk-[a-zA-Z0-9_-]{20,}/g,
  // GitHub tokens
  /gh[pousr]-[a-zA-Z0-9_]{20,}/g,
  // Anthropic keys
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  // Google / Gemini keys
  /AIza[0-9A-Za-z-_]{35}/g,
  // Authorization headers & Bearer tokens
  /(?:Bearer|Authorization[:=]\s*Bearer)\s+[a-zA-Z0-9_\-\.]{16,}/gi,
  // Generic password / secret assignments in command lines or env vars
  /(?:password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\s*[:=]\s*["']?([^"'\s,;]+)["']?/gi,
  // Hex tokens with 32+ characters (like AR connector token)
  /(?:token|secret|key|bearer)[:=]\s*([a-f0-9]{32,64})/gi
];

/**
 * Sanitize any string by replacing recognized secrets with [REDACTED].
 */
export function sanitizeText(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const rx of SECRET_REGEXES) {
    out = out.replace(rx, (match, ...args) => {
      // If regex has a capture group and it's a string, replace only the capture
      if (args.length > 2 && typeof args[0] === 'string' && typeof args[1] === 'number') {
        return match.replace(args[0], '[REDACTED]');
      }
      return '[REDACTED]';
    });
  }
  return out;
}

/**
 * Recursively sanitize objects or strings.
 */
export function sanitizePayload(obj) {
  if (typeof obj === 'string') return sanitizeText(obj);
  if (Array.isArray(obj)) return obj.map(sanitizePayload);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/password|secret|token|apikey|api_key|bearer|jwt|credential|cookie/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizePayload(v);
      }
    }
    return out;
  }
  return obj;
}

// ── Whitelisted Observable Event Types ────────────────────────────────────────

export const ALLOWED_EVENT_TYPES = new Set([
  'routing',
  'worker_start',
  'progress',
  'tool',
  'command',
  'file_read',
  'file_edit',
  'file_create',
  'file_delete',
  'browser',
  'test_started',
  'test_check',
  'test_passed',
  'test_failed',
  'test_summary',
  'error',
  'retry',
  'failover',
  'escalation',
  'review_started',
  'review_finding',
  'review_verdict',
  'correction',
  'completion',
  'token_usage'
]);

// Whitelisted platforms
export const ALLOWED_PLATFORMS = new Set([
  'codex',
  'claude',
  'antigravity',
  'cline',
  'router',
  'system',
  'browser'
]);

/**
 * Creates and formats a validated, sanitized Universal Worker Event.
 */
export function createWorkerEvent({
  taskId,
  sequence,
  platform = 'router',
  worker = 'adaptive-router',
  model = null,
  effort = null,
  specialist = null,
  role = 'builder',
  eventType = 'progress',
  title = '',
  detail = null,
  status = 'info',
  icon = null,
  file = null,
  command = null,
  metadata = null
}) {
  const normType = ALLOWED_EVENT_TYPES.has(eventType) ? eventType : 'progress';
  const normPlatform = ALLOWED_PLATFORMS.has(platform) ? platform : 'router';

  // Choose appropriate icon if not provided
  let eventIcon = icon;
  if (!eventIcon) {
    switch (normType) {
      case 'routing': eventIcon = '🎯'; break;
      case 'worker_start': eventIcon = '🤖'; break;
      case 'token_usage': eventIcon = '📊'; break;
      case 'file_read': eventIcon = '📖'; break;
      case 'file_edit': eventIcon = '✏️'; break;
      case 'file_create': eventIcon = '📄'; break;
      case 'file_delete': eventIcon = '🗑️'; break;
      case 'command': eventIcon = '💻'; break;
      case 'tool': eventIcon = '🔧'; break;
      case 'browser': eventIcon = '🌐'; break;
      case 'test_started':
      case 'test_check': eventIcon = '🧪'; break;
      case 'test_passed': eventIcon = '✅'; break;
      case 'test_failed': eventIcon = '❌'; break;
      case 'test_summary': eventIcon = '📊'; break;
      case 'review_started':
      case 'review_finding':
      case 'review_verdict': eventIcon = '🔍'; break;
      case 'failover':
      case 'retry':
      case 'escalation': eventIcon = '⚡'; break;
      case 'error': eventIcon = '⚠️'; break;
      case 'correction': eventIcon = '↺'; break;
      case 'completion': eventIcon = '🎉'; break;
      default: eventIcon = '⚡'; break;
    }
  }

  return {
    eventId: `evt_${randomBytes(6).toString('hex')}`,
    sequence: typeof sequence === 'number' ? sequence : 1,
    taskId,
    timestamp: new Date().toISOString(),
    platform: normPlatform,
    worker: sanitizeText(worker),
    model: model ? sanitizeText(model) : null,
    effort: effort ? sanitizeText(effort) : null,
    specialist: specialist ? sanitizeText(specialist) : null,
    role,
    eventType: normType,
    title: sanitizeText(title),
    detail: detail ? sanitizeText(detail) : null,
    status,
    icon: eventIcon,
    file: file ? sanitizeText(file) : null,
    command: command ? sanitizeText(command) : null,
    metadata: metadata ? sanitizePayload(metadata) : null
  };
}

/**
 * Publish a Universal Worker Event:
 *  - Assigns monotonic sequence
 *  - Sanitizes payload
 *  - Persists to events.jsonl
 *  - Returns the event object for broadcasting
 */
export function recordWorkerEvent(root, taskId, eventParams) {
  initSequenceFromDisk(root, taskId);
  const sequence = getNextSequence(taskId);

  const event = createWorkerEvent({
    ...eventParams,
    taskId,
    sequence
  });

  const taskDir = path.join(root, '.router', 'tasks', taskId);
  if (fs.existsSync(taskDir)) {
    const eventsFile = path.join(taskDir, 'events.jsonl');
    try {
      fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n');
    } catch (e) {
      console.error(`Failed to append worker event for ${taskId}:`, e.message);
    }
  }

  return event;
}

/**
 * Load and normalize all events for a task from disk.
 * Handles both new Universal Worker Events and legacy event types seamlessly.
 */
export function loadTaskEvents(root, taskId) {
  const taskDir = path.join(root, '.router', 'tasks', taskId);
  const eventsFile = path.join(taskDir, 'events.jsonl');
  if (!fs.existsSync(eventsFile)) return [];

  const rawLines = fs.readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const hasUniversal = rawLines.some(line => line.includes('"eventId"') && line.includes('"sequence"'));
  let maxSeq = 0;
  for (const line of rawLines) {
    try {
      const entry = JSON.parse(line);
      if (typeof entry.sequence === 'number' && entry.sequence > maxSeq) {
        maxSeq = entry.sequence;
      }
    } catch {}
  }
  const normalized = [];
  let seqFallback = maxSeq ? maxSeq + 1 : 1;

  for (const line of rawLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.eventId && entry.eventType) {
        // Already a universal worker event
        normalized.push(sanitizePayload(entry));
      } else if (!hasUniversal) {
        // Legacy event normalization only for older tasks without universal events
        const legacyEvent = normalizeLegacyEvent(entry, taskId, seqFallback++);
        if (legacyEvent) normalized.push(legacyEvent);
      } else if (entry.type === 'failed' || entry.type === 'error') {
        // Ensure failed state events are represented in the event stream even if universal events exist
        const hasExistingError = normalized.some(e => e.eventType === 'error' || e.status === 'error');
        if (!hasExistingError) {
          const legacyEvent = normalizeLegacyEvent(entry, taskId, seqFallback++);
          if (legacyEvent) normalized.push(legacyEvent);
        }
      }
    } catch {}
  }

  normalized.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  return normalized;
}

/**
 * Normalizes legacy event types (e.g. from older AR versions) into UniversalWorkerEvent shape.
 */
function normalizeLegacyEvent(entry, taskId, seq) {
  const timestamp = entry.time || entry.timestamp || new Date().toISOString();
  const type = entry.type || 'activity';

  if (type === 'activity') {
    let eventType = 'progress';
    const titleLower = (entry.title || '').toLowerCase();
    if (titleLower.includes('instruction') || titleLower.includes('initiated')) eventType = 'routing';
    else if (titleLower.includes('specialist') || titleLower.includes('selected') || titleLower.includes('resumed')) eventType = 'routing';
    else if (titleLower.includes('draft') || titleLower.includes('built')) eventType = 'file_edit';
    else if (titleLower.includes('test passed') || titleLower.includes('test')) eventType = 'test_passed';
    else if (titleLower.includes('audit') || titleLower.includes('review')) eventType = 'review_verdict';
    else if (titleLower.includes('ready') || titleLower.includes('accepted')) eventType = 'completion';

    return {
      eventId: `evt_leg_${seq}`,
      sequence: seq,
      taskId,
      timestamp,
      platform: 'router',
      worker: 'adaptive-router',
      model: null,
      effort: null,
      specialist: null,
      role: 'router',
      eventType,
      title: sanitizeText(entry.title || 'Activity'),
      detail: sanitizeText(entry.desc || entry.details || ''),
      status: 'info',
      icon: entry.icon || '⚡',
      file: null,
      command: null,
      metadata: null
    };
  }

  if (type === 'worker_started') {
    return {
      eventId: `evt_leg_${seq}`,
      sequence: seq,
      taskId,
      timestamp,
      platform: entry.worker ? (entry.worker.startsWith('codex') ? 'codex' : entry.worker.startsWith('claude') ? 'claude' : entry.worker.startsWith('antigravity') ? 'antigravity' : entry.worker.startsWith('cline') ? 'cline' : 'router') : 'router',
      worker: entry.worker || 'Worker',
      model: entry.model || null,
      effort: entry.effort || null,
      specialist: null,
      role: 'builder',
      eventType: 'worker_start',
      title: `Worker started: ${(entry.worker || '').toUpperCase()}`,
      detail: entry.reason || `Stage: ${entry.stage || 'build'}`,
      status: 'in_progress',
      icon: '🤖',
      file: null,
      command: null,
      metadata: null
    };
  }

  if (type === 'worker_completed') {
    return {
      eventId: `evt_leg_${seq}`,
      sequence: seq,
      taskId,
      timestamp,
      platform: entry.worker ? (entry.worker.startsWith('codex') ? 'codex' : entry.worker.startsWith('claude') ? 'claude' : entry.worker.startsWith('antigravity') ? 'antigravity' : entry.worker.startsWith('cline') ? 'cline' : 'router') : 'router',
      worker: entry.worker || 'Worker',
      model: entry.model || null,
      effort: entry.effort || null,
      specialist: null,
      role: 'builder',
      eventType: 'progress',
      title: `Worker completed: ${(entry.worker || '').toUpperCase()}`,
      detail: `Model: ${entry.model || 'Standard'} [${entry.effort || 'medium'}]`,
      status: 'success',
      icon: '✓',
      file: null,
      command: null,
      metadata: null
    };
  }

  if (type === 'worker_unavailable' || type === 'failover') {
    return {
      eventId: `evt_leg_${seq}`,
      sequence: seq,
      taskId,
      timestamp,
      platform: 'router',
      worker: entry.worker || 'Worker',
      model: entry.model || null,
      effort: entry.effort || null,
      specialist: null,
      role: 'router',
      eventType: 'failover',
      title: entry.isQuota ? `Quota limit reached: ${entry.worker}` : `Worker unavailable: ${entry.worker}`,
      detail: entry.error || 'Switched to next available worker',
      status: 'failed',
      icon: '⚠️',
      file: null,
      command: null,
      metadata: { isQuota: Boolean(entry.isQuota) }
    };
  }

  if (type === 'failed' || type === 'error') {
    const errorMsg = sanitizeText(entry.error || entry.reason || entry.detail || 'Task execution failed');
    return {
      eventId: `evt_leg_${seq}`,
      sequence: seq,
      taskId,
      timestamp,
      platform: entry.worker ? (entry.worker.startsWith('codex') ? 'codex' : entry.worker.startsWith('claude') ? 'claude' : entry.worker.startsWith('antigravity') ? 'antigravity' : entry.worker.startsWith('cline') ? 'cline' : 'router') : 'router',
      worker: entry.worker || 'adaptive-router',
      model: entry.model || null,
      effort: entry.effort || null,
      specialist: null,
      role: 'router',
      eventType: 'error',
      title: entry.title || `Task Failed — ${entry.stage || 'Validation'}`,
      detail: errorMsg,
      status: 'error',
      icon: '❌',
      file: null,
      command: null,
      metadata: { stage: entry.stage || null, error: errorMsg }
    };
  }

  return null;
}
