// Scope Guard (warn only): before a file is written, flags changes that look
// outside the rules in CLAUDE.md and docs/management-plan.md. It never blocks.
const fs = require('fs');
const path = require('path');
const { ROOT, toNative, readInput, read, currentStep, stepNumber, relPath, emit } = require('./lib');

const input = readInput();
const tool = input.tool_input || {};
const file = tool.file_path;
const rel = file ? relPath(file) : '..';
const warnings = [];

if (!rel.startsWith('..') && !rel.startsWith('.claude/')) {
  const edits = tool.edits || [{ old_string: tool.old_string, new_string: tool.new_string, replace_all: tool.replace_all }];
  const added = [tool.content, ...edits.map((e) => e.new_string)].filter((s) => typeof s === 'string').join('\n');
  const step = currentStep();
  const n = step && stepNumber(step.id);
  const modulesLocked = !step || (n && n[0] < 7);

  // 1. Browser storage: only the theme preference may live there.
  if (/\.[jt]sx?$/.test(rel)) {
    const line = added.split('\n').find((l) => /\b(localStorage|sessionStorage|indexedDB)\b/.test(l) && !/theme/i.test(l));
    if (line) {
      warnings.push(`browser storage used for something other than the theme: "${line.trim().slice(0, 120)}". Auth data must never be stored in the browser; who is logged in comes from GET /api/auth/me.`);
    }
  }

  // 2. Business modules (M7+) stay title-only placeholders until M6.4 is signed off.
  if (modulesLocked) {
    const isModuleFile = /^(web|node)\/src\/.*\b(products?|inventory|orders?|customers?|reports?|notifications?)\b/i.test(rel);
    const hasLogic = /apiRequest|fetch\(|useState|useEffect|<form|<table|knex|db\(|router\.|createTable/.test(added);
    if (isModuleFile && (hasLogic || rel.startsWith('node/'))) {
      warnings.push('this looks like real Products/Inventory/Orders/Customers/Reports/Notifications functionality. Before M7 these are placeholder pages showing only their title.');
    }
    if (/\/api\/(office\/)?(products|inventory|orders|customers|reports)\b/.test(added)) {
      warnings.push('adds an API route for an M7+ business module, which is locked until M6.4 is signed off.');
    }
  }

  // 3. progress.md: tick only the step just finished, one at a time.
  if (rel === 'docs/progress.md') {
    const before = read(path.join(ROOT, rel)) || '';
    let after = before;
    if (typeof tool.content === 'string') after = tool.content;
    else {
      for (const e of edits) {
        if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') continue;
        after = e.replace_all ? after.split(e.old_string).join(e.new_string) : after.replace(e.old_string, () => e.new_string);
      }
    }
    const ticked = (text) => new Set([...text.matchAll(/- \[[xX]\] (M\d+\.\d+)/g)].map((m) => m[1]));
    const was = ticked(before);
    const now = ticked(after);
    const newly = [...now].filter((id) => !was.has(id));
    const unticked = [...was].filter((id) => !now.has(id));
    if (newly.length > 1) warnings.push(`ticks ${newly.length} steps at once (${newly.join(', ')}). Tick only the step just finished.`);
    if (newly.length && step && step.id && !newly.includes(step.id)) warnings.push(`ticks ${newly.join(', ')}, but the current step is ${step.id}.`);
    if (unticked.length) warnings.push(`unticks ${unticked.join(', ')}. Confirm this with the user.`);
    if (newly.length) warnings.push(`before ticking, confirm every "Done when" check for ${newly.join(', ')} actually passed.`);
  }

  // 4. Dependencies: install only when necessary, and say why.
  if (/(^|\/)package\.json$/.test(rel)) {
    warnings.push('package.json is changing. CLAUDE.md: add dependencies only when necessary, and explain why to the user.');
  }

  // 5. File layout belongs to the user.
  if (!fs.existsSync(path.dirname(path.resolve(ROOT, toNative(file))))) {
    warnings.push(`creates a new folder (${path.posix.dirname(rel)}). The user decides the file layout: propose the path and ask first.`);
  }
}

if (warnings.length) {
  emit('PreToolUse', {
    context:
      `[Scope Guard] ${rel}:\n- ${warnings.join('\n- ')}\n` +
      'This is a warning, not a block. If the change is intended and inside the current step, continue and mention it in your report; otherwise stop and ask the user.',
    message: `Scope Guard: ${warnings.length} warning(s) on ${rel}`,
  });
}
