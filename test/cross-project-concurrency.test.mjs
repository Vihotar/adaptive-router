import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboardServer, getActiveTask } from '../src/server.mjs';
import { read, json } from '../src/storage.mjs';
import { createProject } from '../src/projects.mjs';
import { createTestFixture } from './helpers/fixture-helper.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Verifies the activeRunningTasks refactor (server.mjs) actually delivers
// what it was built for: a task "active" on one project must NOT block a
// task start on a DIFFERENT project, while same-project blocking remains
// exactly as strict as before. This exercises the real POST /api/tasks 409
// gate over HTTP, not just the underlying module functions in isolation —
// the same style of gap that caused an earlier root-path bug in a related
// feature (cto-attention.mjs) to slip past pure unit tests.
function fixture(t) {
  return createTestFixture('cross-project-concurrency-', {
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

// Simulates an in-flight task the same way the existing sensitivity-override
// test suite does (Scenario 10-12): write a task.json directly with an
// ACTIVE_TASK_STATUSES status, rather than actually driving a real worker
// call through codeTask() — getActiveTask()'s disk fallback (listRecentTasks
// -> newest task's on-disk status) picks this up exactly as it would a
// genuinely running task, and this is what POST /api/tasks's 409 check
// calls.
function simulateActiveTask(root, projectId, projectRoot) {
  const taskId = `2026010${Math.floor(Math.random() * 9) + 1}T000000-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`;
  const taskDir = path.join(root, '.router', 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  json(path.join(taskDir, 'task.json'), {
    id: taskId,
    project: projectId,
    projectRoot,
    status: 'running',
    instruction: 'Simulated active task for concurrency test',
    created: new Date().toISOString()
  });
  return taskId;
}

describe('Cross-Project Concurrency (activeRunningTasks per-project gate)', () => {
  test('A task active on Project A does not block starting a task on Project B', async (t) => {
    const root = fixture(t);
    // test-site is the always-present fixture project (see projects.mjs).
    // Register a second, independent project pointing at a second fixture
    // folder so the two are genuinely different project ids/roots.
    const secondRoot = path.join(root, 'fixtures', 'test-site-2');
    fs.cpSync(path.join(root, 'fixtures', 'test-site'), secondRoot, { recursive: true });
    const projectB = createProject(root, { name: 'Second Project', mode: 'existing', folderPath: secondRoot });

    const testServer = await startTestServer(root);
    try {
      // Simulate Project A ("test-site") having an active task.
      simulateActiveTask(root, 'test-site', path.join(root, 'fixtures', 'test-site'));
      assert.ok(getActiveTask(root, 'test-site'), 'sanity: test-site should show as active');
      assert.equal(getActiveTask(root, projectB.id), null, 'sanity: Project B should show no active task of its own');

      // A task start on Project A must still correctly 409.
      const resA = await fetch(`${testServer.url}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: 'Another task on the same project', project: 'test-site' })
      });
      assert.equal(resA.status, 409, 'same-project task start must still be blocked (no regression in serialization)');

      // A task start on Project B (genuinely different project) must NOT
      // be blocked by Project A's active task — this is the actual
      // capability this refactor was built to unlock.
      const resB = await fetch(`${testServer.url}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: 'Delete all customer payment credentials and API keys from the database', project: projectB.id })
      });
      assert.notEqual(resB.status, 409, 'a different project\'s task start must not be blocked by another project\'s active task');
      assert.equal(resB.status, 200, 'Project B task should start successfully');
      const dataB = await resB.json();
      assert.equal(dataB.success, true);
      assert.ok(dataB.taskId, 'Project B task should get a real task id');

      // Give the background IIFE a moment to run the (fast, no-real-worker)
      // sensitivity gate and settle, then clean up the task it created so
      // this test doesn't leave a stray "active" task in the map.
      await new Promise(r => setTimeout(r, 500));
    } finally {
      await testServer.close();
    }
  });

  test('Two projects can each independently 409 their own second concurrent start', async (t) => {
    const root = fixture(t);
    const secondRoot = path.join(root, 'fixtures', 'test-site-2');
    fs.cpSync(path.join(root, 'fixtures', 'test-site'), secondRoot, { recursive: true });
    const projectB = createProject(root, { name: 'Second Project', mode: 'existing', folderPath: secondRoot });

    const testServer = await startTestServer(root);
    try {
      simulateActiveTask(root, 'test-site', path.join(root, 'fixtures', 'test-site'));
      simulateActiveTask(root, projectB.id, secondRoot);

      const resA = await fetch(`${testServer.url}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: 'Second task on A', project: 'test-site' })
      });
      const resB = await fetch(`${testServer.url}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction: 'Second task on B', project: projectB.id })
      });
      assert.equal(resA.status, 409, 'Project A must independently block its own second concurrent start');
      assert.equal(resB.status, 409, 'Project B must independently block its own second concurrent start');
    } finally {
      await testServer.close();
    }
  });
});
