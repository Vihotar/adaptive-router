import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeTask } from '../src/coding.mjs';
import { read, json, hash } from '../src/storage.mjs';
import { buildSchema, reviewSchema } from '../src/contracts.mjs';
import { selectModelAndEffort } from '../src/smart-router.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const workersConfig = {
  workers: [
    {
      id: 'codex',
      enabled: false,
      roles: ['plan', 'build', 'review'],
      priority: 10,
      adapter: 'codex'
    },
    {
      id: 'antigravity',
      enabled: true,
      roles: ['review', 'build'],
      priority: 30,
      adapter: 'antigravity'
    },
    {
      id: 'claude-code',
      enabled: false,
      roles: ['build', 'review'],
      priority: 20,
      adapter: 'claude'
    },
    {
      id: 'cline',
      enabled: true,
      roles: ['build'],
      priority: 35,
      adapter: 'cline'
    }
  ],
  maxCorrections: 2,
  workerTimeoutSeconds: 600,
  claudeReserve: true,
  connectorToken: 'CONNECTOR_TOKEN_REGENERATED_ON_FIRST_RUN'
};

function createFixture() {
  const tmp = fs.mkdtempSync(path.resolve('.router/tests/review-mismatch-'));
  fs.cpSync(path.join(rootDir, 'fixtures'), path.join(tmp, 'fixtures'), { recursive: true });
  json(path.join(tmp, 'workers.json'), workersConfig);
  return tmp;
}

