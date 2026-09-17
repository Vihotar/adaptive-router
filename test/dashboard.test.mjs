import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createDashboardServer } from '../src/server.mjs';
import { read, json, hash, saveFiles } from '../src/storage.mjs';
import { createTestFixture } from './helpers/fixture-helper.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fixture(t) {
  return createTestFixture('dash-', {
    seedFixtures: true,
    seedWeb: true,
    seedSpecialists: true,
    workersConfig: read(path.join(rootDir, 'workers.json')),
    t
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

test('Dashboard: serves static UI files index.html, prototype.css, app.js with HTTP 200', async () => {
  // Note: the production dashboard's live stylesheet is src/web/prototype.css
  // (index.html links it directly) -- src/web/styles.css was a dead,
  // unreferenced leftover from an earlier prototype iteration and has been
  // removed as part of the production UI cleanup. This is unrelated to the
  // per-task-deliverable 'styles.css' filename used elsewhere (coding.mjs's
  // fixed 3-file browser-project contract, fixtures/test-site) -- that is a
  // different, still-live concept: the generic filename AR's own generated
  // web deliverables are built with, not the dashboard's own asset.
  const root = fixture();
  const testServer = await startTestServer(root);

  try {
    const htmlRes = await fetch(`${testServer.url}/`);
    assert.equal(htmlRes.status, 200);
    assert.ok(htmlRes.headers.get('content-type').includes('text/html'));
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('Adaptive Router'));
    assert.ok(htmlText.includes('Claude Reserve'));

    const cssRes = await fetch(`${testServer.url}/prototype.css`);
    assert.equal(cssRes.status, 200);
    assert.ok(cssRes.headers.get('content-type').includes('text/css'));

    const jsRes = await fetch(`${testServer.url}/app.js`);
    assert.equal(jsRes.status, 200);
    assert.ok(jsRes.headers.get('content-type').includes('application/javascript'));
  } finally {
    await testServer.close();
  }
});

test('Dashboard: GET /api/status returns worker workforce, Claude Reserve state, and project info', async () => {
  const root = fixture();
  const testServer = await startTestServer(root);

  try {
    const res = await fetch(`${testServer.url}/api/status`);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(Array.isArray(data.workers));
    assert.equal(data.workers.length, 4);
    assert.ok(data.workers.some(w => w.id === 'codex'));
    assert.ok(data.workers.some(w => w.id === 'claude-code'));
    assert.ok(data.workers.some(w => w.id === 'antigravity'));
    assert.ok(data.workers.some(w => w.id === 'cline'));

    assert.equal(typeof data.claudeReserve, 'boolean');
    assert.equal(data.routingMode, 'Auto');
    assert.ok(Array.isArray(data.projects));
    assert.equal(data.projects[0].name, 'Adaptive Router System');
    assert.ok(!data.projects.some(project => project.id === 'test-site'));
  } finally {
    await testServer.close();
  }
});

test('Dashboard: POST /api/claude-reserve toggles Claude Reserve Mode and persists to workers.json', async () => {
  const root = fixture();
  const testServer = await startTestServer(root);

  try {
    // 1. Turn OFF
    const offRes = await fetch(`${testServer.url}/api/claude-reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(offRes.status, 200);
    const offData = await offRes.json();
    assert.equal(offData.claudeReserve, false);

    const saved1 = read(path.join(root, 'workers.json'));
    assert.equal(saved1.claudeReserve, false);

    // 2. Turn ON
    const onRes = await fetch(`${testServer.url}/api/claude-reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(onRes.status, 200);
    const onData = await onRes.json();
    assert.equal(onData.claudeReserve, true);

    const saved2 = read(path.join(root, 'workers.json'));
    assert.equal(saved2.claudeReserve, true);
  } finally {
    await testServer.close();
  }
});

test('Dashboard: GET /api/tasks and GET /api/tasks/:id return structured task history and details', async () => {
  const root = fixture();
  const taskId = '20260910T150000-abcd1234';
  const taskDir = path.join(root, '.router', 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });

  const dummyFiles = [
    { path: 'index.html', content: '<h1>Test Website</h1>' },
    { path: 'styles.css', content: 'body { color: blue; }' },
    { path: 'app.js', content: 'console.log("ready");' }
  ];
  saveFiles(path.join(taskDir, 'deliverables-1'), dummyFiles);
  json(path.join(taskDir, 'manifest-1.json'), { files: dummyFiles, digest: hash(dummyFiles) });

  const taskData = {
    id: taskId,
    project: 'adaptive-router',
    projectName: 'Adaptive Router System',
    kind: 'web',
    instruction: 'Add a contact form to the test website',
    status: 'awaiting_approval',
    revision: 1,
    digest: hash(dummyFiles),
    created: new Date().toISOString(),
    routingLog: [
      { role: 'build', worker: 'codex', model: 'gpt-5.6-sol', effort: 'medium', specialist: 'engineering-frontend-developer', reason: 'Frontend component task' },
      { role: 'review', worker: 'antigravity', model: 'gemini-3.1-pro-high', effort: 'high', reason: 'Independent reviewer' }
    ]
  };
  json(path.join(taskDir, 'task.json'), taskData);
  json(path.join(taskDir, 'baseline.json'), dummyFiles);
  json(path.join(taskDir, 'tests-1.json'), { passed: true, digest: hash(dummyFiles), checks: [{ name: 'form-exists', passed: true }] });
  json(path.join(taskDir, 'review-1.json'), { verdict: 'pass', summary: 'Approved', issues: [], worker: 'antigravity', digest: hash(dummyFiles) });
  fs.writeFileSync(path.join(taskDir, 'APPROVAL.md'), '# Ready for approval\n- deliverables-1/index.html\nDigest: ' + hash(dummyFiles));

  const testServer = await startTestServer(root);

  try {
    // List tasks
    const listRes = await fetch(`${testServer.url}/api/tasks`);
    assert.equal(listRes.status, 200);
    const tasks = await listRes.json();
    assert.ok(tasks.length >= 1);
    assert.equal(tasks[0].id, taskId);
    assert.equal(tasks[0].builder, 'codex');
    assert.equal(tasks[0].specialist, 'engineering-frontend-developer');

    // Get specific task detail
    const detailRes = await fetch(`${testServer.url}/api/tasks/${taskId}`);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.id, taskId);
    assert.equal(detail.routingLog.length, 2);
    assert.equal(detail.tests.passed, true);
    assert.equal(detail.review.verdict, 'pass');
  } finally {
    await testServer.close();
  }
});

