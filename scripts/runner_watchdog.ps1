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

    [switch] $DryRun
)

# Decides what to do from a snapshot of worker processes. Pure - touches no
# process, service or clock - so the self-check can drive it with fabricated
# input and a fabricated $Now.
function Get-WatchdogAction {
    param(
        [AllowEmptyCollection()]
        [object[]] $Workers,       # objects with .ProcessId and .CreationDate
        [datetime] $Now,
        [double]   $MaxAgeHours
    )

    $cutoff = $Now.AddHours(-$MaxAgeHours)
    $stale  = @($Workers | Where-Object { $_.CreationDate -lt $cutoff })
    $active = @($Workers | Where-Object { $_.CreationDate -ge $cutoff })

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

function Invoke-RunnerWatchdog {
    param([double] $MaxAgeHours, [switch] $DryRun)

    $workers  = @(Get-CimInstance Win32_Process -Filter "Name='Runner.Worker.exe'" |
                  Select-Object ProcessId, CreationDate)
    $decision = Get-WatchdogAction -Workers $workers -Now (Get-Date) -MaxAgeHours $MaxAgeHours

    # Silent on the normal path - this runs every 30 minutes and almost always
    # has nothing to say.
    if ($decision.Action -eq 'none') { return }

    $ids = ($decision.Stale | ForEach-Object { $_.ProcessId }) -join ','

    if ($decision.Action -eq 'wait') {
        Write-WatchdogLog "stale worker(s) $ids present but a live job is running - leaving alone"
        return
    }

    Write-WatchdogLog "WEDGED: worker(s) $ids older than $MaxAgeHours h with no live job - recovering"
    if ($DryRun) { Write-WatchdogLog 'dry run - no action taken'; return }

    foreach ($w in $decision.Stale) {
        try {
            Stop-Process -Id $w.ProcessId -Force -ErrorAction Stop
            Write-WatchdogLog "killed worker $($w.ProcessId)"
        } catch {
            Write-WatchdogLog "could not kill worker $($w.ProcessId): $($_.Exception.Message)"
        }
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
    Invoke-RunnerWatchdog -MaxAgeHours $MaxAgeHours -DryRun:$DryRun
}
