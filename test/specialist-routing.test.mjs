import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeTask } from '../src/coding.mjs';
import { createTask } from '../src/router.mjs';
const fixtureCodeTask = (root, instruction, options = {}) => codeTask(root, instruction, { project: 'test-site', ...options });
import { read, json } from '../src/storage.mjs';
import { buildSchema, planSchema } from '../src/contracts.mjs';
import { matchSpecialist, loadSpecialistInstructions } from '../src/specialists.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = read(path.join(rootDir, 'workers.json'));
const files = ['index.html', 'styles.css', 'app.js'].map(name => ({
  path: name,
  content: fs.readFileSync(path.join(rootDir, 'fixtures', 'test-site', name), 'utf8')
}));
const formFiles = files.map(f => f.path === 'index.html' ? {
  ...f,
  content: f.content.replace('A contact form will be added here.', '<form id="contact-form"><label for="name">Name</label><input id="name" required><label for="email">Email</label><input type="email" id="email" required><label for="msg">Message</label><textarea id="msg" required></textarea><div role="status" id="status"></div><button type="submit">Send message</button></form>')
} : f);
const buildResult = { summary: 'Specialist-guided implementation', files: formFiles };

function fixture() {
  const tmp = fs.mkdtempSync(path.resolve('.router/tests/pilot-'));
  fs.cpSync(path.join(rootDir, 'fixtures'), path.join(tmp, 'fixtures'), { recursive: true });
  const testConfig = structuredClone(config);
  for (const w of testConfig.workers) {
    if (w.id === 'codex' || w.id === 'antigravity' || w.id === 'cline') {
      w.enabled = true;
    }
  }
  json(path.join(tmp, 'workers.json'), testConfig);
  return tmp;
}

test('Pilot Test 1 — Frontend: automatically matches engineering-frontend-developer and chooses best worker/model/effort', async () => {
  const root = fixture();
  const promptCaptures = [];
  const instruction = 'Build frontend form components: add a contact form to the test website';

  // 1. Verify automatic specialist matching
  const matched = matchSpecialist(instruction, { root, role: 'build' });
  assert.ok(matched);
  assert.equal(matched.id, 'engineering-frontend-developer');

  const t = await fixtureCodeTask(root, instruction, {
    ready() {}, log() {}, paths: {},
    call: async (worker, opts) => {
      promptCaptures.push({ worker: worker.id, model: opts.model, effort: opts.effort, prompt: opts.prompt, role: opts.schema === buildSchema ? 'build' : 'review' });
      if (opts.schema === buildSchema) return structuredClone(buildResult);
      return { verdict: 'pass', summary: 'Frontend implementation approved', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'form-exists', passed: true }, { name: 'submit', passed: true }] };
      json(report, r);
      return r;
    }
  });

  assert.equal(t.status, 'awaiting_approval');
  assert.equal(t.contributors[0], 'cline'); // Standard web recipe selects Cline as economical low-cost worker
  assert.equal(t.routingLog[0].specialist, 'engineering-frontend-developer');
  assert.equal(t.routingLog[0].model, 'gemini-3.5-flash-lite');
  assert.equal(t.routingLog[0].effort, 'medium');

  // Verify that specialist instructions were actually injected into the prompt
  const buildCall = promptCaptures.find(c => c.role === 'build');
  assert.ok(buildCall.prompt.includes('Frontend Developer'));
  assert.ok(buildCall.prompt.includes('Core Web Vitals'));

  // APPROVAL.md records specialist selection
  const reportContent = fs.readFileSync(t.approvalReport, 'utf8');
  assert.ok(reportContent.includes('engineering-frontend-developer'));
});

