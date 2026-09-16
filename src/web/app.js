// Adaptive Router — Production Executive Dashboard Client
(function() {
  'use strict';

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
    techLogFilter: 'all',
    techLogSearch: '',
    taskSearch: '',
    eventSource: null,
    pollTimer: null
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

    if (viewName === 'tasks') {
      renderTasksTable();
    } else if (viewName === 'team') {
      renderTeamView();
    } else if (viewName === 'progress') {
      renderTaskProgressView();
    } else if (viewName === 'logs') {
      renderTechnicalLogsView();
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

      if (data.activeRunningTask && !State.currentTaskId) {
        State.currentTaskId = data.activeRunningTask;
      }

      renderHeader();
      renderPlatformLimits();
      renderTeamView();
    } catch (err) {
      console.warn('Error fetching /api/status:', err);
    }
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

      // Select newest/active task if none selected
      if (!State.currentTaskId && State.tasks.length > 0) {
        State.currentTaskId = State.tasks[0].id;
      }

      // Populate progress task selector dropdown
      updateProgressTaskSelect();

      // Render table if visible
      renderTasksTable();

      // Fetch details of current task
      if (State.currentTaskId) {
        await fetchTaskDetails(State.currentTaskId);
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

  // View 1: Overview — Platform Limits & Usage
  function renderPlatformLimits() {
    const findW = (id) => State.workers.find(w => w.id === id);

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
    if (!t) return;

    // Title & Status Badge — truncate a long instruction to a short
    // summary with a "View full instruction" expand toggle, instead of
    // dumping the whole raw instruction text into the header.
    const fullInstruction = t.instruction || t.id;
    const TITLE_SUMMARY_LIMIT = 100;
    const titleEl = document.getElementById('current-task-title');
    const titleToggle = document.getElementById('current-task-title-toggle');
    const titleFull = document.getElementById('current-task-title-full');
    const isLongInstruction = fullInstruction.length > TITLE_SUMMARY_LIMIT;
    if (titleEl) {
      const firstLine = fullInstruction.split(/\r?\n/)[0];
      const summary = firstLine.length > TITLE_SUMMARY_LIMIT
        ? `${firstLine.slice(0, TITLE_SUMMARY_LIMIT).trim()}…`
        : (isLongInstruction ? `${firstLine}…` : firstLine);
      titleEl.textContent = summary;
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

    const nextStepVal = document.getElementById('task-next-step-value');
    if (nextStepVal) {
      if (t.status === 'awaiting_approval') nextStepVal.textContent = 'CTO Approval Required (Stage B)';
      else if (t.status === 'needs_human_input') nextStepVal.textContent = 'Action Permission Needed';
      else if (t.status === 'building' || t.status === 'running') nextStepVal.textContent = 'Autonomous Build Phase';
      else if (t.status === 'reviewing' || t.status === 'testing') nextStepVal.textContent = 'Independent Review Phase';
      else if (t.status === 'paused_by_user') nextStepVal.textContent = 'Task Paused by User';
      else if (t.status === 'approved' || t.status === 'completed') nextStepVal.textContent = 'Execution Complete (Delivered)';
      else if (t.status === 'rejected') nextStepVal.textContent = 'Draft Rejected';
      else nextStepVal.textContent = 'Autonomous Pipeline Active';
    }

    const durationVal = document.getElementById('task-duration-value');
    if (durationVal) {
      if (t.created) {
        const start = new Date(t.created).getTime();
        const end = t.completionTime ? new Date(t.completionTime).getTime() : Date.now();
        const sec = Math.max(0, Math.floor((end - start) / 1000));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        durationVal.textContent = `${m}m ${s < 10 ? '0' : ''}${s}s elapsed`;
      } else {
        durationVal.textContent = '—';
      }
    }

    // Progress bar
    let pct = 50;
    if (t.status === 'completed' || t.status === 'approved') pct = 100;
    else if (t.status === 'awaiting_approval') pct = 85;
    else if (t.status === 'reviewing' || t.status === 'testing') pct = 70;
    else if (t.status === 'building' || t.status === 'running') pct = 45;
    else if (t.status === 'failed' || t.status === 'rejected') pct = 60;

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

    if (State.autoFollow) {
      if (State.overviewLogsMode === 'split') {
        scrollToBottom('split-progress-feed');
        scrollToBottom('split-tech-feed');
      } else if (State.overviewLogsMode === 'progress') {
        scrollToBottom('overview-timeline');
      } else if (State.overviewLogsMode === 'logs') {
        scrollToBottom('overview-tech-feed');
      }
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
    const el = document.getElementById(elId);
    if (el) el.scrollTop = el.scrollHeight;
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
      toggleAutofollow.addEventListener('change', (e) => {
        State.autoFollow = e.target.checked;
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
      if (btnOverride) btnOverride.addEventListener('click', () => resumeTask(t.id, 'preserve_claude'));
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
      const progressVal = t.progress || 50;

      // Exactly 7 columns: Task Name / ID | Started | Builder AI | Reviewer AI | Duration | Progress | Status
      return `
        <tr class="task-row ${isSelected ? 'selected' : ''}" data-task-id="${escapeHtml(t.id)}" style="cursor: pointer; ${isSelected ? 'background: #eff6ff;' : ''}">
          <td>
            <div style="font-weight: 700; color: var(--text-main);">${escapeHtml(t.instruction || t.summary || t.id)}</div>
            <div style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">${escapeHtml(t.id)}</div>
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

    // Row click event
    tbody.querySelectorAll('.task-row').forEach(row => {
      row.addEventListener('click', async () => {
        const id = row.getAttribute('data-task-id');
        if (id) {
          State.currentTaskId = id;
          renderTasksTable();
          await fetchTaskDetails(id);
          switchView('overview');
        }
      });
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
        const claudeCheck = document.getElementById('new-task-allow-claude');
        const instruction = (textEl?.value || '').trim();
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
              project: State.activeProjectId,
              allowClaude: Boolean(claudeCheck?.checked)
            })
          });
          const data = await res.json();
          if (res.ok) {
            modalNewTask.classList.remove('active');
            if (textEl) textEl.value = '';
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
      const title = (t.instruction || t.id).slice(0, 45);
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
      toggle.addEventListener('change', (e) => {
        State.autoFollow = e.target.checked;
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

    feed.innerHTML = renderTechLogsFeedHtml(events, 'tech-logs-full-stream');

    if (State.autoFollow) {
      scrollToBottom('tech-logs-full-stream');
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
      toggle.addEventListener('change', (e) => {
        State.autoFollow = e.target.checked;
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
  function initModals() {
    const modalDetail = document.getElementById('task-detail-modal');
    const btnCloseModal = document.getElementById('modal-close-btn');
    const btnCloseModal2 = document.getElementById('btn-close-modal');

    if (btnCloseModal && modalDetail) {
      btnCloseModal.addEventListener('click', () => modalDetail.classList.remove('active'));
    }
    if (btnCloseModal2 && modalDetail) {
      btnCloseModal2.addEventListener('click', () => modalDetail.classList.remove('active'));
    }
  }

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
    initModals();

    // Initial load
    await fetchStatus();
    await fetchTasks();

    // Periodic poll every 3 seconds for fresh task records and status
    State.pollTimer = setInterval(async () => {
      await fetchStatus();
      await fetchTasks();
    }, 3000);
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
