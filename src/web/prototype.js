/**
 * Adaptive Router — Interactive Dashboard Prototype Logic
 * UI Prototype only. Pure client-side mock interactivity.
 */

// Global Prototype State
const ProtoState = {
  activeView: 'overview',
  autoFollow: true,
  logsViewMode: 'split', // 'progress', 'logs', 'split'
  activeVariation: 'decision',
  tokens: {
    cline: { input: 14820, output: 2340, total: 17160 },
    antigravity: { input: 8410, output: 1120, total: 9530 }
  },
  platforms: {
    google: { on: true, name: 'Google AI Studio', used: 34, status: 'ACTIVE' },
    claude: { on: true, name: 'Claude (Anthropic)', used: 18, status: 'RESERVE MODE' },
    openai: { on: false, name: 'OpenAI / ChatGPT', used: 0, status: 'STANDBY' },
    antigravity: { on: true, name: 'Antigravity', used: 42, status: 'ACTIVE' }
  },
  tasks: [
    {
      id: 'task-20260914-login-auth',
      name: 'Create customer login page',
      status: 'Waiting for Decision',
      statusClass: 'amber',
      builder: 'Cline (Gemini 3.5 Flash Lite)',
      reviewer: 'Antigravity (Gemini 3.8 Flash)',
      started: '12 min ago',
      startedTime: '16:52',
      duration: '6m 45s',
      progress: 85,
      type: 'Web Application • Standard Security',
      summary: 'Generated responsive login form with CSRF protection, WCAG AA accessible labels, and client-side credential validation.',
      files: ['index.html', 'styles.css', 'app.js'],
      verdict: 'PASS — Independent audit confirmed full security and accessibility compliance.'
    },
    {
      id: 'task-20260914-checkout-stripe',
      name: 'Stripe webhook payment reconciliation',
      status: 'Running',
      statusClass: 'blue',
      builder: 'Cline (Gemini 3.5 Flash Lite)',
      reviewer: 'Antigravity (Gemini 3.8 Flash)',
      started: '3 min ago',
      startedTime: '17:01',
      duration: '2m 10s',
      progress: 45,
      type: 'Backend Integration • High Sensitivity',
      summary: 'Implementing signature verification for checkout.session.completed and invoice.payment_succeeded events.',
      files: ['src/stripe-webhook.mjs', 'test/stripe.test.mjs'],
      verdict: 'Building in isolated workspace...'
    },
    {
      id: 'task-20260914-profile-avatar',
      name: 'User avatar upload and thumbnail resizing',
      status: 'Completed',
      statusClass: 'green',
      builder: 'Cline (Gemini 3.5 Flash Lite)',
      reviewer: 'Antigravity (Gemini 3.8 Flash)',
      started: '1 hour ago',
      startedTime: '15:58',
      duration: '4m 12s',
      progress: 100,
      type: 'Media Processing • Low Risk',
      summary: 'Added client-side image cropping and secure multipart upload endpoint.',
      files: ['src/avatar.mjs', 'src/web/avatar.js', 'test/avatar.test.mjs'],
      verdict: 'Approved and applied to project root.'
    },
    {
      id: 'task-20260914-dark-mode',
      name: 'Executive dashboard dark mode palette',
      status: 'Completed',
      statusClass: 'green',
      builder: 'Claude (Claude 3.5 Sonnet)',
      reviewer: 'Antigravity (Gemini 3.8 Flash)',
      started: '2 hours ago',
      startedTime: '14:50',
      duration: '8m 30s',
      progress: 100,
      type: 'UI/CSS Polish • Design Specialist',
      summary: 'Implemented CSS variables for system preference dark theme and high-contrast accessibility.',
      files: ['src/web/styles.css', 'src/web/dark-theme.css'],
      verdict: 'Approved by CEO.'
    },
    {
      id: 'task-20260914-db-migrate',
      name: 'User permissions table schema migration',
      status: 'Failed',
      statusClass: 'red',
      builder: 'Codex (GPT-5.6 Luna)',
      reviewer: 'Claude (Claude 3.5 Sonnet)',
      started: '4 hours ago',
      startedTime: '12:45',
      duration: '5m 18s',
      progress: 70,
      type: 'Database Schema • Critical Sensitivity',
      summary: 'Migration aborted due to foreign key constraint verification mismatch.',
      files: ['migrations/004_permissions.sql'],
      verdict: 'BLOCKED: Schema validation failed 2 integrity checks.'
    },
    {
      id: 'task-20260914-analytics-export',
      name: 'Export customer usage data to CSV',
      status: 'Cancelled',
      statusClass: 'gray',
      builder: 'Cline (Gemini 3.5 Flash Lite)',
      reviewer: 'Antigravity (Gemini 3.8 Flash)',
      started: 'Yesterday',
      startedTime: '10:24',
      duration: '1m 05s',
      progress: 20,
      type: 'Reporting • Routine',
      summary: 'Task cancelled by user before build stage commenced.',
      files: [],
      verdict: 'Cancelled by user.'
    }
  ],
  techLogs: [
    { time: '16:52:00.104', tag: 'router', platform: 'Router Engine', model: 'adaptive-core', effort: '—', type: 'task_received', msg: 'Instruction registered: Create customer login page' },
    { time: '16:52:01.420', tag: 'router', platform: 'Router Engine', model: 'classifier-v2', effort: '—', type: 'classify', msg: 'Task classified: web frontend, routine complexity, sensitivity: standard' },
    { time: '16:52:02.015', tag: 'router', platform: 'Router Engine', model: 'smart-router', effort: '—', type: 'preselect_builder', msg: 'Selected builder: cline (Google AI Studio / Gemini 3.5 Flash Lite, Tier 1 Economical)' },
    { time: '16:52:02.110', tag: 'router', platform: 'Router Engine', model: 'smart-router', effort: '—', type: 'preselect_reviewer', msg: 'Reserved qualified reviewer: antigravity (Google DeepMind / Gemini 3.8 Flash, Tier 2 Senior)' },
    { time: '16:52:03.200', tag: 'builder', platform: 'Google AI Studio', model: 'gemini-3.5-flash-lite', effort: 'medium', type: 'build_dispatched', msg: 'Cline initialized in workspace .router/tasks/task-20260914-login-auth/draft/' },
    { time: '16:54:15.890', tag: 'builder', platform: 'Google AI Studio', model: 'gemini-3.5-flash-lite', effort: 'medium', type: 'build_completed', msg: 'Cline produced 3 files: index.html, styles.css, app.js. Digest: 8f4c2e...91b' },
    { time: '16:55:01.320', tag: 'validation', platform: 'System Engine', model: 'static-validator', effort: '—', type: 'checks_passed', msg: 'Automated validation passed: 4/4 assertions OK (HTML5 semantic form, accessible labels, CSRF)' },
    { time: '16:55:10.550', tag: 'reviewer', platform: 'Antigravity', model: 'gemini-3.8-flash', effort: 'medium', type: 'audit_dispatched', msg: 'Antigravity loaded identical deliverable digest. Cross-platform independent audit active' },
    { time: '16:57:42.810', tag: 'reviewer', platform: 'Antigravity', model: 'gemini-3.8-flash', effort: 'medium', type: 'audit_verdict', msg: 'Reviewer verdict: PASS. No security vulnerabilities or accessibility regressions' },
    { time: '16:57:43.002', tag: 'router', platform: 'Router Engine', model: 'state-machine', effort: '—', type: 'status_transition', msg: 'Task state transitioned to awaiting_approval. Generated APPROVAL.md report' }
  ]
};

