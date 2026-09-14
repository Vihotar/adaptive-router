/**
 * mcp-server.mjs — MCP JSON-RPC 2.0 Protocol Handler
 *
 * Implements the Model Context Protocol HTTP transport so ChatGPT can connect
 * to Adaptive Router in Developer Mode. Only read tools are exposed (ChatGPT
 * Pro cannot invoke write actions via MCP today — write endpoints exist as REST
 * and are ready for future Pro upgrade or ChatGPT Work bridge use).
 *
 * Protocol:
 *   POST /mcp  — JSON-RPC 2.0 request → response
 *   GET  /mcp  — returns server info (health check)
 *
 * Methods handled:
 *   initialize      — handshake, returns server capabilities
 *   tools/list      — returns all available read tools
 *   tools/call      — executes a tool and returns result
 */

import {
  listProjects,
  getProjectStatus,
  listRecentTasks,
  getTaskStatus,
  getLiveProgress,
  getTestResults,
  getReviewerFindings,
  getDeliverableSummary,
  getApprovalState,
  getFailoversAndErrors,
  // Write tools (available for REST / future MCP write support)
  submitTask,
  approveTask,
  rejectTask,
  toggleClaudeReserve
} from './connector.mjs';

const SERVER_NAME = 'adaptive-router';
const SERVER_VERSION = '1.0.0';

// ── Tool Definitions ──────────────────────────────────────────────────────────

export const READ_TOOLS = [
  {
    name: 'list_projects',
    description: 'List all available Adaptive Router projects with their current status.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_project_status',
    description: 'Get overall system status: Claude Reserve Mode, active task lock, routing mode, and task summary counts.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'list_recent_tasks',
    description: 'List the most recent tasks with their status, worker, model, specialist, and instruction summary. Use this to see what has been built lately.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of tasks to return (default 10, max 30)'
        }
      },
      required: []
    }
  },
  {
    name: 'get_task_status',
    description: 'Get the full status of a specific task: current state, worker used, model, effort level, specialist loaded, routing reason, and whether a decision is required.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID (format: YYYYMMDDTHHMMSS-xxxxxxxx)'
        }
      },
      required: ['task_id']
    }
  },
  {
    name: 'get_live_progress',
    description: 'Get the latest real-time progress events for a running or recently completed task. Shows what the AI workers are doing right now.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID to get live progress for'
        }
      },
      required: ['task_id']
    }
  },
  {
    name: 'get_test_results',
    description: 'Get the automated browser test results for a task — which checks passed or failed.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'get_reviewer_findings',
    description: 'Get the independent AI reviewer verdict and summary for a task. The reviewer is always a different AI worker from the builder.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'get_deliverable_summary',
    description: 'Get a summary of what was built in a task: feature description, which files changed, project name, and where to view the result.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'get_approval_state',
    description: 'Check whether a task is approved, rejected, or awaiting your approval. Tells you exactly what action is needed.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'get_failovers_and_errors',
    description: 'Get any worker failures or automatic failover events for a task — shows if Adaptive Router had to switch workers and why.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' }
      },
      required: ['task_id']
    }
  }
];

// Write tools — defined but annotated as destructive (ChatGPT Pro will gate these)
export const WRITE_TOOLS = [
  {
    name: 'submit_task',
    description: 'Submit a new task for Adaptive Router to execute. Adaptive Router will automatically select the best specialist, worker, and model.',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'The business instruction describing what to build or change' },
        project: { type: 'string', enum: ['test-site', 'adaptive-router'], description: 'Which project to run the task against (default: test-site)' },
        allow_claude: { type: 'boolean', description: 'Override Claude Reserve Mode and allow Claude Code for this task (default: false)' }
      },
      required: ['instruction']
    }
  },
  {
    name: 'approve_result',
    description: 'Approve a completed deliverable that is awaiting your approval.',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to approve' },
        reason: { type: 'string', description: 'Optional approval note' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'reject_result',
    description: 'Reject a deliverable that is awaiting approval.',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to reject' },
        reason: { type: 'string', description: 'Required: explain why you are rejecting this deliverable' }
      },
      required: ['task_id', 'reason']
    }
  },
  {
    name: 'toggle_claude_reserve',
    description: 'Enable or disable Claude Reserve Mode. When ON, Claude quota is preserved for your Cowork browser/desktop usage.',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true = Claude Reserve ON (preserve quota), false = Claude available for routing' }
      },
      required: ['enabled']
    }
  }
];

export const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];

// ── Tool Execution ────────────────────────────────────────────────────────────

export async function callTool(root, toolName, args) {
  switch (toolName) {
    case 'list_projects':
      return listProjects(root);
    case 'get_project_status':
      return getProjectStatus(root);
    case 'list_recent_tasks':
      return listRecentTasks(root, Math.min(parseInt(args.limit) || 10, 30));
    case 'get_task_status':
      return getTaskStatus(root, args.task_id);
    case 'get_live_progress':
      return getLiveProgress(root, args.task_id);
    case 'get_test_results':
      return getTestResults(root, args.task_id);
    case 'get_reviewer_findings':
      return getReviewerFindings(root, args.task_id);
    case 'get_deliverable_summary':
      return getDeliverableSummary(root, args.task_id);
    case 'get_approval_state':
      return getApprovalState(root, args.task_id);
    case 'get_failovers_and_errors':
      return getFailoversAndErrors(root, args.task_id);
    // Write tools
    case 'submit_task':
      return await submitTask(root, {
        instruction: args.instruction,
        project: args.project || 'test-site',
        allowClaude: Boolean(args.allow_claude)
      });
    case 'approve_result':
      return approveTask(root, args.task_id, { reason: args.reason });
    case 'reject_result':
      return rejectTask(root, args.task_id, { reason: args.reason });
    case 'toggle_claude_reserve':
      return toggleClaudeReserve(root, args.enabled);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ── MCP JSON-RPC Request Handler ─────────────────────────────────────────────

export async function handleMcpRequest(root, body) {
  const { jsonrpc, id, method, params } = body;

  function ok(result) {
    return { jsonrpc: '2.0', id, result };
  }
  function err(code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  if (jsonrpc !== '2.0') return err(-32600, 'Invalid JSON-RPC version');

  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
        });

      case 'notifications/initialized':
        return ok({});

      case 'tools/list':
        return ok({ tools: ALL_TOOLS });

      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        if (!toolName) return err(-32602, 'Missing tool name');
        try {
          const data = await callTool(root, toolName, toolArgs);
          return ok({
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
          });
        } catch (toolErr) {
          return ok({
            content: [{ type: 'text', text: `Error: ${toolErr.message}` }],
            isError: true
          });
        }
      }

      case 'ping':
        return ok({});

      default:
        return err(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return err(-32603, `Internal error: ${e.message}`);
  }
}