test('Dashboard: POST /api/tasks/:id/decide approves or rejects task and writes approval.json', async () => {
  const root = fixture();
  const taskId = '20260910T150000-abcd1234';
  const taskDir = path.join(root, '.router', 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });

  const baselineFiles = [
    { path: 'index.html', content: '<h1>Starting Site</h1>' },
    { path: 'styles.css', content: 'body { color: black; }' },
    { path: 'app.js', content: '// baseline' }
  ];
  const dummyFiles = [
    { path: 'index.html', content: '<h1>Test Website Form</h1>' },
    { path: 'styles.css', content: 'body { color: blue; }' },
    { path: 'app.js', content: 'console.log("ready");' }
  ];
  saveFiles(path.join(taskDir, 'deliverables-1'), dummyFiles);
  json(path.join(taskDir, 'baseline.json'), baselineFiles);
  const contextHash = 'context-bound-dashboard-test';
  const binding = { taskId, project: 'adaptive-router', projectRoot: root, contextHash };
  json(path.join(taskDir, 'manifest-1.json'), { ...binding, files: dummyFiles, digest: hash(dummyFiles) });

  const taskData = {
    schemaVersion: 2,
    id: taskId,
    project: 'adaptive-router',
    projectName: 'Adaptive Router System',
    projectRoot: root,
    contextHash,
    kind: 'system',
    instruction: 'Add a contact form to the test website',
    status: 'awaiting_approval',
    revision: 1,
    contributors: ['codex'],
    builderEffort: 'medium',
    reviewerEffort: 'medium',
    reviewerQualification: { builderTier: 3, reviewerTier: 3, independentFamily: true },
    digest: hash(dummyFiles),
    created: new Date().toISOString()
  };
  json(path.join(taskDir, 'task.json'), taskData);
  json(path.join(taskDir, 'tests-1.json'), { ...binding, passed: true, digest: hash(dummyFiles), checks: [{ name: 'static-validation', passed: true }] });
  json(path.join(taskDir, 'review-1.json'), { ...binding, verdict: 'pass', summary: 'Approved', issues: [], worker: 'antigravity', digest: hash(dummyFiles) });
  fs.writeFileSync(path.join(taskDir, 'APPROVAL.md'), `# Ready for approval\nTask ${taskId}\nProject adaptive-router\nContext ${contextHash}\nDigest ${hash(dummyFiles)}\n`);

  const testServer = await startTestServer(root);

  try {
    const approveRes = await fetch(`${testServer.url}/api/tasks/${taskId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', reason: 'Approved from Business Dashboard' })
    });
    assert.equal(approveRes.status, 200);
    const approveData = await approveRes.json();
    assert.equal(approveData.success, true);
    assert.equal(approveData.task.status, 'approved');

    // Verify approval.json exists
    assert.ok(fs.existsSync(path.join(taskDir, 'approval.json')));
    const approval = read(path.join(taskDir, 'approval.json'));
    assert.equal(approval.decision, 'approved');
    assert.equal(approval.reason, 'Approved from Business Dashboard');
  } finally {
    await testServer.close();
  }
});

test('Dashboard: GET /api/tasks/:id/deliverable/* serves deliverables and denies path traversal', async () => {
  const root = fixture();
  const taskId = '20260910T150000-abcd1234';
  const taskDir = path.join(root, '.router', 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });

  const dummyFiles = [
    { path: 'index.html', content: '<h1>Preview Page</h1>' },
    { path: 'styles.css', content: 'body { background: white; }' },
    { path: 'app.js', content: 'alert(1);' }
  ];
  saveFiles(path.join(taskDir, 'deliverables-1'), dummyFiles);
  json(path.join(taskDir, 'manifest-1.json'), { files: dummyFiles, digest: hash(dummyFiles) });
  json(path.join(taskDir, 'task.json'), { id: taskId, revision: 1, status: 'awaiting_approval' });

  const testServer = await startTestServer(root);

  try {
    // 1. Valid file request
    const fileRes = await fetch(`${testServer.url}/api/tasks/${taskId}/deliverable/index.html`);
    assert.equal(fileRes.status, 200);
    const fileText = await fileRes.text();
    assert.equal(fileText, '<h1>Preview Page</h1>');

    // 2. Directory traversal attempt
    const traversalRes = await fetch(`${testServer.url}/api/tasks/${taskId}/deliverable/../../task.json`);
    assert.ok(traversalRes.status === 403 || traversalRes.status === 404);
  } finally {
    await testServer.close();
  }
});

test('Dashboard: needs_human_input populates decisionRequired and categorized activityLog', async () => {
  const root = fixture();
  const taskId = '20260910T160000-ea123456';
  const taskDir = path.join(root, '.router', 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });

  const taskData = {
    id: taskId,
    kind: 'web',
    instruction: '# Task: Add Unified Planning Chat\n\nLong multiline prompt...',
    status: 'needs_human_input',
    revision: 0,
    created: new Date().toISOString(),
    activityLog: [
      { time: new Date().toISOString(), icon: '📋', title: 'Instruction Received', desc: '# Task: Add Unified Planning Chat\n\nLong multiline prompt...' }
    ]
  };
  json(path.join(taskDir, 'task.json'), taskData);

  const testServer = await startTestServer(root);
  try {
    const res = await fetch(`${testServer.url}/api/tasks/${taskId}`);
    assert.equal(res.status, 200);
    const detail = await res.json();

    assert.ok(detail.decisionRequired, 'decisionRequired should be populated');
    assert.equal(detail.decisionRequired.question, 'Claude Code would be useful for this task. Use Claude quota?');
    assert.ok(detail.decisionRequired.options.some(o => o.id === 'preserve_claude'));
    assert.ok(detail.decisionRequired.options.some(o => o.id === 'use_claude'));

    assert.equal(detail.activityLog[0].category, 'instruction');
    assert.ok(!detail.activityLog[0].desc.includes('\n'), 'desc should be concise without newlines');
    assert.equal(detail.activityLog[0].details, '# Task: Add Unified Planning Chat\n\nLong multiline prompt...');
  } finally {
    await testServer.close();
  }
});

test('Dashboard: POST /api/tasks/:id/resume accepts decision and resumes task', async () => {
  const root = fixture();
  const taskId = '20260910T160500-b0123456';
  const taskDir = path.join(root, '.router', 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });

  const dummyFiles = [
    { path: 'index.html', content: '<h1>Test Website</h1>' },
    { path: 'styles.css', content: 'body { color: blue; }' },
    { path: 'app.js', content: 'console.log("ready");' }
  ];
  saveFiles(path.join(taskDir, 'baseline'), dummyFiles);
  json(path.join(taskDir, 'baseline.json'), dummyFiles);

  const taskData = {
    id: taskId,
    project: 'adaptive-router',
    projectName: 'Adaptive Router System',
    projectRoot: root,
    kind: 'system',
    instruction: 'Add a contact form to the test website',
    status: 'needs_human_input',
    revision: 0,
    created: new Date().toISOString(),
    contributors: [],
    routingLog: [],
    activityLog: []
  };
  json(path.join(taskDir, 'task.json'), taskData);

  const testServer = await startTestServer(root);
  try {
    const res = await fetch(`${testServer.url}/api/tasks/${taskId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'preserve_claude', preferredWorker: 'antigravity' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.status, 'resumed');
    assert.equal(data.preferredWorker, 'antigravity');
    assert.equal(data.allowClaude, false);
  } finally {
    await testServer.close();
  }
});