// UI Initialization
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupPlatformToggles();
  setupTokenTicker();
  setupLogsViewSwitcher();
  setupDecisionVariations();
  setupTaskActions();
  setupTasksPage();
  setupProgressPage();
  setupTechLogsPage();
  setupSettingsPage();

  // Check URL hash on load
  const hash = window.location.hash.replace('#', '');
  if (['overview', 'tasks', 'team', 'progress', 'logs', 'settings'].includes(hash)) {
    navigateTo(hash);
  } else {
    navigateTo('overview');
  }
});

// Toast Feedback Notification
function showToast(message, type = 'info') {
  const toast = document.getElementById('proto-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.display = 'block';
  toast.style.background = type === 'success' ? '#065f46' : type === 'warning' ? '#92400e' : type === 'danger' ? '#991b1b' : '#0f172a';
  setTimeout(() => {
    toast.style.display = 'none';
  }, 3500);
}

// 1. Navigation Setup
function setupNavigation() {
  const navItems = document.querySelectorAll('.proto-nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const target = item.getAttribute('data-view');
      navigateTo(target);
    });
  });

  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace('#', '');
    if (hash && hash !== ProtoState.activeView) {
      navigateTo(hash);
    }
  });
}

function navigateTo(viewId) {
  ProtoState.activeView = viewId;
  window.location.hash = viewId;

  // Update nav tabs
  document.querySelectorAll('.proto-nav-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-view') === viewId);
  });

  // Update views
  document.querySelectorAll('.proto-view').forEach(el => {
    el.classList.toggle('active', el.id === `view-${viewId}`);
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 2. Token Ticker Simulation
function setupTokenTicker() {
  setInterval(() => {
    if (!ProtoState.platforms.google.on && !ProtoState.platforms.antigravity.on) return;

    // Increment Cline tokens subtly
    if (ProtoState.platforms.google.on) {
      const inInc = Math.floor(Math.random() * 25) + 10;
      const outInc = Math.floor(Math.random() * 8) + 2;
      ProtoState.tokens.cline.input += inInc;
      ProtoState.tokens.cline.output += outInc;
      ProtoState.tokens.cline.total = ProtoState.tokens.cline.input + ProtoState.tokens.cline.output;

      updateTokenDisplay('cline', ProtoState.tokens.cline);
    }

    // Increment Antigravity tokens
    if (ProtoState.platforms.antigravity.on) {
      const inInc = Math.floor(Math.random() * 15) + 5;
      const outInc = Math.floor(Math.random() * 5) + 1;
      ProtoState.tokens.antigravity.input += inInc;
      ProtoState.tokens.antigravity.output += outInc;
      ProtoState.tokens.antigravity.total = ProtoState.tokens.antigravity.input + ProtoState.tokens.antigravity.output;

      updateTokenDisplay('antigravity', ProtoState.tokens.antigravity);
    }
  }, 2400);
}

function updateTokenDisplay(workerKey, data) {
  const inEl = document.getElementById(`tok-${workerKey}-in`);
  const outEl = document.getElementById(`tok-${workerKey}-out`);
  const totEl = document.getElementById(`tok-${workerKey}-tot`);

  if (inEl && outEl && totEl) {
    inEl.textContent = data.input.toLocaleString();
    outEl.textContent = data.output.toLocaleString();
    totEl.textContent = data.total.toLocaleString();

    totEl.classList.add('tick');
    setTimeout(() => totEl.classList.remove('tick'), 300);
  }
}

// 3. Platform Toggles (Top Limits Bar + Settings + Team Page)
function setupPlatformToggles() {
  const toggleMap = [
    { key: 'google', id: 'toggle-google-limit', teamId: 'toggle-team-cline', settingsId: 'toggle-set-cline' },
    { key: 'claude', id: 'toggle-claude-limit', teamId: 'toggle-team-claude', settingsId: 'toggle-set-claude' },
    { key: 'openai', id: 'toggle-openai-limit', teamId: 'toggle-team-codex', settingsId: 'toggle-set-codex' },
    { key: 'antigravity', id: 'toggle-antigravity-limit', teamId: 'toggle-team-antigravity', settingsId: 'toggle-set-antigravity' }
  ];

  toggleMap.forEach(({ key, id, teamId, settingsId }) => {
    const limitInput = document.getElementById(id);
    const teamInput = document.getElementById(teamId);
    const setInput = document.getElementById(settingsId);

    function syncState(val) {
      ProtoState.platforms[key].on = val;
      if (limitInput) limitInput.checked = val;
      if (teamInput) teamInput.checked = val;
      if (setInput) setInput.checked = val;

      const badge = document.getElementById(`badge-${key}-status`);
      if (badge) {
        badge.textContent = val ? (key === 'claude' ? 'RESERVE MODE' : 'ACTIVE') : 'OFF';
        badge.className = `badge ${val ? (key === 'claude' ? 'purple' : 'green') : 'gray'}`;
      }

      const teamStatus = document.getElementById(`team-status-${key}`);
      if (teamStatus) {
        teamStatus.textContent = val ? (key === 'claude' ? 'RESERVE (ON)' : 'ACTIVE (ON)') : 'DISABLED (OFF)';
        teamStatus.className = `badge ${val ? (key === 'claude' ? 'purple' : 'green') : 'gray'}`;
      }

      showToast(`${ProtoState.platforms[key].name} platform turned ${val ? 'ON' : 'OFF'}`, val ? 'success' : 'warning');
    }

    if (limitInput) limitInput.addEventListener('change', (e) => syncState(e.target.checked));
    if (teamInput) teamInput.addEventListener('change', (e) => syncState(e.target.checked));
    if (setInput) setInput.addEventListener('change', (e) => syncState(e.target.checked));
  });
}

// 4. Task Progress / Technical Logs / Split View Switcher
function setupLogsViewSwitcher() {
  const btnProgress = document.getElementById('btn-view-progress');
  const btnLogs = document.getElementById('btn-view-logs');
  const btnSplit = document.getElementById('btn-view-split');
  const displayWrap = document.getElementById('overview-logs-display');
  const autofollowToggle = document.getElementById('toggle-autofollow');

  function updateView(mode) {
    ProtoState.logsViewMode = mode;
    [btnProgress, btnLogs, btnSplit].forEach(b => b && b.classList.remove('active'));

    if (mode === 'progress') {
      btnProgress?.classList.add('active');
      displayWrap.innerHTML = `<div class="single-col" id="col-progress">${renderTimelineHtml()}</div>`;
    } else if (mode === 'logs') {
      btnLogs?.classList.add('active');
      displayWrap.innerHTML = `<div class="single-col" id="col-logs"><div class="tech-log-feed" id="feed-logs">${renderTechLogsHtml()}</div></div>`;
    } else {
      btnSplit?.classList.add('active');
      displayWrap.innerHTML = `
        <div class="split-container">
          <div class="split-col" id="col-progress">${renderTimelineHtml()}</div>
          <div class="split-col" id="col-logs"><div class="tech-log-feed" id="feed-logs">${renderTechLogsHtml()}</div></div>
        </div>`;
    }

    if (ProtoState.autoFollow) {
      scrollLogsToBottom();
    }
  }

  btnProgress?.addEventListener('click', () => updateView('progress'));
  btnLogs?.addEventListener('click', () => updateView('logs'));
  btnSplit?.addEventListener('click', () => updateView('split'));

  if (autofollowToggle) {
    autofollowToggle.checked = ProtoState.autoFollow;
    autofollowToggle.addEventListener('change', (e) => {
      ProtoState.autoFollow = e.target.checked;
      showToast(`Auto-follow ${ProtoState.autoFollow ? 'enabled' : 'paused'}`);
      if (ProtoState.autoFollow) scrollLogsToBottom();
    });
  }

  // Initial render
  updateView('split');
}

function scrollLogsToBottom() {
  setTimeout(() => {
    const colP = document.getElementById('col-progress');
    const colL = document.getElementById('feed-logs');
    if (colP) colP.scrollTop = colP.scrollHeight;
    if (colL) colL.scrollTop = colL.scrollHeight;
  }, 50);
}

function renderTimelineHtml() {
  const steps = [
    { title: 'Task Received', desc: 'CEO instruction received: Create customer login page', time: '16:52:00', state: 'done' },
    { title: 'AR Evaluated Task', desc: 'Assessed as routine frontend web deliverable. Low risk profile.', time: '16:52:01', state: 'done' },
    { title: 'Builder Selected', desc: 'Cline assigned on Google AI Studio (Gemini 3.5 Flash Lite)', time: '16:52:02', state: 'done' },
    { title: 'Reviewer Reserved', desc: 'Antigravity pre-selected for independent verification before build began', time: '16:52:02', state: 'done' },
    { title: 'Builder Started', desc: 'Isolated draft workspace initialized in .router/tasks/task-20260914-login-auth/', time: '16:52:03', state: 'done' },
    { title: 'Draft Completed', desc: 'Generated index.html, styles.css, app.js. Draft digest verified.', time: '16:54:15', state: 'done' },
    { title: 'Automatic Checks Passed', desc: '4 of 4 automated browser integrity and syntax checks passed.', time: '16:55:01', state: 'done' },
    { title: 'Independent Review Started', desc: 'Antigravity inspecting deliverable draft for WCAG and security standards.', time: '16:55:10', state: 'done' },
    { title: 'Review Completed — PASS', desc: 'Antigravity verified code clean and compliant. Zero critical issues.', time: '16:57:42', state: 'done' },
    { title: 'Waiting for Decision', desc: 'Deliverable ready for CEO review and Stage B sign-off.', time: '16:57:43', state: 'active' }
  ];

  return `
    <div class="timeline-list">
      ${steps.map((s, idx) => `
        <div class="timeline-item ${s.state}">
          <div class="timeline-marker">${s.state === 'done' ? '✓' : (idx + 1)}</div>
          <div class="timeline-content">
            <span class="timeline-title">${s.title}</span>
            <span class="timeline-desc">${s.desc}</span>
            <span class="timeline-time">${s.time}</span>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderTechLogsHtml() {
  return ProtoState.techLogs.map(log => `
    <div class="log-entry">
      <span class="log-time">[${log.time}]</span>
      <span class="log-tag ${log.tag}">${log.tag.toUpperCase()}</span>
      <span class="log-msg">${log.msg}</span>
    </div>
  `).join('');
}

// 5. Decision / Warning / Permission Variations Switcher
function setupDecisionVariations() {
  const container = document.getElementById('decision-card-container');
  const tabs = document.querySelectorAll('.var-tab-btn');

  const dialogData = {
    decision: {
      type: 'decision',
      icon: '✅',
      title: 'Your Decision Needed',
      subtitle: 'Reviewer has finished checking the work. Please review and choose an action.',
      details: `
        <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
          <strong>Deliverable Draft Ready (Stage B)</strong>
          <span class="badge green">Review Verdict: PASS</span>
        </div>
        <p style="color: #475569; margin-bottom: 0.4rem;">Files modified: <code>index.html</code>, <code>styles.css</code>, <code>app.js</code> (3 files).</p>
        <p style="color: #475569;">Senior Auditor Antigravity verified WCAG AA accessible form controls, clean credential validation, and zero CSRF vulnerabilities.</p>
      `,
      primaryBtn: { label: 'Approve Deliverable', action: 'approve', class: 'btn-success' },
      secondaryBtn: { label: 'Request Changes', action: 'request_changes', class: 'btn-warning' }
    },
    permission: {
      type: 'permission',
      icon: '🛡️',
      title: 'Permission Required',
      subtitle: 'Worker requests permission to execute a shell script outside standard sandbox.',
      details: `
        <p style="margin-bottom: 0.4rem;"><strong>Command:</strong> <code>npm run build:prod</code></p>
        <p style="color: #475569;">Target Directory: <code>C:\\projects\\adaptive-router</code></p>
        <p style="color: #475569; margin-top: 0.3rem;">Adaptive Router paused the task to protect local file security until you authorize.</p>
      `,
      primaryBtn: { label: 'Allow Execution', action: 'allow', class: 'btn-primary' },
      secondaryBtn: { label: 'Deny', action: 'deny', class: 'btn-secondary' }
    },
    warning: {
      type: 'warning',
      icon: '⚠️',
      title: 'Operational Warning',
      subtitle: 'Antigravity response latency exceeds 30 seconds due to heavy external request load.',
      details: `
        <p style="color: #92400e;">The task is proceeding normally, but review turnaround time may take up to 2 additional minutes.</p>
        <p style="color: #92400e; margin-top: 0.2rem;">You may wait for completion or switch reviewer to Claude.</p>
      `,
      primaryBtn: { label: 'Acknowledge & Continue', action: 'ack', class: 'btn-warning' },
      secondaryBtn: { label: 'Switch Reviewer', action: 'switch_reviewer', class: 'btn-secondary' }
    },
    sensitivity: {
      type: 'sensitivity',
      icon: '🔒',
      title: 'CEO Sensitivity Override Required',
      subtitle: 'Sensitive keywords ("production_db", "api_secret") detected in task instruction.',
      details: `
        <p style="color: #9a3412;">Adaptive Router automatically paused this task (<strong>needs_cto_attention</strong>) in accordance with Stage A governance rules.</p>
        <p style="color: #9a3412; margin-top: 0.3rem;">To proceed without modification, CEO explicit override authorization is required.</p>
      `,
      primaryBtn: { label: 'Authorize CEO Override', action: 'override', class: 'btn-warning' },
      secondaryBtn: { label: 'Cancel Task', action: 'cancel_task', class: 'btn-danger-outline' }
    },
    reviewer: {
      type: 'reviewer',
      icon: '👥',
      title: 'Qualified Reviewer Required',
      subtitle: 'Task is ready to build, but no independent qualified reviewer is currently enabled.',
      details: `
        <p style="color: #6b21a8;">Builder <strong>Cline</strong> requires a Tier 2+ independent auditor. Both Codex and Antigravity are currently disabled.</p>
        <p style="color: #6b21a8; margin-top: 0.3rem;">Adaptive Router will not start drafting without a reserved reviewer.</p>
      `,
      primaryBtn: { label: 'Enable Antigravity as Reviewer', action: 'enable_antigravity', class: 'btn-primary' },
      secondaryBtn: { label: 'Enable Claude', action: 'enable_claude', class: 'btn-secondary' }
    },
    unavailable: {
      type: 'unavailable',
      icon: '🔌',
      title: 'Platform Quota Exceeded (Failover)',
      subtitle: 'Google AI Studio returned HTTP 429 quota exhaustion. Auto-failover ready.',
      details: `
        <p style="color: #991b1b;">Builder <strong>Cline</strong> reached daily usage limit on <code>gemini-3.5-flash-lite</code>.</p>
        <p style="color: #991b1b; margin-top: 0.3rem;">Adaptive Router can cleanly failover builder duties to <strong>Claude (Sonnet)</strong> without losing task context.</p>
      `,
      primaryBtn: { label: 'Authorize Failover to Claude', action: 'failover_claude', class: 'btn-danger' },
      secondaryBtn: { label: 'Wait for Quota Reset', action: 'wait_quota', class: 'btn-secondary' }
    },
    failure: {
      type: 'failure',
      icon: '❌',
      title: 'Automatic Validation Check Failed',
      subtitle: 'Deliverable draft failed 1 automated test assertion during pre-review validation.',
      details: `
        <p style="color: #991b1b;"><strong>Test:</strong> <code>test/greeting.test.mjs</code> — Expected output "Hello, Adaptive Router!", received undefined.</p>
        <p style="color: #991b1b; margin-top: 0.3rem;">Draft rejected back to builder for Revision 2 automatic correction.</p>
      `,
      primaryBtn: { label: 'Trigger Auto-Correction', action: 'auto_correct', class: 'btn-danger' },
      secondaryBtn: { label: 'Inspect Failure Report', action: 'inspect_fail', class: 'btn-secondary' }
    }
  };

  function renderVariation(key) {
    ProtoState.activeVariation = key;
    tabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-var') === key));

    const item = dialogData[key];
    if (!item || !container) return;

    container.innerHTML = `
      <div class="decision-dialog-card dialog-${item.type}">
        <div class="dialog-header">
          <div class="dialog-icon">${item.icon}</div>
          <div class="dialog-title-wrap">
            <h3>${item.title}</h3>
            <p>${item.subtitle}</p>
          </div>
        </div>

        <div class="dialog-details-box">
          ${item.details}
        </div>

        <div class="dialog-actions-row">
          <div class="dialog-btn-group">
            <button type="button" class="btn ${item.primaryBtn.class}" data-action="${item.primaryBtn.action}">${item.primaryBtn.label}</button>
            <button type="button" class="btn ${item.secondaryBtn.class}" data-action="${item.secondaryBtn.action}">${item.secondaryBtn.label}</button>
          </div>
          <div class="dialog-btn-group">
            <button type="button" class="btn btn-secondary" data-action="pause" title="Pause in-flight operations">Pause</button>
            <button type="button" class="btn btn-danger-outline" data-action="stop" title="Terminate task">Stop</button>
          </div>
        </div>
      </div>
    `;

    attachDialogButtons();
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const v = tab.getAttribute('data-var');
      renderVariation(v);
    });
  });

  renderVariation('decision');
}

