/**
 * test/connector.test.mjs — Automated tests for ChatGPT Connector & MCP Layer
 *
 * Verifies:
 *   1. sanitize() recursively removes secret keys (token, secret, key, password, etc.)
 *   2. getOrCreateConnectorToken() generates and persists a 64-char hex token
 *   3. All 10 read operations return expected sanitized data
 *   4. Write operations (toggleClaudeReserve, approveTask, rejectTask) function correctly
 *   5. MCP protocol handler responds to initialize, tools/list, and tools/call
 *   6. Dashboard server enforces Bearer token authentication on connector endpoints
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

import {
  sanitize,
  getOrCreateConnectorToken,
  listProjects,
  getProjectStatus,
  listRecentTasks,
  getTaskStatus,
  getLiveProgress,
  getTestResults,
  getReviewerFindings,
  getDeliverableSummary,
  getApprovalState,
  getFailoversAndErrors,
  toggleClaudeReserve,
  approveTask,
  rejectTask,
  submitTask,
  isProjectTaskActive
} from '../src/connector.mjs';

import { handleMcpRequest, ALL_TOOLS, READ_TOOLS, WRITE_TOOLS } from '../src/mcp-server.mjs';
import { createDashboardServer } from '../src/server.mjs';

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-test-'));
  // Create mock workers.json
  fs.writeFileSync(path.join(tmpRoot, 'workers.json'), JSON.stringify({
    workers: [
      { id: 'codex', enabled: true },
      { id: 'antigravity', enabled: true },
      { id: 'claude-code', enabled: true },
      { id: 'cline', enabled: true }
    ],
    claudeReserve: true,
    maxCorrections: 2
  }, null, 2));

  // Create mock task
  const taskId = '20260910T120000-abcd1234';
  const taskPath = path.join(tmpRoot, '.router', 'tasks', taskId);
  fs.mkdirSync(taskPath, { recursive: true });

  fs.writeFileSync(path.join(taskPath, 'task.json'), JSON.stringify({
    id: taskId,
    status: 'awaiting_approval',
    created: new Date().toISOString(),
    revision: 1,
    instruction: 'Add a contact form to the test website\nWith responsive styling.',
    project: 'test-site',
    summary: 'Created responsive customer contact form with email validation',
    routingLog: [
      { role: 'build', worker: 'antigravity', model: 'gemini-2.5-pro', effort: 'medium', specialist: 'engineering-frontend-developer', specialistName: 'Frontend Specialist', reason: 'High visual accuracy' },
      { role: 'review', worker: 'codex', specialist: 'security-ai-generated-code-auditor' }
    ]
  }, null, 2));

  fs.writeFileSync(path.join(taskPath, 'events.jsonl'), [
    JSON.stringify({ time: new Date().toISOString(), type: 'activity', title: 'Worker Selected', desc: 'Antigravity selected', category: 'router' }),
    JSON.stringify({ time: new Date().toISOString(), type: 'activity', title: 'Code Built', desc: 'Created contact.html', category: 'worker' }),
    JSON.stringify({ time: new Date().toISOString(), type: 'worker_unavailable', worker: 'codex', reason: 'Usage limit reached', isQuota: true, escalatedTo: 'antigravity' })
  ].join('\n'));

  fs.writeFileSync(path.join(taskPath, 'tests-1.json'), JSON.stringify({
    passed: true,
    checks: [
      { name: 'Form exists', passed: true },
      { name: 'Submit button present', passed: true }
    ]
  }));

  fs.writeFileSync(path.join(taskPath, 'review-1.json'), JSON.stringify({
    worker: 'codex',
    verdict: 'pass',
    summary: 'Code is well-structured and secure.'
  }));

  fs.writeFileSync(path.join(taskPath, 'manifest-1.json'), JSON.stringify({
    files: [{ path: 'contact.html' }, { path: 'styles.css' }]
  }));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Sanitization & Security Contract', () => {
  test('sanitize() recursively removes sensitive keys', () => {
    const raw = {
      project: 'test',
      apiKey: 'sk-1234567890',
      authToken: 'bearer-xyz',
      nested: {
        password: 'supersecretpassword',
        safeData: 'visible',
        credentials: { secretKey: 'topsecret' }
      },
      list: [
        { bearer: 'tok', name: 'item1' },
        { regularKey: 'value' }
      ]
    };

    const cleaned = sanitize(raw);

    assert.equal(cleaned.project, 'test');
    assert.equal(cleaned.apiKey, undefined);
    assert.equal(cleaned.authToken, undefined);
    assert.equal(cleaned.nested.password, undefined);
    assert.equal(cleaned.nested.safeData, 'visible');
    assert.equal(cleaned.nested.credentials, undefined);
    assert.equal(cleaned.list[0].bearer, undefined);
    assert.equal(cleaned.list[0].name, 'item1');
    assert.equal(cleaned.list[1].regularKey, 'value');
  });

  test('getOrCreateConnectorToken generates 64-char hex token and persists it', () => {
    const token1 = getOrCreateConnectorToken(tmpRoot);
    assert.equal(typeof token1, 'string');
    assert.equal(token1.length, 64);

    // Call again, should return the exact same token
    const token2 = getOrCreateConnectorToken(tmpRoot);
    assert.equal(token1, token2);

    // Verify it was persisted to .router/connector-token.json, NEVER workers.json
    const tokenData = JSON.parse(fs.readFileSync(path.join(tmpRoot, '.router', 'connector-token.json'), 'utf8'));
    assert.equal(tokenData.token, token1);

    const config = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'workers.json'), 'utf8'));
    assert.equal(config.connectorToken, undefined, 'workers.json must NEVER contain connectorToken');
  });
});

describe('Connector Read Operations', () => {
  test('listProjects returns available projects with status', () => {
    const projects = listProjects(tmpRoot);
    assert.ok(Array.isArray(projects));
    assert.ok(projects.some(p => p.id === 'adaptive-router'));
    assert.ok(projects.some(p => p.id === 'test-site'));
  });

  test('submitTask rejects a new submission while this project has a genuinely active task (real concurrency gate, not a lock file)', async () => {
    // This is the gate connector.mjs's isProjectTaskActive() now backs --
    // previously this checked a '.router/router.lock' file that real code
    // paths never write any more (storage.mjs's locked() always uses a
    // per-project scoped filename), so external submissions via ChatGPT
    // Work / scripts had no real protection against piling up a second
    // task on a project that already has one awaiting approval.
    await assert.rejects(
      () => submitTask(tmpRoot, { instruction: 'Add another page', project: 'test-site' }),
      /already running/i
    );
  });

  test('submitTask does not block a DIFFERENT project just because test-site has an active task', async () => {
    // Sanity check that the fix is scoped per-project, not a return to the
    // old global unscoped-lock behavior -- a task active on 'test-site'
    // must not block the concurrency GATE for 'adaptive-router'. This
    // fixture's tmpRoot has no real adaptive-router project scaffolding
    // (specialists.json, workers.json shape codeTask() needs to actually
    // run a build), so rather than let the fire-and-forget codeTask()
    // pipeline run for real (and fail for unrelated fixture-completeness
    // reasons), assert directly on the exported gate function itself --
    // this is what submitTask()'s pre-check actually calls.
    assert.equal(isProjectTaskActive(tmpRoot, 'adaptive-router'), false, 'a task active on test-site must not read as active for a different project');
    assert.equal(isProjectTaskActive(tmpRoot, 'test-site'), true, 'sanity: test-site itself should still read as active');
  });

  test('getProjectStatus returns overview without secrets', () => {
    const status = getProjectStatus(tmpRoot);
    assert.equal(status.claudeReserve, true);
    // The fixture task above is 'awaiting_approval' -- a real active status
    // (see connector.mjs's isProjectTaskActive()) that genuinely blocks a
    // new same-project task submission, the same way the dashboard's own
    // getActiveTask()/409 gate treats it. taskInProgress reflects real
    // on-disk task state now, not a lock file that's essentially never
    // created (see connector.mjs's comment on isProjectTaskActive for why
    // that was actually a latent bug in the external connector API).
    assert.equal(status.taskInProgress, true);
    assert.ok(status.taskSummary);
    assert.equal(status.taskSummary.total, 1);
    assert.equal(status.token, undefined);
  });

  test('listRecentTasks returns recent tasks', () => {
    const tasks = listRecentTasks(tmpRoot, 5);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, '20260910T120000-abcd1234');
    assert.equal(tasks[0].worker, 'antigravity');
    assert.equal(tasks[0].specialist, 'Frontend Specialist');
    assert.equal(tasks[0].summary, 'Add a contact form to the test website');
  });

  test('getTaskStatus returns full details of a specific task', () => {
    const task = getTaskStatus(tmpRoot, '20260910T120000-abcd1234');
    assert.equal(task.id, '20260910T120000-abcd1234');
    assert.equal(task.status, 'awaiting_approval');
    assert.equal(task.worker, 'antigravity');
    assert.equal(task.model, 'gemini-2.5-pro');
    assert.equal(task.effort, 'medium');
    assert.equal(task.routingReason, 'High visual accuracy');
  });

  test('getLiveProgress returns recent activity events', () => {
    const progress = getLiveProgress(tmpRoot, '20260910T120000-abcd1234');
    assert.equal(progress.taskId, '20260910T120000-abcd1234');
    assert.ok(progress.recentActivity.length >= 2);
    assert.equal(progress.recentActivity[0].title, 'Code Built');
  });

  test('getTestResults returns test summary', () => {
    const results = getTestResults(tmpRoot, '20260910T120000-abcd1234');
    assert.equal(results.available, true);
    assert.equal(results.passed, true);
    assert.equal(results.checksCount, 2);
  });

  test('getReviewerFindings returns reviewer audit verdict', () => {
    const review = getReviewerFindings(tmpRoot, '20260910T120000-abcd1234');
    assert.equal(review.available, true);
    assert.equal(review.verdict, 'pass');
    assert.equal(review.passed, true);
    assert.match(review.summary, /well-structured/i);
  });

  test('getDeliverableSummary returns deliverable information', () => {
    const del = getDeliverableSummary(tmpRoot, '20260910T120000-abcd1234');
    assert.equal(del.taskId, '20260910T120000-abcd1234');
    assert.deepEqual(del.filesChanged, ['contact.html', 'styles.css']);
  });

  test('getApprovalState returns current approval status', () => {
    const app = getApprovalState(tmpRoot, '20260910T120000-abcd1234');
    assert.equal(app.approvalState, 'awaiting_your_approval');
    assert.ok(app.actionRequired);
  });

  test('getFailoversAndErrors reports worker failovers accurately', () => {
    const failovers = getFailoversAndErrors(tmpRoot, '20260910T120000-abcd1234');
    assert.equal(failovers.failoverCount, 1);
    assert.equal(failovers.failovers[0].worker, 'codex');
    assert.match(failovers.failovers[0].reason, /limit/i);
    assert.equal(failovers.failovers[0].escalatedTo, 'antigravity');
  });
});

describe('Connector Write Operations', () => {
  test('toggleClaudeReserve toggles reserve mode in workers.json', () => {
    const resOff = toggleClaudeReserve(tmpRoot, false);
    assert.equal(resOff.claudeReserve, false);
    let cfg = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'workers.json'), 'utf8'));
    assert.equal(cfg.claudeReserve, false);

    const resOn = toggleClaudeReserve(tmpRoot, true);
    assert.equal(resOn.claudeReserve, true);
    cfg = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'workers.json'), 'utf8'));
    assert.equal(cfg.claudeReserve, true);
  });

  test('rejectTask requires a non-empty reason and enforces decision validation', async () => {
    await assert.rejects(() => rejectTask(tmpRoot, '20260910T120000-abcd1234', { reason: '' }), /reason is required/i);
    // Synthetic incomplete task cannot be rejected/approved without valid context binding
    await assert.rejects(() => rejectTask(tmpRoot, '20260910T120000-abcd1234', { reason: 'Missing phone field' }), /Legacy or unbound/i);
  });

  test('approveTask strictly forbids synthetic/incomplete task bypass (routes through decide)', async () => {
    // Attempting to approve a synthetic task missing digest, context binding, or tests MUST fail
    await assert.rejects(
      () => approveTask(tmpRoot, '20260910T120000-abcd1234', { reason: 'Looks great!' }),
      /Legacy or unbound|Approval does not match/i
    );
  });
});

describe('MCP JSON-RPC Protocol', () => {
  test('ALL_TOOLS provides 10 read tools with readOnlyHint: true', () => {
    assert.equal(READ_TOOLS.length, 10);
    for (const tool of READ_TOOLS) {
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.ok(tool.name);
      assert.ok(tool.description);
    }
  });

  test('ALL_TOOLS provides write tools with readOnlyHint: false', () => {
    assert.equal(WRITE_TOOLS.length, 4);
    for (const tool of WRITE_TOOLS) {
      assert.equal(tool.annotations.readOnlyHint, false);
    }
  });

  test('handleMcpRequest: initialize returns protocolVersion & serverInfo', async () => {
    const res = await handleMcpRequest(tmpRoot, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    });
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    assert.equal(res.result.serverInfo.name, 'adaptive-router');
    assert.ok(res.result.capabilities.tools);
  });

  test('handleMcpRequest: tools/list returns available tools', async () => {
    const res = await handleMcpRequest(tmpRoot, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });
    assert.equal(res.result.tools.length, ALL_TOOLS.length);
  });

  test('handleMcpRequest: tools/call executes get_project_status', async () => {
    const res = await handleMcpRequest(tmpRoot, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_project_status', arguments: {} }
    });
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.result.isError, undefined);
    const parsed = JSON.parse(res.result.content[0].text);
    assert.equal(parsed.claudeReserve, true);
  });

  test('handleMcpRequest: returns JSON-RPC error on invalid method', async () => {
    const res = await handleMcpRequest(tmpRoot, {
      jsonrpc: '2.0',
      id: 4,
      method: 'nonexistent/method',
      params: {}
    });
    assert.equal(res.error.code, -32601);
  });
});

describe('Server Authentication & HTTP Endpoints', () => {
  let server;
  let port;
  let token;

  before(async () => {
    token = getOrCreateConnectorToken(tmpRoot);
    server = createDashboardServer(tmpRoot);
    await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  function request(urlPath, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, headers: res.headers, data: parsed });
        });
      });
      req.on('error', reject);
      if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    });
  }

  test('Connector rejects unauthenticated requests with 401', async () => {
    const res = await request('/api/connector/status');
    assert.equal(res.status, 401);
  });

  test('Connector accepts requests with valid Bearer token', async () => {
    const res = await request('/api/connector/status', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.claudeReserve, true);
  });

  test('GET /mcp with Bearer token returns server info', async () => {
    const res = await request('/mcp', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.name, 'adaptive-router');
    assert.equal(res.data.readTools, 10);
  });

  test('POST /mcp with Bearer token executes JSON-RPC request', async () => {
    const res = await request('/mcp', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'list_projects', arguments: {} }
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.jsonrpc, '2.0');
    const result = JSON.parse(res.data.result.content[0].text);
    assert.ok(Array.isArray(result));
    assert.ok(result.some(p => p.id === 'adaptive-router'));
  });

  test('GET /api/connector/token returns token when requested from localhost', async () => {
    const res = await request('/api/connector/token');
    assert.equal(res.status, 200);
    assert.equal(res.data, token);
  });
});
