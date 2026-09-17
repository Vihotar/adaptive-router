import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPreauthorized,
  requestPermission,
  getPendingPermissions,
  resolvePermission,
  getProjectPermissions,
  saveProjectPermission,
  openNativeApp
} from '../src/permissions.mjs';
import { createTestFixture } from './helpers/fixture-helper.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fixture(t) {
  const tmp = createTestFixture('perm-', { t });
  fs.mkdirSync(path.join(tmp, '.router'), { recursive: true });
  return tmp;
}

test('Permissions: pre-authorizes safe disposable actions within task sandbox', () => {
  assert.equal(isPreauthorized('read_project_baseline'), true);
  assert.equal(isPreauthorized('write_task_deliverables'), true);
  assert.equal(isPreauthorized('run_browser_tests'), true);
  assert.equal(isPreauthorized('delete_database'), false);
  assert.equal(isPreauthorized('deploy_production'), false);
  assert.equal(isPreauthorized('access_outside_files'), false);
});

test('Permissions: requestPermission enqueues pending request and resolves upon user action', async () => {
  const taskId = 'task-test-123';
  let promiseResolved = false;

  const permPromise = requestPermission(taskId, {
    type: 'claude_quota',
    description: 'Authorize Claude Pro quota for enhanced UI layout?',
    worker: 'claude-code',
    action: 'use_claude_quota',
    canRemember: true
  }).then(result => {
    promiseResolved = true;
    return result;
  });

  const pending = getPendingPermissions(taskId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].worker, 'claude-code');
  assert.equal(pending[0].action, 'use_claude_quota');
  assert.equal(promiseResolved, false);

  // Resolve permission
  const ok = resolvePermission(null, pending[0].id, { decision: 'allow_task', remember: false });
  assert.equal(ok, true);

  const result = await permPromise;
  assert.equal(result.decision, 'allow_task');
  assert.equal(promiseResolved, true);

  // Queue should be clear
  const remaining = getPendingPermissions(taskId);
  assert.equal(remaining.length, 0);
});

test('Permissions: remember option persists decision to project permissions file', () => {
  const root = fixture();
  saveProjectPermission(root, 'test-site', 'run_local_build', true);

  const perms = getProjectPermissions(root, 'test-site');
  assert.equal(perms.run_local_build, true);

  assert.equal(isPreauthorized('run_local_build', { root, projectId: 'test-site' }), true);
  assert.equal(isPreauthorized('run_arbitrary_eval', { root, projectId: 'test-site' }), false);
});

test('Permissions: openNativeApp returns application launcher response', () => {
  const claudeResult = openNativeApp('claude');
  assert.ok(typeof claudeResult === 'object');
  assert.ok('success' in claudeResult);

  const agyResult = openNativeApp('antigravity');
  assert.ok(typeof agyResult === 'object');
  assert.ok('success' in agyResult);
});

test('Permissions: handles all 4 standard choices (Yes, Yes for this session, No, Stop the task)', async () => {
  const taskId = 'task-session-test-456';

  // 1. Test "Yes" (single action allow)
  const p1 = requestPermission(taskId, { action: 'run_single_build' });
  let pending = getPendingPermissions(taskId);
  assert.equal(pending.length, 1);
  resolvePermission(null, pending[0].id, { decision: 'yes' });
  const res1 = await p1;
  assert.equal(res1.allowed, true);
  assert.equal(res1.decision, 'allow_once');

  // 2. Test "Yes for this session"
  const p2 = requestPermission(taskId, { action: 'edit_schema_migration' });
  pending = getPendingPermissions(taskId);
  assert.equal(pending.length, 1);
  resolvePermission(null, pending[0].id, { decision: 'yes_session' });
  const res2 = await p2;
  assert.equal(res2.allowed, true);
  assert.equal(res2.decision, 'allow_task');
  // Check that subsequent checks for this task session are pre-authorized
  assert.equal(isPreauthorized('edit_schema_migration', { taskId }), true);
  // Check that another task is not pre-authorized
  assert.equal(isPreauthorized('edit_schema_migration', { taskId: 'other-task-789' }), false);

  // 3. Test "No" (deny with feedback to worker)
  const p3 = requestPermission(taskId, { action: 'install_unapproved_package' });
  pending = getPendingPermissions(taskId);
  assert.equal(pending.length, 1);
  resolvePermission(null, pending[0].id, { decision: 'no' });
  const res3 = await p3;
  assert.equal(res3.allowed, false);
  assert.equal(res3.decision, 'deny');
  assert.equal(res3.feedback, 'Permission denied for this action. Continue without it or propose another safe method.');

  // 4. Test "Stop the task"
  const p4 = requestPermission(taskId, { action: 'format_drive' });
  pending = getPendingPermissions(taskId);
  assert.equal(pending.length, 1);
  resolvePermission(null, pending[0].id, { decision: 'stop_task' });
  const res4 = await p4;
  assert.equal(res4.allowed, false);
  assert.equal(res4.decision, 'stop_task');
  assert.equal(res4.feedback, 'Task stopped by user during permission request.');
});