test('Dashboard: Stage B Approval Context binds strictly to current task with zero cross-task contamination', async () => {
  const root = fixture();
  const testServer = await startTestServer(root);

  try {
    // Task A: Shopping Cart feature on test-site
    const taskAId = '20260911T120000-aaaaaaaa';
    const taskADir = path.join(root, '.router', 'tasks', taskAId);
    fs.mkdirSync(taskADir, { recursive: true });

    const filesA = [
      { path: 'index.html', content: '<h1>Cart Page A</h1>' },
      { path: 'styles.css', content: 'body { color: green; }' },
      { path: 'app.js', content: 'console.log("cart A");' }
    ];
    const digestA = hash(filesA);
    json(path.join(taskADir, 'manifest-1.json'), { files: filesA, digest: digestA });
    json(path.join(taskADir, 'tests-1.json'), { passed: true, digest: digestA, checksCount: 5, checks: [{ name: 'Cart Item Count' }, { name: 'Cart Total Price' }] });
    json(path.join(taskADir, 'review-1.json'), { verdict: 'pass', worker: 'antigravity', summary: 'Cart feature passes all requirements with clean state handling.' });

    const taskAData = {
      id: taskAId,
      project: 'test-site',
      projectName: 'Adaptive Router Test Project (Sample Shop)',
      kind: 'web',
      instruction: 'Add shopping cart item count badge to header',
      summary: 'Shopping cart item counter added with responsive badge',
      status: 'awaiting_approval',
      revision: 1,
      digest: digestA,
      builder: 'codex',
      reviewer: 'antigravity',
      routingLog: [
        { role: 'build', worker: 'codex', model: 'o3-mini', effort: 'high' },
        { role: 'review', worker: 'antigravity', model: 'gemini-2.5-pro', effort: 'high' }
      ],
      created: '2026-09-11T12:00:00.000Z'
    };
    json(path.join(taskADir, 'task.json'), taskAData);

    // Task B: Contact Form feature on test-site
    const taskBId = '20260911T130000-bbbbbbbb';
    const taskBDir = path.join(root, '.router', 'tasks', taskBId);
    fs.mkdirSync(taskBDir, { recursive: true });

    const filesB = [
      { path: 'index.html', content: '<h1>Contact Page B</h1>' },
      { path: 'styles.css', content: 'body { color: purple; }' },
      { path: 'app.js', content: 'console.log("contact form B");' }
    ];
    const digestB = hash(filesB);
    json(path.join(taskBDir, 'manifest-1.json'), { files: filesB, digest: digestB });
    json(path.join(taskBDir, 'tests-1.json'), { passed: true, digest: digestB, checksCount: 7, checks: [{ name: 'Name Input Required' }, { name: 'Email Validation' }, { name: 'Message Field' }] });
    json(path.join(taskBDir, 'review-1.json'), { verdict: 'pass', worker: 'cline', summary: 'Contact form inputs validated and accessible according to spec.' });

    const taskBData = {
      id: taskBId,
      project: 'test-site',
      projectName: 'Adaptive Router Test Project (Sample Shop)',
      kind: 'web',
      instruction: 'Add an accessible contact form with name, email and message',
      summary: 'Accessible contact form built and verified with 7 automated checks',
      status: 'awaiting_approval',
      revision: 1,
      digest: digestB,
      builder: 'claude-code',
      reviewer: 'cline',
      routingLog: [
        { role: 'build', worker: 'claude-code', model: 'claude-3-7-sonnet', effort: 'medium' },
        { role: 'review', worker: 'cline', model: 'gemini-3.8-flash', effort: 'high' }
      ],
      created: '2026-09-11T13:00:00.000Z'
    };
    json(path.join(taskBDir, 'task.json'), taskBData);

    // 1. Fetch Task A
    const resA = await fetch(`${testServer.url}/api/tasks/${taskAId}`);
    assert.equal(resA.status, 200);
    const detailA = await resA.json();
    assert.equal(detailA.id, taskAId);
    assert.equal(detailA.instruction, 'Add shopping cart item count badge to header');
    assert.equal(detailA.tests.checksCount, 5);
    assert.equal(detailA.review.worker, 'antigravity');

    // 2. Fetch Task B (sequential)
    const resB = await fetch(`${testServer.url}/api/tasks/${taskBId}`);
    assert.equal(resB.status, 200);
    const detailB = await resB.json();

    // Verify Task B contains ONLY Task B data
    assert.equal(detailB.id, taskBId);
    assert.equal(detailB.instruction, 'Add an accessible contact form with name, email and message');
    assert.equal(detailB.summary, 'Accessible contact form built and verified with 7 automated checks');
    assert.equal(detailB.tests.checksCount, 7);
    assert.equal(detailB.review.worker, 'cline');
    assert.equal(detailB.digest, digestB);

    // Verify zero Task A contamination in Task B
    assert.ok(!detailB.instruction.includes('shopping cart'));
    assert.ok(!detailB.summary.includes('shopping cart'));
    assert.notEqual(detailB.tests.checksCount, 5);
    assert.notEqual(detailB.digest, digestA);

    // 3. Re-fetch (refresh) and verify consistency
    const resB2 = await fetch(`${testServer.url}/api/tasks/${taskBId}`);
    assert.equal(resB2.status, 200);
    const detailB2 = await resB2.json();
    assert.deepEqual(detailB, detailB2);
  } finally {
    await testServer.close();
  }
});

