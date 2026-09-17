import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import {
  createTestFixture,
  safeRemoveFixture,
  assertSafeFixturePath,
  isSafeFixturePath,
  pruneStaleFixtures,
  withTestFixture,
  trackFixture,
  untrackFixture,
  cleanAllActiveFixtures,
  getActiveFixtures,
  repoRoot,
  testBaseDir
} from './helpers/fixture-helper.mjs';

describe('Adaptive Router — Test Fixture Cleanup Prevention Suite', () => {

  test('1. Fixture is created, test executes inside it, and fixture is removed afterward', (t) => {
    // 1. Fixture created
    const fixtureDir = createTestFixture('verify-lifecycle-', { t });
    assert.ok(fs.existsSync(fixtureDir), 'fixture directory must exist after creation');
    assert.ok(fixtureDir.startsWith(testBaseDir), 'fixture must be created inside .router/tests/');

    // 2. Test executes - writing files and reading back
    const sampleFile = path.join(fixtureDir, 'test-deliverable.txt');
    fs.writeFileSync(sampleFile, 'Temporary build output', 'utf8');
    assert.equal(fs.readFileSync(sampleFile, 'utf8'), 'Temporary build output');

    // 3. Fixture removed afterward
    const removed = safeRemoveFixture(fixtureDir);
    assert.equal(removed, true, 'safeRemoveFixture must return true');
    assert.equal(fs.existsSync(fixtureDir), false, 'fixture directory must no longer exist after removal');
  });

  test('2. withTestFixture helper guarantees cleanup on normal execution', async () => {
    let capturedDir = null;
    await withTestFixture('with-fixture-pass-', async (dir) => {
      capturedDir = dir;
      assert.ok(fs.existsSync(dir), 'fixture directory must exist during callback');
      fs.writeFileSync(path.join(dir, 'work.json'), JSON.stringify({ ok: true }));
      assert.ok(fs.existsSync(path.join(dir, 'work.json')));
    });

    assert.ok(capturedDir, 'dir should have been captured');
    assert.equal(fs.existsSync(capturedDir), false, 'fixture directory must be cleaned up after callback');
  });

  test('3. withTestFixture helper guarantees cleanup when test throws an error', async () => {
    let capturedDir = null;
    await assert.rejects(
      async () => {
        await withTestFixture('with-fixture-fail-', async (dir) => {
          capturedDir = dir;
          fs.writeFileSync(path.join(dir, 'error.log'), 'fatal error');
          throw new Error('Deliberate test failure');
        });
      },
      /Deliberate test failure/
    );

    assert.ok(capturedDir, 'dir should have been captured');
    assert.equal(fs.existsSync(capturedDir), false, 'fixture directory must be cleaned up even on exception');
  });

  test('4. Failure path in subprocess test cleans up fixtures safely on process exit', () => {
    // Spawns a child process running a failing test that creates a fixture in .router/tests/
    const subProcessCode = `
      import fs from 'node:fs';
      import path from 'node:path';
      import assert from 'node:assert/strict';
      import { createTestFixture } from './test/helpers/fixture-helper.mjs';

      const dir = createTestFixture('subproc-fail-');
      fs.writeFileSync(path.join(dir, 'marker.txt'), 'in-flight data');
      process.stdout.write(dir);

      // Deliberately trigger failure
      assert.equal(1, 2, 'Simulated test assertion failure');
    `;

    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', subProcessCode],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000
      }
    );

    assert.equal(result.status, 1, 'Child process must exit with non-zero code on test failure');
    const fixtureDir = result.stdout.trim();
    assert.ok(fixtureDir.includes('subproc-fail-'), `Must output created fixture path, got: ${fixtureDir}`);

    // Verify the fixture was cleaned up on exit despite the failure
    assert.equal(
      fs.existsSync(fixtureDir),
      false,
      'Fixture created by failed test process must be automatically cleaned up upon exit'
    );
  });

  test('5. Concurrent fixture names do not conflict and parallel tests do not delete each other active fixtures', () => {
    const fixtureCount = 10;
    const fixtures = [];

    // Create multiple concurrent fixtures
    for (let i = 0; i < fixtureCount; i++) {
      fixtures.push(createTestFixture(`concurrent-${i}-`));
    }

    // Verify all directories are unique
    const uniquePaths = new Set(fixtures);
    assert.equal(uniquePaths.size, fixtureCount, 'All concurrent fixture paths must be unique');

    // Verify all exist simultaneously
    for (const dir of fixtures) {
      assert.ok(fs.existsSync(dir), `Fixture ${dir} must exist concurrently`);
      fs.writeFileSync(path.join(dir, 'id.txt'), dir);
    }

    // Verify one test deleting its own fixture does NOT affect others
    const targetToDelete = fixtures[0];
    safeRemoveFixture(targetToDelete);
    assert.equal(fs.existsSync(targetToDelete), false);

    // Remaining fixtures must still be intact
    for (let i = 1; i < fixtures.length; i++) {
      assert.ok(fs.existsSync(fixtures[i]), `Fixture ${fixtures[i]} must not be deleted by other tests`);
      assert.equal(fs.readFileSync(path.join(fixtures[i], 'id.txt'), 'utf8'), fixtures[i]);
    }

    // Clean up the rest
    for (let i = 1; i < fixtures.length; i++) {
      safeRemoveFixture(fixtures[i]);
    }
  });

  test('6. Safety Boundary: Cleanup must NEVER delete real .router production/task data', () => {
    const realTasksDir = path.resolve(repoRoot, '.router', 'tasks');
    const realProjectsDir = path.resolve(repoRoot, '.router', 'projects');
    const routerDir = path.resolve(repoRoot, '.router');

    // 1. isSafeFixturePath checks
    assert.equal(isSafeFixturePath(repoRoot), false, 'repo root must never be considered safe fixture path');
    assert.equal(isSafeFixturePath(routerDir), false, '.router must never be considered safe fixture path');
    assert.equal(isSafeFixturePath(realTasksDir), false, '.router/tasks must never be considered safe fixture path');
    assert.equal(isSafeFixturePath(path.join(realTasksDir, 'task-123')), false, 'real tasks must never be considered safe');
    assert.equal(isSafeFixturePath(realProjectsDir), false, '.router/projects must never be considered safe');
    assert.equal(isSafeFixturePath(path.resolve(repoRoot, 'src')), false, 'src must never be considered safe');
    assert.equal(isSafeFixturePath(path.resolve(repoRoot, 'fixtures')), false, 'fixtures must never be considered safe');

    // 2. assertSafeFixturePath throws on unsafe paths
    assert.throws(() => assertSafeFixturePath(realTasksDir), /SAFETY VIOLATION/);
    assert.throws(() => assertSafeFixturePath(realProjectsDir), /SAFETY VIOLATION/);
    assert.throws(() => assertSafeFixturePath(routerDir), /SAFETY VIOLATION/);
    assert.throws(() => assertSafeFixturePath(repoRoot), /SAFETY VIOLATION/);

    // 3. safeRemoveFixture rejects deletion and throws or returns false
    assert.throws(() => safeRemoveFixture(realTasksDir), /SAFETY VIOLATION/);
    assert.throws(() => safeRemoveFixture(realProjectsDir), /SAFETY VIOLATION/);

    // 4. Real paths remain completely untouched
    if (fs.existsSync(realTasksDir)) {
      assert.ok(fs.existsSync(realTasksDir), 'real tasks directory must still exist');
    }
  });

  test('7. Stale Fixture Pruning: Old abandoned fixtures are cleaned, active/recent fixtures preserved', () => {
    // Isolate pruning test inside an isolated fixture directory so concurrent test suites do not race
    const isolationParent = createTestFixture('prune-isolation-');
    const staleDir = path.join(isolationParent, 'stale-child');
    fs.mkdirSync(staleDir, { recursive: true });

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(staleDir, twoHoursAgo, twoHoursAgo);

    // Create a fresh active fixture inside the isolated container
    const activeDir = path.join(isolationParent, 'active-child');
    fs.mkdirSync(activeDir, { recursive: true });

    // Prune fixtures older than 30 minutes inside isolationParent
    const maxAgeMs = 30 * 60 * 1000;
    const prunedCount = pruneStaleFixtures(maxAgeMs, isolationParent);

    assert.equal(prunedCount, 1, 'pruneStaleFixtures must prune exactly 1 stale directory');
    assert.equal(fs.existsSync(staleDir), false, 'stale fixture must be pruned');
    assert.equal(fs.existsSync(activeDir), true, 'active/recent fixture must NOT be pruned');

    // Clean up isolated test container
    safeRemoveFixture(isolationParent);
  });

  test('8. Cross-process stale pruning safety: Process B MUST NOT delete Process A active fixture even if older than threshold', async () => {
    // Process A: spawns, creates fixture, backdates mtime to 2 hours ago, and stays running
    const procACode = `
      import fs from 'node:fs';
      import { createTestFixture } from './test/helpers/fixture-helper.mjs';

      const dir = createTestFixture('proc-a-active-');
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(dir, twoHoursAgo, twoHoursAgo);

      // Output fixture path to stdout
      process.stdout.write(dir + '\\n');

      // Keep Process A alive
      setInterval(() => {}, 1000);
    `;

    const procA = spawn(process.execPath, ['--input-type=module', '-e', procACode], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'inherit']
    });

    const fixtureDir = await new Promise((resolve, reject) => {
      procA.stdout.once('data', (data) => {
        resolve(data.toString().trim());
      });
      procA.on('error', reject);
    });

    assert.ok(fs.existsSync(fixtureDir), 'Process A fixture must exist on disk');

    try {
      // Process B: starts independently in a fresh OS process, runs pruneStaleFixtures
      const procBCode = `
        import { pruneStaleFixtures } from './test/helpers/fixture-helper.mjs';
        const count = pruneStaleFixtures(15 * 60 * 1000); // 15 minutes threshold
        process.stdout.write(String(count));
      `;

      const procB = spawnSync(process.execPath, ['--input-type=module', '-e', procBCode], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000
      });

      assert.equal(procB.status, 0, 'Process B must complete successfully');

      // Expected result: Process B MUST PRESERVE Process A's active fixture!
      assert.equal(
        fs.existsSync(fixtureDir),
        true,
        'Process B MUST NOT delete Process A active fixture even though older than 15 minutes!'
      );
    } finally {
      // Terminate Process A
      procA.kill();
      await new Promise((r) => setTimeout(r, 200));
    }

    // Now that Process A is terminated, Process C runs stale pruning:
    const procCCode = `
      import { pruneStaleFixtures } from './test/helpers/fixture-helper.mjs';
      const count = pruneStaleFixtures(15 * 60 * 1000);
      process.stdout.write(String(count));
    `;

    const procC = spawnSync(process.execPath, ['--input-type=module', '-e', procCCode], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    });

    assert.equal(procC.status, 0, 'Process C must complete successfully');
    // Now the abandoned fixture MUST be pruned!
    assert.equal(
      fs.existsSync(fixtureDir),
      false,
      'Process C must prune Process A fixture once Process A has terminated!'
    );
  });

  test('9. Signal handling sanity check: SIGINT, SIGTERM, normal exit, and failure exit all clean up and terminate', () => {
    // 1. In-process SIGINT terminates and cleans fixture
    const sigIntCode = `
      import { createTestFixture } from './test/helpers/fixture-helper.mjs';
      const dir = createTestFixture('test-sigint-');
      process.stdout.write(dir);
      process.emit('SIGINT');
      process.stdout.write('FAILED_SHOULD_HAVE_EXITED');
    `;
    const sigIntRes = spawnSync(process.execPath, ['--input-type=module', '-e', sigIntCode], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    });
    assert.ok(!sigIntRes.stdout.includes('FAILED_SHOULD_HAVE_EXITED'), 'SIGINT handler must terminate process');
    const sigIntDir = sigIntRes.stdout.trim();
    assert.equal(fs.existsSync(sigIntDir), false, 'SIGINT must clean up active fixture');

    // 2. In-process SIGTERM terminates and cleans fixture
    const sigTermCode = `
      import { createTestFixture } from './test/helpers/fixture-helper.mjs';
      const dir = createTestFixture('test-sigterm-');
      process.stdout.write(dir);
      process.emit('SIGTERM');
      process.stdout.write('FAILED_SHOULD_HAVE_EXITED');
    `;
    const sigTermRes = spawnSync(process.execPath, ['--input-type=module', '-e', sigTermCode], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    });
    assert.ok(!sigTermRes.stdout.includes('FAILED_SHOULD_HAVE_EXITED'), 'SIGTERM handler must terminate process');
    const sigTermDir = sigTermRes.stdout.trim();
    assert.equal(fs.existsSync(sigTermDir), false, 'SIGTERM must clean up active fixture');

    // 3. Normal exit cleans fixture and exits 0
    const normalCode = `
      import { createTestFixture } from './test/helpers/fixture-helper.mjs';
      const dir = createTestFixture('test-normal-');
      process.stdout.write(dir);
    `;
    const normalRes = spawnSync(process.execPath, ['--input-type=module', '-e', normalCode], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    });
    assert.equal(normalRes.status, 0, 'Normal script must exit with 0');
    const normalDir = normalRes.stdout.trim();
    assert.equal(fs.existsSync(normalDir), false, 'Normal exit must clean up active fixture');

    // 4. Failure exit cleans fixture and exits 1
    const failCode = `
      import assert from 'node:assert/strict';
      import { createTestFixture } from './test/helpers/fixture-helper.mjs';
      const dir = createTestFixture('test-fail-exit-');
      process.stdout.write(dir);
      assert.equal(1, 2, 'Simulated failure');
    `;
    const failRes = spawnSync(process.execPath, ['--input-type=module', '-e', failCode], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    });
    assert.equal(failRes.status, 1, 'Failing script must exit with 1');
    const failDir = failRes.stdout.trim();
    assert.equal(fs.existsSync(failDir), false, 'Failure exit must clean up active fixture');
  });
});
