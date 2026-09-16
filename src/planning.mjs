/**
 * planning.mjs — AI CTO Planning Mode for Adaptive Router
 *
 * Manages project-specific planning conversations between the CTO and an AI CTO
 * assistant.
 *
 * NO execution workers (Codex, Claude, Antigravity, Cline) are ever invoked here.
 * Only the codeTask() call triggered by approvePlanAndExecute() may launch builders.
 */

import fs from 'node:fs';
import path from 'node:path';

const SYSTEM_PROMPT = `You are the AI CTO and strategic planning assistant for Adaptive Router — an intelligent AI task routing platform built by a business owner (the CTO) who is not a developer.

Your role in Planning Mode:
1. Have a genuine, thoughtful conversation with the CTO about their project goals.
2. Ask clarifying questions to understand requirements fully before proposing anything.
3. Challenge weak assumptions and surface hidden risks in a friendly, business-focused way.
4. Help define clear, achievable requirements that respect the CTO's constraints.
5. When the CTO has given enough information, propose a structured execution plan.

Core constraints you must always respect:
- Claude Reserve Mode is ON by default — Claude Pro quota is preserved for the CTO's personal Cowork usage in browser/desktop. Do not recommend using Claude unless the CTO explicitly overrides this.
- Do not suggest connecting example.com or any external production system until the CTO explicitly asks.
- Do not suggest purchasing additional APIs or paid services unless the CTO asks.
- Never claim to execute code, modify files, or launch workers — you are a conversational planning assistant only.

Communication style:
- Speak in plain business language, not developer jargon.
- Be concise but thorough — the CTO is busy.
- Use bullet points and numbered lists to make information scannable.
- When proposing a plan, clearly separate: GOAL, RECOMMENDED APPROACH, KEY RISKS, PROPOSED STEPS.

When you are ready to propose a structured plan (either because the CTO asks for it, or because the conversation has covered the key requirements), include this exact marker on its own line:

---PLAN_PROPOSED---

Then immediately follow with a JSON block in this exact format (no markdown fences, just raw JSON):

{"goal":"<one-sentence goal>","approach":"<2-3 sentence recommended approach>","specialist":"<most relevant specialist>","builder":"Adaptive Router selects automatically","reviewer":"Qualified independent premium reviewer selected automatically","checklist":["Step 1: ...","Step 2: ...","Step 3: ..."]}

After the JSON, continue with a human-readable summary of the proposed plan for the CTO.`;

/**
 * Returns the planning state file path for a project.
 */
function planningFile(root, project) {
  return path.join(root, '.router', 'projects', project, 'planning.json');
}

/**
 * Read current planning state for a project.
 * Creates a fresh state if none exists yet.
 */
export function getPlanningState(root, project) {
  const file = planningFile(root, project);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // Corrupted — start fresh
    }
  }
  return { messages: [], proposedPlan: null, status: 'planning' };
}

/**
 * Persist planning state to disk.
 */
export function savePlanningState(root, project, state) {
  const file = planningFile(root, project);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Send a CTO message to the AI CTO and get a response.
 * Maintains full conversation history for context continuity.
 *
 * Returns: { reply: string, proposedPlan: object|null }
 */
export async function sendPlanningMessage(root, { project, message }) {
  const state = getPlanningState(root, project);

  // Append CTO message and persist immediately so it's captured even if API fails
  state.messages.push({
    role: 'user',
    content: message,
    time: new Date().toISOString()
  });
  savePlanningState(root, project, state);

  // Build messages array for API (system + conversation history, without custom 'time' field)
  const apiMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...state.messages.map(m => ({ role: m.role, content: m.content }))
  ];

  // Conversational planning provider is offline
  throw new Error('Planning AI unavailable: conversational planning provider is not configured.');

  // Detect plan proposal marker
  let proposedPlan = null;
  let cleanReply = rawReply;

  const markerIdx = rawReply.indexOf('---PLAN_PROPOSED---');
  if (markerIdx !== -1) {
    // Extract the JSON block immediately after the marker
    const afterMarker = rawReply.slice(markerIdx + '---PLAN_PROPOSED---'.length).trim();
    const jsonEnd = afterMarker.indexOf('\n\n');
    const jsonStr = jsonEnd !== -1 ? afterMarker.slice(0, jsonEnd).trim() : afterMarker.split('\n')[0].trim();
    try {
      proposedPlan = JSON.parse(jsonStr);
      proposedPlan.id = `plan-${Date.now()}`;
      state.proposedPlan = proposedPlan;
      state.status = 'plan_proposed';
    } catch {
      // Malformed JSON — ignore plan extraction, treat as normal reply
    }
    // Remove the marker and raw JSON from the human-visible reply
    cleanReply = rawReply.slice(0, markerIdx).trim();
    const remainderAfterJson = jsonEnd !== -1
      ? afterMarker.slice(jsonEnd).trim()
      : afterMarker.split('\n').slice(1).join('\n').trim();
    if (remainderAfterJson) cleanReply += '\n\n' + remainderAfterJson;
  }

  // Append AI CTO reply to history
  state.messages.push({
    role: 'assistant',
    content: cleanReply,
    time: new Date().toISOString()
  });

  savePlanningState(root, project, state);

  return { reply: cleanReply, proposedPlan };
}

/**
 * Reset the planning conversation for a project (start fresh).
 */
export function resetPlanningState(root, project) {
  savePlanningState(root, project, { messages: [], proposedPlan: null, status: 'planning' });
}

/**
 * Translate an approved plan into a codeTask() execution.
 * This is the ONLY entry point that launches actual builder workers.
 *
 * Returns: { taskId }
 */
export async function approvePlanAndExecute(root, { project, allowClaude, log, onActivity }) {
  const state = getPlanningState(root, project);

  if (!state.proposedPlan) {
    throw new Error('No proposed plan found. Discuss requirements with the AI CTO first, then request a plan.');
  }

  const plan = state.proposedPlan;

  // Build execution instruction from the approved plan
  const checklist = Array.isArray(plan.checklist) ? plan.checklist.join('\n') : '';
  const instruction = [
    plan.goal,
    '',
    plan.approach || '',
    '',
    checklist
  ].filter(l => l !== undefined).join('\n').trim();

  // Dynamically import to avoid circular deps at module load time
  const { codeTask } = await import('./coding.mjs');

  const taskId = await codeTask(root, instruction, {
    project,
    allowClaude: Boolean(allowClaude),
    log: log || (() => {}),
    onActivity: onActivity || (() => {})
  });

  // Mark planning as executing
  state.status = 'executing';
  savePlanningState(root, project, state);

  return taskId;
}
