# Natural Hand: install an update from the downloaded zip and publish it.
# Usage: right-click > Run with PowerShell (or: powershell -ExecutionPolicy Bypass -File update.ps1)
$zip  = Join-Path $env:USERPROFILE 'Downloads\natural-hand.zip'
$repo = $PSScriptRoot
$tmp  = Join-Path $env:TEMP 'natural-hand-update'
if (-not (Test-Path $zip)) { Write-Host "No natural-hand.zip in Downloads." -ForegroundColor Red; Read-Host 'Press Enter'; exit 1 }
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -Path $zip -DestinationPath $tmp -Force
Copy-Item -Path (Join-Path $tmp 'natural-hand\*') -Destination $repo -Recurse -Force
Set-Location $repo
git add -A
git commit -m "Update from natural-hand.zip"
git push
Remove-Item $zip
Write-Host "Done. GitHub Pages will update in 1 to 2 minutes." -ForegroundColor Green
Read-Host 'Press Enter to close'
