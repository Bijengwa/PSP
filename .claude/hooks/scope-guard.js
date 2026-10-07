// Scope Guard (warn only): before a file is written, flags changes that look
// outside the rules in CLAUDE.md and docs/management-plan.md. It never blocks.
const fs = require('fs');
const path = require('path');
const { STEP_ID, STAGE, ROOT, toNative, readInput, read, currentStep, stepNumber, relPath, emit } = require('./lib');

const input = readInput();
const tool = input.tool_input || {};
const file = tool.file_path;
const rel = file ? relPath(file) : '..';
const warnings = [];

if (!rel.startsWith('..') && !rel.startsWith('.claude/')) {
  const edits = tool.edits || [{ old_string: tool.old_string, new_string: tool.new_string, replace_all: tool.replace_all }];
  const added = [tool.content, ...edits.map((e) => e.new_string)].filter((s) => typeof s === 'string').join('\n');
  const step = currentStep();
  // Stage of the current step (M5.2 -> 5, C3 -> 8, H1 -> 9). Unknown: treat as stage 0.
  const stage = (step && stepNumber(step.id)?.[0]) ?? 0;
  const allDone = Boolean(step && !step.id);
  const isManagement = /^web\/src\/management\//.test(rel);

  // 1. Browser storage: the theme anywhere; the shop cart (product ids and
  //    quantities) in the public shop from stage C. Nothing else, never auth data.
  if (/\.[jt]sx?$/.test(rel)) {
    const cartAllowed = !isManagement && (stage >= STAGE.C || allDone);
    const line = added
      .split('\n')
      .find((l) => /\b(localStorage|sessionStorage|indexedDB)\b/.test(l) && !/theme/i.test(l) && !(cartAllowed && /cart/i.test(l)));
    if (line) {
      warnings.push(`browser storage used for something other than the theme${isManagement ? '' : ' or the shop cart'}: "${line.trim().slice(0, 120)}". Auth data must never be stored in the browser; who is logged in comes from GET /api/auth/me.`);
    }
  }

  // 2. Business modules open stage by stage (docs/management-plan.md §1 Scope):
  //    Products from M5, Customers from M6, Orders from M7, the public shop API
  //    from C. Inventory, Reports and real Notifications stay locked until after H8.
  const MODULES = [
    { name: 'Products', file: /products?/, api: /products/, opensAt: 5, label: 'M5' },
    { name: 'Customers', file: /customers?/, api: /customers/, opensAt: 6, label: 'M6' },
    { name: 'Orders', file: /orders?/, api: /orders/, opensAt: 7, label: 'M7' },
    { name: 'Inventory', file: /inventory/, api: /inventory/, opensAt: Infinity, label: 'its own approved plan section after H8' },
    { name: 'Reports', file: /reports?/, api: /reports/, opensAt: Infinity, label: 'its own approved plan section after H8' },
    { name: 'Notifications', file: /notifications?/, api: /notifications/, opensAt: Infinity, label: 'its own approved plan section after H8' },
  ];
  const hasLogic = /apiRequest|fetch\(|useState|useEffect|<form|<table|knex|db\(|router\.|createTable/.test(added);
  for (const m of MODULES) {
    if (stage >= m.opensAt) continue;
    const isModuleFile = new RegExp(`^(web|node)/src/.*\\b${m.file.source}\\b`, 'i').test(rel);
    if (isModuleFile && (hasLogic || rel.startsWith('node/'))) {
      warnings.push(`this looks like real ${m.name} functionality, which opens at ${m.label}. Until then its page is a placeholder showing only its title.`);
    }
    if (new RegExp(`/api/(office/|shop/)?${m.api.source}\\b`).test(added)) {
      warnings.push(`adds an API route for ${m.name}, which opens at ${m.label}.`);
    }
  }
  if (stage < STAGE.C && !allDone && /\/api\/shop\b/.test(added)) {
    warnings.push('adds a public shop API route (/api/shop). The client side opens at C1, after M7.');
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
    const ticked = (text) => new Set([...text.matchAll(new RegExp(`- \\[[xX]\\] (${STEP_ID})`, 'g'))].map((m) => m[1]));
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
