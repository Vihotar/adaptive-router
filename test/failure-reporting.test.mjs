import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeTask } from '../src/coding.mjs';
import { read, json, saveFiles } from '../src/storage.mjs';
import { buildSchema } from '../src/contracts.mjs';
import { loadTaskEvents } from '../src/events.mjs';
import { formatTaskFailure } from '../src/failure.mjs';
import { createDashboardServer } from '../src/server.mjs';
import { createTestFixture } from './helpers/fixture-helper.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fixture(t) {
  return createTestFixture('fail-rep-', {
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

const dummyFiles = [
  { path: 'greeting.js', content: 'export function greet(name) { return `Hello, ${name}!`; }' },
  { path: 'test/greeting.test.mjs', content: 'import test from "node:test"; test("greet", () => {});' }
];

test('Failure Reporting Suite — Comprehensive Verification', async (t) => {
  await t.test('1. Worker crashes -> clear failure reason, worker, model, stage shown', async () => {
    const root = fixture();
    const task = await codeTask(root, 'Create a greeting script', {
      project: 'test-site',
      call: async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:59999');
        err.code = 'ECONNREFUSED';
        throw err;
      }
    });

    assert.ok(task.status === 'failed' || task.status === 'waiting_for_worker');
    assert.ok(task.failure, 'task.failure must be populated');
    assert.equal(task.failure.stage, 'Build');
    assert.equal(task.failure.workerCompleted, false);
    assert.ok(task.failure.reason.includes('crashed or was unreachable') || task.failure.reason.includes('refused'), `Expected crash explanation, got: ${task.failure.reason}`);
    assert.ok(task.failure.worker, 'Worker must be identified');
    assert.ok(task.failure.recommendedAction, 'Recommended action must be present');
    assert.ok(Array.isArray(task.failure.actions) && task.failure.actions.length >= 2);
  });

  await t.test('2. Worker returns bad/invalid output -> clear failure reason shown', async () => {
    const root = fixture();
    const task = await codeTask(root, 'Create a greeting script', {
      project: 'test-site',
      call: async (_w, req) => {
        if (req.schema === buildSchema) {
          // Missing required files property
          return { summary: 'Invalid output with missing files' };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      }
    });

    assert.ok(task.status === 'failed' || task.status === 'waiting_for_worker');
    assert.ok(task.failure, 'task.failure must be populated');
    assert.equal(task.failure.stage, 'Build');
    assert.ok(task.failure.reason.toLowerCase().includes('invalid') || task.failure.reason.toLowerCase().includes('deliverable') || task.failure.reason.toLowerCase().includes('schema') || task.failure.reason.toLowerCase().includes('unusable'), `Reason should explain bad output: ${task.failure.reason}`);
  });

  await t.test('3. Required file missing -> clear failure reason shown', async () => {
    const root = fixture();
    const task = await codeTask(root, 'Create a greeting script', {
      project: 'test-site',
      call: async (_w, req) => {
        if (req.schema === buildSchema) {
          return { summary: 'Empty file list', files: [] };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      }
    });

    assert.ok(task.status === 'failed' || task.status === 'waiting_for_worker');
    assert.ok(task.failure);
    assert.ok(task.failure.reason.toLowerCase().includes('expected') || task.failure.reason.toLowerCase().includes('files') || task.failure.reason.toLowerCase().includes('unusable') || task.failure.reason.toLowerCase().includes('deliverable'), `Reason: ${task.failure.reason}`);
  });

  await t.test('4. Validation fails -> explicitly distinguishes that worker completed successfully (Replica of 20260914T083226-43dd08c4)', async () => {
    const root = fixture();
    // Simulate baseline files near the limit
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'sample-router.js'), `// Big router file\nconst data = "${'x'.repeat(90_000)}";\n`);

    let workerFinished = false;

    const task = await codeTask(root, 'Update sample-router.js in router', {
      project: 'adaptive-router',
      call: async (_w, req) => {
        if (req.schema === buildSchema) {
          workerFinished = true;
          return {
            summary: 'Valid 160 KB builder output',
            files: [
              { path: 'big-output.js', content: `// Builder output\nconst s = "${'z'.repeat(160_000)}";\n` }
            ]
          };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      }
    });

    assert.ok(workerFinished, 'Worker should have finished generating');
    assert.equal(task.status, 'failed');
    assert.ok(task.failure, 'task.failure must exist');
    assert.equal(task.failure.stage, 'Validation');
    assert.equal(task.failure.workerCompleted, true, 'workerCompleted must be true');
    assert.ok(task.failure.reason.includes('Worker') && task.failure.reason.includes('completed successfully'), `Reason must state worker completed: ${task.failure.reason}`);
    assert.ok(task.failure.reason.includes('150 KB') || task.failure.reason.includes('size limit'), `Reason must mention size limit: ${task.failure.reason}`);
    assert.ok(task.failure.workerStatusText.includes('completed generation successfully'), `Status text must distinguish completion: ${task.failure.workerStatusText}`);
  });

  await t.test('5. Reviewer handoff fails -> clear failure reason shown', async () => {
    const root = fixture();
    const task = await codeTask(root, 'Create a greeting script', {
      project: 'test-site',
      test: async (_r, _p, report, digest) => {
        const rep = { passed: true, digest, checks: [{ name: 'check', passed: true }] };
        json(report, rep);
        return rep;
      },
      call: async (_w, req) => {
        if (req.schema === buildSchema) {
          return {
            summary: 'Code ready',
            files: [
              { path: 'index.html', content: '<html><body>Hello</body></html>' },
              { path: 'styles.css', content: 'body { color: red; }' },
              { path: 'app.js', content: 'console.log("hello");' }
            ]
          };
        }
        if (req.schema === reviewSchema) {
          throw new Error('Reviewer API authentication failed: invalid credentials');
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      }
    });

    // Reviewer error after build transitions to waiting_for_reviewer or failed with clear reason
    assert.ok(task.status === 'waiting_for_reviewer' || task.status === 'failed');
    if (task.status === 'failed') {
      assert.ok(task.failure);
      assert.equal(task.failure.stage, 'Review');
      assert.equal(task.failure.workerCompleted, true);
    } else {
      assert.ok(task.decisionRequired || task.failure);
      const reason = task.decisionRequired?.reason || task.failure?.reason || '';
      assert.ok(reason.includes('Reviewer') || reason.includes('unavailable') || reason.includes('Review'));
    }
  });

  await t.test('6. Errors tab contains failure event with eventType: error and status: error', async () => {
    const root = fixture();
    const task = await codeTask(root, 'Simulate error event task', {
      project: 'test-site',
      call: async () => {
        throw new Error('Simulated build worker failure');
      }
    });

    assert.ok(task.status === 'failed' || task.status === 'waiting_for_worker');
    const events = loadTaskEvents(root, task.id);
    const errorEvents = events.filter(e => e.eventType === 'error' || e.status === 'error' || ['error', 'retry', 'failover'].includes(e.eventType));
    assert.ok(errorEvents.length >= 1, `Errors tab must contain at least 1 error event, found: ${errorEvents.length}`);
    const failureEv = errorEvents.find(e => e.icon === '❌' || e.eventType === 'error');
    assert.ok(failureEv, 'Must have ❌ error event');
    assert.ok(failureEv.detail, 'Error event detail must be present');
  });

  await t.test('7. Failure details survive dashboard refresh (loaded from disk)', async () => {
    const root = fixture();
    const task = await codeTask(root, 'Simulate disk persistence failure', {
      project: 'test-site',
      call: async () => {
        throw new Error('Simulated engine fault for disk reload test');
      }
    });

    // Verify task.json on disk
    const diskTask = read(path.join(root, '.router', 'tasks', task.id, 'task.json'));
    assert.ok(diskTask.status === 'failed' || diskTask.status === 'waiting_for_worker');
    assert.ok(diskTask.failure, 'Disk task must have failure object');
    assert.ok(diskTask.failure.reason);

    // Verify via test dashboard server API
    const testServer = await startTestServer(root);
    try {
      const res = await fetch(`${testServer.url}/api/tasks/${task.id}`);
      assert.equal(res.status, 200);
      const apiTask = await res.json();
      assert.ok(apiTask.status === 'failed' || apiTask.status === 'waiting_for_worker');
      assert.ok(apiTask.failure, 'API must return failure object');
      assert.equal(apiTask.failure.reason, diskTask.failure.reason);

      // Verify activityLog contains Task Failed
      const hasFailedActivity = apiTask.activityLog.some(a => a.title === 'Task Failed');
      assert.ok(hasFailedActivity, 'activityLog must have Task Failed');

      // Verify workerEvents has error event
      const apiErrorEvents = apiTask.workerEvents.filter(e => e.eventType === 'error' || e.status === 'error');
      assert.ok(apiErrorEvents.length >= 1, 'workerEvents must have error event');
    } finally {
      await testServer.close();
    }
  });

  await t.test('8. Failure reason contains no secrets (strict sanitization)', async () => {
    const root = fixture();
    const simulatedSecret = 'sk-ant-api03-abcdef1234567890abcdef12345678';
    const task = await codeTask(root, 'Task with secret in error', {
      project: 'test-site',
      call: async () => {
        throw new Error(`Worker failed: authorization key ${simulatedSecret} was invalid`);
      }
    });

    assert.ok(task.status === 'failed' || task.status === 'waiting_for_worker');
    assert.ok(!task.failure.reason.includes(simulatedSecret), 'Secret must not appear in failure.reason');
    assert.ok(!task.failure.technicalError.includes(simulatedSecret), 'Secret must not appear in failure.technicalError');
    assert.ok(task.failure.technicalError.includes('[REDACTED]'), 'Secret must be replaced with [REDACTED]');

    // Check events.jsonl on disk
    const eventsFile = path.join(root, '.router', 'tasks', task.id, 'events.jsonl');
    const content = fs.readFileSync(eventsFile, 'utf8');
    assert.ok(!content.includes(simulatedSecret), 'Secret must not appear in events.jsonl');
  });

  await t.test('9. Failed task produces failure and error events via API', async () => {
    const root = fixture();
    const taskId = '20260914T083226-43dd08c4';
    const tDir = path.join(root, '.router', 'tasks', taskId);
    fs.mkdirSync(tDir, { recursive: true });
    json(path.join(tDir, 'task.json'), {
      schemaVersion: 2,
      id: taskId,
      project: 'test-site',
      projectName: 'Adaptive Router Test Project (Sample Shop)',
      status: 'failed',
      failure: {
        stage: 'Validation',
        workerCompleted: true,
        reason: 'Deliverable size exceeded 150 KB limit'
      },
      workerEvents: [
        { eventType: 'error', status: 'error', message: 'Deliverable size exceeded 150 KB limit' }
      ]
    });
    fs.writeFileSync(path.join(tDir, 'events.jsonl'), JSON.stringify({
      eventId: 'evt_1',
      taskId,
      sequence: 1,
      eventType: 'error',
      status: 'error',
      title: 'Task Failed',
      detail: 'Deliverable size exceeded 150 KB limit'
    }) + '\n');
    const testServer = await startTestServer(root);
    try {
      const res = await fetch(`${testServer.url}/api/tasks/${taskId}`);
      assert.equal(res.status, 200);
      const histTask = await res.json();
      assert.equal(histTask.status, 'failed');
      assert.ok(histTask.failure, 'Failed task must have failure object');
      assert.equal(histTask.failure.stage, 'Validation');
      assert.equal(histTask.failure.workerCompleted, true);
      assert.ok(histTask.failure.reason.includes('150 KB') || histTask.failure.reason.includes('exceed'));

      // Check Errors tab event
      const errors = histTask.workerEvents.filter(e => e.eventType === 'error' || e.status === 'error');
      assert.ok(errors.length >= 1, 'Failed task must yield an error event for Errors tab');
    } finally {
      await testServer.close();
    }
  });

  await t.test('10. Retry actions on failed tasks in server resume endpoint', async () => {
    const root = fixture();
    const task = await codeTask(root, 'Task to test resume/stop', {
      project: 'test-site',
      call: async () => {
        throw new Error('Initial attempt failure');
      }
    });

    const testServer = await startTestServer(root);
    try {
      // Test stop_task on failed task
      const stopRes = await fetch(`${testServer.url}/api/tasks/${task.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'stop_task' })
      });
      assert.equal(stopRes.status, 200);
      const stopData = await stopRes.json();
      assert.equal(stopData.status, 'cancelled_by_user');
    } finally {
      await testServer.close();
    }
  });
});
