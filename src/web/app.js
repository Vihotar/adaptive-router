// Adaptive Router — Production Executive Dashboard Client
(function() {
  'use strict';

  // Source-of-truth fix (Post-Release Fix A): the frontend's own mirror of
  // storage.mjs's ACTIVE_TASK_STATUSES / server.mjs's re-export of the same
  // set. Kept as its own literal (rather than fetched) the same way
  // connector.mjs does on the backend, since the client has no import path
  // into src/. If the backend set ever changes, update this to match — the
  // whole point of this bug fix is that "is this task really active" must
  // be answered the same way everywhere (Overview, Office View, the API),
  // so this list must stay identical to storage.mjs's.
  const ACTIVE_TASK_STATUSES = new Set([
    'running',
    'building',
    'testing',
    'reviewing',
    'waiting_for_worker',
    'needs_cto_attention',
    'needs_human_input',
    'awaiting_plan_approval',
    'waiting_for_reviewer',
    'awaiting_approval',
    'paused_by_user'
  ]);

  // State Management
  const State = {
    activeView: 'overview',
    activeProjectId: 'adaptive-router',
    projects: [],
    workers: [],
    claudeReserve: true,
    reviewPolicy: 'independent',
    tasks: [],
    currentTaskId: null,
    currentTask: null,
    overviewLogsMode: 'split', // 'progress', 'logs', 'split'
    autoFollow: true,
    taskFilter: 'all',
    detailModalTaskId: null,
    providerLogos: {},
    techLogFilter: 'all',
    techLogSearch: '',
    taskSearch: '',
    eventSource: null,
    pollTimer: null,
    ctoAttentionItems: [],
    ctoAttentionFilter: '',
    officeProjects: [],
    officeWorkers: []
  };

  // Toast Notification System
  function showToast(message, type = 'info') {
    const toast = document.getElementById('proto-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.style.background = type === 'error' ? '#ef4444' : (type === 'success' ? '#10b981' : '#1e293b');
    toast.classList.add('show');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
      toast.classList.remove('show');
    }, 4000);
  }

  // Formatting Utilities
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Short display label for a task. The server already puts a `title` on
  // every task payload (explicit title if one was submitted, otherwise one
  // derived from the instruction — which is how tasks recorded before the
  // title field existed still get a sensible short name). window.ARTaskTitle
  // is the SAME module the server derives with, loaded over HTTP by the
  // module bootstrap in index.html; the last branch is only a degradation
  // path if that module fails to load.
  //
  // This never replaces the raw instruction anywhere — task detail, the
  // decision dialogs, the approval report and the Overview "View full
  // instruction" toggle all still read task.instruction verbatim.
  function taskTitleOf(task) {
    if (!task) return '';
    const explicit = typeof task.title === 'string' ? task.title.trim() : '';
    if (explicit) return explicit;
    const api = window.ARTaskTitle;
    if (api && typeof api.taskDisplayTitle === 'function') {
      const derived = api.taskDisplayTitle(task);
      if (derived) return derived;
    }
    const firstLine = String(task.instruction || '').split(/\r?\n/).find(l => l.trim()) || '';
    const trimmed = firstLine.trim();
    if (!trimmed) return task.id || '';
    return trimmed.length > 64 ? `${trimmed.slice(0, 64).trim()}…` : trimmed;
  }

  // Same, for a bare instruction string (CTO Inbox items store a short
  // instruction snapshot rather than a task object).
  function titleFromInstruction(instruction) {
    return taskTitleOf({ instruction });
  }

  function formatTime(isoStr) {
    if (!isoStr) return '—';
    try {
      const d = new Date(isoStr);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return isoStr;
    }
  }

  function formatRelativeTime(isoStr) {
    if (!isoStr) return '—';
    try {
      const diffSec = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
      if (diffSec < 60) return 'Just now';
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago (${formatTime(isoStr)})`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago (${formatTime(isoStr)})`;
      return `${Math.floor(diffSec / 86400)}d ago (${formatTime(isoStr)})`;
    } catch {
      return isoStr;
    }
  }

  function formatWorkerName(workerId) {
    if (!workerId) return 'Unknown';
    const id = String(workerId).toLowerCase();
    if (id.includes('cline')) return 'Cline';
    if (id.includes('claude')) return 'Claude Code';
    if (id.includes('codex')) return 'Codex';
    if (id.includes('antigravity')) return 'Antigravity';
    return workerId;
  }

  function getWorkerAvatarLetter(workerId) {
    const id = String(workerId || '').toLowerCase();
    if (id.includes('cline')) return 'C';
    if (id.includes('claude')) return 'Cl';
    if (id.includes('codex')) return 'X';
    if (id.includes('antigravity')) return 'A';
    return 'W';
  }

  function getWorkerAvatarClass(workerId) {
    const id = String(workerId || '').toLowerCase();
    if (id.includes('cline')) return 'cline';
    if (id.includes('claude')) return 'claude';
    if (id.includes('codex')) return 'codex';
    if (id.includes('antigravity')) return 'antigravity';
    return 'cline';
  }

  function formatStatusBadge(status) {
    switch (status) {
      case 'awaiting_approval':
        return { label: 'Awaiting Approval', cls: 'amber' };
      case 'running':
      case 'building':
        return { label: 'Building Draft', cls: 'blue' };
      case 'testing':
      case 'reviewing':
        return { label: 'Independent Review', cls: 'purple' };
      case 'waiting_for_worker':
      case 'waiting_for_reviewer':
        return { label: 'Waiting for Worker', cls: 'amber' };
      case 'needs_human_input':
      case 'needs_cto_attention':
        return { label: 'Decision Required', cls: 'amber' };
      case 'paused_by_user':
        return { label: 'Paused', cls: 'gray' };
      case 'approved':
      case 'completed':
        return { label: 'Completed', cls: 'green' };
      case 'failed':
        return { label: 'Failed', cls: 'red' };
      case 'cancelled':
      case 'cancelled_by_user':
        return { label: 'Cancelled', cls: 'gray' };
      case 'rejected':
        return { label: 'Rejected', cls: 'red' };
      default:
        return { label: (status || 'Unknown').replace(/_/g, ' '), cls: 'gray' };
    }
  }

  // Navigation System
  function initNavigation() {
    const navItems = document.querySelectorAll('.proto-nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const targetView = item.getAttribute('data-view');
        switchView(targetView);
      });
    });
  }

  function switchView(viewName) {
    State.activeView = viewName;
    document.querySelectorAll('.proto-nav-item').forEach(n => {
      n.classList.toggle('active', n.getAttribute('data-view') === viewName);
    });
    document.querySelectorAll('.proto-view').forEach(v => {
      v.classList.toggle('active', v.id === `view-${viewName}`);
    });

    ['toggle-autofollow', 'toggle-progress-autofollow', 'toggle-tech-autofollow'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.checked = State.autoFollow;
    });

    if (viewName === 'tasks') {
      renderTasksTable();
    } else if (viewName === 'team') {
      renderTeamView();
    } else if (viewName === 'progress') {
      renderTaskProgressView();
    } else if (viewName === 'logs') {
      renderTechnicalLogsView();
    } else if (viewName === 'cto-inbox') {
      fetchCtoAttention();
    } else if (viewName === 'office') {
      fetchOfficeView();
    }
  }

  // API Interaction Methods
  async function fetchStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      State.workers = data.workers || [];
      State.claudeReserve = data.claudeReserve !== false;
      State.reviewPolicy = ['independent', 'cto_only', 'disabled'].includes(data.reviewPolicy) ? data.reviewPolicy : 'independent';
      State.projects = data.projects || [];
      if (data.activeProject?.id) {
        State.activeProjectId = data.activeProject.id;
      }

      // Source-of-truth fix (Post-Release Fix A): data.activeRunningTask is
      // the SAME real "is a task genuinely active" answer Office View is
      // built on (server-side, backed by ACTIVE_TASK_STATUSES via
      // getActiveTask()/getActiveRunningTask() — never inferred or
      // assumed). Overview must be driven by that same answer instead of
      // guessing from whichever task happens to be newest, which is what
      // let a cancelled/completed/failed task keep showing as "Current
      // Task" indefinitely: fetchTasks() used to pick State.tasks[0] once
      // and never re-evaluate it once that task's status went terminal.
      //
      // So this is now authoritative in both directions: when the backend
      // reports a real active task, follow it (even overriding a stale
      // selection — e.g. the previously-active task just finished and a
      // new one started); when it reports none, clear the selection so the
      // Overview card empties out to "No active task" rather than
      // continuing to display whatever was last selected.
      if (data.activeRunningTask) {
        if (State.currentTaskId !== data.activeRunningTask) {
          State.currentTaskId = data.activeRunningTask;
          State.currentTask = null; // force a fresh fetchTaskDetails render
        }
      } else if (State.currentTaskId) {
        State.currentTaskId = null;
        State.currentTask = null;
        renderOverviewTask();
      }

      renderHeader();
      renderPlatformLimits();
      renderTeamView();
    } catch (err) {
      console.warn('Error fetching /api/status:', err);
    }
  }

  // Persistent CTO Attention / Inbox — lightweight poll (piggybacks on the
  // same 3s cadence as fetchStatus/fetchTasks, no separate timer) plus an
  // explicit fetch when the CTO navigates to the Inbox view. The inbox
  // itself is the source of truth on the server; this just mirrors it for
  // display and updates the sidebar badge, matching the handover doc's
  // instruction not to make correctness depend on any particular UI popup.
  async function fetchCtoAttention() {
    try {
      const res = await fetch('/api/cto/attention/list');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      State.ctoAttentionItems = Array.isArray(data.items) ? data.items : [];
      renderCtoInboxBadge();
      if (State.activeView === 'cto-inbox') renderCtoInboxList();
    } catch (err) {
      console.warn('Error fetching CTO attention inbox:', err);
    }
  }

  function renderCtoInboxBadge() {
    const badge = document.getElementById('nav-count-cto-inbox');
    if (!badge) return;
    const unread = State.ctoAttentionItems.filter(i => i.state === 'unread').length;
    if (unread > 0) {
      badge.textContent = String(unread);
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  function renderCtoInboxList() {
    const container = document.getElementById('cto-inbox-list');
    if (!container) return;
    const filter = State.ctoAttentionFilter;
    const items = filter ? State.ctoAttentionItems.filter(i => i.state === filter) : State.ctoAttentionItems;
    if (items.length === 0) {
      container.innerHTML = `<div class="cto-inbox-empty">No attention items${filter ? ` (${escapeHtml(filter)})` : ''}. AR is working independently.</div>`;
      return;
    }
    container.innerHTML = items.map(item => `
      <div class="cto-inbox-item cto-inbox-state-${escapeHtml(item.state)}" data-id="${escapeHtml(item.id)}">
        <div class="cto-inbox-item-header">
          <span class="cto-inbox-item-title">${escapeHtml(item.title || item.eventType)}</span>
          <span class="cto-inbox-item-state-badge">${escapeHtml(item.state)}</span>
        </div>
        ${item.instruction ? `<div class="cto-inbox-item-instruction" title="${escapeHtml(item.instruction)}">${escapeHtml(titleFromInstruction(item.instruction))}</div>` : ''}
        ${item.reason ? `<div class="cto-inbox-item-reason">${escapeHtml(item.reason)}</div>` : ''}
        <div class="cto-inbox-item-action">Action: ${escapeHtml(item.action || 'Review Result')}</div>
        <div class="cto-inbox-item-footer">
          <span class="cto-inbox-item-time">${new Date(item.createdAt).toLocaleString()}</span>
          <div class="cto-inbox-item-buttons">
            ${item.taskId ? `<button type="button" class="btn btn-secondary cto-inbox-goto-task" data-task-id="${escapeHtml(item.taskId)}">View Task</button>` : ''}
            ${item.state === 'unread' ? `<button type="button" class="btn btn-secondary cto-inbox-ack" data-id="${escapeHtml(item.id)}">Acknowledge</button>` : ''}
            ${item.state !== 'resolved' ? `<button type="button" class="btn btn-secondary cto-inbox-resolve" data-id="${escapeHtml(item.id)}">Mark Resolved</button>` : ''}
          </div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.cto-inbox-goto-task').forEach(btn => {
      btn.addEventListener('click', () => {
        State.currentTaskId = btn.getAttribute('data-task-id');
        switchView('overview');
        fetchTaskDetails(State.currentTaskId);
      });
    });
    container.querySelectorAll('.cto-inbox-ack').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await fetch(`/api/cto/attention/${encodeURIComponent(btn.getAttribute('data-id'))}/ack`, { method: 'POST' });
          await fetchCtoAttention();
        } catch (err) { console.warn('Failed to acknowledge attention item:', err); }
      });
    });
    container.querySelectorAll('.cto-inbox-resolve').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await fetch(`/api/cto/attention/${encodeURIComponent(btn.getAttribute('data-id'))}/resolve`, { method: 'POST' });
          await fetchCtoAttention();
        } catch (err) { console.warn('Failed to resolve attention item:', err); }
      });
    });
  }

  function initCtoInboxControls() {
    document.querySelectorAll('.cto-inbox-filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.cto-inbox-filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        State.ctoAttentionFilter = chip.getAttribute('data-state') || '';
        renderCtoInboxList();
      });
    });
  }

  // Office View — real multi-project runtime state, visualized as a set of
  // worker desks plus per-project activity cards. Reads GET /api/office-view,
  // which is the single source of truth for "is a worker genuinely running
  // right now" (never invented/faked activity — see server.mjs comments on
  // that endpoint). Only fetched when the Office View is the active tab, or
  // on the shared 3s poll while it stays the active tab, matching the same
  // "don't burn quota" pattern as the CTO Inbox badge.
  async function fetchOfficeView() {
    try {
      const res = await fetch('/api/office-view');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      State.officeProjects = Array.isArray(data.projects) ? data.projects : [];
      State.officeWorkers = Array.isArray(data.workers) ? data.workers : [];
      // Official provider logo files the CTO has supplied, as reported by
      // the server. Empty until files are placed in src/web/assets/logos/,
      // in which case every seat uses its neutral fallback node.
      State.providerLogos = (data.providerLogos && typeof data.providerLogos === 'object') ? data.providerLogos : {};
      renderOfficeFloor();
      renderOfficeProjects();
      renderOfficeFlowStats();
      renderOfficeSystemStatus();
      renderOfficeRecentActivity();
    } catch (err) {
      console.warn('Error fetching /api/office-view:', err);
    }
  }

  function officeWorkerCurrentTask(workerId) {
    // A worker desk shows the task it is actively executing right now —
    // find the project entry (if any) whose activeWorker is this worker.
    for (const p of State.officeProjects) {
      if (p.task && p.task.isWorkerRunning && p.task.activeWorker === workerId) {
        return { project: p, task: p.task };
      }
    }
    return null;
  }

  // Business-facing Office View seat layout — 7 fixed radial positions around
  // the AR hub, matching the CTO-approved reference image and roster
  // (2026-09-17 Fix B revision): Claude, Codex, Antigravity, Grok, Gemini,
  // NVIDIA NIM, OpenRouter. Cline is deliberately NOT a visible seat here —
  // it may still exist as internal execution plumbing in workers.json, but
  // per the approved brief it must not appear as an Office View employee.
  // Only claude-code/codex/antigravity have a real backing worker today;
  // the other 4 (Grok, Gemini, NVIDIA NIM, OpenRouter) show an honest
  // "Available" / not-yet-connected state with no invented activity — see
  // the `live` flag below. Angles are degrees clockwise from the top (12
  // o'clock = -90 in standard SVG/canvas angle convention), evenly spaced.
  const OFFICE_SEATS = [
    { id: 'claude-code', label: 'Claude', provider: 'Anthropic', initials: 'CL', backingWorkerId: 'claude-code', live: true, angleDeg: -90, accent: '#d97706' },
    { id: 'codex', label: 'Codex', provider: 'OpenAI', initials: 'CX', backingWorkerId: 'codex', live: true, angleDeg: -38.57, accent: '#16a34a' },
    { id: 'antigravity', label: 'Antigravity', provider: 'Google', initials: 'AG', backingWorkerId: 'antigravity', live: true, angleDeg: 12.86, accent: '#4f46e5' },
    { id: 'grok', label: 'Grok', provider: 'xAI', initials: 'GK', backingWorkerId: null, live: false, angleDeg: 64.29, accent: '#475569' },
    { id: 'nvidia-nim', label: 'NVIDIA NIM', provider: 'NVIDIA', initials: 'NV', backingWorkerId: null, live: false, angleDeg: 115.71, accent: '#16a34a' },
    { id: 'openrouter', label: 'OpenRouter', provider: 'OpenRouter', initials: 'OR', backingWorkerId: null, live: false, angleDeg: 167.14, accent: '#9333ea' },
    { id: 'gemini', label: 'Gemini', provider: 'Google', initials: 'GM', backingWorkerId: null, live: false, angleDeg: 218.57, accent: '#2563eb' }
  ];

  // Final UI Closure item 3 — provider nodes replace the previous robot
  // illustrations. Two render paths, and no third:
  //
  //  1. An OFFICIAL asset the CTO supplied in src/web/assets/logos/ (see the
  //     README there). It is rendered exactly as supplied — letterboxed with
  //     object-fit: contain so the original proportions are preserved, never
  //     stretched, never recolored, never traced.
  //  2. A neutral fallback node when no such file exists: the provider's
  //     short initials plus a plain generic node glyph. AR does not draw an
  //     imitation of anyone's trademark, so this is deliberately generic —
  //     it identifies the seat without pretending to be a brand mark.
  //
  // Nothing here rotates: a logo must sit upright regardless of where the
  // seat falls on the radial layout.
  function renderProviderMark(seat, isLive, isBusy, logoSrc) {
    const glow = isBusy ? `filter: drop-shadow(0 0 6px ${seat.accent}66);` : '';
    if (logoSrc) {
      return `
        <img class="office-seat-logo" src="${escapeHtml(logoSrc)}" alt="" aria-hidden="true"
             style="${glow}" loading="lazy" />
      `;
    }
    return `
      <span class="office-seat-fallback" style="${glow}" aria-hidden="true">
        <svg class="office-seat-fallback-glyph" viewBox="0 0 32 32" focusable="false">
          <rect x="6.5" y="6.5" width="19" height="19" rx="5"
                fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.55" />
          <circle cx="16" cy="16" r="3.6" fill="currentColor" opacity="0.85" />
          <path d="M16 6.5 V2.5 M16 25.5 V29.5 M6.5 16 H2.5 M25.5 16 H29.5"
                stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.5" />
        </svg>
        <span class="office-seat-initials">${escapeHtml(seat.initials)}</span>
      </span>
    `;
  }

  function renderOfficeFloor() {
    const seatsLayer = document.getElementById('office-seats-layer');
    const svgLayer = document.getElementById('office-connectors-svg');
    const hub = document.getElementById('office-hub');
    const hubLabel = document.getElementById('office-hub-label');
    const hubAttention = document.getElementById('office-hub-attention');
    if (!seatsLayer || !svgLayer) return;

    if (State.officeWorkers.length === 0) {
      seatsLayer.innerHTML = '<div class="office-empty">No workers configured.</div>';
      svgLayer.innerHTML = '';
      return;
    }

    const center = 500;
    const radius = 320; // kept well inside the 1000x1000 viewBox so pods don't clip on narrow screens
    let anyBusy = false;
    // Any task genuinely waiting on the CTO (not just a worker being idle) —
    // drives the hub's attention indicator. Never shown unless real task
    // state says so (see /api/office-view's waitingOnCto field).
    const anyWaitingOnCto = State.officeProjects.some(p => p.task && p.task.waitingOnCto);

    const seatGeom = OFFICE_SEATS.map(seat => {
      const rad = (seat.angleDeg * Math.PI) / 180;
      return { seat, x: center + radius * Math.cos(rad), y: center + radius * Math.sin(rad) };
    });

    const seatsHtml = seatGeom.map(({ seat, x, y }) => {
      const backingWorker = seat.backingWorkerId ? State.officeWorkers.find(w => w.id === seat.backingWorkerId) : null;
      const isLive = seat.live && Boolean(backingWorker);
      const busy = isLive && !!backingWorker.busy;
      const current = busy ? officeWorkerCurrentTask(backingWorker.id) : null;
      if (busy) anyBusy = true;

      const name = seat.label;

      let stateLabel, stateClass;
      if (!isLive) {
        stateLabel = 'Available';
        stateClass = 'available';
      } else {
        const enabled = backingWorker.userEnabled !== false;
        const reachable = backingWorker.status === 'Available' || backingWorker.status === 'Reserved';
        if (!enabled) {
          stateLabel = 'Disabled';
          stateClass = 'off';
        } else if (!reachable) {
          stateLabel = backingWorker.status || 'Unavailable';
          stateClass = 'off';
        } else if (busy) {
          stateLabel = current?.task?.status === 'reviewing' ? 'Reviewing' : 'Building';
          stateClass = 'busy';
        } else {
          stateLabel = 'Idle';
          stateClass = 'idle';
        }
      }

      // Distinct visual states, all derived from real runtime data and
      // never from decoration: reviewing gets its own ring animation rather
      // than sharing the building pulse, and a task genuinely waiting on the
      // CTO turns this seat's ring amber. Both fall straight out of the
      // task status /api/office-view already reports.
      const isReviewing = busy && current?.task?.status === 'reviewing';
      const needsAttention = isLive && State.officeProjects.some(p =>
        p.task && p.task.waitingOnCto &&
        (p.task.builderWorker === backingWorker.id || p.task.reviewerWorker === backingWorker.id));

      const leftPct = ((x / 1000) * 100).toFixed(2);
      const topPct = ((y / 1000) * 100).toFixed(2);
      // Only ever a file the CTO actually placed in src/web/assets/logos/;
      // the server reports which of those exist (see listProviderLogoAssets).
      const logoSrc = State.providerLogos[seat.id] || null;
      const interactiveAttrs = isLive ? 'role="button" tabindex="0"' : 'aria-disabled="true"';
      const taskLine = (busy && current?.task)
        ? `<div class="office-pod-task" title="${escapeHtml(current.task.instruction || '')}">${escapeHtml(taskTitleOf(current.task))}</div>`
        : '';

      return `
        <div class="office-seat-node ${busy ? 'seat-busy' : ''} ${isReviewing ? 'seat-reviewing' : ''} ${needsAttention ? 'seat-attention' : ''} ${isLive ? 'seat-live' : 'seat-non-live'}"
             id="office-seat-${escapeHtml(seat.id)}"
             data-worker-id="${escapeHtml(backingWorker?.id || seat.id)}"
             data-live="${isLive ? '1' : '0'}"
             style="left: ${leftPct}%; top: ${topPct}%; --seat-accent: ${escapeHtml(seat.accent)};"
             ${interactiveAttrs}
             aria-label="${escapeHtml(name)} workstation — ${escapeHtml(stateLabel)}">
          <div class="office-pod">
            <div class="office-pod-ring"></div>
            <div class="office-pod-avatar-wrap">
              ${renderProviderMark(seat, isLive, busy, logoSrc)}
              ${busy ? '<span class="office-desk-activity-dot"></span>' : ''}
            </div>
          </div>
          <div class="office-pod-plate">
            <span class="office-seat-name">${escapeHtml(name)}</span>
            ${seat.provider && seat.provider !== name ? `<span class="office-seat-provider">${escapeHtml(seat.provider)}</span>` : ''}
            <span class="office-seat-state office-seat-state-${stateClass}">${escapeHtml(stateLabel)}</span>
          </div>
          ${taskLine}
        </div>
      `;
    }).join('');
    seatsLayer.innerHTML = seatsHtml;

    // Connectors: a dashed line per seat plus a small moving "task packet"
    // dot on any connector that's genuinely active, so routing reads as
    // motion rather than just a static arrow. Only ever animated when the
    // real backing worker is actually busy — never decorative-only.
    const lines = seatGeom.map(({ seat, x, y }) => {
      const backingWorker = seat.backingWorkerId ? State.officeWorkers.find(w => w.id === seat.backingWorkerId) : null;
      const isLive = seat.live && Boolean(backingWorker);
      const busy = isLive && !!backingWorker.busy;
      const current = busy ? officeWorkerCurrentTask(backingWorker.id) : null;
      const isReviewing = current?.task?.status === 'reviewing';
      let cls = 'office-connector-line';
      let marker = '';
      let packet = '';
      if (!isLive) {
        cls += ' connector-dormant';
      } else if (busy) {
        cls += isReviewing ? ' connector-active-return' : ' connector-active-out';
        marker = isReviewing ? 'url(#office-arrow-return)' : 'url(#office-arrow-out)';
        // Packet travels center->seat while building, seat->center while
        // reviewing (work goes out to build, comes back in for review).
        const [px1, py1, px2, py2] = isReviewing ? [x, y, center, center] : [center, center, x, y];
        packet = `
          <circle class="office-task-packet ${isReviewing ? 'packet-return' : 'packet-out'}" r="7">
            <animateMotion dur="1.6s" repeatCount="indefinite" path="M${px1},${py1} L${px2},${py2}" />
          </circle>
        `;
      } else {
        cls += ' connector-dormant';
      }
      const markerAttr = marker ? `marker-end="${marker}"` : '';
      return `<line class="${cls}" x1="${center}" y1="${center}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" ${markerAttr} />${packet}`;
    }).join('');
    svgLayer.innerHTML = `
      <defs>
        <marker id="office-arrow-out" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 Z" fill="var(--primary)"></path>
        </marker>
        <marker id="office-arrow-return" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 Z" fill="var(--success)"></path>
        </marker>
      </defs>
      ${lines}
    `;

    if (hub) hub.classList.toggle('hub-active', anyBusy);
    if (hub) hub.classList.toggle('hub-attention', anyWaitingOnCto);
    if (hubAttention) hubAttention.hidden = !anyWaitingOnCto;
    if (hubLabel) hubLabel.textContent = anyWaitingOnCto ? 'CTO Decision Needed' : (anyBusy ? 'Routing Tasks' : 'Orchestrator Ready');

    seatsLayer.querySelectorAll('.office-seat-node[data-live="1"]').forEach(node => {
      const open = () => openOfficeWorkerModal(node.getAttribute('data-worker-id'));
      node.addEventListener('click', open);
      node.addEventListener('keypress', (e) => { if (e.key === 'Enter' || e.key === ' ') open(); });
    });
  }

  // Left panel: honest counts of tasks by pipeline stage, derived from real
  // task state across all registered projects — never invented totals.
  function renderOfficeFlowStats() {
    const el = document.getElementById('office-flow-stats');
    if (!el) return;
    let building = 0, reviewing = 0, waiting = 0, idle = 0;
    for (const p of State.officeProjects) {
      if (!p.task) { idle++; continue; }
      if (p.task.isWorkerRunning) {
        if (p.task.status === 'reviewing') reviewing++; else building++;
      } else if (p.task.waitingOnCto) {
        waiting++;
      } else {
        idle++;
      }
    }
    const rows = [
      { label: 'Building', count: building, cls: 'busy' },
      { label: 'Reviewing', count: reviewing, cls: 'busy' },
      { label: 'Needs CTO', count: waiting, cls: 'attention' },
      { label: 'No Active Task', count: idle, cls: 'idle' }
    ];
    el.innerHTML = rows.map(r => `
      <div class="office-stat-row">
        <span class="office-stat-dot office-stat-dot-${r.cls}"></span>
        <span class="office-stat-label">${escapeHtml(r.label)}</span>
        <span class="office-stat-count">${r.count}</span>
      </div>
    `).join('');
  }

  // Right panel: real worker/system counts — enabled/disabled from
  // workers.json state, CTO Inbox count from the actual inbox badge.
  function renderOfficeSystemStatus() {
    const el = document.getElementById('office-status-list');
    if (!el) return;
    const active = State.officeWorkers.filter(w => w.userEnabled !== false).length;
    const disabled = State.officeWorkers.filter(w => w.userEnabled === false).length;
    const waitingCount = State.officeProjects.filter(p => p.task?.waitingOnCto).length;
    const rows = [
      { label: 'Router', value: 'Online', ok: true },
      { label: 'Workers', value: `${active} active, ${disabled} disabled`, ok: true },
      { label: 'Registered Projects', value: String(State.officeProjects.length), ok: true },
      { label: 'CTO Inbox', value: waitingCount > 0 ? `${waitingCount} pending` : 'Clear', ok: waitingCount === 0 }
    ];
    el.innerHTML = rows.map(r => `
      <div class="office-status-row">
        <span class="office-status-icon">${r.ok ? '✓' : '!'}</span>
        <span class="office-status-label">${escapeHtml(r.label)}</span>
        <span class="office-status-value ${r.ok ? '' : 'office-status-value-warn'}">${escapeHtml(r.value)}</span>
      </div>
    `).join('');
  }

  // Bottom-left panel: a short real recent-activity feed sourced from the
  // same per-project task state already on hand — not a separate log
  // fetch, and never fabricated when there's nothing to show.
  function renderOfficeRecentActivity() {
    const el = document.getElementById('office-recent-activity');
    if (!el) return;
    const items = [];
    for (const p of State.officeProjects) {
      if (!p.task) continue;
      let desc;
      if (p.task.isWorkerRunning) {
        desc = `${formatWorkerName(p.task.activeWorker)} ${p.task.status === 'reviewing' ? 'reviewing' : 'building'} on ${p.projectName}`;
      } else if (p.task.waitingOnCto) {
        desc = `Waiting on CTO — ${p.projectName}`;
      } else {
        continue;
      }
      items.push(desc);
    }
    if (items.length === 0) {
      el.innerHTML = '<div class="office-empty office-empty-inline">No active work right now.</div>';
      return;
    }
    el.innerHTML = items.map(desc => `<div class="office-activity-row">${escapeHtml(desc)}</div>`).join('');
  }

  function renderOfficeProjects() {
    const grid = document.getElementById('office-projects-grid');
    if (!grid) return;
    if (State.officeProjects.length === 0) {
      grid.innerHTML = '<div class="office-empty">No registered projects yet.</div>';
      return;
    }
    grid.innerHTML = State.officeProjects.map(p => {
      if (!p.task) {
        return `
          <div class="office-project-card office-project-idle">
            <div class="office-project-header">
              <span class="office-project-name">${escapeHtml(p.projectName)}</span>
              <span class="badge gray">Idle</span>
            </div>
            <div class="office-project-empty">No active task</div>
          </div>
        `;
      }
      const t = p.task;
      if (t.isWorkerRunning) {
        const badge = formatStatusBadge(t.status);
        return `
          <div class="office-project-card office-project-active">
            <div class="office-project-header">
              <span class="office-project-name">${escapeHtml(p.projectName)}</span>
              <span class="badge ${badge.cls}">${escapeHtml(badge.label)}</span>
            </div>
            <div class="office-project-instruction" title="${escapeHtml(t.instruction || '')}">${escapeHtml(taskTitleOf(t))}</div>
            <div class="office-project-worker-row">
              <span class="office-project-worker-label">Active:</span>
              <span class="office-project-worker-name">${escapeHtml(formatWorkerName(t.activeWorker))}</span>
              <span class="office-desk-activity-dot office-desk-activity-dot-inline"></span>
            </div>
          </div>
        `;
      }
      if (t.waitingOnCto) {
        return `
          <div class="office-project-card office-project-attention">
            <div class="office-project-attention-banner">⚠ CTO ATTENTION REQUIRED</div>
            <div class="office-project-header">
              <span class="office-project-name">${escapeHtml(p.projectName)}</span>
            </div>
            <div class="office-project-attention-row" title="${escapeHtml(t.instruction || '')}"><strong>Task:</strong> ${escapeHtml(taskTitleOf(t))}</div>
            <div class="office-project-attention-row"><strong>Status:</strong> ${escapeHtml((t.status || '').replace(/_/g, ' '))}</div>
            <div class="office-project-attention-row"><strong>Action:</strong> Review in CTO Inbox</div>
            <button type="button" class="btn btn-secondary office-project-goto-inbox">View CTO Inbox</button>
          </div>
        `;
      }
      // Any other non-running, non-waiting active status (e.g. waiting_for_worker) —
      // show it plainly without implying a worker is busy.
      const badge = formatStatusBadge(t.status);
      return `
        <div class="office-project-card office-project-idle">
          <div class="office-project-header">
            <span class="office-project-name">${escapeHtml(p.projectName)}</span>
            <span class="badge ${badge.cls}">${escapeHtml(badge.label)}</span>
          </div>
          <div class="office-project-instruction" title="${escapeHtml(t.instruction || '')}">${escapeHtml(taskTitleOf(t))}</div>
        </div>
      `;
    }).join('');

    grid.querySelectorAll('.office-project-goto-inbox').forEach(btn => {
      btn.addEventListener('click', () => switchView('cto-inbox'));
    });
  }

  function openOfficeWorkerModal(workerId) {
    const worker = State.officeWorkers.find(w => w.id === workerId);
    if (!worker) return;
    const busy = !!worker.busy;
    const current = busy ? officeWorkerCurrentTask(workerId) : null;
    const avatarClass = getWorkerAvatarClass(workerId);
    const avatarLetter = getWorkerAvatarLetter(workerId);
    const name = formatWorkerName(workerId);
    const enabled = worker.userEnabled !== false;
    const reachable = worker.status === 'Available' || worker.status === 'Reserved';

    const body = document.getElementById('office-worker-modal-body');
    if (!body) return;
    body.innerHTML = `
      <div class="ai-role-title-group" style="margin-bottom: 1rem;">
        <div class="ai-avatar ${avatarClass}">${avatarLetter}</div>
        <div>
          <h3 class="ai-name">${escapeHtml(name)}</h3>
          <span class="ai-platform">${escapeHtml(worker.platform || '')}</span>
        </div>
      </div>
      <div class="team-stat-row">
        <span class="team-stat-k">CTO Toggle</span>
        <span class="badge ${enabled ? 'green' : 'gray'}">${enabled ? 'Enabled' : 'Disabled'}</span>
      </div>
      <div class="team-stat-row">
        <span class="team-stat-k">Platform Status</span>
        <span class="badge ${reachable ? 'green' : 'gray'}">${escapeHtml(worker.status || 'Unknown')}</span>
      </div>
      <div class="team-stat-row">
        <span class="team-stat-k">Current Role</span>
        <span class="team-stat-v">${busy ? (current?.task?.status === 'reviewing' ? 'Reviewer' : 'Builder') : 'Idle / Standby'}</span>
      </div>
      <div class="team-stat-row">
        <span class="team-stat-k">Note</span>
        <span class="team-stat-v">${escapeHtml(worker.note || '')}</span>
      </div>
      ${worker.health && worker.health !== 'healthy' ? `
        <div class="team-stat-row">
          <span class="team-stat-k">Health</span>
          <span class="badge amber">${escapeHtml(worker.health)}</span>
        </div>
        <div class="team-stat-row">
          <span class="team-stat-k">Health Detail</span>
          <span class="team-stat-v">${escapeHtml(worker.healthDetail || '')}</span>
        </div>
      ` : ''}
      ${current ? `
        <div class="team-stat-row">
          <span class="team-stat-k">Project</span>
          <span class="team-stat-v">${escapeHtml(current.project.projectName)}</span>
        </div>
        <div class="team-stat-row">
          <span class="team-stat-k">Current Role</span>
          <span class="team-stat-v">${escapeHtml(current.task.status === 'reviewing' ? 'Reviewer' : 'Builder')}</span>
        </div>
        <div class="team-stat-row">
          <span class="team-stat-k">Task</span>
          <span class="team-stat-v" title="${escapeHtml(current.task.instruction || '')}">${escapeHtml(taskTitleOf(current.task))}</span>
        </div>
        <div class="team-stat-row">
          <span class="team-stat-k">Task Status</span>
          <span class="team-stat-v">${escapeHtml((current.task.status || '').replace(/_/g, ' '))}</span>
        </div>
      ` : `
        <div class="team-stat-row">
          <span class="team-stat-k">Current Task</span>
          <span class="team-stat-v" style="color: var(--text-muted);">None — idle</span>
        </div>
      `}
    `;
    document.getElementById('office-worker-modal').classList.add('active');
  }

  function initOfficeViewControls() {
    const modal = document.getElementById('office-worker-modal');
    const close = () => modal && modal.classList.remove('active');
    document.getElementById('office-worker-modal-close')?.addEventListener('click', close);
    document.getElementById('office-worker-modal-close-btn')?.addEventListener('click', close);
    modal?.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.getElementById('office-view-inbox-link')?.addEventListener('click', () => switchView('cto-inbox'));
  }

  async function fetchTasks() {
    try {
      const res = await fetch(`/api/tasks?project=${encodeURIComponent(State.activeProjectId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tasks = await res.json();
      State.tasks = Array.isArray(tasks) ? tasks : [];

      // Update badge counts in sidebar
      const navCountTasks = document.getElementById('nav-count-tasks');
      if (navCountTasks) navCountTasks.textContent = State.tasks.length;

      // Source-of-truth fix (Post-Release Fix A): this used to select
      // State.tasks[0] (the newest task, whatever its status) as the
      // Overview "current task" any time nothing was already selected —
      // with nothing ever clearing that selection afterward, a task that
      // later reached a terminal status (cancelled/completed/failed/
      // rejected) just stayed pinned as "Current Task" forever, which is
      // exactly the bug reported: Overview kept showing a cancelled task
      // as active while Office View correctly showed idle.
      //
      // fetchStatus() (its data.activeRunningTask, backed by the same
      // ACTIVE_TASK_STATUSES check Office View uses) is now the
      // authoritative source for "is anything really active" and owns
      // clearing State.currentTaskId when nothing is. This fallback is
      // only a same-tick convenience for the very first load, before
      // fetchStatus() has necessarily run yet — and it must apply the same
      // active/terminal check, not just grab the newest task unconditionally,
      // so a page load that lands directly on a terminal task never shows
      // it as current even momentarily.
      if (!State.currentTaskId && State.tasks.length > 0 && ACTIVE_TASK_STATUSES.has(State.tasks[0].status)) {
        State.currentTaskId = State.tasks[0].id;
      }

      // Populate progress task selector dropdown
      updateProgressTaskSelect();

      // Render table if visible
      renderTasksTable();

      // Fetch details of current task; otherwise make sure the Overview
      // card reflects "no active task" rather than stale prior content.
      if (State.currentTaskId) {
        await fetchTaskDetails(State.currentTaskId);
      } else {
        State.currentTask = null;
        renderOverviewTask();
      }
    } catch (err) {
      console.warn('Error fetching /api/tasks:', err);
    }
  }

  async function fetchTaskDetails(taskId) {
    if (!taskId) return;
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`);
      if (!res.ok) return;
      const detail = await res.json();
      State.currentTask = detail;

      // Connect SSE if not already connected
      connectTaskEventStream(taskId);

      // Render Views
      renderOverviewTask();
      renderOverviewLogs();
      renderDecisionContainer();

      if (State.activeView === 'progress') renderTaskProgressView();
      if (State.activeView === 'logs') renderTechnicalLogsView();
    } catch (err) {
      console.warn('Error fetching task details:', err);
    }
  }

  // Real-time Event Stream (SSE)
  function connectTaskEventStream(taskId) {
    if (State.eventSource && State.eventSource._taskId === taskId) {
      return; // already connected
    }
    if (State.eventSource) {
      State.eventSource.close();
      State.eventSource = null;
    }

    try {
      const es = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/stream`);
      es._taskId = taskId;

      es.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          handleLiveEvent(payload);
        } catch {}
      };

      es.onerror = () => {
        es.close();
        State.eventSource = null;
      };

      State.eventSource = es;
    } catch (err) {
      console.warn('SSE connection failed:', err);
    }
  }

  function handleLiveEvent(payload) {
    if (!payload) return;
    if (!State.currentTask) return;

    if (payload.type === 'activity' && payload.item) {
      State.currentTask.activityLog = State.currentTask.activityLog || [];
      State.currentTask.activityLog.push(payload.item);
      renderOverviewLogs();
      if (State.activeView === 'progress') renderTaskProgressView();
    } else if (payload.type === 'worker_event' && payload.event) {
      State.currentTask.events = State.currentTask.events || [];
      State.currentTask.events.push(payload.event);
      if (payload.event.eventType === 'token_usage') {
        if (payload.event.metadata?.tokenUsage) {
          State.currentTask.tokenUsage = payload.event.metadata.tokenUsage;
        }
        renderOverviewTask();
      }
      renderOverviewLogs();
      if (State.activeView === 'logs') renderTechnicalLogsView();
    } else if (payload.type === 'token_usage' && payload.tokenUsage) {
      State.currentTask.tokenUsage = payload.tokenUsage;
      renderOverviewTask();
    } else if (payload.type === 'status') {
      State.currentTask.status = payload.status;
      // Source-of-truth fix (Post-Release Fix A): don't wait for the next
      // fetchStatus() poll (up to 3s away) to notice a task just went
      // terminal — the live SSE push is the fastest signal available, and
      // the user's verification steps require Overview to change
      // "immediately". Clear the current-task selection the instant a
      // terminal status arrives over the stream, same rule fetchStatus()
      // applies: not in ACTIVE_TASK_STATUSES means it is no longer current.
      if (!ACTIVE_TASK_STATUSES.has(payload.status)) {
        if (State.eventSource) {
          State.eventSource.close();
          State.eventSource = null;
        }
        State.currentTaskId = null;
        State.currentTask = null;
      }
      renderOverviewTask();
      renderDecisionContainer();
    }
  }

  // Header Rendering & Bindings
  function renderHeader() {
    // Project selector
    const sel = document.getElementById('project-selector');
    if (sel && State.projects.length > 0) {
      sel.innerHTML = State.projects.map(p =>
        `<option value="${escapeHtml(p.id)}" ${p.id === State.activeProjectId ? 'selected' : ''}>${escapeHtml(p.name || p.id)}</option>`
      ).join('');
    }

    // Claude Reserve header toggle
    const toggle = document.getElementById('header-claude-reserve-toggle');
    const label = document.getElementById('header-claude-reserve-label');
    if (toggle) toggle.checked = State.claudeReserve;
    if (label) {
      label.textContent = State.claudeReserve ? 'RESERVE ON' : 'RESERVE OFF';
      label.style.color = State.claudeReserve ? '#8b5cf6' : '#64748b';
    }

    // Reviewer Policy select
    const reviewPolicySelect = document.getElementById('review-policy-select');
    if (reviewPolicySelect && reviewPolicySelect.value !== State.reviewPolicy) {
      reviewPolicySelect.value = State.reviewPolicy;
    }
  }

  function initHeaderControls() {
    // Project selector change
    const sel = document.getElementById('project-selector');
    if (sel) {
      sel.addEventListener('change', async (e) => {
        const projectId = e.target.value;
        try {
          const res = await fetch('/api/projects/active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId })
          });
          if (res.ok) {
            State.activeProjectId = projectId;
            State.currentTaskId = null;
            State.currentTask = null;
            showToast(`Switched project to ${projectId}`, 'success');
            await fetchTasks();
          }
        } catch (err) {
          showToast('Failed to switch project', 'error');
        }
      });
    }

    // Claude Reserve toggle
    const toggle = document.getElementById('header-claude-reserve-toggle');
    if (toggle) {
      toggle.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        try {
          const res = await fetch('/api/claude-reserve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
          });
          if (res.ok) {
            State.claudeReserve = enabled;
            renderHeader();
            renderPlatformLimits();
            renderTeamView();
            showToast(`Claude Reserve Mode ${enabled ? 'enabled' : 'disabled'}`, 'success');
          }
        } catch (err) {
          showToast('Failed to toggle Claude Reserve', 'error');
        }
      });
    }
  }

  // View 1: Overview — Platform Limits & Availability
  function renderPlatformLimits() {
    const findW = (id) => State.workers.find(w => w.id === id);

    // Post-Release Fix C: the two rows that replaced the fake usage bar.
    // Both read only values the backend genuinely measures — never an
    // invented quota percentage.
    //
    //  * Connection — getWorkerStatuses()'s own status/note for the
    //    platform: whether its CLI is present and signed in, whether the
    //    CTO has switched it off, and whether Claude is in Reserve Mode.
    //  * Recent reliability — worker-health.json's rolling record of AR's
    //    own recent build/review calls to that platform. "No recent calls
    //    recorded" is the honest answer before any have been made, not a
    //    zero.
    const setSignal = (elId, text, cls) => {
      const el = document.getElementById(elId);
      if (!el) return;
      el.textContent = text;
      el.className = `platform-signal-value ${cls || ''}`.trim();
    };

    // Final UI Closure item 1 — the restored percentage bar. Every number
    // here is measured by AR itself (server.mjs getPlatformUsageShare):
    // the platform's share of the tokens AR actually recorded across recent
    // tasks. Nothing is scaled to, or implies, a provider subscription
    // quota — `quotaReported` stays false until a provider genuinely
    // exposes one, and the label beside the bar says so plainly.
    const renderUsageBar = (workerId, worker) => {
      const shareEl = document.getElementById(`share-limit-${workerId}`);
      const barEl = document.getElementById(`bar-limit-${workerId}`);
      const basisEl = document.getElementById(`basis-limit-${workerId}`);
      const quotaEl = document.getElementById(`quota-limit-${workerId}`);
      const u = worker?.usage;

      if (quotaEl) {
        quotaEl.textContent = u?.quotaReported ? 'Provider quota reported' : 'Provider quota not reported';
      }
      if (!u || !u.windowTotalTokens) {
        // No usage recorded yet in the window. Show an empty bar with an
        // honest basis line rather than a number AR cannot back up.
        if (shareEl) shareEl.textContent = 'No data yet';
        if (barEl) barEl.style.width = '0%';
        if (basisEl) basisEl.textContent = 'AR has recorded no token usage yet across recent tasks.';
        return;
      }
      const pct = Math.max(0, Math.min(100, Number(u.sharePercent) || 0));
      if (shareEl) shareEl.textContent = `${pct}%`;
      if (barEl) barEl.style.width = `${pct}%`;
      if (basisEl) {
        const tasks = Number(u.windowTaskCount) || 0;
        const accuracy = u.accuracy && u.accuracy !== 'Unavailable' ? ` · ${u.accuracy}` : '';
        // Phrased so the denominator is unmistakably AR's own spend over a
        // task window, never an allowance this platform is consuming.
        basisEl.textContent = u.tokens > 0
          ? `${Number(u.tokens).toLocaleString()} of the ${Number(u.windowTotalTokens).toLocaleString()} tokens AR spent across its last ${tasks} task${tasks === 1 ? '' : 's'}${accuracy}`
          : `AR recorded no tokens for this platform across its last ${tasks} task${tasks === 1 ? '' : 's'}`;
      }
    };

    const renderConnectionSignal = (workerId, worker) => {
      const elId = `conn-limit-${workerId}`;
      if (!worker) return setSignal(elId, 'Not configured', 'signal-muted');
      if (worker.userEnabled === false) return setSignal(elId, 'Switched off by CTO', 'signal-muted');
      if (worker.status === 'Available') return setSignal(elId, 'Connected', 'signal-ok');
      if (worker.status === 'Reserved') return setSignal(elId, 'Connected — held in reserve', 'signal-warn');
      return setSignal(elId, 'Not connected', 'signal-bad');
    };

    const renderHealthSignal = (workerId, worker) => {
      const elId = `health-limit-${workerId}`;
      if (!worker) return setSignal(elId, '—', 'signal-muted');
      if (worker.health === 'cooldown') {
        return setSignal(elId, worker.healthDetail || 'In cooldown after repeated failures', 'signal-bad');
      }
      if (worker.health === 'degraded') {
        return setSignal(elId, worker.healthDetail || 'Recent failures — deprioritized', 'signal-warn');
      }
      const sample = Number(worker.healthSampleSize || 0);
      if (worker.health === 'healthy' && sample > 0) {
        return setSignal(elId, `No failures in last ${sample} call${sample === 1 ? '' : 's'}`, 'signal-ok');
      }
      return setSignal(elId, 'No recent calls recorded', 'signal-muted');
    };

    // Cline
    const wCline = findW('cline');
    const tCline = document.getElementById('toggle-limit-cline');
    const bCline = document.getElementById('badge-limit-cline');
    const nCline = document.getElementById('note-limit-cline');
    if (tCline) tCline.checked = wCline?.userEnabled !== false;
    if (bCline) {
      const active = wCline?.userEnabled !== false && wCline?.status === 'Available';
      bCline.textContent = active ? 'ACTIVE' : (wCline?.userEnabled === false ? 'DISABLED' : 'STANDBY');
      bCline.className = `badge ${active ? 'green' : (wCline?.userEnabled === false ? 'gray' : 'amber')}`;
    }
    if (nCline && wCline?.note) nCline.textContent = wCline.note;
    renderUsageBar('cline', wCline);
    renderConnectionSignal('cline', wCline);
    renderHealthSignal('cline', wCline);

    // Claude Code
    const wClaude = findW('claude-code');
    const tClaude = document.getElementById('toggle-limit-claude');
    const bClaude = document.getElementById('badge-limit-claude');
    const nClaude = document.getElementById('note-limit-claude');
    if (tClaude) tClaude.checked = wClaude?.userEnabled !== false;
    if (bClaude) {
      if (wClaude?.userEnabled === false) {
        bClaude.textContent = 'DISABLED';
        bClaude.className = 'badge gray';
      } else if (State.claudeReserve) {
        bClaude.textContent = 'RESERVE MODE';
        bClaude.className = 'badge purple';
      } else if (wClaude?.status === 'Available') {
        bClaude.textContent = 'ACTIVE';
        bClaude.className = 'badge green';
      } else {
        bClaude.textContent = 'UNAVAILABLE';
        bClaude.className = 'badge red';
      }
    }
    if (nClaude && wClaude?.note) nClaude.textContent = wClaude.note;
    renderUsageBar('claude', wClaude);
    renderConnectionSignal('claude', wClaude);
    renderHealthSignal('claude', wClaude);

    // Codex
    const wCodex = findW('codex');
    const tCodex = document.getElementById('toggle-limit-codex');
    const bCodex = document.getElementById('badge-limit-codex');
    const nCodex = document.getElementById('note-limit-codex');
    if (tCodex) tCodex.checked = wCodex?.userEnabled !== false;
    if (bCodex) {
      const active = wCodex?.userEnabled !== false && wCodex?.status === 'Available';
      bCodex.textContent = active ? 'AVAILABLE' : (wCodex?.userEnabled === false ? 'DISABLED' : 'UNAVAILABLE');
      bCodex.className = `badge ${active ? 'green' : (wCodex?.userEnabled === false ? 'gray' : 'red')}`;
    }
    if (nCodex && wCodex?.note) nCodex.textContent = wCodex.note;
    renderUsageBar('codex', wCodex);
    renderConnectionSignal('codex', wCodex);
    renderHealthSignal('codex', wCodex);

    // Antigravity
    const wAntigravity = findW('antigravity');
    const tAntigravity = document.getElementById('toggle-limit-antigravity');
    const bAntigravity = document.getElementById('badge-limit-antigravity');
    const nAntigravity = document.getElementById('note-limit-antigravity');
    if (tAntigravity) tAntigravity.checked = wAntigravity?.userEnabled !== false;
    if (bAntigravity) {
      const active = wAntigravity?.userEnabled !== false && wAntigravity?.status === 'Available';
      bAntigravity.textContent = active ? 'ACTIVE' : (wAntigravity?.userEnabled === false ? 'DISABLED' : 'UNAVAILABLE');
      bAntigravity.className = `badge ${active ? 'green' : (wAntigravity?.userEnabled === false ? 'gray' : 'red')}`;
    }
    if (nAntigravity && wAntigravity?.note) nAntigravity.textContent = wAntigravity.note;
    renderUsageBar('antigravity', wAntigravity);
    renderConnectionSignal('antigravity', wAntigravity);
    renderHealthSignal('antigravity', wAntigravity);
  }

  function initPlatformLimitToggles() {
    const bindToggle = (elementId, workerId) => {
      const el = document.getElementById(elementId);
      if (el) {
        el.addEventListener('change', async (e) => {
          const enabled = e.target.checked;
          try {
            const res = await fetch('/api/workers/toggle', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ workerId, enabled })
            });
            if (res.ok) {
              showToast(`${formatWorkerName(workerId)} ${enabled ? 'enabled' : 'disabled'}`, 'success');
              await fetchStatus();
            } else {
              showToast('Failed to toggle worker', 'error');
            }
          } catch (err) {
            showToast('Toggle request error', 'error');
          }
        });
      }
    };

    bindToggle('toggle-limit-cline', 'cline');
    bindToggle('toggle-limit-claude', 'claude-code');
    bindToggle('toggle-limit-codex', 'codex');
    bindToggle('toggle-limit-antigravity', 'antigravity');

    // Also bind Settings switches
    bindToggle('settings-toggle-cline', 'cline');
    bindToggle('settings-toggle-claude', 'claude-code');
    bindToggle('settings-toggle-codex', 'codex');
    bindToggle('settings-toggle-antigravity', 'antigravity');

    // Also bind Team view switches
    bindToggle('team-toggle-cline', 'cline');
    bindToggle('team-toggle-claude', 'claude-code');
    bindToggle('team-toggle-codex', 'codex');
    bindToggle('team-toggle-antigravity', 'antigravity');
  }

  // View 1: Overview — Current Task & Team Rationale
  function renderOverviewTask() {
    const t = State.currentTask;
    const activeCard = document.getElementById('current-task-card');
    const emptyCard = document.getElementById('no-active-task-card');
    // Source-of-truth fix (Post-Release Fix A): when there is no current
    // task (State.currentTask is null — fetchStatus()/fetchTasks() only
    // set it from a genuinely active task now, never from whatever task
    // happens to be newest), show the "No active task" card and hide the
    // Current Task card entirely, rather than leaving whatever was last
    // rendered on screen. This is what makes Overview match Office View's
    // "Idle / No active task" instead of continuing to show a task that
    // has already reached a terminal status.
    if (!t) {
      if (activeCard) activeCard.style.display = 'none';
      if (emptyCard) emptyCard.style.display = '';
      return;
    }
    if (activeCard) activeCard.style.display = '';
    if (emptyCard) emptyCard.style.display = 'none';

    // Title & Status Badge — show the task's short display title, with a
    // "View full instruction" expand toggle underneath, instead of dumping
    // the whole raw instruction text into the header. Post-Release Fix C
    // moved the shortening itself into the shared task-title module so the
    // header, the Tasks table and the Task Progress selector all show the
    // same label; the toggle below still reveals the complete, unmodified
    // instruction.
    const fullInstruction = t.instruction || t.id;
    const titleEl = document.getElementById('current-task-title');
    const titleToggle = document.getElementById('current-task-title-toggle');
    const titleFull = document.getElementById('current-task-title-full');
    const displayTitle = taskTitleOf(t);
    const isLongInstruction = fullInstruction.trim() !== displayTitle;
    if (titleEl) {
      titleEl.textContent = displayTitle;
      titleEl.title = fullInstruction;
    }
    if (titleToggle) {
      titleToggle.style.display = isLongInstruction ? '' : 'none';
      titleToggle.textContent = 'View full instruction';
      titleToggle.onclick = () => {
        if (!titleFull) return;
        const showing = titleFull.style.display !== 'none';
        titleFull.style.display = showing ? 'none' : '';
        titleFull.textContent = fullInstruction;
        titleToggle.textContent = showing ? 'View full instruction' : 'Hide full instruction';
      };
    }
    if (titleFull && !isLongInstruction) titleFull.style.display = 'none';

    const statusBadge = document.getElementById('current-task-status-badge');
    if (statusBadge) {
      const bInfo = formatStatusBadge(t.status);
      statusBadge.textContent = bInfo.label;
      statusBadge.className = `badge ${bInfo.cls}`;
    }

    // Info Strip
    const idVal = document.getElementById('task-id-value');
    if (idVal) idVal.textContent = t.id;

    const createdVal = document.getElementById('task-created-value');
    if (createdVal) createdVal.textContent = formatRelativeTime(t.created);

    const typeVal = document.getElementById('task-type-value');
    if (typeVal) {
      const kindStr = t.kind === 'system' ? 'System Infrastructure' : 'Web Application';
      const diffStr = t.difficulty || 'Standard';
      typeVal.textContent = `${kindStr} • ${diffStr}`;
    }

    // Source-of-truth fix (Post-Release Fix A): the catch-all `else` below
    // used to say "Autonomous Pipeline Active" for ANY status this chain
    // didn't already name — including cancelled/cancelled_by_user, which is
    // exactly how a stopped task kept reading as actively running. Terminal
    // statuses not otherwise covered now get their own explicit text
    // instead of falling into that catch-all, and the catch-all itself only
    // fires for a status that is still genuinely active.
    const nextStepVal = document.getElementById('task-next-step-value');
    if (nextStepVal) {
      if (t.status === 'awaiting_approval') nextStepVal.textContent = 'CTO Approval Required (Stage B)';
      else if (t.status === 'needs_human_input') nextStepVal.textContent = 'Action Permission Needed';
      else if (t.status === 'building' || t.status === 'running') nextStepVal.textContent = 'Autonomous Build Phase';
      else if (t.status === 'reviewing' || t.status === 'testing') nextStepVal.textContent = 'Independent Review Phase';
      else if (t.status === 'paused_by_user') nextStepVal.textContent = 'Task Paused by User';
      else if (t.status === 'approved' || t.status === 'completed') nextStepVal.textContent = 'Execution Complete (Delivered)';
      else if (t.status === 'rejected') nextStepVal.textContent = 'Draft Rejected';
      else if (t.status === 'failed') nextStepVal.textContent = 'Task Failed';
      else if (t.status === 'cancelled' || t.status === 'cancelled_by_user') nextStepVal.textContent = 'Task Stopped';
      else if (ACTIVE_TASK_STATUSES.has(t.status)) nextStepVal.textContent = 'Autonomous Pipeline Active';
      else nextStepVal.textContent = t.status || '—';
    }

    // Source-of-truth fix (Post-Release Fix A): duration must freeze at
    // completionTime for any terminal task and never keep measuring
    // against Date.now() — that was the visible "timer keeps increasing"
    // half of the bug. completionTime is now always stamped the moment a
    // task becomes terminal (coding.mjs's state(), router.mjs's update(),
    // and every direct task.json writer in server.mjs), so the fallback to
    // Date.now() below now only ever applies to a task that is genuinely
    // still active.
    const durationVal = document.getElementById('task-duration-value');
    if (durationVal) {
      if (t.created) {
        const start = new Date(t.created).getTime();
        const isTerminal = !ACTIVE_TASK_STATUSES.has(t.status);
        const end = t.completionTime
          ? new Date(t.completionTime).getTime()
          : (isTerminal ? start : Date.now());
        const sec = Math.max(0, Math.floor((end - start) / 1000));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        durationVal.textContent = isTerminal
          ? `${m}m ${s < 10 ? '0' : ''}${s}s`
          : `${m}m ${s < 10 ? '0' : ''}${s}s elapsed`;
      } else {
        durationVal.textContent = '—';
      }
    }

    // Progress bar — add the missing cancelled/cancelled_by_user branch so
    // a stopped task doesn't fall through to the 50% default (the exact
    // stuck value the user reported).
    let pct = 50;
    if (t.status === 'completed' || t.status === 'approved') pct = 100;
    else if (t.status === 'awaiting_approval') pct = 85;
    else if (t.status === 'reviewing' || t.status === 'testing') pct = 70;
    else if (t.status === 'building' || t.status === 'running') pct = 45;
    else if (t.status === 'failed' || t.status === 'rejected') pct = 60;
    else if (t.status === 'cancelled' || t.status === 'cancelled_by_user') pct = 0;

    const barEl = document.getElementById('task-progress-bar');
    const pctEl = document.getElementById('task-progress-pct');
    if (barEl) barEl.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = `${pct}%`;

    // Builder Card
    const latestBuildLog = (t.routingLog || []).filter(r => r.role === 'build').pop();
    const latestReviewLog = (t.routingLog || []).filter(r => r.role === 'review').pop();

    const builderWorker = latestBuildLog?.worker || t.builderWorker || t.selectedBuilder || t.contributors?.[0] || 'cline';
    const builderModel = latestBuildLog?.model || t.builderModel || t.model || 'gemini-3.5-flash-lite';
    const builderTier = latestBuildLog?.tierNumber || t.builderTier || 1;
    const builderTierName = latestBuildLog?.tierName || t.builderTierName || 'Lightweight';

    const reviewerWorker = latestReviewLog?.worker || t.reviewerWorker || t.selectedReviewer || t.reviewer || 'antigravity';
    const reviewerModel = latestReviewLog?.model || t.reviewerModel || 'gemini-3.8-flash-medium';
    const reviewerTier = latestReviewLog?.tierNumber || t.reviewerTier || 2;
    const reviewerTierName = latestReviewLog?.tierName || t.reviewerTierName || 'Standard';

    const isHighTier = (builderTier >= 3) || String(builderTierName).toLowerCase().includes('advanced') || String(builderTierName).toLowerCase().includes('expert') || String(builderTierName).toLowerCase().includes('frontier');
    const builderAvatar = document.getElementById('builder-avatar');
    if (builderAvatar) {
      builderAvatar.textContent = getWorkerAvatarLetter(builderWorker);
      builderAvatar.className = `ai-avatar ${getWorkerAvatarClass(builderWorker)}`;
    }
    const bName = document.getElementById('builder-name');
    if (bName) bName.textContent = formatWorkerName(builderWorker);

    const bPlatform = document.getElementById('builder-platform');
    if (bPlatform) {
      bPlatform.textContent = `Platform: ${builderWorker === 'cline' ? 'Google AI Studio (Local CLI)' : builderWorker}`;
    }

    const bRole = document.getElementById('builder-role');
    if (bRole) bRole.textContent = isHighTier ? 'Lead Builder' : 'Economical Builder';

    const bModel = document.getElementById('builder-model');
    if (bModel) bModel.textContent = builderModel;

    const bEffort = document.getElementById('builder-effort');
    if (bEffort) bEffort.textContent = (t.builderEffort || 'medium').toUpperCase();

    const bStatus = document.getElementById('builder-status');
    if (bStatus) {
      if (t.status === 'building' || t.status === 'running') bStatus.textContent = 'Drafting deliverables';
      else if (t.status === 'awaiting_approval' || t.status === 'completed' || t.status === 'approved') bStatus.textContent = 'Draft completed';
      else bStatus.textContent = t.status;
    }

    const bTime = document.getElementById('builder-time');
    if (bTime) {
      bTime.textContent = t.duration ? `${t.duration} elapsed` : '—';
    }

    const bSpec = document.getElementById('builder-specialist');
    if (bSpec) bSpec.textContent = t.specialistName || 'Workflow Architect';

    // Reviewer Card
    const reviewerAvatar = document.getElementById('reviewer-avatar');
    if (reviewerAvatar) {
      reviewerAvatar.textContent = getWorkerAvatarLetter(reviewerWorker);
      reviewerAvatar.className = `ai-avatar ${getWorkerAvatarClass(reviewerWorker)}`;
    }
    const rName = document.getElementById('reviewer-name');
    if (rName) rName.textContent = formatWorkerName(reviewerWorker);

    const rPlatform = document.getElementById('reviewer-platform');
    if (rPlatform) rPlatform.textContent = 'Platform: Google DeepMind';

    const rRole = document.getElementById('reviewer-role');
    if (rRole) rRole.textContent = 'Independent Senior Reviewer';

    const rStatus = document.getElementById('reviewer-status');
    if (rStatus) {
      if (t.status === 'awaiting_approval' || t.status === 'completed' || t.status === 'approved') rStatus.textContent = 'Review completed';
      else if (t.status === 'reviewing' || t.status === 'testing') rStatus.textContent = 'Auditing code';
      else rStatus.textContent = 'Reserved';
    }

    const rModel = document.getElementById('reviewer-model');
    if (rModel) rModel.textContent = reviewerModel;

    const rEffort = document.getElementById('reviewer-effort');
    if (rEffort) rEffort.textContent = (latestReviewLog?.effort || t.reviewerEffort || 'medium').toUpperCase();

    const rVerdict = document.getElementById('reviewer-verdict');
    if (rVerdict) {
      if (t.status === 'awaiting_approval') rVerdict.textContent = 'PASS (Clean)';
      else if (t.status === 'completed' || t.status === 'approved') rVerdict.textContent = 'PASS (Approved)';
      else if (t.status === 'reviewing' || t.status === 'testing') rVerdict.textContent = 'Auditing code...';
      else rVerdict.textContent = 'Reserved for verification';
    }

    const rSpec = document.getElementById('reviewer-specialist');
    if (rSpec) {
      rSpec.textContent = t.reviewerQualification?.specialist || 'Reality Checker (Independent)';
    }

    // Why AR Chose This Team (4 clean business points)
    const ratList = document.getElementById('rationale-list');
    if (ratList) {
      const diff = t.difficulty ? String(t.difficulty).toLowerCase() : 'routine';
      const taskType = t.taskType ? String(t.taskType).replace(/_/g, ' ') : 'standard deliverable';
      const p1 = `Task classified as ${diff} difficulty (${taskType}) with low risk profile.`;

      const bWorkerName = formatWorkerName(builderWorker);
      const bModelName = builderModel;
      const p2 = isHighTier
        ? `${bWorkerName} (${bModelName}) escalated to advanced capability for this revision.`
        : `${bWorkerName} (${bModelName}) selected for economical, fast drafting.`;

      const rWorkerName = formatWorkerName(reviewerWorker);
      const rModelName = t.reviewerModel || 'Gemini 3.8 Flash';
      const p3 = `${rWorkerName} (${rModelName}) reserved before drafting started.`;

      const qualBadge = t.reviewerQualification?.badge || 'Tier 2 senior review of Tier 1 builder';
      const p4 = `Reviewer is independent: ${qualBadge}.`;

      ratList.innerHTML = `
        <li class="rationale-item"><span class="check-icon">✓</span> ${escapeHtml(p1)}</li>
        <li class="rationale-item"><span class="check-icon">✓</span> ${escapeHtml(p2)}</li>
        <li class="rationale-item"><span class="check-icon">✓</span> ${escapeHtml(p3)}</li>
        <li class="rationale-item"><span class="check-icon">✓</span> ${escapeHtml(p4)}</li>
      `;
    }

    // Token Telemetry: Builder, Reviewer, and Combined Task Total
    const tu = t.tokenUsage || {
      builder: { inputTokens: null, outputTokens: null, totalTokens: null, accuracy: 'Unavailable' },
      reviewer: { inputTokens: null, outputTokens: null, totalTokens: null, accuracy: 'Unavailable' },
      totalTokens: null,
      totalAccuracy: 'Unavailable',
      summaryText: 'Unavailable'
    };

    const bUsage = tu.builder || {};
    const rUsage = tu.reviewer || {};

    const getBadgeClass = (acc) => {
      if (acc === 'Exact') return 'green';
      if (acc === 'Estimated') return 'amber';
      if (acc === 'Partial') return 'purple';
      return 'gray';
    };

    // Builder Tokens
    const bBadge = document.getElementById('builder-token-badge');
    const bInput = document.getElementById('builder-token-input');
    const bOutput = document.getElementById('builder-token-output');
    const bTotal = document.getElementById('builder-token-total');
    const bNote = document.getElementById('builder-token-note');

    if (bBadge) {
      bBadge.textContent = bUsage.accuracy || 'Unavailable';
      bBadge.className = `badge ${getBadgeClass(bUsage.accuracy)}`;
    }
    if (bInput) {
      bInput.textContent = bUsage.inputTokens != null ? bUsage.inputTokens.toLocaleString() : 'Unavailable';
      bInput.style.color = bUsage.inputTokens != null ? 'var(--text-main)' : 'var(--text-muted)';
      bInput.style.fontWeight = bUsage.inputTokens != null ? '700' : 'normal';
    }
    if (bOutput) {
      bOutput.textContent = bUsage.outputTokens != null ? bUsage.outputTokens.toLocaleString() : 'Unavailable';
      bOutput.style.color = bUsage.outputTokens != null ? 'var(--text-main)' : 'var(--text-muted)';
      bOutput.style.fontWeight = bUsage.outputTokens != null ? '700' : 'normal';
    }
    if (bTotal) {
      bTotal.textContent = bUsage.totalTokens != null ? bUsage.totalTokens.toLocaleString() : 'Unavailable';
      bTotal.style.color = bUsage.totalTokens != null ? '#2563eb' : 'var(--text-muted)';
      bTotal.style.fontWeight = bUsage.totalTokens != null ? '700' : 'normal';
    }
    if (bNote) {
      if (bUsage.accuracy === 'Exact') {
        bNote.textContent = `Exact token telemetry recorded across ${bUsage.invocations || 1} model call(s).`;
      } else if (bUsage.accuracy === 'Estimated') {
        bNote.textContent = 'Estimated based on prompt & output heuristic.';
      } else {
        bNote.textContent = 'Token telemetry unavailable from current builder CLI.';
      }
    }

    // Reviewer Tokens
    const rBadge = document.getElementById('reviewer-token-badge');
    const rInput = document.getElementById('reviewer-token-input');
    const rOutput = document.getElementById('reviewer-token-output');
    const rTotal = document.getElementById('reviewer-token-total');
    const rNote = document.getElementById('reviewer-token-note');

    if (rBadge) {
      rBadge.textContent = rUsage.accuracy || 'Unavailable';
      rBadge.className = `badge ${getBadgeClass(rUsage.accuracy)}`;
    }
    if (rInput) {
      rInput.textContent = rUsage.inputTokens != null ? rUsage.inputTokens.toLocaleString() : 'Unavailable';
      rInput.style.color = rUsage.inputTokens != null ? 'var(--text-main)' : 'var(--text-muted)';
      rInput.style.fontWeight = rUsage.inputTokens != null ? '700' : 'normal';
    }
    if (rOutput) {
      rOutput.textContent = rUsage.outputTokens != null ? rUsage.outputTokens.toLocaleString() : 'Unavailable';
      rOutput.style.color = rUsage.outputTokens != null ? 'var(--text-main)' : 'var(--text-muted)';
      rOutput.style.fontWeight = rUsage.outputTokens != null ? '700' : 'normal';
    }
    if (rTotal) {
      rTotal.textContent = rUsage.totalTokens != null ? rUsage.totalTokens.toLocaleString() : 'Unavailable';
      rTotal.style.color = rUsage.totalTokens != null ? '#059669' : 'var(--text-muted)';
      rTotal.style.fontWeight = rUsage.totalTokens != null ? '700' : 'normal';
    }
    if (rNote) {
      if (rUsage.accuracy === 'Exact') {
        rNote.textContent = `Exact token telemetry recorded across ${rUsage.invocations || 1} review audit(s).`;
      } else if (rUsage.accuracy === 'Estimated') {
        rNote.textContent = 'Estimated based on prompt & output heuristic.';
      } else {
        rNote.textContent = 'Token telemetry unavailable from reviewer.';
      }
    }

    // Combined Task AI Usage
    const cVal = document.getElementById('task-combined-tokens-value');
    const cBadge = document.getElementById('task-combined-tokens-badge');
    const cNote = document.getElementById('task-combined-tokens-note');

    if (cVal) {
      if (tu.totalTokens != null && tu.totalTokens > 0) {
        cVal.textContent = `${tu.totalTokens.toLocaleString()} tokens`;
      } else {
        cVal.textContent = 'Unavailable';
      }
    }
    if (cBadge) {
      cBadge.textContent = tu.totalAccuracy || 'Unavailable';
      cBadge.className = `badge ${getBadgeClass(tu.totalAccuracy)}`;
    }
    if (cNote) {
      if (tu.summaryText && tu.summaryText !== 'Unavailable') {
        cNote.textContent = tu.summaryText;
      } else {
        cNote.textContent = 'Tokens accumulate across build, revision, and audit calls.';
      }
    }
  }

  // View 1: Overview — Logs Display (Split, Progress, Logs)
  function renderOverviewLogs() {
    const container = document.getElementById('overview-logs-display');
    if (!container || !State.currentTask) return;

    const activities = State.currentTask.activityLog || [];
    const events = State.currentTask.events || [];

    // Update count in sidebar
    const navCountLogs = document.getElementById('nav-count-logs');
    if (navCountLogs) navCountLogs.textContent = events.length;

    // Capture previous scroll positions so user scroll position is preserved when autoFollow is OFF
    const prevProgressEl = document.getElementById('split-progress-feed');
    const prevProgressScroll = prevProgressEl ? prevProgressEl.scrollTop : null;

    const prevTechEl = document.getElementById('split-tech-stream') || document.getElementById('split-tech-feed');
    const prevTechScroll = prevTechEl ? prevTechEl.scrollTop : null;

    const prevOverviewTimeline = document.getElementById('overview-timeline');
    const prevOverviewTimelineScroll = prevOverviewTimeline ? prevOverviewTimeline.scrollTop : null;

    const prevOverviewTech = document.getElementById('overview-tech-stream') || document.getElementById('overview-tech-feed');
    const prevOverviewTechScroll = prevOverviewTech ? prevOverviewTech.scrollTop : null;

    if (State.overviewLogsMode === 'progress') {
      container.className = 'logs-display-container mode-progress';
      container.innerHTML = `
        <div class="single-col" id="col-progress">
          <div class="panel-header">
            <span>⏱️ Task Progress Timeline (${activities.length})</span>
          </div>
          <div class="panel-body" id="overview-timeline">
            ${renderTimelineHtml(activities, 'overview-timeline-feed')}
          </div>
        </div>
      `;
    } else if (State.overviewLogsMode === 'logs') {
      container.className = 'logs-display-container mode-logs';
      container.innerHTML = `
        <div class="single-col" id="col-logs">
          <div class="panel-header">
            <span>📄 Technical Event Stream (${events.length})</span>
          </div>
          <div class="panel-body tech-feed-wrap" id="overview-tech-feed">
            ${renderTechLogsFeedHtml(events, 'overview-tech-stream')}
          </div>
        </div>
      `;
    } else {
      // Split view (side-by-side on desktop)
      container.className = 'logs-display-container mode-split';
      container.innerHTML = `
        <div class="split-container">
          <div class="split-col" id="col-progress">
            <div class="panel-header">
              <span>⏱️ Task Progress Timeline (${activities.length})</span>
            </div>
            <div class="panel-body" id="split-progress-feed">
              ${renderTimelineHtml(activities, 'split-timeline')}
            </div>
          </div>
          <div class="split-col" id="col-logs">
            <div class="panel-header">
              <span>📄 Technical Event Stream (${events.length})</span>
            </div>
            <div class="panel-body tech-feed-wrap" id="split-tech-feed">
              ${renderTechLogsFeedHtml(events, 'split-tech-stream')}
            </div>
          </div>
        </div>
      `;
    }

    function applyOverviewScroll() {
      if (State.autoFollow) {
        if (State.overviewLogsMode === 'split') {
          scrollToBottom('split-progress-feed');
          scrollToBottom('split-tech-stream');
          scrollToBottom('split-tech-feed');
        } else if (State.overviewLogsMode === 'progress') {
          scrollToBottom('overview-timeline');
        } else if (State.overviewLogsMode === 'logs') {
          scrollToBottom('overview-tech-stream');
          scrollToBottom('overview-tech-feed');
        }
      } else {
        if (State.overviewLogsMode === 'split') {
          if (prevProgressScroll !== null) {
            const el = document.getElementById('split-progress-feed');
            if (el) el.scrollTop = prevProgressScroll;
          }
          if (prevTechScroll !== null) {
            const streamEl = document.getElementById('split-tech-stream');
            if (streamEl) streamEl.scrollTop = prevTechScroll;
            const wrapEl = document.getElementById('split-tech-feed');
            if (wrapEl) wrapEl.scrollTop = prevTechScroll;
          }
        } else if (State.overviewLogsMode === 'progress') {
          if (prevOverviewTimelineScroll !== null) {
            const el = document.getElementById('overview-timeline');
            if (el) el.scrollTop = prevOverviewTimelineScroll;
          }
        } else if (State.overviewLogsMode === 'logs') {
          if (prevOverviewTechScroll !== null) {
            const streamEl = document.getElementById('overview-tech-stream');
            if (streamEl) streamEl.scrollTop = prevOverviewTechScroll;
            const wrapEl = document.getElementById('overview-tech-feed');
            if (wrapEl) wrapEl.scrollTop = prevOverviewTechScroll;
          }
        }
      }
    }

    applyOverviewScroll();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(applyOverviewScroll);
    }
  }

  function renderTimelineHtml(activities, id) {
    if (!activities || activities.length === 0) {
      return '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 1.25rem;">No progress events recorded for this task yet.</div>';
    }
    return `
      <div class="timeline-list" id="${id}">
        ${activities.map((a, idx) => {
          const isLatest = idx === activities.length - 1;
          const isDone = !isLatest || a.icon === '✓' || (a.title && (a.title.toLowerCase().includes('passed') || a.title.toLowerCase().includes('completed') || a.title.toLowerCase().includes('approved')));
          const stateCls = isDone ? 'done' : 'active';
          const markerIcon = a.icon || (isDone ? '✓' : '●');
          return `
            <div class="timeline-item ${stateCls}">
              <div class="timeline-marker">${escapeHtml(markerIcon)}</div>
              <div class="timeline-content">
                <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem;">
                  <span class="timeline-title">${escapeHtml(a.title || 'Step completed')}</span>
                  <span class="timeline-time">${escapeHtml(formatTime(a.time))}</span>
                </div>
                ${a.desc ? `<p class="timeline-desc" style="margin: 0.15rem 0 0 0;">${escapeHtml(a.desc)}</p>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderTechLogsFeedHtml(events, id) {
    if (!events || events.length === 0) {
      return '<div class="tech-log-feed" id="' + id + '"><div style="color: #64748b; font-family: var(--font-mono); font-size: 0.85rem; padding: 1.25rem;">No technical events recorded.</div></div>';
    }
    return `
      <div class="tech-log-feed" id="${id}">
        ${events.map(ev => {
          const type = (ev.eventType || ev.type || 'EVENT').toLowerCase();
          const time = formatTime(ev.timestamp || ev.time);
          const role = (ev.role || 'ROUTER').toLowerCase();
          let tagClass = 'router';
          if (role.includes('cline') || role === 'builder') tagClass = 'builder';
          else if (role.includes('antigravity') || role === 'reviewer') tagClass = 'reviewer';
          else if (type.includes('valid') || type.includes('test')) tagClass = 'validation';
          else if (type.includes('fail') || type.includes('error')) tagClass = 'error';

          const title = ev.title || ev.message || JSON.stringify(ev);

          if (type === 'token_usage' || title.includes('[TOKEN_USAGE]')) {
            const cleanTitle = title.replace(/^\[TOKEN_USAGE\]\s*/i, '');
            return `
              <div class="log-entry" style="background: rgba(245, 158, 11, 0.12); border-left: 3px solid #f59e0b; padding-left: 0.5rem; margin: 0.15rem 0; border-radius: 2px;">
                <span class="log-time">[${escapeHtml(time)}]</span>
                <span class="log-tag reviewer">${escapeHtml(role.toUpperCase())}</span>
                <span class="log-tag" style="background: #78350f; color: #fde68a;">TOKEN_USAGE</span>
                <span class="log-msg" style="color: #f8fafc; font-weight: 600;">${escapeHtml(cleanTitle)}</span>
              </div>
            `;
          }

          if (tagClass === 'error') {
            return `
              <div class="log-entry" style="background: rgba(239, 68, 68, 0.12); border-left: 3px solid #ef4444; padding-left: 0.5rem; margin: 0.15rem 0; border-radius: 2px;">
                <span class="log-time">[${escapeHtml(time)}]</span>
                <span class="log-tag error">${escapeHtml(role.toUpperCase())}</span>
                <span class="log-msg" style="color: #fca5a5; font-weight: 600;">${escapeHtml(title)}</span>
              </div>
            `;
          }

          return `
            <div class="log-entry">
              <span class="log-time">[${escapeHtml(time)}]</span>
              <span class="log-tag ${tagClass}">${escapeHtml(role.toUpperCase())}</span>
              <span class="log-msg">${escapeHtml(title)}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function scrollToBottom(elId) {
    const el = typeof elId === 'string' ? document.getElementById(elId) : elId;
    if (el) el.scrollTop = el.scrollHeight;
  }

  function syncAutoFollow(enabled) {
    State.autoFollow = Boolean(enabled);
    ['toggle-autofollow', 'toggle-progress-autofollow', 'toggle-tech-autofollow'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.checked = State.autoFollow;
    });

    if (State.autoFollow) {
      if (State.overviewLogsMode === 'split') {
        scrollToBottom('split-progress-feed');
        scrollToBottom('split-tech-stream');
        scrollToBottom('split-tech-feed');
      } else if (State.overviewLogsMode === 'progress') {
        scrollToBottom('overview-timeline');
      } else if (State.overviewLogsMode === 'logs') {
        scrollToBottom('overview-tech-stream');
        scrollToBottom('overview-tech-feed');
      }
      if (State.activeView === 'logs') {
        scrollToBottom('tech-logs-full-stream');
        const fullFeed = document.getElementById('tech-logs-full-feed');
        if (fullFeed) fullFeed.scrollTop = fullFeed.scrollHeight;
      }
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          if (State.autoFollow) {
            if (State.overviewLogsMode === 'split') {
              scrollToBottom('split-progress-feed');
              scrollToBottom('split-tech-stream');
              scrollToBottom('split-tech-feed');
            } else if (State.overviewLogsMode === 'progress') {
              scrollToBottom('overview-timeline');
            } else if (State.overviewLogsMode === 'logs') {
              scrollToBottom('overview-tech-stream');
              scrollToBottom('overview-tech-feed');
            }
            if (State.activeView === 'logs') {
              scrollToBottom('tech-logs-full-stream');
              const fullFeed = document.getElementById('tech-logs-full-feed');
              if (fullFeed) fullFeed.scrollTop = fullFeed.scrollHeight;
            }
          }
        });
      }
    }
  }

  function initLogViewControls() {
    const btnProgress = document.getElementById('btn-view-progress');
    const btnLogs = document.getElementById('btn-view-logs');
    const btnSplit = document.getElementById('btn-view-split');
    const toggleAutofollow = document.getElementById('toggle-autofollow');

    if (btnProgress) {
      btnProgress.addEventListener('click', () => {
        State.overviewLogsMode = 'progress';
        [btnProgress, btnLogs, btnSplit].forEach(b => b?.classList.remove('active'));
        btnProgress.classList.add('active');
        renderOverviewLogs();
      });
    }

    if (btnLogs) {
      btnLogs.addEventListener('click', () => {
        State.overviewLogsMode = 'logs';
        [btnProgress, btnLogs, btnSplit].forEach(b => b?.classList.remove('active'));
        btnLogs.classList.add('active');
        renderOverviewLogs();
      });
    }

    if (btnSplit) {
      btnSplit.addEventListener('click', () => {
        State.overviewLogsMode = 'split';
        [btnProgress, btnLogs, btnSplit].forEach(b => b?.classList.remove('active'));
        btnSplit.classList.add('active');
        renderOverviewLogs();
      });
    }

    if (toggleAutofollow) {
      toggleAutofollow.checked = State.autoFollow;
      toggleAutofollow.addEventListener('change', (e) => {
        syncAutoFollow(e.target.checked);
      });
    }
  }

  // Real Decision Container Rendering
  function renderDecisionContainer() {
    const container = document.getElementById('decision-card-container');
    const subtext = document.getElementById('decision-status-subtext');
    if (!container || !State.currentTask) return;

    const t = State.currentTask;

    if (t.status === 'awaiting_approval') {
      if (subtext) subtext.textContent = 'Stage B Deliverable sign-off active';
      container.innerHTML = `
        <div class="decision-dialog-card dialog-decision">
          <div class="dialog-header">
            <div class="dialog-icon">🛡️</div>
            <div class="dialog-title-wrap">
              <h3>Stage B Deliverable Approval Required</h3>
              <p>Independent review passed. The draft is waiting for CTO approval before applying to project root.</p>
            </div>
          </div>

          <div class="dialog-details-box">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; flex-wrap: wrap; gap: 0.5rem;">
              <strong>Deliverable Draft Ready (Stage B)</strong>
              <span class="badge green">Review Verdict: PASS (Verified Clean)</span>
            </div>
            <p style="color: #334155; margin-bottom: 0.35rem;"><strong>Instruction:</strong> ${escapeHtml(t.instruction || t.id)}</p>
            <p style="color: #334155; margin-bottom: 0.35rem;"><strong>Builder:</strong> ${escapeHtml(formatWorkerName(builderWorker))} • <strong>Auditor:</strong> ${escapeHtml(formatWorkerName(reviewerWorker))} (✓ Approved)</p>
            <p style="color: #64748b; font-family: var(--font-mono); font-size: 0.78rem;">Digest: ${escapeHtml(t.digest || t.baselineDigest || '033972cd67...')}</p>
          </div>

          <div class="dialog-actions-row">
            <div class="dialog-btn-group">
              <button type="button" class="btn btn-success" id="btn-action-approve" style="display: flex; align-items: center; gap: 0.4rem;">
                <span>✓</span> Approve & Apply Deliverable
              </button>
              <button type="button" class="btn btn-danger-outline" id="btn-action-reject">
                <span>✕</span> Request Changes / Reject Draft
              </button>
            </div>
            <div class="dialog-btn-group">
              <button type="button" class="btn btn-secondary" id="btn-action-pause">
                <span>⏸️</span> Pause
              </button>
              <button type="button" class="btn btn-secondary" id="btn-action-stop">
                <span>⏹️</span> Stop Task
              </button>
            </div>
          </div>
        </div>
      `;

      // Bind Decision Action Buttons
      const btnApprove = document.getElementById('btn-action-approve');
      if (btnApprove) btnApprove.addEventListener('click', () => decideTask(t.id, 'approved'));

      const btnReject = document.getElementById('btn-action-reject');
      if (btnReject) btnReject.addEventListener('click', () => decideTask(t.id, 'rejected'));

      const btnPause = document.getElementById('btn-action-pause');
      if (btnPause) btnPause.addEventListener('click', () => pauseTask(t.id));

      const btnStop = document.getElementById('btn-action-stop');
      if (btnStop) btnStop.addEventListener('click', () => stopTask(t.id));

    } else if (t.status === 'needs_human_input' || t.decisionRequired) {
      const dec = t.decisionRequired || {};
      // Decision types that are genuinely an app-permission request (the
      // "Allow Once / Remember for Project / Deny & Stop" dialog) vs.
      // every other decision type, which needs its own reason-specific
      // buttons built from dec.options (the real source of truth for what
      // actions are valid — see coding.mjs). Only fall back to the generic
      // permission dialog when there's no dec.type/options to render from.
      if (subtext) subtext.textContent = dec.title || 'Human input requested by pipeline';

      if (Array.isArray(dec.options) && dec.options.length > 0) {
        const btnClassFor = (id, recommended) => {
          if (id === 'stop_task' || id === 'reject' || id === 'override_sensitive') return 'btn-danger-outline';
          if (recommended) return 'btn-primary';
          return 'btn-secondary';
        };
        const buttonsHtml = dec.options.map(opt =>
          `<button type="button" class="btn ${btnClassFor(opt.id, opt.recommended)}" data-decision-id="${escapeHtml(opt.id)}">${escapeHtml(opt.label)}</button>`
        ).join(' ');

        container.innerHTML = `
          <div class="decision-dialog-card dialog-permission">
            <div class="dialog-header">
              <div class="dialog-icon">🧭</div>
              <div class="dialog-title-wrap">
                <h3>${escapeHtml(dec.question || dec.title || 'Decision Required')}</h3>
                <p>${escapeHtml(dec.reason || 'Adaptive Router needs a decision to continue.')}</p>
              </div>
            </div>
            <div class="dialog-details-box">
              <p style="color: #334155;">Task: <strong>${escapeHtml(t.instruction || t.id)}</strong></p>
              ${dec.recommendation ? `<p style="color: #64748b; margin-top: 0.3rem;">${escapeHtml(dec.recommendation)}</p>` : ''}
            </div>
            <div class="dialog-actions-row">
              <div class="dialog-btn-group">
                ${buttonsHtml}
              </div>
            </div>
          </div>
        `;

        container.querySelectorAll('[data-decision-id]').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-decision-id');
            if (id === 'stop_task') stopTask(t.id);
            else resumeTask(t.id, id);
          });
        });
      } else {
        // Fallback: a real app-permission request with no explicit
        // options array (e.g. file-system access approval flows).
        container.innerHTML = `
          <div class="decision-dialog-card dialog-permission">
            <div class="dialog-header">
              <div class="dialog-icon">🛡️</div>
              <div class="dialog-title-wrap">
                <h3>${escapeHtml(dec.question || 'Action Permission Required')}</h3>
                <p>${escapeHtml(dec.reason || 'Adaptive Router requires authorization to proceed.')}</p>
              </div>
            </div>
            <div class="dialog-details-box">
              <p style="color: #334155;">Task: <strong>${escapeHtml(t.instruction || t.id)}</strong></p>
              <p style="color: #64748b; margin-top: 0.3rem;">Adaptive Router paused the task to protect local file security until authorized.</p>
            </div>
            <div class="dialog-actions-row">
              <div class="dialog-btn-group">
                <button type="button" class="btn btn-primary" id="btn-action-allow-once">Allow Once</button>
                <button type="button" class="btn btn-secondary" id="btn-action-allow-always">Remember for Project</button>
              </div>
              <div class="dialog-btn-group">
                <button type="button" class="btn btn-danger-outline" id="btn-action-stop-perm">Deny & Stop</button>
              </div>
            </div>
          </div>
        `;

        const btnAllowOnce = document.getElementById('btn-action-allow-once');
        if (btnAllowOnce) btnAllowOnce.addEventListener('click', () => resumeTask(t.id, 'allow_once'));

        const btnAllowAlways = document.getElementById('btn-action-allow-always');
        if (btnAllowAlways) btnAllowAlways.addEventListener('click', () => resumeTask(t.id, 'allow_task'));

        const btnStopPerm = document.getElementById('btn-action-stop-perm');
        if (btnStopPerm) btnStopPerm.addEventListener('click', () => stopTask(t.id));
      }

    } else if (t.status === 'needs_cto_attention') {
      if (subtext) subtext.textContent = 'CTO Sensitivity Override Required';
      container.innerHTML = `
        <div class="decision-dialog-card dialog-sensitivity">
          <div class="dialog-header">
            <div class="dialog-icon">🔒</div>
            <div class="dialog-title-wrap">
              <h3>CTO Sensitivity Override Required</h3>
              <p>Sensitive keywords detected in task instruction. Task held for Stage A authorization.</p>
            </div>
          </div>
          <div class="dialog-details-box">
            <p style="color: #9a3412;">Instruction: <strong>${escapeHtml(t.instruction || t.id)}</strong></p>
            <p style="color: #9a3412; margin-top: 0.3rem;">Adaptive Router automatically paused this task. To proceed without modification, explicit CTO override authorization is required.</p>
          </div>
          <div class="dialog-actions-row">
            <div class="dialog-btn-group">
              <button type="button" class="btn btn-warning" id="btn-action-override">Authorize CTO Override</button>
            </div>
            <div class="dialog-btn-group">
              <button type="button" class="btn btn-danger-outline" id="btn-action-stop-sens">Cancel Task</button>
            </div>
          </div>
        </div>
      `;
      const btnOverride = document.getElementById('btn-action-override');
      if (btnOverride) btnOverride.addEventListener('click', () => resumeTask(t.id, 'override_sensitive'));
      const btnStopSens = document.getElementById('btn-action-stop-sens');
      if (btnStopSens) btnStopSens.addEventListener('click', () => stopTask(t.id));

    } else if (t.status === 'paused_by_user') {
      if (subtext) subtext.textContent = 'Pipeline currently paused';
      container.innerHTML = `
        <div class="decision-dialog-card dialog-warning">
          <div class="dialog-header">
            <div class="dialog-icon">⏸️</div>
            <div class="dialog-title-wrap">
              <h3>Task Paused by User</h3>
              <p>Active execution was safely held at the current stage boundary.</p>
            </div>
          </div>
          <div class="dialog-details-box">
            <p style="color: #92400e;">Task: <strong>${escapeHtml(t.instruction || t.id)}</strong></p>
            <p style="color: #92400e; margin-top: 0.3rem;">Worker and reviewer resources remain reserved. You can resume at any time.</p>
          </div>
          <div class="dialog-actions-row">
            <div class="dialog-btn-group">
              <button type="button" class="btn btn-primary" id="btn-action-resume">▶️ Resume Execution</button>
            </div>
            <div class="dialog-btn-group">
              <button type="button" class="btn btn-secondary btn-danger-outline" id="btn-action-stop-paused">⏹️ Stop & Unlock</button>
            </div>
          </div>
        </div>
      `;

      const btnResume = document.getElementById('btn-action-resume');
      if (btnResume) btnResume.addEventListener('click', () => resumeTask(t.id, 'preserve_claude'));

      const btnStopP = document.getElementById('btn-action-stop-paused');
      if (btnStopP) btnStopP.addEventListener('click', () => stopTask(t.id));

    } else if (t.status === 'failed' || t.status === 'rejected') {
      if (subtext) subtext.textContent = 'Execution finished with rejection or failure';
      container.innerHTML = `
        <div class="decision-dialog-card dialog-failure">
          <div class="dialog-header">
            <div class="dialog-icon">❌</div>
            <div class="dialog-title-wrap">
              <h3>Task Finished (${escapeHtml(t.status.toUpperCase())})</h3>
              <p>The deliverable was rejected or execution encountered an unrecoverable failure.</p>
            </div>
          </div>
          <div class="dialog-details-box">
            <p style="color: #991b1b;">Instruction: <strong>${escapeHtml(t.instruction || t.id)}</strong></p>
            <p style="color: #991b1b; margin-top: 0.3rem;">You can trigger a fresh clean rerun with isolated workspace initialization.</p>
          </div>
          <div class="dialog-actions-row">
            <div class="dialog-btn-group">
              <button type="button" class="btn btn-primary" id="btn-action-rerun-failed">🔄 Rerun Cleanly</button>
            </div>
          </div>
        </div>
      `;

      const btnRerun = document.getElementById('btn-action-rerun-failed');
      if (btnRerun) btnRerun.addEventListener('click', () => rerunCleanTask(t.id));

    } else {
      if (subtext) subtext.textContent = 'Autonomous pipeline operating normally';
      container.innerHTML = `
        <div class="decision-dialog-card dialog-decision" style="background: #f8fafc; border-color: #cbd5e1;">
          <div class="dialog-header">
            <div class="dialog-icon">✓</div>
            <div class="dialog-title-wrap">
              <h3>Pipeline Operating Normally</h3>
              <p>Autonomous Stage B governance active. No manual decision is currently required for this task.</p>
            </div>
          </div>
        </div>
      `;
    }
  }

  // Decision & Task Control Handlers
  async function decideTask(taskId, decision) {
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, reason: `Approved by CTO from production dashboard` })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`Deliverable successfully ${decision}`, 'success');
        await fetchTasks();
      } else {
        showToast(data.error || 'Decision failed', 'error');
      }
    } catch (err) {
      showToast('Error sending decision', 'error');
    }
  }

  async function pauseTask(taskId) {
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/pause`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast('Task paused gracefully', 'success');
        await fetchTasks();
      } else {
        showToast(data.error || 'Pause failed', 'error');
      }
    } catch (err) {
      showToast('Error pausing task', 'error');
    }
  }

  async function stopTask(taskId) {
    if (!confirm('Are you sure you want to stop this task and release the execution lock?')) return;
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/stop`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast('Task stopped and lock released', 'success');
        await fetchTasks();
      } else {
        showToast(data.error || 'Stop failed', 'error');
      }
    } catch (err) {
      showToast('Error stopping task', 'error');
    }
  }

  async function resumeTask(taskId, decision) {
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision })
      });
      const data = await res.json();
      if (res.ok) {
        showToast('Task resumed', 'success');
        await fetchTasks();
      } else {
        showToast(data.error || 'Resume failed', 'error');
      }
    } catch (err) {
      showToast('Error resuming task', 'error');
    }
  }

  async function rerunCleanTask(taskId) {
    if (!confirm('Initiate a fresh clean rerun for this instruction?')) return;
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/rerun-clean`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast('Clean rerun initiated', 'success');
        if (data.taskId) State.currentTaskId = data.taskId;
        await fetchTasks();
      } else {
        showToast(data.error || 'Clean rerun failed', 'error');
      }
    } catch (err) {
      showToast('Error initiating clean rerun', 'error');
    }
  }

  function initTaskActionButtons() {
    const btnPause = document.getElementById('btn-pause-task');
    if (btnPause) {
      btnPause.addEventListener('click', () => {
        if (State.currentTaskId) pauseTask(State.currentTaskId);
      });
    }

    const btnStop = document.getElementById('btn-stop-task');
    if (btnStop) {
      btnStop.addEventListener('click', () => {
        if (State.currentTaskId) stopTask(State.currentTaskId);
      });
    }

    const btnRerun = document.getElementById('btn-rerun-task');
    if (btnRerun) {
      btnRerun.addEventListener('click', () => {
        if (State.currentTaskId) rerunCleanTask(State.currentTaskId);
      });
    }
  }

  // View 2: Tasks — Table with Exactly 7 Columns as Required
  function renderTasksTable() {
    const tbody = document.getElementById('tasks-table-body');
    if (!tbody) return;

    let filtered = State.tasks.slice();

    // Filter by tab
    if (State.taskFilter === 'running') {
      filtered = filtered.filter(t => t.status === 'running' || t.status === 'building');
    } else if (State.taskFilter === 'decision') {
      filtered = filtered.filter(t => t.status === 'awaiting_approval' || t.status === 'needs_human_input');
    } else if (State.taskFilter === 'completed') {
      filtered = filtered.filter(t => t.status === 'completed' || t.status === 'approved');
    } else if (State.taskFilter === 'failed') {
      filtered = filtered.filter(t => t.status === 'failed' || t.status === 'rejected');
    } else if (State.taskFilter === 'cancelled') {
      filtered = filtered.filter(t => t.status === 'cancelled' || t.status === 'cancelled_by_user');
    }

    // Filter by search
    if (State.taskSearch) {
      const q = State.taskSearch.toLowerCase();
      filtered = filtered.filter(t =>
        (t.instruction || '').toLowerCase().includes(q) ||
        (t.id || '').toLowerCase().includes(q) ||
        (t.builder || '').toLowerCase().includes(q) ||
        (t.reviewer || '').toLowerCase().includes(q)
      );
    }

    // Update filter tab counts
    const countAll = State.tasks.length;
    const countRunning = State.tasks.filter(t => t.status === 'running' || t.status === 'building').length;
    const countDecision = State.tasks.filter(t => t.status === 'awaiting_approval' || t.status === 'needs_human_input').length;
    const countCompleted = State.tasks.filter(t => t.status === 'completed' || t.status === 'approved').length;
    const countFailed = State.tasks.filter(t => t.status === 'failed' || t.status === 'rejected').length;
    const countCancelled = State.tasks.filter(t => t.status === 'cancelled' || t.status === 'cancelled_by_user').length;

    const elAll = document.getElementById('filter-tab-all');
    if (elAll) elAll.textContent = `All Tasks (${countAll})`;
    const elRun = document.getElementById('filter-tab-running');
    if (elRun) elRun.textContent = `Running (${countRunning})`;
    const elDec = document.getElementById('filter-tab-decision');
    if (elDec) elDec.textContent = `Waiting for Decision (${countDecision})`;
    const elComp = document.getElementById('filter-tab-completed');
    if (elComp) elComp.textContent = `Completed (${countCompleted})`;
    const elFail = document.getElementById('filter-tab-failed');
    if (elFail) elFail.textContent = `Failed (${countFailed})`;
    const elCanc = document.getElementById('filter-tab-cancelled');
    if (elCanc) elCanc.textContent = `Cancelled (${countCancelled})`;

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding: 2rem; color: var(--text-muted);">No tasks match the selected filter.</td></tr>';
      return;
    }

    tbody.innerHTML = filtered.map(t => {
      const bInfo = formatStatusBadge(t.status);
      const isSelected = t.id === State.currentTaskId;
      const startedStr = formatRelativeTime(t.created);
      const durationStr = t.duration || '0m 00s';
      // Source-of-truth fix (Post-Release Fix A): `t.progress || 50` looked
      // like a safe fallback but `||` treats a genuine 0 (server-side fix:
      // listRecentTasks() now correctly reports 0% for a cancelled/
      // cancelled_by_user task) as "missing" and silently replaced it with
      // 50 — the exact stuck-at-50% value this bug report was about,
      // surviving in the Tasks table even after the server-side and
      // Overview-card fixes. Only fall back to 50 when progress is truly
      // absent (undefined/null), never when it is a real 0.
      const progressVal = (t.progress === undefined || t.progress === null) ? 50 : t.progress;

      // Exactly 7 columns: Task Name / ID | Started | Builder AI | Reviewer AI | Duration | Progress | Status
      return `
        <tr class="task-row ${isSelected ? 'selected' : ''}" data-task-id="${escapeHtml(t.id)}" style="cursor: pointer; ${isSelected ? 'background: #eff6ff;' : ''}">
          <td>
            <div class="task-name-title" title="${escapeHtml(t.instruction || '')}">${escapeHtml(taskTitleOf(t))}</div>
            <div class="task-name-id" title="${escapeHtml(t.id)}">${escapeHtml(t.id)}</div>
          </td>
          <td style="white-space: nowrap; font-size: 0.85rem;">${escapeHtml(startedStr)}</td>
          <td>
            <div style="font-weight: 600;">${escapeHtml(formatWorkerName(t.builder))}</div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(t.model || 'gemini-3.5-flash-lite')}</div>
          </td>
          <td>
            <div style="font-weight: 600;">${escapeHtml(formatWorkerName(t.reviewer))}</div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(t.reviewerModel || 'gemini-3.8-flash-medium')}</div>
          </td>
          <td style="white-space: nowrap; font-size: 0.85rem; font-family: var(--font-mono);">${escapeHtml(durationStr)}</td>
          <td>
            <div style="display: flex; align-items: center; gap: 0.4rem;">
              <div class="usage-progress" style="width: 70px; height: 6px;">
                <div class="usage-fill ${bInfo.cls === 'green' ? 'fill-green' : (bInfo.cls === 'amber' ? 'fill-amber' : 'fill-blue')}" style="width: ${progressVal}%;"></div>
              </div>
              <span style="font-size: 0.78rem; font-weight: 700;">${progressVal}%</span>
            </div>
          </td>
          <td>
            <span class="badge ${bInfo.cls}">${escapeHtml(bInfo.label)}</span>
          </td>
        </tr>
      `;
    }).join('');

    // Row click event — Final UI Closure item 2: opens the task detail
    // modal in place. It deliberately does NOT switch views any more; the
    // modal's "Open in Overview" button still does that for anyone who
    // wants the full workspace.
    tbody.querySelectorAll('.task-row').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-task-id');
        if (!id) return;
        State.currentTaskId = id;
        renderTasksTable();
        openTaskDetailModal(id);
      });
    });
  }


  // ── Task Detail Modal (Final UI Closure item 2) ──────────────────────────
  //
  // Restores the prototype's "click a task row to inspect it" interaction,
  // without leaving the Tasks page. Everything rendered here comes from the
  // real /api/tasks/:id payload (server.mjs getTaskDetails) — the same
  // source Overview already uses. Nothing is invented: every section below
  // checks whether its data actually exists and is skipped entirely when it
  // does not, so an old task with no reviewer, no applied files and no token
  // telemetry renders a short, correct modal rather than a wall of blanks.
  function fact(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return `
      <div class="task-detail-fact">
        <span class="task-detail-fact-k">${escapeHtml(label)}</span>
        <span class="task-detail-fact-v">${escapeHtml(String(value))}</span>
      </div>`;
  }

  function formatAbsoluteTime(value) {
    if (!value) return null;
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString();
  }

  function renderTaskDetailBody(t) {
    const badge = formatStatusBadge(t.status);
    const title = taskTitleOf(t);
    const instruction = t.instruction || '';

    // Builder / reviewer: task.json carries several generations of field
    // names (builderWorker vs selectedBuilder vs routingLog). Read them in
    // the same priority order the Tasks table does so an old task still
    // resolves, and omit the card entirely when none of them is present.
    const buildEntry = Array.isArray(t.routingLog) ? t.routingLog.find(r => r.role === 'build') : null;
    const reviewEntry = Array.isArray(t.routingLog) ? t.routingLog.find(r => r.role === 'review') : null;
    const builder = t.builderWorker || t.selectedBuilder || buildEntry?.worker || t.contributors?.[0] || null;
    const reviewer = t.reviewerWorker || t.selectedReviewer || t.reviewer || reviewEntry?.worker || null;
    const builderModel = t.builderModel || buildEntry?.model || null;
    const reviewerModel = t.reviewerModel || reviewEntry?.model || null;
    const builderTier = t.builderTierName || buildEntry?.tierName || null;
    const reviewerTier = t.reviewerTierName || reviewEntry?.tierName || null;
    const builderEffort = t.builderEffort || buildEntry?.effort || null;
    const reviewerEffort = t.reviewerEffort || reviewEntry?.effort || null;
    const specialist = t.specialistName || buildEntry?.specialistName || null;

    // Files: appliedFiles is what was actually written to the project root;
    // the manifest/changes list is what the builder produced. Prefer applied.
    let files = [];
    if (Array.isArray(t.appliedFiles) && t.appliedFiles.length) files = t.appliedFiles;
    else if (Array.isArray(t.changes) && t.changes.length) files = t.changes.map(c => (typeof c === 'string' ? c : c?.path)).filter(Boolean);
    else if (Array.isArray(t.manifest?.files) && t.manifest.files.length) files = t.manifest.files.map(f => (typeof f === 'string' ? f : f?.path)).filter(Boolean);

    const tu = t.tokenUsage || null;
    const hasTokens = tu && typeof tu.totalTokens === 'number' && tu.totalTokens > 0;

    const created = formatAbsoluteTime(t.created);
    const completed = formatAbsoluteTime(t.completionTime);
    const duration = t.duration || null;
    const progress = (t.progress === undefined || t.progress === null) ? null : `${t.progress}%`;

    const factsHtml = [
      fact('Status', badge.label),
      fact('Project', t.projectName || t.project),
      fact('Created', created),
      fact('Completed', completed),
      fact('Duration', duration),
      fact('Progress', progress),
      fact('Revision', t.revision),
      hasTokens ? fact('Tokens used', `${Number(tu.totalTokens).toLocaleString()}${tu.totalAccuracy && tu.totalAccuracy !== 'Unavailable' ? ` (${tu.totalAccuracy})` : ''}`) : ''
    ].join('');

    const parts = [];

    parts.push(`
      <div class="task-detail-head">
        <div class="task-detail-title-row">
          <h2 class="task-detail-title" id="task-detail-modal-title">${escapeHtml(title)}</h2>
          <span class="badge ${badge.cls}">${escapeHtml(badge.label)}</span>
        </div>
        <p class="task-detail-meta">Task ID: <code>${escapeHtml(t.id || '')}</code>${t.kind ? ` • ${escapeHtml(t.kind)}` : ''}</p>
      </div>`);

    if (factsHtml.trim()) {
      parts.push(`<div class="task-detail-section"><div class="task-detail-facts">${factsHtml}</div></div>`);
    }

    if (t.summary) {
      parts.push(`
        <div class="task-detail-section">
          <h4>Summary</h4>
          <div class="task-detail-instruction">${escapeHtml(t.summary)}</div>
        </div>`);
    }

    // The complete original instruction, never truncated — the short title
    // above is only a label, this is the canonical prompt.
    if (instruction) {
      parts.push(`
        <div class="task-detail-section">
          <h4>Original instruction</h4>
          <div class="task-detail-instruction">${escapeHtml(instruction)}</div>
        </div>`);
    }

    if (builder || reviewer) {
      const card = (label, name, model, tier, effort, extra) => {
        if (!name) return '';
        const sub = [model, tier, effort ? `effort: ${effort}` : null, extra].filter(Boolean).join(' • ');
        return `
          <div class="task-detail-role-card">
            <span class="task-detail-role-label">${escapeHtml(label)}</span>
            <div class="task-detail-role-name">${escapeHtml(formatWorkerName(name))}</div>
            ${sub ? `<div class="task-detail-role-sub">${escapeHtml(sub)}</div>` : ''}
          </div>`;
      };
      parts.push(`
        <div class="task-detail-section">
          <h4>Assigned workers</h4>
          <div class="task-detail-pair-grid">
            ${card('Builder', builder, builderModel, builderTier, builderEffort, specialist)}
            ${card('Reviewer', reviewer, reviewerModel, reviewerTier, reviewerEffort, t.reviewerQualification?.badge)}
          </div>
        </div>`);
    }

    parts.push(`
      <div class="task-detail-section">
        <h4>Modified files</h4>
        ${files.length
          ? `<ul class="task-detail-file-list">${files.map(f => `<li>${escapeHtml(String(f))}</li>`).join('')}</ul>`
          : '<p class="task-detail-empty">No file changes recorded for this task.</p>'}
      </div>`);

    // Validator result — real pass/fail plus the real check count.
    if (t.tests && typeof t.tests.passed === 'boolean') {
      const n = t.tests.checksCount ?? t.tests.checks?.length;
      parts.push(`
        <div class="task-detail-section">
          <div class="task-detail-callout ${t.tests.passed ? 'pass' : 'fail'}">
            <h4>Automated validation</h4>
            ${t.tests.passed ? 'Passed' : 'Failed'}${n != null ? ` — ${n} check${n === 1 ? '' : 's'}` : ''}
          </div>
        </div>`);
    }

    // Independent reviewer finding.
    if (t.review && (t.review.verdict || t.review.summary)) {
      const passed = t.review.verdict === 'pass';
      const issues = Array.isArray(t.review.issues) ? t.review.issues.filter(Boolean) : [];
      parts.push(`
        <div class="task-detail-section">
          <div class="task-detail-callout ${passed ? 'pass' : 'warn'}">
            <h4>Reviewer audit finding${t.review.verdict ? ` — ${escapeHtml(String(t.review.verdict).toUpperCase())}` : ''}</h4>
            ${t.review.summary ? escapeHtml(t.review.summary) : ''}
            ${issues.length ? `<ul>${issues.map(i => `<li>${escapeHtml(String(i))}</li>`).join('')}</ul>` : ''}
          </div>
        </div>`);
    }

    // Approval / rejection decision actually recorded on disk.
    const approval = t.approvalData || t.approval;
    if (approval && approval.decision) {
      parts.push(`
        <div class="task-detail-section">
          <div class="task-detail-callout ${approval.decision === 'approved' ? 'pass' : 'warn'}">
            <h4>CTO decision — ${escapeHtml(String(approval.decision).toUpperCase())}</h4>
            ${approval.reason ? escapeHtml(approval.reason) : 'No reason recorded.'}
          </div>
        </div>`);
    }

    // Anything genuinely waiting on the CTO right now.
    if (t.decisionRequired && (t.decisionRequired.question || t.decisionRequired.reason)) {
      parts.push(`
        <div class="task-detail-section">
          <div class="task-detail-callout info">
            <h4>Awaiting CTO decision</h4>
            ${escapeHtml(t.decisionRequired.question || t.decisionRequired.reason || '')}
          </div>
        </div>`);
    }

    // Guardrail flag — real, set by coding.mjs when a task passed its tier
    // token threshold.
    if (t.guardrailHardFlagged && t.guardrailReason) {
      parts.push(`
        <div class="task-detail-section">
          <div class="task-detail-callout warn">
            <h4>Token / time guardrail flagged</h4>
            ${escapeHtml(t.guardrailReason)}
          </div>
        </div>`);
    }

    // Failure / blocker information.
    const failure = t.failure;
    if (failure || t.error) {
      const detail = failure?.reason || t.error || 'Task execution failed.';
      const tech = failure?.technicalError && failure.technicalError !== detail ? failure.technicalError : null;
      parts.push(`
        <div class="task-detail-section">
          <div class="task-detail-callout fail">
            <h4>Failure${failure?.stage ? ` — ${escapeHtml(failure.stage)}` : ''}</h4>
            ${escapeHtml(detail)}
            ${tech ? `<ul><li>${escapeHtml(tech)}</li></ul>` : ''}
          </div>
        </div>`);
    }

    // Context-integrity verdict, when the backend reports a mismatch.
    if (t.contextIntegrity && t.contextIntegrity.valid === false && t.contextIntegrity.reason) {
      parts.push(`
        <div class="task-detail-section">
          <div class="task-detail-callout warn">
            <h4>Context integrity — ${escapeHtml(t.contextIntegrity.reasonCode || 'UNVERIFIED')}</h4>
            ${escapeHtml(t.contextIntegrity.reason)}
          </div>
        </div>`);
    }

    return parts.join('');
  }

  async function openTaskDetailModal(taskId) {
    const modal = document.getElementById('task-detail-modal');
    const body = document.getElementById('task-detail-modal-body');
    if (!modal || !body || !taskId) return;

    State.detailModalTaskId = taskId;
    // Fall back to the list record immediately so the modal never opens
    // blank, then enrich it with the full detail payload.
    const listRecord = State.tasks.find(t => t.id === taskId) || { id: taskId };
    body.innerHTML = renderTaskDetailBody(listRecord);
    modal.classList.add('active');

    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`);
      if (!res.ok) return;
      const detail = await res.json();
      // Guard against a slow response landing after the CTO has already
      // closed the modal or opened a different task.
      if (State.detailModalTaskId !== taskId || !modal.classList.contains('active')) return;
      body.innerHTML = renderTaskDetailBody({ ...listRecord, ...detail });
    } catch {
      // Keep the list-record view; it is real data, just less of it.
    }
  }

  function closeTaskDetailModal() {
    const modal = document.getElementById('task-detail-modal');
    if (modal) modal.classList.remove('active');
    State.detailModalTaskId = null;
  }

  function initTaskDetailModal() {
    const modal = document.getElementById('task-detail-modal');
    if (!modal) return;
    document.getElementById('task-detail-modal-close')?.addEventListener('click', closeTaskDetailModal);
    document.getElementById('task-detail-modal-close-btn')?.addEventListener('click', closeTaskDetailModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeTaskDetailModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('active')) closeTaskDetailModal();
    });
    // Preserves the pre-modal behavior for anyone who wants it: select the
    // task and jump to the full Overview workspace.
    document.getElementById('task-detail-open-overview')?.addEventListener('click', async () => {
      const id = State.detailModalTaskId;
      closeTaskDetailModal();
      if (!id) return;
      State.currentTaskId = id;
      renderTasksTable();
      await fetchTaskDetails(id);
      switchView('overview');
    });
  }

  function initTasksViewControls() {
    // Filter tabs
    const filterTabs = document.querySelectorAll('.task-filter-tab[data-filter]');
    filterTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        filterTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        State.taskFilter = tab.getAttribute('data-filter') || 'all';
        renderTasksTable();
      });
    });

    // Search input
    const searchInput = document.getElementById('task-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        State.taskSearch = e.target.value.trim();
        renderTasksTable();
      });
    }

    // New Task Modal
    const btnNewTask = document.getElementById('btn-open-new-task');
    const modalNewTask = document.getElementById('new-task-modal');
    const btnCancel = document.getElementById('new-task-cancel-btn');
    const btnClose = document.getElementById('new-task-modal-close');
    const btnSubmit = document.getElementById('new-task-submit-btn');

    if (btnNewTask && modalNewTask) {
      btnNewTask.addEventListener('click', () => modalNewTask.classList.add('active'));
    }
    if (btnCancel && modalNewTask) {
      btnCancel.addEventListener('click', () => modalNewTask.classList.remove('active'));
    }
    if (btnClose && modalNewTask) {
      btnClose.addEventListener('click', () => modalNewTask.classList.remove('active'));
    }

    if (btnSubmit && modalNewTask) {
      btnSubmit.addEventListener('click', async () => {
        const textEl = document.getElementById('new-task-instruction');
        const titleInput = document.getElementById('new-task-title');
        const claudeCheck = document.getElementById('new-task-allow-claude');
        const instruction = (textEl?.value || '').trim();
        // Optional. Blank means the server derives a short title from the
        // instruction instead.
        const taskTitle = (titleInput?.value || '').trim();
        if (!instruction) {
          alert('Please enter a task instruction');
          return;
        }

        try {
          btnSubmit.disabled = true;
          btnSubmit.textContent = 'Submitting...';
          const res = await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instruction,
              title: taskTitle,
              project: State.activeProjectId,
              allowClaude: Boolean(claudeCheck?.checked)
            })
          });
          const data = await res.json();
          if (res.ok) {
            modalNewTask.classList.remove('active');
            if (textEl) textEl.value = '';
            if (titleInput) titleInput.value = '';
            showToast('New task launched successfully!', 'success');
            if (data.taskId) State.currentTaskId = data.taskId;
            await fetchTasks();
            switchView('overview');
          } else {
            showToast(data.error || 'Failed to start task', 'error');
          }
        } catch (err) {
          showToast('Error starting task', 'error');
        } finally {
          btnSubmit.disabled = false;
          btnSubmit.textContent = 'Execute Task';
        }
      });
    }
  }

  // View 3: AI Team — Fleet Cards
  function renderTeamView() {
    const findW = (id) => State.workers.find(w => w.id === id);
    // Worker health (degraded/cooldown) overrides the normal ACTIVE/AVAILABLE
    // badge so a worker with recent repeated failures is visibly flagged,
    // not just silently deprioritized in routing.
    const applyHealthBadge = (worker, badgeEl) => {
      if (!worker || !badgeEl || !worker.health || worker.health === 'healthy') return false;
      if (worker.health === 'cooldown') {
        badgeEl.textContent = 'COOLDOWN';
        badgeEl.className = 'badge red';
        badgeEl.title = worker.healthDetail || 'Temporarily excluded from routing after repeated failures';
        return true;
      }
      if (worker.health === 'degraded') {
        badgeEl.textContent = 'DEGRADED';
        badgeEl.className = 'badge amber';
        badgeEl.title = worker.healthDetail || 'Recent failures; still eligible but deprioritized';
        return true;
      }
      return false;
    };

    // Cline
    const wCline = findW('cline');
    const tCline = document.getElementById('team-toggle-cline');
    const sCline = document.getElementById('team-status-cline');
    if (tCline) tCline.checked = wCline?.userEnabled !== false;
    if (sCline) {
      const active = wCline?.userEnabled !== false && wCline?.status === 'Available';
      sCline.textContent = active ? 'ACTIVE (ON)' : (wCline?.userEnabled === false ? 'DISABLED (OFF)' : 'STANDBY');
      sCline.className = `badge ${active ? 'green' : 'gray'}`;
      applyHealthBadge(wCline, sCline);
    }

    // Codex
    const wCodex = findW('codex');
    const tCodex = document.getElementById('team-toggle-codex');
    const sCodex = document.getElementById('team-status-codex');
    if (tCodex) tCodex.checked = wCodex?.userEnabled !== false;
    if (sCodex) {
      const active = wCodex?.userEnabled !== false && wCodex?.status === 'Available';
      sCodex.textContent = active ? 'AVAILABLE (ON)' : (wCodex?.userEnabled === false ? 'DISABLED (OFF)' : 'UNAVAILABLE');
      sCodex.className = `badge ${active ? 'green' : 'gray'}`;
      applyHealthBadge(wCodex, sCodex);
    }

    // Claude Code
    const wClaude = findW('claude-code');
    const tClaude = document.getElementById('team-toggle-claude');
    const sClaude = document.getElementById('team-status-claude');
    if (tClaude) tClaude.checked = wClaude?.userEnabled !== false;
    if (sClaude) {
      if (wClaude?.userEnabled === false) {
        sClaude.textContent = 'DISABLED (OFF)';
        sClaude.className = 'badge gray';
      } else if (State.claudeReserve) {
        sClaude.textContent = 'RESERVE (ON)';
        sClaude.className = 'badge purple';
      } else {
        sClaude.textContent = 'ACTIVE (ON)';
        sClaude.className = 'badge green';
      }
    }

    // Antigravity
    const wAntigravity = findW('antigravity');
    const tAntigravity = document.getElementById('team-toggle-antigravity');
    const sAntigravity = document.getElementById('team-status-antigravity');
    if (tAntigravity) tAntigravity.checked = wAntigravity?.userEnabled !== false;
    if (sAntigravity) {
      const active = wAntigravity?.userEnabled !== false && wAntigravity?.status === 'Available';
      sAntigravity.textContent = active ? 'ACTIVE (ON)' : (wAntigravity?.userEnabled === false ? 'DISABLED (OFF)' : 'UNAVAILABLE');
      sAntigravity.className = `badge ${active ? 'green' : 'gray'}`;
      applyHealthBadge(wAntigravity, sAntigravity);
    }
  }

  // View 4: Task Progress — Dedicated Timeline
  function updateProgressTaskSelect() {
    const sel = document.getElementById('progress-task-select');
    if (!sel) return;
    sel.innerHTML = State.tasks.map(t => {
      const selected = t.id === State.currentTaskId;
      const bInfo = formatStatusBadge(t.status);
      const title = taskTitleOf(t);
      return `<option value="${escapeHtml(t.id)}" ${selected ? 'selected' : ''}>${escapeHtml(title)} (${escapeHtml(bInfo.label)})</option>`;
    }).join('');
  }

  function renderTaskProgressView() {
    const container = document.getElementById('progress-dedicated-timeline');
    const t = State.currentTask;
    if (!container) return;

    if (!t) {
      container.innerHTML = '<div style="color: var(--text-muted); padding: 1.5rem;">Select a task to view its progress timeline.</div>';
      return;
    }

    // Strip values
    const sBuilder = document.getElementById('prog-strip-builder');
    if (sBuilder) sBuilder.textContent = `${formatWorkerName(t.selectedBuilder || 'cline')} (${t.builderModel || 'gemini-3.5-flash-lite'})`;

    const sReviewer = document.getElementById('prog-strip-reviewer');
    if (sReviewer) sReviewer.textContent = `${formatWorkerName(t.selectedReviewer || 'antigravity')} (${t.reviewerModel || 'gemini-3.8-flash-medium'})`;

    const sStep = document.getElementById('prog-strip-step');
    if (sStep) {
      if (t.status === 'awaiting_approval') sStep.textContent = 'Waiting for CTO Approval';
      else if (t.status === 'completed' || t.status === 'approved') sStep.textContent = 'Completed & Delivered';
      else sStep.textContent = (t.status || 'Active').replace(/_/g, ' ');
    }

    const sDuration = document.getElementById('prog-strip-duration');
    if (sDuration) sDuration.textContent = t.duration || '0m 00s';

    const sStatus = document.getElementById('prog-strip-status');
    if (sStatus) sStatus.textContent = formatStatusBadge(t.status).label;

    container.innerHTML = renderTimelineHtml(t.activityLog || [], 'dedicated-timeline-feed');
  }

  function initTaskProgressControls() {
    const sel = document.getElementById('progress-task-select');
    if (sel) {
      sel.addEventListener('change', async (e) => {
        const id = e.target.value;
        if (id) {
          State.currentTaskId = id;
          await fetchTaskDetails(id);
          renderTaskProgressView();
        }
      });
    }

    const toggle = document.getElementById('toggle-progress-autofollow');
    if (toggle) {
      toggle.checked = State.autoFollow;
      toggle.addEventListener('change', (e) => {
        syncAutoFollow(e.target.checked);
      });
    }
  }

  // View 5: Technical Logs — Granular Diagnostic Feed
  function renderTechnicalLogsView() {
    const feed = document.getElementById('tech-logs-full-feed');
    if (!feed) return;
    const t = State.currentTask;

    if (!t || !t.events || t.events.length === 0) {
      feed.innerHTML = '<div style="color: #64748b; font-family: var(--font-mono); font-size: 0.85rem; padding: 1.5rem;">No technical events recorded for this task.</div>';
      return;
    }

    let events = t.events.slice();

    // Filter by tag
    if (State.techLogFilter !== 'all') {
      const tag = State.techLogFilter.toLowerCase();
      events = events.filter(ev => {
        const role = (ev.role || '').toLowerCase();
        const type = (ev.eventType || ev.type || '').toLowerCase();
        if (tag === 'builder') return role === 'builder' || role === 'cline' || role === 'codex';
        if (tag === 'reviewer') return role === 'reviewer' || role === 'antigravity' || role === 'claude';
        if (tag === 'router') return role === 'router' || type.includes('route');
        if (tag === 'validation') return type.includes('valid') || type.includes('test');
        if (tag === 'error') return type.includes('fail') || type.includes('error');
        return true;
      });
    }

    // Filter by search
    if (State.techLogSearch) {
      const q = State.techLogSearch.toLowerCase();
      events = events.filter(ev =>
        JSON.stringify(ev).toLowerCase().includes(q)
      );
    }

    const prevStreamEl = document.getElementById('tech-logs-full-stream') || feed;
    const prevScroll = prevStreamEl ? prevStreamEl.scrollTop : null;

    feed.innerHTML = renderTechLogsFeedHtml(events, 'tech-logs-full-stream');

    function applyFullLogsScroll() {
      if (State.autoFollow) {
        scrollToBottom('tech-logs-full-stream');
        if (feed) feed.scrollTop = feed.scrollHeight;
      } else if (prevScroll !== null) {
        const streamEl = document.getElementById('tech-logs-full-stream');
        if (streamEl) streamEl.scrollTop = prevScroll;
        if (feed) feed.scrollTop = prevScroll;
      }
    }

    applyFullLogsScroll();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(applyFullLogsScroll);
    }
  }

  function initTechnicalLogsControls() {
    const chips = document.querySelectorAll('.tech-filter-chip');
    chips.forEach(chip => {
      chip.addEventListener('click', () => {
        chips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        State.techLogFilter = chip.getAttribute('data-tag') || 'all';
        renderTechnicalLogsView();
      });
    });

    const searchInput = document.getElementById('tech-log-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        State.techLogSearch = e.target.value.trim();
        renderTechnicalLogsView();
      });
    }

    const toggle = document.getElementById('toggle-tech-autofollow');
    if (toggle) {
      toggle.checked = State.autoFollow;
      toggle.addEventListener('change', (e) => {
        syncAutoFollow(e.target.checked);
      });
    }
  }

  // View 6: Settings Controls
  function initSettingsControls() {
    const reviewPolicySelect = document.getElementById('review-policy-select');
    if (reviewPolicySelect) {
      reviewPolicySelect.value = State.reviewPolicy;
      reviewPolicySelect.addEventListener('change', async (e) => {
        const policy = e.target.value;
        const previous = State.reviewPolicy;
        try {
          const res = await fetch('/api/review-policy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ policy })
          });
          if (res.ok) {
            State.reviewPolicy = policy;
            const labels = { independent: 'Independent Review', cto_only: 'CTO Review Only', disabled: 'Review Disabled' };
            showToast(`Reviewer policy set to ${labels[policy] || policy}`, 'success');
          } else {
            e.target.value = previous;
            showToast('Failed to update reviewer policy', 'error');
          }
        } catch (err) {
          e.target.value = previous;
          showToast('Reviewer policy update request failed', 'error');
        }
      });
    }

    const btnAdv = document.getElementById('btn-advanced-settings-toggle');
    const contentAdv = document.getElementById('advanced-settings-content');
    if (btnAdv && contentAdv) {
      btnAdv.addEventListener('click', () => {
        const isHidden = contentAdv.style.display === 'none';
        contentAdv.style.display = isHidden ? 'block' : 'none';
        btnAdv.textContent = isHidden ? 'Hide Advanced Settings ▲' : 'Show Advanced Settings ▼';
      });
    }

    const btnRotateToken = document.getElementById('btn-rotate-token');
    if (btnRotateToken) {
      btnRotateToken.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/connector/token/rotate', { method: 'POST' });
          if (res.ok) {
            showToast('Connector token rotated successfully', 'success');
          } else {
            showToast('Failed to rotate token', 'error');
          }
        } catch {
          showToast('Token rotation request failed', 'error');
        }
      });
    }
  }

  // Modal Dialog Controls
  //
  // The task-detail close buttons that used to be wired here pointed at
  // #modal-close-btn / #btn-close-modal — ids belonging to a modal shell
  // that nothing ever filled or opened. That shell is now the live task
  // detail modal (Final UI Closure item 2) and initTaskDetailModal() owns
  // its controls, including overlay-click and Escape, so this no longer
  // duplicates that wiring.
  function initModals() {}

  // Lifecycle Initialization
  async function init() {
    initNavigation();
    initHeaderControls();
    initPlatformLimitToggles();
    initTaskActionButtons();
    initLogViewControls();
    initTasksViewControls();
    initTaskProgressControls();
    initTechnicalLogsControls();
    initSettingsControls();
    initCtoInboxControls();
    initOfficeViewControls();
    initModals();
    initTaskDetailModal();

    // Initial load
    await fetchStatus();
    await fetchTasks();
    await fetchCtoAttention();

    // Periodic poll every 3 seconds for fresh task records and status.
    // CTO Attention piggybacks on this same cadence rather than a separate
    // timer — cheap, and matches the handover doc's "do not burn quota
    // simply waiting" / "avoid polling aggressively" guidance. Office View
    // only refetches while it is the active tab, same reasoning.
    State.pollTimer = setInterval(async () => {
      await fetchStatus();
      await fetchTasks();
      await fetchCtoAttention();
      if (State.activeView === 'office') await fetchOfficeView();
    }, 3000);
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
