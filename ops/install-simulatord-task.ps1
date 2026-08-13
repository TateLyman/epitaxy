<#
.SYNOPSIS
  Registers the WSL simulation daemon to start at logon and stay started.

.DESCRIPTION
  §12 — systemd inside WSL is not sufficient on its own. WSL terminates a
  distribution's processes when its last session ends, and nothing starts the
  distribution at logon, so a daemon supervised only from the inside is
  supervised only while something else is already keeping it alive. The Windows
  side has to be what starts it.

  This registers ops/simulatord.ps1, which holds a FOREGROUND WSL session for as
  long as the daemon should live and restarts it with bounded, increasing
  backoff. Task Scheduler restarts the supervisor itself if the supervisor dies.

  What this deliberately does NOT do:

    - It does not run at boot as SYSTEM. The daemon reads a token from the
      user's profile and runs a user's WSL distribution; a SYSTEM task would
      need neither and would be a service with more privilege than the thing it
      supervises.
    - It does not start canary or live, and the daemon it launches holds no key
      and has no signing or submission endpoint. Nothing here can spend.

.EXAMPLE
  pwsh -File ops/install-simulatord-task.ps1
  pwsh -File ops/install-simulatord-task.ps1 -Remove
#>

[CmdletBinding()]
param(
  [string]$TaskName = 'epitaxy-simulatord',
  [string]$Distro = 'Ubuntu-24.04',
  [string]$RepoPath = '$HOME/epitaxy',
  [int]$Port = 8787,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "removed scheduled task '$TaskName'"
  } else {
    Write-Host "no scheduled task named '$TaskName'"
  }
  return
}

$supervisor = Join-Path $PSScriptRoot 'simulatord.ps1'
if (-not (Test-Path $supervisor)) {
  throw "supervisor not found at $supervisor"
}

# pwsh if it is present, Windows PowerShell otherwise. Resolved now rather than
# assumed, so a machine without pwsh gets a task that runs instead of a task
# that fails silently at logon.
$shell = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
if (-not $shell) { $shell = (Get-Command powershell).Source }

$argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$supervisor`" " +
            "-Distro `"$Distro`" -RepoPath `"$RepoPath`" -Port $Port"

$action = New-ScheduledTaskAction -Execute $shell -Argument $argument
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# The supervisor is a long-lived loop, so no execution time limit and no
# stop-on-idle. RestartCount covers the supervisor itself dying; the supervisor
# covers the daemon dying.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description `
  'Holds a foreground WSL session running the epitaxy simulation daemon on 127.0.0.1. Holds no key and cannot sign or submit.' | Out-Null

Write-Host "registered '$TaskName' to run $shell at logon"
Write-Host "start it now with:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "the engine health-checks http://127.0.0.1:$Port/v1/health and refuses fills that need an unavailable simulator"
