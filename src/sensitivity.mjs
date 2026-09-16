// Sensitive-task detection and credential-leak guarding.
//
// Business rule (set by the CTO): tasks that touch credentials, API keys,
// account access, payment processing, or system-level commands must never
// be handed to any Adaptive Router worker model (Codex, Claude Code,
// Antigravity, or Cline). Those tasks come to Claude (acting as CTO)
// directly instead. Customer data and payment DETAILS (e.g. "email the
// customer's shipping address to fulfillment", "record this order total")
// are explicitly NOT considered sensitive by the CTO and may flow to
// worker models normally — only the credential/access/system-command
// surface is blocked here.
//
// This module is intentionally conservative: false positives (flagging a
// task that turns out to be harmless) just mean Claude looks at one extra
// task personally, which is safe. False negatives (missing a genuinely
// sensitive task) would leak credentials to a third-party model, which is
// not acceptable — so the patterns below are kept broad on purpose.

// Matches an instruction that is ASKING for credential/account/system-level
// work to be done, as opposed to merely mentioning an unrelated word that
// happens to overlap (kept as narrow as reasonably possible while erring
// toward catching real cases).
const SENSITIVE_PATTERNS = [
  // Credentials & secrets
  /\b(api[\s_-]?key|secret[\s_-]?(access[\s_-]?)?key|access[\s_-]?token|auth[\s_-]?token|bearer[\s_-]?token|private[\s_-]?key|client[\s_-]?secret)\b/i,
  /\b(password|passphrase|credentials?)\b/i,
  /\.env\b|\bsecrets\.(json|ya?ml)\b/i,
  // Account / identity access
  /\b(log\s?in|sign\s?in|log\s?into|authenticate)\b.*\b(account|cloudflare|hostinger|aws|azure|gcp|google\s+cloud|stripe|paypal|bank|domain\s+registrar)\b/i,
  /\b(cloudflare|hostinger)\b.*\b(account|token|api|dns|zone|dashboard|login)\b/i,
  /\b(two[\s_-]?factor|2fa|mfa|otp|recovery\s+code)\b/i,
  // Payment processing (processing/moving money — NOT customer payment
  // details/records, which the CTO said are fine for workers to see)
  /\b(charge|refund|payout|withdraw|transfer\s+funds|process\s+a?\s*payment|stripe\s+(api|secret|charge)|paypal\s+api)\b/i,
  // System-level commands / infra access
  /\b(ssh\s+into|remote\s+desktop|rdp\s+into|sudo\s|run\s+as\s+admin|elevate\s+privileges?)\b/i,
  /\b(delete|wipe|format)\b.*\b(disk|drive|partition|system\s+files?|registry)\b/i,
  /\b(dns\s+record|nameserver|domain\s+registrar|ssl\s+certificate|firewall\s+rule)\b.*\b(change|update|add|delete|configure)\b/i,
  /\b(environment\s+variable|env\s+var)\b.*\b(set|add|configure)\b/i
];

// Returns { sensitive: boolean, reason: string|null, matched: string|null }
export function classifySensitivity(instruction = '') {
  const text = String(instruction || '');
  for (const pattern of SENSITIVE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return {
        sensitive: true,
        reason: 'This task involves credentials, account access, payment processing, or system-level commands — Adaptive Router keeps this class of work off every worker model and routes it to Claude (CTO) directly.',
        matched: match[0]
      };
    }
  }
  return { sensitive: false, reason: null, matched: null };
}

// Defense-in-depth: even for tasks that pass the sensitivity check, scan the
// final instruction text for anything that LOOKS like an actual live secret
// (not just a mention of the concept) before it would be sent to a worker.
// This mirrors the redaction patterns already used for sanitizing displayed
// logs in events.mjs, applied here as a hard pre-send gate instead of just
// a display-time redaction.
const LIKELY_SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}\b/,              // OpenAI-style secret keys
  /\bAKIA[0-9A-Z]{16}\b/,                  // AWS access key id
  /\bghp_[a-zA-Z0-9]{30,}\b/,              // GitHub personal access token
  /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/,      // Slack tokens
  /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*\b/, // Raw bearer token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/     // PEM private key block
];

export function containsLikelySecret(text = '') {
  const combined = String(text || '');
  for (const pattern of LIKELY_SECRET_PATTERNS) {
    if (pattern.test(combined)) return true;
  }
  return false;
}
