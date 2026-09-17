import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTask, decide, taskDir } from '../src/router.mjs';
import { read, safePath, validateFiles, locked } from '../src/storage.mjs';
import { choose, runProcess } from '../src/workers.mjs';
import { reviewSchema, validate } from '../src/contracts.mjs';
import { createTestFixture, testBaseDir } from './helpers/fixture-helper.mjs';

const base = testBaseDir;
const config = {
  workers: [
    { id: 'codex', enabled: true, roles: ['plan', 'build', 'review'], priority: 10, adapter: 'codex' },
    { id: 'antigravity', enabled: true, roles: ['review', 'build'], priority: 30, adapter: 'antigravity' },
    { id: 'claude-code', enabled: false, roles: ['build', 'review'], priority: 20, adapter: 'claude' },
    { id: 'cline', enabled: true, roles: ['build'], priority: 35, adapter: 'cline' }
  ],
  maxCorrections: 2,
  workerTimeoutSeconds: 600,
  claudeReserve: true,
  connectorToken: 'CONNECTOR_TOKEN_REGENERATED_ON_FIRST_RUN'
};
const plan = { goal: 'Dummy quote', jobs: ['Write quote'], questions: [], approvalActions: [] };
const draft = { summary: 'Dummy', files: [{ path: 'quote.json', content: '{"total":44}' }] };
const pass = { verdict: 'pass', summary: 'Correct', issues: [] };
function fixture(replies, t) {
  const root = createTestFixture('case-', { workersConfig: config, t });
  const calls = [];
  return { root, calls, options: { available: { codex: 'fake', antigravity: 'fake' }, preflight() {}, log() {}, invokeWorker: async (worker, request) => {
    calls.push({ worker: worker.id, prompt: request.prompt });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return structuredClone(reply);
  } } };
}
test('legacy unbound workflow cannot be approved even after build/review completes', async () => {
  const f = fixture([plan, draft, { verdict: 'changes_requested', summary: 'Fix it', issues: ['Change total to 44'] }, draft, pass]);
  const t = await createTask(f.root, 'Make a dummy quote.', f.options);
  assert.equal(t.status, 'awaiting_approval');
  assert.equal(t.revision, 2);
  assert.deepEqual(f.calls.map(c => c.worker), ['codex', 'codex', 'antigravity', 'codex', 'antigravity']);
  assert.match(f.calls[3].prompt, /Change total to 44/);
  assert.ok(!fs.existsSync(path.join(taskDir(f.root, t.id), 'approval.json')));
  await assert.rejects(decide(f.root, t.id, 'approved'), /Legacy or unbound task context/);
});
test('failed reviewer cannot become approved', async () => {
  const f = fixture([plan, draft, Error('quota exhausted')]);
  const t = await createTask(f.root, 'Make a quote.', f.options);
  assert.equal(t.status, 'failed');
  assert.match(t.error, /quota/);
  await assert.rejects(decide(f.root, t.id, 'approved'));
});
test('unclear and consequential instructions stop before building', async () => {
  for (const [p, status] of [[{ ...plan, questions: ['Who is the audience?'] }, 'needs_clarification'], [{ ...plan, approvalActions: ['Deploy to production'] }, 'needs_action_approval']]) {
    const f = fixture([p]);
    const t = await createTask(f.root, 'Instruction', f.options);
    assert.equal(t.status, status);
    assert.equal(f.calls.length, 1);
    await assert.rejects(decide(f.root, t.id, 'approved'));
  }
});
test('corrections stop at configured limit', async () => {
  const change = { verdict: 'changes_requested', summary: 'Wrong', issues: ['Fix'] };
  const f = fixture([plan, draft, change, draft, change, draft, change]);
  const t = await createTask(f.root, 'Make a quote.', f.options);
  assert.equal(t.status, 'needs_human_input');
  assert.equal(t.revision, 3);
  assert.equal(f.calls.length, 7);
});
test('legacy edited or extra files remain unapprovable without exact task binding', async () => {
  for (const name of ['quote.json', 'extra.txt']) {
    const f = fixture([plan, draft, pass]);
    const t = await createTask(f.root, 'Make a quote.', f.options);
    fs.writeFileSync(path.join(taskDir(f.root, t.id), 'deliverables-1', name), 'tampered');
    await assert.rejects(decide(f.root, t.id, 'approved'), /Legacy or unbound task context/);
  }
});
test('dangerous Windows paths and collisions are rejected', () => {
  for (const name of ['../x.md', '/x.md', 'C:/x.md', 'x\\a.md', 'con.txt', 'aux.json', '.env', 'x.ps1', 'x.cmd', 'a/../../x.txt', 'a.txt:stream']) assert.throws(() => safePath(name), name);
  assert.equal(safePath('draft/quote.json'), 'draft/quote.json');
  assert.throws(() => validateFiles([{ path: 'A.md', content: '' }, { path: 'a.md', content: '' }]));
});
test('disabled or unavailable workers never get selected, review is independent', () => {
  assert.equal(choose(config, 'build', { codex: 'yes' }).id, 'codex');
  assert.throws(() => choose(config, 'review', { codex: 'yes' }, 'codex'));
  assert.throws(() => choose(config, 'build', { 'claude-code': 'yes' }));
  assert.throws(() => choose(config, 'review', { antigravity: 'yes' }, 'antigravity'));
});
test('malformed and contradictory review cannot pass', async () => {
  assert.throws(() => validate({ verdict: 'pass' }, reviewSchema));
  const f = fixture([plan, draft, { ...pass, issues: ['Broken'] }]);
  const t = await createTask(f.root, 'Make a quote.', f.options);
  assert.equal(t.status, 'failed');
});
test('lock prevents simultaneous writers', async () => {
  const f = fixture([]);
  await locked(path.join(f.root, '.router'), async () => {
    await assert.rejects(locked(path.join(f.root, '.router'), () => {}), /Another router/);
  });
});
test('worker failure and timeout are bounded', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(2)'], { cwd: base, input: '', timeout: 5000 }), /exit 2/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: base, input: '', timeout: 200 }), /timed out/);
});
test('reviewer hook denies action tools and unknown workspace scope', (t) => {
  const workspace = createTestFixture('gate-', { t });
  const gateScript = path.resolve('src/reviewer-gate.mjs');
  const runGate = payload => {
    const result = spawnSync(process.execPath, [gateScript], { input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  for (const name of ['write_to_file', 'run_command', 'call_mcp_tool', 'browser_input', 'generate_image', 'invoke_subagent', 'schedule']) {
    assert.equal(runGate({ workspacePaths: [workspace], toolCall: { name, args: {} } }).decision, 'deny');
  }
  assert.equal(runGate({ workspacePaths: [], toolCall: { name: 'write_to_file' } }).decision, 'deny');
  assert.equal(runGate({ workspacePaths: [path.resolve('.')], toolCall: { name: 'write_to_file' } }).decision, 'deny');
  runGate({ workspacePaths: [workspace], invocationNum: 0 });
  assert.match(fs.readFileSync(path.join(workspace, 'reviewer-gate.jsonl'), 'utf8'), /"type":"active"/);
});
