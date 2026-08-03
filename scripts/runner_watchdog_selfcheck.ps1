# Self-check for runner_watchdog.ps1's decision logic.
#
# The dangerous part of the watchdog is the age partition: too eager and it
# shoots a slow-but-healthy scrape, too lax and the runner stays wedged. These
# cases pin the boundary and the "a live job is running" bail-out.
#
# Pure logic only - nothing here enumerates processes or touches a service, so
# it runs on the Linux CI box under pwsh.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runner_watchdog.ps1')

$script:fails = 0
$now = Get-Date '2026-08-03T12:00:00'

function Check {
    param([string] $Name, [string] $Expected, [string] $Actual)
    if ($Expected -ne $Actual) {
        Write-Host "FAIL $Name : expected '$Expected', got '$Actual'"
        $script:fails++
    } else {
        Write-Host "ok   $Name"
    }
}

# A worker process $AgeHours old, as Get-CimInstance would report it.
function W {
    param([int] $Id, [double] $AgeHours)
    [pscustomobject]@{ ProcessId = $Id; CreationDate = $now.AddHours(-$AgeHours) }
}

function Act {
    param([object[]] $Workers, [double] $MaxAgeHours = 3)
    (Get-WatchdogAction -Workers $Workers -Now $now -MaxAgeHours $MaxAgeHours).Action
}

# --- nothing to do ---------------------------------------------------------
Check 'no workers at all'        'none' (Act @())
Check 'one fresh worker'         'none' (Act @( (W 1 0.1) ))
Check 'worker at 89 min'         'none' (Act @( (W 1 1.483) ))

# --- the boundary ----------------------------------------------------------
# Exactly at the cutoff is NOT stale: a job that has run precisely MaxAgeHours
# gets the benefit of the doubt and one more tick.
Check 'worker exactly at cutoff' 'none'    (Act @( (W 1 3) ))
Check 'worker one second past'   'recover' (Act @( (W 1 3.00028) ))

# --- the wedge -------------------------------------------------------------
Check 'single stale worker'      'recover' (Act @( (W 1 22) ))
Check 'two stale workers'        'recover' (Act @( (W 1 22), (W 2 5) ))

# --- do not disturb a live job --------------------------------------------
# This is the case that matters: on 2026-08-03 the zombie (PID 12224, 22h old)
# and a healthy worker (PID 15868, minutes old) were running side by side.
# Restarting the service then would have killed the good scrape too.
Check 'stale + live job'         'wait' (Act @( (W 12224 22), (W 15868 0.05) ))
Check 'stale + live, order swap' 'wait' (Act @( (W 15868 0.05), (W 12224 22) ))

# --- the threshold is honoured --------------------------------------------
Check 'lax threshold spares 4h'  'none'    (Act @( (W 1 4) ) 6)
Check 'tight threshold takes 4h' 'recover' (Act @( (W 1 4) ) 2)

# --- the stale list is what gets killed -----------------------------------
$d = Get-WatchdogAction -Workers @( (W 7 22), (W 8 21), (W 9 0.2) ) -Now $now -MaxAgeHours 3
Check 'wait keeps both stale ids' '7,8' (($d.Stale | ForEach-Object { $_.ProcessId }) -join ',')
Check 'live job blocks recovery'  'wait' $d.Action

$d = Get-WatchdogAction -Workers @( (W 7 22), (W 8 21) ) -Now $now -MaxAgeHours 3
Check 'recover targets both'      '7,8'     (($d.Stale | ForEach-Object { $_.ProcessId }) -join ',')
Check 'recover with no live job'  'recover' $d.Action

if ($script:fails -gt 0) {
    Write-Host "`n$script:fails check(s) FAILED"
    exit 1
}
Write-Host "`nrunner_watchdog: all checks passed"
