# Overnight run, shop-first track (2026-10-14): M5.6 -> C2 -> C3 -> C4 -> C5 -> C6 -> C7.
# Stops when the current step becomes M4.x, M6.x, M7.x or H (set at the end of C7).
# Run from the PSP folder:  powershell -ExecutionPolicy Bypass -File .\overnight.ps1
$stopAt = '\*\*(M4|M6|M7|H)'
$mods = ".claude\mods\psp-guards"

# Work on its own branch so main and the older overnight branches stay untouched.
$branch = "overnight/shop"
if (-not (git rev-parse --verify $branch 2>$null)) { git switch -c $branch } else { git switch $branch }

for ($i = 1; $i -le 10; $i++) {
  $before = (Select-String -Path docs\progress.md -Pattern "Current step:" | Select-Object -First 1).Line
  Write-Host "Run ${i}: $before"
  if ($before -match $stopAt) { Write-Host "Reached the stop point. Stopping."; break }

  $prompt = @"
Read CLAUDE.md, docs/management-plan.md (the current step, the Design bar in section 1, and the approved files list at the start of section 4) and docs/progress.md. Do the current step only, following the Development method in CLAUDE.md.
Quality bar: the UI must feel finished, in light AND dark mode, on a 360px phone first. Use the frontend-design skill if available and follow PSP-Engineering-Group-Preview.html.
Nobody is awake to answer questions. The new files and the playwright-core dev dependency listed in the plan are already approved. If a [Progress Guard], [Scope Guard] or [Collision Guard] warning shows the change is outside the step, or you need a decision (a file or folder not in the approved list, documents that disagree, a check you cannot run), do not guess: write the question to docs/overnight-log.md, leave docs/progress.md unchanged, and stop.
Run the checks (node: npm test; web: npm test, npm run build, npm run lint). UI steps also need the responsive check: after M5.6 exists, run npm run check:responsive in web and look at the screenshots it saves in docs/screenshots. If the check cannot run, do not tick the step: log that and stop.
Only if every Done when check passes: tick the step (M5.6 ticks M5.1 to M5.6 together), set the next step as current, and write notes to docs/overnight-log.md (what changed, what was verified, guard warnings). Never start the next step. Never commit.
"@

  claude -p $prompt --plugin-dir $mods --permission-mode acceptEdits --allowedTools "Bash(npm *)" "Bash(npx *)" "Bash(node *)" "Bash(git status)" "Bash(git diff *)" --max-turns 150 2>&1 | Out-File -Append -Encoding utf8 docs\overnight-run.log
  if ($LASTEXITCODE -ne 0) { Write-Host "Run $i failed"; break }

  $after = (Select-String -Path docs\progress.md -Pattern "Current step:" | Select-Object -First 1).Line
  if ($after -eq $before) { Write-Host "Step did not advance (see docs/overnight-log.md). Stopping."; break }

  git add -A
  git commit -m "overnight: $before"
}

git push -u origin $branch
