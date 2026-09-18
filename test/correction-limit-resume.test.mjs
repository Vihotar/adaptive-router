import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboardServer } from '../src/server.mjs';
import { codeTask } from '../src/coding.mjs';
import { read, json, saveFiles } from '../src/storage.mjs';
import { buildSchema } from '../src/contracts.mjs';
import { createTestFixture } from './helpers/fixture-helper.mjs';

import { getProject } from '../src/projects.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fixture() {
  const config = read(path.join(rootDir, 'workers.json'));
  const ag = config.workers.find(w => w.id === 'antigravity');
  if (ag) ag.enabled = true;
  const codex = config.workers.find(w => w.id === 'codex');
  if (codex) codex.enabled = true;
  return createTestFixture('corr-limit-', {
    seedFixtures: true,
    seedWeb: true,
    seedSpecialists: true,
    workersConfig: config
  });
}

function startTestServer(root) {
  return new Promise((resolve) => {
    const server = createDashboardServer(root);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

const dummyFiles = [
  { path: 'index.html', content: '<h1>Website</h1>' },
  { path: 'styles.css', content: 'body { color: blue; }' },
  { path: 'app.js', content: 'console.log("ready");' }
];

function seedCorrectionLimitTask(root, taskId, overrides = {}) {
  const registered = getProject(root, 'test-site', { includeHidden: true });
  const taskDir = path.join(root, '.router', 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  saveFiles(path.join(taskDir, 'baseline'), dummyFiles);
  json(path.join(taskDir, 'baseline.json'), dummyFiles);

  for (let r = 1; r <= 3; r++) {
    const rDir = path.join(taskDir, `deliverables-${r}`);
    saveFiles(rDir, dummyFiles);
    json(path.join(taskDir, `manifest-${r}.json`), {
      taskId,
      project: 'test-site',
      projectRoot: registered.rootPath,
      contextHash: 'hash-abc',
      files: dummyFiles,
      digest: 'dummy-digest'
    });
  }

  const taskData = {
    id: taskId,
    project: 'test-site',
    projectName: registered.name,
    projectRoot: registered.rootPath,
    kind: 'web',
    schemaVersion: 2,
    contextHash: 'hash-abc',
    instruction: 'Create interactive portfolio header',
    status: 'needs_human_input',
    note: 'Correction limit reached',
    revision: 3,
    selectedBuilder: 'cline',
    builderWorker: 'antigravity',
    reviewerWorker: 'codex',
    created: new Date().toISOString(),
    decisionRequired: {
      type: 'correction_limit',
      title: 'Decision Required',
      question: 'Correction limit reached. Review drafts and decide next step.',
      reason: 'Correction limit reached.\nBuilder attempted 3 revisions.',
      recommendation: 'Review deliverable or provide manual guidance',
      options: [
        { id: 'review_drafts', label: 'Review Latest Deliverable', recommended: true },
        { id: 'reject', label: 'Reject', recommended: false }
      ]
    },
    contributors: ['cline', 'antigravity'],
    routingLog: [
      { role: 'build', worker: 'cline' },
      { role: 'build', worker: 'antigravity' },
      { role: 'review', worker: 'codex' }
    ],
    activityLog: [],
    ...overrides
  };
  json(path.join(taskDir, 'task.json'), taskData);
  return taskData;
}

test('Correction Limit: POST /api/tasks/:id/resume with decision: review_drafts is rejected with HTTP 400', async (t) => {
  const root = fixture(t);
  const taskId = '20260918T173638-71067c54';
  seedCorrectionLimitTask(root, taskId);

  const testServer = await startTestServer(root);
  try {
    const res = await fetch(`${testServer.url}/api/tasks/${taskId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'review_drafts' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /"review_drafts" is an inspection action, not an execution resume decision/);

    const taskOnDisk = read(path.join(root, '.router', 'tasks', taskId, 'task.json'));
    assert.equal(taskOnDisk.status, 'needs_human_input');
    assert.equal(taskOnDisk.revision, 3);
  } finally {
    await testServer.close();
  }
});

test('Correction Limit: POST /api/tasks/:id/resume with invalid decision returns HTTP 400', async (t) => {
  const root = fixture(t);
  const taskId = '20260918T173638-71067c54';
  seedCorrectionLimitTask(root, taskId);

  const testServer = await startTestServer(root);
  try {
    const res = await fetch(`${testServer.url}/api/tasks/${taskId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'non_existent_decision' })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /Unsupported resume decision/);
  } finally {
    await testServer.close();
  }
});

test('Correction Limit: GET /api/tasks/:id dynamically normalizes legacy decisionRequired.options', async (t) => {
  const root = fixture(t);
  const taskId = '20260918T173638-71067c54';
  seedCorrectionLimitTask(root, taskId);

  const testServer = await startTestServer(root);
  try {
    const res = await fetch(`${testServer.url}/api/tasks/${taskId}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    const options = data.decisionRequired?.options;
    assert.ok(Array.isArray(options), 'options should be an array');
    const optionIds = options.map(o => o.id);
    assert.ok(optionIds.includes('retry_same_worker'), 'should include retry_same_worker');
    assert.ok(optionIds.includes('retry_other_worker'), 'should include retry_other_worker');
    assert.ok(optionIds.includes('reject'), 'should include reject');
    assert.ok(!optionIds.includes('review_drafts'), 'review_drafts should be replaced by executable options');
  } finally {
    await testServer.close();
  }
});

test('Correction Limit: codeTask in-place resume with human guidance advances to revision 4 and passes feedback to builder', async (t) => {
  const root = fixture(t);
  const taskId = '20260918T173638-71067c54';
  seedCorrectionLimitTask(root, taskId);

  const userGuidance = 'Ensure the contact form has an explicit submit handler and CSRF header.';
  let builderReceivedPrompt = '';
  let builderCallCount = 0;
  let reviewerCallCount = 0;

  const revisedFiles = [
    { path: 'index.html', content: '<h1>Website</h1><form id="contact-form"><button type="submit">Submit</button></form>' },
    { path: 'styles.css', content: 'body { color: blue; }' },
    { path: 'app.js', content: 'console.log("with-csrf");' }
  ];

  const resumed = await codeTask(root, null, {
    resume: taskId,
    preferredWorker: 'antigravity',
    feedback: { userComment: userGuidance },
    ready() {},
    log() {},
    call: async (w, r) => {
      if (r.schema === buildSchema) {
        builderCallCount++;
        builderReceivedPrompt = r.prompt;
        return { summary: 'Added CSRF contact form', files: revisedFiles };
      }
      reviewerCallCount++;
      return { verdict: 'pass', summary: 'Approved deliverable', issues: [] };
    },
    test: async (_root, _project, report, digest) => {
      const rep = { passed: true, digest, checks: [{ name: 'csrf-check', passed: true }] };
      json(report, rep);
      return rep;
    }
  });

  assert.equal(resumed.id, taskId, 'Task ID must be preserved in place');
  assert.equal(resumed.revision, 4, 'Task revision must advance to 4');
  assert.equal(resumed.status, 'awaiting_approval', 'Task must reach awaiting_approval after passing tests and review');
  assert.equal(builderCallCount, 1, 'Builder must be called exactly once for revision 4');
  assert.equal(reviewerCallCount, 1, 'Reviewer must review revision 4');
  assert.ok(builderReceivedPrompt.includes(userGuidance), 'Builder prompt must contain injected human guidance');
  assert.ok(fs.existsSync(path.join(root, '.router', 'tasks', taskId, 'deliverables-4')), 'Revision 4 deliverables directory must exist');
  assert.ok(fs.existsSync(path.join(root, '.router', 'tasks', taskId, 'deliverables-1')), 'Revision 1 must remain preserved');
});

test('Correction Limit: Bounded extension grants exactly ONE additional revision attempt and stops if review fails', async (t) => {
  const root = fixture(t);
  const taskId = '20260918T173638-71067c54';
  seedCorrectionLimitTask(root, taskId);

  let builderCallCount = 0;
  let reviewerCallCount = 0;

  const resumed = await codeTask(root, null, {
    resume: taskId,
    preferredWorker: 'antigravity',
    feedback: { userComment: 'Fix missing field' },
    ready() {},
    log() {},
    call: async (w, r) => {
      if (r.schema === buildSchema) {
        builderCallCount++;
        return { summary: 'Revision 4 attempt', files: dummyFiles };
      }
      reviewerCallCount++;
      return { verdict: 'changes_requested', summary: 'Still fails requirements', issues: ['Button is still missing'] };
    },
    test: async (_root, _project, report, digest) => {
      const rep = { passed: true, digest, checks: [{ name: 'test', passed: true }] };
      json(report, rep);
      return rep;
    }
  });

  assert.equal(resumed.id, taskId, 'Task ID must remain unchanged');
  assert.equal(resumed.revision, 4, 'Task revision should have attempted 4');
  assert.equal(resumed.status, 'needs_human_input', 'Must re-enter needs_human_input after the 1 granted attempt');
  assert.equal(resumed.note, 'Correction limit reached');
  assert.equal(builderCallCount, 1, 'Must execute exactly ONE attempt, not loop infinitely');
  assert.equal(reviewerCallCount, 1, 'Reviewer must execute for the single attempt');
});

test('Correction Limit: POST /api/tasks/:id/resume accepts retry_same_worker with guidance and preferredWorker', async (t) => {
  const root = fixture(t);
  const taskId = '20260918T173638-71067c54';
  seedCorrectionLimitTask(root, taskId);

  const testServer = await startTestServer(root);
  try {
    const res = await fetch(`${testServer.url}/api/tasks/${taskId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'retry_same_worker',
        guidance: 'Make sure the button is blue and accessible.'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status, 'resumed');
    assert.equal(data.guidance, 'Make sure the button is blue and accessible.');
    assert.equal(data.preferredWorker, 'antigravity');
  } finally {
    await testServer.close();
  }
});

test('Correction Limit: POST /api/tasks/:id/resume accepts correct as an alias for human revision', async (t) => {
  const root = fixture(t);
  const taskId = '20260918T173638-71067c54';
  seedCorrectionLimitTask(root, taskId);

  const testServer = await startTestServer(root);
  try {
    const res = await fetch(`${testServer.url}/api/tasks/${taskId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'correct',
        guidance: 'Revise navigation header.'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status, 'resumed');
    assert.equal(data.guidance, 'Revise navigation header.');
  } finally {
    await testServer.close();
  }
});

test('Correction Limit: POST /api/tasks/:id/decide accepts correct for tasks at needs_human_input', async (t) => {
  const root = fixture(t);
  const taskId = '20260918T173638-71067c54';
  seedCorrectionLimitTask(root, taskId);

  const testServer = await startTestServer(root);
  try {
    const res = await fetch(`${testServer.url}/api/tasks/${taskId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'correct',
        reason: 'Revise layout for mobile screens.'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status, 'resumed_correction');
  } finally {
    await testServer.close();
  }
});

test('Correction Limit: POST /api/tasks/:id/resume with reject stops task and releases lock', async (t) => {
  const root = fixture(t);
  const taskId = '20260918T173638-71067c54';
  seedCorrectionLimitTask(root, taskId);

  const testServer = await startTestServer(root);
  try {
    const res = await fetch(`${testServer.url}/api/tasks/${taskId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision: 'reject',
        reason: 'Human user declined further attempts at correction limit.'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status, 'rejected');

    const taskOnDisk = read(path.join(root, '.router', 'tasks', taskId, 'task.json'));
    assert.equal(taskOnDisk.status, 'rejected');
    assert.ok(taskOnDisk.completionTime, 'completionTime must be stamped');
    assert.equal(taskOnDisk.rejectionReason, 'Human user declined further attempts at correction limit.');

    const approvalOnDisk = read(path.join(root, '.router', 'tasks', taskId, 'approval.json'));
    assert.equal(approvalOnDisk.decision, 'rejected');
  } finally {
    await testServer.close();
  }
});

test('Correction Limit: Resume activity log attributes active builder (Antigravity), not initial builder (Cline)', async (t) => {
  const root = fixture(t);
  const taskId = '20260918T173638-71067c54';
  seedCorrectionLimitTask(root, taskId, {
    selectedBuilder: 'cline',
    builderWorker: 'antigravity',
    reviewerWorker: 'codex'
  });

  const resumed = await codeTask(root, null, {
    resume: taskId,
    preferredWorker: 'antigravity',
    feedback: { userComment: 'Fix header styling' },
    ready() {},
    log() {},
    call: async (w, r) => {
      if (r.schema === buildSchema) return { summary: 'Updated styling', files: dummyFiles };
      return { verdict: 'pass', summary: 'Approved', issues: [] };
    },
    test: async (_root, _project, report, digest) => {
      const rep = { passed: true, digest, checks: [{ name: 'test', passed: true }] };
      json(report, rep);
      return rep;
    }
  });

  const resumeLog = (resumed.activityLog || []).find(a => a.title === 'Task Resumed');
  assert.ok(resumeLog, 'Task Resumed activity log entry must exist');
  assert.match(resumeLog.desc, /Antigravity/, 'Must mention Antigravity');
  assert.doesNotMatch(resumeLog.desc, /Builder: Cline/, 'Must not attribute builder to Cline');
});
