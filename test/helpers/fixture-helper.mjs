import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const helperDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.dirname(path.dirname(helperDir));
export const testBaseDir = path.resolve(repoRoot, '.router', 'tests');

// Registry of fixtures created and owned by the current process
const activeFixtures = new Set();
const GLOBAL_HOOK_INSTALLED = Symbol.for('adaptive_router_fixture_cleanup_installed');

/**
 * Returns true if the target path is strictly within the allowed test fixture scope
 * and is safe to delete.
 */
export function isSafeFixturePath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const resolved = path.resolve(targetPath);

  // 1. Never allow root directories
  if (resolved === repoRoot || resolved === path.resolve(repoRoot, '.router')) {
    return false;
  }

  // 2. Never allow real production / task / project data
  const realTasksDir = path.resolve(repoRoot, '.router', 'tasks');
  const realProjectsDir = path.resolve(repoRoot, '.router', 'projects');
  const realFixturesDir = path.resolve(repoRoot, 'fixtures');
  const realSrcDir = path.resolve(repoRoot, 'src');

  if (resolved === realTasksDir || resolved.startsWith(realTasksDir + path.sep)) return false;
  if (resolved === realProjectsDir || resolved.startsWith(realProjectsDir + path.sep)) return false;
  if (resolved === realFixturesDir || resolved.startsWith(realFixturesDir + path.sep)) return false;
  if (resolved === realSrcDir || resolved.startsWith(realSrcDir + path.sep)) return false;

  // 3. Must be inside .router/tests/
  const relToTestBase = path.relative(testBaseDir, resolved);
  const isInsideTestBase = !relToTestBase.startsWith('..') && !path.isAbsolute(relToTestBase) && relToTestBase !== '';
  if (isInsideTestBase) {
    return true;
  }

  // 4. Or inside os.tmpdir() with recognized test prefixes
  const tmpDir = path.resolve(os.tmpdir());
  const relToTmp = path.relative(tmpDir, resolved);
  const isInsideTmp = !relToTmp.startsWith('..') && !path.isAbsolute(relToTmp) && relToTmp !== '';
  if (isInsideTmp) {
    const baseName = path.basename(resolved);
    const allowedPrefixes = ['connector-test-', 'planning-test-', 'ar-title-', 'ar-usage-', 'ar-logos-', 'fail-test-'];
    if (allowedPrefixes.some(p => baseName.startsWith(p))) {
      return true;
    }
  }

  return false;
}

/**
 * Asserts that the target path is safe to delete, throwing an error if unsafe.
 */
export function assertSafeFixturePath(targetPath) {
  if (!isSafeFixturePath(targetPath)) {
    throw new Error(`[SAFETY VIOLATION] Refusing to delete path outside test fixture sandbox: "${targetPath}"`);
  }
}

/**
 * Safely removes a fixture directory with Windows lock handling and retries.
 */
export function safeRemoveFixture(targetPath) {
  if (!targetPath) return false;
  const resolved = path.resolve(targetPath);
  assertSafeFixturePath(resolved);

  activeFixtures.delete(resolved);

  if (!fs.existsSync(resolved)) {
    return true;
  }

  try {
    fs.rmSync(resolved, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
    return true;
  } catch (err) {
    // If still fails after retries (e.g. file lock), warn but don't crash runner
    return false;
  }
}

/**
 * Checks if a process with the given PID is currently alive and running.
 */
export function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // Running under different permissions, but definitely alive
  }
}

/**
 * Tracks a fixture directory for the current process.
 */
export function trackFixture(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return;
  const resolved = path.resolve(targetPath);
  if (isSafeFixturePath(resolved)) {
    activeFixtures.add(resolved);
    try {
      const ownerFile = path.join(resolved, '.fixture-owner.json');
      fs.writeFileSync(ownerFile, JSON.stringify({
        pid: process.pid,
        startedAt: Date.now()
      }));
    } catch (err) {}
  }
}

/**
 * Untracks a fixture directory without deleting it.
 */
export function untrackFixture(targetPath) {
  if (!targetPath) return;
  const resolved = path.resolve(targetPath);
  activeFixtures.delete(resolved);
}

/**
 * Cleans all active fixtures registered by the current process.
 */
export function cleanAllActiveFixtures() {
  const toClean = Array.from(activeFixtures);
  for (const dir of toClean) {
    safeRemoveFixture(dir);
  }
  activeFixtures.clear();
}

/**
 * Gets a copy of all currently tracked active fixtures for this process.
 */
export function getActiveFixtures() {
  return Array.from(activeFixtures);
}

/**
 * Creates a managed temporary test fixture directory.
 * @param {string} prefix - Directory prefix (e.g. 'case-', 'dash-')
 * @param {object} options - Configuration options
 * @param {object} [options.t] - node:test TestContext (registers t.after automatic cleanup)
 * @param {boolean} [options.seedFixtures] - Copy fixtures/ into fixture
 * @param {boolean} [options.seedWeb] - Copy src/web/ into fixture
 * @param {boolean} [options.seedSpecialists] - Copy specialists.json into fixture
 * @param {object} [options.workersConfig] - Write workers.json with this config
 * @returns {string} The created absolute fixture directory path
 */