test('Review Mismatch Fix & Dedicated Progress vs Technical Logs Suite', async (t) => {

  await t.test('1. Validator and reviewer receive exact same draft', async () => {
    const root = createFixture();
    let reviewerCodeStr = null;

    const task = await codeTask(root, 'Create greeting script', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          return {
            summary: 'Created greeting module and test',
            files: [
              { path: 'greeting.js', content: 'export function greet(name) { return `Hello, ${name}!`; }\n' },
              { path: 'test/greeting.test.mjs', content: 'import assert from "node:assert";\nimport { greet } from "../greeting.js";\nassert.equal(greet("World"), "Hello, World!");\n' }
            ]
          };
        }
        if (opts.schema === reviewSchema) {
          const match = opts.prompt.match(/Current code:\s*(\[.*?\])(?:\nActual validator results:|$)/s);
          if (match) reviewerCodeStr = match[1];
          return { verdict: 'pass', summary: 'All files present and tests pass', issues: [] };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      }
    });

    assert.equal(task.status, 'awaiting_approval');
    assert.ok(task.tests?.digest, 'tests.digest must be recorded');
    assert.equal(task.tests.digest, task.digest, 'Validator evaluated exact task digest');

    assert.ok(reviewerCodeStr, 'Reviewer prompt must contain Current code');
    const reviewerFiles = JSON.parse(reviewerCodeStr);
    assert.equal(reviewerFiles.length, 2, 'Reviewer received exact 2 files');
    assert.equal(hash(reviewerFiles), task.digest, 'Reviewer received exact same draft and digest');
  });

  await t.test('2. Requested files seen by validator visible to reviewer', async () => {
    const root = createFixture();
    let reviewerSeenPaths = [];

    const task = await codeTask(root, 'Create greeting script with test', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          return {
            summary: 'Created greeting module and unit test',
            files: [
              { path: 'greeting.js', content: 'export function greet(name) { return `Hello, ${name}!`; }\n' },
              { path: 'test/greeting.test.mjs', content: 'import assert from "node:assert"; assert.ok(true);\n' }
            ]
          };
        }
        if (opts.schema === reviewSchema) {
          const match = opts.prompt.match(/Current code:\s*(\[.*?\])(?:\nActual validator results:|$)/s);
          if (match) reviewerSeenPaths = JSON.parse(match[1]).map(f => f.path);
          return { verdict: 'pass', summary: 'Files verified successfully', issues: [] };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      }
    });

    assert.equal(task.status, 'awaiting_approval');
    assert.ok(reviewerSeenPaths.includes('greeting.js'), 'greeting.js must be visible to reviewer');
    assert.ok(reviewerSeenPaths.includes('test/greeting.test.mjs'), 'test/greeting.test.mjs must be visible to reviewer');
  });

  await t.test('3. Baseline files cannot replace requested deliverable', async () => {
    const root = createFixture();
    // Simulate repository project with preexisting baseline files
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'router.mjs'), '// original router file\n');
    fs.writeFileSync(path.join(root, 'src', 'server.mjs'), '// original server file\n');

    let reviewerBaseline = null;
    let reviewerFiles = [];

    const task = await codeTask(root, 'Create standalone greeting.js and test', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          return {
            summary: 'Created greeting module',
            files: [
              { path: 'greeting.js', content: 'export function greet() { return "hi"; }\n' },
              { path: 'test/greeting.test.mjs', content: 'import assert from "node:assert"; assert.ok(true);\n' }
            ]
          };
        }
        if (opts.schema === reviewSchema) {
          const codeMatch = opts.prompt.match(/Current code:\s*(\[.*?\])(?:\nActual validator results:|$)/s);
          if (codeMatch) reviewerFiles = JSON.parse(codeMatch[1]);
          const baseMatch = opts.prompt.match(/Baseline:\s*(\[.*?\])(?:\nCurrent code:|$)/s);
          if (baseMatch) reviewerBaseline = JSON.parse(baseMatch[1]);
          return { verdict: 'pass', summary: 'Clean standalone deliverable', issues: [] };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      }
    });

    assert.equal(task.status, 'awaiting_approval');
    // Deliverable manifest must ONLY contain greeting.js and test, NOT baseline repo files
    const manifest = read(path.join(root, '.router', 'tasks', task.id, 'manifest-1.json'));
    const manifestPaths = manifest.files.map(f => f.path);
    assert.deepEqual(manifestPaths.sort(), ['greeting.js', 'test/greeting.test.mjs'].sort(), 'Manifest must contain only builder deliverables');
    assert.ok(!manifestPaths.includes('src/router.mjs'), 'Baseline file must NOT be in manifest');
    assert.ok(!manifestPaths.includes('src/server.mjs'), 'Baseline file must NOT be in manifest');

    // Reviewer files must match manifest exactly
    const reviewerPaths = reviewerFiles.map(f => f.path);
    assert.deepEqual(reviewerPaths.sort(), ['greeting.js', 'test/greeting.test.mjs'].sort(), 'Reviewer must receive only builder deliverables');
    // Baseline passed to reviewer for newly created files must be empty
    assert.deepEqual(reviewerBaseline, [], 'Newly created standalone files must have empty baseline');
  });

  await t.test('4. Revision 1 validator/reviewer use same draft', async () => {
    const root = createFixture();
    let r1DigestValidator = null;
    let r1ReviewerDigest = null;

    const task = await codeTask(root, 'Implement greeting feature', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          return {
            summary: 'Draft 1',
            files: [
              { path: 'greeting.js', content: 'export const msg = "rev1";\n' }
            ]
          };
        }
        if (opts.schema === reviewSchema) {
          const match = opts.prompt.match(/Current code:\s*(\[.*?\])(?:\nActual validator results:|$)/s);
          if (match) r1ReviewerDigest = hash(JSON.parse(match[1]));
          return { verdict: 'pass', summary: 'Approved rev1', issues: [] };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      }
    });

    assert.equal(task.status, 'awaiting_approval');
    r1DigestValidator = task.tests.digest;
    assert.equal(r1DigestValidator, task.digest);
    assert.equal(r1ReviewerDigest, task.digest);
    assert.equal(r1DigestValidator, r1ReviewerDigest, 'Revision 1 validator and reviewer must evaluate the exact same draft');
  });

  await t.test('5. Revision 2 validator/reviewer use same draft', async () => {
    const root = createFixture();
    let revision2ValidatorDigest = null;
    let revision2ReviewerDigest = null;
    let revisionCount = 0;

    const task = await codeTask(root, 'Implement greeting feature with error handling', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          revisionCount++;
          if (revisionCount === 1) {
            return {
              summary: 'Draft 1 without error handling',
              files: [
                { path: 'greeting.js', content: 'export function greet(name) { return `Hi ${name}`; }\n' }
              ]
            };
          }
          return {
            summary: 'Draft 2 with error handling',
            files: [
              { path: 'greeting.js', content: 'export function greet(name) { if (!name) throw new Error("Name required"); return `Hi ${name}`; }\n' }
            ]
          };
        }
        if (opts.schema === reviewSchema) {
          if (revisionCount === 1) {
            return { verdict: 'changes_requested', summary: 'Missing name validation', issues: ['Add error check when name is falsy'] };
          }
          const match = opts.prompt.match(/Current code:\s*(\[.*?\])(?:\nActual validator results:|$)/s);
          if (match) revision2ReviewerDigest = hash(JSON.parse(match[1]));
          return { verdict: 'pass', summary: 'Error check implemented properly', issues: [] };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      }
    });

    assert.equal(task.status, 'awaiting_approval');
    assert.equal(task.revision, 2, 'Task must reach revision 2');
    revision2ValidatorDigest = task.tests.digest;
    assert.equal(revision2ValidatorDigest, task.digest, 'Revision 2 validator matches task digest');
    assert.equal(revision2ReviewerDigest, task.digest, 'Revision 2 reviewer matches task digest');
    assert.equal(revision2ValidatorDigest, revision2ReviewerDigest, 'Revision 2 validator and reviewer evaluate exact same draft');
  });

  await t.test('6. Task Progress contains plain-language events', async () => {
    const root = createFixture();
    const task = await codeTask(root, 'Create greeting script', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          return {
            summary: 'Built greeting script',
            files: [{ path: 'greeting.js', content: 'export const hello = "world";\n' }]
          };
        }
        return { verdict: 'pass', summary: 'Good job', issues: [] };
      }
    });

    const progress = task.activityLog || [];
    const titles = progress.map(p => p.title);
    assert.ok(titles.includes('Work Started') || titles.includes('Builder Completed First Draft'), `Expected work started event in: ${titles.join(', ')}`);
    assert.ok(titles.includes('Automatic Checks Passed'), `Expected checks passed event in: ${titles.join(', ')}`);
    assert.ok(titles.includes('Reviewer Approved Deliverable'), `Expected review approved event in: ${titles.join(', ')}`);
  });

  await t.test('7. Technical details do not appear unnecessarily in Task Progress', async () => {
    const root = createFixture();
    const task = await codeTask(root, 'Create greeting script', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          return {
            summary: 'Built greeting script',
            files: [{ path: 'greeting.js', content: 'export const hello = "world";\n' }]
          };
        }
        return { verdict: 'pass', summary: 'Good job', issues: [] };
      }
    });

    const progress = task.activityLog || [];
    for (const item of progress) {
      assert.ok(item.desc.length < 500, `Task Progress description must be concise, got ${item.desc.length} chars: ${item.desc}`);
      assert.ok(!item.desc.includes('--- BEGIN RAW REVIEW ---'), 'No raw logs in Task Progress desc');
    }
  });

  await t.test('8. Technical Logs retain full technical information', async () => {
    const root = createFixture();
    let publishedWorkerEvents = [];

    const task = await codeTask(root, 'Create greeting script', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      onWorkerEvent: (ev) => publishedWorkerEvents.push(ev),
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          return {
            summary: 'Built greeting script',
            files: [{ path: 'greeting.js', content: 'export const hello = "world";\n' }]
          };
        }
        return { verdict: 'pass', summary: 'Good job', issues: [] };
      }
    });

    // Worker events retained full diagnostic information
    assert.ok(publishedWorkerEvents.length > 0, 'Worker events must be captured');
    const hasWorkerAndModel = publishedWorkerEvents.some(e => e.worker && e.model);
    assert.ok(hasWorkerAndModel, 'Technical logs must retain worker and model details');
  });

  await t.test('9. Raw reviewer report appears in Technical Logs', async () => {
    const root = createFixture();
    const task = await codeTask(root, 'Create greeting script', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          return {
            summary: 'Built greeting script',
            files: [{ path: 'greeting.js', content: 'export const hello = "world";\n' }]
          };
        }
        return { verdict: 'pass', summary: 'Audit verified specifications cleanly without regressions.', issues: [] };
      }
    });

    const reviewFile = path.join(root, '.router', 'tasks', task.id, 'review-1.json');
    assert.ok(fs.existsSync(reviewFile), 'review-1.json must exist in task directory');
    const reviewData = read(reviewFile);
    assert.equal(reviewData.verdict, 'pass');
    assert.ok(reviewData.summary.includes('Audit verified'), 'Reviewer summary preserved');
  });

  await t.test('10. Task Progress contains short reviewer summary with issue bullets', async () => {
    const root = createFixture();
    let revisionCount = 0;

    const task = await codeTask(root, 'Create greeting script', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          revisionCount++;
          return {
            summary: `Draft ${revisionCount}`,
            files: [{ path: 'greeting.js', content: `export const rev = ${revisionCount};\n` }]
          };
        }
        if (opts.schema === reviewSchema) {
          if (revisionCount === 1) {
            return {
              verdict: 'changes_requested',
              summary: 'Critical functions missing in draft 1',
              issues: ['Missing export greet function', 'Missing error handling for null input']
            };
          }
          return { verdict: 'pass', summary: 'Approved', issues: [] };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      }
    });

    const progress = task.activityLog || [];
    const changeReq = progress.find(p => p.title.includes('Reviewed — Changes Requested'));
    assert.ok(changeReq, 'Activity log must contain Changes Requested event');
    assert.ok(changeReq.desc.includes('requested changes'), 'Desc must state changes requested');
    assert.ok(Array.isArray(changeReq.bullets), 'Bullets must be an array');
    assert.equal(changeReq.bullets.length, 2, 'Must have 2 issue bullets');
    assert.equal(changeReq.reportAvailable, true, 'reportAvailable flag must be true');
  });

  await t.test('11. Misleading "Codex chosen" cannot appear for other workers', async () => {
    const root = createFixture();
    const antigravityDecision = selectModelAndEffort({ platform: 'antigravity', difficulty: 'medium', role: 'review', root });
    assert.ok(!antigravityDecision.platformReason?.includes('Codex chosen'), 'Antigravity reason must not say Codex chosen');

    const clineDecision = selectModelAndEffort({ platform: 'cline', difficulty: 'medium', role: 'build', root });
    assert.ok(!clineDecision.platformReason?.includes('Codex chosen'), 'Cline reason must not say Codex chosen');
  });

  await t.test('12. Resume message correctly distinguishes builder and reviewer', async () => {
    const root = createFixture();
    let task = await codeTask(root, 'Create greeting script', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          return {
            summary: 'Draft 1',
            files: [{ path: 'greeting.js', content: 'export const hello = 1;\n' }]
          };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      }
    });

    // Resume the task
    const resumedTask = await codeTask(root, 'Create greeting script', {
      resume: task.id,
      ready() {},
      log() {},
      call: async () => ({ verdict: 'pass', summary: 'OK', issues: [] })
    });

    const resumeEvent = (resumedTask.activityLog || []).find(e => e.title === 'Task Resumed');
    assert.ok(resumeEvent, 'Task Resumed event must be recorded');
    assert.ok(!resumeEvent.desc.includes('ANTIGRAVITY.') || resumeEvent.desc.includes('Reviewer'), 'Resume event must not misidentify Antigravity as the builder');
  });

  await t.test('13. Regression: Reviewer preselection tests pass', async () => {
    const config = structuredClone(workersConfig);
    config.workers.find(w => w.id === 'antigravity').enabled = false;
    const root = createFixture();
    json(path.join(root, 'workers.json'), config);

    let buildRan = false;
    const task = await codeTask(root, 'Task without reviewer', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          buildRan = true;
          return { summary: 'Should not run', files: [] };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      }
    });

    assert.equal(buildRan, false, 'Builder must not start when no qualified reviewer is available');
    assert.equal(task.status, 'waiting_for_reviewer');
  });

  await t.test('14. Regression: Failure reporting tests pass', async () => {
    const root = createFixture();
    const task = await codeTask(root, 'Fail task immediately', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async () => {
        throw new Error('Immediate failure');
      }
    });

    assert.ok(task.status === 'failed' || task.status === 'waiting_for_worker');
    assert.ok(task.failure, 'Task failure must be populated');
  });

  await t.test('15. Regression: Active workforce platforms only', async () => {
    const root = createFixture();
    const { platformModelTiers } = await import('../src/smart-router.mjs');
    assert.deepEqual(Object.keys(platformModelTiers).sort(), ['antigravity', 'claude', 'cline', 'codex']);
  });

  await t.test('16. Regression: Task controls and sensitivity override tests pass', async () => {
    const root = createFixture();
    const task = await codeTask(root, 'Update AWS access key AKIAIOSFODNN7EXAMPLE in config', {
      project: 'adaptive-router',
      ready() {},
      log() {},
      call: async () => ({ verdict: 'pass', summary: 'OK', issues: [] })
    });

    assert.equal(task.status, 'needs_cto_attention', 'Sensitive tasks must be held for CTO attention');
  });

});