// 6. Action Button Handlers
function setupTaskActions() {
  // Global actions
}

function attachDialogButtons() {
  document.querySelectorAll('.decision-dialog-card button[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const act = e.currentTarget.getAttribute('data-action');
      handleActionClick(act);
    });
  });
}

function handleActionClick(action) {
  const currentTaskBadge = document.getElementById('current-task-status-badge');
  const currentTaskNext = document.getElementById('current-task-next-step');

  switch (action) {
    case 'approve':
      showToast('🎉 Deliverable approved! Changes applied cleanly to project root.', 'success');
      if (currentTaskBadge) {
        currentTaskBadge.textContent = 'COMPLETED (APPROVED)';
        currentTaskBadge.className = 'badge green';
      }
      if (currentTaskNext) currentTaskNext.textContent = 'Task completed cleanly';
      break;

    case 'request_changes':
      showToast('📝 Changes requested. Builder dispatched for Revision 2.', 'warning');
      if (currentTaskBadge) {
        currentTaskBadge.textContent = 'REVISION IN PROGRESS';
        currentTaskBadge.className = 'badge amber';
      }
      if (currentTaskNext) currentTaskNext.textContent = 'Cline applying requested changes';
      break;

    case 'pause':
      showToast('⏸️ Task paused by user. In-flight operations held safely.', 'warning');
      if (currentTaskBadge) {
        currentTaskBadge.textContent = 'PAUSED BY USER';
        currentTaskBadge.className = 'badge amber';
      }
      if (currentTaskNext) currentTaskNext.textContent = 'Waiting for user resume';
      break;

    case 'stop':
      showToast('🛑 Task stopped and cancelled. Router lock released.', 'danger');
      if (currentTaskBadge) {
        currentTaskBadge.textContent = 'CANCELLED BY USER';
        currentTaskBadge.className = 'badge red';
      }
      if (currentTaskNext) currentTaskNext.textContent = 'Task aborted';
      break;

    case 'override':
      showToast('🔓 CEO sensitivity override authorized! Resuming execution...', 'success');
      break;

    case 'enable_antigravity':
      const toggle = document.getElementById('toggle-antigravity-limit');
      if (toggle) {
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
      }
      showToast('✅ Antigravity enabled! Reviewer reserved successfully.', 'success');
      break;

    case 'failover_claude':
      showToast('🔄 Failover complete: Claude assigned as builder.', 'info');
      break;

    default:
      showToast(`Action executed: ${action}`, 'info');
      break;
  }
}

