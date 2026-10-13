// Shared helpers for the PSP guard hooks. The guards only read the plan and the
// progress file; they never decide anything themselves (see docs/management-plan.md).
const fs = require('fs');
const path = require('path');

// Git Bash spells D:\x as /d/x; Node on Windows needs the drive letter.
const toNative = (p) => (process.platform === 'win32' ? p.replace(/^\/([a-z])\//i, '$1:/') : p);

const ROOT = toNative(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const PLAN = path.join(ROOT, 'docs', 'management-plan.md');
const PROGRESS = path.join(ROOT, 'docs', 'progress.md');

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const escape = (id) => id.replace('.', '\\.');

// Step IDs in the replanned roadmap (2026-10-07): M3.2 … M7.5, then C1 … C6
// (client side), then H1 … H8 (hardening). As a regex source, for reuse.
const STEP_ID = '(?:M\\d+\\.\\d+|[CH]\\d+)';

// The "Current step: **M1.1**" line in progress.md, else the first unticked box.
// Returns null when progress.md is missing, and { id: null } when every box is ticked.
function currentStep() {
  const text = read(PROGRESS);
  if (text === null) return null;
  const marked = text.match(new RegExp(`Current step:\\s*\\*{0,2}(${STEP_ID})`));
  const firstOpen = text.match(new RegExp(`- \\[ \\] (${STEP_ID})`));
  const id = marked ? marked[1] : firstOpen && firstOpen[1];
  if (!id) return { id: null, title: 'all tracked steps are complete' };
  const line = text.match(new RegExp(`- \\[[ xX]\\] ${escape(id)}\\s+(.+)`));
  return { id, title: line ? line[1].trim() : '' };
}

// The step's section of the plan: its "#### M1.1 …" heading up to the next heading.
function planSection(id) {
  const text = read(PLAN);
  if (!text || !id) return null;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^#### ${escape(id)}\\b`).test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^#{1,4} /.test(lines[end])) end++;
  return lines.slice(start, end).join('\n').trim();
}

// Build order as [stage, step]: M1–M7 are stages 1–7, C (client side) is 8,
// H (hardening) is 9. Compare stages to know what is unlocked.
const STAGE = { C: 8, H: 9 };
function stepNumber(id) {
  const m = /^M(\d+)\.(\d+)$/.exec(id || '');
  if (m) return [Number(m[1]), Number(m[2])];
  const ch = /^([CH])(\d+)$/.exec(id || '');
  return ch ? [STAGE[ch[1]], Number(ch[2])] : null;
}

// Repo-relative path with forward slashes; starts with ".." when outside the repo.
function relPath(file) {
  return path.relative(ROOT, path.resolve(ROOT, toNative(file))).split(path.sep).join('/');
}

// context goes to Claude, message is shown to the user. Neither blocks anything.
function emit(event, { context, message }) {
  const out = {};
  if (message) out.systemMessage = message;
  if (context) out.hookSpecificOutput = { hookEventName: event, additionalContext: context };
  process.stdout.write(JSON.stringify(out));
}

module.exports = { STEP_ID, STAGE, ROOT, toNative, readInput, read, currentStep, planSection, stepNumber, relPath, emit };
