import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { codeTask, composeValidationWorkspace, selectTargetedProjectContext } from '../src/coding.mjs';
import { shouldUseFullSpecialist, matchSpecialist, loadSpecialistInstructions } from '../src/specialists.mjs';
import { read, json, hash, verifyFiles } from '../src/storage.mjs';
import { buildSchema, reviewSchema } from '../src/contracts.mjs';
import { createProject } from '../src/projects.mjs';
import { createTestFixture, repoRoot } from './helpers/fixture-helper.mjs';

const testWorkersConfig = {
  workers: [
    {
      id: 'cline',
      enabled: true,
      roles: ['build'],
      priority: 35,
      adapter: 'cline'
    },
    {
      id: 'antigravity',
      enabled: true,
      roles: ['review', 'build'],
      priority: 30,
      adapter: 'antigravity'
    }
  ],
  maxCorrections: 2,
  workerTimeoutSeconds: 600,
  claudeReserve: true,
  connectorToken: 'CONNECTOR_TOKEN_REGENERATED_ON_FIRST_RUN'
};

function setupFixture(t) {
  const dir = createTestFixture('prompt-size-', {
    seedFixtures: true,
    seedSpecialists: true,
    workersConfig: testWorkersConfig,
    t
  });
  const runtimeJson = path.join(repoRoot, 'browser-runtime.json');
  if (fs.existsSync(runtimeJson)) {
    fs.copyFileSync(runtimeJson, path.join(dir, 'browser-runtime.json'));
  }
  return dir;
}

