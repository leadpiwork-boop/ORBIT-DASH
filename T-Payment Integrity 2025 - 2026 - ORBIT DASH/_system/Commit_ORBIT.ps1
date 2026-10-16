param(
  [Parameter(Mandatory=$true)][string]$Message
)
$dash = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dash
python orbit_vcs.py commit $Message
Write-Host ""
python orbit_vcs.py log
