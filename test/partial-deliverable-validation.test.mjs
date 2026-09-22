import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { codeTask, composeValidationWorkspace } from '../src/coding.mjs';
import { read, json, hash, verifyFiles, safePath } from '../src/storage.mjs';
import { buildSchema, reviewSchema, validate } from '../src/contracts.mjs';
import { decide } from '../src/router.mjs';
import { createProject } from '../src/projects.mjs';
import { testProject } from '../src/project-test.mjs';
import { createTestFixture, repoRoot } from './helpers/fixture-helper.mjs';

const testWorkersConfig = {
  workers: [
    {
      id: 'codex',
      enabled: false,
      roles: ['plan', 'build', 'review'],
      priority: 10,
      adapter: 'codex'
    },
    {
      id: 'antigravity',
      enabled: true,
      roles: ['review', 'build'],
      priority: 30,
      adapter: 'antigravity'
    },
    {
      id: 'claude-code',
      enabled: false,
      roles: ['build', 'review'],
      priority: 20,
      adapter: 'claude'
    },
    {
      id: 'cline',
      enabled: true,
      roles: ['build'],
      priority: 35,
      adapter: 'cline'
    }
  ],
  maxCorrections: 2,
  workerTimeoutSeconds: 600,
  claudeReserve: true,
  connectorToken: 'CONNECTOR_TOKEN_REGENERATED_ON_FIRST_RUN'
};

function setupFixture(t) {
  const dir = createTestFixture('partial-val-', {
    seedFixtures: true,
    workersConfig: testWorkersConfig,
    t
  });
  const runtimeJson = path.join(repoRoot, 'browser-runtime.json');
  if (fs.existsSync(runtimeJson)) {
    fs.copyFileSync(runtimeJson, path.join(dir, 'browser-runtime.json'));
  }
  return dir;
}

