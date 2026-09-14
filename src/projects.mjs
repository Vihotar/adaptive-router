import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { json, read } from './storage.mjs';

const REGISTRY_VERSION = 1;

function registryPath(root) {
  return path.join(root, '.router', 'projects.json');
}

function canonical(filePath) {
  return path.resolve(filePath).replace(/[\\/]+$/, '').toLowerCase();
}

function builtIns(root) {
  return [
    {
      id: 'adaptive-router',
      name: 'Adaptive Router System',
      rootPath: path.resolve(root),
      description: 'Core router, dashboard UI, and AI workforce engine',
      created: null,
      kind: 'system',
      hidden: false,
      managedFolder: false,
      gitRepository: fs.existsSync(path.join(root, '.git'))
    },
    {
      id: 'test-site',
      name: 'Adaptive Router Test Project',
      rootPath: path.resolve(root, 'fixtures', 'test-site'),
      description: 'Sample Shop disposable test fixture',
      created: null,
      kind: 'fixture',
      hidden: true,
      managedFolder: false,
      gitRepository: false
    }
  ];
}

function defaultRegistry(root) {
  return {
    version: REGISTRY_VERSION,
    activeProjectId: 'adaptive-router',
    projects: builtIns(root)
  };
}

export function loadProjectRegistry(root, { persist = true } = {}) {
  const file = registryPath(root);
  let registry = defaultRegistry(root);
  if (fs.existsSync(file)) {
    try {
      const saved = read(file);
      if (saved && Array.isArray(saved.projects)) registry = saved;
    } catch {}
  }

  const builtInById = new Map(builtIns(root).map(p => [p.id, p]));
  const custom = (registry.projects || []).filter(p => !builtInById.has(p.id));
  registry = {
    version: REGISTRY_VERSION,
    activeProjectId: registry.activeProjectId || 'adaptive-router',
    projects: [...builtInById.values(), ...custom]
  };
  if (!registry.projects.some(p => p.id === registry.activeProjectId && !p.hidden)) {
    registry.activeProjectId = 'adaptive-router';
  }
  if (persist) json(file, registry);
  return registry;
}

export function listProjects(root, { includeHidden = false } = {}) {
  const registry = loadProjectRegistry(root);
  return registry.projects
    .filter(project => includeHidden || !project.hidden)
    .map(project => ({
      ...project,
      status: fs.existsSync(project.rootPath) ? 'Ready' : 'Missing',
      active: project.id === registry.activeProjectId
    }));
}

export function getProject(root, projectId, { includeHidden = true } = {}) {
  const project = loadProjectRegistry(root).projects.find(p => p.id === projectId);
  if (!project || (!includeHidden && project.hidden)) throw Error('Project not found');
  const resolved = path.resolve(project.rootPath);
  if (!fs.existsSync(resolved) || !fs.lstatSync(resolved).isDirectory()) {
    throw Error(`Project folder is unavailable: ${resolved}`);
  }
  if (fs.lstatSync(resolved).isSymbolicLink()) throw Error('Project root must not be a symbolic link');
  return { ...project, rootPath: resolved };
}

export function getActiveProject(root) {
  const registry = loadProjectRegistry(root);
  return getProject(root, registry.activeProjectId, { includeHidden: false });
}

export function setActiveProject(root, projectId) {
  const registry = loadProjectRegistry(root);
  const project = registry.projects.find(p => p.id === projectId && !p.hidden);
  if (!project) throw Error('Only a visible registered project can be selected');
  if (!fs.existsSync(project.rootPath) || !fs.lstatSync(project.rootPath).isDirectory()) {
    throw Error('Project folder is unavailable');
  }
  registry.activeProjectId = projectId;
  json(registryPath(root), registry);
  return { ...project, active: true };
}

export function defaultProjectsFolder(root) {
  return path.resolve(root, '..', 'Projects');
}

function validateProjectName(name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (clean.length < 2 || clean.length > 80) throw Error('Project name must be 2–80 characters');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._()-]*$/u.test(clean)) throw Error('Project name contains unsupported characters');
  return clean;
}

function projectSlug(name) {
  const base = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
  return `${base}-${randomUUID().slice(0, 6)}`;
}

