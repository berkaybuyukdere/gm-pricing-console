@echo off
title GM Pricing Relay Kurulum / Setup
rem Double-click installer: extracts the PowerShell payload embedded below the
rem marker line and runs it. No terminal typing needed. Self-deletes at the end
rem because the payload carries an access key.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$m='#'+'GMPS1'+'#'; $c=[IO.File]::ReadAllText('%~f0'); $i=$c.IndexOf($m); $ps=$c.Substring($i+$m.Length); $tmp=Join-Path $env:TEMP 'install-gm-relay.ps1'; [IO.File]::WriteAllText($tmp,$ps); & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tmp"
echo.
pause
(goto) 2>nul & del "%~f0"
exit /b
#GMPS1#
