for ($i = 1; $i -le 15; $i++) {
  $step = (Select-String -Path docs\progress.md -Pattern "Current step:" | Select-Object -First 1).Line
  Write-Host "Run ${i}: $step"
  if ($step -match "M[3-9]") { Write-Host "M1 and M2 done. Stopping."; break }
  $prompt = "Read CLAUDE.md, docs/management-plan.md and docs/progress.md. Do the current step only. Run the checks. Mark it done in docs/progress.md, set the next step as current, write notes to docs/overnight-log.md, then stop."
  claude -p $prompt --permission-mode acceptEdits --allowedTools "Bash(npm *)" "Bash(npx *)" "Bash(node *)" "Bash(git status)" "Bash(git diff *)" --max-turns 60 2>&1 | Out-File -Append -Encoding utf8 docs\overnight-run.log
  if ($LASTEXITCODE -ne 0) { Write-Host "Run $i failed"; break }
  git add -A
  git commit -m "overnight: $step"
}