function setupMultiFileProject(root, projectName = 'Sample Project') {
  const projectFolder = path.join(root, 'test-project-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(projectFolder, { recursive: true });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Counter App</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <h1>Counter</h1>
  <button id="inc">Increment</button>
  <span id="val">0</span>
  <script src="app.js"></script>
</body>
</html>
`;
  const css = `body { font-family: sans-serif; padding: 20px; }\nbutton { padding: 8px 16px; }\n`;
  const js = `document.getElementById('inc')?.addEventListener('click', () => {\n  const el = document.getElementById('val');\n  if (el) el.textContent = String(Number(el.textContent) + 1);\n});\n`;
  const readme = `# Counter App\nA simple counter application.\n`;

  fs.writeFileSync(path.join(projectFolder, 'index.html'), html, 'utf8');
  fs.writeFileSync(path.join(projectFolder, 'styles.css'), css, 'utf8');
  fs.writeFileSync(path.join(projectFolder, 'app.js'), js, 'utf8');
  fs.writeFileSync(path.join(projectFolder, 'README.md'), readme, 'utf8');

  // Also include a non-safe file / dotfile / node_modules to test exclusion
  fs.mkdirSync(path.join(projectFolder, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(projectFolder, 'node_modules', 'dep.js'), '// dep', 'utf8');
  fs.writeFileSync(path.join(projectFolder, '.env'), 'SECRET=key', 'utf8');

  const registered = createProject(root, { name: projectName, mode: 'existing', folderPath: projectFolder });
  return { registered, projectFolder, html, css, js, readme };
}

test('Partial-Deliverable Validation Against Complete Project State Suite', async (t) => {

  await t.test('1. composeValidationWorkspace isolates baseline + deliverable overlay', async () => {
    const root = setupFixture(t);
    const { registered, projectFolder, css, js, readme } = setupMultiFileProject(root);

    const taskDir = path.join(root, '.router', 'tasks', 'task-test-compose');
    fs.mkdirSync(taskDir, { recursive: true });

    const task = {
      id: 'task-test-compose',
      project: registered.id,
      projectRoot: projectFolder,
      revision: 1
    };

    const modifiedHtml = '<!DOCTYPE html><html><body><button id="inc" aria-label="Increment counter">Increment</button></body></html>\n';
    const deliverableFiles = [{ path: 'index.html', content: modifiedHtml }];

    const validationDir = composeValidationWorkspace(taskDir, task, deliverableFiles);

    assert.ok(fs.existsSync(validationDir), 'Validation directory should exist');
    assert.equal(path.basename(validationDir), 'validation-1');

    // index.html must be the modified deliverable content
    assert.equal(fs.readFileSync(path.join(validationDir, 'index.html'), 'utf8'), modifiedHtml);

    // Companion files must be present from baseline
    assert.equal(fs.readFileSync(path.join(validationDir, 'styles.css'), 'utf8'), css);
    assert.equal(fs.readFileSync(path.join(validationDir, 'app.js'), 'utf8'), js);
    assert.equal(fs.readFileSync(path.join(validationDir, 'README.md'), 'utf8'), readme);

    // Excluded items (.env, node_modules) must NOT be present
    assert.ok(!fs.existsSync(path.join(validationDir, '.env')), '.env must be excluded');
    assert.ok(!fs.existsSync(path.join(validationDir, 'node_modules')), 'node_modules must be excluded');

    // Deletion support
    const task2 = { ...task, revision: 2 };
    const filesWithDeletion = [{ path: 'styles.css', content: null, deleted: true }];
    const validationDir2 = composeValidationWorkspace(taskDir, task2, filesWithDeletion);
    assert.ok(!fs.existsSync(path.join(validationDir2, 'styles.css')), 'Deleted file should be unlinked');
    assert.ok(fs.existsSync(path.join(validationDir2, 'index.html')), 'Other baseline files remain');
  });

  await t.test('2. composeValidationWorkspace falls back to baseline.json if projectRoot is missing', async () => {
    const root = setupFixture(t);
    const taskDir = path.join(root, '.router', 'tasks', 'task-test-fallback');
    fs.mkdirSync(taskDir, { recursive: true });

    const baselineData = [
      { path: 'index.html', content: '<h1>Original</h1>' },
      { path: 'styles.css', content: 'body { color: black; }' }
    ];
    json(path.join(taskDir, 'baseline.json'), baselineData);

    const task = {
      id: 'task-test-fallback',
      project: 'test-project',
      projectRoot: path.join(root, 'non-existent-folder'),
      revision: 1
    };

    const deliverableFiles = [{ path: 'index.html', content: '<h1>Updated</h1>' }];
    const validationDir = composeValidationWorkspace(taskDir, task, deliverableFiles);

    assert.equal(fs.readFileSync(path.join(validationDir, 'index.html'), 'utf8'), '<h1>Updated</h1>');
    assert.equal(fs.readFileSync(path.join(validationDir, 'styles.css'), 'utf8'), 'body { color: black; }');
  });

  await t.test('3. Antigravity-style partial builder passes on Revision 1 with pure manifest and deliverables', async () => {
    const root = setupFixture(t);
    const { registered, projectFolder } = setupMultiFileProject(root);

    let reviewerReceivedFiles = null;
    let reviewerReceivedBaseline = null;
    let validatedProjectDir = null;

    const modifiedHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Counter App</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <h1>Counter</h1>
  <button id="inc" aria-label="Increment counter">Increment</button>
  <span id="val">0</span>
  <script src="app.js"></script>
</body>
</html>
`;

    const task = await codeTask(root, 'Add aria-label="Increment counter" to the existing increment button. Change nothing else.', {
      project: registered.id,
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          // Antigravity builder correctly returns ONLY the modified file
          return {
            summary: 'Added aria-label="Increment counter" to button',
            files: [
              { path: 'index.html', content: modifiedHtml }
            ]
          };
        }
        if (opts.schema === reviewSchema) {
          const codeMatch = opts.prompt.match(/Current code:\s*(\[.*?\])(?:\nActual validator results:|$)/s);
          if (codeMatch) reviewerReceivedFiles = JSON.parse(codeMatch[1]);
          const baseMatch = opts.prompt.match(/Baseline:\s*(\[.*?\])(?:\nCurrent code:|$)/s);
          if (baseMatch) reviewerReceivedBaseline = JSON.parse(baseMatch[1]);
          return { verdict: 'pass', summary: 'Clean and precise aria-label addition', issues: [] };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      },
      test: async (r, projectDir, reportPath, digest) => {
        validatedProjectDir = projectDir;
        // Verify that the validator received the composed validation directory
        assert.ok(projectDir.includes('validation-1'), 'Validator must receive validation-1 workspace');
        assert.ok(fs.existsSync(path.join(projectDir, 'index.html')), 'validation-1 has index.html');
        assert.ok(fs.existsSync(path.join(projectDir, 'styles.css')), 'validation-1 has styles.css');
        assert.ok(fs.existsSync(path.join(projectDir, 'app.js')), 'validation-1 has app.js');
        assert.ok(fs.existsSync(path.join(projectDir, 'README.md')), 'validation-1 has README.md');

        const result = {
          passed: true,
          digest,
          checks: [
            { name: 'Deliverable contains safe project files', passed: true },
            { name: 'Web deliverable loads without browser errors', passed: true },
            { name: 'No external requests attempted', passed: true }
          ],
          time: new Date().toISOString()
        };
        json(reportPath, result);
        return result;
      }
    });

    // 1. Task reaches awaiting_approval on Revision 1
    assert.equal(task.status, 'awaiting_approval', 'Task must reach awaiting_approval on rev 1');
    assert.equal(task.revision, 1, 'Task should succeed on Revision 1 without false correction loops');

    const taskDir = path.join(root, '.router', 'tasks', task.id);

    // 2. deliverables-1 directory must contain ONLY index.html
    const deliverablesDir = path.join(taskDir, 'deliverables-1');
    const deliverableList = fs.readdirSync(deliverablesDir);
    assert.deepEqual(deliverableList, ['index.html'], 'deliverables-1 must contain ONLY builder output');
    verifyFiles(deliverablesDir, [{ path: 'index.html', content: modifiedHtml }]);

    // 3. manifest-1.json must contain ONLY index.html
    const manifest = read(path.join(taskDir, 'manifest-1.json'));
    assert.equal(manifest.files.length, 1, 'manifest must contain only 1 file');
    assert.equal(manifest.files[0].path, 'index.html');
    assert.equal(manifest.digest, hash(manifest.files));
    assert.equal(task.digest, manifest.digest);

    // 4. changes-1.json must contain ONLY index.html
    const changes = read(path.join(taskDir, 'changes-1.json'));
    assert.deepEqual(changes.files, ['index.html'], 'changes.json must record only index.html');

    // 5. Reviewer prompt integrity: only builder deliverables and relevant baseline
    assert.ok(reviewerReceivedFiles, 'Reviewer must receive files');
    assert.equal(reviewerReceivedFiles.length, 1, 'Reviewer files must NOT include unchanged baseline files');
    assert.equal(reviewerReceivedFiles[0].path, 'index.html');
    assert.equal(reviewerReceivedBaseline.length, 1, 'Reviewer baseline must ONLY contain index.html');
    assert.equal(reviewerReceivedBaseline[0].path, 'index.html');

    // 6. Stage B approval applies ONLY index.html to real project folder
    const approvalRes = await decide(root, task.id, 'approved');
    assert.equal(approvalRes.status, 'approved');
    assert.deepEqual(approvalRes.appliedFiles, ['index.html'], 'appliedFiles must list only index.html');

    // Verify disk state in projectFolder
    const finalHtml = fs.readFileSync(path.join(projectFolder, 'index.html'), 'utf8');
    assert.ok(finalHtml.includes('aria-label="Increment counter"'), 'projectFolder index.html must be updated');
  });

  await t.test('4. Stage B applyApprovedFiles skips untouched baseline files if worker returns them', async () => {
    const root = setupFixture(t);
    const { registered, projectFolder, css } = setupMultiFileProject(root);

    const modifiedHtml = '<!DOCTYPE html><html><body>Updated HTML</body></html>\n';

    const task = await codeTask(root, 'Update HTML', {
      project: registered.id,
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          // Builder returns modified index.html AND untouched styles.css
          return {
            summary: 'Updated HTML and included untouched CSS',
            files: [
              { path: 'index.html', content: modifiedHtml },
              { path: 'styles.css', content: css } // Unchanged from baseline!
            ]
          };
        }
        return { verdict: 'pass', summary: 'Approved', issues: [] };
      },
      test: async (r, p, reportPath, digest) => {
        const result = { passed: true, digest, checks: [{ name: 'check', passed: true }], time: new Date().toISOString() };
        json(reportPath, result);
        return result;
      }
    });

    assert.equal(task.status, 'awaiting_approval');
    const approvalRes = await decide(root, task.id, 'approved');
    assert.equal(approvalRes.status, 'approved');

    // styles.css was identical to baseline, so applyApprovedFiles skipped it!
    assert.deepEqual(approvalRes.appliedFiles, ['index.html'], 'appliedFiles must skip unchanged styles.css');
  });

  await t.test('5. Adding brand new file overlays into validation workspace and applies on approval', async () => {
    const root = setupFixture(t);
    const { registered, projectFolder } = setupMultiFileProject(root);

    const newWidget = 'export function widget() { return "new"; }\n';

    const task = await codeTask(root, 'Add widget component', {
      project: registered.id,
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          return {
            summary: 'Added widget.js',
            files: [
              { path: 'widget.js', content: newWidget }
            ]
          };
        }
        return { verdict: 'pass', summary: 'Approved', issues: [] };
      },
      test: async (r, projectDir, reportPath, digest) => {
        assert.ok(fs.existsSync(path.join(projectDir, 'widget.js')), 'widget.js must be in validation workspace');
        assert.ok(fs.existsSync(path.join(projectDir, 'index.html')), 'baseline index.html must also be present');
        const result = { passed: true, digest, checks: [{ name: 'check', passed: true }], time: new Date().toISOString() };
        json(reportPath, result);
        return result;
      }
    });

    assert.equal(task.status, 'awaiting_approval');
    const approvalRes = await decide(root, task.id, 'approved');
    assert.deepEqual(approvalRes.appliedFiles, ['widget.js'], 'New file applied');
    assert.equal(fs.readFileSync(path.join(projectFolder, 'widget.js'), 'utf8'), newWidget);
  });

  await t.test('6. testProject browser route fulfillment succeeds with companion files in validation workspace', async (tSub) => {
    const root = setupFixture(t);
    const runtimePath = path.join(root, 'browser-runtime.json');
    if (!fs.existsSync(runtimePath)) {
      tSub.skip('Skipping browser test because browser-runtime.json is absent');
      return;
    }
    const { registered, projectFolder } = setupMultiFileProject(root);

    const taskDir = path.join(root, '.router', 'tasks', 'task-test-route');
    fs.mkdirSync(taskDir, { recursive: true });

    const task = {
      id: 'task-test-route',
      project: registered.id,
      projectRoot: projectFolder,
      revision: 1
    };

    // Builder only touches index.html
    const modifiedHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Test Project</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <h1>Test Page</h1>
  <button id="inc" aria-label="Increment counter">Increment</button>
  <script src="app.js"></script>
</body>
</html>
`;
    const deliverableFiles = [{ path: 'index.html', content: modifiedHtml }];
    const validationDir = composeValidationWorkspace(taskDir, task, deliverableFiles);

    // Run the real testProject against validationDir
    const reportPath = path.join(taskDir, 'tests-1.json');
    const testDigest = hash(deliverableFiles);
    const report = await testProject(root, validationDir, reportPath, testDigest);

    assert.equal(report.passed, true, 'testProject should pass completely against composed validation workspace');
    assert.ok(report.checks.every(c => c.passed), 'All testProject checks should pass');
    const browserCheck = report.checks.find(c => c.name === 'Web deliverable loads without browser errors');
    assert.ok(browserCheck && browserCheck.passed, 'Browser check must pass without ERR_FAILED');
  });

  await t.test('7. Cline builder compatibility remains intact', async () => {
    const root = setupFixture(t);
    const { registered, projectFolder, css, js } = setupMultiFileProject(root);

    const modifiedHtml = '<!DOCTYPE html><html><body>Cline update</body></html>\n';

    // Cline returns multiple files including companion files
    const clineFiles = [
      { path: 'index.html', content: modifiedHtml },
      { path: 'styles.css', content: css },
      { path: 'app.js', content: js }
    ];

    const task = await codeTask(root, 'Cline task update', {
      project: registered.id,
      ready() {},
      log() {},
      preferredWorker: 'cline',
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          return {
            summary: 'Cline completed edit',
            files: clineFiles
          };
        }
        return { verdict: 'pass', summary: 'Approved', issues: [] };
      },
      test: async (r, projectDir, reportPath, digest) => {
        const result = { passed: true, digest, checks: [{ name: 'check', passed: true }], time: new Date().toISOString() };
        json(reportPath, result);
        return result;
      }
    });

    assert.equal(task.status, 'awaiting_approval');
    assert.equal(task.revision, 1);
    const approvalRes = await decide(root, task.id, 'approved');
    assert.equal(approvalRes.status, 'approved');
    // Because styles.css and app.js matched baseline, applyApprovedFiles skipped them!
    assert.deepEqual(approvalRes.appliedFiles, ['index.html'], 'Only modified index.html is applied');
  });

  await t.test('8. Baseline-drift regression test: validation uses immutable task baseline, not live projectRoot drift', async () => {
    const root = setupFixture(t);
    const { registered, projectFolder } = setupMultiFileProject(root);

    // Initial baseline on disk: app.js contains ORIGINAL
    const originalAppJs = fs.readFileSync(path.join(projectFolder, 'app.js'), 'utf8');
    assert.ok(originalAppJs.length > 0, 'Original app.js must exist');

    let validationAppJsContent = null;
    const modifiedHtml = '<!DOCTYPE html><html><body>Drift test update</body></html>\n';

    const task = await codeTask(root, 'Update HTML', {
      project: registered.id,
      ready() {},
      log() {},
      call: async (worker, opts) => {
        if (opts.schema === buildSchema) {
          // Simulate external process/user mutating live projectFolder AFTER task was created
          fs.writeFileSync(path.join(projectFolder, 'app.js'), '// EXTERNAL_MUTATION_AFTER_TASK_CREATION\n', 'utf8');

          // Worker returns only index.html
          return {
            summary: 'Updated HTML only',
            files: [{ path: 'index.html', content: modifiedHtml }]
          };
        }
        return { verdict: 'pass', summary: 'Approved', issues: [] };
      },
      test: async (r, projectDir, reportPath, digest) => {
        // Read app.js from the validation directory
        const appJsPath = path.join(projectDir, 'app.js');
        assert.ok(fs.existsSync(appJsPath), 'app.js must be present in validation workspace');
        validationAppJsContent = fs.readFileSync(appJsPath, 'utf8');

        const result = { passed: true, digest, checks: [{ name: 'check', passed: true }], time: new Date().toISOString() };
        json(reportPath, result);
        return result;
      }
    });

    assert.equal(task.status, 'awaiting_approval');
    // Crucial assertion: validation workspace MUST contain ORIGINAL baseline app.js, NOT external change!
    assert.equal(validationAppJsContent, originalAppJs, 'Validation workspace must use immutable task-start baseline');
    assert.notEqual(validationAppJsContent, '// EXTERNAL_MUTATION_AFTER_TASK_CREATION\n', 'Validation workspace must NOT consume external mutations');
  });

  await t.test('9. Deletion contract: AR V1 enforces non-null file content, while validation workspace defensively handles deletions', async () => {
    // 1. Verify buildSchema strictly enforces path: string and content: string
    assert.throws(() => {
      validate({
        summary: 'Deleted a file',
        files: [{ path: 'app.js', deleted: true }]
      }, buildSchema);
    }, /missing content/, 'buildSchema must reject deliverables missing content string');

    assert.throws(() => {
      validate({
        summary: 'Null content',
        files: [{ path: 'app.js', content: null }]
      }, buildSchema);
    }, /expected string/, 'buildSchema must reject non-string content');

    // 2. Verify composeValidationWorkspace defensively supports deleted flag when passed directly
    const root = setupFixture(t);
    const { registered, projectFolder } = setupMultiFileProject(root);
    const taskDir = path.join(root, '.router', 'tasks', 'task-test-del');
    fs.mkdirSync(taskDir, { recursive: true });
    // Seed baseline
    json(path.join(taskDir, 'baseline.json'), [
      { path: 'index.html', content: '<h1>Keep</h1>' },
      { path: 'styles.css', content: '/* Remove */' }
    ]);
    const task = { id: 'task-test-del', project: registered.id, projectRoot: projectFolder, revision: 1 };
    const validationDir = composeValidationWorkspace(taskDir, task, [
      { path: 'styles.css', content: null, deleted: true }
    ]);
    assert.ok(!fs.existsSync(path.join(validationDir, 'styles.css')), 'Deleted file must be removed from validation workspace');
    assert.ok(fs.existsSync(path.join(validationDir, 'index.html')), 'Non-deleted file remains present');
  });

  await t.test('10. Path safety: reject traversal, absolute paths, and escaping variants', async () => {
    const root = setupFixture(t);
    const taskDir = path.join(root, '.router', 'tasks', 'task-test-sec');
    fs.mkdirSync(taskDir, { recursive: true });
    json(path.join(taskDir, 'baseline.json'), [{ path: 'index.html', content: '<h1>Sec</h1>' }]);
    const task = { id: 'task-test-sec', project: 'test', projectRoot: root, revision: 1 };

    // Parent directory traversal
    assert.throws(() => {
      composeValidationWorkspace(taskDir, task, [{ path: '../outside.txt', content: 'hacked' }]);
    }, /Unsafe deliverable path/);

    // Traversal variant
    assert.throws(() => {
      composeValidationWorkspace(taskDir, task, [{ path: 'foo/../../bar.txt', content: 'hacked' }]);
    }, /Unsafe deliverable path/);

    // Absolute path
    assert.throws(() => {
      composeValidationWorkspace(taskDir, task, [{ path: '/etc/passwd.txt', content: 'hacked' }]);
    }, /Unsafe deliverable path/);

    // Windows device name
    assert.throws(() => {
      composeValidationWorkspace(taskDir, task, [{ path: 'con.txt', content: 'hacked' }]);
    }, /Unsafe deliverable path/);

    // Unsupported extension
    assert.throws(() => {
      composeValidationWorkspace(taskDir, task, [{ path: 'script.sh', content: 'hacked' }]);
    }, /Unsupported deliverable type/);
  });

  await t.test('11. Multi-project isolation: validation workspaces never leak companion files across projects', async () => {
    const root = setupFixture(t);

    // Setup Project A
    const folderA = path.join(root, 'project-a');
    fs.mkdirSync(folderA, { recursive: true });
    fs.writeFileSync(path.join(folderA, 'index.html'), '<h1>Project A</h1>', 'utf8');
    fs.writeFileSync(path.join(folderA, 'moduleA.js'), '// Project A unique module\n', 'utf8');
    const projectA = createProject(root, { name: 'Project A', mode: 'existing', folderPath: folderA });

    // Setup Project B
    const folderB = path.join(root, 'project-b');
    fs.mkdirSync(folderB, { recursive: true });
    fs.writeFileSync(path.join(folderB, 'index.html'), '<h1>Project B</h1>', 'utf8');
    fs.writeFileSync(path.join(folderB, 'moduleB.js'), '// Project B unique module\n', 'utf8');
    const projectB = createProject(root, { name: 'Project B', mode: 'existing', folderPath: folderB });

    let projectAValidationFiles = null;
    let projectBValidationFiles = null;

    // Run Task on Project A
    const taskA = await codeTask(root, 'Update A', {
      project: projectA.id,
      ready() {},
      log() {},
      call: async (_w, opts) => {
        if (opts.schema === buildSchema) {
          return { summary: 'Update A', files: [{ path: 'index.html', content: '<h1>Updated Project A</h1>' }] };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      },
      test: async (_r, projectDir, reportPath, digest) => {
        projectAValidationFiles = fs.readdirSync(projectDir);
        const result = { passed: true, digest, checks: [{ name: 'check', passed: true }], time: new Date().toISOString() };
        json(reportPath, result);
        return result;
      }
    });

    // Run Task on Project B
    const taskB = await codeTask(root, 'Update B', {
      project: projectB.id,
      ready() {},
      log() {},
      call: async (_w, opts) => {
        if (opts.schema === buildSchema) {
          return { summary: 'Update B', files: [{ path: 'index.html', content: '<h1>Updated Project B</h1>' }] };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      },
      test: async (_r, projectDir, reportPath, digest) => {
        projectBValidationFiles = fs.readdirSync(projectDir);
        const result = { passed: true, digest, checks: [{ name: 'check', passed: true }], time: new Date().toISOString() };
        json(reportPath, result);
        return result;
      }
    });

    assert.equal(taskA.status, 'awaiting_approval');
    assert.equal(taskB.status, 'awaiting_approval');

    // Verify isolation
    assert.ok(projectAValidationFiles.includes('moduleA.js'), 'Project A validation must have moduleA.js');
    assert.ok(!projectAValidationFiles.includes('moduleB.js'), 'Project A validation must NEVER leak moduleB.js');

    assert.ok(projectBValidationFiles.includes('moduleB.js'), 'Project B validation must have moduleB.js');
    assert.ok(!projectBValidationFiles.includes('moduleA.js'), 'Project B validation must NEVER leak moduleA.js');
  });

  await t.test('12. Stage B guard review: correctly differentiates new files, modified files, and unchanged baseline files', async () => {
    const root = setupFixture(t);
    const { registered, projectFolder, css } = setupMultiFileProject(root);

    // 1. Task with new file + modified file + unchanged file
    const newContent = 'export const newlyAdded = true;\n';
    const modifiedHtml = '<!DOCTYPE html><html><body>Modified</body></html>\n';

    const task = await codeTask(root, 'Stage B test', {
      project: registered.id,
      ready() {},
      log() {},
      call: async (_w, opts) => {
        if (opts.schema === buildSchema) {
          return {
            summary: 'Mixed changes',
            files: [
              { path: 'index.html', content: modifiedHtml },
              { path: 'styles.css', content: css }, // identical to baseline
              { path: 'newfile.js', content: newContent } // new file
            ]
          };
        }
        return { verdict: 'pass', summary: 'OK', issues: [] };
      },
      test: async (_r, _p, reportPath, digest) => {
        const result = { passed: true, digest, checks: [{ name: 'check', passed: true }], time: new Date().toISOString() };
        json(reportPath, result);
        return result;
      }
    });

    assert.equal(task.status, 'awaiting_approval');
    const approvalRes = await decide(root, task.id, 'approved');
    assert.equal(approvalRes.status, 'approved');

    // Applied must contain modified index.html and newfile.js, but NOT unchanged styles.css
    assert.ok(approvalRes.appliedFiles.includes('index.html'), 'Modified file must be applied');
    assert.ok(approvalRes.appliedFiles.includes('newfile.js'), 'New file must be applied');
    assert.ok(!approvalRes.appliedFiles.includes('styles.css'), 'Unchanged file matching baseline must be skipped');

    assert.equal(fs.readFileSync(path.join(projectFolder, 'newfile.js'), 'utf8'), newContent);
    assert.equal(fs.readFileSync(path.join(projectFolder, 'index.html'), 'utf8'), modifiedHtml);
  });

});