// 7. Tasks Page Setup
function setupTasksPage() {
  const tableBody = document.getElementById('tasks-table-body');
  const filterTabs = document.querySelectorAll('.task-filter-tab');
  const searchInput = document.getElementById('task-search-input');

  let currentFilter = 'all';

  function renderTasks() {
    if (!tableBody) return;
    const q = (searchInput?.value || '').toLowerCase().trim();

    const filtered = ProtoState.tasks.filter(t => {
      const matchesFilter = currentFilter === 'all' ||
        (currentFilter === 'running' && t.status === 'Running') ||
        (currentFilter === 'decision' && t.status === 'Waiting for Decision') ||
        (currentFilter === 'completed' && t.status === 'Completed') ||
        (currentFilter === 'failed' && t.status === 'Failed') ||
        (currentFilter === 'cancelled' && t.status === 'Cancelled');

      const matchesSearch = !q || t.name.toLowerCase().includes(q) || t.builder.toLowerCase().includes(q) || t.id.toLowerCase().includes(q);

      return matchesFilter && matchesSearch;
    });

    tableBody.innerHTML = filtered.map(t => `
      <tr class="task-row" data-id="${t.id}">
        <td class="task-name-cell">
          <div style="font-weight: 700; color: var(--text-main); font-size: 0.95rem;">${t.name}</div>
          <div style="font-family: var(--font-mono); font-size: 0.78rem; color: var(--text-muted); margin-top: 2px;">${t.id}</div>
          <div class="task-desc-sub" style="margin-top: 2px; color: #475569;">${t.type}</div>
        </td>
        <td>
          <div style="font-weight: 600; color: var(--text-main);">${t.started}</div>
          <div style="font-size: 0.76rem; color: var(--text-muted);">${t.startedTime || '16:52'}</div>
        </td>
        <td>
          <div style="font-weight: 600; color: var(--text-main);">${t.builder}</div>
        </td>
        <td>
          <div style="font-weight: 600; color: var(--text-main);">${t.reviewer}</div>
        </td>
        <td>
          <span style="font-family: var(--font-mono); font-weight: 600; color: var(--text-main);">${t.duration}</span>
        </td>
        <td style="width: 140px;">
          <div class="usage-progress" style="height: 6px;">
            <div class="usage-fill fill-${t.statusClass === 'green' ? 'green' : t.statusClass === 'amber' ? 'amber' : t.statusClass === 'red' ? 'amber' : 'blue'}" style="width: ${t.progress}%;"></div>
          </div>
          <div style="font-size: 0.72rem; color: #64748b; margin-top: 0.2rem; text-align: right; font-weight: 600;">${t.progress}%</div>
        </td>
        <td>
          <span class="badge ${t.statusClass}">${t.status}</span>
        </td>
      </tr>
    `).join('');

    // Attach row click listeners for modal
    tableBody.querySelectorAll('.task-row').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-id');
        openTaskModal(id);
      });
    });
  }

  filterTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      filterTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.getAttribute('data-filter');
      renderTasks();
    });
  });

  searchInput?.addEventListener('input', renderTasks);
  renderTasks();

  setupModal();
}

