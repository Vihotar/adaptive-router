import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboardServer } from '../src/server.mjs';
import { read, json } from '../src/storage.mjs';
import { createProject } from '../src/projects.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Note: the always-present 'test-site' project (see projects.mjs) is
// registered with hidden: true, kind: 'fixture' — deliberately excluded
// from /api/office-view (listRegisteredProjects({ includeHidden: false })),
// same as it's excluded from the production Tasks/Projects UI. So these
// tests register real, visible projects instead of relying on it, which
// also happens to be a closer match to how Office View is actually used.
function fixture() {
  const tmp = fs.mkdtempSync(path.resolve('.router/tests/office-view-'));
  fs.cpSync(path.join(rootDir, 'fixtures'), path.join(tmp, 'fixtures'), { recursive: true });
  fs.cpSync(path.join(rootDir, 'src', 'web'), path.join(tmp, 'src', 'web'), { recursive: true });
  if (fs.existsSync(path.join(rootDir, 'specialists.json'))) {
    fs.copyFileSync(path.join(rootDir, 'specialists.json'), path.join(tmp, 'specialists.json'));
  }
  const config = read(path.join(rootDir, 'workers.json'));
  json(path.join(tmp, 'workers.json'), config);
  return tmp;
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

function registerVisibleProject(root, name) {
  const folder = path.join(root, 'fixtures', name.toLowerCase().replace(/\s+/g, '-'));
  fs.cpSync(path.join(root, 'fixtures', 'test-site'), folder, { recursive: true });
  return createProject(root, { name, mode: 'existing', folderPath: folder });
}

function writeTask(root, projectId, projectRoot, overrides = {}) {
  const taskId = `2026010${Math.floor(Math.random() * 9) + 1}T000000-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`;
  const taskDir = path.join(root, '.router', 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  // A real task always carries a routingLog with build/review role entries
  // (that's what listRecentTasks()'s on-disk-fallback shape actually reads
  // for its builder/reviewer fields — it does NOT read builderWorker /
  // reviewerWorker directly). Fixtures must mirror that shape, or the
  // disk-fallback resolution path (used whenever the in-memory
  // activeRunningTasks map hasn't been populated for this task, which is
  // always true here since these are written directly to disk rather than
  // driven through a real codeTask() run) reports 'Unknown' instead of the
  // intended worker — a fixture-fidelity gap, not a real endpoint bug.
  const routingLog = [];
  if (overrides.builderWorker) routingLog.push({ role: 'build', worker: overrides.builderWorker });
  if (overrides.reviewerWorker) routingLog.push({ role: 'review', worker: overrides.reviewerWorker });
  json(path.join(taskDir, 'task.json'), {
    id: taskId,
    project: projectId,
    projectRoot,
    status: 'building',
    instruction: 'Office View test task',
    created: new Date().toISOString(),
    routingLog,
    ...overrides
  });
  return taskId;
}

describe('GET /api/office-view — real multi-task runtime state', () => {
  test('No active tasks: every listed project reports task: null, no workers marked busy', async () => {
    const root = fixture();
    const testServer = await startTestServer(root);
    try {
      const res = await fetch(`${testServer.url}/api/office-view`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.projects));
      assert.ok(data.projects.length >= 1, 'the always-present adaptive-router project should be listed');
      for (const p of data.projects) assert.equal(p.task, null);
      assert.ok(Array.isArray(data.workers));
      for (const w of data.workers) assert.equal(w.busy, false, `worker ${w.id} should not be busy when nothing is running`);
    } finally {
      await testServer.close();
    }
  });

  test('A building task marks its builder worker busy and surfaces on its project', async () => {
    const root = fixture();
    const projectA = registerVisibleProject(root, 'Project Alpha');
    const testServer = await startTestServer(root);
    try {
      const taskId = writeTask(root, projectA.id, projectA.rootPath, {
        status: 'building',
        builderWorker: 'antigravity'
      });
      const res = await fetch(`${testServer.url}/api/office-view`);
      const data = await res.json();
      const entry = data.projects.find(p => p.projectId === projectA.id);
      assert.ok(entry, 'Project Alpha should be present in the listing');
      assert.ok(entry.task, 'Project Alpha should show an active task');
      assert.equal(entry.task.id, taskId);
      assert.equal(entry.task.status, 'building');
      assert.equal(entry.task.isWorkerRunning, true);
      assert.equal(entry.task.activeWorker, 'antigravity');
      assert.equal(entry.task.waitingOnCto, false);

      const antigravity = data.workers.find(w => w.id === 'antigravity');
      assert.equal(antigravity.busy, true, 'antigravity should be reported busy');
      const codex = data.workers.find(w => w.id === 'codex');
      assert.equal(codex.busy, false, 'an unrelated worker must not be marked busy — never fake activity');
    } finally {
      await testServer.close();
    }
  });

  test('A reviewing task marks the REVIEWER worker busy, not the builder', async () => {
    const root = fixture();
    const projectA = registerVisibleProject(root, 'Project Alpha');
    const testServer = await startTestServer(root);
    try {
      writeTask(root, projectA.id, projectA.rootPath, {
        status: 'reviewing',
        builderWorker: 'antigravity',
        reviewerWorker: 'codex'
      });
      const res = await fetch(`${testServer.url}/api/office-view`);
      const data = await res.json();
      const entry = data.projects.find(p => p.projectId === projectA.id);
      assert.equal(entry.task.activeWorker, 'codex', 'during review, the reviewer is the one actually running, not the builder');

      const codex = data.workers.find(w => w.id === 'codex');
      const antigravity = data.workers.find(w => w.id === 'antigravity');
      assert.equal(codex.busy, true);
      assert.equal(antigravity.busy, false, 'the builder is idle again once review has taken over — must not show stale busy state');
    } finally {
      await testServer.close();
    }
  });

  test('needs_cto_attention is surfaced as waitingOnCto, never as a worker actively running', async () => {
    const root = fixture();
    const projectA = registerVisibleProject(root, 'Project Alpha');
    const testServer = await startTestServer(root);
    try {
      writeTask(root, projectA.id, projectA.rootPath, {
        status: 'needs_cto_attention',
        builderWorker: 'antigravity'
      });
      const res = await fetch(`${testServer.url}/api/office-view`);
      const data = await res.json();
      const entry = data.projects.find(p => p.projectId === projectA.id);
      assert.equal(entry.task.isWorkerRunning, false, 'no worker is actually executing while a task waits on the CTO');
      assert.equal(entry.task.activeWorker, null);
      assert.equal(entry.task.waitingOnCto, true);

      const antigravity = data.workers.find(w => w.id === 'antigravity');
      assert.equal(antigravity.busy, false, 'a worker must never be shown busy while genuinely idle, even if it built the task earlier');
    } finally {
      await testServer.close();
    }
  });

  test('Two different projects each with their own active task both appear, independently', async () => {
    const root = fixture();
    const projectA = registerVisibleProject(root, 'Project Alpha');
    const projectB = registerVisibleProject(root, 'Project Beta');

    const testServer = await startTestServer(root);
    try {
      writeTask(root, projectA.id, projectA.rootPath, { status: 'building', builderWorker: 'antigravity' });
      writeTask(root, projectB.id, projectB.rootPath, { status: 'building', builderWorker: 'codex' });

      const res = await fetch(`${testServer.url}/api/office-view`);
      const data = await res.json();
      const entryA = data.projects.find(p => p.projectId === projectA.id);
      const entryB = data.projects.find(p => p.projectId === projectB.id);
      assert.ok(entryA.task && entryA.task.activeWorker === 'antigravity');
      assert.ok(entryB.task && entryB.task.activeWorker === 'codex');

      assert.equal(data.workers.find(w => w.id === 'antigravity').busy, true);
      assert.equal(data.workers.find(w => w.id === 'codex').busy, true);
    } finally {
      await testServer.close();
    }
  });

  test('Hidden fixture projects (e.g. test-site) are excluded from Office View', async () => {
    const root = fixture();
    writeTask(root, 'test-site', path.join(root, 'fixtures', 'test-site'), { status: 'building', builderWorker: 'antigravity' });
    const testServer = await startTestServer(root);
    try {
      const res = await fetch(`${testServer.url}/api/office-view`);
      const data = await res.json();
      assert.ok(!data.projects.some(p => p.projectId === 'test-site'), 'hidden fixture projects must not appear in Office View');
    } finally {
      await testServer.close();
    }
  });
});
