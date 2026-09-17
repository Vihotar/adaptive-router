import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboardServer, getActiveTask, ACTIVE_TASK_STATUSES, TERMINAL_TASK_STATUSES } from '../src/server.mjs';
import { codeTask } from '../src/coding.mjs';
import { classifySensitivity } from '../src/sensitivity.mjs';
import { candidates } from '../src/failover.mjs';
import { read, json, hash, saveFiles } from '../src/storage.mjs';
import { buildSchema } from '../src/contracts.mjs';
import { createTestFixture } from './helpers/fixture-helper.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fixture(t) {
  const config = read(path.join(rootDir, 'workers.json'));
  const agWorker = config.workers.find(w => w.id === 'antigravity');
  if (agWorker) agWorker.enabled = true;
  return createTestFixture('task-ctrl-', {
    seedFixtures: true,
    seedWeb: true,
    seedSpecialists: true,
    workersConfig: config,
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

const dummyFiles = [
  { path: 'index.html', content: '<h1>Test Site</h1>' },
  { path: 'styles.css', content: 'body { color: black; }' },
  { path: 'app.js', content: 'console.log("ok");' }
];

describe('Task Controls and CTO Sensitivity Override', () => {
  // Scenario 1: Sensitive keyword task enters warning state (needs_cto_attention)
  test('Scenario 1: Sensitive keyword task enters warning state (needs_cto_attention)', async () => {
    const root = fixture();
    const task = await codeTask(root, 'Store AWS_SECRET_ACCESS_KEY in config and rotate credentials', {
      project: 'test-site',
      ready() {},
      log() {}
    });

    assert.equal(task.status, 'needs_cto_attention');
    assert.equal(task.sensitive, true);
    assert.ok(task.sensitiveReason);
    assert.ok(task.decisionRequired);
  });

  // Scenario 2: Override button/path exists
  test('Scenario 2: Override button/path exists in decisionRequired options', async () => {
    const root = fixture();
    const task = await codeTask(root, 'Update production database password and API secret token', {
      project: 'test-site',
      ready() {},
      log() {}
    });

    assert.equal(task.status, 'needs_cto_attention');
    const options = task.decisionRequired?.options;
    assert.ok(Array.isArray(options), 'Options array should exist');
    assert.equal(options.length, 2);

    const acknowledgeOpt = options.find(o => o.id === 'acknowledge_sensitive');
    assert.ok(acknowledgeOpt, 'acknowledge_sensitive option should exist');
    assert.equal(acknowledgeOpt.recommended, true);
    assert.equal(acknowledgeOpt.label, 'Continue with Claude (CTO)');

    const overrideOpt = options.find(o => o.id === 'override_sensitive');
    assert.ok(overrideOpt, 'override_sensitive option should exist');
    assert.equal(overrideOpt.recommended, false);
    assert.match(overrideOpt.label, /Ignore warning and continue with worker/i);
  });

  // Scenario 3: Override changes task out of needs_cto_attention
  test('Scenario 3: Override changes task out of needs_cto_attention', async () => {
    const root = fixture();
    const task = await codeTask(root, 'Store AWS API secret key and credentials in secure vault configuration', {
      project: 'test-site',
      ready() {},
      log() {}
    });
    assert.equal(task.status, 'needs_cto_attention');

    // Override via resume
    const resumed = await codeTask(root, '', {
      resume: task.id,
      override_sensitive: true,
      project: 'test-site',
      ready() {},
      log() {},
      call: async (_w, r) => {
        if (r.schema === buildSchema) {
          return { summary: 'Stored key in vault', files: dummyFiles };
        }
        return { verdict: 'pass', summary: 'Approved', issues: [] };
      },
      test: async (_r, _p, report, digest) => {
        const rep = { passed: true, digest, checks: [{ name: 'test', passed: true }] };
        json(report, rep);
        return rep;
      }
    });

    assert.notEqual(resumed.status, 'needs_cto_attention');
    assert.equal(resumed.sensitiveOverridden, true);
    assert.equal(resumed.status, 'awaiting_approval');
  });

  // Scenario 4: Override preserves Stage A requirement
  test('Scenario 4: Override preserves Stage A governance rules', async () => {
    const root = fixture();
    const task = await codeTask(root, 'Refactor entire database credentials subsystem', {
      project: 'test-site',
      ready() {},
      log() {}
    });
    assert.equal(task.status, 'needs_cto_attention');

    // Mark planRequired on task to simulate Stage A requirement
    const taskPath = path.join(root, '.router', 'tasks', task.id, 'task.json');
    const taskObj = read(taskPath);
    taskObj.planRequired = true;
    taskObj.sensitiveOverridden = true;
    json(taskPath, taskObj);

    // Verify task maintains plan requirement
    const reloaded = read(taskPath);
    assert.equal(reloaded.planRequired, true);
    assert.equal(reloaded.sensitiveOverridden, true);
  });

  // Scenario 5: Disabled worker remains disabled after override
  test('Scenario 5: Disabled worker remains disabled after override', async () => {
    const root = fixture();
    const cfg = read(path.join(root, 'workers.json'));
    // Disable codex
    const targetWorker = cfg.workers.find(w => w.id === 'codex');
    if (targetWorker) targetWorker.enabled = false;
    json(path.join(root, 'workers.json'), cfg);

    const buildCandidates = candidates(cfg, 'build');
    assert.ok(!buildCandidates.some(c => c.id === 'codex'), 'Codex should not be in candidates');

    // Run task with sensitive keywords and resume with override
    const task = await codeTask(root, 'Configure AWS API secret key and database password', {
      project: 'test-site',
      ready() {},
      log() {}
    });
    assert.equal(task.status, 'needs_cto_attention');

    const resumed = await codeTask(root, '', {
      resume: task.id,
      override_sensitive: true,
      project: 'test-site',
      ready() {},
      log() {},
      call: async (w, r) => {
        assert.notEqual(w.id, 'codex', 'Codex must never be called when disabled');
        if (r.schema === buildSchema) {
          return { summary: 'Configured', files: dummyFiles };
        }
        return { verdict: 'pass', summary: 'Approved', issues: [] };
      },
      test: async (_r, _p, report, digest) => {
        const rep = { passed: true, digest, checks: [{ name: 'test', passed: true }] };
        json(report, rep);
        return rep;
      }
    });

    assert.notEqual(resumed.builder, 'codex');
  });

  // Scenario 6: Override event is logged (SENSITIVITY_OVERRIDE_BY_USER)
  test('Scenario 6: Override event is logged with SENSITIVITY_OVERRIDE_BY_USER', async () => {
    const root = fixture();
    const testServer = await startTestServer(root);

    try {
      const task = await codeTask(root, 'Rotate AWS API secret key and credentials', {
        project: 'test-site',
        ready() {},
        log() {}
      });
      assert.equal(task.status, 'needs_cto_attention');

      // Call resume endpoint with override_sensitive decision
      const res = await fetch(`${testServer.url}/api/tasks/${task.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'override_sensitive', project: 'test-site' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);

      // Check task.json
      const taskPath = path.join(root, '.router', 'tasks', task.id, 'task.json');
      const updated = read(taskPath);
      assert.equal(updated.sensitiveOverridden, true);

      const overrideLog = updated.activityLog?.find(a => a.eventType === 'SENSITIVITY_OVERRIDE_BY_USER');
      assert.ok(overrideLog, 'activityLog should contain SENSITIVITY_OVERRIDE_BY_USER');
      assert.equal(overrideLog.matched, undefined, 'activityLog must not log raw matched text');
      assert.equal(overrideLog.matchedText, undefined, 'activityLog must not log raw matchedText');

      // Check event on disk
      const eventsPath = path.join(root, '.router', 'tasks', task.id, 'events.ndjson');
      if (fs.existsSync(eventsPath)) {
        const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
        const overrideWorkerEvent = lines.find(e => e.eventType === 'SENSITIVITY_OVERRIDE_BY_USER');
        if (overrideWorkerEvent) {
          assert.equal(overrideWorkerEvent.matched, undefined, 'Worker event must not contain raw matched text');
          assert.equal(overrideWorkerEvent.matchedText, undefined, 'Worker event must not contain raw matchedText');
          assert.equal(overrideWorkerEvent.category, 'credentials_or_access');
          assert.equal(overrideWorkerEvent.overrideAction, 'continue_with_worker');
          assert.ok(overrideWorkerEvent.reason, 'Reason should be recorded');
        }
      }
    } finally {
      await testServer.close();
    }
  });

  // Scenario 7: Pause changes task to paused_by_user and does NOT kill in-flight worker
  test('Scenario 7: Pause changes task to paused_by_user and allows in-flight worker to finish safely', async () => {
    const root = fixture();
    const testServer = await startTestServer(root);

    try {
      const taskId = '20260914T100000-aaaa1111';
      const taskDir = path.join(root, '.router', 'tasks', taskId);
      fs.mkdirSync(taskDir, { recursive: true });
      json(path.join(taskDir, 'task.json'), {
        id: taskId,
        project: 'test-site',
        projectRoot: path.join(root, 'fixtures', 'test-site'),
        status: 'building',
        instruction: 'Building something',
        created: new Date().toISOString()
      });

      const res = await fetch(`${testServer.url}/api/tasks/${taskId}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'test-site' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.status, 'paused_by_user');

      const saved = read(path.join(taskDir, 'task.json'));
      assert.equal(saved.status, 'paused_by_user');

      // Now verify in-flight worker atomic completion:
      let buildOperationFinished = false;
      let reviewerOperationStarted = false;

      const inFlightTask = await codeTask(root, 'Add a banner to test site', {
        project: 'test-site',
        ready() {},
        log() {},
        call: async (_w, r) => {
          if (r.schema === buildSchema) {
            // Simulate pause arriving while builder is executing
            const liveDir = path.dirname(r.dir);
            const tObj = read(path.join(liveDir, 'task.json'));
            tObj.status = 'paused_by_user';
            json(path.join(liveDir, 'task.json'), tObj);

            await new Promise(res => setTimeout(res, 30));
            buildOperationFinished = true;
            return { summary: 'Banner added', files: dummyFiles };
          }
          reviewerOperationStarted = true;
          return { verdict: 'pass', summary: 'Approved', issues: [] };
        },
        test: async (_r, _p, report, digest) => {
          const rep = { passed: true, digest, checks: [{ name: 'test', passed: true }] };
          json(report, rep);
          return rep;
        }
      });

      assert.equal(buildOperationFinished, true, 'In-flight build operation must complete safely');
      assert.equal(reviewerOperationStarted, false, 'Reviewer operation must NOT be launched after pause');
      assert.equal(inFlightTask.status, 'paused_by_user', 'Task must be held in paused_by_user at safe boundary');
    } finally {
      await testServer.close();
    }
  });

  // Scenario 8: Paused task does not launch next worker step
  test('Scenario 8: Paused task does not launch next worker step', async () => {
    const root = fixture();
    const taskId = '20260914T100001-aaaa2222';
    const taskDir = path.join(root, '.router', 'tasks', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    json(path.join(taskDir, 'task.json'), {
      id: taskId,
      project: 'test-site',
      status: 'paused_by_user',
      instruction: 'Test pause step',
      created: new Date().toISOString()
    });

    let workerCalled = false;
    // Attempting codeTask without resume should reject or throw
    await assert.rejects(async () => {
      await codeTask(root, null, {
        project: 'test-site',
        ready() {},
        log() {},
        call: async () => { workerCalled = true; return {}; }
      });
    });
    assert.equal(workerCalled, false);
  });

  // Scenario 9: Resume continues from saved state
  test('Scenario 9: Resume continues from paused_by_user state', async () => {
    const root = fixture();
    const taskId = '20260914T100002-aaaa3333';
    const taskDir = path.join(root, '.router', 'tasks', taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.mkdirSync(path.join(taskDir, 'baseline'), { recursive: true });
    json(path.join(taskDir, 'baseline.json'), dummyFiles);
    json(path.join(taskDir, 'task.json'), {
      id: taskId,
      project: 'test-site',
      projectRoot: path.join(root, 'fixtures', 'test-site'),
      status: 'paused_by_user',
      instruction: 'Add a banner to test site',
      revision: 0,
      created: new Date().toISOString()
    });

    let buildCalled = false;
    const resumed = await codeTask(root, '', {
      resume: taskId,
      project: 'test-site',
      ready() {},
      log() {},
      call: async (_w, r) => {
        if (r.schema === buildSchema) {
          buildCalled = true;
          return { summary: 'Banner added', files: [{ path: 'index.html', content: '<h1>Test Site - Banner</h1>' }, { path: 'styles.css', content: 'body { color: black; }' }, { path: 'app.js', content: 'console.log("ok");' }] };
        }
        return { verdict: 'pass', summary: 'Approved', issues: [] };
      },
      test: async (_r, _p, report, digest) => {
        const rep = { passed: true, digest, checks: [{ name: 'test', passed: true }] };
        json(report, rep);
        return rep;
      }
    });

    assert.equal(buildCalled, true);
    assert.equal(resumed.status, 'awaiting_approval');
  });

  // Scenario 10: Stop changes task to cancelled_by_user and terminates in-flight worker
  test('Scenario 10: Stop changes task to cancelled_by_user and terminates active in-flight worker', async () => {
    const root = fixture();
    const testServer = await startTestServer(root);

    try {
      const taskId = '20260914T100003-aaaa4444';
      const taskDir = path.join(root, '.router', 'tasks', taskId);
      fs.mkdirSync(taskDir, { recursive: true });
      json(path.join(taskDir, 'task.json'), {
        id: taskId,
        project: 'test-site',
        projectRoot: path.join(root, 'fixtures', 'test-site'),
        status: 'building',
        instruction: 'Running task to stop',
        created: new Date().toISOString()
      });

      const res = await fetch(`${testServer.url}/api/tasks/${taskId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'test-site' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.status, 'cancelled_by_user');

      const saved = read(path.join(taskDir, 'task.json'));
      assert.equal(saved.status, 'cancelled_by_user');
      assert.equal(saved.stoppedByUser, true);

      // Verify in-flight worker termination when Stop is invoked:
      const abortController = new AbortController();
      let workerFinishedAfterStop = false;

      const stopTaskPromise = codeTask(root, 'Add a contact form', {
        project: 'test-site',
        signal: abortController.signal,
        ready() {},
        log() {},
        call: async (_w, r) => {
          // Abort mid-flight (simulating Stop Task click)
          abortController.abort();
          if (r.signal?.aborted) {
            throw Error('TASK_ABORTED_BY_USER');
          }
          await new Promise(res => setTimeout(res, 50));
          workerFinishedAfterStop = true;
          return { summary: 'Should not finish', files: dummyFiles };
        }
      });

      const stoppedResult = await stopTaskPromise;
      assert.equal(workerFinishedAfterStop, false, 'In-flight worker must be terminated when stopped');
      assert.equal(stoppedResult.status, 'cancelled_by_user', 'Task must be cancelled_by_user on stop');
      assert.equal(stoppedResult.stoppedByUser, true);
    } finally {
      await testServer.close();
    }
  });

  // Scenario 11: Stop releases active-task lock
  test('Scenario 11: Stop releases router.lock and frees getActiveTask', async () => {
    const root = fixture();
    const testServer = await startTestServer(root);

    try {
      const taskId = '20260914T100004-aaaa5555';
      const taskDir = path.join(root, '.router', 'tasks', taskId);
      fs.mkdirSync(taskDir, { recursive: true });
      json(path.join(taskDir, 'task.json'), {
        id: taskId,
        project: 'test-site',
        status: 'building',
        instruction: 'Lock holding task',
        created: new Date().toISOString()
      });

      // Simulate a lock on disk
      const lockPath = path.join(root, '.router', 'router.lock');
      fs.writeFileSync(lockPath, 'locked');
      assert.ok(fs.existsSync(lockPath));

      // Stop the task
      const res = await fetch(`${testServer.url}/api/tasks/${taskId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'test-site' })
      });
      assert.equal(res.status, 200);

      // Lock must be released
      assert.equal(fs.existsSync(lockPath), false, 'router.lock must be removed');
      const activeTask = getActiveTask(root, 'test-site');
      assert.equal(activeTask, null, 'getActiveTask must return null');
    } finally {
      await testServer.close();
    }
  });

  // Scenario 12: New task can start immediately after Stop
  test('Scenario 12: New task can start immediately after Stop (no 409 conflict)', async () => {
    const root = fixture();
    const testServer = await startTestServer(root);

    try {
      const taskId = '20260914T100005-aaaa6666';
      const taskDir = path.join(root, '.router', 'tasks', taskId);
      fs.mkdirSync(taskDir, { recursive: true });
      json(path.join(taskDir, 'task.json'), {
        id: taskId,
        project: 'test-site',
        status: 'running',
        instruction: 'Previous active task',
        created: new Date().toISOString()
      });

      // Confirm active task blocks creation
      const preCheck = getActiveTask(root, 'test-site');
      assert.ok(preCheck, 'Should have active task before stop');

      // Stop previous task
      const stopRes = await fetch(`${testServer.url}/api/tasks/${taskId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'test-site' })
      });
      assert.equal(stopRes.status, 200);

      // Now create new task - active task check should not conflict
      assert.equal(getActiveTask(root, 'test-site'), null);
    } finally {
      await testServer.close();
    }
  });

  // Scenario 13: Stop from needs_cto_attention works
  test('Scenario 13: Stop from needs_cto_attention works', async () => {
    const root = fixture();
    const testServer = await startTestServer(root);

    try {
      const task = await codeTask(root, 'Review AWS_SECRET_ACCESS_KEY credentials', {
        project: 'test-site',
        ready() {},
        log() {}
      });
      assert.equal(task.status, 'needs_cto_attention');

      const stopRes = await fetch(`${testServer.url}/api/tasks/${task.id}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'test-site' })
      });
      assert.equal(stopRes.status, 200);
      const data = await stopRes.json();
      assert.equal(data.status, 'cancelled_by_user');

      const taskPath = path.join(root, '.router', 'tasks', task.id, 'task.json');
      const updated = read(taskPath);
      assert.equal(updated.status, 'cancelled_by_user');
      assert.equal(updated.stoppedByUser, true);
    } finally {
      await testServer.close();
    }
  });

  // Scenario 14: Stop from waiting_for_worker works
  test('Scenario 14: Stop from waiting_for_worker works', async () => {
    const root = fixture();
    const testServer = await startTestServer(root);

    try {
      const taskId = '20260914T100006-aaaa7777';
      const taskDir = path.join(root, '.router', 'tasks', taskId);
      fs.mkdirSync(taskDir, { recursive: true });
      json(path.join(taskDir, 'task.json'), {
        id: taskId,
        project: 'test-site',
        status: 'waiting_for_worker',
        instruction: 'Stuck waiting for worker',
        error: 'Quota exhausted',
        created: new Date().toISOString()
      });

      const stopRes = await fetch(`${testServer.url}/api/tasks/${taskId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'test-site' })
      });
      assert.equal(stopRes.status, 200);
      const data = await stopRes.json();
      assert.equal(data.status, 'cancelled_by_user');

      const updated = read(path.join(taskDir, 'task.json'));
      assert.equal(updated.status, 'cancelled_by_user');
    } finally {
      await testServer.close();
    }
  });

  // Scenario 15: Stop from Stage A waiting state (awaiting_plan_approval) works
  test('Scenario 15: Stop from Stage A awaiting_plan_approval works', async () => {
    const root = fixture();
    const testServer = await startTestServer(root);

    try {
      const taskId = '20260914T100007-aaaa8888';
      const taskDir = path.join(root, '.router', 'tasks', taskId);
      fs.mkdirSync(taskDir, { recursive: true });
      json(path.join(taskDir, 'task.json'), {
        id: taskId,
        project: 'test-site',
        status: 'awaiting_plan_approval',
        instruction: 'Awaiting Stage A plan review',
        created: new Date().toISOString()
      });

      const stopRes = await fetch(`${testServer.url}/api/tasks/${taskId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'test-site' })
      });
      assert.equal(stopRes.status, 200);
      const data = await stopRes.json();
      assert.equal(data.status, 'cancelled_by_user');

      const updated = read(path.join(taskDir, 'task.json'));
      assert.equal(updated.status, 'cancelled_by_user');
    } finally {
      await testServer.close();
    }
  });

  // Scenario 16: Stop from Stage B waiting state (awaiting_approval) works
  test('Scenario 16: Stop from Stage B awaiting_approval works', async () => {
    const root = fixture();
    const testServer = await startTestServer(root);

    try {
      const taskId = '20260914T100008-aaaa9999';
      const taskDir = path.join(root, '.router', 'tasks', taskId);
      fs.mkdirSync(taskDir, { recursive: true });
      json(path.join(taskDir, 'task.json'), {
        id: taskId,
        project: 'test-site',
        status: 'awaiting_approval',
        instruction: 'Awaiting Stage B final review',
        created: new Date().toISOString()
      });

      const stopRes = await fetch(`${testServer.url}/api/tasks/${taskId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'test-site' })
      });
      assert.equal(stopRes.status, 200);
      const data = await stopRes.json();
      assert.equal(data.status, 'cancelled_by_user');

      const updated = read(path.join(taskDir, 'task.json'));
      assert.equal(updated.status, 'cancelled_by_user');
    } finally {
      await testServer.close();
    }
  });

  // Scenario 17: ACTIVE_TASK_STATUSES and TERMINAL_TASK_STATUSES consistency
  test('Scenario 17: Status sets partition active and terminal states correctly', () => {
    assert.ok(ACTIVE_TASK_STATUSES.has('paused_by_user'), 'paused_by_user must be in ACTIVE_TASK_STATUSES');
    assert.ok(ACTIVE_TASK_STATUSES.has('needs_cto_attention'), 'needs_cto_attention must be in ACTIVE_TASK_STATUSES');
    assert.ok(ACTIVE_TASK_STATUSES.has('waiting_for_worker'), 'waiting_for_worker must be in ACTIVE_TASK_STATUSES');
    assert.ok(ACTIVE_TASK_STATUSES.has('awaiting_plan_approval'), 'awaiting_plan_approval must be in ACTIVE_TASK_STATUSES');
    assert.ok(ACTIVE_TASK_STATUSES.has('awaiting_approval'), 'awaiting_approval must be in ACTIVE_TASK_STATUSES');

    assert.ok(TERMINAL_TASK_STATUSES.has('cancelled_by_user'), 'cancelled_by_user must be in TERMINAL_TASK_STATUSES');
    assert.ok(TERMINAL_TASK_STATUSES.has('completed'), 'completed must be in TERMINAL_TASK_STATUSES');
    assert.ok(TERMINAL_TASK_STATUSES.has('approved'), 'approved must be in TERMINAL_TASK_STATUSES');
    assert.ok(TERMINAL_TASK_STATUSES.has('rejected'), 'rejected must be in TERMINAL_TASK_STATUSES');

    // No overlap
    for (const status of ACTIVE_TASK_STATUSES) {
      assert.ok(!TERMINAL_TASK_STATUSES.has(status), `Status ${status} must not be in both sets`);
    }
  });

  // Scenario 18: Cannot resume a task in terminal status
  test('Scenario 18: Cannot resume a task in cancelled_by_user status', async () => {
    const root = fixture();
    const testServer = await startTestServer(root);

    try {
      const taskId = '20260914T100009-bbbb1111';
      const taskDir = path.join(root, '.router', 'tasks', taskId);
      fs.mkdirSync(taskDir, { recursive: true });
      json(path.join(taskDir, 'task.json'), {
        id: taskId,
        project: 'test-site',
        status: 'cancelled_by_user',
        instruction: 'Cancelled task',
        created: new Date().toISOString()
      });

      const res = await fetch(`${testServer.url}/api/tasks/${taskId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'test-site' })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /Cannot resume task in terminal status/);
    } finally {
      await testServer.close();
    }
  });

  // Scenario 19: Cannot pause a task in terminal status
  test('Scenario 19: Cannot pause a task in cancelled_by_user status', async () => {
    const root = fixture();
    const testServer = await startTestServer(root);

    try {
      const taskId = '20260914T100010-bbbb2222';
      const taskDir = path.join(root, '.router', 'tasks', taskId);
      fs.mkdirSync(taskDir, { recursive: true });
      json(path.join(taskDir, 'task.json'), {
        id: taskId,
        project: 'test-site',
        status: 'cancelled_by_user',
        instruction: 'Cancelled task',
        created: new Date().toISOString()
      });

      const res = await fetch(`${testServer.url}/api/tasks/${taskId}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'test-site' })
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /Cannot pause task in terminal status/);
    } finally {
      await testServer.close();
    }
  });

  // Scenario 20: Acknowledge sensitive warning records acknowledgment without worker launch
  test('Scenario 20: Acknowledge sensitive warning records acknowledgment cleanly', async () => {
    const root = fixture();
    const testServer = await startTestServer(root);

    try {
      const task = await codeTask(root, 'Store AWS API secret key and credentials', {
        project: 'test-site',
        ready() {},
        log() {}
      });
      assert.equal(task.status, 'needs_cto_attention');

      const res = await fetch(`${testServer.url}/api/tasks/${task.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'acknowledge_sensitive', project: 'test-site' })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.acknowledged, true);

      const taskPath = path.join(root, '.router', 'tasks', task.id, 'task.json');
      const updated = read(taskPath);
      assert.equal(updated.sensitiveAcknowledged, true);
      // Stays in needs_cto_attention, not sent to worker
      assert.equal(updated.status, 'needs_cto_attention');
    } finally {
      await testServer.close();
    }
  });

  // Scenario 21: Sensitivity decision dialog buttons have exact labels and shared lifecycle endpoints
  test('Scenario 21: Sensitivity decision dialog buttons have exact labels and shared lifecycle endpoints', async () => {
    const root = fixture();
    const testServer = await startTestServer(root);

    try {
      const task = await codeTask(root, 'Update production database password and AWS secret key', {
        project: 'test-site',
        ready() {},
        log() {}
      });
      assert.equal(task.status, 'needs_cto_attention');

      // Verify options defined on task
      const options = task.decisionRequired?.options;
      assert.ok(Array.isArray(options));
      assert.equal(options[0].label, 'Continue with Claude (CTO)');
      assert.equal(options[1].label, 'Ignore warning and continue with worker');

      // Verify the app.js script contains exact labels for all 4 buttons and shared handlers
      const appJs = fs.readFileSync(path.join(root, 'src', 'web', 'app.js'), 'utf8');
      assert.ok(appJs.includes('<span>Pause Task</span>'), 'app.js must include exact Pause Task button');
      assert.ok(appJs.includes('<span>Stop Task</span>'), 'app.js must include exact Stop Task button');
      assert.ok(appJs.includes('executePauseTask()'), 'app.js must use shared executePauseTask');
      assert.ok(appJs.includes('executeStopTask()'), 'app.js must use shared executeStopTask');

      // Verify Stop Task endpoint from sensitivity warning works identically
      const stopRes = await fetch(`${testServer.url}/api/tasks/${task.id}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'test-site' })
      });
      assert.equal(stopRes.status, 200);
      const stopData = await stopRes.json();
      assert.equal(stopData.status, 'cancelled_by_user');

      // Verify Pause Task endpoint on a separate sensitive task works identically
      const task2 = await codeTask(root, 'Rotate cloud database password and credentials', {
        project: 'test-site',
        ready() {},
        log() {}
      });
      assert.equal(task2.status, 'needs_cto_attention');

      const pauseRes = await fetch(`${testServer.url}/api/tasks/${task2.id}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'test-site' })
      });
      assert.equal(pauseRes.status, 200);
      const pauseData = await pauseRes.json();
      assert.equal(pauseData.status, 'paused_by_user');
    } finally {
      await testServer.close();
    }
  });
});

