import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let cachedRegistry = null;

/**
 * Loads the specialist registry from specialists.json.
 * @param {string} [root]
 * @returns {object} Registry object containing metadata and specialists list
 */
export function loadRegistry(root = defaultRoot) {
  if (cachedRegistry) return cachedRegistry;
  let registryFile = path.join(root, 'specialists.json');
  if (!fs.existsSync(registryFile)) {
    registryFile = path.join(defaultRoot, 'specialists.json');
  }
  if (!fs.existsSync(registryFile)) {
    throw new Error(`Specialist registry not found at ${registryFile}`);
  }
  cachedRegistry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  return cachedRegistry;
}

/**
 * Retrieves a single specialist by its slug/ID.
 * @param {string} id
 * @param {string} [root]
 * @returns {object|null}
 */
export function getSpecialist(id, root = defaultRoot) {
  const reg = loadRegistry(root);
  return reg.specialists.find(s => s.id === id) || null;
}

/**
 * Filters specialists by category, priority, or supported platform.
 * @param {object} filters
 * @param {string} [root]
 * @returns {Array<object>}
 */
export function filterSpecialists({ category, priority, platform, portable } = {}, root = defaultRoot) {
  const reg = loadRegistry(root);
  return reg.specialists.filter(s => {
    if (category && s.mainCategory !== category) return false;
    if (priority && s.priority !== priority) return false;
    if (portable !== undefined && s.portable !== portable) return false;
    if (platform && !s.supportedPlatforms.includes(platform)) return false;
    return true;
  });
}

/**
 * Safely loads the actual markdown instruction body of a specialist from its local file.
 * Preserves the file intact; performs read-only extraction.
 * @param {string} id
 * @param {string} [root]
 * @returns {string}
 */
export function loadSpecialistInstructions(id, root = defaultRoot) {
  const specialist = getSpecialist(id, root);
  if (!specialist) {
    throw new Error(`Specialist '${id}' not found in registry.`);
  }
  if (!fs.existsSync(specialist.sourceFile)) {
    throw new Error(`Source file for specialist '${id}' not found at ${specialist.sourceFile}`);
  }
  const raw = fs.readFileSync(specialist.sourceFile, 'utf8');
  // Strip YAML frontmatter if present to return pure system instructions
  if (raw.startsWith('---')) {
    const parts = raw.split('---', 3);
    if (parts.length >= 3) {
      return parts[2].trim();
    }
  }
  return raw.trim();
}

/**
 * Keyword and semantic intent matcher to find the single most relevant specialist for a given task.
 * Ensures that only the relevant specialist is loaded rather than bloating the context.
 * @param {string} taskInstruction
 * @param {string} [root]
 * @returns {object|null} The matched specialist or null
 */
