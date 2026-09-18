import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseClineStream, invoke } from '../src/workers.mjs';
import { buildSchema } from '../src/contracts.mjs';

function tempDir(prefix) {
  fs.mkdirSync('.router/tests', { recursive: true });
  return fs.mkdtempSync(path.resolve('.router/tests', prefix));
}

test('Cline Token & Runtime Efficiency Hardening', async (t) => {
  const root = process.cwd();

  await t.test('parseClineStream resolves both relative and absolute paths from disk', () => {
    const dir = tempDir('cline-stream-path-');
    const testFile = path.join(dir, 'index.html');
    fs.writeFileSync(testFile, '<h1>Fresh on Disk</h1>', 'utf8');

    // Case A: relative path
    const streamRel = [
      {
        type: 'agent_event',
        event: {
          type: 'content_start',
          contentType: 'tool',
          toolName: 'editor',
          input: { path: 'index.html', new_text: '<h1>From new_text</h1>' }
        }
      },
      {
        type: 'run_result',
        text: '{"summary":"Done"}',
        usage: { inputTokens: 5000, outputTokens: 120 }
      }
    ].map(o => JSON.stringify(o)).join('\n');

    const parsedRel = parseClineStream(streamRel, dir);
    assert.equal(parsedRel.editedFiles.get('index.html'), '<h1>Fresh on Disk</h1>');
    assert.equal(parsedRel.usage.inputTokens, 5000);
    assert.equal(parsedRel.usage.outputTokens, 120);

    // Case B: absolute path
    const streamAbs = [
      {
        type: 'agent_event',
        event: {
          type: 'content_start',
          contentType: 'tool',
          toolName: 'editor',
          input: { path: testFile, new_text: '<h1>From new_text</h1>' }
        }
      },
      {
        type: 'run_result',
        text: '{"summary":"Done"}',
        usage: { inputTokens: 5000, outputTokens: 120 }
      }
    ].map(o => JSON.stringify(o)).join('\n');

    const parsedAbs = parseClineStream(streamAbs, dir);
    assert.equal(parsedAbs.editedFiles.get('index.html'), '<h1>Fresh on Disk</h1>');
  });

  await t.test('parseClineStream falls back to content or new_text if file is not on disk', () => {
    const dir = tempDir('cline-stream-fallback-');
    const streamFallback = [
      {
        type: 'agent_event',
        event: {
          type: 'content_start',
          contentType: 'tool',
          toolName: 'write_to_file',
          input: { path: 'nonexistent.txt', content: 'fallback content string' }
        }
      },
      {
        type: 'agent_event',
        event: {
          type: 'content_start',
          contentType: 'tool',
          toolName: 'editor',
          input: { path: 'another-virtual.txt', new_text: 'virtual new text' }
        }
      }
    ].map(o => JSON.stringify(o)).join('\n');

    const parsed = parseClineStream(streamFallback, dir);
    assert.equal(parsed.editedFiles.get('nonexistent.txt'), 'fallback content string');
    assert.equal(parsed.editedFiles.get('another-virtual.txt'), 'virtual new text');
  });

  await t.test('Cline prompt replaces full project snapshot with concise manifest', async () => {
    const dir = tempDir('cline-prompt-manifest-');
    const workspace = path.join(dir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });

    // Mock prompt with bulky project snapshot
    const largeSnapshot = JSON.stringify([
      { path: 'index.html', content: '<html><body>' + 'A'.repeat(5000) + '</body></html>' },
      { path: 'styles.css', content: 'body { margin: 0; }' },
      { path: 'script.js', content: 'console.log("hello");' }
    ]);
    const originalPrompt = `Build Task: Update the button label.\n\nCurrent project snapshot:\n${largeSnapshot}\n\nPlease proceed with the implementation.`;

    const mockClineBat = path.join(dir, 'mock-cline.bat');
    const mockScript = path.join(dir, 'mock-cline.mjs');
    fs.writeFileSync(mockScript, `
      import fs from 'node:fs';
      import path from 'node:path';
      const cwdIdx = process.argv.indexOf('--cwd');
      const targetCwd = cwdIdx !== -1 ? process.argv[cwdIdx + 1] : process.cwd();
      const files = fs.readdirSync(targetCwd);
      const promptFile = files.find(f => f.startsWith('.adaptive-router-cline-task-'));
      if (promptFile) {
        fs.writeFileSync(path.join('${dir.replaceAll('\\', '/')}', 'captured-prompt.txt'), fs.readFileSync(path.join(targetCwd, promptFile), 'utf8'), 'utf8');
      }
      fs.writeFileSync(path.join('${dir.replaceAll('\\', '/')}', 'captured-args.json'), JSON.stringify(process.argv), 'utf8');
      const out = JSON.stringify({ summary: "mock success", files: [{ path: "index.html", content: "ok" }] });
      console.log(JSON.stringify({ type: "run_result", text: out, usage: { inputTokens: 100, outputTokens: 50 } }));
    `, 'utf8');

    fs.writeFileSync(mockClineBat, `@echo off\r\nnode "${mockScript}" %*\r\n`, 'utf8');

    const result = await invoke(
      { id: 'cline', adapter: 'cline' },
      {
        root,
        dir,
        schema: buildSchema,
        prompt: originalPrompt,
        timeout: 10000,
        paths: { cline: mockClineBat },
        model: 'gemini-3.5-flash-lite',
        providerId: 'gemini'
      }
    );

    assert.ok(fs.existsSync(path.join(dir, 'captured-prompt.txt')), 'captured-prompt.txt must exist');
    const capturedPrompt = fs.readFileSync(path.join(dir, 'captured-prompt.txt'), 'utf8');
    const capturedArgs = JSON.parse(fs.readFileSync(path.join(dir, 'captured-args.json'), 'utf8'));

    // 1. Bulky snapshot replaced by concise manifest
    assert.ok(!capturedPrompt.includes('A'.repeat(5000)), 'Bulky file contents must NOT be embedded in prompt');
    assert.ok(capturedPrompt.includes('Project files available in current directory: index.html, styles.css, script.js'), 'Must contain concise manifest');
    assert.ok(capturedPrompt.includes('(All project files are directly accessible in your current working directory; inspect or edit them directly on disk)'));

    // 2. Directives harmonized for tool usage and submit_and_exit
    assert.ok(capturedPrompt.includes('Task Execution Directives for Cline:'));
    assert.ok(capturedPrompt.includes('Focus strictly on the file(s) relevant to the instruction.'));
    assert.ok(capturedPrompt.includes('Use the editor or write_to_file tool to apply the requested edits directly.'));
    assert.ok(capturedPrompt.includes('When finished, call submit_and_exit with a concise summary of changes made.'));

    // 3. Removed contradictory "Return ONLY a JSON object matching this schema, with no other text before or after it"
    assert.ok(!capturedPrompt.includes('Return ONLY a JSON object matching this schema, with no other text before or after it'));

    // 4. Cline CLI args include bounded retries
    assert.ok(capturedArgs.includes('--retries'), 'Args must include --retries');
    assert.equal(capturedArgs[capturedArgs.indexOf('--retries') + 1], '3');
  });

  await t.test('Workspace companion files are preserved in deliverable manifest for browser tests', async () => {
    const dir = tempDir('cline-companion-');
    const mockProjectRoot = path.join(dir, 'mock-project');
    fs.mkdirSync(mockProjectRoot, { recursive: true });
    fs.writeFileSync(path.join(mockProjectRoot, 'index.html'), '<h1>Hello</h1>', 'utf8');
    fs.writeFileSync(path.join(mockProjectRoot, 'styles.css'), 'h1 { color: blue; }', 'utf8');

    const mockClineBat = path.join(dir, 'mock-cline.bat');
    const mockScript = path.join(dir, 'mock-cline.mjs');
    fs.writeFileSync(mockScript, `
      const out = JSON.stringify({ summary: "Updated index", files: [{ path: "index.html", content: "<h1>Updated</h1>" }] });
      console.log(JSON.stringify({ type: "run_result", text: out, usage: { inputTokens: 100, outputTokens: 50 } }));
    `, 'utf8');
    fs.writeFileSync(mockClineBat, `@echo off\r\nnode "${mockScript}" %*\r\n`, 'utf8');

    const result = await invoke(
      { id: 'cline', adapter: 'cline' },
      {
        root,
        dir,
        schema: buildSchema,
        prompt: 'Update index.html',
        timeout: 10000,
        paths: { cline: mockClineBat },
        model: 'gemini-3.5-flash-lite',
        providerId: 'gemini',
        projectRoot: mockProjectRoot
      }
    );

    // Companion file styles.css must be preserved alongside index.html
    const filePaths = result.files.map(f => f.path);
    assert.ok(filePaths.includes('index.html'), 'index.html must be present');
    assert.ok(filePaths.includes('styles.css'), 'styles.css must be preserved');
    const indexFile = result.files.find(f => f.path === 'index.html');
    assert.equal(indexFile.content, '<h1>Updated</h1>');
    const stylesFile = result.files.find(f => f.path === 'styles.css');
    assert.equal(stylesFile.content, 'h1 { color: blue; }');
  });

  await t.test('Non-Cline workers retain their full prompt and snapshot contracts', async () => {
    const workersSource = fs.readFileSync(path.join(root, 'src', 'workers.mjs'), 'utf8');
    assert.ok(workersSource.includes("input: prompt + '\\nReturn only JSON matching:\\n' + JSON.stringify(schema)"),
      'Claude Code input prompt contract must be retained');
    assert.ok(workersSource.includes("input: prompt,"),
      'Codex input prompt contract must be retained');
  });
});
