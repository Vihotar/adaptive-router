// Adaptive Router — shared task display-title derivation.
//
// Why this lives in src/web/ rather than src/: it is the one piece of task
// logic both sides genuinely need. The Node server imports it as an ESM
// module (`./web/task-title.mjs`); the dashboard loads the exact same file
// over HTTP (the static handler already serves src/web/ and already maps
// .mjs to application/javascript) via the small module bootstrap in
// index.html that exposes it as window.ARTaskTitle. One implementation,
// no mirrored copy to drift — unlike ACTIVE_TASK_STATUSES, which has to be
// duplicated because it lives in a server-only module.
//
// Contract: this NEVER modifies or replaces task.instruction. It only
// produces a short label for places that show a task in a list, a table
// row, a dropdown option or a card header. Every view that needs the full
// original instruction (task detail, decision dialogs, approval reports,
// the Overview "View full instruction" toggle, everything server-side that
// routes or hashes a task) keeps reading task.instruction unchanged.

export const MAX_TASK_TITLE_LENGTH = 64;

// Leading noise that carries no meaning in a short label: markdown heading
// markers, bullets, numbered-list prefixes, blockquote markers, and the
// "Task:" / "Instruction:" / "Please" preambles instructions often open
// with.
const LEADING_MARKUP = /^\s*(?:#{1,6}|[-*+>]|\d+[.)])\s+/;
const LEADING_LABEL = /^\s*(?:task|instruction|objective|goal|request|prompt)\s*:\s*/i;
const LEADING_POLITENESS = /^\s*(?:please|kindly)\s+/i;

function cleanLine(line) {
  return String(line == null ? '' : line)
    .replace(LEADING_MARKUP, '')
    .replace(/[`*_~]+/g, '')
    .replace(LEADING_LABEL, '')
    .replace(LEADING_POLITENESS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateOnWordBoundary(text, maxLength) {
  if (text.length <= maxLength) return text;
  const hard = text.slice(0, maxLength);
  const lastSpace = hard.lastIndexOf(' ');
  // Only fall back to a word boundary when it keeps a useful amount of the
  // label; a single very long token (a path, a URL) is cut mid-token rather
  // than thrown away entirely.
  const kept = lastSpace > maxLength * 0.5 ? hard.slice(0, lastSpace) : hard;
  return kept.replace(/[\s,;:.\-]+$/, '') + '…';
}

/**
 * Derive a short, human-readable label from a raw task instruction.
 * Deterministic and lossless-by-omission: it summarises nothing, it simply
 * takes the first meaningful line, strips formatting noise, keeps the first
 * sentence and truncates on a word boundary.
 *
 * @param {string} instruction raw task instruction
 * @param {{ maxLength?: number }} [options]
 * @returns {string} short label, or '' when there is nothing usable
 */
export function deriveTaskTitle(instruction, { maxLength = MAX_TASK_TITLE_LENGTH } = {}) {
  const raw = typeof instruction === 'string' ? instruction : '';
  if (!raw.trim()) return '';

  let line = '';
  for (const candidate of raw.split(/\r?\n/)) {
    const cleaned = cleanLine(candidate);
    if (cleaned) { line = cleaned; break; }
  }
  if (!line) return '';

  // Keep only the first sentence when there clearly is one. The length
  // guard stops an abbreviation or a filename ("office-view-verify.md at
  // C:\...") from cutting the label down to nothing useful.
  const sentenceEnd = line.search(/[.!?](?:\s|$)/);
  if (sentenceEnd >= 12) line = line.slice(0, sentenceEnd);
  line = line.trim();
  if (!line) return '';

  line = truncateOnWordBoundary(line, maxLength);
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * The label to show for a task anywhere a short name is wanted. Prefers an
 * explicitly stored title (set at submission time), falls back to deriving
 * one from the instruction — which is what makes every historical task
 * recorded before the title field existed still render sensibly — and only
 * then to the task id.
 *
 * @param {{ title?: string, instruction?: string, id?: string }} task
 * @param {{ maxLength?: number }} [options]
 * @returns {string}
 */
export function taskDisplayTitle(task, options) {
  if (!task) return '';
  const explicit = typeof task.title === 'string' ? task.title.trim() : '';
  if (explicit) return explicit;
  const derived = deriveTaskTitle(task.instruction, options);
  if (derived) return derived;
  return task.id ? String(task.id) : '';
}

/**
 * Normalise a title supplied by a caller (the dashboard's optional "Short
 * task name" field, or the connector). Returns '' when nothing usable was
 * given, so callers can fall back to derivation.
 *
 * @param {string} title
 * @returns {string}
 */
export function normalizeTaskTitle(title, { maxLength = MAX_TASK_TITLE_LENGTH } = {}) {
  const cleaned = cleanLine(typeof title === 'string' ? title : '');
  if (!cleaned) return '';
  return truncateOnWordBoundary(cleaned, maxLength);
}
