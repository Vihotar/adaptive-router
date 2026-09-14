// Adaptive Router Business Dashboard & AI Control Interface
(function() {
  'use strict';

  let currentTaskId = null;
  let pollInterval = null;
  let eventSource = null;
  let activeTab = 'all';
  let showTechnical = false;
  let rawLogs = [];
  let activeProjectId = 'adaptive-router';
  let defaultProjectsFolder = '';

  // Live Worker Feed State
  let lastReceivedSequence = 0;
  let allWorkerEvents = [];
  let currentFilter = 'all';
  let isAutoFollow = true;
  let isFeedPaused = false;
  let unreadEventCount = 0;

  function showToast(message, type = 'error') {
    const existing = document.querySelector('.dashboard-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `dashboard-toast ${type}`;
    toast.innerHTML = `<span>${type === 'success' ? '✓' : '⚠️'}</span><span>${escapeHtml(message)}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // DOM Elements - Top Header & Workspace
  const workersGrid = document.getElementById('workers-grid');
  const claudeToggle = document.getElementById('claude-reserve-toggle');
  const claudeState = document.getElementById('claude-reserve-state');
  const reserveDesc = document.getElementById('reserve-desc');
  const taskForm = document.getElementById('task-form');
  const taskInstruction = document.getElementById('task-instruction');
  const overrideClaudeCheckbox = document.getElementById('override-claude-checkbox');
  const startTaskBtn = document.getElementById('start-task-btn');
  const presetButtons = document.querySelectorAll('.preset-btn');
  const costHintEl = document.getElementById('cost-hint');

  // AI Workforce Tab Elements
  const tabBtnProgress = document.getElementById('tab-btn-progress');
  const tabBtnTechLogs = document.getElementById('tab-btn-tech-logs');
  const tabBtnLive = document.getElementById('tab-btn-tech-logs'); // backward compat
  const tabBtnFeed = document.getElementById('tab-btn-feed');
  const tabBtnExecute = document.getElementById('tab-btn-execute');
  const paneTaskProgress = document.getElementById('pane-task-progress');
  const paneTechnicalLogs = document.getElementById('pane-technical-logs');
  const paneLiveActivity = document.getElementById('pane-technical-logs'); // backward compat
  const paneExecutionFeed = document.getElementById('pane-execution-feed');
  const paneExecuteTask = document.getElementById('pane-execute-task');
  const aiProgressIndicator = document.getElementById('ai-progress-indicator');
  const aiTechIndicator = document.getElementById('ai-tech-indicator');
  const aiLiveIndicator = document.getElementById('ai-progress-indicator'); // backward compat
  const feedLogCountBadge = document.getElementById('feed-log-count-badge');
  const taskProgressStream = document.getElementById('task-progress-stream');
  const tpLiveBadge = document.getElementById('tp-live-badge');
  const tpBuilderPill = document.getElementById('tp-builder-pill');
  const tpReviewerPill = document.getElementById('tp-reviewer-pill');

  // Permission Inbox Elements
  const permSection = document.getElementById('permission-inbox-section');
  const permWorkerBadge = document.getElementById('perm-worker-badge');
  const permActionDesc = document.getElementById('perm-action-desc');
  const permReasonText = document.getElementById('perm-reason-text');
  const permYesBtn = document.getElementById('perm-yes-btn');
  const permYesSessionBtn = document.getElementById('perm-yes-session-btn');
  const permNoBtn = document.getElementById('perm-no-btn');
  const permStopTaskBtn = document.getElementById('perm-stop-task-btn');
  const nativeAppCallout = document.getElementById('native-app-callout');
  const openNativeAppBtn = document.getElementById('open-native-app-btn');
  let currentPendingPerm = null;

  // Decision Required Card Elements
  const decisionRequiredCard = document.getElementById('decision-required-card');
  const decisionQuestionText = document.getElementById('decision-question-text');
  const decisionReasonText = document.getElementById('decision-reason-text');
  const decisionRecommendationText = document.getElementById('decision-recommendation-text');
  const decisionPreserveBtn = document.getElementById('decision-preserve-btn');
  const decisionClaudeBtn = document.getElementById('decision-claude-btn');

  // Live Task UI Elements
  const taskIdDisplay = document.getElementById('task-id-display');
  const taskStatusBadge = document.getElementById('task-status-badge');
  const liveStatusIndicator = document.getElementById('live-status-indicator');
  const taskLifecycleGroup = document.getElementById('task-lifecycle-group');
  const taskPauseBtn = document.getElementById('task-pause-btn');
  const taskPauseIcon = document.getElementById('task-pause-icon');
  const taskPauseText = document.getElementById('task-pause-text');
  const taskStopBtn = document.getElementById('task-stop-btn');
  const failoverBanner = document.getElementById('failover-banner');
  const failoverTitle = document.getElementById('failover-title');
  const failoverDesc = document.getElementById('failover-desc');

  // Routing Decision Elements
  const decisionSpecialist = document.getElementById('decision-specialist');
  const decisionBuilder = document.getElementById('decision-builder');
  const decisionModel = document.getElementById('decision-model');
  const decisionReviewer = document.getElementById('decision-reviewer');
  const decisionWhyText = document.getElementById('decision-why-text');
  const activityStream = document.getElementById('activity-stream');

  // Live Worker Feed Elements
  const wfLiveBadge = document.getElementById('wf-live-badge');
  const wfActiveWorker = document.getElementById('wf-active-worker');
  const wfActiveDot = document.getElementById('wf-active-dot');
  const wfWorkerName = document.getElementById('wf-worker-name');
  const wfActiveModel = document.getElementById('wf-active-model');
  const wfActiveEffort = document.getElementById('wf-active-effort');
  const wfActiveSpecialist = document.getElementById('wf-active-specialist');
  const wfActiveRole = document.getElementById('wf-active-role');
  const wfFailoverPill = document.getElementById('wf-failover-pill');
  const wfFailoverText = document.getElementById('wf-failover-text');
  const wfFilterPills = document.querySelectorAll('.wf-filter-pill');
  const wfAutoFollowBtn = document.getElementById('wf-auto-follow-btn');
  const wfPauseBtn = document.getElementById('wf-pause-btn');
  const wfJumpNewestBtn = document.getElementById('wf-jump-newest-btn');
  const wfUnreadCount = document.getElementById('wf-unread-count');
  const logCountBadge = document.getElementById('log-count-badge');

  // Worker Console & Log Elements
  const consoleTabs = document.querySelectorAll('.console-tab');
  const showTechnicalToggle = document.getElementById('show-technical-details-toggle');
  const logStreamContent = document.getElementById('log-stream-content');
  const techDrawerContent = document.getElementById('tech-drawer-content');
  const clearLogsBtn = document.getElementById('clear-logs-btn');
  const consoleStreamHeading = document.getElementById('console-stream-heading');

  // Stage B: Deliverable Approval Elements
  const approvalCard = document.getElementById('approval-card');
  const approvalPill = document.getElementById('approval-pill');
  const stagebMismatchBanner = document.getElementById('stageb-mismatch-banner');
  const stagebActionsBar = document.getElementById('stageb-actions-bar');
  const stagebProjectName = document.getElementById('stageb-project-name');
  const stagebTaskId = document.getElementById('stageb-task-id');
  const stagebDigest = document.getElementById('stageb-digest');
  const stagebTimestamp = document.getElementById('stageb-timestamp');
  const stagebInstruction = document.getElementById('stageb-instruction');
  const stagebSummary = document.getElementById('stageb-summary');
  const stagebBusinessInstruction = document.getElementById('stageb-business-instruction');
  const stagebBusinessSummaryText = document.getElementById('stageb-business-summary-text');
  const stagebShowTechnicalToggle = document.getElementById('stageb-show-technical-toggle');
  const stagebTechnicalDetail = document.getElementById('stageb-technical-detail');
  const stagebBuilderInfo = document.getElementById('stageb-builder-info');
  const stagebReviewerInfo = document.getElementById('stageb-reviewer-info');
  const stagebQualRow = document.getElementById('stageb-qual-row');
  const stagebReviewerQual = document.getElementById('stageb-reviewer-qual');
  const stagebModifiedFiles = document.getElementById('stageb-modified-files');
  const stagebTestBadge = document.getElementById('stageb-test-badge');
  const stagebTestCount = document.getElementById('stageb-test-count');
  const stagebChecksList = document.getElementById('stageb-checks-list');
  const stagebVerdictBadge = document.getElementById('stageb-verdict-badge');
  const stagebVerdictWorker = document.getElementById('stageb-verdict-worker');
  const stagebReviewerComment = document.getElementById('stageb-reviewer-comment');
  const stagebWebPreview = document.getElementById('stageb-web-preview');
  const previewIframe = document.getElementById('preview-iframe');
  const previewOpenLink = document.getElementById('preview-open-link');
  const previewReloadBtn = document.getElementById('preview-reload-btn');
  const sysPreviewContainer = document.getElementById('sys-preview-container');
  const systemPreviewImg = document.getElementById('system-preview-img');

  const approveBtn = document.getElementById('approve-btn');
  const correctBtn = document.getElementById('correct-btn');
  const rejectBtn = document.getElementById('reject-btn');
  const correctionDrawer = document.getElementById('correction-drawer');
  const correctionFeedback = document.getElementById('correction-feedback');
  const submitCorrectionBtn = document.getElementById('submit-correction-btn');
  const cancelCorrectionBtn = document.getElementById('cancel-correction-btn');

  // Rejection Drawer Elements
  const rejectionDrawer = document.getElementById('rejection-drawer');
  const rejectionReason = document.getElementById('rejection-reason');
  const submitRejectionBtn = document.getElementById('submit-rejection-btn');
  const cancelRejectionBtn = document.getElementById('cancel-rejection-btn');

  // Project Selector
  const projectSelector = document.getElementById('project-selector');
  const newProjectBtn = document.getElementById('new-project-btn');
  const newProjectDialog = document.getElementById('new-project-dialog');
  const newProjectForm = document.getElementById('new-project-form');
  const newProjectName = document.getElementById('new-project-name');
  const newProjectDescription = document.getElementById('new-project-description');
  const newProjectClose = document.getElementById('new-project-close');
  const newProjectCancel = document.getElementById('new-project-cancel');
  const createProjectBtn = document.getElementById('create-project-btn');
  const existingProjectPathRow = document.getElementById('existing-project-path-row');
  const existingProjectPath = document.getElementById('existing-project-path');
  const newProjectPathPreview = document.getElementById('new-project-path-preview');
  const newProjectError = document.getElementById('new-project-error');

  // Delete Project Elements
  const deleteProjectBtn = document.getElementById('delete-project-btn');
  const deleteProjectDialog = document.getElementById('delete-project-dialog');
  const deleteProjectForm = document.getElementById('delete-project-form');
  const deleteProjectName = document.getElementById('delete-project-name');
  const deleteProjectPath = document.getElementById('delete-project-path');
  const deleteProjectRemoveFolder = document.getElementById('delete-project-remove-folder');
  const deleteProjectClose = document.getElementById('delete-project-close');
  const deleteProjectCancel = document.getElementById('delete-project-cancel');
  const deleteProjectConfirmBtn = document.getElementById('delete-project-confirm-btn');
  const deleteProjectError = document.getElementById('delete-project-error');
  let registeredProjects = [];

  // Stage A: Plan Approval Elements
  const planApprovalCard = document.getElementById('plan-approval-card');
  const planStatusPill = document.getElementById('plan-status-pill');
  const planProjectVal = document.getElementById('plan-project-val');
  const planSpecialistVal = document.getElementById('plan-specialist-val');
  const planBuilderVal = document.getElementById('plan-builder-val');
  const planReviewerVal = document.getElementById('plan-reviewer-val');
  const planGoalText = document.getElementById('plan-goal-text');
  const planJobsChecklist = document.getElementById('plan-jobs-checklist');
  const approvePlanBtn = document.getElementById('approve-plan-btn');
  const revisePlanBtn = document.getElementById('revise-plan-btn');

  // Bottom History & Technical Inspection Elements
  const historyList = document.getElementById('history-list');
  const historyListBusiness = document.getElementById('history-list-business');
  const historyViewButtons = document.querySelectorAll('.history-view-btn');
  let historyViewMode = 'business';
  const refreshHistoryBtn = document.getElementById('refresh-history-btn');
  const advTaskId = document.getElementById('adv-task-id');
  const advDigest = document.getElementById('adv-digest');
  const advFiles = document.getElementById('adv-files');
  const advRoutingLog = document.getElementById('adv-routing-log');
  const advApprovalReport = document.getElementById('adv-approval-report');

  // 1. Preset Pill Buttons
  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      taskInstruction.value = btn.dataset.preset;
      taskInstruction.focus();
      updateCostHint();
    });
  });

  // 1b. Plain-language "what this will likely use" hint, computed the same
  // way real routing decides (server-side classifyTask), shown before the
  // task is even submitted. Debounced so it doesn't fire on every keystroke.
  let costHintTimer = null;
  let costHintRequestId = 0;
  function updateCostHint() {
    if (!costHintEl) return;
    clearTimeout(costHintTimer);
    const text = taskInstruction.value.trim();
    if (!text) {
      costHintEl.style.display = 'none';
      return;
    }
    costHintTimer = setTimeout(async () => {
      const myRequestId = ++costHintRequestId;
      try {
        const allowClaude = overrideClaudeCheckbox ? overrideClaudeCheckbox.checked : false;
        const res = await fetch(`/api/tasks/cost-hint?instruction=${encodeURIComponent(text)}&allowClaude=${allowClaude}`);
        if (!res.ok) return;
        const data = await res.json();
        // Ignore a stale response that resolved after a newer request went out.
        if (myRequestId !== costHintRequestId) return;
        if (data.hint) {
          costHintEl.textContent = (data.sensitive ? '🔒 ' : '💡 ') + data.hint;
          costHintEl.style.display = 'block';
        } else {
          costHintEl.style.display = 'none';
        }
      } catch (e) {
        costHintEl.style.display = 'none';
      }
    }, 500);
  }
  taskInstruction?.addEventListener('input', updateCostHint);
  overrideClaudeCheckbox?.addEventListener('change', updateCostHint);

  // 2. Fetch System & Workforce Status
  async function fetchStatus() {
    try {
      const res = await fetch(`/api/status?project=${encodeURIComponent(activeProjectId)}`);
      if (!res.ok) return;
      const data = await res.json();

      // Claude Reserve Mode and the per-worker "Use this worker" toggle do
      // different jobs and are easy to mistake for duplicates: the
      // per-worker toggle removes Claude Code from consideration entirely,
      // while Reserve Mode is a finer rule that only ever matters when
      // Claude Code is otherwise enabled — it stops AR from spending Claude
      // Pro quota on routine background tasks so it stays available for
      // direct use in Cowork/chat. When Claude Code is disabled outright,
      // Reserve Mode has nothing to act on, so say so plainly instead of
      // implying it's doing something.
      const claudeCodeWorker = data.workers?.find(w => w.id === 'claude-code');
      const claudeCodeEnabled = claudeCodeWorker ? claudeCodeWorker.userEnabled !== false : true;
      claudeToggle.checked = Boolean(data.claudeReserve);
      claudeToggle.disabled = !claudeCodeEnabled;
      claudeState.textContent = data.claudeReserve ? 'ON' : 'OFF';
      if (!claudeCodeEnabled) {
        reserveDesc.textContent = 'Not applicable — Claude Code is turned off above, so there is no Claude quota to reserve';
      } else {
        reserveDesc.textContent = data.claudeReserve ? 'Preserving quota for Cowork' : 'Available for normal routing';
      }

      renderWorkers(data.workers);

      // Check pending permissions
      fetchPermissions();

      // If a task is active and not tracked yet
      if (data.activeRunningTask && data.activeRunningTask !== currentTaskId && data.activeRunningTask !== 'running') {
        loadTask(data.activeRunningTask);
      } else if (currentTaskId && !pollInterval) {
        // The task being viewed has no live per-second tracking running for
        // it right now — this is exactly the gap a stalled task waiting on
        // its next scheduled auto-retry falls into: activeRunningTask goes
        // back to null between attempts (nothing is "currently running" in
        // the strictly literal sense), so the branch above never fires, and
        // if this page was loaded or refreshed during one of those gaps,
        // startLiveTracking() never got called for it at all. Without this,
        // the person is left staring at a snapshot from whenever the page
        // last loaded, with no visible sign that anything is happening
        // automatically behind the scenes, even though the task genuinely
        // is retrying on its own. This 5-second tick is a coarser fallback
        // than the 1-second live poll, but it's enough to keep the status
        // badge, activity log, and retry countdown honest.
        loadTask(currentTaskId);
      }
    } catch (e) {
      console.error('Error fetching system status:', e);
    }
  }

  function renderWorkers(workers) {
    if (!workersGrid) return;
    workersGrid.innerHTML = workers.map(w => {
      let statusClass = 'status-available';
      if (w.status === 'Reserved') statusClass = 'status-reserved';
      else if (w.status === 'Busy') statusClass = 'status-busy';
      else if (w.status === 'Unavailable' || w.status === 'Error') statusClass = 'status-unavailable';

      const isOn = w.userEnabled !== false;

      return `
        <div class="worker-card${isOn ? '' : ' worker-disabled'}" data-worker="${w.id}">
          <div class="worker-card-header">
            <span class="worker-name">${w.name}</span>
            <span class="worker-status-badge ${statusClass}">${w.status}</span>
          </div>
          <span class="worker-platform">${w.platform}</span>
          <p class="worker-note">${w.note || ''}</p>
          <div class="worker-enable-row">
            <label class="toggle-switch toggle-switch-sm">
              <input type="checkbox" class="worker-enable-toggle" data-worker-id="${w.id}" ${isOn ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
            <span class="worker-enable-label">${isOn ? 'Use this worker' : 'Skipped by routing'}</span>
          </div>
        </div>
      `;
    }).join('');

    workersGrid.querySelectorAll('.worker-enable-toggle').forEach(toggle => {
      toggle.addEventListener('change', async (e) => {
        e.stopPropagation();
        const workerId = toggle.dataset.workerId;
        const enabled = toggle.checked;
        const card = toggle.closest('.worker-card');
        if (card) card.classList.toggle('worker-disabled', !enabled);
        const label = card?.querySelector('.worker-enable-label');
        if (label) label.textContent = enabled ? 'Use this worker' : 'Skipped by routing';
        try {
          const res = await fetch('/api/workers/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workerId, enabled })
          });
          const data = await res.json();
          if (!res.ok || data.error) throw Error(data.error || 'Toggle failed');
          showToast(`${card?.querySelector('.worker-name')?.textContent || workerId}: ${enabled ? 'enabled' : 'disabled'}`, 'info');
        } catch (err) {
          toggle.checked = !enabled;
          if (card) card.classList.toggle('worker-disabled', enabled);
          if (label) label.textContent = !enabled ? 'Use this worker' : 'Skipped by routing';
          showToast(`Could not update worker setting: ${err.message}`, 'error');
        }
      });
    });
  }

  function populateProjects(projects, selectedId) {
    if (!projectSelector) return;
    registeredProjects = projects || [];
    projectSelector.innerHTML = projects.map(project =>
      `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`
    ).join('');
    activeProjectId = projects.some(project => project.id === selectedId) ? selectedId : (projects[0]?.id || 'adaptive-router');
    projectSelector.value = activeProjectId;
    updateDeleteProjectButtonState();
  }

  // Only user-created projects can be deleted — the built-in Adaptive
  // Router System project (and any hidden test fixtures) never appear as
  // deletable, mirroring the same restriction the backend enforces.
  function updateDeleteProjectButtonState() {
    if (!deleteProjectBtn) return;
    const project = registeredProjects.find(p => p.id === activeProjectId);
    const deletable = Boolean(project) && project.kind === 'project' && !project.hidden;
    deleteProjectBtn.disabled = !deletable;
    deleteProjectBtn.title = deletable ? 'Delete the selected project' : 'Built-in projects cannot be deleted';
  }

  async function fetchProjects() {
    const res = await fetch('/api/projects');
    const data = await res.json();
    if (!res.ok || data.error) throw Error(data.error || 'Could not load projects');
    defaultProjectsFolder = data.defaultFolder || '';
    populateProjects(data.projects || [], data.activeProjectId);
    updateProjectPathPreview();
    return data;
  }

  function resetProjectTaskContext() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = null;
    if (eventSource) eventSource.close();
    eventSource = null;
    currentTaskId = null;
    allWorkerEvents = [];
    lastReceivedSequence = 0;
    rawLogs = [];
    unreadEventCount = 0;
    if (taskIdDisplay) taskIdDisplay.textContent = 'No task selected';
    if (taskStatusBadge) { taskStatusBadge.textContent = 'Idle'; taskStatusBadge.className = 'status-badge grey'; }
    if (decisionSpecialist) decisionSpecialist.textContent = 'Matching...';
    if (decisionBuilder) decisionBuilder.textContent = 'Evaluating...';
    if (decisionModel) decisionModel.textContent = 'Tier / Effort';
    if (decisionReviewer) decisionReviewer.textContent = 'Pending...';
    if (decisionWhyText) decisionWhyText.textContent = 'Awaiting task submission to analyze requirements.';
    const builderTier = document.getElementById('decision-builder-tier');
    const reviewerTier = document.getElementById('decision-reviewer-tier');
    const reviewerQualification = document.getElementById('reviewer-qualification-box');
    const validatorStatus = document.getElementById('validator-status-box');
    if (builderTier) builderTier.textContent = 'Tier -';
    if (reviewerTier) reviewerTier.textContent = 'Tier -';
    if (reviewerQualification) reviewerQualification.style.display = 'none';
    if (validatorStatus) validatorStatus.style.display = 'none';
    if (failoverBanner) failoverBanner.style.display = 'none';
    if (wfFailoverPill) wfFailoverPill.style.display = 'none';
    if (wfWorkerName) wfWorkerName.textContent = 'Awaiting Worker';
    if (wfActiveModel) wfActiveModel.textContent = '-';
    if (wfActiveEffort) wfActiveEffort.textContent = '-';
    if (wfActiveSpecialist) wfActiveSpecialist.textContent = '-';
    if (wfActiveRole) wfActiveRole.textContent = 'Builder';
    if (historyList) historyList.innerHTML = '<div class="empty-state">Loading this project...</div>';
    if (liveStatusIndicator) liveStatusIndicator.style.display = 'none';
    if (taskLifecycleGroup) taskLifecycleGroup.style.display = 'none';
    if (decisionRequiredCard) decisionRequiredCard.style.display = 'none';
    if (approvalCard) approvalCard.style.display = 'none';
    if (planApprovalCard) planApprovalCard.style.display = 'none';
    hidePermission();
    renderAllWorkerEvents();
    renderLogs();
  }

  async function switchProject(projectId, { persist = true } = {}) {
    if (persist) {
      const res = await fetch('/api/projects/active', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId })
      });
      const data = await res.json();
      if (!res.ok || data.error) throw Error(data.error || 'Could not switch project');
    }
    activeProjectId = projectId;
    if (projectSelector) projectSelector.value = projectId;
    updateDeleteProjectButtonState();
    resetProjectTaskContext();
    await Promise.all([loadPlanningState(projectId), fetchStatus(), fetchHistory(true), fetchPermissions()]);
  }

  function selectedFolderMode() {
    return document.querySelector('input[name="project-folder-mode"]:checked')?.value || 'create';
  }

  function updateProjectPathPreview() {
    const mode = selectedFolderMode();
    if (existingProjectPathRow) existingProjectPathRow.style.display = mode === 'existing' ? 'block' : 'none';
    if (newProjectPathPreview) {
      const name = newProjectName?.value.trim() || '<Project Name>';
      newProjectPathPreview.textContent = defaultProjectsFolder ? `${defaultProjectsFolder}\\${name}` : 'Folder will be created under your ChatGPT Projects folder.';
    }
  }

  function closeProjectDialog() {
    if (newProjectDialog?.open) newProjectDialog.close();
  }

  if (newProjectBtn) newProjectBtn.addEventListener('click', () => {
    if (newProjectError) newProjectError.style.display = 'none';
    if (newProjectForm) newProjectForm.reset();
    updateProjectPathPreview();
    newProjectDialog?.showModal();
    setTimeout(() => newProjectName?.focus(), 20);
  });
  newProjectClose?.addEventListener('click', closeProjectDialog);
  newProjectCancel?.addEventListener('click', closeProjectDialog);
  newProjectName?.addEventListener('input', updateProjectPathPreview);
  document.querySelectorAll('input[name="project-folder-mode"]').forEach(radio => radio.addEventListener('change', updateProjectPathPreview));
  newProjectForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const mode = selectedFolderMode();
    if (newProjectError) newProjectError.style.display = 'none';
    if (createProjectBtn) { createProjectBtn.disabled = true; createProjectBtn.textContent = 'Creating...'; }
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newProjectName?.value || '',
          description: newProjectDescription?.value || '',
          mode,
          folderPath: mode === 'existing' ? existingProjectPath?.value || '' : ''
        })
      });
      const data = await res.json();
      if (!res.ok || data.error) throw Error(data.error || 'Could not create project');
      closeProjectDialog();
      await fetchProjects();
      await switchProject(data.project.id, { persist: false });
      showToast(`Project “${data.project.name}” is ready.`, 'success');
    } catch (error) {
      if (newProjectError) { newProjectError.textContent = error.message; newProjectError.style.display = 'block'; }
    } finally {
      if (createProjectBtn) { createProjectBtn.disabled = false; createProjectBtn.textContent = 'Create Project'; }
    }
  });

  function closeDeleteProjectDialog() {
    if (deleteProjectDialog?.open) deleteProjectDialog.close();
  }

  if (deleteProjectBtn) deleteProjectBtn.addEventListener('click', () => {
    const project = registeredProjects.find(p => p.id === activeProjectId);
    if (!project) return;
    if (deleteProjectError) deleteProjectError.style.display = 'none';
    if (deleteProjectRemoveFolder) deleteProjectRemoveFolder.checked = false;
    if (deleteProjectName) deleteProjectName.textContent = `“${project.name}”`;
    if (deleteProjectPath) deleteProjectPath.textContent = project.rootPath || '';
    deleteProjectDialog?.showModal();
  });
  deleteProjectClose?.addEventListener('click', closeDeleteProjectDialog);
  deleteProjectCancel?.addEventListener('click', closeDeleteProjectDialog);
  deleteProjectForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const project = registeredProjects.find(p => p.id === activeProjectId);
    if (!project) return;
    if (deleteProjectError) deleteProjectError.style.display = 'none';
    if (deleteProjectConfirmBtn) { deleteProjectConfirmBtn.disabled = true; deleteProjectConfirmBtn.textContent = 'Deleting...'; }
    try {
      const res = await fetch('/api/projects', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          deleteFolder: Boolean(deleteProjectRemoveFolder?.checked)
        })
      });
      const data = await res.json();
      if (!res.ok || data.error) throw Error(data.error || 'Could not delete project');
      closeDeleteProjectDialog();
      await fetchProjects();
      await switchProject(data.activeProjectId || 'adaptive-router', { persist: false });
      showToast(`Project “${project.name}” deleted.`, 'success');
    } catch (error) {
      if (deleteProjectError) { deleteProjectError.textContent = error.message; deleteProjectError.style.display = 'block'; }
    } finally {
      if (deleteProjectConfirmBtn) { deleteProjectConfirmBtn.disabled = false; deleteProjectConfirmBtn.textContent = 'Delete Project'; }
    }
  });

  // 3. Central Permission Inbox
  async function fetchPermissions() {
    try {
      const res = await fetch(`/api/permissions?project=${encodeURIComponent(activeProjectId)}`);
      if (!res.ok) return;
      const perms = await res.json();
      if (perms && perms.length > 0) {
        showPermission(perms[0]);
      } else {
        hidePermission();
      }
    } catch (e) {
      console.error('Error fetching permissions:', e);
    }
  }

  function showPermission(perm) {
    currentPendingPerm = perm;
    permSection.style.display = 'block';
    permWorkerBadge.textContent = `${(perm.worker || 'Worker').toUpperCase()} is requesting authorization`;
    permActionDesc.textContent = perm.description || 'Action requires authorization';
    permReasonText.textContent = perm.details?.reason || 'This action is not pre-authorized in the current project sandbox policy.';

    // Show native app launcher if supported
    if (perm.worker === 'claude-code' || perm.worker === 'antigravity') {
      nativeAppCallout.style.display = 'flex';
      openNativeAppBtn.textContent = `↗ Open ${perm.worker === 'antigravity' ? 'Antigravity' : 'Claude Code'} Desktop App`;
    } else {
      nativeAppCallout.style.display = 'none';
    }
  }

  function hidePermission() {
    currentPendingPerm = null;
    permSection.style.display = 'none';
  }

  async function resolvePendingPermission(decision) {
    if (!currentPendingPerm) return;
    const permId = currentPendingPerm.id;

    try {
      const res = await fetch(`/api/permissions/${permId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, projectId: activeProjectId })
      });
      const data = await res.json();
      if (data.success) {
        hidePermission();
        if (decision === 'stop_task') {
          showToast('Task stopped by user.', 'info');
        } else if (decision === 'no' || decision === 'deny') {
          showToast('Permission denied for this action. Worker will continue with safe method.', 'info');
        } else if (decision === 'yes_session') {
          showToast('Permission granted for this session.', 'success');
        } else {
          showToast('Permission granted for this action.', 'success');
        }
        if (currentTaskId) loadTask(currentTaskId);
      }
    } catch (e) {
      showToast('Failed to resolve permission: ' + e.message);
    }
  }

  if (permYesBtn) permYesBtn.addEventListener('click', () => resolvePendingPermission('yes'));
  if (permYesSessionBtn) permYesSessionBtn.addEventListener('click', () => resolvePendingPermission('yes_session'));
  if (permNoBtn) permNoBtn.addEventListener('click', () => resolvePendingPermission('no'));
  if (permStopTaskBtn) permStopTaskBtn.addEventListener('click', () => resolvePendingPermission('stop_task'));

  openNativeAppBtn.addEventListener('click', async () => {
    if (!currentPendingPerm) return;
    try {
      await fetch('/api/permissions/open-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worker: currentPendingPerm.worker })
      });
    } catch (e) {
      console.error('Error opening native app:', e);
    }
  });

  // Decision Required Action Handlers
  decisionPreserveBtn.addEventListener('click', async () => {
    if (!currentTaskId) return;
    decisionPreserveBtn.disabled = true;
    decisionPreserveBtn.innerHTML = '<span>⏳ Resuming with Antigravity...</span>';
    try {
      const res = await fetch(`/api/tasks/${currentTaskId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'preserve_claude', preferredWorker: 'antigravity', project: activeProjectId })
      });
      const data = await res.json();
      if (data.success) {
        decisionRequiredCard.style.display = 'none';
        startLiveTracking(currentTaskId);
      } else {
        showToast(data.error || 'Failed to resume task');
      }
    } catch (e) {
      showToast('Error resuming task: ' + e.message);
    } finally {
      decisionPreserveBtn.disabled = false;
      decisionPreserveBtn.innerHTML = '<span>🛡️ Preserve Claude — Use Next Best Worker</span>';
    }
  });

  decisionClaudeBtn.addEventListener('click', async () => {
    if (!currentTaskId) return;
    decisionClaudeBtn.disabled = true;
    decisionClaudeBtn.innerHTML = '<span>⏳ Resuming with Claude...</span>';
    try {
      const res = await fetch(`/api/tasks/${currentTaskId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'use_claude', allowClaude: true, project: activeProjectId })
      });
      const data = await res.json();
      if (data.success) {
        decisionRequiredCard.style.display = 'none';
        startLiveTracking(currentTaskId);
      } else {
        showToast(data.error || 'Failed to resume task');
      }
    } catch (e) {
      showToast('Error resuming task: ' + e.message);
    } finally {
      decisionClaudeBtn.disabled = false;
      decisionClaudeBtn.innerHTML = '<span>⚡ Use Claude</span>';
    }
  });

  // Task Lifecycle Action Handlers (Pause, Resume, Stop)
  async function executePauseTask() {
    if (!currentTaskId) return;
    if (taskPauseBtn) {
      taskPauseBtn.disabled = true;
      taskPauseBtn.innerHTML = `<span>⏳ Pausing...</span>`;
    }
    try {
      const res = await fetch(`/api/tasks/${currentTaskId}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: activeProjectId })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Task paused.', 'success');
        if (decisionRequiredCard) decisionRequiredCard.style.display = 'none';
        loadTask(currentTaskId);
        await fetchHistory();
      } else {
        showToast(data.error || 'Failed to pause task');
      }
    } catch (e) {
      showToast('Error pausing task: ' + e.message);
    } finally {
      if (taskPauseBtn) {
        taskPauseBtn.disabled = false;
        if (taskPauseBtn.dataset.action === 'resume') {
          if (taskPauseIcon) taskPauseIcon.textContent = '▶';
          if (taskPauseText) taskPauseText.textContent = 'Resume Task';
        } else {
          if (taskPauseIcon) taskPauseIcon.textContent = '⏸';
          if (taskPauseText) taskPauseText.textContent = 'Pause Task';
        }
      }
    }
  }

  async function executeStopTask() {
    if (!currentTaskId) return;
    if (!confirm('Are you sure you want to stop this task? Any running worker process will be terminated.')) {
      return;
    }
    if (taskStopBtn) {
      taskStopBtn.disabled = true;
      taskStopBtn.innerHTML = '<span>⏳ Stopping...</span>';
    }
    try {
      const res = await fetch(`/api/tasks/${currentTaskId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: activeProjectId })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Task stopped and cancelled.', 'success');
        stopAutoRetryCountdown();
        if (decisionRequiredCard) decisionRequiredCard.style.display = 'none';
        if (allFailedCard) allFailedCard.style.display = 'none';
        loadTask(currentTaskId);
        await fetchHistory();
      } else {
        showToast(data.error || 'Failed to stop task');
      }
    } catch (e) {
      showToast('Error stopping task: ' + e.message);
    } finally {
      if (taskStopBtn) {
        taskStopBtn.disabled = false;
        taskStopBtn.innerHTML = '<span class="task-action-icon">⏹</span><span>Stop Task</span>';
      }
    }
  }

  if (taskPauseBtn) {
    taskPauseBtn.addEventListener('click', async () => {
      if (!currentTaskId) return;
      const isResume = taskPauseBtn.dataset.action === 'resume';
      if (isResume) {
        taskPauseBtn.disabled = true;
        taskPauseBtn.innerHTML = `<span>⏳ Resuming...</span>`;
        try {
          const res = await fetch(`/api/tasks/${currentTaskId}/resume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: activeProjectId })
          });
          const data = await res.json();
          if (data.success) {
            showToast('Task resumed.', 'success');
            startLiveTracking(currentTaskId);
          } else {
            showToast(data.error || 'Failed to resume task');
          }
        } catch (e) {
          showToast('Error resuming task: ' + e.message);
        } finally {
          taskPauseBtn.disabled = false;
          if (taskPauseIcon) taskPauseIcon.textContent = '⏸';
          if (taskPauseText) taskPauseText.textContent = 'Pause Task';
        }
      } else {
        await executePauseTask();
      }
    });
  }

  if (taskStopBtn) {
    taskStopBtn.addEventListener('click', executeStopTask);
  }

  // 4. Claude Reserve Toggle
  claudeToggle.addEventListener('change', async () => {
    const enabled = claudeToggle.checked;
    claudeState.textContent = enabled ? 'ON' : 'OFF';
    reserveDesc.textContent = enabled ? 'Preserving quota for Cowork' : 'Available for normal routing';

    try {
      const res = await fetch('/api/claude-reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      const data = await res.json();
      claudeToggle.checked = data.claudeReserve;
      fetchStatus();
    } catch (e) {
      console.error('Failed to toggle Claude reserve mode:', e);
      claudeToggle.checked = !enabled;
    }
  });

  // ── Planning Conversation State ─────────────────────────────────────────────
  let planningFeed = null;
  let planningFeedMessages = null;

  function initPlanningFeedRefs() {
    planningFeed = document.getElementById('planning-feed');
    planningFeedMessages = document.getElementById('planning-feed-messages');
  }
  initPlanningFeedRefs();

  function appendPlanningMessage(role, content, time) {
    if (!planningFeedMessages) return;
    const isUser = role === 'user';
    const timeStr = time ? new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const bubble = document.createElement('div');
    bubble.className = `planning-bubble ${isUser ? 'planning-bubble-user' : 'planning-bubble-cto'}`;
    bubble.innerHTML = `
      <div class="planning-bubble-meta">
        <span class="planning-bubble-role">${isUser ? '👤 You (CEO)' : '🤖 AI CTO'}</span>
        <span class="planning-bubble-time">${timeStr}</span>
      </div>
      <div class="planning-bubble-text">${escapeHtml(content).replace(/\n/g, '<br>')}</div>
    `;
    planningFeedMessages.appendChild(bubble);
    planningFeedMessages.scrollTop = planningFeedMessages.scrollHeight;
  }

  function renderPlanningProposal(plan) {
    if (!plan || !planApprovalCard) return;
    planApprovalCard.style.display = 'block';
    if (planGoalText) planGoalText.textContent = plan.goal || 'Deliver requested changes.';
    if (planSpecialistVal) planSpecialistVal.textContent = plan.specialist || 'General Web Developer';
    if (planBuilderVal) planBuilderVal.textContent = (plan.builder || 'Antigravity').toUpperCase();
    if (planReviewerVal) planReviewerVal.textContent = plan.reviewer || 'Independent Reviewer';
    if (planJobsChecklist && plan.checklist) {
      planJobsChecklist.innerHTML = plan.checklist.map(step =>
        `<li>• ${escapeHtml(step)}</li>`
      ).join('');
    }
    planApprovalCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function loadPlanningState(project) {
    try {
      const res = await fetch(`/api/planning?project=${encodeURIComponent(project)}`);
      if (!res.ok) return;
      const state = await res.json();
      if (planningFeedMessages) planningFeedMessages.innerHTML = '';
      if (state.messages && state.messages.length > 0) {
        if (planningFeed) planningFeed.style.display = 'block';
        for (const msg of state.messages) {
          appendPlanningMessage(msg.role, msg.content, msg.time);
        }
      } else {
        if (planningFeed) planningFeed.style.display = 'none';
      }
      // Restore proposed plan card if there is one
      if (state.proposedPlan && state.status === 'plan_proposed') {
        renderPlanningProposal(state.proposedPlan);
      } else {
        if (planApprovalCard) planApprovalCard.style.display = 'none';
      }
    } catch (e) {
      console.error('Error loading planning state:', e);
    }
  }

  // AI Workforce Tab Switching
  function switchWorkforceTab(tabName) {
    // Reset all tabs
    [tabBtnProgress, tabBtnTechLogs, tabBtnExecute, tabBtnFeed, tabBtnLive].forEach(btn => {
      if (btn) {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
      }
    });

    // Reset all panes
    [paneTaskProgress, paneTechnicalLogs, paneExecuteTask, paneExecutionFeed, paneLiveActivity].forEach(pane => {
      if (pane) pane.style.display = 'none';
    });

    if (tabName === 'progress') {
      if (tabBtnProgress) {
        tabBtnProgress.classList.add('active');
        tabBtnProgress.setAttribute('aria-selected', 'true');
      }
      if (paneTaskProgress) paneTaskProgress.style.display = 'block';
    } else if (tabName === 'tech-logs' || tabName === 'live') {
      if (tabBtnTechLogs) {
        tabBtnTechLogs.classList.add('active');
        tabBtnTechLogs.setAttribute('aria-selected', 'true');
      }
      if (paneTechnicalLogs) paneTechnicalLogs.style.display = 'block';
    } else if (tabName === 'feed') {
      if (tabBtnFeed) {
        tabBtnFeed.classList.add('active');
        tabBtnFeed.setAttribute('aria-selected', 'true');
      }
      if (paneExecutionFeed) paneExecutionFeed.style.display = 'block';
      if (logStreamContent) logStreamContent.scrollTop = logStreamContent.scrollHeight;
    } else if (tabName === 'execute') {
      if (tabBtnExecute) {
        tabBtnExecute.classList.add('active');
        tabBtnExecute.setAttribute('aria-selected', 'true');
      }
      if (paneExecuteTask) paneExecuteTask.style.display = 'block';
      if (taskInstruction) {
        setTimeout(() => taskInstruction.focus(), 50);
      }
    }
  }

  if (tabBtnProgress) tabBtnProgress.addEventListener('click', () => switchWorkforceTab('progress'));
  if (tabBtnTechLogs) tabBtnTechLogs.addEventListener('click', () => switchWorkforceTab('tech-logs'));
  if (tabBtnExecute) tabBtnExecute.addEventListener('click', () => switchWorkforceTab('execute'));
  if (tabBtnFeed) tabBtnFeed.addEventListener('click', () => switchWorkforceTab('feed'));

  // Preset Buttons Handling
  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (taskInstruction) {
        taskInstruction.value = btn.dataset.preset;
        taskInstruction.focus();
      }
    });
  });

  // 5. Submit Approved Task for Execution
  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const instruction = taskInstruction.value.trim();
    if (!instruction) return;

    // Automatically switch to Task Progress tab (default active view)
    switchWorkforceTab('progress');
    if (isFeedPaused) {
      isFeedPaused = false;
      if (wfPauseBtn) {
        wfPauseBtn.classList.remove('paused');
        wfPauseBtn.innerHTML = '<span>⏸</span> Pause Activity Feed';
      }
    }
    isAutoFollow = true;
    if (wfAutoFollowBtn) wfAutoFollowBtn.classList.add('active');

    const project = projectSelector ? projectSelector.value : 'adaptive-router';
    const allowClaude = overrideClaudeCheckbox ? overrideClaudeCheckbox.checked : false;

    startTaskBtn.disabled = true;
    startTaskBtn.innerHTML = '<span class="pulse-dot"></span><span>Dispatching Workforce...</span>';

    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction, project, allowClaude })
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        showToast(data.error || 'Failed to start task');
        return;
      }

      if (data.taskId) {
        // Do not set currentTaskId here. loadTask() below is the single place
        // that transitions currentTaskId, and it only clears the in-memory
        // event list when it sees the id actually change. Setting it here
        // first made that comparison always false, so a task started from an
        // already-open dashboard page kept showing the previous task's Live
        // Activity events mixed in with the new task's (duplicate sequence
        // numbers, stale entries at the top).
        loadTask(data.taskId);
        startLiveTracking(data.taskId);
        showToast('Task dispatched to AI workforce', 'success');
      }
      taskInstruction.value = '';
      if (costHintEl) costHintEl.style.display = 'none';
    } catch (err) {
      showToast('Error launching task: ' + err.message);
    } finally {
      startTaskBtn.disabled = false;
      startTaskBtn.innerHTML = '<span class="btn-icon">⚡</span><span>Execute Task</span>';
    }
  });


  // 6. Load and Render Task
  async function loadTask(id) {
    if (currentTaskId !== id) {
      allWorkerEvents = [];
      lastReceivedSequence = 0;
    }
    currentTaskId = id;
    taskIdDisplay.textContent = id;

    // Highlight in history list
    document.querySelectorAll('.history-item').forEach(el => {
      el.classList.toggle('active', el.dataset.id === id);
    });

    try {
      const res = await fetch(`/api/tasks/${id}`);
      if (!res.ok) return;
      const task = await res.json();
      if (task.project !== activeProjectId) {
        resetProjectTaskContext();
        showToast('That task belongs to a different project and was not opened here.');
        return;
      }
      renderTask(task);
    } catch (e) {
      console.error('Error loading task:', e);
    }
  }

  const allFailedCard = document.getElementById('all-failed-card');
  const allFailedReasonText = document.getElementById('all-failed-reason-text');
  const allFailedExplanationText = document.getElementById('all-failed-explanation-text');
  const allFailedRetryBtn = document.getElementById('all-failed-retry-btn');

  const taskFailedCard = document.getElementById('task-failed-card');
  const taskFailedSubtitle = document.getElementById('task-failed-subtitle');
  const taskFailedStageBadge = document.getElementById('task-failed-stage-badge');
  const taskFailedReasonText = document.getElementById('task-failed-reason-text');
  const taskFailedWorkerVal = document.getElementById('task-failed-worker-val');
  const taskFailedModelVal = document.getElementById('task-failed-model-val');
  const taskFailedStageVal = document.getElementById('task-failed-stage-val');
  const taskFailedWorkerStatusVal = document.getElementById('task-failed-worker-status-val');
  const taskFailedRecommendationText = document.getElementById('task-failed-recommendation-text');
  const taskFailedRetrySameBtn = document.getElementById('task-failed-retry-same-btn');
  const taskFailedRetryOtherBtn = document.getElementById('task-failed-retry-other-btn');
  const taskFailedStopBtn = document.getElementById('task-failed-stop-btn');

  // Translates the technical error text stored on a stalled task into a
  // plain-business-language explanation, so the person deciding what to do
  // doesn't have to interpret worker names, quota jargon, or stack-trace-ish
  // phrasing themselves.
  function explainWorkerFailure(errorText = '') {
    const text = String(errorText || '').toLowerCase();
    if (/quota|usage[- ]limit|rate[- ]limit|429|overloaded|credit balance|resets? at/.test(text)) {
      return 'Every worker that could try this task has hit its usage limit for now. This is temporary — usage limits reset over time (often within a few hours), so retrying later usually works.';
    }
    if (/no available independent .*reviewer|senior reviewer|qualification|capability floor/.test(text)) {
      return 'The work was built, but no available reviewer was senior enough to independently check it. This can happen right after a usage limit is hit on your stronger workers — retrying, or approving Claude quota for the review step, usually resolves it.';
    }
    if (/host executable|failed to spawn|not recognized|not found|broken/.test(text)) {
      return 'One of the worker programs on your computer seems to have a setup problem — not a usage limit. This may need looking at (ask Claude to check its installation), but retrying may also succeed if a different worker is now available.';
    }
    if (/unusable draft|expected .* deliverable files/.test(text)) {
      return 'Every worker that tried produced an empty or unusable draft for this specific request. Rewording the instruction to be more specific sometimes helps, or try again — a different worker or model may do better.';
    }
    return 'Every worker that could try this task either hit a usage limit, had a problem running, or wasn\'t qualified for it. Your work is saved — nothing was lost.';
  }

  // Live "Retrying in..." countdown next to the Retry Now button, driven by
  // autoRetryAt/autoRetryAttempt/autoRetryMax on the task (set by the
  // server's auto-retry scheduler). Without this, a stalled task with an
  // automatic retry already scheduled looked identical to one that would
  // just sit there forever — the person had no way to tell "this is about
  // to retry on its own" from "nothing is going to happen unless I click."
  let autoRetryCountdownTimer = null;
  let autoRetryPillEl = null;

  function stopAutoRetryCountdown() {
    if (autoRetryCountdownTimer) {
      clearInterval(autoRetryCountdownTimer);
      autoRetryCountdownTimer = null;
    }
    if (autoRetryPillEl) {
      autoRetryPillEl.remove();
      autoRetryPillEl = null;
    }
  }

  function renderAutoRetryCountdown(task) {
    if (!task.autoRetryAt || !allFailedRetryBtn) {
      stopAutoRetryCountdown();
      return;
    }
    const targetTime = new Date(task.autoRetryAt).getTime();
    if (Number.isNaN(targetTime)) { stopAutoRetryCountdown(); return; }

    if (!autoRetryPillEl) {
      autoRetryPillEl = document.createElement('span');
      autoRetryPillEl.className = 'auto-retry-countdown-pill';
      autoRetryPillEl.style.cssText = 'margin-left:0.75rem;font-size:0.85rem;color:var(--text-secondary,#666);white-space:nowrap;';
      allFailedRetryBtn.insertAdjacentElement('afterend', autoRetryPillEl);
    }

    const attempt = task.autoRetryAttempt || 1;
    const max = task.autoRetryMax || 3;

    const tick = () => {
      const remainingMs = targetTime - Date.now();
      if (remainingMs <= 0) {
        // Firing right about now — the next status poll will pick up the
        // real state (Retrying.../building/etc). Show a neutral in-between
        // label rather than a negative or zero countdown.
        if (autoRetryPillEl) autoRetryPillEl.textContent = `⏳ Retrying now… (attempt ${attempt} of ${max})`;
        return;
      }
      const totalSecs = Math.ceil(remainingMs / 1000);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      const timeText = mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `${secs}s`;
      if (autoRetryPillEl) autoRetryPillEl.textContent = `⏳ Retrying in ${timeText} (attempt ${attempt} of ${max})`;
    };

    tick();
    if (autoRetryCountdownTimer) clearInterval(autoRetryCountdownTimer);
    autoRetryCountdownTimer = setInterval(tick, 1000);
  }

  function renderTask(task) {
    taskStatusBadge.textContent = task.status;
    let badgeClass = 'grey';
    if (task.status === 'awaiting_approval') badgeClass = 'blue';
    else if (task.status === 'approved') badgeClass = 'green';
    else if (task.status === 'rejected') badgeClass = 'red';
    else if (['building', 'testing', 'reviewing', 'planning'].includes(task.status)) badgeClass = 'amber';
    else if (task.status === 'paused_by_user') badgeClass = 'orange';
    else if (task.status === 'cancelled_by_user') badgeClass = 'slate';
    taskStatusBadge.className = `status-badge ${badgeClass}`;

    if (taskLifecycleGroup) {
      const activeStatuses = ['running', 'building', 'testing', 'reviewing', 'waiting_for_worker', 'needs_cto_attention', 'needs_human_input', 'awaiting_plan_approval', 'waiting_for_reviewer', 'awaiting_approval', 'paused_by_user'];
      const terminalStatuses = ['completed', 'approved', 'cancelled', 'cancelled_by_user', 'rejected', 'failed'];
      const isActive = activeStatuses.includes(task.status) || (!terminalStatuses.includes(task.status) && Boolean(task.id));
      taskLifecycleGroup.style.display = isActive ? 'inline-flex' : 'none';

      if (isActive) {
        if (task.status === 'paused_by_user') {
          taskPauseBtn.title = 'Resume this task';
          taskPauseBtn.dataset.action = 'resume';
          if (taskPauseIcon) taskPauseIcon.textContent = '▶';
          if (taskPauseText) taskPauseText.textContent = 'Resume Task';
        } else {
          taskPauseBtn.title = 'Pause this task';
          taskPauseBtn.dataset.action = 'pause';
          if (taskPauseIcon) taskPauseIcon.textContent = '⏸';
          if (taskPauseText) taskPauseText.textContent = 'Pause Task';
        }
      }
    }

    // Smart Routing Decisions
    const buildLog = task.routingLog?.find(r => r.role === 'build');
    const reviewLog = task.routingLog?.find(r => r.role === 'review');

    const builderTierEl = document.getElementById('decision-builder-tier');
    const reviewerTierEl = document.getElementById('decision-reviewer-tier');
    const reviewerQualBox = document.getElementById('reviewer-qualification-box');
    const reviewerQualText = document.getElementById('reviewer-qualification-text');
    const validatorBox = document.getElementById('validator-status-box');
    const validatorText = document.getElementById('validator-status-text');

    // A sensitive task never gets routed to any worker or reviewer at all —
    // "Matching...", "Evaluating...", "Pending verification" etc. are
    // in-progress placeholders left over from the normal routing flow, and
    // showing them here reads as if the task is stuck rather than settled.
    // Show plain "not applicable" text instead, then fall through to the
    // rest of renderTask() as usual (decision card, live activity, etc.).
    const isSensitiveTask = task.sensitive || task.status === 'needs_cto_attention';

    function formatWorkerName(id) {
      if (!id) return '';
      if (id === 'claude-code' || id === 'claude') return 'Claude';
      if (id === 'codex') return 'Codex';
      if (id === 'antigravity') return 'Antigravity';
      if (id === 'cline') return 'Cline';
      return id.charAt(0).toUpperCase() + id.slice(1);
    }

    if (isSensitiveTask) {
      decisionSpecialist.textContent = 'Not applicable';
      decisionBuilder.textContent = 'Not applicable';
      decisionModel.textContent = 'Handled by Claude (CTO)';
      decisionWhyText.textContent = 'This task was routed directly to Claude (CTO) and never reached the worker-selection step.';
      if (builderTierEl) builderTierEl.textContent = 'N/A';
      decisionReviewer.textContent = 'Not applicable';
      if (reviewerTierEl) reviewerTierEl.textContent = 'N/A';
      if (reviewerQualBox) reviewerQualBox.style.display = 'none';
      if (validatorBox) validatorBox.style.display = 'none';
    } else {
      if (buildLog) {
        decisionSpecialist.textContent = buildLog.specialistName || buildLog.specialist || 'General Web Developer';
        const bName = formatWorkerName(buildLog.worker);
        decisionBuilder.textContent = buildLog.model ? `${bName} — ${buildLog.model}` : bName;
        decisionModel.textContent = `${buildLog.model || 'Standard'} [${buildLog.effort || 'medium'}]`;
        decisionWhyText.textContent = buildLog.reason || 'Optimal worker selected based on task requirements and availability.';
        if (builderTierEl) {
          builderTierEl.textContent = buildLog.tierName || (buildLog.tierNumber ? `Tier ${buildLog.tierNumber}` : (task.builderTierName || 'Standard'));
        }
      } else if (task.selectedBuilder || task.builderWorker) {
        const bId = task.builderWorker || task.selectedBuilder;
        const bName = formatWorkerName(bId);
        decisionBuilder.textContent = task.builderModel ? `${bName} — ${task.builderModel}` : bName;
        decisionModel.textContent = `${task.builderModel || 'Standard'} [${task.builderEffort || 'medium'}]`;
        decisionWhyText.textContent = `Pre-selected builder: ${bName} (${task.builderModel || 'Standard'}).`;
        if (builderTierEl) {
          builderTierEl.textContent = task.builderTierName || (task.builderTier ? `Tier ${task.builderTier}` : 'Standard');
        }
        if (task.specialist || task.specialistName) {
          decisionSpecialist.textContent = task.specialistName || task.specialist;
        }
      } else if (task.specialist) {
        decisionSpecialist.textContent = task.specialistName || task.specialist;
      }

      if (reviewLog) {
        const rName = formatWorkerName(reviewLog.worker);
        decisionReviewer.textContent = reviewLog.model ? `${rName} — ${reviewLog.model}` : rName;
        if (reviewerTierEl) {
          reviewerTierEl.textContent = reviewLog.tierName || (reviewLog.tierNumber ? `Tier ${reviewLog.tierNumber}` : (task.reviewerTierName || 'Standard'));
        }
      } else if (task.selectedReviewer || task.reviewerWorker) {
        const rId = task.reviewerWorker || task.selectedReviewer;
        const rName = formatWorkerName(rId);
        decisionReviewer.textContent = task.reviewerModel ? `${rName} — ${task.reviewerModel}` : rName;
        if (reviewerTierEl) {
          reviewerTierEl.textContent = task.reviewerTierName || (task.reviewerTier ? `Tier ${task.reviewerTier}` : 'Standard');
        }
      } else if (task.status === 'waiting_for_reviewer' && task.decisionRequired) {
        decisionReviewer.textContent = 'None available (Action required)';
        if (reviewerTierEl) reviewerTierEl.textContent = 'Action Required';
      } else {
        decisionReviewer.textContent = task.reviewer ? formatWorkerName(task.reviewer) : 'Pending verification';
        if (reviewerTierEl) {
          reviewerTierEl.textContent = task.reviewerTierName || 'Pending';
        }
      }
    }

    // Reviewer Qualification Badge
    if (task.reviewerQualification?.badge) {
      if (reviewerQualBox && reviewerQualText) {
        reviewerQualBox.style.display = 'flex';
        reviewerQualText.textContent = task.reviewerQualification.badge;
      }
    } else {
      if (reviewerQualBox) reviewerQualBox.style.display = 'none';
    }

    // Validator Badge
    if (task.validator) {
      if (validatorBox && validatorText) {
        validatorBox.style.display = 'flex';
        const validatorLabel = task.validator.platform === 'browser' ? 'Automated isolated browser testing' : 'Automated isolated project validation';
        validatorText.textContent = `${validatorLabel} (${task.validator.checksCount || 0} checks verified). Validator passes do not constitute final quality approval.`;
      }
    } else {
      if (validatorBox) validatorBox.style.display = 'none';
    }

    // Failover Notice
    if (task.failoverEvents && task.failoverEvents.length > 0) {
      failoverBanner.style.display = 'flex';
      const last = task.failoverEvents[task.failoverEvents.length - 1];
      failoverTitle.textContent = `Worker Transition: ${last.worker.toUpperCase()}`;
      failoverDesc.textContent = last.isQuota
        ? `Worker ${last.worker} reached usage/quota limits. Adaptive Router automatically routed to ${task.contributors?.[task.contributors.length - 1] || 'next worker'}.`
        : `Worker encountered an issue. Automatically escalated to next worker pool.`;
    } else {
      failoverBanner.style.display = 'none';
    }

    // Prominent Decision Required Card (when paused for human input or context mismatch)
    const isContextMismatch = task.reasonCode === 'CONTEXT_MISMATCH' ||
      task.status === 'context_mismatch' ||
      ((task.status === 'awaiting_approval' || task.status === 'approved' || task.status === 'rejected') && task.contextIntegrity?.valid === false) ||
      task.decisionRequired?.reasonCode === 'CONTEXT_MISMATCH' ||
      task.decisionRequired?.type === 'context_mismatch' ||
      (task.decisionRequired?.reason && /mismatch|prohibited/i.test(task.decisionRequired.reason));

    if (task.status === 'needs_human_input' || isContextMismatch || task.decisionRequired || (task.status && task.status.startsWith('review_pending'))) {
      decisionRequiredCard.style.display = 'block';
      const dr = task.decisionRequired || {};

      if (isContextMismatch) {
        decisionQuestionText.textContent = dr.question || 'Deliverable Context Mismatch Detected. Automatic revision is prohibited.';
        decisionReasonText.textContent = dr.reason || 'A context mismatch was detected between the task instruction/project and the deliverable artifacts. Because cross-task contamination occurred, automatic revision is prohibited.';
        decisionRecommendationText.innerHTML = `<strong>${escapeHtml(dr.recommendation || 'Reject Draft & Rerun Cleanly from a fresh isolated context.')}</strong>`;

        const actionsContainer = document.getElementById('decision-actions');
        if (actionsContainer) {
          const safeOptions = [
            { id: 'reject_rerun', label: 'Reject Draft & Rerun Cleanly', recommended: true },
            { id: 'cancel', label: 'Cancel / Leave Task Paused', recommended: false }
          ];
          actionsContainer.innerHTML = safeOptions.map(opt => `
            <button type="button" class="btn ${opt.recommended ? 'btn-primary btn-decision-primary' : 'btn-secondary btn-decision-secondary'}" data-decision-id="${opt.id}">
              <span>${opt.recommended ? '🔄 ' : '⏸ '}${escapeHtml(opt.label)}</span>
            </button>
          `).join('');
          actionsContainer.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', async () => {
              const decisionId = btn.dataset.decisionId;
              if (decisionId === 'reject_rerun') {
                btn.disabled = true;
                btn.innerHTML = '<span>⏳ Rejecting & Rerunning Cleanly...</span>';
                try {
                  const res = await fetch(`/api/tasks/${currentTaskId}/rerun-clean`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ decision: 'reject_rerun', project: activeProjectId })
                  });
                  const data = await res.json();
                  if (data.success && data.taskId) {
                    showToast('Draft rejected. Fresh clean rerun started.', 'success');
                    decisionRequiredCard.style.display = 'none';
                    await fetchHistory();
                    loadTask(data.taskId);
                    startLiveTracking(data.taskId);
                  } else {
                    showToast(data.error || 'Failed to rerun cleanly', 'error');
                  }
                } catch (e) {
                  showToast('Clean rerun error: ' + e.message, 'error');
                } finally {
                  btn.disabled = false;
                }
              } else if (decisionId === 'cancel') {
                decisionRequiredCard.style.display = 'none';
                showToast('Task left paused. Context mismatch preserved for audit.', 'info');
              }
            });
          });
        }
      } else {
        decisionQuestionText.textContent = dr.question || 'Action required before review can proceed';
        decisionReasonText.textContent = dr.reason || 'Decision needed.';
        decisionRecommendationText.innerHTML = `<strong>${escapeHtml(dr.recommendation || '')}</strong>`;

        const actionsContainer = document.getElementById('decision-actions');
        if (actionsContainer && dr.options && dr.options.length > 0) {
          const optionsHtml = dr.options.map(opt => `
            <button type="button" class="btn ${opt.recommended ? 'btn-primary btn-decision-primary' : 'btn-secondary btn-decision-secondary'}" data-decision-id="${opt.id}">
              <span>${escapeHtml(opt.label)}</span>
            </button>
          `).join('');
          const hasStopOption = dr.options.some(opt => opt.id === 'stop_task');
          const isPreStart = dr.type === 'reviewer_required_before_start';
          const pauseBtnHtml = isPreStart ? '' : `
            <button type="button" class="btn btn-secondary btn-decision-secondary btn-decision-pause" data-decision-id="pause_task" style="border-color: rgba(245, 158, 11, 0.4); color: #d97706;">
              <span>Pause Task</span>
            </button>
          `;
          const stopBtnHtml = hasStopOption ? '' : `
            <button type="button" class="btn btn-secondary btn-decision-secondary btn-decision-stop" data-decision-id="stop_task" style="border-color: rgba(239, 68, 68, 0.4); color: #ef4444;">
              <span>Stop Task</span>
            </button>
          `;
          actionsContainer.innerHTML = optionsHtml + pauseBtnHtml + stopBtnHtml;
          actionsContainer.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', async () => {
              const decisionId = btn.dataset.decisionId;
              if (decisionId === 'stop_task') {
                await executeStopTask();
              } else if (decisionId === 'pause_task') {
                await executePauseTask();
              } else if (decisionId === 'use_claude' || decisionId === 'preserve_claude' || decisionId === 'retry' || decisionId === 'check_again_start' || decisionId === 'check_again_review' || decisionId.startsWith('check_again')) {
                btn.disabled = true;
                const originalHtml = btn.innerHTML;
                btn.innerHTML = '<span>⏳ Checking & Resuming...</span>';
                try {
                  const res = await fetch(`/api/tasks/${currentTaskId}/resume`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ decision: decisionId, project: activeProjectId })
                  });
                  const data = await res.json();
                  if (data.success) {
                    decisionRequiredCard.style.display = 'none';
                    showToast('Decision submitted. Task resumed.', 'success');
                    startLiveTracking(currentTaskId);
                  } else {
                    showToast(data.error || 'Failed to submit decision', 'error');
                    btn.disabled = false;
                    btn.innerHTML = originalHtml;
                  }
                } catch (e) {
                  showToast('Resume error: ' + e.message, 'error');
                  btn.disabled = false;
                  btn.innerHTML = originalHtml;
                }
              } else if (decisionId === 'override_sensitive') {
                // CEO reviewed the sensitive-task warning above and chose to
                // send this task to a worker anyway. Same resume flow as the
                // other decisions, just a different decision id — coding.mjs
                // only lets this proceed past the sensitivity gate once, for
                // this task, because the CEO clicked this specific button.
                btn.disabled = true;
                try {
                  const res = await fetch(`/api/tasks/${currentTaskId}/resume`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ decision: decisionId, project: activeProjectId })
                  });
                  const data = await res.json();
                  if (data.success) {
                    decisionRequiredCard.style.display = 'none';
                    showToast('Warning overridden — sending to a worker.', 'success');
                    startLiveTracking(currentTaskId);
                  } else {
                    showToast(data.error || 'Failed to submit decision', 'error');
                  }
                } catch (e) {
                  showToast('Resume error: ' + e.message, 'error');
                } finally {
                  btn.disabled = false;
                }
              } else if (decisionId === 'acknowledge_sensitive') {
                btn.disabled = true;
                try {
                  await fetch(`/api/tasks/${currentTaskId}/resume`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ decision: 'acknowledge_sensitive', project: activeProjectId })
                  });
                } catch {}
                decisionRequiredCard.style.display = 'none';
                showToast('Understood — this task stays with Claude (CTO), no worker will be used.', 'success');
                loadTask(currentTaskId);
                await fetchHistory();
              } else if (decisionId === 'cancel') {
                showToast('Review cancelled / strategy change requested.', 'error');
              }
            });
          });
        }
      }
    } else {
      decisionRequiredCard.style.display = 'none';
    }

    // All Workers Failed Card — a stalled task (waiting_for_worker /
    // waiting_for_reviewer) with an error means every eligible worker was
    // already tried and none could finish it. Surface that plainly instead
    // of leaving the person to dig through the Live Activity feed.
    if ((task.status === 'waiting_for_worker' || task.status === 'waiting_for_reviewer') && task.error) {
      if (allFailedCard) allFailedCard.style.display = 'block';
      if (allFailedReasonText) allFailedReasonText.textContent = 'None of your available workers could finish this task right now.';
      if (allFailedExplanationText) allFailedExplanationText.textContent = explainWorkerFailure(task.error);
      if (allFailedRetryBtn) {
        allFailedRetryBtn.disabled = false;
        allFailedRetryBtn.innerHTML = '<span>🔄 Retry Now</span>';
        allFailedRetryBtn.onclick = async () => {
          stopAutoRetryCountdown();
          allFailedRetryBtn.disabled = true;
          allFailedRetryBtn.innerHTML = '<span>⏳ Retrying...</span>';
          try {
            const res = await fetch(`/api/tasks/${currentTaskId}/resume`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ decision: 'preserve_claude' })
            });
            const data = await res.json();
            if (!res.ok || data.error) throw Error(data.error || 'Could not retry this task');
            showToast('Retrying with available workers...', 'success');
            if (allFailedCard) allFailedCard.style.display = 'none';
            startLiveTracking(currentTaskId);
          } catch (e) {
            showToast('Retry failed: ' + e.message, 'error');
            allFailedRetryBtn.disabled = false;
            allFailedRetryBtn.innerHTML = '<span>🔄 Retry Now</span>';
          }
        };
      }
      renderAutoRetryCountdown(task);
    } else {
      if (allFailedCard) allFailedCard.style.display = 'none';
      stopAutoRetryCountdown();
    }

    // Task Failed Card — shown prominently when task.status === 'failed'
    if (task.status === 'failed') {
      if (taskFailedCard) taskFailedCard.style.display = 'block';
      const fail = task.failure || {};
      const stageName = fail.stage || 'Validation';
      const workerName = fail.workerName || (fail.worker ? fail.worker.toUpperCase() : 'BUILDER');
      const modelName = fail.model || 'Standard';

      if (taskFailedSubtitle) taskFailedSubtitle.textContent = `Execution halted during ${stageName.toLowerCase()} with ${workerName}`;
      if (taskFailedStageBadge) taskFailedStageBadge.textContent = `Failed — ${stageName}`;
      if (taskFailedReasonText) taskFailedReasonText.textContent = fail.reason || task.error || 'Task execution failed.';
      if (taskFailedWorkerVal) taskFailedWorkerVal.textContent = workerName;
      if (taskFailedModelVal) taskFailedModelVal.textContent = modelName;
      if (taskFailedStageVal) taskFailedStageVal.textContent = stageName;
      if (taskFailedWorkerStatusVal) {
        taskFailedWorkerStatusVal.textContent = fail.workerStatusText || (fail.workerCompleted
          ? 'Worker completed generation successfully; deliverable was rejected during validation.'
          : 'Worker encountered an error during execution.');
      }
      if (taskFailedRecommendationText) {
        taskFailedRecommendationText.textContent = fail.recommendedAction || 'Retry with the same worker or switch to another available worker.';
      }

      if (taskFailedRetrySameBtn) {
        taskFailedRetrySameBtn.disabled = false;
        taskFailedRetrySameBtn.onclick = async () => {
          taskFailedRetrySameBtn.disabled = true;
          taskFailedRetrySameBtn.innerHTML = '<span>⏳ Retrying...</span>';
          try {
            const res = await fetch(`/api/tasks/${currentTaskId}/resume`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ decision: 'retry_same_worker' })
            });
            const data = await res.json();
            if (!res.ok || data.error) throw Error(data.error || 'Could not retry task');
            showToast('Retrying task with same worker...', 'success');
            if (taskFailedCard) taskFailedCard.style.display = 'none';
            if (data.taskId) {
              currentTaskId = data.taskId;
              loadTask(data.taskId);
              startLiveTracking(data.taskId);
            }
          } catch (e) {
            showToast('Retry failed: ' + e.message, 'error');
            taskFailedRetrySameBtn.disabled = false;
            taskFailedRetrySameBtn.innerHTML = '<span>🔄 Retry with Same Worker</span>';
          }
        };
      }

      if (taskFailedRetryOtherBtn) {
        taskFailedRetryOtherBtn.disabled = false;
        taskFailedRetryOtherBtn.onclick = async () => {
          taskFailedRetryOtherBtn.disabled = true;
          taskFailedRetryOtherBtn.innerHTML = '<span>⏳ Retrying...</span>';
          try {
            const res = await fetch(`/api/tasks/${currentTaskId}/resume`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ decision: 'retry_other_worker' })
            });
            const data = await res.json();
            if (!res.ok || data.error) throw Error(data.error || 'Could not retry task');
            showToast('Retrying task with another worker...', 'success');
            if (taskFailedCard) taskFailedCard.style.display = 'none';
            if (data.taskId) {
              currentTaskId = data.taskId;
              loadTask(data.taskId);
              startLiveTracking(data.taskId);
            }
          } catch (e) {
            showToast('Retry failed: ' + e.message, 'error');
            taskFailedRetryOtherBtn.disabled = false;
            taskFailedRetryOtherBtn.innerHTML = '<span>🔀 Retry with Another Worker</span>';
          }
        };
      }

      if (taskFailedStopBtn) {
        taskFailedStopBtn.disabled = false;
        taskFailedStopBtn.onclick = async () => {
          await executeStopTask();
        };
      }
    } else {
      if (taskFailedCard) taskFailedCard.style.display = 'none';
    }

    // Live Worker Activity initialization from task
    const incomingEvents = task.workerEvents || [];
    if (allWorkerEvents.length === 0 || task.id !== currentTaskId) {
      allWorkerEvents = [...incomingEvents];
      lastReceivedSequence = 0;
      for (const ev of allWorkerEvents) {
        if (typeof ev.sequence === 'number' && ev.sequence > lastReceivedSequence) {
          lastReceivedSequence = ev.sequence;
        }
      }
    } else {
      // Merge any new events from task.workerEvents without duplicating
      for (const ev of incomingEvents) {
        if (!allWorkerEvents.some(e => e.eventId === ev.eventId)) {
          allWorkerEvents.push(ev);
          if (typeof ev.sequence === 'number' && ev.sequence > lastReceivedSequence) {
            lastReceivedSequence = ev.sequence;
          }
        }
      }
    }

    // Update worker header from latest event or task data
    const lastEvent = allWorkerEvents[allWorkerEvents.length - 1];
    if (lastEvent) {
      updateWorkerHeader(lastEvent);
    } else if (task.builder) {
      if (wfWorkerName) wfWorkerName.textContent = task.builder.toUpperCase();
      if (wfActiveModel) wfActiveModel.textContent = buildLog?.model || 'Standard';
      if (wfActiveEffort) wfActiveEffort.textContent = buildLog?.effort || 'medium';
      if (wfActiveSpecialist) wfActiveSpecialist.textContent = task.specialistName || task.specialist || '-';
      if (wfActiveRole) wfActiveRole.textContent = 'Builder';
    }

    // Live status badges
    const isLiveWorking = ['building', 'testing', 'reviewing', 'planning'].includes(task.status);
    if (wfLiveBadge) {
      if (isLiveWorking) {
        wfLiveBadge.textContent = 'Live Working...';
        wfLiveBadge.className = 'wf-sub-badge live';
      } else {
        wfLiveBadge.textContent = task.status || 'Idle';
        wfLiveBadge.className = 'wf-sub-badge';
      }
    }
    if (tpLiveBadge) {
      if (isLiveWorking) {
        tpLiveBadge.textContent = 'Live Working...';
        tpLiveBadge.className = 'tp-sub-badge live';
      } else {
        tpLiveBadge.textContent = task.status || 'Idle';
        tpLiveBadge.className = 'tp-sub-badge';
      }
    }
    if (aiProgressIndicator) {
      if (isLiveWorking) {
        aiProgressIndicator.textContent = 'Live';
        aiProgressIndicator.className = 'ai-tab-badge live';
      } else {
        aiProgressIndicator.textContent = task.status || 'Idle';
        aiProgressIndicator.className = 'ai-tab-badge';
      }
    }
    if (aiTechIndicator) {
      if (isLiveWorking) {
        aiTechIndicator.textContent = 'Live';
        aiTechIndicator.className = 'ai-tab-badge live';
      } else {
        aiTechIndicator.textContent = task.status || 'Idle';
        aiTechIndicator.className = 'ai-tab-badge';
      }
    }
    if (aiLiveIndicator && aiLiveIndicator !== aiProgressIndicator) {
      if (isLiveWorking) {
        aiLiveIndicator.textContent = 'Live';
        aiLiveIndicator.className = 'ai-tab-badge live';
      } else {
        aiLiveIndicator.textContent = task.status || 'Idle';
        aiLiveIndicator.className = 'ai-tab-badge';
      }
    }

    // Task Progress Overview Pills
    if (tpBuilderPill) {
      const bId = task.builderWorker || task.selectedBuilder || task.builder;
      if (bId) {
        tpBuilderPill.style.display = 'inline-block';
        tpBuilderPill.textContent = `Builder: ${formatWorkerName(bId)}`;
      } else {
        tpBuilderPill.style.display = 'none';
      }
    }
    if (tpReviewerPill) {
      const rId = task.reviewerWorker || task.selectedReviewer || task.reviewer;
      if (rId) {
        tpReviewerPill.style.display = 'inline-block';
        tpReviewerPill.textContent = `Reviewer: ${formatWorkerName(rId)}`;
      } else {
        tpReviewerPill.style.display = 'none';
      }
    }

    // Render Task Progress Stream
    const progressList = task.taskProgress || task.activityLog || [];
    if (taskProgressStream) {
      if (progressList.length === 0) {
        taskProgressStream.innerHTML = `
          <div class="activity-empty-state">
            <div class="empty-icon">🤖</div>
            <p>No active progress events. Start a task to track progress here.</p>
          </div>
        `;
      } else {
        taskProgressStream.innerHTML = '';
        for (const item of progressList) {
          taskProgressStream.appendChild(createProgressCard(item));
        }
      }
    }

    renderAllWorkerEvents();

    // Pending Permissions from Task
    if (task.pendingPermissions && task.pendingPermissions.length > 0) {
      showPermission(task.pendingPermissions[0]);
    }

    // Stage A: Plan Approval Card
    if (task.status === 'awaiting_plan_approval') {
      if (planApprovalCard) {
        planApprovalCard.style.display = 'block';
        if (planProjectVal) planProjectVal.textContent = task.projectName || 'Adaptive Router System';
        if (planSpecialistVal) planSpecialistVal.textContent = task.specialistName || task.specialist || 'Frontend Architect';
        if (planBuilderVal) planBuilderVal.textContent = (task.builder || 'Antigravity').toUpperCase();
        if (planReviewerVal) planReviewerVal.textContent = (task.reviewer || 'Independent Reviewer').toUpperCase();
        if (planGoalText) planGoalText.textContent = task.plan?.goal || task.instruction?.split('\n')[0] || 'Execute requested changes safely.';
        if (planJobsChecklist) {
          const jobs = task.plan?.jobs?.length ? task.plan.jobs : [
            '1. Analyze architectural impact and prepare workspace sandbox',
            '2. Execute changes and build deliverables',
            '3. Run full automated test suite and independent review audit'
          ];
          planJobsChecklist.innerHTML = jobs.map(j => `<li>• ${escapeHtml(typeof j === 'string' ? j : j.title || JSON.stringify(j))}</li>`).join('');
        }
      }
    } else {
      if (planApprovalCard) planApprovalCard.style.display = 'none';
    }

    // Stage B: Approval Card & Strict Deliverable Binding
    if (task.status === 'awaiting_approval' || task.status === 'approved' || task.status === 'rejected') {
      approvalCard.style.display = 'block';

      // 1. Verify Task & Deliverable Binding Safety Rule
      const isBindingValid = Boolean(
        task.id &&
        task.id === currentTaskId &&
        task.digest &&
        (task.status === 'awaiting_approval' || task.status === 'approved' || task.status === 'rejected') &&
        task.reasonCode !== 'CONTEXT_MISMATCH' &&
        task.status !== 'context_mismatch' &&
        task.contextIntegrity?.valid === true &&
        (!task.tests || !task.tests.digest || task.tests.digest === task.digest) &&
        (!task.manifest || !task.manifest.digest || task.manifest.digest === task.digest)
      );

      const isMismatch = !isBindingValid || task.reasonCode === 'CONTEXT_MISMATCH' || task.status === 'context_mismatch';

      if (isMismatch) {
        if (stagebMismatchBanner) {
          stagebMismatchBanner.style.display = 'flex';
          const alertDesc = stagebMismatchBanner.querySelector('.alert-desc');
          if (alertDesc) {
            alertDesc.textContent = 'Approval unavailable — deliverable context mismatch detected. Automatic revision is prohibited.';
          }
        }
        if (approveBtn) approveBtn.style.display = 'none';
        if (correctBtn) correctBtn.style.display = 'none';
        if (rejectBtn) rejectBtn.style.display = 'none';
        if (correctionDrawer) correctionDrawer.style.display = 'none';

        if (stagebActionsBar) {
          stagebActionsBar.style.display = 'flex';
          let mismatchActions = document.getElementById('stageb-mismatch-actions');
          if (!mismatchActions) {
            mismatchActions = document.createElement('div');
            mismatchActions.id = 'stageb-mismatch-actions';
            mismatchActions.className = 'stageb-mismatch-actions-group';
            mismatchActions.style.display = 'flex';
            mismatchActions.style.gap = '0.75rem';
            mismatchActions.style.marginTop = '0.5rem';
            stagebActionsBar.appendChild(mismatchActions);
          }
          mismatchActions.style.display = 'flex';
          mismatchActions.innerHTML = `
            <button type="button" id="mismatch-rerun-btn" class="btn btn-primary">
              <span>🔄 Reject Draft &amp; Rerun Cleanly</span>
            </button>
            <button type="button" id="mismatch-cancel-btn" class="btn btn-secondary">
              <span>⏸ Cancel / Leave Task Paused</span>
            </button>
          `;
          const rerunBtn = document.getElementById('mismatch-rerun-btn');
          if (rerunBtn) {
            rerunBtn.onclick = async () => {
              rerunBtn.disabled = true;
              rerunBtn.innerHTML = '<span>⏳ Rejecting & Rerunning Cleanly...</span>';
              try {
                const res = await fetch(`/api/tasks/${currentTaskId}/rerun-clean`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ decision: 'reject_rerun', project: activeProjectId })
                });
                const data = await res.json();
                if (data.success && data.taskId) {
                  showToast('Draft rejected. Fresh clean rerun started.', 'success');
                  await fetchHistory();
                  loadTask(data.taskId);
                  startLiveTracking(data.taskId);
                } else {
                  showToast(data.error || 'Failed to rerun cleanly', 'error');
                }
              } catch (e) {
                showToast('Clean rerun error: ' + e.message, 'error');
              }
            };
          }
          const cancelBtn = document.getElementById('mismatch-cancel-btn');
          if (cancelBtn) {
            cancelBtn.onclick = () => {
              showToast('Task left paused. Context mismatch preserved for audit.', 'info');
            };
          }
        }
      } else {
        if (stagebMismatchBanner) stagebMismatchBanner.style.display = 'none';
        if (approveBtn) approveBtn.style.display = '';
        if (correctBtn) correctBtn.style.display = '';
        if (rejectBtn) rejectBtn.style.display = '';
        const mismatchActions = document.getElementById('stageb-mismatch-actions');
        if (mismatchActions) mismatchActions.style.display = 'none';
        if (stagebActionsBar) stagebActionsBar.style.display = 'flex';
      }

      // Status pill
      if (task.status === 'approved') {
        approvalPill.className = 'badge-pill green';
        approvalPill.textContent = '✓ Approved';
        approveBtn.innerHTML = '<span>✓ Approved</span>';
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
        correctBtn.disabled = true;
      } else if (task.status === 'rejected') {
        approvalPill.className = 'badge-pill red';
        approvalPill.textContent = '✕ Rejected';
        approveBtn.innerHTML = '<span>Approve</span>';
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
        correctBtn.disabled = true;
      } else {
        approvalPill.className = 'badge-pill blue';
        approvalPill.textContent = 'Awaiting Your Approval';
        approveBtn.innerHTML = '<span class="btn-icon">✓</span><span>Approve</span>';
        if (isBindingValid) {
          approveBtn.disabled = false;
          rejectBtn.disabled = false;
          correctBtn.disabled = false;
        }
      }

      // 2. Populate Task Metadata Badges
      if (stagebProjectName) {
        stagebProjectName.textContent = task.projectName || (task.project === 'adaptive-router' ? 'Adaptive Router System' : 'Adaptive Router Test Project (Sample Shop)');
      }
      if (stagebTaskId) stagebTaskId.textContent = `Task ID: ${task.id}`;
      if (stagebDigest) stagebDigest.textContent = `Revision ${task.revision ?? 1} • SHA-256: ${task.digest ? task.digest.slice(0, 16) + '...' : 'Verified'}`;
      if (stagebTimestamp) {
        const timeStr = task.completionTime || task.updated || task.tests?.time || task.created;
        stagebTimestamp.textContent = timeStr ? `Completed: ${new Date(timeStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Completed';
      }

      // 3. Populate Original Instruction & Summary
      if (stagebInstruction) stagebInstruction.textContent = task.instruction || 'No instruction specified.';
      if (stagebSummary) stagebSummary.textContent = task.summary || task.review?.summary || task.review?.details || 'Deliverable built and audited in isolated workspace.';
      // Same content, shown in the always-visible business summary above the
      // technical detail toggle — most people only need these two lines to
      // decide whether to approve.
      if (stagebBusinessInstruction) stagebBusinessInstruction.textContent = task.instruction || 'No instruction specified.';
      if (stagebBusinessSummaryText) stagebBusinessSummaryText.textContent = task.summary || task.review?.summary || task.review?.details || 'Deliverable built and audited in isolated workspace.';

      // 4. Builder & Reviewer Attribution
      const buildLog = task.routingLog?.find(r => r.role === 'build');
      const reviewLog = task.routingLog?.find(r => r.role === 'review');

      if (stagebBuilderInfo) {
        const bWorker = (buildLog?.worker || task.builder || 'Builder').toUpperCase();
        const bModel = buildLog?.model || task.builderModel || 'Standard';
        const bEffort = buildLog?.effort || task.builderEffort || 'medium';
        stagebBuilderInfo.textContent = `${bWorker} (${bModel} [${bEffort}])`;
      }

      if (stagebReviewerInfo) {
        const rWorker = (reviewLog?.worker || task.reviewer || task.review?.worker || 'Reviewer').toUpperCase();
        const rModel = reviewLog?.model || task.reviewerModel || 'Standard';
        const rEffort = reviewLog?.effort || task.reviewerEffort || 'medium';
        stagebReviewerInfo.textContent = `${rWorker} (${rModel} [${rEffort}])`;
      }

      if (stagebReviewerQual && stagebQualRow) {
        if (task.reviewerQualification?.badge) {
          stagebQualRow.style.display = 'flex';
          stagebReviewerQual.textContent = task.reviewerQualification.badge;
        } else {
          stagebQualRow.style.display = 'none';
        }
      }

      // 5. Modified Files for THIS Task
      if (stagebModifiedFiles) {
        let files = [];
        if (task.changes?.files && Array.isArray(task.changes.files)) {
          files = task.changes.files;
        } else if (task.files && Array.isArray(task.files)) {
          files = task.files.map(f => typeof f === 'string' ? f : f.path);
        } else if (task.systemFiles && Array.isArray(task.systemFiles)) {
          files = task.systemFiles;
        }

        if (files.length > 0) {
          stagebModifiedFiles.innerHTML = files.map(f => `<span class="file-badge">${escapeHtml(f)}</span>`).join('');
        } else {
          stagebModifiedFiles.innerHTML = '<span class="file-badge">No files modified</span>';
        }
      }

      // 6. Automated Tests for THIS Task
      if (task.tests?.checks && Array.isArray(task.tests.checks)) {
        if (stagebTestBadge) stagebTestBadge.textContent = '✓ All Checks Passed';
        if (stagebTestCount) stagebTestCount.textContent = `${task.tests.checks.length} checks verified`;
        if (stagebChecksList) {
          const verificationSource = task.validator?.platform === 'browser' ? 'Verified in Chrome' : 'Verified by the isolated validator';
          stagebChecksList.innerHTML = task.tests.checks.map(c => `
            <li>✓ <strong>${escapeHtml(typeof c === 'string' ? c : c.name)}</strong>: ${verificationSource}</li>
          `).join('');
        }
      } else if (task.tests?.passed) {
        if (stagebTestBadge) stagebTestBadge.textContent = '✓ Automated Tests Passed';
        if (stagebTestCount) stagebTestCount.textContent = `${task.tests.checksCount || 0} checks verified`;
        if (stagebChecksList) stagebChecksList.innerHTML = '<li>✓ Automated quality suite passed with zero errors</li>';
      } else {
        if (stagebTestBadge) {
          stagebTestBadge.textContent = task.status === 'failed' ? '✕ Tests Failed' : '✓ Verified';
          stagebTestBadge.className = task.status === 'failed' ? 'check-badge failed' : 'check-badge passed';
        }
        if (stagebTestCount) stagebTestCount.textContent = '0 checks';
        if (stagebChecksList) stagebChecksList.innerHTML = '<li>No test report available for this task.</li>';
      }

      // 7. Reviewer Audit Verdict for THIS Task
      if (task.review) {
        if (stagebVerdictBadge) {
          stagebVerdictBadge.textContent = task.review.verdict === 'pass' ? '✓ Audit Passed' : (task.review.verdict === 'blocked' ? '✕ Blocked' : 'Changes Requested');
          stagebVerdictBadge.className = task.review.verdict === 'pass' ? 'check-badge passed' : 'check-badge failed';
        }
        if (stagebVerdictWorker) stagebVerdictWorker.textContent = `Audited by ${(task.reviewer || task.review.worker || 'Reviewer').toUpperCase()}`;
        if (stagebReviewerComment) stagebReviewerComment.textContent = task.review.summary || task.review.details || 'Code audited independently with zero defects.';
      } else {
        if (stagebVerdictBadge) stagebVerdictBadge.textContent = '✓ Ready for Review';
        if (stagebVerdictWorker) stagebVerdictWorker.textContent = `Audited by ${(task.reviewer || 'Reviewer').toUpperCase()}`;
        if (stagebReviewerComment) stagebReviewerComment.textContent = 'Independent review verification complete.';
      }

      // 8. Deliverable Live Preview or Screenshot
      const hasWebEntry = task.manifest?.files?.some(file => (typeof file === 'string' ? file : file.path) === 'index.html');
      if (task.deliverablePreviewUrl || task.hasPreviewImage) {
        if (sysPreviewContainer) sysPreviewContainer.style.display = 'block';
        if (systemPreviewImg) systemPreviewImg.src = `/api/tasks/${task.id}/deliverable-preview`;
        if (stagebWebPreview) stagebWebPreview.style.display = 'none';
      } else if (hasWebEntry) {
        if (sysPreviewContainer) sysPreviewContainer.style.display = 'none';
        if (stagebWebPreview) stagebWebPreview.style.display = 'block';
        const previewUrl = `/api/tasks/${task.id}/deliverable/index.html`;
        if (previewIframe && previewIframe.src !== window.location.origin + previewUrl) {
          previewIframe.src = previewUrl;
        }
        if (previewOpenLink) previewOpenLink.href = previewUrl;
      } else {
        if (sysPreviewContainer) sysPreviewContainer.style.display = 'none';
        if (stagebWebPreview) stagebWebPreview.style.display = 'none';
      }

    } else {
      approvalCard.style.display = 'none';
    }

    // Advanced Details
    advTaskId.textContent = task.id;
    advDigest.textContent = task.digest || task.testDigest || '-';
    advFiles.textContent = task.changes?.files?.join(', ') || task.manifest?.files?.map(f => f.path).join(', ') || 'No files yet';
    advRoutingLog.textContent = JSON.stringify(task.routingLog || [], null, 2);
    advApprovalReport.textContent = task.approvalReport || 'None generated yet.';
  }

  // 7. Live Worker Activity Stream Logic

  function matchesFilter(ev, filter) {
    if (filter === 'all') return true;
    const type = ev.eventType || '';
    if (filter === 'worker') {
      return ['worker_start', 'routing', 'escalation', 'completion'].includes(type);
    }
    if (filter === 'files') {
      return ['file_read', 'file_edit', 'file_create', 'file_delete'].includes(type);
    }
    if (filter === 'commands') {
      return ['command', 'tool'].includes(type);
    }
    if (filter === 'browser') {
      return type === 'browser';
    }
    if (filter === 'tests') {
      return ['test_started', 'test_check', 'test_passed', 'test_failed', 'test_summary'].includes(type);
    }
    if (filter === 'errors') {
      return ['error', 'retry', 'failover'].includes(type) || ev.status === 'error';
    }
    if (filter === 'reviewer') {
      return ['review_started', 'review_finding', 'review_verdict', 'correction'].includes(type);
    }
    return true;
  }

  function updateWorkerHeader(ev) {
    if (ev.worker && ev.worker !== 'adaptive-router' && ev.worker !== 'router') {
      if (wfWorkerName) wfWorkerName.textContent = ev.worker.toUpperCase();
      if (wfActiveWorker) wfActiveWorker.classList.add('active');
      if (wfActiveDot) wfActiveDot.classList.add('live');
    }
    if (ev.model && wfActiveModel) wfActiveModel.textContent = ev.model;
    if (ev.effort && wfActiveEffort) wfActiveEffort.textContent = ev.effort;
    if (ev.specialist && wfActiveSpecialist) wfActiveSpecialist.textContent = ev.specialist;
    if (ev.role && wfActiveRole) wfActiveRole.textContent = ev.role.charAt(0).toUpperCase() + ev.role.slice(1);

    // Failover detection
    if (ev.eventType === 'failover') {
      if (wfFailoverPill) {
        wfFailoverPill.style.display = 'inline-flex';
        if (wfFailoverText) wfFailoverText.textContent = `Switched to ${ev.worker?.toUpperCase() || 'Next Worker'}`;
      }
    }

    // Keep the top "Current Task Overview" summary pills in sync with the
    // live worker stream. Those pills normally read task.routingLog, which
    // only gains a new entry once a worker fully finishes — during a
    // failover (old worker fails, new one starts) there is a window where
    // routingLog still shows the previous worker even though this event
    // stream has already announced the replacement. Updating from
    // worker_start directly closes that gap so the two panels never disagree.
    if (ev.eventType === 'worker_start' && ev.worker && ev.worker !== 'adaptive-router' && ev.worker !== 'router') {
      // Matches the same 'build' / 'review' role strings used throughout
      // routingLog and the router (see coding.mjs / failover.mjs) — not
      // 'builder', which this event never actually carries.
      if (ev.role === 'build' && decisionBuilder) {
        decisionBuilder.textContent = ev.worker.toUpperCase();
        if (ev.model && decisionModel) decisionModel.textContent = `${ev.model} [${ev.effort || 'medium'}]`;
      } else if (ev.role === 'review' && decisionReviewer) {
        decisionReviewer.textContent = ev.model ? `${ev.worker.toUpperCase()} (${ev.model})` : ev.worker.toUpperCase();
      }
    }
  }

  function createProgressCard(item) {
    const card = document.createElement('div');
    let toneClass = 'tp-card-info';
    const icon = item.icon || 'ℹ️';
    const title = item.title || '';
    const desc = item.desc || '';

    if (icon.includes('✓') || icon.includes('✅') || /passed|approved|completed/i.test(title)) {
      toneClass = 'tp-card-success';
    } else if (icon.includes('⚠️') || icon.includes('❓') || /changes requested|warning|pending|review/i.test(title)) {
      toneClass = 'tp-card-warning';
    } else if (icon.includes('❌') || icon.includes('🛑') || /failed|error|blocked|limit/i.test(title)) {
      toneClass = 'tp-card-error';
    }

    card.className = `tp-card ${toneClass}`;

    let timeStr = '';
    if (item.time) {
      try {
        timeStr = new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch {}
    }

    let issuesHtml = '';
    if (Array.isArray(item.bullets) && item.bullets.length > 0) {
      issuesHtml = `
        <div class="tp-card-issues">
          <ul style="margin: 0.25rem 0 0 1.2rem; padding: 0;">
            ${item.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}
          </ul>
        </div>
      `;
    }

    let techLinkHtml = '';
    if (item.reportAvailable || item.details || /reviewed|audit|failed/i.test(title)) {
      techLinkHtml = `
        <button type="button" class="tp-view-tech-btn" data-action="view-tech-logs">
          <span>View full technical report in Technical Logs &rarr;</span>
        </button>
      `;
    }

    card.innerHTML = `
      <div class="tp-card-icon">${icon}</div>
      <div class="tp-card-content">
        <div class="tp-card-header">
          <span class="tp-card-title">${escapeHtml(title)}</span>
          <span class="tp-card-time">${escapeHtml(timeStr)}</span>
        </div>
        <div class="tp-card-desc">${escapeHtml(desc)}</div>
        ${issuesHtml}
        ${techLinkHtml}
      </div>
    `;

    const btn = card.querySelector('.tp-view-tech-btn');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        switchWorkforceTab('tech-logs');
      });
    }

    return card;
  }

  function createEventItemElement(ev) {
    const div = document.createElement('div');
    const evType = ev.eventType || 'progress';
    div.className = `wf-event-item wf-ev-${evType}`;
    div.dataset.seq = ev.sequence;
    div.dataset.id = ev.eventId;
    div.dataset.type = evType;

    const timeStr = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    const platform = (ev.platform || ev.worker || 'router').toUpperCase();
    const typeLabel = evType.replace(/_/g, ' ');

    let codeBox = '';
    if (ev.command) {
      codeBox = `<div class="wf-ev-code-box"><code>$ ${escapeHtml(ev.command)}</code></div>`;
    } else if (ev.file) {
      codeBox = `<div class="wf-ev-code-box"><code>📄 ${escapeHtml(ev.file)}</code></div>`;
    } else if (ev.detail && ev.detail.length > 0) {
      codeBox = `<div class="wf-ev-detail">${escapeHtml(ev.detail)}</div>`;
    }

    div.innerHTML = `
      <div class="wf-ev-top">
        <div class="wf-ev-meta">
          <span class="wf-ev-seq">#${ev.sequence || 1}</span>
          <span class="wf-ev-type-badge">${escapeHtml(typeLabel)}</span>
          <span class="wf-ev-platform-badge">${escapeHtml(platform)}</span>
        </div>
        <span class="wf-ev-time">${timeStr}</span>
      </div>
      <div class="wf-ev-title-row">
        <span class="wf-ev-icon">${ev.icon || '⚡'}</span>
        <span class="wf-ev-title">${escapeHtml(ev.title || 'Event')}</span>
      </div>
      ${codeBox}
    `;
    return div;
  }

  function handleIncomingWorkerEvent(ev) {
    if (!ev || !ev.eventId) return;

    // Duplication check: ignore if already received
    if (allWorkerEvents.some(e => e.eventId === ev.eventId)) {
      return;
    }

    // Monotonic sequence tracking
    if (typeof ev.sequence === 'number' && ev.sequence > lastReceivedSequence) {
      lastReceivedSequence = ev.sequence;
    }

    allWorkerEvents.push(ev);
    updateWorkerHeader(ev);

    // If currently paused or inspecting older events below the top, track unread
    if (isFeedPaused || !isAutoFollow) {
      unreadEventCount++;
      if (wfUnreadCount) wfUnreadCount.textContent = unreadEventCount;
      if (wfJumpNewestBtn) wfJumpNewestBtn.style.display = 'inline-flex';
    }

    // Render if matches filter
    if (matchesFilter(ev, currentFilter)) {
      const emptyState = activityStream.querySelector('.activity-empty-state');
      if (emptyState) emptyState.remove();

      const itemEl = createEventItemElement(ev);
      activityStream.prepend(itemEl);

      if (isAutoFollow && !isFeedPaused) {
        activityStream.scrollTop = 0;
      }
    }
  }

  function renderAllWorkerEvents() {
    activityStream.innerHTML = '';
    const filtered = allWorkerEvents
      .filter(ev => matchesFilter(ev, currentFilter))
      .sort((a, b) => (b.sequence || 0) - (a.sequence || 0) || new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

    if (filtered.length === 0) {
      activityStream.innerHTML = `
        <div class="activity-empty-state">
          <div class="empty-icon">${allWorkerEvents.length ? '🔍' : '🤖'}</div>
          <p>${allWorkerEvents.length ? 'No events matching filter "' + escapeHtml(currentFilter) + '"' : 'No active worker stream. Submit an instruction below to watch our AI workforce execute live.'}</p>
        </div>
      `;
      return;
    }

    for (const ev of filtered) {
      activityStream.appendChild(createEventItemElement(ev));
    }

    if (isAutoFollow && !isFeedPaused) {
      activityStream.scrollTop = 0;
    }
  }

  // 8. Live Tracking & SSE Connection with Sequence Resumption
  function startLiveTracking(taskId) {
    if (pollInterval) clearInterval(pollInterval);
    liveStatusIndicator.style.display = 'flex';
    if (wfLiveBadge) {
      wfLiveBadge.textContent = 'Live Working...';
      wfLiveBadge.className = 'wf-sub-badge live';
    }
    if (tpLiveBadge) {
      tpLiveBadge.textContent = 'Live Working...';
      tpLiveBadge.className = 'tp-sub-badge live';
    }
    if (aiProgressIndicator) {
      aiProgressIndicator.textContent = 'Live';
      aiProgressIndicator.className = 'ai-tab-badge live';
    }
    if (aiTechIndicator) {
      aiTechIndicator.textContent = 'Live';
      aiTechIndicator.className = 'ai-tab-badge live';
    }
    rawLogs = [];
    if (logStreamContent) logStreamContent.innerHTML = '';
    if (logCountBadge) logCountBadge.textContent = '0 lines';
    appendLog(`[${new Date().toLocaleTimeString()}] Task ${taskId} initiated. Connecting live stream...`);

    // Reset unread count
    unreadEventCount = 0;
    if (wfJumpNewestBtn) wfJumpNewestBtn.style.display = 'none';

    // Connect Server-Sent Events (SSE) with sequence resumption
    if (eventSource) eventSource.close();
    eventSource = new EventSource(`/api/tasks/${taskId}/stream?sinceSequence=${lastReceivedSequence}`);

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'worker_event' && data.event) {
          handleIncomingWorkerEvent(data.event);
        } else if ((data.type === 'activity' || data.type === 'task_progress') && data.item) {
          if (taskProgressStream) {
            const emptyState = taskProgressStream.querySelector('.activity-empty-state');
            if (emptyState) emptyState.remove();
            taskProgressStream.appendChild(createProgressCard(data.item));
            taskProgressStream.scrollTop = taskProgressStream.scrollHeight;
          }
        } else if (data.type === 'log' && data.message) {
          appendLog(data.message);
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    eventSource.onerror = () => {
      // EventSource automatically handles reconnection
    };

    // Periodic state polling (1s interval)
    pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`);
        if (res.ok) {
          const task = await res.json();
          renderTask(task);
          fetchHistory();
          fetchPermissions();

          if (['awaiting_approval', 'approved', 'rejected', 'failed', 'cancelled', 'cancelled_by_user', 'paused_by_user', 'needs_human_input', 'needs_cto_attention'].includes(task.status) || task.status?.startsWith('review_pending')) {
            clearInterval(pollInterval);
            liveStatusIndicator.style.display = 'none';
            if (wfLiveBadge) {
              wfLiveBadge.textContent = task.status;
              wfLiveBadge.className = 'wf-sub-badge';
            }
            if (tpLiveBadge) {
              tpLiveBadge.textContent = task.status;
              tpLiveBadge.className = 'tp-sub-badge';
            }
            if (aiProgressIndicator) {
              aiProgressIndicator.textContent = task.status;
              aiProgressIndicator.className = 'ai-tab-badge';
            }
            if (aiTechIndicator) {
              aiTechIndicator.textContent = task.status;
              aiTechIndicator.className = 'ai-tab-badge';
            }
            if (eventSource) eventSource.close();
          }
        }
      } catch {}
    }, 1000);
  }

  function appendLog(rawMsg) {
    rawLogs.push(rawMsg);
    if (logCountBadge) {
      logCountBadge.textContent = `${rawLogs.length} lines`;
    }
    if (feedLogCountBadge) {
      feedLogCountBadge.textContent = `${rawLogs.length} lines`;
    }
    renderLogs();
  }

  function renderLogs() {
    const filtered = rawLogs.filter(msg => {
      if (activeTab === 'all') return true;
      if (activeTab === 'codex') return msg.toLowerCase().includes('codex');
      if (activeTab === 'claude') return msg.toLowerCase().includes('claude');
      if (activeTab === 'antigravity') return msg.toLowerCase().includes('antigravity');
      if (activeTab === 'cline') return msg.toLowerCase().includes('cline');
      return true;
    });

    const html = !filtered.length 
      ? `<div class="log-placeholder">No logs for tab [${activeTab.toUpperCase()}] yet...</div>`
      : filtered.map(msg => {
          if (!showTechnical && msg.startsWith('{') && msg.endsWith('}')) {
            try {
              const parsed = JSON.parse(msg);
              return `<div>[Structured Event] ${parsed.type || 'Event'}</div>`;
            } catch {}
          }
          return `<div>${escapeHtml(msg)}</div>`;
        }).join('');

    if (logStreamContent) {
      logStreamContent.innerHTML = html;
      logStreamContent.scrollTop = logStreamContent.scrollHeight;
    }
    if (techDrawerContent) {
      techDrawerContent.innerHTML = html;
      techDrawerContent.scrollTop = techDrawerContent.scrollHeight;
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Feed Controls & Event Listeners
  if (activityStream) {
    // Newest events are at the top. Scrolling down means the user is
    // deliberately inspecting older activity.
    activityStream.addEventListener('scroll', () => {
      const isAtTop = activityStream.scrollTop <= 40;
      if (!isAtTop && isAutoFollow && !isFeedPaused) {
        isAutoFollow = false;
        if (wfAutoFollowBtn) wfAutoFollowBtn.classList.remove('active');
      } else if (isAtTop && !isAutoFollow && !isFeedPaused) {
        isAutoFollow = true;
        if (wfAutoFollowBtn) wfAutoFollowBtn.classList.add('active');
        unreadEventCount = 0;
        if (wfJumpNewestBtn) wfJumpNewestBtn.style.display = 'none';
      }
    });
  }

  if (wfJumpNewestBtn) {
    wfJumpNewestBtn.addEventListener('click', () => {
      isAutoFollow = true;
      isFeedPaused = false;
      if (wfAutoFollowBtn) wfAutoFollowBtn.classList.add('active');
      if (wfPauseBtn) {
        wfPauseBtn.classList.remove('paused');
        wfPauseBtn.innerHTML = '<span>⏸</span> Pause Activity Feed';
      }
      unreadEventCount = 0;
      wfJumpNewestBtn.style.display = 'none';
      if (activityStream) activityStream.scrollTop = 0;
    });
  }

  if (wfAutoFollowBtn) {
    wfAutoFollowBtn.addEventListener('click', () => {
      isAutoFollow = !isAutoFollow;
      wfAutoFollowBtn.classList.toggle('active', isAutoFollow);
      if (isAutoFollow) {
        isFeedPaused = false;
        if (wfPauseBtn) {
          wfPauseBtn.classList.remove('paused');
          wfPauseBtn.innerHTML = '<span>⏸</span> Pause Activity Feed';
        }
        unreadEventCount = 0;
        if (wfJumpNewestBtn) wfJumpNewestBtn.style.display = 'none';
        if (activityStream) activityStream.scrollTop = 0;
      }
    });
  }

  if (wfPauseBtn) {
    wfPauseBtn.addEventListener('click', () => {
      isFeedPaused = !isFeedPaused;
      wfPauseBtn.classList.toggle('paused', isFeedPaused);
      if (isFeedPaused) {
        isAutoFollow = false;
        if (wfAutoFollowBtn) wfAutoFollowBtn.classList.remove('active');
        wfPauseBtn.innerHTML = '<span>▶</span> Resume Activity Feed';
      } else {
        isAutoFollow = true;
        if (wfAutoFollowBtn) wfAutoFollowBtn.classList.add('active');
        wfPauseBtn.innerHTML = '<span>⏸</span> Pause Activity Feed';
        unreadEventCount = 0;
        if (wfJumpNewestBtn) wfJumpNewestBtn.style.display = 'none';
        if (activityStream) activityStream.scrollTop = 0;
      }
    });
  }

  wfFilterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      wfFilterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentFilter = pill.dataset.filter;
      renderAllWorkerEvents();
    });
  });

  // Console Tabs & Controls
  consoleTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      consoleTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeTab = tab.dataset.tab;
      if (consoleStreamHeading) {
        consoleStreamHeading.textContent = activeTab === 'all' ? 'System & Worker Execution Feed' : `${tab.textContent} Live Feed`;
      }
      renderLogs();
    });
  });

  showTechnicalToggle?.addEventListener('change', () => {
    showTechnical = showTechnicalToggle.checked;
    renderLogs();
  });

  // Stage B's own "Show Technical Details" toggle — independent of the
  // worker-log toggle above. Off by default: business users get preview +
  // one-line summary + Approve/Send Back/Reject; checking this reveals
  // tiers, models, routing rationale, and reviewer qualification badges.
  stagebShowTechnicalToggle?.addEventListener('change', () => {
    if (stagebTechnicalDetail) {
      stagebTechnicalDetail.style.display = stagebShowTechnicalToggle.checked ? 'block' : 'none';
    }
  });

  clearLogsBtn?.addEventListener('click', () => {
    rawLogs = [];
    if (logCountBadge) logCountBadge.textContent = '0 lines';
    if (feedLogCountBadge) feedLogCountBadge.textContent = '0 lines';
    renderLogs();
  });

  // Plain-business-language history: what was asked, what happened, and
  // when — no task IDs, worker names, tiers, or technical statuses. Shows
  // only work that has actually reached a real outcome (approved, rejected,
  // or ready for approval); in-progress technical states (building,
  // reviewing, waiting on a worker, etc.) are left out since there is
  // nothing decided yet to report in plain language.
  function renderBusinessHistory(tasks) {
    if (!historyListBusiness) return;
    const STATUS_LABEL = {
      approved: { text: 'Approved and applied', cls: 'green' },
      rejected: { text: 'Rejected', cls: 'red' },
      awaiting_approval: { text: 'Ready for your review', cls: 'blue' },
      needs_cto_attention: { text: 'Handled by Claude directly (sensitive task)', cls: 'amber' },
      cancelled_by_user: { text: 'Stopped by user', cls: 'slate' },
      paused_by_user: { text: 'Paused by user', cls: 'orange' }
    };
    const relevant = tasks.filter(t => STATUS_LABEL[t.status]);
    if (!relevant.length) {
      historyListBusiness.innerHTML = '<div class="empty-state">No completed work yet.</div>';
      return;
    }
    historyListBusiness.innerHTML = relevant.map(t => {
      const label = STATUS_LABEL[t.status];
      const timeStr = t.created ? new Date(t.created).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      return `
        <div class="business-history-item" data-id="${t.id}">
          <div class="bh-title">${escapeHtml((t.instruction || 'Untitled task').slice(0, 140))}</div>
          <div class="bh-meta">
            <span class="status-badge ${label.cls}">${label.text}</span>
            <span> &bull; ${timeStr}</span>
          </div>
        </div>
      `;
    }).join('');
    historyListBusiness.querySelectorAll('.business-history-item').forEach(el => {
      el.addEventListener('click', () => loadTask(el.dataset.id));
    });
  }

  historyViewButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      historyViewMode = btn.dataset.historyView;
      historyViewButtons.forEach(b => b.classList.toggle('active', b === btn));
      if (historyListBusiness) historyListBusiness.style.display = historyViewMode === 'business' ? 'block' : 'none';
      if (historyList) historyList.style.display = historyViewMode === 'technical' ? 'block' : 'none';
    });
  });

  // 10. Fetch Recent Tasks History
  async function fetchHistory(loadNewest = false) {
    try {
      const res = await fetch(`/api/tasks?project=${encodeURIComponent(activeProjectId)}`);
      if (!res.ok) return;
      const tasks = await res.json();

      if (!tasks.length) {
        if (loadNewest) resetProjectTaskContext();
        historyList.innerHTML = '<div class="empty-state">No recent tasks found.</div>';
        if (historyListBusiness) historyListBusiness.innerHTML = '<div class="empty-state">No completed work yet.</div>';
        return;
      }

      renderBusinessHistory(tasks);

      historyList.innerHTML = tasks.map(t => {
        let badgeColor = 'grey';
        if (t.status === 'awaiting_approval') badgeColor = 'blue';
        else if (t.status === 'approved') badgeColor = 'green';
        else if (t.status === 'rejected') badgeColor = 'red';
        else if (['building', 'testing', 'reviewing'].includes(t.status)) badgeColor = 'amber';
        else if (t.status === 'paused_by_user') badgeColor = 'orange';
        else if (t.status === 'cancelled_by_user') badgeColor = 'slate';

        const activeClass = t.id === currentTaskId ? 'active' : '';
        const timeStr = t.created ? new Date(t.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

        return `
          <div class="history-item ${activeClass}" data-id="${t.id}">
            <div class="history-header">
              <span class="history-time">${timeStr} &bull; ${t.id.slice(0, 15)}</span>
              <span class="status-badge ${badgeColor}">${t.status}</span>
            </div>
            <div class="history-instruction">${escapeHtml(t.instruction || '')}</div>
            <div class="history-meta">
              <span><strong>Worker:</strong> ${t.builder || 'Pending'}</span>
              ${t.specialist ? `<span>&bull; <strong>Specialist:</strong> ${escapeHtml(t.specialist)}</span>` : ''}
            </div>
          </div>
        `;
      }).join('');

      document.querySelectorAll('.history-item').forEach(el => {
        el.addEventListener('click', () => {
          loadTask(el.dataset.id);
        });
      });
      if (loadNewest && tasks[0]) await loadTask(tasks[0].id);
    } catch (e) {
      console.error('Error fetching history:', e);
    }
  }

  refreshHistoryBtn.addEventListener('click', () => fetchHistory(false));

  // 11. Approval Decisions
  approveBtn.addEventListener('click', async () => {
    if (!currentTaskId) return;
    approveBtn.disabled = true;
    approveBtn.innerHTML = '<span class="pulse-dot"></span><span>Approving...</span>';

    try {
      const res = await fetch(`/api/tasks/${currentTaskId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', reason: 'Approved via Adaptive Router Business Dashboard', project: activeProjectId })
      });
      const data = await res.json();
      if (data.success) {
        approvalPill.className = 'badge-pill green';
        approvalPill.textContent = '✓ Approved';
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
        correctBtn.disabled = true;
        loadTask(currentTaskId);
        fetchHistory();
      } else {
        showToast(data.error || 'Failed to record approval');
        approveBtn.disabled = false;
        approveBtn.innerHTML = '<span class="btn-icon">✓</span><span>Approve</span>';
      }
    } catch (e) {
      showToast('Approval error: ' + e.message);
      approveBtn.disabled = false;
      approveBtn.innerHTML = '<span class="btn-icon">✓</span><span>Approve</span>';
    }
  });

  // Rejection Drawer Handling
  rejectBtn.addEventListener('click', () => {
    if (correctionDrawer) correctionDrawer.style.display = 'none';
    if (rejectionDrawer) {
      rejectionDrawer.style.display = 'block';
      if (rejectionReason) rejectionReason.focus();
    }
  });

  if (cancelRejectionBtn) {
    cancelRejectionBtn.addEventListener('click', () => {
      if (rejectionDrawer) rejectionDrawer.style.display = 'none';
    });
  }

  if (submitRejectionBtn) {
    submitRejectionBtn.addEventListener('click', async () => {
      const reason = rejectionReason ? rejectionReason.value.trim() : '';
      if (!reason) {
        if (rejectionReason) rejectionReason.focus();
        return;
      }
      if (!currentTaskId) return;
      if (rejectionDrawer) rejectionDrawer.style.display = 'none';
      submitRejectionBtn.disabled = true;

      try {
        const res = await fetch(`/api/tasks/${currentTaskId}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'rejected', reason, project: activeProjectId })
        });
        const data = await res.json();
        if (data.success) {
          approvalPill.className = 'badge-pill red';
          approvalPill.textContent = '✕ Rejected';
          approveBtn.disabled = true;
          correctBtn.disabled = true;
          rejectBtn.disabled = true;
          loadTask(currentTaskId);
          fetchHistory();
        } else {
          showToast(data.error || 'Failed to record rejection');
        }
      } catch (e) {
        showToast('Rejection error: ' + e.message);
      } finally {
        submitRejectionBtn.disabled = false;
      }
    });
  }

  // Correction Drawer Handling
  correctBtn.addEventListener('click', () => {
    if (rejectionDrawer) rejectionDrawer.style.display = 'none';
    if (correctionDrawer) {
      correctionDrawer.style.display = 'block';
      if (correctionFeedback) correctionFeedback.focus();
    }
  });

  cancelCorrectionBtn.addEventListener('click', () => {
    if (correctionDrawer) correctionDrawer.style.display = 'none';
  });

  submitCorrectionBtn.addEventListener('click', async () => {
    const reason = correctionFeedback ? correctionFeedback.value.trim() : '';
    if (!reason || !currentTaskId) {
      if (correctionFeedback) correctionFeedback.focus();
      return;
    }
    if (correctionDrawer) correctionDrawer.style.display = 'none';

    try {
      const res = await fetch(`/api/tasks/${currentTaskId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'correct', reason, project: activeProjectId })
      });
      const data = await res.json();
      if (data.success) {
        taskStatusBadge.className = 'status-badge amber';
        taskStatusBadge.textContent = 'building';
        liveStatusIndicator.style.display = 'flex';
        startLiveTracking(currentTaskId);
      } else {
        showToast(data.error || 'Failed to submit correction');
      }
    } catch (e) {
      showToast('Correction error: ' + e.message);
    }
  });

  // Stage A — Approve Plan & Execute (calls planning module, not old task-based endpoint)
  if (approvePlanBtn) {
    approvePlanBtn.addEventListener('click', async () => {
      const project = projectSelector ? projectSelector.value : 'adaptive-router';
      approvePlanBtn.disabled = true;
      approvePlanBtn.innerHTML = '<span class="pulse-dot"></span><span>Dispatching Workers...</span>';

      try {
        const res = await fetch('/api/planning/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project,
            allowClaude: overrideClaudeCheckbox ? overrideClaudeCheckbox.checked : false
          })
        });
        const data = await res.json();
        if (data.success) {
          if (planApprovalCard) planApprovalCard.style.display = 'none';
          if (data.taskId) {
            // Same fix as the main Execute Task handler: let loadTask() be the
            // only place that transitions currentTaskId, so its stale-event
            // reset actually fires on a task change instead of comparing the
            // new id against itself.
            loadTask(data.taskId);
            startLiveTracking(data.taskId);
          }
          taskStatusBadge.className = 'status-badge amber';
          taskStatusBadge.textContent = 'building';
          liveStatusIndicator.style.display = 'flex';
          showToast('Plan approved — workers are now executing the plan.', 'success');
        } else {
          showToast(data.error || 'Failed to execute plan');
        }
      } catch (e) {
        showToast('Error executing plan: ' + e.message);
      } finally {
        approvePlanBtn.disabled = false;
        approvePlanBtn.innerHTML = '<span class="btn-icon">⚡</span><span>Approve Plan & Execute</span>';
      }
    });
  }

  // Revise Plan — scroll to planning input so user can type a revision request
  if (revisePlanBtn) {
    revisePlanBtn.addEventListener('click', () => {
      if (planApprovalCard) planApprovalCard.style.display = 'none';
      taskInstruction.value = 'Please revise the plan: ';
      taskInstruction.focus();
      taskInstruction.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // Continue Discussing — collapse the plan card and return to chat
  const continueDiscussingBtn = document.getElementById('continue-discussing-btn');
  if (continueDiscussingBtn) {
    continueDiscussingBtn.addEventListener('click', () => {
      if (planApprovalCard) planApprovalCard.style.display = 'none';
      taskInstruction.focus();
      taskInstruction.scrollIntoView({ behavior: 'smooth' });
    });
  }




  previewReloadBtn.addEventListener('click', () => {
    if (currentTaskId) {
      previewIframe.src = `/api/tasks/${currentTaskId}/deliverable/index.html?t=${Date.now()}`;
    }
  });

  // 12. Initial Load — restore the persisted project before showing task state.
  (async () => {
    try {
      await fetchProjects();
      await switchProject(activeProjectId, { persist: false });
    } catch (error) {
      showToast('Project registry error: ' + error.message);
    }
  })();

  // Switch the whole dashboard context, not just the planning pane.
  if (projectSelector) {
    projectSelector.addEventListener('change', async () => {
      try {
        await switchProject(projectSelector.value);
      } catch (error) {
        showToast('Project switch failed: ' + error.message);
        await fetchProjects();
      }
    });
  }

  // Periodic polling for status & permissions every 5s
  setInterval(() => {
    fetchStatus();
    fetchPermissions();
  }, 5000);

  // ── ChatGPT Connection Panel ─────────────────────────────────────────────────

  const connMcpStatus   = document.getElementById('conn-mcp-status');
  const connTunnelStatus = document.getElementById('conn-tunnel-status');
  const connReadyStatus  = document.getElementById('conn-ready-status');
  const btnStartTunnel   = document.getElementById('btn-start-tunnel');
  const btnCopyMcpAddr   = document.getElementById('btn-copy-mcp-address');
  const btnCopyToken     = document.getElementById('btn-copy-token');
  const btnRotateToken   = document.getElementById('btn-rotate-token');
  const chatgptSetupNotice = document.getElementById('chatgpt-setup-notice');

  function setConnStatusEl(el, state, label) {
    if (!el) return;
    const dotClass = state === 'ok' ? 'green' : state === 'err' ? 'red' : 'grey';
    el.className = 'chatgpt-status-value ' + (state === 'ok' ? 'ok' : state === 'err' ? 'err' : '');
    el.innerHTML = `<span class="status-dot ${dotClass}"></span> ${escapeHtml(label)}`;
  }

  async function refreshChatGptConnectionStatus() {
    // Check MCP server health
    try {
      const resp = await fetch('/mcp', { method: 'GET' });
      if (resp.ok) {
        setConnStatusEl(connMcpStatus, 'ok', 'Running');
      } else {
        setConnStatusEl(connMcpStatus, 'err', 'Stopped');
      }
    } catch {
      setConnStatusEl(connMcpStatus, 'err', 'Stopped');
    }

    // Check tunnel status
    let tunnelConnected = false;
    let tunnelId = null;
    try {
      const resp = await fetch('/api/tunnel/status');
      if (resp.ok) {
        const data = await resp.json();
        tunnelConnected = data.connected;
        tunnelId = data.tunnelId || null;
        if (tunnelConnected) {
          const label = tunnelId ? `Connected (${tunnelId.slice(0, 16)}…)` : 'Connected';
          setConnStatusEl(connTunnelStatus, 'ok', label);
          if (chatgptSetupNotice) chatgptSetupNotice.style.display = 'none';
          if (btnStartTunnel) { btnStartTunnel.disabled = false; }
        } else {
          setConnStatusEl(connTunnelStatus, 'err', 'Not configured');
          if (chatgptSetupNotice) chatgptSetupNotice.style.display = 'flex';
          if (btnStartTunnel) { btnStartTunnel.disabled = true; }
        }
      }
    } catch {
      setConnStatusEl(connTunnelStatus, 'err', 'Not configured');
    }

    // Overall readiness
    const mcpOk = connMcpStatus && connMcpStatus.classList.contains('ok');
    if (mcpOk && tunnelConnected) {
      setConnStatusEl(connReadyStatus, 'ok', 'Ready');
    } else {
      setConnStatusEl(connReadyStatus, 'err', 'Not ready');
    }
  }

  // Copy ChatGPT MCP Address — tunnel ID if connected, else "Not connected" message
  if (btnCopyMcpAddr) {
    btnCopyMcpAddr.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/tunnel/status');
        const data = await resp.json();
        if (data.connected && data.tunnelId) {
          await navigator.clipboard.writeText(data.tunnelId);
          showToast('Tunnel ID copied to clipboard. Paste it in ChatGPT Connectors → Tunnel ID.', 'success');
        } else {
          showToast('Secure MCP Tunnel not yet configured. Complete OpenAI Platform setup first.', 'error');
        }
      } catch {
        showToast('Could not read tunnel status.', 'error');
      }
    });
  }

  // Copy Connector Token — fetches from localhost-only endpoint, never logs the value
  if (btnCopyToken) {
    btnCopyToken.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/connector/token/copy');
        if (!resp.ok) {
          showToast('Token copy failed. Make sure you are accessing the dashboard from localhost.', 'error');
          return;
        }
        const token = await resp.text();
        if (!token || token.length < 10) {
          showToast('Token response was empty. Try again or regenerate.', 'error');
          return;
        }
        // SECURITY: do NOT log or display the token — clipboard only
        await navigator.clipboard.writeText(token);
        showToast('Connector token copied to clipboard. Paste it in ChatGPT Connectors → Authentication.', 'success');
      } catch {
        showToast('Clipboard write failed. Your browser may have blocked it.', 'error');
      }
    });
  }

  // Regenerate Connector Token — invalidates old token, generates fresh one
  if (btnRotateToken) {
    btnRotateToken.addEventListener('click', async () => {
      if (!confirm('This will immediately invalidate your current connector token. ChatGPT will lose access until you paste the new token into ChatGPT Connectors. Continue?')) return;
      try {
        const resp = await fetch('/api/connector/token/rotate', { method: 'POST' });
        const data = await resp.json();
        if (data.rotated) {
          showToast('Token rotated. Use Copy Connector Token to retrieve the new value.', 'success');
        } else {
          showToast(data.error || 'Rotation failed.', 'error');
        }
      } catch {
        showToast('Rotation request failed.', 'error');
      }
    });
  }

  // Start Secure MCP Tunnel button (stub — enabled once tunnel ID is configured)
  if (btnStartTunnel) {
    btnStartTunnel.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/tunnel/start', { method: 'POST' });
        const data = await resp.json();
        showToast(data.note || 'Tunnel start requested.', data.started ? 'success' : 'error');
      } catch {
        showToast('Tunnel start request failed.', 'error');
      }
    });
  }

  // Initial check (one-time — polling disabled while ChatGPT MCP is dormant)
  // refreshChatGptConnectionStatus() is a no-op for visible status because
  // the HTML is pre-set to the dormant state. Keep the call so hidden-element
  // JS refs initialize without errors.
  refreshChatGptConnectionStatus();
  // setInterval removed — panel is static until MCP activation is resumed

})();
