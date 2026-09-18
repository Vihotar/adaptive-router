import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const rootDir = process.cwd();
const appJsPath = path.join(rootDir, 'src', 'web', 'app.js');
const indexHtmlPath = path.join(rootDir, 'src', 'web', 'index.html');

test('Autofollow UI: index.html contains all expected auto-follow toggles and split view containers', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  assert.ok(html.includes('id="toggle-autofollow"'), 'Overview / Split View autofollow toggle must exist');
  assert.ok(html.includes('id="toggle-progress-autofollow"'), 'Task Progress autofollow toggle must exist');
  assert.ok(html.includes('id="toggle-tech-autofollow"'), 'Technical Logs autofollow toggle must exist');
  assert.ok(html.includes('id="overview-logs-display"'), 'overview-logs-display container must exist');
  assert.ok(html.includes('id="btn-view-split"'), 'Split view button must exist');
});

test('Autofollow UI: app.js targets split-tech-stream and overview-tech-stream for scrolling', () => {
  const js = fs.readFileSync(appJsPath, 'utf8');

  // Both the inner scroll container (split-tech-stream) and outer wrap should be scrolled/handled
  assert.ok(js.includes("scrollToBottom('split-tech-stream')"), 'Must scroll split-tech-stream in split mode');
  assert.ok(js.includes("scrollToBottom('overview-tech-stream')"), 'Must scroll overview-tech-stream in logs mode');
  assert.ok(js.includes("scrollToBottom('split-progress-feed')"), 'Must scroll split-progress-feed in split mode');

  // syncAutoFollow function exists and synchronizes all toggles
  assert.ok(js.includes('function syncAutoFollow('), 'syncAutoFollow helper must be defined');
  assert.ok(js.includes("'toggle-autofollow'"), 'syncAutoFollow must handle toggle-autofollow');
  assert.ok(js.includes("'toggle-progress-autofollow'"), 'syncAutoFollow must handle toggle-progress-autofollow');
  assert.ok(js.includes("'toggle-tech-autofollow'"), 'syncAutoFollow must handle toggle-tech-autofollow');
});