export function createTestFixture(prefix = 'test-', options = {}) {
  // Ensure the test fixture root exists
  fs.mkdirSync(testBaseDir, { recursive: true });

  const safePrefix = prefix.endsWith('-') ? prefix : `${prefix}-`;
  const dir = fs.mkdtempSync(path.join(testBaseDir, safePrefix));
  trackFixture(dir);

  if (options.seedFixtures) {
    const src = path.join(repoRoot, 'fixtures');
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(dir, 'fixtures'), { recursive: true });
    }
  }

  if (options.seedWeb) {
    const src = path.join(repoRoot, 'src', 'web');
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(dir, 'src', 'web'), { recursive: true });
    }
  }

  if (options.seedSpecialists) {
    const src = path.join(repoRoot, 'specialists.json');
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dir, 'specialists.json'));
    }
  }

  if (options.workersConfig) {
    fs.writeFileSync(path.join(dir, 'workers.json'), JSON.stringify(options.workersConfig, null, 2));
  }

  // Register cleanup in test context if provided
  if (options.t && typeof options.t.after === 'function') {
    options.t.after(() => {
      safeRemoveFixture(dir);
    });
  }

  return dir;
}

/**
 * Runs an async callback inside an isolated test fixture, guaranteeing cleanup
 * in a try/finally block whether the test passes or throws.
 */
export async function withTestFixture(prefix, fn) {
  const dir = createTestFixture(prefix);
  try {
    return await fn(dir);
  } finally {
    safeRemoveFixture(dir);
  }
}

/**
 * Prunes stale fixtures in .router/tests older than maxAgeMs, skipping active fixtures.
 * This prevents unbounded accumulation across past aborted runs.
 * @param {number} maxAgeMs - Age threshold in milliseconds (default 15 minutes)
 * @returns {number} Count of pruned directories
 */
export function pruneStaleFixtures(maxAgeMs = 15 * 60 * 1000, baseDir = testBaseDir) {
  const targetDir = path.resolve(baseDir);
  if (!fs.existsSync(targetDir)) return 0;

  let pruned = 0;
  const now = Date.now();
  let entries = [];
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch (err) {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(targetDir, entry.name);
    const resolved = path.resolve(fullPath);

    // Never prune an active fixture belonging to the current process
    if (activeFixtures.has(resolved)) continue;

    // Must pass strict safety check
    if (!isSafeFixturePath(resolved)) continue;

    // Cross-process active check: if an active owner file exists and that process is alive, PRESERVE it!
    const ownerFile = path.join(resolved, '.fixture-owner.json');
    let ownerDead = false;
    if (fs.existsSync(ownerFile)) {
      try {
        const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
        if (owner && owner.pid) {
          if (isProcessAlive(owner.pid)) {
            // Process is currently alive and active! Legitimate long-running fixture, do not prune!
            continue;
          }
          ownerDead = true;
        }
      } catch (err) {
        // Corrupt owner file, fall back to age check
      }
    }

    try {
      const stats = fs.statSync(resolved);
      const ageMs = now - stats.mtimeMs;
      if (ownerDead || ageMs > maxAgeMs) {
        fs.rmSync(resolved, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50
        });
        pruned++;
      }
    } catch (err) {
      // Ignore individual file access errors during pruning
    }
  }

  return pruned;
}

/**
 * Installs automated lifecycle hooks and wraps fs.mkdtempSync to intercept
 * any fixture creation under .router/tests/ dynamically.
 */
export function setupFixtureAutoCleanup() {
  if (globalThis[GLOBAL_HOOK_INSTALLED]) {
    return;
  }
  globalThis[GLOBAL_HOOK_INSTALLED] = true;

  // 1. Register process exit and signal handlers
  process.on('exit', () => {
    cleanAllActiveFixtures();
  });

  const handleSignal = (signal, code) => {
    cleanAllActiveFixtures();
    process.exit(code);
  };

  process.once('SIGINT', () => handleSignal('SIGINT', 130));
  process.once('SIGTERM', () => handleSignal('SIGTERM', 143));

  // 2. Wrap fs.mkdtempSync to ensure parent directory exists and track fixture
  const originalMkdtempSync = fs.mkdtempSync;
  fs.mkdtempSync = function (prefix, options) {
    if (typeof prefix === 'string') {
      const resolvedPrefix = path.resolve(prefix);
      const rel = path.relative(testBaseDir, resolvedPrefix);
      const isTargetingTests = !rel.startsWith('..') && !path.isAbsolute(rel);

      if (isTargetingTests) {
        // Automatically ensure parent directory exists so tests never fail with ENOENT
        const parent = path.dirname(resolvedPrefix);
        fs.mkdirSync(parent, { recursive: true });

        const created = originalMkdtempSync.call(fs, prefix, options);
        trackFixture(created);
        return created;
      }
    }
    return originalMkdtempSync.call(fs, prefix, options);
  };

  // 3. Wrap fs.mkdtemp (async) as well
  const originalMkdtemp = fs.mkdtemp;
  fs.mkdtemp = function (prefix, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof prefix === 'string') {
      const resolvedPrefix = path.resolve(prefix);
      const rel = path.relative(testBaseDir, resolvedPrefix);
      const isTargetingTests = !rel.startsWith('..') && !path.isAbsolute(rel);

      if (isTargetingTests) {
        const parent = path.dirname(resolvedPrefix);
        fs.mkdirSync(parent, { recursive: true });

        return originalMkdtemp.call(fs, prefix, options, (err, folder) => {
          if (!err && folder) {
            trackFixture(folder);
          }
          if (callback) callback(err, folder);
        });
      }
    }
    return originalMkdtemp.call(fs, prefix, options, callback);
  };
}

// Auto-install lifecycle hooks on module load
setupFixtureAutoCleanup();

