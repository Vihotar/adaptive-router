// Antigravity PreToolUse/PreInvocation hook. Only applies to this router's
// isolated review workspaces; normal Antigravity projects are unaffected.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.router');
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const payload = JSON.parse(input);
  const workspaces = payload.workspacePaths || [];
  const inside = workspaces.length > 0 && workspaces.every(p => {
    const relative = path.relative(root, path.resolve(p));
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  if (!inside) { console.log(JSON.stringify({ decision: 'deny', reason: 'Review workspace could not be verified.' })); process.exit(0); }
  const workspace = workspaces[0];
  const marker = path.join(workspace, 'reviewer-gate.jsonl');
  if (payload.toolCall) {
    const name = payload.toolCall.name;
    const decision = name === 'finish' ? 'allow' : 'deny';
    fs.appendFileSync(marker, JSON.stringify({ type: 'tool', name, decision }) + '\n');
    console.log(JSON.stringify({ decision, reason: 'Adaptive Router reviewer may only return a review. All action tools are blocked.' }));
  } else {
    fs.appendFileSync(marker, JSON.stringify({ type: 'active' }) + '\n');
    console.log('{}');
  }
} catch { console.log(JSON.stringify({ decision: 'deny', reason: 'Reviewer gate could not verify the request.' })); }
