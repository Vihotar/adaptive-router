// A running, plain-language log of work Adaptive Router's "staff" models
// (Cline in particular — the worker pool doing routine day-to-day
// tasks) have completed, so Claude (acting as CTO) can stay aware of what
// the workforce has been doing even when not actively watching the AR
// dashboard. This is deliberately a simple append-only text log rather than
// a push notification — Claude reads it at the start of a session, or on
// request, the same way a manager might skim a daily report.
//
// Business rule this supports: the CEO wants the CTO to know what staff
// models are doing without having to babysit the dashboard personally.
import fs from 'node:fs';
import path from 'node:path';

function logPath(root) {
  return path.join(root, '.router', 'staff-activity-log.md');
}

const MAX_ENTRIES = 200; // keep the log readable; oldest entries roll off

function readEntries(root) {
  const file = logPath(root);
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8');
  return content.split(/\n(?=## )/).map(s => s.trim()).filter(Boolean);
}

// Records a completed staff-built task in plain business language.
// Called once, right when a task reaches awaiting_approval, so the log
// reflects what staff finished — not what a human later approved/rejected.
export function recordStaffCompletion(root, {
  taskId,
  projectName,
  instruction,
  summary,
  builder,
  reviewer,
  completionTime
} = {}) {
  const when = completionTime || new Date().toISOString();
  const entry = [
    `## ${when} — ${projectName || 'Unknown project'}`,
    `- Task: \`${taskId}\``,
    `- Requested: ${String(instruction || '').trim().slice(0, 300)}`,
    `- Built by: ${builder || 'cline'} (routine worker pool)`,
    reviewer ? `- Checked by: ${reviewer}` : null,
    summary ? `- Outcome: ${String(summary).trim().slice(0, 400)}` : null,
    `- Status: Ready for your review in Adaptive Router (Stage B)`
  ].filter(Boolean).join('\n');

  const existing = readEntries(root);
  existing.push(entry);
  const trimmed = existing.slice(-MAX_ENTRIES);
  fs.mkdirSync(path.dirname(logPath(root)), { recursive: true });
  fs.writeFileSync(logPath(root), trimmed.join('\n\n') + '\n');
}

// Returns the N most recent staff-completion entries as plain text, newest
// first — meant to be read by Claude directly (e.g. "what has staff been
// doing lately?") rather than parsed programmatically.
export function getRecentStaffActivity(root, { limit = 20 } = {}) {
  const entries = readEntries(root).reverse().slice(0, limit);
  if (!entries.length) return 'No staff task completions recorded yet.';
  return entries.join('\n\n');
}
