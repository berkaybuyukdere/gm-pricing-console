# GM Pricing Relay - Windows installer (downloaded from the console's Settings page).
# The console URL and relay secret below were baked in server-side at download time.
# Normally embedded inside install-gm-relay.bat (double-click flow); running it
# directly with powershell -ExecutionPolicy Bypass -File also works.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$dir = Join-Path $env:LOCALAPPDATA 'GMPricingRelay'
$script = Join-Path $dir 'relay.ps1'
$log = Join-Path $dir 'relay.log'
$taskName = 'GM Pricing Relay'

New-Item -ItemType Directory -Force -Path $dir | Out-Null

# single-quoted here-string: every $ inside reaches relay.ps1 verbatim
$relay = @'
# GM Pricing Relay - pure PowerShell raw worker (written by install-gm-relay.ps1).
# Long-polls the console for rentalcars jobs, fetches each URL from this
# machine's IP and posts the raw response back. Outbound HTTPS only.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # progress rendering cripples MB-sized transfers on PS 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$CONSOLE_URL = '__CONSOLE_URL__'
$RELAY_SECRET = '__RELAY_SECRET__'
$NAME = $env:COMPUTERNAME
$LOG = Join-Path $env:LOCALAPPDATA 'GMPricingRelay\relay.log'

function Log($msg) {
  try {
    if ((Test-Path $LOG) -and ((Get-Item $LOG).Length -gt 5MB)) { Clear-Content $LOG }
    Add-Content -Path $LOG -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  } catch {}
}

function Post-Result($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 4
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)  # PS 5.1 sends string bodies as ISO-8859-1 - bytes bypass that
  # The console parks on this job for 90s and runs on a single Cloud Run
  # instance, so a burst can refuse this POST outright (429 "no available
  # instance"). The request never reached the app, so resending is safe - and
  # it is the difference between an answer and a 90s stall on the operator's
  # screen. Only back-pressure and 5xx are retried; a real rejection is final.
  $delays = @(1, 2, 5, 11)
  for ($i = 0; $i -le $delays.Count; $i++) {
    try {
      Invoke-RestMethod -Method Post -Uri "$CONSOLE_URL/api/relay/result" `
        -Headers @{ 'x-relay-secret' = $RELAY_SECRET; 'x-relay-name' = $NAME } `
        -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 30 | Out-Null
      return
    } catch {
      $code = 0; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      if ($i -ge $delays.Count) { Log '[relay] result abandoned after retries'; return }
      if ($code -ne 0 -and $code -ne 429 -and $code -lt 500) { return }  # a real rejection
      Start-Sleep -Seconds $delays[$i]
    }
  }
}

function Run-Job($job) {
  try {
    if (-not $job.url) { Post-Result @{ id = $job.id; ok = $false; error = 'NO_URL' }; return }  # console build predates the raw protocol
    if (([Uri]$job.url).Host -ne 'www.rentalcars.com') { Post-Result @{ id = $job.id; ok = $false; error = 'BAD_URL' }; return }  # only rentalcars is ever fetched
    $req = [Net.WebRequest]::CreateHttp($job.url)
    $req.Timeout = 25000; $req.ReadWriteTimeout = 25000
    if ($job.headers) { foreach ($p in $job.headers.PSObject.Properties) {
      switch ($p.Name) {  # restricted headers must go through properties on .NET 4.x
        'User-Agent' { $req.UserAgent = $p.Value }
        'Accept'     { $req.Accept    = $p.Value }
        default      { $req.Headers.Add($p.Name, $p.Value) }
      } } }
    # rentalcars fronts the search API with AWS WAF; a rate rule answers 202 +
    # `x-amzn-waf-action: challenge` (2026-09-03). A browser on THIS machine
    # passes that challenge and holds an `aws-waf-token` cookie; with it a plain
    # request is served again. Put that cookie's value in waf-token.txt beside
    # this script (from the browser: document.cookie -> aws-waf-token) whenever
    # the log shows 202/challenge. The token is per machine — one from another
    # computer will not do.
    $tokFile = Join-Path $dir 'waf-token.txt'
    if (Test-Path $tokFile) {
      $tok = (Get-Content $tokFile -Raw).Trim()
      if ($tok) { $req.Headers.Add('Cookie', "aws-waf-token=$tok") }
    }
    $resp = $null
    try { $resp = $req.GetResponse() }
    catch [Net.WebException] {
      if ($_.Exception.Response) { $resp = $_.Exception.Response }  # 403/405/429: still a result
      else { throw }
    }
    $status = [int]$resp.StatusCode
    $waf = $resp.Headers['x-amzn-waf-action']
    $sr = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
    $body = $sr.ReadToEnd(); $sr.Close(); $resp.Close()
    Post-Result @{ id = $job.id; ok = $true; status = $status; body = $body }
    if ($status -ne 200 -or $waf) { Log ("[relay] rentalcars answered {0}{1} bytes={2} - refresh waf-token.txt from a browser on this machine" -f $status, $(if ($waf) { " waf=$waf" } else { "" }), $body.Length) }
    Log ("[relay] job {0} ok ({1})" -f $job.id.Substring(0, 8), $status)
  } catch {
    Log ("[relay] job {0} failed: {1}" -f $job.id.Substring(0, 8), $_.Exception.Message)
    Post-Result @{ id = $job.id; ok = $false; error = $_.Exception.Message }
  }
}

$connected = $false  # '[relay] connected' is only logged after a real HTTP 200 poll
while ($true) {
  try {
    $r = Invoke-RestMethod -Uri "$CONSOLE_URL/api/relay/poll" `
      -Headers @{ 'x-relay-secret' = $RELAY_SECRET; 'x-relay-name' = $NAME } -TimeoutSec 40
    if (-not $connected) { $connected = $true; Log '[relay] connected' }
    if ($r.job) { Run-Job $r.job }
  } catch {
    $code = 0; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 401 -or $code -eq 404) { $connected = $false; Log "[relay] console refused ($code) - retry in 60s"; Start-Sleep 60 }
    elseif ($code -eq 429) { Start-Sleep (3 + (Get-Random -Maximum 5)) }  # no instance free: ease off, do not storm
    else { Start-Sleep 5 }  # timeout/offline: silent, keeps the log small
  }
}
'@
Set-Content -Path $script -Value $relay -Encoding UTF8  # PS 5.1 default is ANSI

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal | Out-Null

New-Item -ItemType File -Force -Path $log | Out-Null
Clear-Content -Path $log -ErrorAction SilentlyContinue  # a stale 'connected' line must not pass the check below
Start-ScheduledTask -TaskName $taskName

# an idle console holds the first poll for 25s before answering - allow 40s
$ok = $false
foreach ($i in 1..20) {
  Start-Sleep -Seconds 2
  if (Select-String -Path $log -Pattern '[relay] connected' -SimpleMatch -Quiet -ErrorAction SilentlyContinue) {
    $ok = $true; break
  }
}
if ($ok) {
  Write-Host "OK - relay calisiyor / relay running ($env:COMPUTERNAME) -> __CONSOLE_URL__"
  Remove-Item -Force $PSCommandPath -ErrorAction SilentlyContinue
  Write-Host 'Not: kurulum dosyalari erisim anahtari icerdigi icin siliniyor.'
  Write-Host 'Note: installer files contain an access key and are being cleaned up.'
} else {
  Write-Host 'Relay 40 sn icinde baglanamadi / did not connect within 40s - task state:'
  Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Format-Table TaskName, State | Out-String | Write-Host
  Get-Content -Path $log -Tail 5 -ErrorAction SilentlyContinue | Write-Host
  exit 1
}
