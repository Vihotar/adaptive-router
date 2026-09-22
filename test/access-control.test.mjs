import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDashboardServer } from '../src/server.mjs';
import { getOrCreateConnectorToken } from '../src/connector.mjs';

function setupTempRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-access-test-'));
  fs.mkdirSync(path.join(tmp, '.router', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.router', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'workers.json'), JSON.stringify({
    claudeReserve: true,
    reviewPolicy: 'independent',
    workers: [
      { id: 'codex', enabled: true },
      { id: 'claude-code', enabled: true },
      { id: 'antigravity', enabled: true },
      { id: 'cline', enabled: false }
    ]
  }, null, 2));
  fs.writeFileSync(path.join(tmp, '.router', 'projects', 'default.json'), JSON.stringify({
    id: 'default',
    name: 'Default',
    path: tmp,
    created: new Date().toISOString()
  }, null, 2));
  return tmp;
}

function request(server, options, body = null) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({
      port,
      host: '127.0.0.1',
      ...options
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data,
          json
        });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

test('Access Control: /api/connector/token rejects untrusted origin and foreign referer', async () => {
  const root = setupTempRoot();
  const server = createDashboardServer(root, { port: 0 });
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    // 1. Untrusted origin
    const res1 = await request(server, {
      path: '/api/connector/token',
      method: 'GET',
      headers: {
        Host: '127.0.0.1',
        Origin: 'http://evil.com'
      }
    });
    assert.strictEqual(res1.status, 403);
    assert.strictEqual(res1.headers['access-control-allow-origin'], undefined);

    // 2. Untrusted referer
    const res2 = await request(server, {
      path: '/api/connector/token',
      method: 'GET',
      headers: {
        Host: '127.0.0.1',
        Referer: 'http://malicious-site.org/phishing'
      }
    });
    assert.strictEqual(res2.status, 403);

    // 3. DNS rebinding host
    const res3 = await request(server, {
      path: '/api/connector/token',
      method: 'GET',
      headers: {
        Host: 'attacker-controlled-domain.com'
      }
    });
    assert.strictEqual(res3.status, 403);

    // 4. Legitimate loopback request
    const res4 = await request(server, {
      path: '/api/connector/token',
      method: 'GET',
      headers: {
        Host: '127.0.0.1',
        Origin: 'http://localhost:3210'
      }
    });
    assert.strictEqual(res4.status, 200);
    assert.strictEqual(res4.headers['access-control-allow-origin'], 'http://localhost:3210');
    assert.strictEqual(res4.data.length, 64);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Access Control: dashboard mutation endpoints reject untrusted origin with 403', async () => {
  const root = setupTempRoot();
  const server = createDashboardServer(root, { port: 0 });
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    // POST /api/review-policy from untrusted origin
    const resPolicy = await request(server, {
      path: '/api/review-policy',
      method: 'POST',
      headers: {
        Host: '127.0.0.1',
        Origin: 'http://evil.com',
        'Content-Type': 'application/json'
      }
    }, { policy: 'disabled' });
    assert.strictEqual(resPolicy.status, 403);

    // POST /api/workers/toggle from untrusted origin
    const resToggle = await request(server, {
      path: '/api/workers/toggle',
      method: 'POST',
      headers: {
        Host: '127.0.0.1',
        Origin: 'http://evil.com',
        'Content-Type': 'application/json'
      }
    }, { workerId: 'cline', enabled: true });
    assert.strictEqual(resToggle.status, 403);

    // POST /api/claude-reserve from untrusted origin
    const resReserve = await request(server, {
      path: '/api/claude-reserve',
      method: 'POST',
      headers: {
        Host: '127.0.0.1',
        Origin: 'http://evil.com',
        'Content-Type': 'application/json'
      }
    }, { enabled: false });
    assert.strictEqual(resReserve.status, 403);

    // POST /api/tasks from untrusted origin
    const resTasks = await request(server, {
      path: '/api/tasks',
      method: 'POST',
      headers: {
        Host: '127.0.0.1',
        Origin: 'http://evil.com',
        'Content-Type': 'application/json'
      }
    }, { instruction: 'malicious payload' });
    assert.strictEqual(resTasks.status, 403);

    // Legitimate local request succeeds
    const resOk = await request(server, {
      path: '/api/claude-reserve',
      method: 'POST',
      headers: {
        Host: '127.0.0.1',
        Origin: 'http://localhost:3210',
        'Content-Type': 'application/json'
      }
    }, { enabled: false });
    assert.strictEqual(resOk.status, 200);
    assert.strictEqual(resOk.json.claudeReserve, false);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Access Control: remote/external request succeeds with valid Bearer token', async () => {
  const root = setupTempRoot();
  const token = getOrCreateConnectorToken(root);
  const server = createDashboardServer(root, { port: 0 });
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  try {
    // Mutation with valid Bearer token succeeds even with non-local origin/headers
    const resOk = await request(server, {
      path: '/api/claude-reserve',
      method: 'POST',
      headers: {
        Host: 'my-ar-tunnel.example.com',
        Origin: 'https://my-dashboard.example.com',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }, { enabled: true });
    assert.strictEqual(resOk.status, 200);
    assert.strictEqual(resOk.json.claudeReserve, true);

    // Mutation with invalid Bearer token fails with 403
    const resBad = await request(server, {
      path: '/api/claude-reserve',
      method: 'POST',
      headers: {
        Host: 'my-ar-tunnel.example.com',
        Origin: 'https://my-dashboard.example.com',
        Authorization: 'Bearer invalid-token-value',
        'Content-Type': 'application/json'
      }
    }, { enabled: false });
    assert.strictEqual(resBad.status, 403);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
