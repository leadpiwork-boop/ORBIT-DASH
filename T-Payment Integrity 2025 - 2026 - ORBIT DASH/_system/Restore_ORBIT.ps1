param(
  [string]$SnapshotId,
  [string[]]$Files
)
$dash = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dash

Write-Host "Recent snapshots:" -ForegroundColor Cyan
python orbit_vcs.py log
Write-Host ""

$pyArgs = @()
if ($SnapshotId) { $pyArgs += $SnapshotId }
if ($Files) { $pyArgs += $Files }
python orbit_vcs.py restore @pyArgs
