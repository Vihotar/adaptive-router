import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deriveTaskTitle, taskDisplayTitle, normalizeTaskTitle, MAX_TASK_TITLE_LENGTH } from '../src/web/task-title.mjs';
import { listRecentTasks, getTaskDetails } from '../src/server.mjs';

// Post-Release Fix C — human-readable task titles.
//
// The bug: production used the full raw task instruction as the Task
// Name / ID display value, so a multi-paragraph engineering brief became a
// table cell, a dropdown option and a card header. The fix adds a short
// display title WITHOUT touching the canonical instruction.

test('deriveTaskTitle: shortens a long engineering brief to a scannable label', () => {
  const instruction = [
    'Create a file named office-view-verify.md at C:\\projects\\adaptive-router\\office-view-verify.md',
    '',
    'The file must contain a complete engineering brief covering every seat,',
    'every pod and every project card in the Office View.'
  ].join('\n');
  const title = deriveTaskTitle(instruction);
  assert.ok(title.length <= MAX_TASK_TITLE_LENGTH + 1, `title too long: ${title}`);
  assert.ok(!title.includes('\n'), 'title must be single-line');
  assert.ok(title.startsWith('Create a file named office-view-verify'));
});

test('deriveTaskTitle: strips markdown headings, bullets and preambles', () => {
  assert.equal(deriveTaskTitle('# Task: Add Unified Planning Chat\n\nLong multiline prompt...'), 'Add Unified Planning Chat');
  assert.equal(deriveTaskTitle('- **fix** the reviewer gate'), 'Fix the reviewer gate');
  assert.equal(deriveTaskTitle('please update the README.'), 'Update the README');
});

test('deriveTaskTitle: returns empty string for empty/whitespace input', () => {
  assert.equal(deriveTaskTitle(''), '');
  assert.equal(deriveTaskTitle('   \n  \n'), '');
  assert.equal(deriveTaskTitle(undefined), '');
  assert.equal(deriveTaskTitle(null), '');
});

test('deriveTaskTitle: leaves an already-short instruction untouched apart from capitalisation', () => {
  assert.equal(deriveTaskTitle('Add date helpers to utils.js'), 'Add date helpers to utils.js');
});

test('taskDisplayTitle: prefers an explicit title, then derivation, then the id', () => {
  assert.equal(taskDisplayTitle({ title: '  Wire Up Office View  ', instruction: 'something long' }), 'Wire Up Office View');
  assert.equal(taskDisplayTitle({ instruction: 'Refactor the router' }), 'Refactor the router');
  assert.equal(taskDisplayTitle({ id: '20260101T000000-deadbeef' }), '20260101T000000-deadbeef');
  assert.equal(taskDisplayTitle(null), '');
});

test('normalizeTaskTitle: caps a submitted title and rejects blanks', () => {
  assert.equal(normalizeTaskTitle('   '), '');
  assert.equal(normalizeTaskTitle('My Task'), 'My Task');
  const long = 'x'.repeat(200);
  assert.ok(normalizeTaskTitle(long).length <= MAX_TASK_TITLE_LENGTH + 1);
});

function seedTask(root, id, task) {
  const dir = path.join(root, '.router', 'tasks', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ id, ...task }, null, 2));
  return dir;
}

test('listRecentTasks: adds a short title and preserves the full raw instruction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-title-'));
  const longInstruction = 'Create a file named office-view-verify.md at C:\\projects\\adaptive-router containing a full engineering brief.\n\nSecond paragraph with a lot more detail that must never appear in a table cell.';
  // A historical task: recorded before the title field existed.
  seedTask(root, '20260101T000000-aaaaaaaa', {
    project: 'test-site',
    status: 'completed',
    created: '2026-01-01T00:00:00.000Z',
    completionTime: '2026-01-01T00:01:00.000Z',
    instruction: longInstruction
  });
  // A new task carrying an explicit title.
  seedTask(root, '20260102T000000-bbbbbbbb', {
    project: 'test-site',
    status: 'completed',
    created: '2026-01-02T00:00:00.000Z',
    completionTime: '2026-01-02T00:01:00.000Z',
    instruction: longInstruction,
    title: 'Office View Verification File'
  });

  const tasks = listRecentTasks(root, 'test-site');
  const historical = tasks.find(t => t.id === '20260101T000000-aaaaaaaa');
  const titled = tasks.find(t => t.id === '20260102T000000-bbbbbbbb');

  assert.ok(historical, 'historical task must still be listed');
  assert.ok(historical.title && historical.title.length <= MAX_TASK_TITLE_LENGTH + 1, 'historical task gets a derived fallback title');
  assert.ok(!historical.title.includes('\n'));
  assert.equal(historical.instruction, longInstruction, 'raw instruction is preserved verbatim');

  assert.equal(titled.title, 'Office View Verification File');
  assert.equal(titled.instruction, longInstruction, 'an explicit title never replaces the instruction');

  fs.rmSync(root, { recursive: true, force: true });
});

test('getTaskDetails: exposes the title and the untouched instruction together', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-title-detail-'));
  const longInstruction = '# Rebuild the Task Progress selector\n\nFull brief follows across several paragraphs, and the canonical prompt must survive intact.';
  seedTask(root, '20260103T000000-cccccccc', {
    project: 'test-site',
    status: 'completed',
    created: '2026-01-03T00:00:00.000Z',
    instruction: longInstruction,
    revision: 1
  });
  const detail = getTaskDetails(root, '20260103T000000-cccccccc');
  assert.equal(detail.title, 'Rebuild the Task Progress selector');
  assert.equal(detail.instruction, longInstruction);
  fs.rmSync(root, { recursive: true, force: true });
});

test('production dashboard never renders a fabricated usage figure', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'src', 'web', 'index.html'), 'utf8');
  // Comments explaining the fix are fine; rendered markup is not.
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/Usage data unavailable/.test(withoutComments), 'platform cards must not show "Usage data unavailable"');
  assert.ok(!/usage-fill fill-(blue|purple|green|muted)"\s+style="width: 0%/.test(withoutComments), 'platform cards must not show a permanently empty usage bar');
  assert.ok(withoutComments.includes('conn-limit-cline'), 'platform cards show a real connection signal');
  assert.ok(withoutComments.includes('health-limit-cline'), 'platform cards show a real reliability signal');
});

test('prototype reference page remains available and untouched by this fix', () => {
  const protoPath = path.join(process.cwd(), 'src', 'web', 'prototype.html');
  assert.ok(fs.existsSync(protoPath), 'prototype.html must still exist');
  const proto = fs.readFileSync(protoPath, 'utf8');
  assert.ok(proto.includes('prototype-legacy.css'), 'prototype keeps its own isolated stylesheet');
});