export function matchSpecialist(taskInstruction, options = defaultRoot) {
  if (!taskInstruction || typeof taskInstruction !== 'string') return null;
  let root = defaultRoot;
  let role = 'build';
  if (typeof options === 'string') {
    root = options;
  } else if (options && typeof options === 'object') {
    root = options.root || defaultRoot;
    role = options.role || 'build';
  }

  const reg = loadRegistry(root);
  const text = taskInstruction.toLowerCase();

  // Role: Review Specialists
  if (role === 'review') {
    const reviewRules = [
      { pattern: /\b(security|vulnerabilit|credential|secret|api\s*key|injection|auth\s*leak)\b/, id: 'security-ai-generated-code-auditor' },
      { pattern: /\b(accessibility|a11y|screen\s*reader|aria|wcag)\b/, id: 'testing-accessibility-auditor' },
      { pattern: /\b(performance|latency|bundle|speed|caching|cwv)\b/, id: 'testing-performance-benchmarker' },
      { pattern: /\b(api\s*test|endpoint|contract|fuzz|status\s*code)\b/, id: 'testing-api-tester' },
      { pattern: /\b(reality\s*check|browser\s*test|visual|independent\s*review)\b/, id: 'testing-reality-checker' }
    ];
    for (const matcher of reviewRules) {
      if (matcher.pattern.test(text)) {
        const match = reg.specialists.find(s => s.id === matcher.id);
        if (match) return match;
      }
    }
    // Default reviewer specialist
    return reg.specialists.find(s => s.id === 'testing-reality-checker') || null;
  }

  // Role: Plan Specialists
  if (role === 'plan') {
    const planRules = [
      { pattern: /\b(product|feature|requirements|user\s*stor|roadmap|spec)\b/, id: 'product-manager' },
      { pattern: /\b(business|roi|pricing|market\s*position|revenue|unit\s*economics)\b/, id: 'business-strategist' }
    ];
    for (const matcher of planRules) {
      if (matcher.pattern.test(text)) {
        const match = reg.specialists.find(s => s.id === matcher.id);
        if (match) return match;
      }
    }
    return reg.specialists.find(s => s.id === 'product-manager') || null;
  }

  // Role: Build Specialists
  const buildRules = [
    { pattern: /\b(accessibility|a11y|screen\s*reader|aria|wcag)\b/, id: 'testing-accessibility-auditor' },
    { pattern: /\b(security|vulnerabilit|credential|secret|api\s*key\s*leak|injection)\b/, id: 'security-ai-generated-code-auditor' },
    { pattern: /\b(seo|search\s*engine|metadata|robots\.txt|sitemap|meta\s*tag)\b/, id: 'marketing-seo-specialist' },
    { pattern: /\b(aeo|citation|perplex|chatgpt\s*search|ai\s*overview)\b/, id: 'marketing-ai-citation-strategist' },
    { pattern: /\b(css|styling|layout|responsive|ui\s*design|visual|typography|color)\b/, id: 'design-ui-designer' },
    { pattern: /\b(frontend|html|form|dom|javascript\s*client|contact\s*form)\b/, id: 'engineering-frontend-developer' },
    { pattern: /\b(mcp|model\s*context\s*protocol|mcp\s*server)\b/, id: 'specialized-mcp-builder' },
    { pattern: /\b(drift|archaeolog|dead\s*code|refactor\s*mismatch|stale\s*logic)\b/, id: 'specialized-codebase-archaeologist' },
    { pattern: /\b(api\s*test|endpoint\s*test|fuzz|status\s*code)\b/, id: 'testing-api-tester' },
    { pattern: /\b(backend|database\s*schema|rest\s*api|server|microservice)\b/, id: 'engineering-backend-architect' },
    { pattern: /\b(performance|latency|bundle|speed|caching)\b/, id: 'engineering-performance-engineer' },
    { pattern: /\b(workflow|pipeline|automation|orchestrat)\b/, id: 'specialized-workflow-architect' },
    { pattern: /\b(content|copywriting|landing\s*page)\b/, id: 'marketing-content-creator' },
    { pattern: /\b(email|onboarding|newsletter)\b/, id: 'marketing-email-strategist' },
    { pattern: /\b(business|roi|pricing|market\s*position)\b/, id: 'business-strategist' }
  ];

  for (const matcher of buildRules) {
    if (matcher.pattern.test(text)) {
      const match = reg.specialists.find(s => s.id === matcher.id);
      if (match) return match;
    }
  }

  // Fallback: token scoring on specialist expertise and name
  const tokens = text.split(/\W+/).filter(t => t.length > 3);
  let bestSpecialist = null;
  let maxScore = 0;

  for (const s of reg.specialists) {
    if (s.priority === 'low') continue;
    let score = 0;
    const target = `${s.id} ${s.name} ${s.expertise}`.toLowerCase();
    const targetTokens = new Set(target.split(/[^a-z0-9]+/).filter(token => token.length > 3));
    for (const t of tokens) {
      if (targetTokens.has(t)) score++;
    }
    if (score > maxScore && score >= 2) {
      maxScore = score;
      bestSpecialist = s;
    }
  }

  return bestSpecialist;
}
