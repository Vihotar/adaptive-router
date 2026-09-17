import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  recordWorkerEvent,
  loadTaskEvents,
  sanitizeText,
  sanitizePayload,
  createWorkerEvent,
  ALLOWED_EVENT_TYPES
} from '../src/events.mjs';
import { createDashboardServer, broadcastTaskEvent } from '../src/server.mjs';
import { createTestFixture } from './helpers/fixture-helper.mjs';

test('Universal Worker Event Layer — Schema, Monotonic Sequences, and Event IDs', (t) => {
  const root = createTestFixture('feed-', { t });
  const taskId = '20260911T120000-testfeed';
  const taskDir = path.join(root, '.router', 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });

  const evt1 = recordWorkerEvent(root, taskId, {
    platform: 'codex',
    worker: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'medium',
    specialist: 'Frontend Architect',
    role: 'builder',
    eventType: 'worker_start',
    title: 'Worker started: CODEX',
    detail: 'Model: gpt-5.6-sol [medium]',
    status: 'in_progress'
  });

  assert.ok(evt1.eventId.startsWith('evt_'));
  assert.equal(evt1.sequence, 1);
  assert.equal(evt1.taskId, taskId);
  assert.equal(evt1.platform, 'codex');
  assert.equal(evt1.eventType, 'worker_start');

  const evt2 = recordWorkerEvent(root, taskId, {
    platform: 'codex',
    worker: 'codex',
    eventType: 'file_edit',
    title: 'Editing src/server.mjs',
    detail: 'Added streaming endpoint',
    file: 'src/server.mjs',
    status: 'in_progress'
  });

  assert.ok(evt2.eventId.startsWith('evt_'));
  assert.equal(evt2.sequence, 2);
  assert.notEqual(evt1.eventId, evt2.eventId);

  // Persistence to events.jsonl
  const eventsFile = path.join(taskDir, 'events.jsonl');
  assert.ok(fs.existsSync(eventsFile));
  const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].sequence, 1);
  assert.equal(lines[1].sequence, 2);

  // Load through loadTaskEvents
  const loaded = loadTaskEvents(root, taskId);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].eventId, evt1.eventId);
  assert.equal(loaded[1].eventId, evt2.eventId);
});

test('Universal Worker Event Layer — Secret Redaction in Events, Text, and Payloads', () => {
  const sensitiveText = 'Using OpenAI key sk-1234567890abcdef1234567890 and Bearer mySecretToken1234567890 with password: "supersecretpass"';
  const sanitized = sanitizeText(sensitiveText);

  assert.ok(!sanitized.includes('sk-1234567890abcdef1234567890'), 'OpenAI key must be redacted');
  assert.ok(!sanitized.includes('mySecretToken1234567890'), 'Bearer token must be redacted');
  assert.ok(!sanitized.includes('supersecretpass'), 'Password must be redacted');
  assert.ok(sanitized.includes('[REDACTED]'), 'Redacted marker must be present');

  const payload = {
    title: 'Command executed',
    apiKey: 'sk-ant-api03-abcdef1234567890abcdef1234',
    command: 'curl -H "Authorization: Bearer secrettoken1234567890" http://localhost:3210',
    nested: {
      password: 'hidden_password_123',
      note: 'safe text'
    }
  };
  const sanitizedPayload = sanitizePayload(payload);
  assert.equal(sanitizedPayload.apiKey, '[REDACTED]');
  assert.equal(sanitizedPayload.nested.password, '[REDACTED]');
  assert.ok(!sanitizedPayload.command.includes('secrettoken1234567890'));
  assert.equal(sanitizedPayload.nested.note, 'safe text');
});

test('Universal Worker Event Layer — Whitelist Validation', () => {
  const custom = createWorkerEvent({
    taskId: 'test',
    eventType: 'unauthorized_internal_thinking',
    platform: 'rogue_platform',
    title: 'Thinking about code'
  });

  // Falls back to safe default
  assert.equal(custom.eventType, 'progress');
  assert.equal(custom.platform, 'router');
});

