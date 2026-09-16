import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { createTask, demoInstruction, taskDir, decide } from './src/router.mjs';
import { executables, assertSubscriptionAuth } from './src/workers.mjs';
import { read } from './src/storage.mjs';
import { codeTask, codingInstruction } from './src/coding.mjs';
import { platformModelTiers } from './src/smart-router.mjs';
import { startDashboardServer } from './src/server.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const [command, ...args] = process.argv.slice(2);
function show(task) {
  console.log(`\n${task.id}: ${task.status}`);
  if (task.routingLog?.length) {
    console.log('\nSmart Routing decisions:');
    for (const r of task.routingLog) {
      console.log(`  - ${r.role === 'build' ? 'Builder' : 'Reviewer'} (${r.worker}): ${r.model} [effort: ${r.effort}] (${r.tier}) - ${r.reason}`);
    }
  }
  if (task.tokenUsage?.summaryText) {
    console.log(`\nToken Usage: ${task.tokenUsage.summaryText}`);
    if (task.tokenUsage.builder?.totalTokens != null) {
      console.log(`  - Builder (${task.tokenUsage.builder.platform || 'unknown'}): ${task.tokenUsage.builder.totalTokens.toLocaleString()} tokens [${task.tokenUsage.builder.accuracy}]`);
    }
    if (task.tokenUsage.reviewer?.totalTokens != null) {
      console.log(`  - Reviewer (${task.tokenUsage.reviewer.platform || 'unknown'}): ${task.tokenUsage.reviewer.totalTokens.toLocaleString()} tokens [${task.tokenUsage.reviewer.accuracy}]`);
    }
  }
  if (task.status === 'awaiting_approval') {
    if (task.websiteUrl) console.log(`Tested website:  ${task.websiteUrl}`);
    if (task.testedArtifact) console.log(`Tested artifact: ${task.testedArtifact}`);
    if (task.approvalReport) console.log(`Approval report: ${task.approvalReport}`);
    if (task.testDigest) console.log(`Digest:          ${task.testDigest}`);
  }
  if (task.plan?.questions?.length) console.log(task.plan.questions.join('\n') + '\nSubmit a new task with these details.');
  if (task.status === 'needs_action_approval') console.log(task.plan.approvalActions.join('\n') + '\n' + task.note);
  if (task.status === 'needs_human_input') console.log(task.review?.issues?.join('\n') || task.note || '');
  if (task.error) console.log(task.error);
  if (task.status === 'failed') process.exitCode = 1;
}
try {
  if (command === 'code' || command === 'code-demo' || command === 'resume-code') {
    const unavailableBuilders = [];
    const filteredArgs = [];
    let allowClaude = false;
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '--unavailable-builder' || args[i] === '--unavailable') && args[i + 1]) {
        unavailableBuilders.push(args[++i]);
      } else if (args[i] === '--allow-claude') {
        allowClaude = true;
      } else {
        filteredArgs.push(args[i]);
      }
    }
    let instruction = filteredArgs.join(' ');
    if (command === 'code' && !instruction) { const rl = createInterface({ input: process.stdin, output: process.stdout }); instruction = await rl.question('What should change on the test website? '); rl.close(); }
    const confirmClaudeUse = async (promptMsg) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`${promptMsg} `);
      rl.close();
      return /^(y|yes)$/i.test(answer.trim());
    };
    show(await codeTask(root, command === 'code-demo' ? codingInstruction : instruction, {
      project: command === 'code-demo' ? 'test-site' : undefined,
      injectFault: command === 'code-demo',
      resume: command === 'resume-code' ? filteredArgs[0] : undefined,
      unavailableBuilders,
      allowClaude,
      confirmClaudeUse
    }));
  } else if (!command || command === 'ask') {
    let instruction = args.join(' ');
    if (!instruction) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      instruction = await rl.question('What would you like done? ');
      rl.close();
    }
    show(await codeTask(root, instruction, { allowClaude: false }));
  } else if (command === 'demo') {
    console.log('Live dummy test. The first draft total is deliberately changed to 999 to test review and correction.');
    show(await codeTask(root, codingInstruction, { project: 'test-site', injectFault: true, allowClaude: false }));
  } else if (command === 'claude-login') {
    const paths = executables(root);
    if (!paths.claude) throw Error('Claude Code could not be found in Claude Desktop installation or PATH.');
    console.log(`Starting Claude Code sign-in via ${paths.claude}...`);
    console.log('Follow the browser prompts to sign in with your Claude Pro account and paste the code below.\n');
    const res = spawnSync(paths.claude, ['auth', 'login', '--claudeai'], { stdio: 'inherit' });
    if (res.status === 0) {
      console.log('\nClaude Code sign-in complete! Run `node router.mjs doctor` to verify.');
    } else {
      process.exitCode = res.status || 1;
    }
  } else if (command === 'doctor') {
    const paths = executables(root);
    for (const [name, exe] of Object.entries(paths)) {
      const result = exe && spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      console.log(`${name}: ${result?.status === 0 ? result.stdout.trim() : 'not available'}${exe ? '\n  ' + exe : ''}`);
    }
    console.log(`Node.js: ${process.version}`);
    console.log(spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).stdout?.trim());
    assertSubscriptionAuth(paths);
    console.log('Codex: existing ChatGPT sign-in. Antigravity: account mode; live availability checked when used.');
    if (paths.claude) {
      const r = spawnSync(paths.claude, ['auth', 'status'], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
      let auth; try { auth = JSON.parse(r.stdout); } catch {}
      if (r.status === 0 && auth?.loggedIn && auth.authMethod === 'claude.ai') {
        console.log(`Claude Code: signed in with Claude Pro (${auth.email || 'claude.ai'}).`);
      } else {
        console.log('Claude Code: installed from Claude Desktop. CLI login required: run `node router.mjs claude-login`.');
      }
    } else {
      console.log('Claude Code: not found.');
    }
    const cfg = read(path.join(root, 'workers.json'));
    const isReserve = cfg.claudeReserve !== false;
    console.log(`Claude Reserve Mode: ${isReserve ? 'ON (Claude Pro quota preserved for Claude Cowork)' : 'OFF (Claude Code available for normal routing and failover)'}`);
    console.log('\nConfigured Model Tiers:');
    for (const [p, tiers] of Object.entries(platformModelTiers)) {
      console.log(`  ${p}:`);
      console.log(`    Tier 1 (Fast/Light):      ${tiers.tier1.model} [effort: ${tiers.tier1.effort}] - ${tiers.tier1.description}`);
      console.log(`    Tier 2 (Standard/Medium):  ${tiers.tier2.model} [effort: ${tiers.tier2.effort}] - ${tiers.tier2.description}`);
      console.log(`    Tier 3 (Flagship/Heavy):   ${tiers.tier3.model} [effort: ${tiers.tier3.effort}] - ${tiers.tier3.description}`);
    }
  } else if (command === 'claude-reserve') {
    const action = args[0]?.toLowerCase();
    const configPath = path.join(root, 'workers.json');
    const cfg = read(configPath);
    if (action === 'on') {
      cfg.claudeReserve = true;
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
      console.log('Claude Reserve Mode: ON (Claude Pro quota preserved for Claude Cowork)');
    } else if (action === 'off') {
      cfg.claudeReserve = false;
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
      console.log('Claude Reserve Mode: OFF (Claude Code available for normal routing and failover)');
    } else if (action === 'status' || !action) {
      const isReserve = cfg.claudeReserve !== false;
      console.log(`Claude Reserve Mode: ${isReserve ? 'ON' : 'OFF'}`);
      console.log(isReserve
        ? 'Claude Pro quota is preserved for Claude Cowork desktop/browser use. Claude Code will not be used silently.'
        : 'Claude Code is active as a standard candidate and failover option.');
    } else {
      console.log('Use: node router.mjs claude-reserve [on|off|status]');
    }
  } else if (command === 'list') {
    const tasks = path.join(root, '.router', 'tasks');
    if (fs.existsSync(tasks)) for (const id of fs.readdirSync(tasks).sort()) {
      const t = read(path.join(taskDir(root, id), 'task.json'));
      console.log(`${id}  ${t.status}  ${t.instruction.slice(0, 85)}`);
    }
  } else if (command === 'status') {
    show(read(path.join(taskDir(root, args[0]), 'task.json')));
  } else if (command === 'approve' || command === 'reject') {
    show(await decide(root, args[0], command === 'approve' ? 'approved' : 'rejected', args.slice(1).join(' ')));
    console.log('Local draft decision recorded. No external action was performed.');
  } else if (command === 'unlock') {
    const file = path.join(root, '.router', 'router.lock');
    const lock = read(file);
    let alive = true;
    try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw Error('Router process is still running; lock retained.');
    fs.unlinkSync(file);
    console.log('Removed interrupted-process lock. Previous tasks are retained; submit a new task to retry.');
  } else if (command === 'dashboard' || command === 'ui') {
    let port = 3210;
    let open = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--port' && args[i + 1]) port = parseInt(args[++i], 10) || 3210;
      if (args[i] === '--open') open = true;
    }
    await startDashboardServer(root, { port, openBrowser: open });
  } else {
    console.log('Use: node router.mjs [dashboard [--port 3210] [--open] | code "instruction" [--unavailable-builder codex] [--allow-claude] | code-demo | resume-code ID | claude-reserve [on|off|status] | ask "instruction" | demo | doctor | claude-login | list | status ID | approve ID | reject ID "reason" | unlock]');
    process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
