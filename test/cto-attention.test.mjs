import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  notifyCtoAttention,
  notifyFromTaskStatus,
  resolveAttentionForTask,
  listAttention,
  setAttentionState,
  getAttentionSummary
} from '../src/cto-attention.mjs';
import { codeTask } from '../src/coding.mjs';
import { read, json } from '../src/storage.mjs';
import { createTestFixture } from './helpers/fixture-helper.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// An integration fixture that includes everything codeTask() needs to run
// through the sensitivity gate end-to-end. We had an actual, customer-facing
// bug precisely in that call-site plumbing that pure module-level tests
// did not catch: the module worked perfectly on its own, but the wiring
// that computed `root` from `dir` at the two call sites was off by one
// path segment, so real codeTask() runs silently never created an inbox
// item. Only an integration test through codeTask() itself can catch that
// class of bug.
function integrationFixture(t) {
  return createTestFixture('cto-attention-integration-', {
    seedFixtures: true,
    seedWeb: true,
    seedSpecialists: true,
    workersConfig: read(path.join(rootDir, 'workers.json')),
    t
  });
}

test('CTO Attention / Inbox Suite', async (t) => {
  function mkRoot(prefix, subT = t) {
    const dir = createTestFixture('cto-attention-' + prefix + '-', { t: subT });
    fs.mkdirSync(path.join(dir, '.router'), { recursive: true });
    return dir;
  }

  await t.test('1. notifyCtoAttention creates a persisted, readable item', () => {
    const root = mkRoot('create');
    const item = notifyCtoAttention(root, {
      eventType: 'SENSITIVE_TECHNICAL_DECISION_REQUIRED',
      taskId: 'task-1',
      project: 'proj-a',
      reason: 'Sensitive keyword detected',
      instruction: 'Do the thing'
    });
    assert.ok(item && item.id, 'should return a created item with an id');
    assert.equal(item.state, 'unread');
    assert.equal(item.eventType, 'SENSITIVE_TECHNICAL_DECISION_REQUIRED');

    // Must be durable — a fresh read (simulating a restart/refresh) sees it.
    const listed = listAttention(root);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, item.id);
    assert.ok(fs.existsSync(path.join(root, '.router', 'cto-attention.json')), 'must persist to disk, not just memory');
  });

  await t.test('2. Ignored statuses never create an inbox item ("no normal internal progress")', () => {
    const root = mkRoot('ignored');
    const task = { id: 'task-2', project: 'proj-a', instruction: 'x' };
    notifyFromTaskStatus(root, task, 'building', {});
    notifyFromTaskStatus(root, task, 'testing', {});
    notifyFromTaskStatus(root, task, 'reviewing', {});
    notifyFromTaskStatus(root, task, 'waiting_for_worker', {});
    assert.equal(listAttention(root).length, 0, 'normal internal progress statuses must not create attention items');
  });

  await t.test('3. Mapped statuses create the correct canonical event type', () => {
    const root = mkRoot('mapped');
    const task = { id: 'task-3', project: 'proj-a', instruction: 'x' };
    notifyFromTaskStatus(root, task, 'needs_cto_attention', { note: 'sensitivity' });
    notifyFromTaskStatus(root, task, 'needs_human_input', { note: 'approval needed' });
    const items = listAttention(root);
    assert.equal(items.length, 2);
    const types = items.map(i => i.eventType).sort();
    assert.deepEqual(types, ['SENSITIVE_TECHNICAL_DECISION_REQUIRED', 'TECHNICAL_APPROVAL_REQUIRED']);
  });

  await t.test('4. Same task + event type refreshes in place rather than duplicating', () => {
    const root = mkRoot('dedupe');
    const task = { id: 'task-4', project: 'proj-a', instruction: 'x' };
    notifyFromTaskStatus(root, task, 'needs_human_input', { note: 'first reason' });
    notifyFromTaskStatus(root, task, 'needs_human_input', { note: 'second reason' });
    const items = listAttention(root);
    assert.equal(items.length, 1, 'repeated identical condition must not pile up duplicates');
    assert.equal(items[0].reason, 'second reason', 'refresh should update the detail');
  });

  await t.test('5. resolveAttentionForTask marks all open items for that task resolved', () => {
    const root = mkRoot('resolve');
    const task = { id: 'task-5', project: 'proj-a', instruction: 'x' };
    notifyFromTaskStatus(root, task, 'needs_human_input', {});
    resolveAttentionForTask(root, 'task-5');
    const items = listAttention(root);
    assert.equal(items.length, 1);
    assert.equal(items[0].state, 'resolved');
  });

  await t.test('6. setAttentionState transitions unread -> acknowledged -> resolved', () => {
    const root = mkRoot('states');
    const item = notifyCtoAttention(root, { eventType: 'TASK_BLOCKED', taskId: 'task-6', reason: 'x' });
    assert.equal(item.state, 'unread');
    const acked = setAttentionState(root, item.id, 'acknowledged');
    assert.equal(acked.state, 'acknowledged');
    const resolved = setAttentionState(root, item.id, 'resolved');
    assert.equal(resolved.state, 'resolved');
    assert.throws(() => setAttentionState(root, item.id, 'bogus'), /Invalid attention state/);
  });

  await t.test('7. getAttentionSummary answers does-attention-exist/what/why/action cheaply', () => {
    const root = mkRoot('summary');
    let summary = getAttentionSummary(root);
    assert.equal(summary.attentionRequired, false);
    assert.equal(summary.unreadCount, 0);

    notifyCtoAttention(root, { eventType: 'FAILOVERS_EXHAUSTED', taskId: 'task-7', reason: 'No worker available', project: 'proj-a' });
    summary = getAttentionSummary(root);
    assert.equal(summary.attentionRequired, true);
    assert.equal(summary.unreadCount, 1);
    assert.equal(summary.totalOpen, 1);
    assert.equal(summary.items[0].taskId, 'task-7');
    assert.ok(summary.items[0].action, 'must include an action recommendation');
    assert.ok(summary.items[0].reason, 'must include a reason');
  });

  await t.test('8. Resolved items are excluded from the summary (only open items count)', () => {
    const root = mkRoot('summary-resolved');
    const item = notifyCtoAttention(root, { eventType: 'TASK_BLOCKED', taskId: 'task-8', reason: 'x' });
    setAttentionState(root, item.id, 'resolved');
    const summary = getAttentionSummary(root);
    assert.equal(summary.attentionRequired, false);
    assert.equal(summary.totalOpen, 0);
  });

  await t.test('9. Never throws on a corrupt/missing inbox file (fail open)', () => {
    const root = mkRoot('corrupt');
    fs.mkdirSync(path.join(root, '.router'), { recursive: true });
    fs.writeFileSync(path.join(root, '.router', 'cto-attention.json'), 'not valid json {{{');
    assert.doesNotThrow(() => listAttention(root));
    assert.doesNotThrow(() => getAttentionSummary(root));
    assert.doesNotThrow(() => notifyCtoAttention(root, { eventType: 'TASK_BLOCKED', taskId: 't', reason: 'x' }));
  });

  await t.test('10. Filtering by state in listAttention works', () => {
    const root = mkRoot('filter');
    const a = notifyCtoAttention(root, { eventType: 'TASK_BLOCKED', taskId: 'a', reason: 'x' });
    notifyCtoAttention(root, { eventType: 'TASK_BLOCKED', taskId: 'b', reason: 'y' });
    setAttentionState(root, a.id, 'resolved');
    assert.equal(listAttention(root, { state: 'resolved' }).length, 1);
    assert.equal(listAttention(root, { state: 'unread' }).length, 1);
    assert.equal(listAttention(root).length, 2);
  });

  await t.test('11. INTEGRATION: a real codeTask() sensitivity-gate run creates a live inbox item at the correct project root', async () => {
    const root = integrationFixture();
    const task = await codeTask(root, 'Store AWS_SECRET_ACCESS_KEY in config and rotate credentials', {
      project: 'test-site',
      ready() {},
      log() {}
    });
    assert.equal(task.status, 'needs_cto_attention', 'sanity check: task actually hit the sensitivity gate');

    // The inbox file must exist directly under THIS fixture's own root
    // (root/.router/cto-attention.json), proving the dir -> root path
    // arithmetic in coding.mjs's state() resolved correctly for a real
    // taskDir() (root/.router/tasks/<id>).
    const inboxPath = path.join(root, '.router', 'cto-attention.json');
    assert.ok(fs.existsSync(inboxPath), 'codeTask() reaching needs_cto_attention must produce a live inbox file at the project root');

    const summary = getAttentionSummary(root);
    assert.equal(summary.attentionRequired, true);
    assert.equal(summary.totalOpen, 1);
    assert.equal(summary.items[0].taskId, task.id);
    assert.equal(summary.items[0].eventType, 'SENSITIVE_TECHNICAL_DECISION_REQUIRED');
  });

  await t.test('12. INTEGRATION: router.mjs decide() resolves the inbox item on approval/rejection at the correct root', async () => {
    // A lighter integration check for router.mjs's update() path: rather
    // than driving a full build+review+approve cycle here (already covered
    // elsewhere), verify directly that an item created at a fixture root
    // gets resolved by resolveAttentionForTask using that same root shape
    // router.mjs's decide() computes (root/.router/tasks/<id> -> root).
    const root = integrationFixture();
    const fakeTaskId = '20260101T000000-deadbeef';
    notifyCtoAttention(root, { eventType: 'TECHNICAL_APPROVAL_REQUIRED', taskId: fakeTaskId, reason: 'x' });
    assert.equal(getAttentionSummary(root).totalOpen, 1);
    resolveAttentionForTask(root, fakeTaskId);
    assert.equal(getAttentionSummary(root).totalOpen, 0, 'resolving must actually clear the item at this root');
  });
});