test('Pilot Test 2 — Security: reviewer independently audits using security-ai-generated-code-auditor and differs from builder', async () => {
  const root = fixture();
  const promptCaptures = [];
  const instruction = 'Add a contact form to the test website with safe input handling to prevent security vulnerabilities and script injection leaks';

  // Verify review specialist matching
  const reviewSpecialist = matchSpecialist(instruction, { root, role: 'review' });
  assert.ok(reviewSpecialist);
  assert.equal(reviewSpecialist.id, 'security-ai-generated-code-auditor');

  const t = await fixtureCodeTask(root, instruction, {
    ready() {}, log() {}, paths: {},
    call: async (worker, opts) => {
      promptCaptures.push({ worker: worker.id, model: opts.model, effort: opts.effort, prompt: opts.prompt, role: opts.schema === buildSchema ? 'build' : 'review' });
      if (opts.schema === buildSchema) {
        assert.equal(worker.id, 'codex'); // Builder
        return structuredClone(buildResult);
      }
      // Reviewer must NOT be the builder (Codex)
      assert.notEqual(worker.id, 'codex');
      return { verdict: 'pass', summary: 'Security audit passed: no hardcoded credentials or injection paths found', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });

  assert.equal(t.status, 'awaiting_approval');
  // Builder and reviewer are strictly distinct
  assert.notEqual(t.contributors[0], t.reviewer);
  assert.equal(t.routingLog[1].specialist, 'security-ai-generated-code-auditor');

  // Verify that security audit instructions were injected into reviewer prompt
  const reviewCall = promptCaptures.find(c => c.role === 'review');
  assert.ok(reviewCall.prompt.includes('AI-Generated Code Security Auditor'));
  assert.ok(reviewCall.prompt.includes('Catch secrets'));
});

test('Pilot Test 3 — SEO: low-risk metadata task routes to marketing-seo-specialist on Cline', async () => {
  const root = fixture();
  const promptCaptures = [];
  const instruction = 'Simple low-risk SEO metadata task: update sitemap metadata and meta tags for the contact form';

  // Verify builder specialist matching
  const matched = matchSpecialist(instruction, { root, role: 'build' });
  assert.ok(matched);
  assert.equal(matched.id, 'marketing-seo-specialist');

  const t = await fixtureCodeTask(root, instruction, {
    ready() {}, log() {}, paths: {},
    call: async (worker, opts) => {
      promptCaptures.push({ worker: worker.id, model: opts.model, effort: opts.effort, prompt: opts.prompt, role: opts.schema === buildSchema ? 'build' : 'review' });
      if (opts.schema === buildSchema) {
        // Low-risk SEO task automatically routes to Cline
        assert.equal(worker.id, 'cline');
        return structuredClone(buildResult);
      }
      assert.equal(worker.id, 'codex');
      return { verdict: 'pass', summary: 'SEO metadata structured markup verified by reviewer', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      const r = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
      json(report, r);
      return r;
    }
  });

  assert.equal(t.status, 'awaiting_approval');
  assert.equal(t.contributors[0], 'cline');
  assert.equal(t.reviewer, 'codex');
  assert.equal(t.routingLog[0].specialist, 'marketing-seo-specialist');
  // A qualified reviewer is required even when the builder came from the low-cost pool.
  assert.equal(t.routingLog[1].model, 'gpt-5.6-sol');

  // Verify SEO specialist instructions were injected
  const buildCall = promptCaptures.find(c => c.role === 'build');
  assert.ok(buildCall.prompt.includes('SEO Specialist'));
  assert.ok(buildCall.prompt.includes('Technical SEO'));
});

test('Pilot Test 4 — Product / Planning: loose feature idea automatically routes to product-manager specialist', async () => {
  const root = fixture();
  const instruction = 'We have a loose business feature idea for customer self-service appointment scheduling and booking. Plan this feature and define user requirements.';

  // Verify plan specialist matching
  const planSpecialist = matchSpecialist(instruction, { root, role: 'plan' });
  assert.ok(planSpecialist);
  assert.equal(planSpecialist.id, 'product-manager');

  let planPromptCapture = '';
  const task = await createTask(root, instruction, {
    invokeWorker: async (worker, opts) => {
      if (opts.schema === planSchema) {
        planPromptCapture = opts.prompt;
        return {
          goal: 'Deliver a customer self-service appointment booking workflow',
          jobs: [
            'booking-ui: Calendar date and time slot selector UI',
            'validation: Client-side contact and booking validation',
            'confirmation: Appointment confirmation and booking receipt'
          ],
          approvalActions: [],
          questions: []
        };
      }
      return { summary: 'Plan execution draft', files: [{ path: 'plan.md', content: '# Plan\nComplete.' }] };
    },
    preflight() {}
  });

  assert.equal(task.plan.specialist, 'product-manager');
  assert.equal(task.plan.jobs.length, 3);
  assert.ok(planPromptCapture.includes('Product Manager') || planPromptCapture.includes('product-manager'));
  assert.ok(planPromptCapture.includes('Specialist Planning Guidance'));
});

test('Pilot Test 5 — Accessibility: testing-accessibility-auditor independently reviews with browser testing', async () => {
  const root = fixture();
  const promptCaptures = [];
  const instruction = 'Ensure full accessibility, screen reader ARIA labels, and WCAG compliance when adding the contact form';

  // Verify accessibility specialist matching
  const a11ySpecialist = matchSpecialist(instruction, { root, role: 'review' });
  assert.ok(a11ySpecialist);
  assert.equal(a11ySpecialist.id, 'testing-accessibility-auditor');

  let browserTested = false;
  const t = await fixtureCodeTask(root, instruction, {
    ready() {}, log() {}, paths: {},
    call: async (worker, opts) => {
      promptCaptures.push({ worker: worker.id, model: opts.model, effort: opts.effort, prompt: opts.prompt, role: opts.schema === buildSchema ? 'build' : 'review' });
      if (opts.schema === buildSchema) return structuredClone(buildResult);
      return { verdict: 'pass', summary: 'WCAG 2.1 AA accessibility audit passed: all inputs have associated labels and aria roles', issues: [] };
    },
    test: async (_r, _p, report, digest) => {
      browserTested = true;
      const r = { passed: true, digest, checks: [{ name: 'aria-role-status', passed: true }, { name: 'label-for-inputs', passed: true }] };
      json(report, r);
      return r;
    }
  });

  assert.equal(browserTested, true);
  assert.equal(t.status, 'awaiting_approval');
  assert.equal(t.routingLog[1].specialist, 'testing-accessibility-auditor');

  // Verify that accessibility audit instructions were injected into reviewer prompt
  const reviewCall = promptCaptures.find(c => c.role === 'review');
  assert.ok(reviewCall.prompt.includes('Accessibility Auditor') || reviewCall.prompt.includes('testing-accessibility-auditor'));
  assert.ok(reviewCall.prompt.includes('WCAG'));
});
