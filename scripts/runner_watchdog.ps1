<#
    Heals a wedged self-hosted runner.

    Failure mode this exists for (first seen 2026-08-03, cost ~22h of no scrapes):
    the machine's network dropped mid-scrape, GitHub failed the job server-side,
    but Runner.Worker.exe never got the message and kept running. The listener
    reported status=Busy for as long as that worker lived, so it accepted no new
    jobs - and because scrape.yml queues rather than cancels (cancel-in-progress:
    false, deliberate), every later dispatch piled up behind a run that could
    never finish. From the UI it looked like nothing happened at all.

    This CANNOT live as a step inside scrape.yml: a workflow step only runs once
    a job has been dispatched to the runner, and the whole problem is that no job
    can be dispatched. It has to run outside the Actions queue - hence a Windows
    scheduled task. Install (elevated, one time):

      $ps = 'C:\Users\jtsen\Desktop\Claude\price-comparison\scripts\runner_watchdog.ps1'
      $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ps`""
      $t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30)
      Register-ScheduledTask -TaskName 'PriceWatch runner watchdog' -Action $a -Trigger $t -User SYSTEM -RunLevel Highest -Force

    Decision logic is self-checked by runner_watchdog_selfcheck.ps1 (in CI).
#>
[CmdletBinding()]
param(
    # ponytail: age alone decides "wedged" - we don't cross-check the GitHub API
    # for whether the job is really dead, because that needs a token in a
    # scheduled task. CEILING: this number MUST stay above the largest
    # timeout-minutes in scrape.yml (currently 90 for `scrape`), or the watchdog
    # will shoot a job that is merely slow. Raise it if that timeout ever grows.
    # Upgrade path if 3h of downtime is ever too much: query
    # /actions/runs/<id>/jobs and recover the moment the job reads completed.
    [double] $MaxAgeHours = 3,

    # Minutes to wait after GitHub has declared the job dead before clearing a
    # worker that is still alive. Grace for a worker that is merely slow to exit.
    [double] $GoneGraceMinutes = 10,

    [switch] $DryRun
)

# Decides what to do from a snapshot of worker processes. Pure - touches no
# process, service or clock - so the self-check can drive it with fabricated
# input and a fabricated $Now.
#
# Two ways a worker counts as stale:
#  - older than MaxAgeHours (the original rule), or
#  - GitHub has told the listener its job is gone ($JobGoneAt, read from the
#    runner log) at least GoneGraceMinutes ago, and the worker predates that.
#    2026-11-11: the laptop slept mid-scrape, GitHub failed the job at 10:25,
#    the worker never exited, and the age rule alone would have waited until
#    12:17 while every Update Prices queued behind it.
function Get-WatchdogAction {
    param(
        [AllowEmptyCollection()]
        [object[]] $Workers,       # objects with .ProcessId and .CreationDate
        [datetime] $Now,
        [double]   $MaxAgeHours,
        $JobGoneAt = $null,        # [datetime] or $null
        [double]   $GoneGraceMinutes = 10
    )

    $cutoff = $Now.AddHours(-$MaxAgeHours)
    $gone = $JobGoneAt -and ([datetime]$JobGoneAt) -le $Now.AddMinutes(-$GoneGraceMinutes)
    $isStale = { param($w) $w.CreationDate -lt $cutoff -or ($gone -and $w.CreationDate -lt [datetime]$JobGoneAt) }
    $stale  = @($Workers | Where-Object { & $isStale $_ })
    $active = @($Workers | Where-Object { -not (& $isStale $_) })

    if ($stale.Count -eq 0)  { return [pscustomobject]@{ Action = 'none'; Stale = @() } }

    # A worker inside the timeout window means a real job is in flight. Killing
    # the stale one would be safe, but restarting the service to finish the job
    # would take the live job down with it - so wait for the next tick instead.
    if ($active.Count -gt 0) { return [pscustomobject]@{ Action = 'wait'; Stale = $stale } }

    return [pscustomobject]@{ Action = 'recover'; Stale = $stale }
}

function Write-WatchdogLog {
    param([string] $Message)
    $line = '{0:yyyy-MM-dd HH:mm:ssK} {1}' -f (Get-Date), $Message
    Write-Output $line
    # Sits beside the runner's own logs, which is where anyone debugging this
    # will already be looking.
    try {
        $dir = 'C:\actions-runner\_diag'
        if (Test-Path $dir) {
            Add-Content -Path (Join-Path $dir 'watchdog.log') -Value $line -Encoding utf8
        }
    } catch { }
}

# When the listener last heard from GitHub that its job is gone, as local time,
# from the newest runner log. $null when there is no such line.
function Get-JobGoneAt {
    $log = Get-ChildItem 'C:\actions-runner\_diag' -Filter 'Runner_*.log' -ErrorAction SilentlyContinue |
           Sort-Object CreationTime -Descending | Select-Object -First 1
    if (-not $log) { return $null }
    $hit = Select-String -Path $log.FullName -Pattern 'job is no longer valid' | Select-Object -Last 1
    if (-not $hit -or $hit.Line -notmatch '^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)Z') { return $null }
    return [datetime]::SpecifyKind([datetime]$Matches[1], 'Utc').ToLocalTime()
}

function Invoke-RunnerWatchdog {
    param([double] $MaxAgeHours, [double] $GoneGraceMinutes, [switch] $DryRun)

    $workers  = @(Get-CimInstance Win32_Process -Filter "Name='Runner.Worker.exe'" |
                  Select-Object ProcessId, CreationDate)
    $decision = Get-WatchdogAction -Workers $workers -Now (Get-Date) -MaxAgeHours $MaxAgeHours `
                  -JobGoneAt (Get-JobGoneAt) -GoneGraceMinutes $GoneGraceMinutes

    # Silent on the normal path - this runs every 30 minutes and almost always
    # has nothing to say.
    if ($decision.Action -eq 'none') { return }

    $ids = ($decision.Stale | ForEach-Object { $_.ProcessId }) -join ','

    if ($decision.Action -eq 'wait') {
        Write-WatchdogLog "stale worker(s) $ids present but a live job is running - leaving alone"
        return
    }

    Write-WatchdogLog "WEDGED: worker(s) $ids are stale (job gone at GitHub, or older than $MaxAgeHours h) - recovering"
    if ($DryRun) { Write-WatchdogLog 'dry run - no action taken'; return }

    foreach ($w in $decision.Stale) {
        # /T takes the scraper's python and Chrome with it; Stop-Process left
        # those running, holding the browser profile.
        $r = taskkill /PID $w.ProcessId /T /F 2>&1
        Write-WatchdogLog "taskkill $($w.ProcessId): $(($r | Select-Object -Last 1))"
    }

    # Restart even when the kill succeeded. On 2026-08-03 the hung worker
    # survived a full service stop, and it was the fresh listener session - not
    # the dead worker going away - that made GitHub start dispatching again.
    $svc = Get-Service | Where-Object { $_.Name -like 'actions.runner.*' } | Select-Object -First 1
    if (-not $svc) { Write-WatchdogLog 'no actions.runner.* service found'; return }
    try {
        Restart-Service -Name $svc.Name -Force -ErrorAction Stop
        Write-WatchdogLog "restarted $($svc.Name)"
    } catch {
        Write-WatchdogLog "restart FAILED (needs SYSTEM/admin): $($_.Exception.Message)"
    }
}

# Dot-sourced by the self-check, which wants the functions but not the actions.
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-RunnerWatchdog -MaxAgeHours $MaxAgeHours -GoneGraceMinutes $GoneGraceMinutes -DryRun:$DryRun
}