function setupModal() {
  const modal = document.getElementById('task-detail-modal');
  const closeBtn = document.getElementById('modal-close-btn');

  closeBtn?.addEventListener('click', () => {
    modal?.classList.remove('active');
  });

  modal?.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('active');
  });
}

function openTaskModal(taskId) {
  const task = ProtoState.tasks.find(t => t.id === taskId);
  if (!task) return;

  const modal = document.getElementById('task-detail-modal');
  const content = document.getElementById('modal-body-content');
  if (!modal || !content) return;

  content.innerHTML = `
    <div style="margin-bottom: 1.5rem;">
      <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem;">
        <h2 style="font-size: 1.35rem; font-weight: 700;">${task.name}</h2>
        <span class="badge ${task.statusClass}">${task.status}</span>
      </div>
      <p style="color: #64748b; font-size: 0.88rem;">Task ID: <code>${task.id}</code> • ${task.type}</p>
    </div>

    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 1.25rem; margin-bottom: 1.5rem;">
      <h4 style="font-size: 0.95rem; font-weight: 700; margin-bottom: 0.5rem;">Executive Summary</h4>
      <p style="color: #334155; font-size: 0.92rem; line-height: 1.5;">${task.summary}</p>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem;">
      <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 1rem;">
        <span style="font-size: 0.75rem; text-transform: uppercase; color: #64748b; font-weight: 700;">Builder Assigned</span>
        <div style="font-weight: 700; font-size: 0.95rem; margin-top: 0.2rem;">${task.builder}</div>
      </div>
      <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 1rem;">
        <span style="font-size: 0.75rem; text-transform: uppercase; color: #64748b; font-weight: 700;">Reviewer Assigned</span>
        <div style="font-weight: 700; font-size: 0.95rem; margin-top: 0.2rem;">${task.reviewer}</div>
      </div>
    </div>

    <div style="margin-bottom: 1.5rem;">
      <h4 style="font-size: 0.95rem; font-weight: 700; margin-bottom: 0.5rem;">Modified Files</h4>
      <ul style="list-style: none; display: flex; flex-direction: column; gap: 0.35rem;">
        ${task.files.length ? task.files.map(f => `
          <li style="font-family: var(--font-mono); font-size: 0.85rem; background: #f1f5f9; padding: 0.35rem 0.65rem; border-radius: 4px; display: inline-flex; align-items: center; gap: 0.5rem;">
            📄 ${f}
          </li>
        `).join('') : '<li style="color: #94a3b8; font-size: 0.85rem;">No files modified</li>'}
      </ul>
    </div>

    <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 1rem;">
      <h4 style="font-size: 0.9rem; font-weight: 700; color: #065f46; margin-bottom: 0.25rem;">Reviewer Audit Finding</h4>
      <p style="color: #047857; font-size: 0.88rem;">${task.verdict}</p>
    </div>
  `;

  modal.classList.add('active');
}