function assertSafeProjectRoot(target, root) {
  const resolved = path.resolve(target);
  const normalized = canonical(resolved);
  const parsed = path.parse(resolved);
  const profile = process.env.USERPROFILE ? canonical(process.env.USERPROFILE) : '';
  const blocked = [
    canonical(parsed.root),
    profile,
    canonical(process.env.SystemRoot || 'C:\\Windows'),
    canonical(process.env.ProgramFiles || 'C:\\Program Files'),
    canonical(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'),
    canonical(process.env.ProgramData || 'C:\\ProgramData'),
    canonical(path.join(process.env.USERPROFILE || parsed.root, 'AppData'))
  ];
  if (blocked.some(p => p && normalized === p)) throw Error('Choose a specific project folder, not a broad system or profile folder');

  const registry = loadProjectRegistry(root);
  const duplicate = registry.projects.find(p => canonical(p.rootPath) === normalized);
  if (duplicate) throw Error(`That folder is already registered as “${duplicate.name}”`);
  return resolved;
}

export function createProject(root, { name, description = '', mode = 'create', folderPath = '' } = {}) {
  const cleanName = validateProjectName(name);
  const cleanDescription = String(description || '').trim().slice(0, 500);
  const createMode = mode === 'existing' ? 'existing' : 'create';
  const defaultBase = defaultProjectsFolder(root);
  const requested = createMode === 'create'
    ? path.join(defaultBase, cleanName)
    : String(folderPath || '').trim();
  if (!requested) throw Error('Choose an existing project folder');
  const resolved = assertSafeProjectRoot(requested, root);

  let createdFolder = false;
  if (createMode === 'create') {
    if (fs.existsSync(resolved)) {
      if (!fs.lstatSync(resolved).isDirectory()) throw Error('The project path already exists and is not a folder');
      if (fs.readdirSync(resolved).length > 0) throw Error('A non-empty folder already exists with that project name; use “Use Existing Folder” instead');
    } else {
      fs.mkdirSync(resolved, { recursive: true });
      createdFolder = true;
    }
  } else {
    if (!fs.existsSync(resolved) || !fs.lstatSync(resolved).isDirectory()) throw Error('Existing project folder was not found');
  }
  if (fs.lstatSync(resolved).isSymbolicLink()) throw Error('Project root must not be a symbolic link');

  const registry = loadProjectRegistry(root);
  if (registry.projects.some(p => p.name.toLowerCase() === cleanName.toLowerCase())) {
    if (createdFolder && fs.readdirSync(resolved).length === 0) fs.rmdirSync(resolved);
    throw Error('A project with that name is already registered');
  }

  const project = {
    id: projectSlug(cleanName),
    name: cleanName,
    rootPath: resolved,
    description: cleanDescription,
    created: new Date().toISOString(),
    kind: 'project',
    hidden: false,
    managedFolder: createMode === 'create',
    gitRepository: fs.existsSync(path.join(resolved, '.git'))
  };
  registry.projects.push(project);
  registry.activeProjectId = project.id;
  json(registryPath(root), registry);
  return { ...project, active: true };
}

// Deletes a project from the registry (and optionally its folder on disk).
// Guardrails, in order:
//  1. Built-in / system / fixture projects can never be deleted from here.
//  2. A project with a task that is still in flight cannot be deleted —
//     the caller must wait for it to finish or be cancelled first, so we
//     never orphan a running worker mid-task.
//  3. Folder removal is re-validated through the exact same
//     assertSafeProjectRoot() blocklist used at creation time, so a
//     corrupted registry entry can never be pointed at a system folder.
//  4. If the active project is deleted, activity falls back to the
//     built-in Adaptive Router System project rather than leaving the
//     dashboard pointed at a project that no longer exists.
export function deleteProject(root, projectId, { deleteFolder = false, hasActiveTask = () => false } = {}) {
  const registry = loadProjectRegistry(root);
  const project = registry.projects.find(p => p.id === projectId);
  if (!project) throw Error('Project not found');
  if (project.kind !== 'project' || project.hidden) throw Error('This project is built into Adaptive Router and cannot be deleted');
  if (hasActiveTask(project.id)) throw Error('This project has a task still in progress. Wait for it to finish (or cancel it) before deleting the project.');

  let folderRemoved = false;
  if (deleteFolder) {
    const resolved = path.resolve(project.rootPath);
    // Re-run the same safety checks used when the folder was registered,
    // so a delete can never reach outside a legitimate project folder.
    const normalized = canonical(resolved);
    const parsed = path.parse(resolved);
    const profile = process.env.USERPROFILE ? canonical(process.env.USERPROFILE) : '';
    const blocked = [
      canonical(parsed.root),
      profile,
      canonical(process.env.SystemRoot || 'C:\\Windows'),
      canonical(process.env.ProgramFiles || 'C:\\Program Files'),
      canonical(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'),
      canonical(process.env.ProgramData || 'C:\\ProgramData'),
      canonical(path.join(process.env.USERPROFILE || parsed.root, 'AppData')),
      canonical(root)
    ];
    if (blocked.some(p => p && normalized === p)) throw Error('Refusing to delete a system, profile, or Adaptive Router folder');
    if (fs.existsSync(resolved)) {
      if (fs.lstatSync(resolved).isSymbolicLink()) throw Error('Refusing to delete a symbolic link');
      fs.rmSync(resolved, { recursive: true, force: true });
      folderRemoved = true;
    }
  }

  registry.projects = registry.projects.filter(p => p.id !== projectId);
  if (registry.activeProjectId === projectId) registry.activeProjectId = 'adaptive-router';
  json(registryPath(root), registry);
  return { removed: project, folderRemoved, activeProjectId: registry.activeProjectId };
}