test('Dashboard: CONTEXT_MISMATCH decision UI prohibits revision, presents Reject & Rerun Cleanly, and blocks correction attempts', async () => {
  const root = fixture();
  const testServer = await startTestServer(root);

  try {
    const taskId = '20260911T160000-1111aaaa';
    const taskDir = path.join(root, '.router', 'tasks', taskId);
    fs.mkdirSync(taskDir, { recursive: true });

    // Contaminated task (e.g. Adaptive Router system task with mixed Sample Shop context)
    const taskData = {
      id: taskId,
      project: 'adaptive-router',
      projectName: 'Adaptive Router System',
      kind: 'system',
      instruction: 'Fix Stage B Approval Context and deliverable binding bug',
      summary: 'Add an accessible contact form with name, email and message', // contaminated summary
      status: 'needs_human_input',
      reasonCode: 'CONTEXT_MISMATCH',
      revision: 1,
      digest: 'contaminated-digest-12345',
      created: '2026-09-11T16:00:00.000Z'
    };
    json(path.join(taskDir, 'task.json'), taskData);

    // 1. Fetch task details and verify decisionRequired options
    const res = await fetch(`${testServer.url}/api/tasks/${taskId}`);
    assert.equal(res.status, 200);
    const detail = await res.json();

    assert.equal(detail.reasonCode, 'CONTEXT_MISMATCH');
    assert.ok(detail.decisionRequired);
    assert.equal(detail.decisionRequired.type, 'context_mismatch');
    assert.ok(detail.decisionRequired.question.includes('prohibited') || detail.decisionRequired.reason.includes('prohibited'));

    // Verify safe options only (NO "Send for Revision")
    const optionIds = detail.decisionRequired.options.map(o => o.id);
    assert.deepEqual(optionIds, ['reject_rerun', 'cancel']);
    assert.ok(!optionIds.includes('correct'));
    assert.ok(!optionIds.includes('send_for_revision'));

    const recommendedOption = detail.decisionRequired.options.find(o => o.recommended);
    assert.equal(recommendedOption.id, 'reject_rerun');
    assert.equal(recommendedOption.label, 'Reject Draft & Rerun Cleanly');

    // 2. Verify safety rule: attempting to request correction on CONTEXT_MISMATCH is rejected with 400
    const decideRes = await fetch(`${testServer.url}/api/tasks/${taskId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'correct', reason: 'Please fix the mismatch' })
    });
    assert.equal(decideRes.status, 400);
    const decideErr = await decideRes.json();
    assert.ok(decideErr.error.includes('Automatic revision is prohibited'));

    // 3. Verify safety rule: attempting to resume with correction is also rejected with 400
    const resumeRes = await fetch(`${testServer.url}/api/tasks/${taskId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'correct' })
    });
    assert.equal(resumeRes.status, 400);
    const resumeErr = await resumeRes.json();
    assert.ok(resumeErr.error.includes('Automatic revision is prohibited'));
  } finally {
    await testServer.close();
  }
});

