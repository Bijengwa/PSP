$stopAt = '\*\*(M[5-9]|C\d|H\d)'   # stop before M5; widen this to go further
$mods = ".claude\mods\psp-guards"

for ($i = 1; $i -le 10; $i++) {
  $before = (Select-String -Path docs\progress.md -Pattern "Current step:" | Select-Object -First 1).Line
  Write-Host "Run ${i}: $before"
  if ($before -match $stopAt) { Write-Host "Reached the stop point. Stopping."; break }

  $prompt = @"
Read CLAUDE.md, docs/management-plan.md (the current step) and docs/progress.md. Do the current step only, following the Development method in CLAUDE.md.
Nobody is awake to answer questions. If a [Progress Guard], [Scope Guard] or [Collision Guard] warning shows the change is outside the step, or you need a decision (new file or folder, a document that disagrees with another, a check you cannot run), do not guess: write the question to docs/overnight-log.md, leave docs/progress.md unchanged, and stop.
Run the checks (node: npm test; web: npm run build and npm run lint). UI steps also need the 360px, 768px and desktop check; if you cannot run it, do not tick the step: log that and stop.
Only if every Done when check passes: tick the step, set the next step as current, and write notes to docs/overnight-log.md (what changed, what was verified, guard warnings). Never start the next step. Never commit.
"@

  claude -p $prompt --plugin-dir $mods --permission-mode acceptEdits --allowedTools "Bash(npm *)" "Bash(npx *)" "Bash(node *)" "Bash(git status)" "Bash(git diff *)" --max-turns 80 2>&1 | Out-File -Append -Encoding utf8 docs\overnight-run.log
  if ($LASTEXITCODE -ne 0) { Write-Host "Run $i failed"; break }

  $after = (Select-String -Path docs\progress.md -Pattern "Current step:" | Select-Object -First 1).Line
  if ($after -eq $before) { Write-Host "Step did not advance (see docs/overnight-log.md). Stopping."; break }

  git add -A
  git commit -m "overnight: $before"
}
