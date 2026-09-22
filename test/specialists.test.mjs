import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, getSpecialist, filterSpecialists, loadSpecialistInstructions, matchSpecialist } from '../src/specialists.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('specialists registry loads all 131 specialists with valid schema', () => {
  const reg = loadRegistry(root);
  assert.equal(reg.totalSpecialists, 131);
  assert.equal(reg.specialists.length, 131);
  assert.ok(reg.portableCount >= 115);
  assert.ok(reg.highPriorityCount >= 15);

  // Check every specialist record has mandatory fields
  for (const s of reg.specialists) {
    assert.ok(s.id, 'Must have id');
    assert.ok(s.name, 'Must have name');
    assert.ok(s.expertise, 'Must have expertise');
    assert.ok(s.mainCategory, 'Must have mainCategory');
    assert.ok(s.classification, 'Must have classification');
    assert.equal(typeof s.portable, 'boolean');
    assert.equal(typeof s.claudeRequired, 'boolean');
    assert.ok(Array.isArray(s.supportedPlatforms));
    assert.ok(Array.isArray(s.requiredTools));
    assert.ok(['high', 'medium', 'low'].includes(s.priority));
    // sourceFile is optional metadata (machine-specific path to local agent doc).
    // Not required for specialist functionality — concise mode works without it.
    if (s.sourceFile !== undefined) {
      assert.equal(typeof s.sourceFile, 'string', 'sourceFile must be string if present');
    }
  }
});

test('getSpecialist retrieves individual specialist by slug', () => {
  const sec = getSpecialist('security-ai-generated-code-auditor', root);
  assert.ok(sec);
  assert.equal(sec.id, 'security-ai-generated-code-auditor');
  assert.equal(sec.priority, 'high');
  assert.equal(sec.portable, true);
  assert.equal(sec.claudeRequired, false);

  const missing = getSpecialist('nonexistent-specialist-123', root);
  assert.equal(missing, null);
});

test('filterSpecialists filters accurately by category, priority, and portability', () => {
  const highPriority = filterSpecialists({ priority: 'high' }, root);
  assert.ok(highPriority.length >= 15);

  const security = filterSpecialists({ category: 'Security & Trust' }, root);
  assert.ok(security.length >= 6);

  const claudeOnly = filterSpecialists({ portable: false }, root);
  assert.equal(claudeOnly.length, 1);
  assert.equal(claudeOnly[0].id, 'agents-orchestrator');
});

test('loadSpecialistInstructions extracts markdown body without touching source file', () => {
  const instructions = loadSpecialistInstructions('security-ai-generated-code-auditor', root);
  assert.ok(instructions.length > 500);
  assert.ok(instructions.includes('AI-Generated Code Security Auditor'));
  // Frontmatter must be stripped
  assert.ok(!instructions.startsWith('---'));
});

test('matchSpecialist accurately matches task keywords to relevant specialist without loading all into context', () => {
  const a11yMatch = matchSpecialist('Verify WCAG compliance and screen reader aria labels on the contact form', root);
  assert.ok(a11yMatch);
  assert.equal(a11yMatch.id, 'testing-accessibility-auditor');

  const secMatch = matchSpecialist('Audit our generated code for API key leaks and SQL injection vulnerabilities', root);
  assert.ok(secMatch);
  assert.equal(secMatch.id, 'security-ai-generated-code-auditor');

  const cssMatch = matchSpecialist('Update the responsive CSS styling and color typography', root);
  assert.ok(cssMatch);
  assert.equal(cssMatch.id, 'design-ui-designer');

  const seoMatch = matchSpecialist('Review technical SEO meta tags and sitemap crawlability', root);
  assert.ok(seoMatch);
  assert.equal(seoMatch.id, 'marketing-seo-specialist');
});