test('Dashboard: POST /api/tasks/:id/rerun-clean rejects contaminated draft and initiates fresh isolated execution without stale artifacts', async () => {
  const root = fixture();
  const testServer = await startTestServer(root);

  try {
    const taskAId = '20260910T140000-2222bbbb';
    const taskBId = '20260910T143000-3333cccc';
    const taskADir = path.join(root, '.router', 'tasks', taskAId);
    const taskBDir = path.join(root, '.router', 'tasks', taskBId);
    fs.mkdirSync(taskADir, { recursive: true });
    fs.mkdirSync(taskBDir, { recursive: true });

    // Task A: Sample Shop Contact Form
    json(path.join(taskADir, 'task.json'), {
      id: taskAId,
      project: 'test-site',
      projectName: 'Adaptive Router Test Project (Sample Shop)',
      kind: 'web',
      instruction: 'Add a customer contact form to the test website',
      summary: 'Contact form added to Sample Shop',
      status: 'awaiting_approval',
      revision: 1,
      digest: 'digest-sample-shop-a',
      created: '2026-09-10T14:00:00.000Z'
    });
    json(path.join(taskADir, 'tests-1.json'), { passed: true, checks: [{ name: 'Contact Form Exists' }] });
    json(path.join(taskADir, 'review-1.json'), { verdict: 'pass', summary: 'Sample Shop form approved' });

    // Task B (contaminated with Task A artifacts / detected as CONTEXT_MISMATCH)
    json(path.join(taskBDir, 'task.json'), {
      id: taskBId,
      project: 'adaptive-router',
      projectName: 'Adaptive Router System',
      kind: 'system',
      instruction: 'Fix Stage B Approval Context and deliverable binding bug',
      summary: 'Contaminated summary with contact form details',
      status: 'needs_human_input',
      reasonCode: 'CONTEXT_MISMATCH',
      revision: 1,
      digest: 'digest-contaminated-b',
      created: '2026-09-10T14:30:00.000Z'
    });

    // Execute Reject Draft & Rerun Cleanly
    const rerunRes = await fetch(`${testServer.url}/api/tasks/${taskBId}/rerun-clean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'reject_rerun' })
    });
    assert.equal(rerunRes.status, 200);
    const rerunData = await rerunRes.json();
    assert.equal(rerunData.success, true);
    assert.equal(rerunData.oldTaskId, taskBId);

    // 1. Verify old contaminated task is marked rejected and preserved for audit
    const updatedTaskB = read(path.join(taskBDir, 'task.json'));
    assert.equal(updatedTaskB.status, 'rejected');
    assert.equal(updatedTaskB.reasonCode, 'CONTEXT_MISMATCH');
    assert.ok(updatedTaskB.rejectionReason.includes('CONTEXT_MISMATCH'));
    assert.ok(fs.existsSync(path.join(taskBDir, 'approval.json')));
    const approvalB = read(path.join(taskBDir, 'approval.json'));
    assert.equal(approvalB.decision, 'rejected');

    // 2. Verify new clean task exists, with its own fresh ID
    assert.ok(rerunData.taskId);
    assert.notEqual(rerunData.taskId, taskBId);
    assert.notEqual(rerunData.taskId, taskAId);

    const newDir = path.join(root, '.router', 'tasks', rerunData.taskId);
    assert.ok(fs.existsSync(newDir));
    const newTask = read(path.join(newDir, 'task.json'));

    // 3. Verify clean task context isolation (Task B instruction and project only, ZERO Task A artifacts)
    assert.equal(newTask.id, rerunData.taskId);
    assert.equal(newTask.project, 'adaptive-router');
    assert.equal(newTask.instruction, 'Fix Stage B Approval Context and deliverable binding bug');
    assert.ok(!newTask.instruction.includes('contact form'));
    assert.ok(!newTask.instruction.includes('Sample Shop'));
  } finally {
    await testServer.close();
  }
});

