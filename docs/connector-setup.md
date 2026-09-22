# ChatGPT ↔ Adaptive Router Connector Guide

## Operating Model

```
┌─────────────────────────────────────────────────────────────┐
│               ChatGPT (Web / Desktop App)                   │
│          Your AI planning and review workspace               │
│   (Requirements, feature design, questions, approvals)      │
└──────────────────────────────┬──────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            │                                     │
    [READ / MONITOR]                     [EXECUTE / WRITE]
  ChatGPT Pro MCP Connector              ChatGPT Work Bridge
  (Real-time status, test results,       (Operates local dashboard
   audit findings, deliverables)          to launch approved tasks)
            │                                     │
            └──────────────────┬──────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Adaptive Router System                      │
│                    Execution Office                         │
│           (Routing, sandboxes, verification)                │
└──────────────────────────────┬──────────────────────────────┘
                               │
        ┌──────────────┬───────┴───────┬──────────────┐
        ▼              ▼               ▼              ▼
    [Codex]     [Antigravity]    [Claude Code]     [Cline]
  (OpenAI Tier)  (DeepMind Tier)  (Reserve Mode)  (Gemini API)
```

---

## 1. What ChatGPT Can See Directly Right Now (Read Operations)

Through the new MCP connector, ChatGPT can read and inspect all of the following without you copying and pasting anything:

| Information | Tool Name | What ChatGPT Sees |
|---|---|---|
| **System Status** | `get_project_status` | Claude Reserve Mode state, active task in progress, total task counts |
| **Available Projects** | `list_projects` | All configured projects (Adaptive Router System, Sample Shop) |
| **Recent Tasks** | `list_recent_tasks` | The last 10–30 tasks, their status, specialist used, and worker assigned |
| **Task Status** | `get_task_status` | Complete task details: worker, model, reasoning effort, routing reason |
| **Live Progress** | `get_live_progress` | Real-time activity log entries showing what the AI workers are doing |
| **Test Results** | `get_test_results` | Automated headless Chrome browser test results and check counts |
| **Reviewer Findings** | `get_reviewer_findings` | Independent AI auditor verdict (`pass`/`fail`), summary, and issues |
| **Deliverables** | `get_deliverable_summary` | Summary of what was created/changed and list of modified files |
| **Approval State** | `get_approval_state` | Whether a task is `awaiting_your_approval`, `approved`, or `rejected` |
| **Failovers & Quotas** | `get_failovers_and_errors` | Any automatic worker switches, quota limits hit, and escalations |

### Security Guarantee
All read responses are automatically sanitized. **API keys, OAuth tokens, passwords, secrets, and raw credential files are never exposed** to ChatGPT or over the network.

---

## 2. What ChatGPT Pro Cannot Do Directly

On individual **ChatGPT Pro ($20/mo)** plans:
- Custom MCP connectors are **read-only / fetch-only** in practice.
- Direct write actions (such as triggering an external build or modifying local files directly via MCP) are gated by OpenAI or reserved for Business/Enterprise workspaces.
- Even if a write tool is defined, ChatGPT Pro will not execute destructive/modifying actions silently.

---

## 3. How ChatGPT Work Temporarily Bridges the Gap

Because ChatGPT Pro cannot call write endpoints directly through MCP, **ChatGPT Work (Operator / Computer-Use)** acts as your execution bridge:

1. **Plan in ChatGPT**: You and ChatGPT discuss the feature and finalize requirements.
2. **User Approves**: You say: *"Looks good, please execute this in Adaptive Router."*
3. **ChatGPT Work Acts**: ChatGPT Work opens `http://localhost:3210` in your browser, pastes the instruction into the Execution Office box, and clicks **⚡ Execute Task**.
4. **Adaptive Router Executes**: Adaptive Router selects the specialist, builder, model, effort, runs automated browser tests, and has an independent reviewer audit the code.
5. **ChatGPT Reads the Result**: Using the MCP connector, your ChatGPT conversation automatically queries `get_task_status`, `get_test_results`, and `get_reviewer_findings`.
6. **ChatGPT Reports Back**: ChatGPT summarizes what was built, how the tests passed, and asks for your final approval.

You never copy/paste code or task logs between windows.

---

## 4. What Becomes Possible Later

When OpenAI rolls out full MCP write tool support to individual Pro accounts:
- The ChatGPT Work browser bridge can be retired.
- ChatGPT will be able to invoke `submit_task`, `approve_result`, and `reject_result` directly from the chat window (with a confirmation prompt).
- The Adaptive Router connector **already implements and tests these write endpoints** today (`/api/connector/tasks`, `/api/connector/tasks/:id/approve`, etc.). No backend redesign will be needed.

---

## 5. Step-by-Step Setup Guide

### Step 1: Start Adaptive Router
Open a terminal in the project directory and start the dashboard:
```powershell
npm run dashboard
```
Verify the dashboard opens at `http://localhost:3210`.

### Step 2: Get Your Secret Connector Token
Open your browser and visit:
```
http://localhost:3210/api/connector/token
```
You will see a 64-character token (e.g. `a1b2c3d4...`). **Copy this token.** It was auto-generated and saved securely in your local `workers.json`.

### Step 3: Start the Secure Tunnel
In a second terminal, run:
```powershell
npm run tunnel
```
*(Or double-click `scripts\start-tunnel.cmd`)*

If `cloudflared` is not yet installed on your machine, install it quickly via:
```powershell
winget install --id Cloudflare.cloudflared
```
The tunnel will output a public HTTPS URL such as:
```
https://random-words-1234.trycloudflare.com
```
**Copy this HTTPS URL.**

### Step 4: Add the Connector in ChatGPT
1. Open [ChatGPT](https://chatgpt.com) in your web browser.
2. Click your profile picture (bottom-left) → **Settings**.
3. Go to **Connectors** (or **Security & Login** / **Advanced** depending on UI version).
4. Toggle **Developer Mode** to **ON**.
5. Click **Add Connector** (or **+**).
6. Enter:
   - **Name**: `Adaptive Router`
   - **Server URL**: `https://<your-tunnel-url>.trycloudflare.com/mcp`
   - **Authentication**: `Bearer Token`
   - **Token**: Paste the 64-character token from Step 2.
7. Confirm and save.

### Step 5: Start a Conversation in ChatGPT
In any new ChatGPT conversation:
- Click the **+** (tools) icon near the chat prompt and ensure **Adaptive Router** is active.
- Try asking:
  > *"Check the status of Adaptive Router and show me recent tasks."*
- ChatGPT will automatically call `get_project_status` and `list_recent_tasks` and report the answers directly in your chat!

---

## 6. Example ChatGPT Prompts

Once connected, you can use prompts like these:

- *"What is Adaptive Router currently working on?"*
- *"Show me the test results and reviewer findings for the latest task."*
- *"Did the last task pass independent audit?"*
- *"What files were modified in the latest build?"*
- *"Is Claude Reserve Mode turned on right now?"*
- *"Summarize any worker failures or failovers that happened recently."*
