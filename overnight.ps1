# Overnight run (2026-10-15): H1 -> H2, the hardening reviews that need no approval.
# Stops when the current step becomes H3 or later: the role matrix (H3) needs the user's
# approval first, H4-H7 depend on it, and H8 needs the user's sign-off.
# Waits and retries when the Claude usage limit is hit.
# Before sleeping: set Windows sleep to "Never" while plugged in, and keep this window open.
# Run from the PSP folder:  powershell -ExecutionPolicy Bypass -File .\overnight.ps1
$stopAt = '\*\*(H[3-8])'
$mods = ".claude\mods\psp-guards"
$maxSteps = 25
$maxLimitWaits = 14   # 14 x 30 minutes = 7 hours per step

$branch = "overnight/m4"
if (-not (git rev-parse --verify $branch 2>$null)) { git switch -c $branch } else { git switch $branch }

# Save anything left uncommitted so it does not mix with the next step.
if (git status --porcelain) { git add -A; git commit -m "pre-run: save uncommitted work" }

for ($i = 1; $i -le $maxSteps; $i++) {
  $before = (Select-String -Path docs\progress.md -Pattern "Current step:" | Select-Object -First 1).Line
  Write-Host "$(Get-Date -Format HH:mm) Run ${i}: $before"
  if ($before -match $stopAt) { Write-Host "Reached the stop point. Stopping."; break }

  $prompt = @"
Read CLAUDE.md, docs/management-plan.md (the current step's whole section, the Design bar in section 1, and the approved files list at the start of section 4) and docs/progress.md. Do the current step only, following the Development method in CLAUDE.md.
Quality bar: the UI must feel finished, in light AND dark mode, on a 360px phone first. Use the frontend-design skill if available and follow PSP-Engineering-Group-Preview.html. Match the look of the existing Products and Staff pages.
Nobody is awake to answer questions, and the user has approved this policy: where the plan is silent, choose the most reasonable option yourself and record it in docs/overnight-log.md as a Decision. Stop only if (a) you would need a file or folder outside the approved list and it is not a plain sibling of the step's own module, (b) documents disagree about a security rule, or (c) a check still fails after an honest effort to fix it. In those cases write the question to docs/overnight-log.md, leave docs/progress.md unchanged, and stop.
If Done when asks for a manual browser run or a user sign-off, the automated tests plus npm run check:responsive (and your own look at the saved screenshots) are accepted instead; say so in the log and continue.
Run the checks: node npm test; web npm test, npm run build, npm run lint. UI steps also need npm run check:responsive in web; add the new pages to it. Never skip a failing check.
When every Done when check passes: tick the step, set the next step as current (see 'Overnight order' in docs/progress.md), and write notes to docs/overnight-log.md (what changed, what was verified, decisions, guard warnings). Never start the next step. Never commit.
"@

  $attempt = 0
  do {
    $attempt++
    $out = claude -p $prompt --plugin-dir $mods --permission-mode acceptEdits --allowedTools "Bash(npm *)" "Bash(npx *)" "Bash(node *)" "Bash(git status)" "Bash(git diff *)" --max-turns 200 2>&1
    $code = $LASTEXITCODE
    $out | Out-File -Append -Encoding utf8 docs\overnight-run.log
    $limited = (($out -join "`n") -match "hit your (session|usage) limit")
    if ($limited) { Write-Host "$(Get-Date -Format HH:mm) Usage limit hit. Waiting 30 minutes (wait $attempt of $maxLimitWaits)."; Start-Sleep -Seconds 1800 }
  } while ($limited -and $attempt -lt $maxLimitWaits)
  if ($limited) { Write-Host "Still limited after waiting. Stopping."; break }
  if ($code -ne 0) { Write-Host "Run $i failed"; break }

  $after = (Select-String -Path docs\progress.md -Pattern "Current step:" | Select-Object -First 1).Line
  if ($after -eq $before) { Write-Host "Step did not advance (see docs/overnight-log.md). Stopping."; break }

  git add -A
  git commit -m "overnight: $before"
  git push origin $branch 2>$null
}

git push -u origin $branch
Write-Host "$(Get-Date -Format HH:mm) Done. Read docs/overnight-log.md."
