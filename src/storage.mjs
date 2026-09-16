import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sanitizePayload } from './events.mjs';

export function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  // Windows antivirus/indexing can briefly hold the destination open. Preserve
  // the atomic replacement and retry only transient sharing/access errors.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temp, file); break; }
    catch (error) {
      if (attempt >= 7 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}
export const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function event(dir, type, detail = {}) {
  const sanitized = sanitizePayload(detail);
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), type, ...sanitized }) + '\n');
}
export function safePath(name) {
  if (typeof name !== 'string' || name.length > 140 || !/^[a-zA-Z0-9_/-]+(?:\.[a-zA-Z0-9_-]+)+$/.test(name)) throw Error(`Unsafe deliverable path: ${name}`);
  const parts = name.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw Error(`Unsafe deliverable path: ${name}`);
  if (![
    '.md', '.txt', '.json', '.jsonc', '.html', '.css', '.scss', '.js', '.mjs', '.cjs',
    '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.py', '.rb', '.php', '.java', '.kt',
    '.go', '.rs', '.cs', '.cpp', '.c', '.h', '.hpp', '.xml', '.yaml', '.yml', '.toml',
    '.sql', '.graphql', '.svg'
  ].includes(path.extname(name).toLowerCase())) throw Error(`Unsupported deliverable type: ${name}`);
  return name;
}
export function validateFiles(files, { checkSize = true } = {}) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 20) throw Error('Expected 1–20 deliverable files');
  const names = new Set();
  let bytes = 0;
  for (const f of files) {
    safePath(f.path);
    if (typeof f.content !== 'string') throw Error('File content must be text');
    const key = f.path.toLowerCase();
    if (names.has(key)) throw Error('Duplicate file path');
    names.add(key);
    bytes += Buffer.byteLength(f.content);
  }
  if (checkSize && bytes > 150_000) throw Error('V1 deliverable exceeds 150 KB');
  return files;
}
export function saveFiles(dir, files) {
  validateFiles(files);
  // Every revision gets a new directory. Never overwrite a previous revision.
  fs.mkdirSync(dir, { recursive: false });
  for (const f of files) {
    const target = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content, { flag: 'wx' });
  }
}
export function verifyFiles(dir, files) {
  if (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory()) throw Error('Deliverable directory must not be a link');
  for (const f of files) {
    const target = path.join(dir, safePath(f.path));
    let current = dir;
    for (const part of f.path.split('/')) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw Error('Deliverable contains a link');
    }
    if (!fs.lstatSync(target).isFile() || fs.readFileSync(target, 'utf8') !== f.content) throw Error('Deliverable changed after review');
  }
  const walk = folder => fs.readdirSync(folder, { withFileTypes: true }).flatMap(e => {
    if (e.isSymbolicLink()) throw Error('Deliverable contains a link');
    return e.isDirectory() ? walk(path.join(folder, e.name)) : [path.relative(dir, path.join(folder, e.name)).replaceAll('\\', '/')];
  });
  if (hash(walk(dir).sort()) !== hash(files.map(f => f.path).sort())) throw Error('Deliverable file list changed after review');
}
// True only when a process with this pid genuinely still exists — process.kill
// with signal 0 sends no signal, it just probes liveness/permission. ESRCH
// means no such process; anything else (e.g. EPERM, seen for a pid reused by
// a different user's process) is treated as "can't prove it's dead", which
// deliberately errs toward NOT stealing a lock that might still be legitimate.
function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}

// scope: an optional short identifier (e.g. a project id) that partitions
// the lock into its own file (router.lock.<scope> instead of router.lock).
// This is what allows two DIFFERENT projects' tasks to run concurrently
// while same-project tasks still fully serialize through one lock, exactly
// as before scope existed. Deliberately narrow: this only changes which
// lock FILE is used, not any of the stale-lock recovery or safety logic
// below, which is unchanged and applies identically per-scope.
function lockFileName(scope) {
  if (!scope) return 'router.lock';
  const safeScope = String(scope).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return `router.lock.${safeScope}`;
}

export async function locked(root, action, scope = null) {
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, lockFileName(scope));
  let fd;
  try {
    fd = fs.openSync(lock, 'wx');
  } catch {
    // The lock file already exists. Previously the only way past this was
    // the manual `node router.mjs unlock` CLI command — which nothing
    // running as a server (the dashboard, any auto-retry) ever calls, and
    // which requires a human to know it exists and run it by hand. If the
    // process that created the lock was killed abruptly (a crash, a forced
    // Task Manager kill, a router restart while a task was mid-flight —
    // exactly what happened here), the lock is permanently stale and every
    // future task, retry, and auto-retry silently refuses to run forever.
    // Recover automatically: only steal the lock when the recorded pid is
    // provably no longer running: a live pid still blocks exactly as before.
    let staleOwner = null;
    try { staleOwner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch {}
    if (staleOwner && !pidIsAlive(staleOwner.pid)) {
      try { fs.unlinkSync(lock); } catch {}
      try { fd = fs.openSync(lock, 'wx'); } catch {}
    }
    if (fd === undefined) throw Error('Another router operation is running. If interrupted, use node router.mjs unlock after it has stopped.');
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  try { return await action(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
