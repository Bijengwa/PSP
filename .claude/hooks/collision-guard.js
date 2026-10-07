// Collision Guard: records which Claude session last edited each file, and warns
// when a session is about to edit a file another session touched recently.
// Usage: collision-guard.js check   (PreToolUse)
//        collision-guard.js record  (PostToolUse)
const fs = require('fs');
const path = require('path');
const { ROOT, readInput, relPath, emit } = require('./lib');

const WINDOW_MS = 30 * 60 * 1000; // warn about edits from the last 30 minutes
const KEEP_MS = 24 * 60 * 60 * 1000; // forget entries after a day
const STATE_DIR = path.join(ROOT, '.claude', 'state');
const STATE = path.join(STATE_DIR, 'touched.json');

const mode = process.argv[2];
const input = readInput();
const file = input.tool_input && input.tool_input.file_path;
const session = input.session_id;
const rel = file ? relPath(file) : '..';

if (session && !rel.startsWith('..') && !rel.startsWith('.claude/state/')) {
  const key = process.platform === 'win32' ? rel.toLowerCase() : rel;
  const now = Date.now();
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    // no record yet
  }

  if (mode === 'record') {
    for (const [k, v] of Object.entries(state)) if (now - v.at > KEEP_MS) delete state[k];
    state[key] = { session, at: now };
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const ignore = path.join(STATE_DIR, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    const tmp = `${STATE}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE);
  } else {
    const last = state[key];
    if (last && last.session !== session && now - last.at < WINDOW_MS) {
      const mins = Math.max(1, Math.round((now - last.at) / 60000));
      emit('PreToolUse', {
        context: `[Collision Guard] ${rel} was edited ${mins} min ago by another Claude session (${last.session.slice(0, 8)}). Re-read the file before editing, and check with the user so the two sessions do not overwrite each other.`,
        message: `Collision Guard: ${rel} was edited ${mins} min ago by another session`,
      });
    }
  }
}