test('Universal Worker Event Layer — Legacy Task Normalization', (t) => {
  const root = createTestFixture('feed-', { t });
  const taskId = '20260910T074014-71564128';
  const taskDir = path.join(root, '.router', 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });

  const legacyEvents = [
    { type: 'activity', time: '2026-09-10T07:40:15.000Z', icon: '📋', title: 'Task Initiated', desc: 'Add contact form' },
    { type: 'worker_started', worker: 'codex', model: 'gpt-5.6-sol', effort: 'medium', stage: 'build-1' },
    { type: 'worker_completed', worker: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
    { type: 'worker_unavailable', worker: 'claude-code', isQuota: true, error: 'usage limit' }
  ];

  fs.writeFileSync(path.join(taskDir, 'events.jsonl'), legacyEvents.map(e => JSON.stringify(e)).join('\n') + '\n');

  const normalized = loadTaskEvents(root, taskId);
  assert.equal(normalized.length, 4);

  // Checks normalization into universal structure
  assert.equal(normalized[0].eventType, 'routing');
  assert.equal(normalized[0].title, 'Task Initiated');
  assert.ok(normalized[0].eventId.startsWith('evt_leg_'));
  assert.equal(normalized[0].sequence, 1);

  assert.equal(normalized[1].eventType, 'worker_start');
  assert.equal(normalized[1].worker, 'codex');
  assert.equal(normalized[1].sequence, 2);

  assert.equal(normalized[2].eventType, 'progress');
  assert.equal(normalized[2].worker, 'codex');
  assert.equal(normalized[2].sequence, 3);

  assert.equal(normalized[3].eventType, 'failover');
  assert.equal(normalized[3].title, 'Quota limit reached: claude-code');
  assert.equal(normalized[3].sequence, 4);
});

test('Real-Time Worker Feed — SSE Live Broadcasting, Sequence Resumption, and Sub-Second Latency', async (t) => {
  const root = createTestFixture('feed-stream-', { t });
  const taskId = '20260911T120500-a1b2c3d4';
  const taskDir = path.join(root, '.router', 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });

  // Minimal workers.json and task.json
  fs.writeFileSync(path.join(root, 'workers.json'), JSON.stringify({ claudeReserve: true }, null, 2));
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    status: 'building',
    builder: 'antigravity',
    instruction: 'Live feed test task'
  }, null, 2));

  // Seed two historical events
  recordWorkerEvent(root, taskId, {
    platform: 'antigravity',
    worker: 'antigravity',
    eventType: 'worker_start',
    title: 'Worker started: ANTIGRAVITY'
  });
  recordWorkerEvent(root, taskId, {
    platform: 'antigravity',
    worker: 'antigravity',
    eventType: 'file_edit',
    title: 'Editing src/web/app.js',
    file: 'src/web/app.js'
  });

  // Start test server
  const server = createDashboardServer(root);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Verify getTaskDetails returns seeded workerEvents
    const taskRes = await fetch(`${baseUrl}/api/tasks/${taskId}`);
    assert.equal(taskRes.status, 200);
    const taskData = await taskRes.json();
    assert.equal(taskData.workerEvents.length, 2);
    assert.equal(taskData.workerEvents[0].sequence, 1);
    assert.equal(taskData.workerEvents[1].sequence, 2);

    // 2. Test SSE Replay with ?sinceSequence=1 (should only replay sequence 2)
    const streamUrl = `${baseUrl}/api/tasks/${taskId}/stream?sinceSequence=1`;
    const resStream = await fetch(streamUrl);
    assert.equal(resStream.status, 200);
    assert.ok(resStream.headers.get('content-type').includes('text/event-stream'));

    const reader = resStream.body.getReader();
    const decoder = new TextDecoder();

    let buffer = '';
    const eventsReceived = [];

    // Read initial stream data
    const readChunk = async () => {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        if (part.startsWith('data: ')) {
          try {
            eventsReceived.push(JSON.parse(part.slice(6)));
          } catch {}
        }
      }
    };

    // Read connected event and replayed events
    await readChunk();
    assert.ok(eventsReceived.some(e => e.type === 'connected'));
    const replayed = eventsReceived.filter(e => e.type === 'worker_event');
    assert.equal(replayed.length, 1, 'Only sequence > 1 should be replayed');
    assert.equal(replayed[0].event.sequence, 2);

    // 3. Test Live Broadcast & Latency Measurement
    const sendTime = performance.now();
    const liveEvt = recordWorkerEvent(root, taskId, {
      platform: 'antigravity',
      worker: 'antigravity',
      eventType: 'command',
      title: 'Running command',
      command: 'node --test'
    });

    broadcastTaskEvent(taskId, { type: 'worker_event', event: liveEvt });

    // Read next chunk with live event
    await readChunk();
    const receiveTime = performance.now();
    const latencyMs = receiveTime - sendTime;

    const liveReceived = eventsReceived.find(e => e.type === 'worker_event' && e.event.sequence === 3);
    assert.ok(liveReceived, 'Live broadcast event must be received');
    assert.equal(liveReceived.event.title, 'Running command');
    assert.equal(liveReceived.event.command, 'node --test');

    // Sub-second requirement: must be well under 500ms (typically < 15ms)
    assert.ok(latencyMs < 500, `Streaming latency must be sub-second (measured: ${latencyMs.toFixed(2)}ms)`);

    await reader.cancel();
  } finally {
    await new Promise((r) => server.close(r));
  }
});
