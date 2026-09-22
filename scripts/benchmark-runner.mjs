import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { codeTask } from '../src/coding.mjs';

const root = process.cwd();
const labRoot = process.env.AR_BENCHMARK_LAB_ROOT || path.join(root, 'benchmark-lab');
const targetProvider = process.argv[2] || 'gemini'; // 'gemini', 'nvidia', 'north', 'laguna'

console.log(`\n======================================================`);
console.log(`BENCHMARK RUN: ${targetProvider.toUpperCase()}`);
console.log(`======================================================`);

// 1. Reset AR Reliability Lab to clean baseline 82927cb
execSync('git reset --hard 82927cb', { cwd: labRoot, stdio: 'inherit' });
execSync('git clean -fd', { cwd: labRoot, stdio: 'inherit' });

// 2. Configure workers.json
const wPath = path.join(root, 'workers.json');
const origConfig = JSON.parse(fs.readFileSync(wPath, 'utf8'));
const testConfig = JSON.parse(JSON.stringify(origConfig));

// Disable Codex and Claude so Cline builds and Antigravity reviews
testConfig.workers.find(w => w.id === 'codex').enabled = false;
testConfig.workers.find(w => w.id === 'claude-code').enabled = false;
const clineWorker = testConfig.workers.find(w => w.id === 'cline');
clineWorker.enabled = true;
delete clineWorker.model;
delete clineWorker.provider;

if (targetProvider === 'gemini') {
  clineWorker.providerOrder = ['gemini'];
} else if (targetProvider === 'nvidia') {
  clineWorker.providerOrder = ['nvidia'];
} else if (targetProvider === 'north') {
  clineWorker.providerOrder = ['openrouter'];
} else if (targetProvider === 'laguna') {
  clineWorker.providerOrder = ['openrouter'];
  clineWorker.model = 'poolside/laguna-s-2.1:free';
} else {
  throw new Error(`Unknown provider: ${targetProvider}`);
}

fs.writeFileSync(wPath, JSON.stringify(testConfig, null, 2) + '\n', 'utf8');

const startTime = Date.now();
let taskResult = null;

try {
  taskResult = await codeTask(root, "Update index.html to add an aria-label 'Increment counter' to the increment button", {
    project: 'ar-reliability-lab-98ca87',
    unavailableBuilders: ['codex'],
    log: (msg) => console.log('[AR LOG]', msg),
    onWorkerEvent: (evt) => {
      const title = evt.title || evt.eventType || '';
      const detail = evt.detail ? ` - ${evt.detail}` : '';
      console.log(`[EVENT] ${title}${detail}`);
    }
  });
} catch (err) {
  console.error('[TASK ERROR]', err);
} finally {
  // Always restore original workers.json
  fs.writeFileSync(wPath, JSON.stringify(origConfig, null, 2) + '\n', 'utf8');
}

const elapsedMs = Date.now() - startTime;
console.log(`\n------------------------------------------------------`);
console.log(`BENCHMARK COMPLETED: ${targetProvider.toUpperCase()} (${(elapsedMs / 1000).toFixed(1)}s)`);
console.log(`------------------------------------------------------`);
if (taskResult) {
  console.log('Task ID:', taskResult.id);
  console.log('Status:', taskResult.status);
  console.log('Summary:', taskResult.summary);
  console.log('Validator:', JSON.stringify(taskResult.validator, null, 2));
  console.log('Review:', JSON.stringify(taskResult.review, null, 2));
  console.log('Token Usage:', JSON.stringify(taskResult.tokenUsage, null, 2));
}
