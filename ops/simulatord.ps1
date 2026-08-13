<#
.SYNOPSIS
  Keeps the WSL simulation daemon alive from Windows.

.DESCRIPTION
  WSL terminates a distribution's processes when its last session ends, so a
  daemon started with `wsl -e ... &` dies the moment the launching command
  returns. That is not a bug to work around with nohup — it is how WSL manages
  lifetime, and the fix is to hold a FOREGROUND session open for as long as the
  daemon should live.

  systemd inside WSL is not sufficient on its own for the same reason: it only
  runs while the distribution is running, and nothing starts the distribution at
  login. This script is what starts it.

  Restart backoff is bounded and increasing. A daemon that cannot start —
  missing binary, wrong platform, port in use — must not be restarted in a tight
  loop; it must become visible in the log and stay down long enough for someone
  to notice.

.NOTES
  Registers with Task Scheduler via ops/install-simulatord-task.ps1.
  Never starts canary or live. The daemon it launches holds no key.
#>

[CmdletBinding()]
param(
  [string]$Distro = 'Ubuntu-24.04',
  [string]$RepoPath = '$HOME/epitaxy',
  [int]$Port = 8787,
  # Where DEVELOPMENT_JIT fetches mainnet state from. Without it the daemon
  # refuses every JIT job immediately, which is correct but useless: there is
  # nowhere to fetch from. Read-only; the daemon holds no key and cannot submit.
  [string]$RemoteRpc = 'https://api.mainnet-beta.solana.com',
  [string]$LogDir = "$env:USERPROFILE\epitaxy-logs"
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$log = Join-Path $LogDir 'simulatord.log'

# The local auth token. Loopback binding stops the LAN; this stops any other
# process on this machine driving the simulator. Generated once and persisted
# with user-only permissions, never committed.
$tokenFile = Join-Path $env:USERPROFILE '.epitaxy-simulatord-token'
if (-not (Test-Path $tokenFile)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = [Convert]::ToBase64String($bytes)
  Set-Content -Path $tokenFile -Value $token -NoNewline
  # Owner-only ACL: the file is the credential.
  $acl = Get-Acl $tokenFile
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $env:USERNAME, 'FullControl', 'Allow')
  $acl.SetAccessRule($rule)
  Set-Acl -Path $tokenFile -AclObject $acl
  Write-Host "generated a new simulator token at $tokenFile"
}
$token = (Get-Content -Path $tokenFile -Raw).Trim()

$attempt = 0
while ($true) {
  $attempt++
  $stamp = (Get-Date).ToString('o')
  Add-Content -Path $log -Value "[$stamp] starting simulatord (attempt $attempt)"

  # Clear any daemon left over from a previous supervisor.
  #
  # Stopping the scheduled task kills the Windows-side supervisor and the
  # wsl.exe child, but does NOT reliably reap the Linux process it started. The
  # replacement then hits EADDRINUSE, exits, gets restarted, hits it again --
  # while the STALE daemon keeps answering on the port. Everything looks alive
  # and every request is served by the old code, which is a genuinely horrible
  # thing to debug: the fix you just deployed simply has no effect.
  $reap = "pkill -f 'apps/simulatord/src/main.ts' 2>/dev/null; sleep 1; exit 0"
  & wsl.exe -d $Distro -e bash -lc $reap 2>&1 | Out-Null

  # FOREGROUND. This process holds the WSL session open; when it exits, the
  # daemon has exited, and we restart it.
  $cmd = "cd $RepoPath && SIMULATORD_TOKEN='$token' SIMULATORD_PORT=$Port SIMULATORD_REMOTE_RPC='$RemoteRpc' exec npx tsx apps/simulatord/src/main.ts"
  & wsl.exe -d $Distro -e bash -lc $cmd 2>&1 | Tee-Object -FilePath $log -Append

  $stamp = (Get-Date).ToString('o')
  Add-Content -Path $log -Value "[$stamp] simulatord exited"

  # Bounded, increasing backoff, capped at a minute. A daemon that cannot start
  # should be visible in the log rather than hammering the machine.
  $delay = [Math]::Min(60, [Math]::Pow(2, [Math]::Min($attempt, 6)))
  Start-Sleep -Seconds $delay
}