function setupMultiFileProject(root, projectName = 'Prompt Size Lab') {
  const projectFolder = path.join(root, 'test-project-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(projectFolder, { recursive: true });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Prompt Sizing Test</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header>
    <h1>Site Header</h1>
  </header>
  <main>
    <p>Content</p>
  </main>
  <script src="app.js"></script>
</body>
</html>`;

  const css = `body { font-family: sans-serif; margin: 0; padding: 1rem; }
header { background: #eee; padding: 1rem; }
button { padding: 0.5rem 1rem; cursor: pointer; }`;

  const js = `document.addEventListener('DOMContentLoaded', () => {
  console.log('App ready');
});`;

  const readme = `# Site Documentation
This is a comprehensive documentation file for the project.
It contains extensive guides, architectures, API documentation,
and history notes that are completely unrelated to individual UI tasks.
`.repeat(30); // ~4 KB of docs

  fs.writeFileSync(path.join(projectFolder, 'index.html'), html, 'utf8');
  fs.writeFileSync(path.join(projectFolder, 'styles.css'), css, 'utf8');
  fs.writeFileSync(path.join(projectFolder, 'app.js'), js, 'utf8');
  fs.writeFileSync(path.join(projectFolder, 'README.md'), readme, 'utf8');

  const registered = createProject(root, {
    name: projectName,
    mode: 'existing',
    folderPath: projectFolder
  });

  return { projectFolder, registered, files: { html, css, js, readme } };
}

test('Adaptive Router — Premium Worker Prompt Right-Sizing Suite', async (t) => {

  // Case 1: Tiny one-file task uses concise specialist profile
  await t.test('1. Tiny one-file task uses concise specialist profile', () => {
    const specialist = matchSpecialist('Add a high-contrast mode toggle button with aria-pressed state to the test website header.', { role: 'build' });
    assert.ok(specialist, 'Should match accessibility or frontend specialist');

    const shouldUseFull = shouldUseFullSpecialist({
      instruction: 'Add a high-contrast mode toggle button with aria-pressed state to the test website header.',
      role: 'build',
      specialist,
      revision: 0
    });
    assert.equal(shouldUseFull, false, 'Routine task must NOT use full specialist handbook');

    const conciseInstructions = loadSpecialistInstructions(specialist.id, repoRoot, { concise: true });
    assert.ok(conciseInstructions.includes('Specialist:'), 'Contains specialist header');
    assert.ok(conciseInstructions.includes('Expertise:'), 'Contains expertise summary');
    assert.ok(conciseInstructions.length < 600, `Concise instructions must be small, got ${conciseInstructions.length} bytes`);
    assert.ok(!conciseInstructions.includes('### Checklist'), 'Concise profile must not include multi-page checklists');
  });

  // Case 2: Model Tier 3 alone does NOT trigger full specialist instructions
  await t.test('2. Model Tier 3 alone does NOT trigger full specialist instructions', () => {
    const specialist = matchSpecialist('Add aria-label to the button', { role: 'build' });
    const shouldUseFull = shouldUseFullSpecialist({
      instruction: 'Add aria-label to the button',
      task: { builderTier: 3, builderModel: 'claude-3-7-sonnet' },
      role: 'build',
      specialist,
      revision: 0
    });
    assert.equal(shouldUseFull, false, 'Tier 3 model alone must NOT trigger full specialist instructions');
  });

  // Case 3: Explicit specialist/audit task can still receive full specialist guidance
  await t.test('3. Explicit specialist/audit task can still receive full specialist guidance', () => {
    const auditSpecialist = matchSpecialist('Perform an accessibility audit and WCAG conformance check on the website', { role: 'review' });
    const shouldUseFullAudit = shouldUseFullSpecialist({
      instruction: 'Perform an accessibility audit and WCAG conformance check on the website',
      role: 'review',
      specialist: auditSpecialist,
      revision: 0
    });
    assert.equal(shouldUseFullAudit, true, 'Explicit audit/conformance task must receive full specialist guidance');

    const secSpecialist = matchSpecialist('Investigate potential credential leak and secret vulnerability in auth endpoint', { role: 'review' });
    const shouldUseFullSec = shouldUseFullSpecialist({
      instruction: 'Investigate potential credential leak and secret vulnerability in auth endpoint',
      role: 'review',
      specialist: secSpecialist,
      revision: 0
    });
    assert.equal(shouldUseFullSec, true, 'Active security vulnerability investigation must receive full specialist guidance');
  });

  // Case 4: Tiny index.html task does not inject unrelated README.md
  await t.test('4. Tiny index.html task does not inject unrelated README.md', () => {
    const files = [
      { path: 'index.html', content: '<h1>Test</h1>' },
      { path: 'styles.css', content: 'h1 { color: red; }' },
      { path: 'app.js', content: 'console.log("hi");' },
      { path: 'README.md', content: '# Documentation\n'.repeat(500) }
    ];

    const instruction = 'Add a high-contrast mode toggle button with aria-pressed state to index.html';
    const { targetedFiles, omittedFiles } = selectTargetedProjectContext(files, instruction);

    const targetedPaths = targetedFiles.map(f => f.path);
    const omittedPaths = omittedFiles.map(f => f.path);

    assert.ok(targetedPaths.includes('index.html'), 'Targeted files must include index.html');
    assert.ok(omittedPaths.includes('README.md'), 'Omitted files must include README.md');
    assert.ok(!targetedPaths.includes('README.md'), 'Targeted files must NOT include README.md');
  });

  // Case 5: Builder receives target file content required for completion
  await t.test('5. Builder receives target file content required for completion', () => {
    const files = [
      { path: 'index.html', content: '<header><button id="btn">Click</button></header>' },
      { path: 'README.md', content: 'Unrelated' }
    ];
    const instruction = 'Add aria-label to button in index.html';
    const { targetedFiles } = selectTargetedProjectContext(files, instruction);

    const target = targetedFiles.find(f => f.path === 'index.html');
    assert.ok(target, 'index.html must be present');
    assert.equal(target.content, '<header><button id="btn">Click</button></header>');
  });

  // Case 6: Ambiguous task safely falls back to broader context
  await t.test('6. Ambiguous task safely falls back to broader context', () => {
    const files = [
      { path: 'src/main.js', content: 'console.log("app");' },
      { path: 'src/utils.js', content: 'export const x = 1;' },
      { path: 'README.md', content: 'Read me docs' }
    ];
    const instruction = 'Make code improvements';
    const { targetedFiles, omittedFiles } = selectTargetedProjectContext(files, instruction);

    const targetedPaths = targetedFiles.map(f => f.path);
    assert.ok(targetedPaths.includes('src/main.js'), 'Ambiguity fallback includes core code files');
    assert.ok(targetedPaths.includes('src/utils.js'), 'Ambiguity fallback includes companion code files');
    assert.ok(!targetedPaths.includes('README.md'), 'Ambiguity fallback still prunes documentation');
  });

  // Case 7 & 8: Builder prompt right-sizing for Claude Code & Codex in codeTask
  await t.test('7 & 8. Claude Code and Codex prompt construction right-sizing in codeTask', async () => {
    const root = setupFixture(t);
    const { projectFolder, registered, files } = setupMultiFileProject(root);

    let capturedBuildPrompt = null;
    let capturedReviewPrompt = null;

    const task = await codeTask(root, 'Add a high-contrast mode toggle button with aria-pressed state to index.html', {
      project: registered.id,
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          capturedBuildPrompt = opts.prompt;
          return {
            summary: 'Added high-contrast button',
            files: [
              { path: 'index.html', content: files.html.replace('Site Header</h1>', 'Site Header</h1>\n    <button id="contrast-toggle" aria-pressed="false">High Contrast</button>') }
            ]
          };
        }
        if (opts.schema === reviewSchema) {
          capturedReviewPrompt = opts.prompt;
          return { verdict: 'pass', summary: 'Clean and accessible', issues: [] };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      },
      test: async (r, projDir, repPath, digest) => {
        const res = { passed: true, digest, checks: [{ name: 'Ok', passed: true }], time: new Date().toISOString() };
        json(repPath, res);
        return res;
      }
    });

    assert.equal(task.status, 'awaiting_approval');

    // Verify Builder Prompt Right-Sizing
    assert.ok(capturedBuildPrompt, 'Must capture build prompt');
    assert.ok(capturedBuildPrompt.includes('index.html'), 'Build prompt contains targeted index.html');
    assert.ok(!capturedBuildPrompt.includes(files.readme), 'Build prompt must NOT embed 4KB README contents');
    assert.ok(capturedBuildPrompt.includes('Specialist:'), 'Specialist loaded in prompt');
    assert.ok(capturedBuildPrompt.includes('Expertise:'), 'Specialist expertise in prompt');
    assert.ok(task.activityLog.some(a => (a.desc || a.detail || '').includes('(concise profile)')), 'Specialist loaded as concise profile');
    assert.ok(!capturedBuildPrompt.includes('### Checklist'), 'Specialist handbook checklist not in prompt');

    // Verify Reviewer Prompt Right-Sizing
    assert.ok(capturedReviewPrompt, 'Must capture review prompt');
    const baseMatch = capturedReviewPrompt.match(/Baseline:\s*(\[.*?\])(?:\nCurrent code:|$)/s);
    assert.ok(baseMatch, 'Must match Baseline array');
    const reviewerBaseline = JSON.parse(baseMatch[1]);
    assert.equal(reviewerBaseline.length, 1, 'Reviewer baseline must ONLY contain modified index.html');
    assert.equal(reviewerBaseline[0].path, 'index.html');

    // Verify unchanged files not duplicated in Baseline
    assert.ok(!reviewerBaseline.some(b => b.path === 'styles.css'), 'styles.css must not be in Baseline');
    assert.ok(!reviewerBaseline.some(b => b.path === 'app.js'), 'app.js must not be in Baseline');
    assert.ok(!reviewerBaseline.some(b => b.path === 'README.md'), 'README.md must not be in Baseline');
    assert.ok(capturedReviewPrompt.includes('Unchanged project files (verified untouched)'), 'Reviewer prompt notes untouched files');
  });

  // Case 9 & 10: Reviewer receives before/after for changed files only, not duplicated unchanged files
  await t.test('9 & 10. Reviewer receives before/after for changed files without duplicate unchanged baseline', async () => {
    const root = setupFixture(t);
    const { projectFolder, registered, files } = setupMultiFileProject(root, 'Reviewer Test Lab');

    let capturedReviewPrompt = null;

    const task = await codeTask(root, 'Update styles.css to set high-contrast background', {
      project: registered.id,
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          return {
            summary: 'Updated styles',
            files: [
              { path: 'styles.css', content: files.css + '\n.high-contrast { background: #000; color: #fff; }\n' }
            ]
          };
        }
        if (opts.schema === reviewSchema) {
          capturedReviewPrompt = opts.prompt;
          return { verdict: 'pass', summary: 'Good CSS styling', issues: [] };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      },
      test: async (r, projDir, repPath, digest) => {
        const res = { passed: true, digest, checks: [{ name: 'Ok', passed: true }], time: new Date().toISOString() };
        json(repPath, res);
        return res;
      }
    });

    assert.equal(task.status, 'awaiting_approval');
    assert.ok(capturedReviewPrompt);

    const baseMatch = capturedReviewPrompt.match(/Baseline:\s*(\[.*?\])(?:\nCurrent code:|$)/s);
    const codeMatch = capturedReviewPrompt.match(/Current code:\s*(\[.*?\])(?:\nActual validator results:|$)/s);

    const baseFiles = JSON.parse(baseMatch[1]);
    const currFiles = JSON.parse(codeMatch[1]);

    assert.equal(baseFiles.length, 1, 'Baseline contains ONLY changed styles.css');
    assert.equal(baseFiles[0].path, 'styles.css');
    assert.equal(currFiles.length, 1, 'Current code contains ONLY changed styles.css');
    assert.equal(currFiles[0].path, 'styles.css');
  });

  // Case 11: Revision feedback remains present when required & specialist escalation
  await t.test('11. Revision feedback remains present when required & escalates specialist on repeat failure', async () => {
    const root = setupFixture(t);
    const { projectFolder, registered, files } = setupMultiFileProject(root, 'Feedback Lab');

    let buildPrompts = [];
    let reviewCount = 0;

    const task = await codeTask(root, 'Add button to index.html', {
      project: registered.id,
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          buildPrompts.push(opts.prompt);
          return {
            summary: `Draft revision ${buildPrompts.length}`,
            files: [
              { path: 'index.html', content: files.html.replace('Site Header</h1>', 'Site Header</h1>\n<button>Btn</button>') }
            ]
          };
        }
        if (opts.schema === reviewSchema) {
          reviewCount++;
          if (reviewCount === 1) {
            return { verdict: 'changes_requested', summary: 'Missing WCAG aria-label attribute', issues: ['Add aria-label according to WCAG criterion 4.1.2'] };
          }
          return { verdict: 'pass', summary: 'Passed with aria-label', issues: [] };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      },
      test: async (r, projDir, repPath, digest) => {
        const res = { passed: true, digest, checks: [{ name: 'Ok', passed: true }], time: new Date().toISOString() };
        json(repPath, res);
        return res;
      }
    });

    assert.equal(task.status, 'awaiting_approval');
    assert.equal(task.revision, 2);
    assert.equal(buildPrompts.length, 2);

    // Revision 2 build prompt must contain review feedback
    assert.ok(buildPrompts[1].includes('Missing WCAG aria-label attribute'), 'Rev 2 prompt retains reviewer feedback');
    assert.ok(buildPrompts[1].includes('WCAG criterion 4.1.2'), 'Rev 2 prompt retains specific criterion');
  });

  // Case 12: Validation workspace integrity preserved (includes README.md on disk)
  await t.test('12. Validation-workspace tests remain green and complete', () => {
    const root = setupFixture(t);
    const taskDir = path.join(root, '.router', 'tasks', 'task-val-intact');
    fs.mkdirSync(taskDir, { recursive: true });

    const baseline = [
      { path: 'index.html', content: '<h1>Original</h1>' },
      { path: 'styles.css', content: 'h1 { color: blue; }' },
      { path: 'README.md', content: '# Documentation' }
    ];
    json(path.join(taskDir, 'baseline.json'), baseline);

    const task = { id: 'task-val-intact', revision: 1 };
    const deliverable = [{ path: 'index.html', content: '<h1>Modified</h1>' }];

    const valDir = composeValidationWorkspace(taskDir, task, deliverable);

    assert.ok(fs.existsSync(path.join(valDir, 'index.html')), 'validation workspace has index.html');
    assert.equal(fs.readFileSync(path.join(valDir, 'index.html'), 'utf8'), '<h1>Modified</h1>', 'index.html has modified content');
    assert.ok(fs.existsSync(path.join(valDir, 'styles.css')), 'validation workspace preserves styles.css');
    assert.ok(fs.existsSync(path.join(valDir, 'README.md')), 'validation workspace preserves README.md');
    assert.equal(fs.readFileSync(path.join(valDir, 'README.md'), 'utf8'), '# Documentation');
  });

  // Case 13 & 14: Documentation explicit request inclusion
  await t.test('13 & 14. Explicit documentation request includes README.md in targeted files', () => {
    const files = [
      { path: 'index.html', content: '<h1>Test</h1>' },
      { path: 'README.md', content: '# Project Documentation\nInstall instructions' }
    ];
    const instruction = 'Update the README.md with new setup guide';
    const { targetedFiles, omittedFiles } = selectTargetedProjectContext(files, instruction);

    const targetedPaths = targetedFiles.map(f => f.path);
    assert.ok(targetedPaths.includes('README.md'), 'Explicitly requested README.md MUST be included in targeted files');
    assert.equal(omittedFiles.length, 1);
    assert.equal(omittedFiles[0].path, 'index.html');
  });
});
