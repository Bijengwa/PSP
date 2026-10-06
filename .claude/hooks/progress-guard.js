// Progress Guard: tells Claude which roadmap step is current, at session start
// (with the step's full plan section) and briefly on every prompt.
const { readInput, currentStep, planSection, emit } = require('./lib');

const input = readInput();
const event = input.hook_event_name || 'SessionStart';
const step = currentStep();

if (!step) {
  emit(event, { context: '[Progress Guard] docs/progress.md is missing, so the current management step is unknown. Ask the user before starting roadmap work.' });
} else if (!step.id) {
  emit(event, { context: `[Progress Guard] docs/progress.md: ${step.title}. M7+ needs its own approved plan section before any work.` });
} else if (event === 'SessionStart') {
  const section = planSection(step.id) || '(section not found in docs/management-plan.md)';
  emit(event, {
    context:
      `[Progress Guard] Management roadmap: docs/management-plan.md. Current step: ${step.id} ${step.title}.\n` +
      'Work only on this step and stop when it is done; never continue to the next step automatically.\n\n' +
      section,
    message: `Progress Guard: current step ${step.id} ${step.title}`,
  });
} else {
  const prompt = String(input.prompt || '');
  const mentioned = [...new Set(prompt.match(/\bM\d+\.\d+\b/g) || [])];
  const others = mentioned.filter((id) => id !== step.id);
  let context = `[Progress Guard] Current step: ${step.id} ${step.title}.`;
  if (others.length) {
    context += ` The prompt mentions ${others.join(', ')}, which is not the current step. Confirm with the user before working on it, and never implement two steps at once.`;
  }
  emit(event, {
    context,
    message: others.length ? `Progress Guard: current step is ${step.id}, prompt mentions ${others.join(', ')}` : undefined,
  });
}