test('Autofollow UI: functional simulation of Split View Auto-follow ON, OFF, and Re-enable', async () => {
  const rawJs = fs.readFileSync(appJsPath, 'utf8');

  // Expose test hooks into sandbox without modifying production file
  const jsCode = rawJs.replace(/\}\)\(\);?\s*$/, `
    if (typeof window !== 'undefined') {
      window.__TEST_HOOKS__ = { State, renderOverviewLogs, renderTechnicalLogsView, syncAutoFollow };
    }
  })();`);

  // Build a lightweight mock DOM environment
  const elements = new Map();

  function createMockElement(id, tagName = 'div') {
    const el = {
      id,
      tagName: tagName.toUpperCase(),
      className: '',
      innerHTML: '',
      textContent: '',
      checked: true,
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
      attributes: {},
      children: [],
      style: {},
      listeners: {},
      addEventListener(event, fn) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(fn);
      },
      dispatchEvent(event, data) {
        const fns = this.listeners[event] || [];
        for (const fn of fns) fn(data || { target: this });
      },
      setAttribute(k, v) { this.attributes[k] = v; },
      getAttribute(k) { return this.attributes[k]; },
      classList: {
        classes: new Set(),
        add(c) { this.classes.add(c); },
        remove(c) { this.classes.delete(c); },
        toggle(c, force) {
          if (force === undefined) {
            if (this.classes.has(c)) this.classes.delete(c);
            else this.classes.add(c);
          } else if (force) this.classes.add(c);
          else this.classes.delete(c);
        },
        contains(c) { return this.classes.has(c); }
      }
    };
    if (id) elements.set(id, el);
    return el;
  }

  // Pre-populate elements expected during init
  createMockElement('overview-logs-display');
  createMockElement('toggle-autofollow', 'input');
  createMockElement('toggle-progress-autofollow', 'input');
  createMockElement('toggle-tech-autofollow', 'input');
  createMockElement('btn-view-progress', 'button');
  createMockElement('btn-view-logs', 'button');
  createMockElement('btn-view-split', 'button');
  createMockElement('progress-task-select', 'select');
  createMockElement('tech-logs-full-feed');
  createMockElement('proto-toast');

  // When innerHTML is assigned to overview-logs-display, create child element mocks dynamically
  const displayContainer = elements.get('overview-logs-display');
  let rawInnerHTML = '';
  Object.defineProperty(displayContainer, 'innerHTML', {
    get() { return rawInnerHTML; },
    set(val) {
      rawInnerHTML = val;
      if (val.includes('id="split-progress-feed"')) {
        let pFeed = elements.get('split-progress-feed');
        if (!pFeed) {
          pFeed = createMockElement('split-progress-feed');
          pFeed.scrollHeight = 1200;
          pFeed.clientHeight = 400;
        }
      }
      if (val.includes('id="split-tech-stream"')) {
        let tStream = elements.get('split-tech-stream');
        if (!tStream) {
          tStream = createMockElement('split-tech-stream');
          tStream.scrollHeight = 2400;
          tStream.clientHeight = 400;
        }
      }
      if (val.includes('id="split-tech-feed"')) {
        let tFeed = elements.get('split-tech-feed');
        if (!tFeed) {
          tFeed = createMockElement('split-tech-feed');
          tFeed.scrollHeight = 400;
          tFeed.clientHeight = 400;
        }
      }
      if (val.includes('id="overview-tech-stream"')) {
        let otStream = elements.get('overview-tech-stream');
        if (!otStream) {
          otStream = createMockElement('overview-tech-stream');
          otStream.scrollHeight = 2500;
          otStream.clientHeight = 400;
        }
      }
      if (val.includes('id="overview-timeline"')) {
        let otLine = elements.get('overview-timeline');
        if (!otLine) {
          otLine = createMockElement('overview-timeline');
          otLine.scrollHeight = 1100;
          otLine.clientHeight = 400;
        }
      }
    }
  });

  const fullFeed = elements.get('tech-logs-full-feed');
  let rawFullFeedHTML = '';
  Object.defineProperty(fullFeed, 'innerHTML', {
    get() { return rawFullFeedHTML; },
    set(val) {
      rawFullFeedHTML = val;
      if (val.includes('id="tech-logs-full-stream"')) {
        let fs = elements.get('tech-logs-full-stream');
        if (!fs) {
          fs = createMockElement('tech-logs-full-stream');
          fs.scrollHeight = 3000;
          fs.clientHeight = 500;
        }
      }
    }
  });

  const mockDocument = {
    readyState: 'complete',
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelectorAll(selector) {
      return [];
    },
    addEventListener() {}
  };

  const sandbox = {
    document: mockDocument,
    window: {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
    fetch: async () => ({
      ok: true,
      json: async () => ({ workers: [], projects: [], claudeReserve: false })
    }),
    setInterval: () => 1,
    clearInterval: () => {},
    requestAnimationFrame: (cb) => { cb(); return 1; },
    EventSource: function() { this.close = () => {}; }
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);

  // Execute app.js in sandbox
  vm.runInContext(jsCode, sandbox);

  const hooks = sandbox.window.__TEST_HOOKS__;
  assert.ok(hooks, 'Hooks successfully registered');

  // Verify initial toggle states
  const toggleOverview = elements.get('toggle-autofollow');
  const toggleProgress = elements.get('toggle-progress-autofollow');
  const toggleTech = elements.get('toggle-tech-autofollow');
  assert.equal(toggleOverview.checked, true, 'Toggle default is ON');
  assert.equal(toggleProgress.checked, true);
  assert.equal(toggleTech.checked, true);

  // Set current task
  hooks.State.currentTaskId = 'test-task-1';
  hooks.State.currentTask = {
    id: 'test-task-1',
    status: 'running',
    activityLog: [
      { time: '12:00:01', title: 'Task Started' },
      { time: '12:00:05', title: 'Draft generated' }
    ],
    events: [
      { timestamp: '12:00:01', role: 'router', eventType: 'route', title: 'Task routed' },
      { timestamp: '12:00:03', role: 'builder', eventType: 'file_edit', title: 'Writing index.html' },
      { timestamp: '12:00:05', role: 'builder', eventType: 'command', title: 'node -c index.html' }
    ]
  };

  // 1. Render overview logs in Split View with autoFollow ON
  hooks.renderOverviewLogs();

  const splitProgress = elements.get('split-progress-feed');
  const splitTech = elements.get('split-tech-stream');
  assert.ok(splitProgress, 'split-progress-feed must be rendered');
  assert.ok(splitTech, 'split-tech-stream must be rendered');

  // Requirement 1: With Auto-follow ON, both feeds follow to bottom (scrollTop === scrollHeight)
  assert.equal(splitProgress.scrollTop, splitProgress.scrollHeight, 'Progress feed followed to bottom');
  assert.equal(splitTech.scrollTop, splitTech.scrollHeight, 'Technical Logs feed followed to bottom');

  // Requirement 2: With Auto-follow OFF, user scroll position is preserved when new events arrive
  toggleOverview.checked = false;
  toggleOverview.dispatchEvent('change', { target: toggleOverview });

  assert.equal(hooks.State.autoFollow, false, 'State.autoFollow is false');
  assert.equal(toggleProgress.checked, false, 'Progress toggle is synced');
  assert.equal(toggleTech.checked, false, 'Tech toggle is synced');

  // User scrolls upward manually to position 150 and 300
  splitProgress.scrollTop = 150;
  splitTech.scrollTop = 300;

  // New event arrives while Auto-follow is OFF
  hooks.State.currentTask.events.push({
    timestamp: '12:00:08',
    role: 'builder',
    eventType: 'test',
    title: 'Check 1 passed'
  });
  hooks.renderOverviewLogs();

  const updatedProgress = elements.get('split-progress-feed');
  const updatedTech = elements.get('split-tech-stream');
  assert.equal(updatedProgress.scrollTop, 150, 'Progress feed preserved upward scroll position');
  assert.equal(updatedTech.scrollTop, 300, 'Technical Logs preserved upward scroll position');

  // Requirement 3: Re-enabling Auto-follow immediately restores following behavior
  toggleOverview.checked = true;
  toggleOverview.dispatchEvent('change', { target: toggleOverview });

  assert.equal(hooks.State.autoFollow, true, 'State.autoFollow restored to true');
  assert.equal(updatedProgress.scrollTop, updatedProgress.scrollHeight, 'Progress feed jumped to newest content');
  assert.equal(updatedTech.scrollTop, updatedTech.scrollHeight, 'Technical Logs jumped to newest content');
  assert.equal(toggleProgress.checked, true, 'Progress toggle synced to ON');
  assert.equal(toggleTech.checked, true, 'Tech toggle synced to ON');

  // 4. Test Single Column Technical Logs mode ('logs')
  hooks.State.overviewLogsMode = 'logs';
  hooks.renderOverviewLogs();
  const singleTech = elements.get('overview-tech-stream');
  assert.ok(singleTech, 'overview-tech-stream rendered');
  assert.equal(singleTech.scrollTop, singleTech.scrollHeight, 'Single-col Tech Logs followed to bottom');

  // Turn OFF auto-follow in single-col mode
  hooks.syncAutoFollow(false);
  singleTech.scrollTop = 220;
  hooks.State.currentTask.events.push({ timestamp: '12:00:10', role: 'reviewer', eventType: 'review', title: 'Review pass' });
  hooks.renderOverviewLogs();
  const updatedSingleTech = elements.get('overview-tech-stream');
  assert.equal(updatedSingleTech.scrollTop, 220, 'Single-col Tech Logs preserved scroll position');

  // Re-enable in single-col mode
  hooks.syncAutoFollow(true);
  assert.equal(updatedSingleTech.scrollTop, updatedSingleTech.scrollHeight, 'Single-col Tech Logs jumped to bottom');

  // 5. Test Standalone Technical Logs View (View 5)
  hooks.renderTechnicalLogsView();
  const view5Stream = elements.get('tech-logs-full-stream');
  assert.ok(view5Stream, 'tech-logs-full-stream rendered');
  assert.equal(view5Stream.scrollTop, view5Stream.scrollHeight, 'View 5 followed to bottom with autoFollow ON');

  hooks.syncAutoFollow(false);
  view5Stream.scrollTop = 410;
  hooks.State.currentTask.events.push({ timestamp: '12:00:12', role: 'reviewer', eventType: 'complete', title: 'Done' });
  hooks.renderTechnicalLogsView();
  const updatedView5Stream = elements.get('tech-logs-full-stream');
  assert.equal(updatedView5Stream.scrollTop, 410, 'View 5 preserved position with autoFollow OFF');
});