// 8. Progress Page Setup
function setupProgressPage() {
  const taskSelect = document.getElementById('progress-task-select');
  const container = document.getElementById('progress-dedicated-timeline');
  const toggle = document.getElementById('toggle-progress-autofollow');

  function renderDedicatedTimeline(taskName) {
    if (!container) return;
    container.innerHTML = renderTimelineHtml();
  }

  taskSelect?.addEventListener('change', (e) => {
    renderDedicatedTimeline(e.target.value);
    showToast(`Loaded progress timeline for: ${e.target.options[e.target.selectedIndex].text}`);
  });

  toggle?.addEventListener('change', (e) => {
    showToast(`Auto-follow ${e.target.checked ? 'enabled' : 'disabled'}`);
  });

  renderDedicatedTimeline('task-1');
}

// 9. Technical Logs Page Setup
function setupTechLogsPage() {
  const feed = document.getElementById('tech-logs-full-feed');
  const filterChips = document.querySelectorAll('.tech-filter-chip');
  const searchInput = document.getElementById('tech-log-search-input');
  const autofollowToggle = document.getElementById('toggle-tech-autofollow');

  let currentTag = 'all';

  function renderLogs() {
    if (!feed) return;
    const q = (searchInput?.value || '').toLowerCase().trim();

    const filtered = ProtoState.techLogs.filter(l => {
      const matchesTag = currentTag === 'all' || l.tag === currentTag;
      const matchesSearch = !q || l.msg.toLowerCase().includes(q) || l.platform.toLowerCase().includes(q) || l.type.toLowerCase().includes(q);
      return matchesTag && matchesSearch;
    });

    feed.innerHTML = filtered.map(log => `
      <div class="log-entry">
        <span class="log-time">[${log.time}]</span>
        <span class="log-tag ${log.tag}">${log.tag.toUpperCase()}</span>
        <span style="color: #94a3b8; font-size: 0.75rem;">(${log.platform})</span>
        <span class="log-msg">${log.msg}</span>
      </div>
    `).join('');

    if (ProtoState.autoFollow) {
      feed.scrollTop = feed.scrollHeight;
    }
  }

  filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
      filterChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentTag = chip.getAttribute('data-tag');
      renderLogs();
    });
  });

  searchInput?.addEventListener('input', renderLogs);

  autofollowToggle?.addEventListener('change', (e) => {
    ProtoState.autoFollow = e.target.checked;
    showToast(`Auto-follow ${e.target.checked ? 'enabled' : 'disabled'}`);
    if (ProtoState.autoFollow && feed) feed.scrollTop = feed.scrollHeight;
  });

  renderLogs();
}

// 10. Settings Page Setup
function setupSettingsPage() {
  document.querySelectorAll('#view-settings input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', (e) => {
      showToast(`Setting updated: ${e.target.closest('.settings-row')?.querySelector('.settings-label')?.textContent || 'Preference'} -> ${e.target.checked ? 'ON' : 'OFF'}`, 'info');
    });
  });

  const advBtn = document.getElementById('btn-advanced-settings-toggle');
  const advSection = document.getElementById('advanced-settings-content');

  advBtn?.addEventListener('click', () => {
    const isHidden = advSection.style.display === 'none';
    advSection.style.display = isHidden ? 'block' : 'none';
    advBtn.textContent = isHidden ? 'Hide Advanced Settings ▲' : 'Show Advanced Settings ▼';
  });
}
